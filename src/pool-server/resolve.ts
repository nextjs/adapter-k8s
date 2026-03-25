// src/pool-server/resolve.ts
import { resolveRoutes, responseToMiddlewareResult } from '@next/routing';
import type { RoutingManifest } from '../types.js';

type LoadedModule = Record<string, unknown>;

export type ResolveResult =
  | { kind: 'route'; pool: string; matchedPathname: string; routeMatches: Record<string, string> | null; resolvedHeaders: Headers | undefined }
  | { kind: 'redirect'; url: URL; status: number }
  | { kind: 'middleware-response'; response: Response }
  | { kind: 'external-rewrite'; url: URL }
  | { kind: 'not-found' };

export function createLocalResolver(
  manifest: RoutingManifest,
  middlewareModule?: LoadedModule | null,
) {
  return {
    async resolve(
      url: URL,
      headers: Headers,
      method: string,
      requestBody: ReadableStream<Uint8Array>,
    ): Promise<ResolveResult> {
      let middlewareResponse: Response | null = null;

      const resolution = await resolveRoutes({
        url,
        buildId: manifest.buildId,
        basePath: manifest.basePath,
        requestBody,
        headers,
        pathnames: manifest.pathnames,
        i18n: manifest.i18n ?? undefined,
        routes: manifest.routeGraph,
        // invokeMiddleware MUST always be a function — resolveRoutes calls it
        // unconditionally (no null guard). When no middleware exists, return empty result.
        invokeMiddleware: middlewareModule
          ? async (ctx) => {
              const request = new Request(ctx.url.toString(), {
                method,
                headers: new Headers(ctx.headers),
                body: method === "GET" || method === "HEAD" ? null : ctx.requestBody,
                // @ts-ignore - duplex is required in Node.js fetch for streamed bodies
                duplex: "half",
              });
              // Middleware modules export default.default (the middleware handler)
              const handlerFn = typeof middlewareModule.default === 'function'
                ? middlewareModule.default
                : (middlewareModule.default as Record<string, unknown>)?.default;
              if (typeof handlerFn !== 'function') {
                return {};
              }
              const result = await (handlerFn as (opts: { request: Request }) => Promise<{ response?: Response; waitUntil?: Promise<void> }>)({ request });
              if (result.waitUntil) await result.waitUntil;
              if (result.response) {
                middlewareResponse = result.response;
                return responseToMiddlewareResult(
                  result.response.clone(),
                  new Headers(ctx.headers),
                  ctx.url,
                );
              }
              return {};
            }
          : async () => ({}),
      });

      // 1. Redirect
      if (resolution.redirect) {
        return { kind: 'redirect', url: resolution.redirect.url, status: resolution.redirect.status };
      }

      const location = resolution.resolvedHeaders?.get('location');
      if (location && [301, 302, 307, 308].includes(resolution.status ?? 0)) {
        return {
          kind: 'redirect',
          url: new URL(location, url.origin),
          status: resolution.status!,
        };
      }

      // 2. Middleware short-circuit
      if (resolution.middlewareResponded && middlewareResponse) {
        return { kind: 'middleware-response', response: middlewareResponse };
      }

      // 3. External rewrite
      if (resolution.externalRewrite) {
        return { kind: 'external-rewrite', url: resolution.externalRewrite };
      }

      // 4. Normal route resolution
      const matchedPathname = resolution.invocationTarget?.pathname ?? url.pathname;
      const pool = manifest.poolAssignments[resolution.resolvedPathname ?? '']
        ?? manifest.poolAssignments[matchedPathname];

      if (!pool) {
        return { kind: 'not-found' };
      }

      const finalMatchedPathname = resolution.resolvedPathname ?? resolution.invocationTarget?.pathname ?? matchedPathname;

      return {
        kind: 'route',
        pool,
        matchedPathname: finalMatchedPathname,
        routeMatches: resolution.routeMatches ?? null,
        resolvedHeaders: resolution.resolvedHeaders ?? undefined,
      };
    },
  };
}

export type LocalResolver = ReturnType<typeof createLocalResolver>;
