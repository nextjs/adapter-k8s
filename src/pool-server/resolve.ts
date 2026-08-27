// src/pool-server/resolve.ts
import { responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";
import {
  hasCallableNodeMiddlewareEntrypoint,
  invokeNodeMiddleware,
} from "../next-runtime/middleware-entrypoint.js";
import {
  applyRewriteSignalHeaders,
  computeRewriteInvocation,
  computeRewriteSignalHeaders,
  getRscConfig,
  isRscRequest,
  lookupPool,
  manifestNextConfig,
  matchesMiddleware,
  mergeInvocationQuery,
  middlewareAuthoredRedirect,
  normalizeResolvedRedirect,
  prepareRequest,
  queryFromUrl,
  resolveOutputPathname,
  resolveRscOutput,
  resolveRoutesWithNextParity,
  sanitizeRouteMatches,
  type MiddlewareMatcher,
} from "../routing-common.js";

type LoadedModule = Record<string, unknown>;

export function hasCallableMiddlewareExport(module: LoadedModule | null | undefined): boolean {
  return hasCallableNodeMiddlewareEntrypoint(module);
}

export type ResolveResult =
  | {
      kind: "route";
      pool: string;
      matchedPathname: string;
      routeMatches: Record<string, string> | null;
      resolvedHeaders: Headers | undefined;
      middlewareRequestHeaders?: Headers | undefined;
      /** Rewritten path+query to invoke the handler with (middleware/config
       * rewrites). Absent when it equals the original request URL. */
      invokePath?: string | undefined;
      /** Resolved user query for the documented handler context. */
      invocationQuery?: Record<string, string | string[]> | undefined;
      /** Trusted absolute Unix execution deadline propagated across pool hops. */
      executionDeadlineAt?: number | undefined;
    }
  | { kind: "redirect"; url: URL; status: number; resolvedHeaders?: Headers | undefined }
  | { kind: "error"; status: number }
  | { kind: "middleware-response"; response: Response }
  | { kind: "external-rewrite"; url: URL }
  | {
      kind: "not-found";
      resolvedHeaders?: Headers | undefined;
      middlewareRequestHeaders?: Headers | undefined;
    };

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
  // Middleware `matcher` config (source regexp + has/missing) — middleware only
  // runs when the request matches. Absent → run always.
  middlewareMatchers?: MiddlewareMatcher[] | undefined,
) {
  return {
    async resolve(
      url: URL,
      headers: Headers,
      method: string,
      requestBody: ReadableStream<Uint8Array>,
      rewriteDepth = 0,
      middlewareAlreadyRan = false,
      // N40b (SECURITY). The mutated request headers of the pass that is CONTINUING into this
      // one (the i18n trailing-slash retry below). Middleware deliberately does not run again
      // on a continuation, so this set is not re-derivable — and dropping it silently undid
      // `NextResponse.next({ request: { headers } })` on that path: an auth middleware's header
      // deletion / credential injection was reverted to the client's own headers, while the pool
      // still skipped its middleware. Same defect the ext_proc tier had at
      // routing-service/handler.ts (both tiers fixed together, on purpose — the retry path is
      // asserted identical in tests/routing-common.tier-parity.test.ts). The same-deployment
      // rewrite continuation below already propagated it via its result merge.
      inheritedMiddlewareRequestHeaders?: Headers | undefined,
    ): Promise<ResolveResult> {
      let middlewareResponse: Response | null = null;
      // Captures the mutated request headers from responseToMiddlewareResult.
      // This includes x-middleware-set-cookie, x-middleware-override-headers,
      // and x-middleware-request-* modifications — all applied in one place.
      let middlewareRequestHeaders: Headers | null = inheritedMiddlewareRequestHeaders ?? null;
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
      // x-nextjs-data is a client hint, not sufficient proof of a data
      // request. Next only exposes it to middleware after the URL has matched
      // the build-scoped /_next/data protocol; accepting it on an arbitrary
      // document URL makes middleware redirects lose Location.
      const routingHeaders = new Headers(headers);
      if (prep.isDataRequest) routingHeaders.set("x-nextjs-data", "1");
      else routingHeaders.delete("x-nextjs-data");

      // A declared middleware policy without an executable implementation is a server error,
      // never an implicit `next()`. This resolver is the security fallback when ext_proc is
      // absent/fails, so failing open here would bypass the policy in both tiers.
      if (
        manifest.middleware &&
        !edgeMiddlewareRunner &&
        !hasCallableMiddlewareExport(middlewareModule)
      ) {
        return { kind: "error", status: 500 };
      }

      const resolution = await resolveRoutesWithNextParity({
        url,
        buildId: manifest.buildId,
        basePath: manifest.basePath,
        requestBody,
        headers: routingHeaders,
        pathnames: manifest.pathnames,
        i18n: (manifest.i18n as any) ?? undefined,
        routes: manifest.routeGraph,
        // invokeMiddleware MUST always be a function — resolveRoutes calls it
        // unconditionally (no null guard). When no middleware exists, return empty result.
        invokeMiddleware:
          middlewareModule || edgeMiddlewareRunner
            ? async (ctx) => {
                // Edge sandbox invocation stays here because it is a different runtime. Node
                // shape discrimination and the measured load-bearing order live in the shared
                // next-runtime/middleware-entrypoint module used by both Node tiers.

                try {
                  // A same-origin middleware rewrite continues route resolution internally. It
                  // is still the same request and middleware has already produced its verdict;
                  // invoking it again both violates Next's single-pass middleware contract and
                  // attempts to consume the same POST body stream twice (`ReadableStream is
                  // locked`). Config rewrites continue to resolve normally through @next/routing.
                  if (middlewareAlreadyRan) return {};
                  // Honor the middleware `matcher` config: skip middleware for
                  // requests it doesn't match (has/missing conditions, source).
                  if (!matchesMiddleware(middlewareMatchers, ctx.url, ctx.headers)) {
                    return {};
                  }

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
                    const invoked = await invokeNodeMiddleware(middlewareModule, {
                      url: ctx.url,
                      headers: ctx.headers,
                      method,
                      requestBody: ctx.requestBody,
                      nextConfig: manifestNextConfig(manifest),
                      getCloneableBody: getCloneableBody ?? null,
                      logBackgroundError(error) {
                        console.error("[pool-server] middleware background work failed:", error);
                      },
                    });
                    // The startup guard above normally makes this unreachable. Keep it explicit:
                    // a declared policy never degrades into an implicit next().
                    if (invoked.kind === "unsupported") {
                      throw invoked.error;
                    }
                    if (invoked.kind === "invalid-result") {
                      throw invoked.error;
                    }
                    response = invoked.response;
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
      const redirect = normalizeResolvedRedirect(resolution, prep, manifest, {
        // N40: a plain `NextResponse.next()` is NOT a middleware-authored redirect — the
        // shared discriminator requires a `location` header. Passing `middlewareResponse !=
        // null` made the N15 request-query carry inert for every app with middleware.
        middlewareAuthored: middlewareAuthoredRedirect(middlewareResponse),
      });
      if (redirect) {
        if (redirect.kind === "retry") {
          // Spurious internal trailing-slash redirect — resolve the real target.
          // Middleware already ran in THIS pass (same request, same verdict), so mark
          // it: re-invoking would both double-apply middleware and consume the POST
          // body stream a second time (`ReadableStream is locked` → 500), exactly
          // like the same-deployment rewrite continuation below.
          //
          // N40b (SECURITY): the middleware's mutated request headers must ride along, or the
          // continuation returns a route with NO middlewareRequestHeaders and dispatch.ts
          // installs nothing — the handler then sees the client's original headers even though
          // middleware asked for a replacement set (and cannot be re-run to ask again).
          return this.resolve(
            redirect.retryUrl,
            headers,
            method,
            requestBody,
            0,
            true,
            middlewareRequestHeaders ?? undefined,
          );
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
        // @next/routing uses externalRewrite for every middleware rewrite URL,
        // including same-origin NextResponse.rewrite() targets. Those are an
        // internal routing continuation, not an HTTP proxy hop: proxying loses
        // the original Pages data URL and makes the entrypoint render HTML.
        if (isSameDeploymentRewrite(url, resolution.externalRewrite)) {
          if (rewriteDepth >= 8) return { kind: "error", status: 508 };
          const rewritten = await this.resolve(
            resolution.externalRewrite,
            middlewareRequestHeaders ?? headers,
            method,
            requestBody,
            rewriteDepth + 1,
            true,
          );
          if (rewritten.kind !== "route") return rewritten;

          const rewriteQuery = queryFromUrl(resolution.externalRewrite);
          const resolvedHeaders =
            mergeHeaders(resolution.resolvedHeaders ?? undefined, rewritten.resolvedHeaders) ??
            (prep.isDataRequest ? new Headers() : undefined);
          if (prep.isDataRequest) {
            resolvedHeaders?.set(
              "x-nextjs-rewrite",
              pagesRewriteSignalPath(resolution.externalRewrite, manifest),
            );
          }
          return {
            ...rewritten,
            resolvedHeaders,
            middlewareRequestHeaders:
              rewritten.middlewareRequestHeaders ?? middlewareRequestHeaders ?? undefined,
            // A data request must keep its public /_next/data URL so the Pages
            // entrypoint emits JSON. Document requests use invocation metadata
            // to render the internal target while preserving req.url.
            invokePath: prep.isDataRequest
              ? undefined
              : (rewritten.invokePath ??
                resolution.externalRewrite.pathname + resolution.externalRewrite.search),
            invocationQuery: mergeInvocationQuery(rewriteQuery, rewritten.invocationQuery),
          };
        }
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
        return {
          kind: "not-found",
          resolvedHeaders: resolution.resolvedHeaders ?? undefined,
          middlewareRequestHeaders: middlewareRequestHeaders ?? undefined,
        };
      }

      // Output-key resolution (normalize → prefer a concrete output over a dynamic
      // template) — ONE implementation with the ext_proc edge
      // (routing-common.ts resolveOutputPathname), which carries the reasoning for
      // each step. The edge used to hand-mirror this and had drifted.
      const baseMatchedPathname = resolveOutputPathname({
        requestPathname: url.pathname,
        resolvedPathname: resolution.resolvedPathname,
        invocationTargetPathname: resolution.invocationTarget?.pathname,
        poolAssignments: manifest.poolAssignments,
      });

      // For RSC requests, resolve to the .rsc / segment-prefetch output variant so the handler
      // returns a flight payload instead of HTML. Shared with the ext_proc edge path
      // (routing-service/handler.ts) so both resolvers map RSC identically.
      const rscConfig = getRscConfig(manifest);
      const finalMatchedPathname = resolveRscOutput(
        baseMatchedPathname,
        headers,
        rscConfig,
        manifest.poolAssignments,
      );

      // Build the handler-invocation URL from the resolved routing target so
      // middleware/config rewrites (which change pathname and/or query) reach
      // the handler — otherwise the handler runs against the ORIGINAL request
      // URL and dynamic params / added query are lost. Strip the internally
      // added locale prefix (handlers receive the unprefixed URL, matching
      // non-rewrite behavior). Only set when it differs from the original
      // request so normal requests dispatch exactly as before.
      //
      // A middleware/config rewrite is handled two ways depending on request
      // kind. For a plain document request we override the handler URL
      // (invokePath) so params/query render correctly. For an RSC request the
      // routing already resolved the right handler+params (the flight renders
      // correctly), but the client router needs the x-nextjs-rewritten-path /
      // -query response headers to reconcile its URL state — without them
      // router.query reflects the ORIGINAL request path. This is the core of
      // "middleware rewrites work behind a CDN": the client-transition (flight)
      // path must carry the rewrite signal, not just the direct render.
      // ONE derivation with the ext_proc edge, which transports the same two values over
      // x-invoke-path / x-invoke-query (routing-common.ts computeRewriteInvocation). The pool
      // used to carry a hand-mirrored copy of this block plus private copies of every helper
      // it calls — that is exactly the drift routing-common.ts exists to prevent.
      const isRscReq = isRscRequest(headers, rscConfig);
      const { invokePath, invocationQuery } = computeRewriteInvocation({
        originalUrl: prep.originalUrl,
        addedLocale: prep.addedLocale,
        isRscRequest: isRscReq,
        isDataRequest: prep.isDataRequest,
        routes: manifest.routeGraph,
        resolvedQuery: resolution.resolvedQuery,
        invocationTarget: resolution.invocationTarget,
        resolvedPathname: resolution.resolvedPathname,
      });

      // Middleware/config rewrites must be signalled to the client on the
      // negotiation requests it makes during a client-side navigation, or the
      // router's URL state stays on the original path (wrong router.query).
      // This is the crux of "middleware rewrites work behind a CDN". The two
      // client protocols:
      //   - App Router (RSC): x-nextjs-rewritten-path + x-nextjs-rewritten-query
      //   - Pages Router (_next/data): x-nextjs-rewrite: <path?query>
      // (Pages Router _next/data rewrite signalling is a separate bucket — its
      // double-resolve path makes the header capture unreliable here.)
      //
      // N19: the App Router derivation is the SHARED computeRewriteSignalHeaders
      // (routing-common.ts), which carries the upstream evidence for every rule it
      // encodes. The ext_proc edge (Phase 2, the production path) emitted NOTHING here
      // for next.config rewrites — proven against `next start` — because upstream splits
      // the emission between the middleware adapter (which both tiers already transport)
      // and the router-server layer this adapter replaces. One derivation, both tiers.
      const signal = computeRewriteSignalHeaders({
        originalUrl: prep.originalUrl,
        addedLocale: prep.addedLocale,
        isRscRequest: isRscReq,
        invocationTarget: resolution.invocationTarget,
        invocationQuery,
      });
      let resolvedHeaders = resolution.resolvedHeaders ?? undefined;
      if (signal.rewrittenPath !== undefined || signal.rewrittenQuery !== undefined) {
        resolvedHeaders = applyRewriteSignalHeaders(
          new Headers(resolvedHeaders ?? undefined),
          signal,
        );
      }

      return {
        kind: "route",
        pool,
        matchedPathname: finalMatchedPathname,
        routeMatches: sanitizeRouteMatches(resolution.routeMatches),
        resolvedHeaders,
        middlewareRequestHeaders: middlewareRequestHeaders ?? undefined,
        invokePath,
        invocationQuery,
      };
    },
  };
}

/**
 * N12. Pages Router clients read middleware rewrite metadata from `x-nextjs-rewrite`.
 * `next start` puts the PUBLIC PAGE path there, NOT a `/_next/data/<buildId>/….json` URL:
 * router-server strips the data prefix before middleware runs (server/lib/router-utils/
 * resolve-routes.ts, `middleware_next_data`), so NextURL.buildId is empty when
 * server/web/adapter.ts serializes the destination — verified against `next start`
 * 16.3.0-canary.84 for concrete pages (`/target`), dynamic pages (`/from-middleware`)
 * and app (`/headers`) destinations alike.
 *
 * This is not cosmetic: the client copies the value verbatim into `routeInfo.resolvedAs`
 * (getMiddlewareData → getRouteInfo) and `_bfl()` tests resolvedAs against the
 * client-router filter to decide whether the destination is an App Router route needing a
 * HARD navigation. A data-URL value is never in that filter, so a Pages→App middleware
 * rewrite soft-navigated to the Pages match and rendered the wrong router's page.
 */
function pagesRewriteSignalPath(target: URL, manifest: RoutingManifest): string {
  let pagePath = target.pathname;
  if (
    manifest.basePath &&
    (pagePath === manifest.basePath || pagePath.startsWith(`${manifest.basePath}/`))
  ) {
    pagePath = pagePath.slice(manifest.basePath.length) || "/";
  }
  if (pagePath !== "/" && pagePath.endsWith("/")) pagePath = pagePath.slice(0, -1);
  return `${pagePath === "/" ? manifest.basePath || "/" : `${manifest.basePath}${pagePath}`}${target.search}`;
}

function mergeHeaders(
  first: Headers | undefined,
  second: Headers | undefined,
): Headers | undefined {
  if (!first && !second) return undefined;
  const merged = new Headers(first);
  for (const [key, value] of second ?? []) merged.set(key, value);
  return merged;
}

function isSameDeploymentRewrite(requestUrl: URL, rewriteUrl: URL): boolean {
  if (requestUrl.origin === rewriteUrl.origin) return true;
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const effectivePort = (url: URL) =>
    url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "");
  return (
    requestUrl.protocol === rewriteUrl.protocol &&
    effectivePort(requestUrl) === effectivePort(rewriteUrl) &&
    loopback.has(requestUrl.hostname) &&
    loopback.has(rewriteUrl.hostname)
  );
}

export type LocalResolver = ReturnType<typeof createLocalResolver>;

export type PlatformResolveResult =
  | Exclude<ResolveResult, { kind: "not-found" }>
  | {
      kind: "continue-platform";
      resolvedHeaders?: Headers | undefined;
      middlewareRequestHeaders?: Headers | undefined;
    };

/**
 * Run the normal Next routing phase before a platform-owned route such as the image optimizer.
 * A filesystem route selected only because it broadly matches the original pathname must not
 * displace the platform route. Rewrites are different: an invocation target that is not the same
 * normalized public URL remains terminal.
 */
export async function resolvePlatformRequest(
  resolver: LocalResolver,
  url: URL,
  headers: Headers,
  method: string,
  requestBody: ReadableStream<Uint8Array>,
): Promise<PlatformResolveResult> {
  const resolution = await resolver.resolve(url, headers, method, requestBody);
  if (
    resolution.kind === "not-found" ||
    (resolution.kind === "route" &&
      (resolution.invokePath === undefined || targetsSamePlatformUrl(resolution.invokePath, url)))
  ) {
    return {
      kind: "continue-platform",
      resolvedHeaders: resolution.resolvedHeaders,
      middlewareRequestHeaders: resolution.middlewareRequestHeaders,
    };
  }
  return resolution;
}

export function targetsSamePlatformUrl(invokePath: string, requestUrl: URL): boolean {
  const target = new URL(invokePath, requestUrl);
  return (
    target.origin === requestUrl.origin &&
    target.pathname === requestUrl.pathname &&
    equalSearchParams(target.searchParams, requestUrl.searchParams)
  );
}

function equalSearchParams(left: URLSearchParams, right: URLSearchParams): boolean {
  const keys = new Set([...left.keys(), ...right.keys()]);
  for (const key of keys) {
    const leftValues = left.getAll(key);
    const rightValues = right.getAll(key);
    if (
      leftValues.length !== rightValues.length ||
      leftValues.some((value, index) => value !== rightValues[index])
    ) {
      return false;
    }
  }
  return true;
}
