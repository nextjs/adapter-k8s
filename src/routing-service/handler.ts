import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";
import type { ProcessingResponse, HeaderValue } from "./ext-proc-types.js";
import {
  buildImmediateResponse,
  buildHeaderMutationResponse,
  type HeaderMutationEntry,
} from "./response-builders.js";
import {
  applyRewriteSignalHeaders,
  computeRewriteInvocation,
  computeRewriteSignalHeaders,
  getRscConfig,
  grantsSharedCacheFreshness,
  isRscRequest,
  lookupPool,
  manifestNextConfig,
  matchesMiddleware,
  normalizeResolvedRedirect,
  prepareRequest,
  resolveOutputPathname,
  resolveRscOutput,
  rscCacheBustingUnvalidated,
  sanitizeRouteMatches,
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_SECRET_HEADER,
} from "../routing-common.js";

type LoadedModule = Record<string, unknown>;

// Abort-shaped errors raised by the request-shed signal: AbortSignal.timeout()
// aborts with a DOMException named "TimeoutError", a manual controller.abort()
// yields "AbortError", and middleware (e.g. a fetch wrapper) may re-wrap either —
// so also check `cause` one level deep for the same shapes.
function isAbortError(err: unknown): boolean {
  const shaped = (e: unknown): boolean =>
    typeof e === "object" &&
    e !== null &&
    ((e as { name?: unknown }).name === "AbortError" ||
      (e instanceof DOMException && e.name === "TimeoutError"));
  return shaped(err) || shaped((err as { cause?: unknown } | null | undefined)?.cause);
}

function getHeader(headers: HeaderValue[], key: string): string | undefined {
  const h = headers.find((h) => h.key === key);
  if (!h) return undefined;
  if (h.value) return h.value;
  if (h.rawValue) return h.rawValue.toString("utf-8");
  return undefined;
}

// Serialize the resolved response headers (next.config `headers()` + middleware response
// headers) into a single JSON internal header. The pool applies these to the RESPONSE
// (dispatch.ts merges resolvedHeaders via a writeHead wrapper). Emitting them as individual
// request-header mutations — as this handler used to — both drops them (they never reach the
// response) and leaks their values into the upstream request under their real names.
function serializeResolvedHeaders(resolved: Headers): string | null {
  const obj: Record<string, string | string[]> = {};
  for (const [key, value] of resolved.entries()) {
    // Headers.entries() folds repeated Set-Cookie into one comma-joined value; collect them
    // separately below so each cookie survives intact.
    if (key.toLowerCase() === "set-cookie") continue;
    obj[key] = value;
  }
  const cookies = resolved.getSetCookie?.() ?? [];
  if (cookies.length > 0) obj["set-cookie"] = cookies;
  if (Object.keys(obj).length === 0) return null;
  return JSON.stringify(obj);
}

// N18 (SECURITY). Almost every response is authored by a pool, which owns the forced-cache
// verdict (pool-server/index.ts + cache-policy.ts) and therefore enforces the RSC
// `_rsc`-validation invariant for the whole dataplane. Two response classes never touch a pool:
// a middleware-authored body and a rule/middleware redirect, both returned from here as ext_proc
// IMMEDIATE responses with their headers copied verbatim from the middleware `Response` /
// next.config `headers()` verdict. Those headers can carry a shared-cacheable Cache-Control, so
// an unvalidated RSC request could still mint a storable entry. Downgrade it here.
//
// Narrow on purpose: only a Cache-Control that actually grants a shared cache an unrevalidated
// window is replaced. We do NOT stamp `no-store` onto responses that had no Cache-Control —
// Cloud CDN runs USE_ORIGIN_HEADERS (it stores nothing without an explicit directive), so adding
// a header there would change observable behavior for zero security gain. Never 307s: same
// fail-safe reasoning as routing-common.ts `rscCacheBustingUnvalidated`.
function withRscCacheBustingGuard(
  headers: Record<string, string>,
  unvalidatedRscRequest: boolean,
): Record<string, string> {
  if (!unvalidatedRscRequest) return headers;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== "cache-control") continue;
    if (grantsSharedCacheFreshness(headers[key]!)) headers[key] = "no-store";
  }
  return headers;
}

export function createRequestHandler(
  manifest: RoutingManifest,
  middlewareModule: LoadedModule | null,
  opts?: { timeoutMs?: number },
) {
  // Shared secret authenticating the internal dispatch headers to the pool. Present in GKE
  // (injected from a Secret); absent in emulate/tests, where the pool trusts nothing over the
  // wire and re-resolves locally. Read once — the deployment env is fixed for the process.
  const internalSecret = process.env.INTERNAL_HEADER_SECRET || undefined;
  const rscConfig = getRscConfig(manifest);
  // Per-request budget mirrored from the server's withTimeout shed — when it fires,
  // this signal aborts so middleware awaiting a slow upstream is actually cancelled
  // instead of racing a shed response it can no longer influence. 0 disables.
  const timeoutMs = opts?.timeoutMs ?? 0;

  return async function handleRequest(
    requestHeaders: HeaderValue[],
    // Internal (trailing-slash retry only): the shed signal of the ORIGINAL request,
    // so the retry spends the remaining budget instead of minting a fresh full window
    // while the server-side withTimeout keeps the original clock.
    inheritedShedSignal?: AbortSignal,
  ): Promise<ProcessingResponse> {
    const rawPath = getHeader(requestHeaders, ":path") ?? "/";
    const method = getHeader(requestHeaders, ":method") ?? "GET";
    const scheme = getHeader(requestHeaders, ":scheme") ?? "https";
    const authority = getHeader(requestHeaders, ":authority") ?? "localhost";
    const url = new URL(`${scheme}://${authority}${rawPath}`);

    // Ingress hygiene: a client can send any x-* header, and the egress mutations
    // below only overwrite the keys they set — so strip the whole internal dispatch
    // vocabulary (plus the secret) BEFORE anything else sees it. Spoofed values must
    // never reach resolveRoutes or middleware (an auth middleware reading a spoofed
    // x-output-id / x-mw-evaluated would be deciding on attacker input). The pool
    // applies the same strip-unless-secret discipline server-side.
    const headers = new Headers(
      requestHeaders
        .filter(
          (h) =>
            !h.key.startsWith(":") &&
            !(INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(h.key.toLowerCase()) &&
            h.key.toLowerCase() !== INTERNAL_SECRET_HEADER,
        )
        .map((h) => [h.key, h.value ?? h.rawValue?.toString("utf-8") ?? ""] as [string, string]),
    );

    // N18 (SECURITY): does this request's `_rsc` authenticate its RSC headers? Read off the
    // ORIGINAL public URL and the client's own headers, before prepareRequest can rewrite either.
    // Only consulted for the immediate responses this tier authors itself (see
    // withRscCacheBustingGuard); pool-bound requests are enforced by the pool, which is the tier
    // that owns Cache-Control and is the only one every request reaches.
    const unvalidatedRscRequest =
      (method === "GET" || method === "HEAD") &&
      rscCacheBustingUnvalidated({
        header: (name) => headers.get(name) ?? undefined,
        searchParams: url.searchParams,
        rsc: rscConfig,
      });

    // Shared request normalization (decode-400, slash-collapse 308, locale
    // prefixing) — one sequence with the pool resolver (routing-common.ts).
    const prep = prepareRequest(url, headers, manifest);
    if (prep.kind === "error") {
      return buildImmediateResponse(prep.status, { "content-type": "text/plain; charset=utf-8" });
    }
    if (prep.kind === "redirect") {
      return buildImmediateResponse(prep.status, { location: prep.url.toString() });
    }
    const resolveUrl = prep.url;
    // Fallback pathname for dispatch when resolution yields none. NEVER the raw
    // :path — that includes the query string, so "?x=1" would leak into the
    // x-output-id/x-upstream-pool derivation. resolveUrl is the prepared
    // (locale-prefixed) URL, matching the pool resolver's url.pathname fallback.
    const fallbackPathname = resolveUrl.pathname;

    // x-nextjs-data is a client hint, not proof of a data request — Next only
    // honors it after the URL matches the build-scoped /_next/data protocol.
    // Mirrors the pool resolver (resolve.ts): drop it for non-data requests.
    if (!prep.isDataRequest) headers.delete("x-nextjs-data");

    // The shed signal handed to middleware: aborts when the per-request budget
    // expires (server.ts's withTimeout shed uses the same budget), so middleware
    // awaiting a slow upstream is actually cancelled instead of racing a shed
    // response it can no longer influence. AbortSignal.timeout is unref'd and
    // self-cleaning — no manual timer to clear on the many return paths below.
    const shedSignal =
      inheritedShedSignal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);

    // Body-capable requests (non-GET/HEAD) with middleware are NOT resolved at the edge: the
    // header-phase ext_proc callout never sees the request body, so body-reading middleware
    // would decide on an empty body. Instead we hand off to the pool's Phase-1 resolver, which
    // has the real buffered body. Crucially we do NOT just pass through — we CLEAR every
    // internal dispatch header (no secret, so the pool wouldn't trust them anyway, but this is
    // the first line of defense) so a client can't smuggle a spoofed x-output-id past the
    // extension and have the pool dispatch straight to a handler, bypassing middleware auth.
    // No secret is added, so the pool treats the request as untrusted → runs Phase 1.
    if (middlewareModule && method !== "GET" && method !== "HEAD") {
      return buildHeaderMutationResponse(
        [],
        [...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER],
      );
    }

    let middlewareResponse: Response | undefined;
    // Fail CLOSED on middleware throw — see pool-server/resolve.ts. A crashing
    // middleware must 500, not silently emit trusted dispatch headers that let
    // the request bypass the auth/redirects/rewrites middleware implements.
    let middlewareThrew = false;
    // Positive record of what the middleware STAGE actually did, stamped to `x-mw-evaluated`
    // so the pool can trust the skip instead of inferring "middleware ran" from the presence
    // of routing headers. Pessimistic default `error` while middleware is configured but not
    // yet confirmed to have run (so the pool re-evaluates); `none` when there is no middleware.
    let mwEvaluated: "ran" | "skip-nomatch" | "none" | "error" = middlewareModule
      ? "error"
      : "none";

    const resolution = await resolveRoutes({
      url: resolveUrl,
      buildId: manifest.buildId,
      basePath: manifest.basePath,
      requestBody: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      headers,
      pathnames: manifest.pathnames,
      i18n: (manifest.i18n || undefined) as any,
      routes: manifest.routeGraph,
      // Next.js middleware modules have multiple shapes depending on compilation
      // target. The ordering here MUST match pool-server/resolve.ts (paths 1/2/3);
      // web-adapter first is load-bearing — the legacy path strips control headers
      // from the response, which makes responseToMiddlewareResult misinterpret it.
      // The routing-service runs Node middleware only, so there is no edge-sandbox
      // path 0 here.
      invokeMiddleware: middlewareModule
        ? async (ctx) => {
            try {
              // Honor the middleware `matcher` config (parity with the pool
              // resolver) — skip middleware for requests it doesn't match.
              if (!matchesMiddleware(manifest.middleware?.matchers, ctx.url, ctx.headers)) {
                mwEvaluated = "skip-nomatch";
                return {};
              }

              let response: Response | null = null;

              const adapterFn =
                typeof middlewareModule.default === "function"
                  ? (middlewareModule.default as (...args: unknown[]) => unknown)
                  : null;

              const exportedHandler =
                (middlewareModule as Record<string, unknown>).proxy ??
                (middlewareModule as Record<string, unknown>).middleware;
              const handlerFn =
                typeof exportedHandler === "function"
                  ? (exportedHandler as (...args: unknown[]) => unknown)
                  : typeof middlewareModule === "function"
                    ? (middlewareModule as unknown as (...args: unknown[]) => unknown)
                    : null;

              const legacyMiddlewareFn =
                typeof (middlewareModule.default as Record<string, unknown> | undefined)
                  ?.default === "function"
                  ? ((middlewareModule.default as Record<string, unknown>).default as (
                      ...args: unknown[]
                    ) => unknown)
                  : null;
              const adapterHandler = handlerFn ?? (adapterFn ? middlewareModule : null);

              // Manifest declares middleware but no callable export was found — this is the
              // exact silent-bypass state. Leave `mwEvaluated = "error"` so the pool does NOT
              // trust the skip and re-runs middleware itself.
              if (!adapterFn && !handlerFn && !legacyMiddlewareFn) return {};
              // A callable was found and is about to run — the middleware stage is genuinely
              // evaluated for this request.
              mwEvaluated = "ran";

              const pendingWaitUntil: Promise<void>[] = [];
              const waitUntil = (waitable: Promise<unknown>) => {
                pendingWaitUntil.push(
                  Promise.resolve(waitable)
                    .then(() => undefined)
                    .catch((error) => {
                      console.error("[routing-service] middleware background work failed:", error);
                    }),
                );
              };

              // Path 1: Web adapter (default({ handler, request, page }))
              if (adapterFn && adapterHandler) {
                const requestHeaders = Object.fromEntries(
                  [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                );
                const result = await (adapterFn as any)({
                  handler: adapterHandler,
                  request: {
                    url: ctx.url.toString(),
                    method,
                    headers: requestHeaders,
                    body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                    // Wired to the request-time shed budget — a previously
                    // never-aborted controller meant the timeout shed rejected the
                    // response but the middleware kept running detached.
                    signal: shedSignal ?? new AbortController().signal,
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
                    // Next's legacy adapter (next/dist/server/web/adapter.js) forwards
                    // params.request.signal into the NextRequest init, so the shed
                    // budget reaches legacy middleware through the same field Path 1
                    // uses — without it, legacy middleware keeps running detached
                    // after the server-side timeout shed rejects the response.
                    signal: shedSignal ?? new AbortController().signal,
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
                  // Shed budget must abort Path 3 middleware too — the Request ctor
                  // adopts this signal as request.signal for the handler to observe.
                  signal: shedSignal ?? null,
                  duplex: "half",
                };
                if (method !== "GET" && method !== "HEAD") {
                  requestInit.body = ctx.requestBody;
                }
                const middlewareRequest = new Request(ctx.url.toString(), requestInit);
                const result = await (handlerFn as any)(middlewareRequest, { waitUntil });

                response =
                  result instanceof Response
                    ? result
                    : result?.response instanceof Response
                      ? result.response
                      : null;
              }

              // ext_proc is the platform invocation for Node middleware. Keep it alive until
              // registered after()/cache work completes so cutover or request teardown cannot
              // discard side effects; shared cache state itself remains in Valkey.
              await Promise.all(pendingWaitUntil);

              if (response) {
                middlewareResponse = response;
                return responseToMiddlewareResult(
                  response.clone(),
                  new Headers(ctx.headers),
                  ctx.url,
                );
              }
              return {};
            } catch (err) {
              // Shed-abort ≠ middleware crash. When the per-request budget expires,
              // the shed signal aborts signal-aware middleware and the rejection must
              // be answered by the SERVER's configured fail-open/fail-closed policy
              // (createProcessHandler in server.ts), not the unconditional fail-closed
              // 500 below — that one exists for genuine middleware crashes (auth must
              // not be bypassed). Rethrow: resolveRoutes awaits invokeMiddleware bare,
              // so this rejects the handleRequest promise the server observes.
              // Previously the abort was classified as a crash, making `failOpen: true`
              // a no-op for signal-aware middleware exceeding timeoutMs.
              if (isAbortError(err) || shedSignal?.aborted) throw err;
              console.error("[routing-service] Middleware execution failed:", err);
              middlewareThrew = true;
              return { bodySent: true };
            }
          }
        : async () => ({}),
    });

    if (middlewareThrew) {
      return buildImmediateResponse(500, { "content-type": "text/plain; charset=utf-8" });
    }

    // Redirects (rule/detection + Location-in-resolvedHeaders) — shared
    // normalization with the pool resolver. Forward resolvedHeaders (middleware
    // Set-Cookie, custom redirect headers) so the edge matches the pool phase.
    const redirect = normalizeResolvedRedirect(resolution, prep, manifest, {
      middlewareAuthored: middlewareResponse != null,
    });
    if (redirect) {
      if (redirect.kind === "retry") {
        // Spurious internal trailing-slash redirect — resolve the real target.
        const retried = requestHeaders.map((h) =>
          h.key === ":path"
            ? { ...h, value: redirect.retryUrl.pathname + redirect.retryUrl.search }
            : h,
        );
        // Carry the ORIGINAL shed signal into the retry: the server-side withTimeout
        // (server.ts) keeps the first request's clock across this recursion, so a
        // fresh AbortSignal.timeout here would give the retried middleware a full
        // new budget that outlives the shed response.
        return handleRequest(retried, shedSignal);
      }
      const responseHeaders: Record<string, string> = {};
      const setCookies = redirect.resolvedHeaders?.getSetCookie?.() ?? [];
      if (redirect.resolvedHeaders) {
        for (const [key, value] of redirect.resolvedHeaders.entries()) {
          const k = key.toLowerCase();
          if (k === "location" || k === "set-cookie" || k === "content-length") continue;
          responseHeaders[key] = value;
        }
      }
      // N15: no RSC special-case — `next start` answers RSC redirects with the real 3xx and the
      // App Router flight client follows it (fetch-server-response.ts reads response.redirected).
      // `x-nextjs-redirect` is a PAGES-router protocol (written under isNextDataRequest, read by
      // shared/lib/router/router.ts); emitting it for App Router stranded the flight client,
      // which then fell back to a document load. Same-origin Locations are relativized so both
      // tiers match (the pool already relativizes via middlewareRedirectLocation) and so the
      // shape matches `next start`, which reports a RELATIVE path for same-origin targets.
      const sameOrigin = redirect.url.origin === url.origin;
      const location = sameOrigin
        ? redirect.url.pathname + redirect.url.search + redirect.url.hash
        : redirect.url.toString();
      responseHeaders["location"] = location;
      if (redirect.status === 308) responseHeaders["Refresh"] = `0;url=${location}`;
      return buildImmediateResponse(
        redirect.status,
        withRscCacheBustingGuard(responseHeaders, unvalidatedRscRequest),
        undefined,
        setCookies,
      );
    }

    if (resolution.middlewareResponded && middlewareResponse != null) {
      const mwRes = middlewareResponse as Response;
      const respHeaders: Record<string, string> = {};
      for (const [key, value] of mwRes.headers.entries()) {
        // Headers.entries() folds multiple Set-Cookie into one comma-joined
        // value; skip them here and forward each intact via getSetCookie().
        if (key.toLowerCase() === "set-cookie") continue;
        respHeaders[key] = value;
      }
      const setCookies = mwRes.headers.getSetCookie();
      return buildImmediateResponse(
        mwRes.status,
        withRscCacheBustingGuard(respHeaders, unvalidatedRscRequest),
        await mwRes.text(),
        setCookies,
      );
    }

    if (resolution.externalRewrite) {
      return buildImmediateResponse(
        502,
        { "content-type": "text/plain; charset=utf-8" },
        `External rewrites are not supported in adapter-k8s v1. ` +
          `Attempted rewrite to: ${resolution.externalRewrite.toString()}\n` +
          `Use a Route Handler to proxy external APIs instead.`,
      );
    }

    // Pool ownership is looked up on the BASE pathname (RSC variants live in the same pool as
    // their page). The output id, however, must be the RSC-mapped variant so the handler
    // returns a flight payload instead of HTML — mirrors pool-server/resolve.ts.
    //
    // Output-key resolution is now the SHARED implementation (routing-common.ts
    // resolveOutputPathname). This tier used to hand-mirror it and had drifted: it only ever
    // preferred a concrete output for the PUBLIC request pathname, never for the rewrite
    // INVOCATION TARGET, so a rewrite whose destination also matched a dynamic route
    // (`/rewrite-1` → `/gssp`, resolvedPathname `/[slug]`) dispatched the `[slug]` template at
    // the edge while the pool's Phase-1 resolver dispatched `/gssp`.
    const basePathname = resolveOutputPathname({
      requestPathname: resolveUrl.pathname,
      resolvedPathname: resolution.resolvedPathname,
      invocationTargetPathname: resolution.invocationTarget?.pathname,
      poolAssignments: manifest.poolAssignments,
    });
    const outputId = resolveRscOutput(basePathname, headers, rscConfig, manifest.poolAssignments);

    const mutations: HeaderMutationEntry[] = [];
    // Every internal dispatch header the extension does NOT set this response must be actively
    // removed, so a client can't smuggle one past the extension (setHeaders only overwrites the
    // keys it lists). We start by clearing all of them, then un-clear each key we set below.
    const clear = new Set<string>([...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER]);
    const setDispatch = (key: string, value: string) => {
      mutations.push({ key, value });
      clear.delete(key);
    };

    // Rewrite invocation target: when routing rewrote the URL (middleware or next.config
    // rewrites), the pool must invoke the handler with the REWRITTEN path+query while the
    // public :path is preserved for the client. Without this transport, a trusted-dispatch
    // request runs the handler against the ORIGINAL URL and every rewrite-added query param
    // (e.g. a destination's repeated `?item=one&item=two`) is silently dropped. Same
    // derivation as pool-server/resolve.ts (shared computeRewriteInvocation).
    const rscRequest = isRscRequest(headers, rscConfig);
    const invocation = computeRewriteInvocation({
      originalUrl: prep.originalUrl,
      addedLocale: prep.addedLocale,
      isRscRequest: rscRequest,
      isDataRequest: prep.isDataRequest,
      routes: manifest.routeGraph,
      resolvedQuery: resolution.resolvedQuery,
      invocationTarget: resolution.invocationTarget,
      resolvedPathname: resolution.resolvedPathname,
    });

    // N19. next.config headers() + middleware response headers → carried as one JSON header
    // and applied to the RESPONSE by the pool (NOT emitted as request-header mutations).
    //
    // The App Router client-facing rewrite signal rides in the SAME slot, because it is a
    // RESPONSE header the browser reads (routing-common.ts computeRewriteSignalHeaders carries
    // the upstream evidence) and this ext_proc filter only processes the REQUEST phase —
    // server.ts echoes `responseHeaders` untouched, so the edge cannot set a response header
    // itself. Riding in `x-resolved-headers` also means the signal inherits that header's
    // secret gating for free: the pool strips the whole internal dispatch vocabulary unless the
    // internal-secret compare succeeds, so a client cannot forge its own rewrite signal.
    //
    // Upstream sets these headers in TWO layers and the adapter replaces exactly one:
    // middleware rewrites get them from `server/web/adapter.ts` on the middleware Response
    // (already inside resolution.resolvedHeaders here), while next.config rewrites get them
    // from `server/lib/router-utils/resolve-routes.ts` — the router-server layer this tier
    // replaces. That second class was silently missing at the edge: PROVEN against real
    // `next start` (`/rewrite-query-array` → p=/api/rewrite-query-array q=item=one&item=two on
    // `next start` and Phase 1, but nothing at all through Envoy+ext_proc). The pool's Phase-1
    // resolver emitted it, so the whole e2e harness — which starts only the pool — was blind.
    const signal = computeRewriteSignalHeaders({
      originalUrl: prep.originalUrl,
      addedLocale: prep.addedLocale,
      isRscRequest: rscRequest,
      invocationTarget: resolution.invocationTarget,
      invocationQuery: invocation.invocationQuery,
    });
    const hasSignal = signal.rewrittenPath !== undefined || signal.rewrittenQuery !== undefined;
    if (resolution.resolvedHeaders || hasSignal) {
      // Overwrite rather than defer to whatever middleware already set, so both tiers land on
      // the one shared derivation (Phase 1 does the same) instead of one tier trusting the
      // middleware adapter's value and the other computing its own.
      const responseHeaders = applyRewriteSignalHeaders(
        new Headers(resolution.resolvedHeaders ?? undefined),
        signal,
      );
      const serialized = serializeResolvedHeaders(responseHeaders);
      if (serialized) setDispatch("x-resolved-headers", serialized);
    }

    const i18nLocales = (manifest.i18n as any)?.locales as string[] | undefined;
    const pool =
      lookupPool(
        manifest.poolAssignments,
        resolution.resolvedPathname,
        resolution.invocationTarget?.pathname ?? fallbackPathname,
        i18nLocales,
      ) ?? "default";
    setDispatch("x-upstream-pool", pool);

    // Positive assertion of what the middleware stage did. The pool only skips its own
    // middleware when this is one of the trusted verdicts (ran / skip-nomatch / none);
    // `error` (no callable found) leaves the pool to re-evaluate — closing the bypass.
    setDispatch("x-mw-evaluated", mwEvaluated);

    // x-output-id tells the pool server which handler to invoke directly,
    // bypassing local resolveRoutes() (avoids double resolution + middleware)
    setDispatch("x-output-id", outputId);
    setDispatch("x-matched-pathname", outputId);
    // Sanitized with the SHARED helper, exactly as Phase 1 does before it attaches
    // routeMatches to a local resolution: the edge must not be the tier that ships the
    // unresolved-dynamic sentinel over the wire and leaves the pool to catch it.
    const sanitizedRouteMatches = sanitizeRouteMatches(resolution.routeMatches);
    if (sanitizedRouteMatches) {
      setDispatch("x-route-matches", JSON.stringify(sanitizedRouteMatches));
    }

    // Transport the rewrite invocation target computed above.
    if (invocation.invokePath) {
      setDispatch("x-invoke-path", invocation.invokePath);
    }
    if (invocation.invocationQuery && Object.keys(invocation.invocationQuery).length > 0) {
      setDispatch("x-invoke-query", JSON.stringify(invocation.invocationQuery));
    }

    if (basePathname in manifest.pprRoutes) {
      setDispatch("x-nextjs-ppr", "1");
    }

    // Authenticate the dispatch headers to the pool. Only the trusted extension knows the
    // secret; the pool ignores (strips) dispatch headers on any request whose secret doesn't
    // match, so a spoofed x-output-id on a CEL-excluded path or during a fail-open outage is
    // rejected. Absent in emulate/tests (no secret configured) — the pool re-resolves locally.
    if (internalSecret) {
      mutations.push({ key: INTERNAL_SECRET_HEADER, value: internalSecret });
      clear.delete(INTERNAL_SECRET_HEADER);
    }

    return buildHeaderMutationResponse(mutations, [...clear]);
  };
}
