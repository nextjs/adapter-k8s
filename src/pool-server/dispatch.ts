// src/pool-server/dispatch.ts
import { request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerLoader } from './handler-loader.js';
import type { ResolveResult } from './resolve.js';
import type { StaticAssetEntry } from '../types.js';

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
}

export function createDispatcher(options: DispatcherOptions) {
  const { handlerLoader, poolName, buildId, staticAssets, releaseName = 'nextjs' } = options;

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
          const maybeResult = await (handler as any)(req, res, {
            waitUntil(p: Promise<unknown>) { void p.catch(() => {}); },
            requestMeta: {
              // Standard adapter requestMeta fields (per official adapter docs)
              relativeProjectDir: '.',
              hostname: req.headers.host?.split(':')[0] ?? '127.0.0.1',
              outputId: resolution.matchedPathname,
              matchedPathname: resolution.matchedPathname,
              routeMatches: resolution.routeMatches,
            },
          });

          // If handler returned a Response or Lambda-like result, write it
          if (maybeResult instanceof Response) {
            const headers: Record<string, string> = {};
            for (const [key, value] of (maybeResult as Response).headers.entries()) {
              headers[key] = value;
            }
            res.writeHead((maybeResult as Response).status, headers);
            if ((maybeResult as Response).body) {
              const reader = (maybeResult as Response).body!.getReader();
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

          // If handler wrote to res directly (most common), ensure it ended
          if (!res.writableEnded) {
            res.end();
          }
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

    req.pipe(proxyReq);
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
