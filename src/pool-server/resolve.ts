// src/pool-server/resolve.ts
import { resolveRoutes, responseToMiddlewareResult } from '@next/routing';
import type { RoutingManifest } from '../types.js';

type LoadedModule = Record<string, unknown>;

export type ResolveResult =
  | { kind: 'route'; pool: string; matchedPathname: string; routeMatches: Record<string, string> | null; resolvedHeaders: Headers | undefined; middlewareRequestHeaders?: Headers | undefined }
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
      // Captures the mutated request headers from responseToMiddlewareResult.
      // This includes x-middleware-set-cookie, x-middleware-override-headers,
      // and x-middleware-request-* modifications — all applied in one place.
      let middlewareRequestHeaders: Headers | null = null;

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
              // Following the Firebase adapter pattern: call middleware.default.default()
              // with a plain object that looks like a Request — avoids private field issues.
              const middlewareUrl = ctx.url;

              const middlewareRequest = {
                url: middlewareUrl.toString(),
                method,
                headers: Object.fromEntries(
                  [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":"))
                ),
                destination: 'document',
                credentials: 'same-origin',
                bodyUsed: false,
                body: method === "GET" || method === "HEAD" ? undefined : ctx.requestBody,
                mode: "navigate",
                redirect: "follow",
                referrer: ctx.headers.get("referer"),
              };

              const handlerFn = typeof middlewareModule.default === 'function'
                ? middlewareModule.default
                : (middlewareModule.default as Record<string, unknown>)?.default;
              if (typeof handlerFn !== 'function') return {};

              try {
                const result = await (handlerFn as any)({ request: middlewareRequest });
                if (result.waitUntil) await result.waitUntil;

                if (result.response) {
                  middlewareResponse = result.response;
                  // responseToMiddlewareResult mutates requestHeaders with:
                  //  - x-middleware-set-cookie → merged into cookie header
                  //  - x-middleware-override-headers → replaced request headers
                  //  - x-middleware-request-* → values for overridden headers
                  const reqHeaders = new Headers(ctx.headers);
                  const mwResult = responseToMiddlewareResult(
                    result.response.clone(),
                    reqHeaders,
                    ctx.url,
                  );
                  middlewareRequestHeaders = reqHeaders;
                  return mwResult;
                }
                return {};
              } catch (err) {
                console.error("[pool-server] Middleware execution failed:", err);
                return {};
              }
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
        middlewareRequestHeaders: middlewareRequestHeaders ?? undefined,
      };
    },
  };
}

export type LocalResolver = ReturnType<typeof createLocalResolver>;
