// src/pool-server/dispatch.ts
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerLoader } from './handler-loader.js';
import type { ResolveResult } from './resolve.js';
import type { StaticAssetEntry } from '../types.js';

const NEXT_REQUEST_META = Symbol.for('NextInternalRequestMeta');

function toNodeHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'undefined') continue;
    headers[key] = value;
  }
  return headers;
}

async function writeInnerResponse(
  outerRes: ServerResponse,
  innerRes: IncomingMessage,
): Promise<void> {
  outerRes.writeHead(innerRes.statusCode ?? 200, innerRes.headers);
  for await (const chunk of innerRes) {
    const shouldContinue = outerRes.write(chunk);
    if (!shouldContinue) {
      await once(outerRes, 'drain');
    }
  }
  outerRes.end();
}

async function invokeLocalHandlerOverHttp({
  handler,
  req,
  res,
  matchedPathname,
  routeMatches,
  bufferedBody,
}: {
  handler: HandlerLoader extends { load(outputId: string): Promise<infer T> } ? T : never;
  req: IncomingMessage;
  res: ServerResponse;
  matchedPathname: string;
  routeMatches: Record<string, string> | null;
  bufferedBody: Buffer | undefined;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((innerReq, innerRes) => {
      void (async () => {
        try {
          const maybeResult = await (handler as any)(innerReq, innerRes, {
            waitUntil(waitable: Promise<unknown>) {
              void waitable.catch(() => undefined);
            },
            requestMeta: {
              relativeProjectDir: '.',
              hostname: req.headers.host?.split(':')[0] ?? '127.0.0.1',
              outputId: matchedPathname,
              matchedPathname,
              routeMatches,
            },
          });

          if (maybeResult instanceof Response) {
            const headers: Record<string, string> = {};
            for (const [key, value] of maybeResult.headers.entries()) {
              headers[key] = value;
            }
            innerRes.writeHead(maybeResult.status, headers);
            if (maybeResult.body) {
              const reader = maybeResult.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) innerRes.write(Buffer.from(value));
                }
              } finally {
                reader.releaseLock();
              }
            }
            innerRes.end();
            return;
          }

          if (!innerRes.writableEnded) {
            innerRes.end();
          }
        } catch (error) {
          if (!innerRes.headersSent) {
            innerRes.statusCode = 500;
            innerRes.end('Internal Server Error');
          } else if (!innerRes.writableEnded) {
            innerRes.end();
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate loopback port')));
        return;
      }

      const clientReq = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method: req.method,
          path: req.url,
          headers: toNodeHeaders(req),
        },
        (clientRes) => {
          void writeInnerResponse(res, clientRes)
            .then(() => {
              server.close(() => resolve());
            })
            .catch((error) => {
              server.close(() => reject(error));
            });
        },
      );

      clientReq.once('error', (error) => {
        server.close(() => reject(error));
      });

      if (bufferedBody && bufferedBody.length > 0) {
        clientReq.end(bufferedBody);
      } else {
        clientReq.end();
      }
    });
  });
}

type LocalHandlerInvoker = typeof invokeLocalHandlerOverHttp;

function sanitizeK8sName(name: string): string {
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  if (!/^[a-z]/.test(sanitized)) sanitized = `b-${sanitized}`;
  sanitized = sanitized.replace(/-+$/, "");
  return sanitized.slice(0, 63);
}

export interface DispatcherOptions {
  handlerLoader: HandlerLoader;
  poolName: string;
  buildId: string;
  staticAssets: StaticAssetEntry[];
  releaseName?: string;
  localHandlerInvoker?: LocalHandlerInvoker;
}

export function createDispatcher(options: DispatcherOptions) {
  const {
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName = 'nextjs',
    localHandlerInvoker = invokeLocalHandlerOverHttp,
  } = options;

  return {
    async dispatch(
      req: IncomingMessage,
      res: ServerResponse,
      resolution: ResolveResult,
    ): Promise<void> {
      // 1. Serve static assets from the manifest.
      // Skip for PPR routes (they have postponedState) — the handler must stream dynamic content.
      // Skip if request has resume headers (PPR resume step).
      if (resolution.kind === 'route') {
        const staticAsset = staticAssets.find(a => a.pathname === resolution.matchedPathname);
        const isPPR = staticAsset?.ppr;
        const hasResumeHeader = req.headers['next-resume'] === '1' || req.headers['x-nextjs-ppr'] === '1';
        if (staticAsset && !isPPR && !hasResumeHeader) {
          const fullPath = path.resolve(process.cwd(), staticAsset.filePath);
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath);
            const assetHeaders = staticAsset.headers;
            const headers: Record<string, string | string[]> = Object.assign(
              { 'cache-control': staticAsset.cacheControl, 'content-type': getContentType(staticAsset.pathname) },
              assetHeaders || {},
            );
            res.writeHead(staticAsset.status ?? 200, headers);
            res.end(content);
            return;
          }
        }
      }

      switch (resolution.kind) {
        case 'redirect': {
          res.writeHead(resolution.status, { location: resolution.url.toString() });
          res.end();
          return;
        }

        case 'middleware-response': {
          const mwRes = resolution.response;
          const headers: Record<string, string> = {};
          for (const [key, value] of mwRes.headers.entries()) {
            headers[key] = value;
          }
          res.writeHead(mwRes.status, headers);
          if (mwRes.body) {
            const reader = mwRes.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) res.write(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
          }
          res.end();
          return;
        }

        case 'external-rewrite': {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(
            `External rewrites are not supported in adapter-k8s v1. ` +
            `Attempted rewrite to: ${resolution.url.toString()}\n` +
            `Use a Route Handler to proxy external APIs instead.`
          );
          return;
        }

        case 'not-found': {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Not Found');
          return;
        }

        case 'route': {
          const outputInfo = handlerLoader.get?.(resolution.matchedPathname);
          if (outputInfo?.runtime === 'edge' || outputInfo?.filePath?.includes('/server/edge/')) {
            res.writeHead(501, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(
              `Edge runtime routes are not supported by adapter-k8s pool-server yet. ` +
              `Route: ${resolution.matchedPathname}\n` +
              `File: ${outputInfo.filePath}\n`
            );
            return;
          }

          // Apply resolved headers from routing
          if (resolution.resolvedHeaders) {
            for (const [key, value] of resolution.resolvedHeaders.entries()) {
              // set-cookie needs special handling — Headers joins multiples with ", "
              // but Node requires an array for multiple Set-Cookie headers
              if (key.toLowerCase() === 'set-cookie') {
                const existing = res.getHeader('set-cookie');
                const arr = existing
                  ? (Array.isArray(existing) ? existing : [String(existing)])
                  : [];
                // Split on boundaries between cookies (comma followed by cookie name=)
                for (const c of value.split(/,(?=[^;]*=)/)) {
                  arr.push(c.trim());
                }
                res.setHeader('set-cookie', arr);
              } else {
                res.setHeader(key, value);
              }
            }
          }

          // Apply middleware's mutated request headers (cookies, overrides, etc.)
          // responseToMiddlewareResult handles x-middleware-set-cookie,
          // x-middleware-override-headers, and x-middleware-request-* in one pass.
          if (resolution.middlewareRequestHeaders) {
            for (const [key, value] of resolution.middlewareRequestHeaders.entries()) {
              // Skip internal x-middleware-* headers — they're control signals, not for the handler
              if (key.startsWith('x-middleware-')) continue;
              if (key === 'cookie') {
                // Merge middleware-set cookies with original request cookies
                const existing = req.headers.cookie ?? '';
                req.headers.cookie = [existing, value].filter(Boolean).join('; ');
              } else {
                req.headers[key] = value;
              }
            }
          }

          // If this output belongs to another pool, proxy the request
          if (resolution.pool !== poolName && !handlerLoader.has(resolution.matchedPathname)) {
            return proxyToPool(req, res, resolution, releaseName, buildId);
          }

          // Load and invoke the handler directly
          const handler = await handlerLoader.load(resolution.matchedPathname);
          const bufferedBody = (req as IncomingMessage & {
            [NEXT_REQUEST_META]?: { actionBody?: Buffer };
          })[NEXT_REQUEST_META]?.actionBody;

          await localHandlerInvoker({
            handler,
            req,
            res,
            matchedPathname: resolution.matchedPathname,
            routeMatches: resolution.routeMatches,
            bufferedBody,
          });
          return;
        }
      }
    },
  };
}

function proxyToPool(
  req: IncomingMessage,
  res: ServerResponse,
  resolution: Extract<ResolveResult, { kind: 'route' }>,
  releaseName: string,
  buildId: string,
): Promise<void> {
  return new Promise((resolve) => {
    const targetHost = sanitizeK8sName(`${releaseName}-${resolution.pool}-${buildId}`);
    const proxyReq = httpRequest(
      {
        hostname: targetHost,
        port: 3000,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          'x-output-id': resolution.matchedPathname,
          'x-matched-pathname': resolution.matchedPathname,
          'x-route-matches': resolution.routeMatches ? JSON.stringify(resolution.routeMatches) : '',
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
      },
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Failed to proxy to pool "${resolution.pool}": ${err.message}`);
      }
      resolve();
    });

    const bufferedBody = (req as IncomingMessage & {
      [NEXT_REQUEST_META]?: { actionBody?: Buffer };
    })[NEXT_REQUEST_META]?.actionBody;

    if (bufferedBody) {
      proxyReq.end(bufferedBody);
    } else {
      req.pipe(proxyReq);
    }
  });
}

function getContentType(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.rsc': return 'text/x-component';
    case '': return 'text/html; charset=utf-8'; // extensionless routes (/, /about, etc.)
    default: return 'application/octet-stream';
  }
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
