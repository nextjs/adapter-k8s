// src/pool-server/resolve.ts
import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";

type LoadedModule = Record<string, unknown>;

export type ResolveResult =
  | {
      kind: "route";
      pool: string;
      matchedPathname: string;
      routeMatches: Record<string, string> | null;
      resolvedHeaders: Headers | undefined;
      middlewareRequestHeaders?: Headers | undefined;
    }
  | { kind: "redirect"; url: URL; status: number }
  | { kind: "middleware-response"; response: Response }
  | { kind: "external-rewrite"; url: URL }
  | { kind: "not-found" };

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
              // Next.js middleware modules have multiple shapes depending on
              // compilation target. We try invocation paths in order:
              //
              // 1. Web adapter: default({ handler, request, page }) — Node middleware
              //    Returns raw NextResponse with x-middleware-* headers intact.
              // 2. Legacy: default.default({ request }) — older Next.js Edge output
              //    Pre-processes response (strips x-middleware-* headers).
              // 3. Direct handler: handler(request, { waitUntil }) — raw handler fn
              //
              // Web adapter MUST be tried first — the legacy path strips control
              // headers from the response, causing responseToMiddlewareResult to
              // misinterpret the result (sets bodySent=true incorrectly).

              const adapterFn =
                typeof middlewareModule.default === "function"
                  ? (middlewareModule.default as (...args: unknown[]) => unknown)
                  : typeof middlewareModule === "function"
                    ? (middlewareModule as unknown as (...args: unknown[]) => unknown)
                    : null;

              const handlerFn =
                (middlewareModule as Record<string, unknown>).proxy ||
                (middlewareModule as Record<string, unknown>).middleware ||
                middlewareModule;

              const legacyMiddlewareFn =
                typeof (middlewareModule.default as Record<string, unknown> | undefined)
                  ?.default === "function"
                  ? ((middlewareModule.default as Record<string, unknown>).default as (
                      ...args: unknown[]
                    ) => unknown)
                  : null;

              if (!adapterFn && !handlerFn && !legacyMiddlewareFn) return {};

              try {
                const waitUntil = (waitable: Promise<unknown>) => {
                  void waitable.catch(() => undefined);
                };

                let response: Response | null = null;

                // Path 1: Web adapter (default({ handler, request, page }))
                if (adapterFn && handlerFn) {
                  const requestHeaders = Object.fromEntries(
                    [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                  );
                  const result = await (adapterFn as any)({
                    handler: handlerFn,
                    request: {
                      url: ctx.url.toString(),
                      method,
                      headers: requestHeaders,
                      body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                      signal: new AbortController().signal,
                      nextConfig: {
                        basePath: manifest.basePath || undefined,
                        i18n: (manifest.i18n as any) ?? undefined,
                      },
                      waitUntil,
                    },
                    page: "middleware",
                  });

                  response =
                    result?.response instanceof Response
                      ? result.response
                      : result instanceof Response
                        ? result
                        : null;
                }

                // Path 2: Legacy middleware (default.default)
                if (!response && legacyMiddlewareFn) {
                  const requestHeaders = Object.fromEntries(
                    [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                  );
                  const result = await (legacyMiddlewareFn as any)({
                    request: {
                      url: ctx.url.toString(),
                      method,
                      headers: requestHeaders,
                      body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                      destination: "document",
                      credentials: "same-origin",
                      bodyUsed: false,
                      mode: "navigate",
                      redirect: "follow",
                    },
                  });

                  if (result?.waitUntil) {
                    await result.waitUntil;
                  }

                  response =
                    result?.response instanceof Response
                      ? result.response
                      : result instanceof Response
                        ? result
                        : null;
                }

                // Path 3: Direct handler invocation
                if (!response && typeof handlerFn === "function") {
                  const requestInit: RequestInit & { duplex?: "half" } = {
                    method,
                    headers: new Headers(
                      [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                    ),
                    duplex: "half",
                  };
                  if (method !== "GET" && method !== "HEAD") {
                    requestInit.body = ctx.requestBody;
                  }
                  const middlewareRequest = new Request(ctx.url.toString(), requestInit);
                  const result = await (handlerFn as any)(middlewareRequest, {
                    waitUntil,
                  });

                  response =
                    result instanceof Response
                      ? result
                      : result?.response instanceof Response
                        ? result.response
                        : null;
                }

                if (response) {
                  middlewareResponse = response;
                  const reqHeaders = new Headers(ctx.headers);
                  const mwResult = responseToMiddlewareResult(
                    response.clone(),
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
        return {
          kind: "redirect",
          url: resolution.redirect.url,
          status: resolution.redirect.status,
        };
      }

      const location = resolution.resolvedHeaders?.get("location");
      if (location && [301, 302, 307, 308].includes(resolution.status ?? 0)) {
        return {
          kind: "redirect",
          url: new URL(location, url.origin),
          status: resolution.status!,
        };
      }

      // 2. Middleware short-circuit
      if (resolution.middlewareResponded && middlewareResponse) {
        return { kind: "middleware-response", response: middlewareResponse };
      }

      // 3. External rewrite
      if (resolution.externalRewrite) {
        return { kind: "external-rewrite", url: resolution.externalRewrite };
      }

      // 4. Normal route resolution
      const matchedPathname = resolution.invocationTarget?.pathname ?? url.pathname;

      // Try exact match first, then try with/without trailing slash, then fall back to default pool
      let pool =
        manifest.poolAssignments[resolution.resolvedPathname ?? ""] ??
        manifest.poolAssignments[matchedPathname];

      if (!pool) {
        // Trailing slash fallback: try with/without trailing slash
        const withSlash = matchedPathname.endsWith("/") ? matchedPathname : matchedPathname + "/";
        const withoutSlash = matchedPathname.endsWith("/") ? matchedPathname.slice(0, -1) : matchedPathname;
        pool =
          manifest.poolAssignments[withSlash] ??
          manifest.poolAssignments[withoutSlash] ??
          manifest.poolAssignments["default"] ??
          Object.values(manifest.poolAssignments)[0];
      }

      if (!pool) {
        return { kind: "not-found" };
      }

      const finalMatchedPathname =
        resolution.resolvedPathname ?? resolution.invocationTarget?.pathname ?? matchedPathname;

      return {
        kind: "route",
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
