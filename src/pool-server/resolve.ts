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
        i18n: (manifest.i18n as any) ?? undefined,
        routes: manifest.routeGraph,
        // invokeMiddleware MUST always be a function — resolveRoutes calls it
        // unconditionally (no null guard). When no middleware exists, return empty result.
        invokeMiddleware: middlewareModule
          ? async (ctx) => {
              const reqInit: RequestInit = {
                method,
                headers: new Headers(ctx.headers),
              };
              if (method !== "GET" && method !== "HEAD") {
                reqInit.body = ctx.requestBody;
                // @ts-ignore - duplex is required in Node.js fetch for streamed bodies
                reqInit.duplex = "half";
              }
              const baseRequest = new Request(ctx.url.toString(), reqInit);
              // Next.js middleware expects a mutable request.url property.
              // Standard Request.url is read-only, so we wrap with a Proxy.
              const request = new Proxy(baseRequest, {
                get(target, prop, receiver) {
                  if (prop === 'url') return (target as any)._mutableUrl ?? target.url;
                  return Reflect.get(target, prop, receiver);
                },
                set(target, prop, value) {
                  if (prop === 'url') { (target as any)._mutableUrl = value; return true; }
                  return Reflect.set(target, prop, value);
                },
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
