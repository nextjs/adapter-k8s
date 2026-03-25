// src/pool-server/dispatch.ts
import { request as httpRequest } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HandlerLoader } from './handler-loader.js';
import type { ResolveResult } from './resolve.js';
import type { StaticAssetEntry } from '../types.js';

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
      // 1. Check for static asset first
      if (resolution.kind === 'route') {
        const staticAsset = staticAssets.find(a => a.pathname === resolution.matchedPathname);
        if (staticAsset) {
          const fullPath = path.resolve(process.cwd(), staticAsset.filePath);
          if (existsSync(fullPath)) {
            const content = readFileSync(fullPath);
            res.writeHead(200, {
              'cache-control': staticAsset.cacheControl,
              'content-type': getContentType(staticAsset.pathname),
            });
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
          // Apply resolved headers from routing
          if (resolution.resolvedHeaders) {
            for (const [key, value] of resolution.resolvedHeaders.entries()) {
              res.setHeader(key, value);
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
              outputId: resolution.matchedPathname, // Still use outputId in meta for compatibility
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
    const targetHost = `${releaseName}-${resolution.pool}-${buildId}`;
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
    default: return 'application/octet-stream';
  }
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
