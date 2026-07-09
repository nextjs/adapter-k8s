// src/pool-server/resolve.ts
import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";
import {
  lookupPool,
  manifestNextConfig,
  normalizeMatchedPathname,
  normalizeResolvedRedirect,
  preferConcreteOutput,
  prepareRequest,
  resolveRscOutput,
  type RscConfig,
} from "../routing-common.js";

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
  | { kind: "redirect"; url: URL; status: number; resolvedHeaders?: Headers | undefined }
  | { kind: "error"; status: number }
  | { kind: "middleware-response"; response: Response }
  | { kind: "external-rewrite"; url: URL }
  | { kind: "not-found"; resolvedHeaders?: Headers | undefined };

export function createLocalResolver(
  manifest: RoutingManifest,
  middlewareModule?: LoadedModule | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  edgeMiddlewareRunner?: ((ctx: any) => Promise<Response | null>) | null,
  // App-scoped next/dist/server/body-streams#getCloneableBody. Node middleware's
  // web adapter reads request.body via .cloneBodyStream(), so a POST body must
  // be wrapped as a CloneableBody, not passed as a raw ReadableStream (doing so
  // throws at invocation — which, before failing closed, silently skipped node
  // middleware entirely on body requests).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getCloneableBody?: ((readable: any) => any) | null,
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
      // Fail CLOSED: a middleware that throws must become a 500, never a silent
      // "middleware passed". Otherwise a crashing/incompatible middleware would
      // bypass the auth, redirects, and rewrites it implements. Mirrors Next's
      // own behavior (thrown middleware → 500) and the ext_proc edge.
      let middlewareThrew = false;

      // Shared request normalization (decode-400, slash-collapse 308, locale
      // prefixing) — one sequence with the ext_proc edge (routing-common.ts).
      const prep = prepareRequest(url, headers, manifest);
      if (prep.kind === "error") return { kind: "error", status: prep.status };
      if (prep.kind === "redirect") return { kind: "redirect", url: prep.url, status: prep.status };
      url = prep.url;

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
        invokeMiddleware:
          middlewareModule || edgeMiddlewareRunner
            ? async (ctx) => {
                // Next.js middleware modules have multiple shapes depending on
                // compilation target. We try invocation paths in order:
                //
                // 0. Edge sandbox: use Next.js's built-in edge runtime sandbox
                //    (for middleware compiled with edge runtime target).
                // 1. Web adapter: default({ handler, request, page }) — Node middleware
                //    Returns raw NextResponse with x-middleware-* headers intact.
                // 2. Legacy: default.default({ request }) — older Next.js Edge output
                //    Pre-processes response (strips x-middleware-* headers).
                // 3. Direct handler: handler(request, { waitUntil }) — raw handler fn
                //
                // Web adapter MUST be tried first — the legacy path strips control
                // headers from the response, causing responseToMiddlewareResult to
                // misinterpret the result (sets bodySent=true incorrectly).

                try {
                  let response: Response | null = null;

                  // Path 0: Edge sandbox (for edge-compiled middleware)
                  if (edgeMiddlewareRunner) {
                    response = await edgeMiddlewareRunner({
                      url: ctx.url,
                      headers: ctx.headers,
                      method,
                      body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                    });
                  }

                  // Node middleware paths (only if no edge runner or edge didn't produce a response)
                  if (!response && middlewareModule) {
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

                    const waitUntil = (waitable: Promise<unknown>) => {
                      void waitable.catch(() => undefined);
                    };

                    // Path 1: Web adapter (default({ handler, request, page }))
                    if (adapterFn && handlerFn) {
                      const requestHeaders = Object.fromEntries(
                        [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                      );
                      // Node middleware wants request.body as a CloneableBody
                      // (has .cloneBodyStream()); wrap the buffered body in a
                      // Node Readable. GET/HEAD carry no body.
                      let mwBody: unknown;
                      if (method !== "GET" && method !== "HEAD") {
                        if (getCloneableBody) {
                          const { Readable } = await import("node:stream");
                          mwBody = getCloneableBody(Readable.fromWeb(ctx.requestBody as any));
                        } else {
                          mwBody = ctx.requestBody;
                        }
                      }
                      const result = await (adapterFn as any)({
                        handler: handlerFn,
                        request: {
                          url: ctx.url.toString(),
                          method,
                          headers: requestHeaders,
                          body: mwBody,
                          signal: new AbortController().signal,
                          nextConfig: manifestNextConfig(manifest),
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
                  } // end if (!response && middlewareModule)

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
                  middlewareThrew = true;
                  return { bodySent: true };
                }
              }
            : async () => ({}),
      });

      if (middlewareThrew) {
        return { kind: "error", status: 500 };
      }

      // 1. Redirects (rule/detection + Location-in-resolvedHeaders) — shared
      // normalization with the ext_proc edge (routing-common.ts).
      const redirect = normalizeResolvedRedirect(resolution, prep, manifest);
      if (redirect) {
        if (redirect.kind === "retry") {
          // Spurious internal trailing-slash redirect — resolve the real target.
          return this.resolve(redirect.retryUrl, headers, method, requestBody);
        }
        return {
          kind: "redirect",
          url: redirect.url,
          status: redirect.status,
          resolvedHeaders: redirect.resolvedHeaders,
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

      // Try exact match first, then try with/without trailing slash, then fall back to default pool.
      // Both resolvedPathname and matchedPathname are checked with trailing slash variants
      // because the pool assignment keys may differ from what @next/routing returns
      // depending on the app's trailingSlash config.
      const i18nLocales = (manifest.i18n as any)?.locales as string[] | undefined;
      const pool = lookupPool(
        manifest.poolAssignments,
        resolution.resolvedPathname,
        matchedPathname,
        i18nLocales,
      );

      if (!pool) {
        // Preserve headers set by middleware (NextResponse.next() with headers)
        // and route rules — they must still reach the 404 response.
        return { kind: "not-found", resolvedHeaders: resolution.resolvedHeaders ?? undefined };
      }

      let baseMatchedPathname = normalizeMatchedPathname(
        resolution.resolvedPathname ?? resolution.invocationTarget?.pathname ?? matchedPathname,
        manifest.poolAssignments,
      );
      // Concrete prerendered outputs win over dynamic templates (decoded lookup).
      baseMatchedPathname =
        preferConcreteOutput(url.pathname, baseMatchedPathname, manifest.poolAssignments) ??
        baseMatchedPathname;

      // For RSC requests, resolve to the .rsc / segment-prefetch output variant so the handler
      // returns a flight payload instead of HTML. Shared with the ext_proc edge path
      // (routing-service/handler.ts) so both resolvers map RSC identically.
      const finalMatchedPathname = resolveRscOutput(
        baseMatchedPathname,
        headers,
        (manifest.routeGraph as { rsc?: RscConfig } | undefined)?.rsc,
        manifest.poolAssignments,
      );

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
