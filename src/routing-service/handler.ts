import { responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";
import { invokeNodeMiddleware } from "../next-runtime/middleware-entrypoint.js";
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
  fitsPoolHeaderBudget,
  getRscConfig,
  grantsSharedCacheFreshness,
  headerBlockBytes,
  isRscRequest,
  lookupPool,
  manifestNextConfig,
  matchesMiddleware,
  middlewareAuthoredRedirect,
  normalizeResolvedRedirect,
  parseRequestUrl,
  prepareRequest,
  resolveOutputPathname,
  resolveRscOutput,
  resolveRoutesWithNextParity,
  rscCacheBustingUnvalidated,
  sanitizeRouteMatches,
  serializeHeaderMap,
  coalesceWireHeaderBytes,
  computeDispatchProof,
  type ProofFieldValue,
  buildProofHeaderNames,
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_SECRET_HEADER,
  PROOF_COVERED_CONTEXT_HEADERS,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
} from "../routing-common.js";

type LoadedModule = Record<string, unknown>;

/** The `x-mw-evaluated` vocabulary (routing-common.ts MW_EVALUATED_TRUSTED recognizes the
 * first three; `error` deliberately does not authorize the pool to skip middleware). */
type MwEvaluated = "ran" | "skip-nomatch" | "none" | "error";

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

/**
 * One header entry's WIRE OCTETS.
 *
 * A0-DP-2. Envoy's ext_proc `HeaderValue` carries a value-vs-raw_value duality: `raw_value` is
 * `bytes` and preserves the field's octets exactly, while `value` is a proto3 `string` and can
 * therefore only ever hold a valid-UTF-8 value (obs-text and other non-UTF-8 octets are delivered
 * in `raw_value` only). So `raw_value` is passed through UNTOUCHED — a `toString("utf-8")`
 * round-trip here is what made the edge sign a different byte string than the pool for every
 * non-ASCII covered value — and an entry that carries only `value` is encoded back to the UTF-8
 * octets Envoy itself put on the wire.
 */
function getRawHeader(headers: HeaderValue[], key: string): Buffer | undefined {
  const h = headers.find((h) => h.key === key);
  if (!h) return undefined;
  if (h.rawValue) return h.rawValue;
  if (h.value) return Buffer.from(h.value, "utf8");
  return undefined;
}

/**
 * Read a real (non-pseudo) header the way the POOL will see it, as OCTETS: case-insensitive on
 * the name, and repeated entries coalesced with the rule the next hop applies (routing-common.ts
 * `coalesceWireHeaderBytes`). Used for the proof's context and matcher inputs — those are signed
 * as the bytes that will arrive at the pool, not as the ext_proc list happens to be shaped.
 * Returns `undefined` for an absent header, which the proof covers distinctly from an empty value.
 */
function getWireHeaderBytes(headers: HeaderValue[], key: string): Buffer | undefined {
  const values: Buffer[] = [];
  for (const h of headers) {
    if (h.key.toLowerCase() !== key) continue;
    // An entry with neither field is an empty value, not an absent header.
    values.push(h.rawValue ?? (h.value ? Buffer.from(h.value, "utf8") : Buffer.alloc(0)));
  }
  return coalesceWireHeaderBytes(key, values);
}

// The resolved response headers (next.config `headers()` + middleware response headers) and the
// middleware's final REQUEST header set are both carried as one JSON internal header each. The
// pool applies the former to the RESPONSE (dispatch.ts merges resolvedHeaders via a writeHead
// wrapper) and the latter over `req.headers`. Emitting either as individual request-header
// mutations — as this handler used to for the response set — both drops them (they never reach
// the response) and leaks their values into the upstream request under their real names.
// The wire shape is the SHARED serializeHeaderMap (routing-common.ts), which the pool's
// parseResolvedHeaders reads back.

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

/**
 * S4 (SECURITY). The middleware-covered cache invariant, applied to the responses THIS tier
 * authors — the same rule the pool enforces in cache-policy.ts, which this tier was missing.
 *
 * A middleware-authored body or a middleware/rule redirect is by definition a
 * middleware-covered response, and the extension is POST-cache on the GXLB
 * (docs/superpowers/plans/gcp-edge-compute-cdn-findings.md). So any positive shared-cache
 * freshness on it hands Cloud CDN a window in which it serves that response to OTHER users
 * without the callout running at all: a cookie-dependent middleware response with
 * `public, s-maxage=600` and no Set-Cookie became a 600-second cross-user leak. The pool
 * refuses exactly this via explicitCacheControlWins → grantsSharedCacheFreshness; the two
 * tiers must not disagree about the same invariant.
 *
 * `no-cache` (not `no-store`), matching the pool's forced default for a middleware-covered
 * route: it keeps the response storable-but-revalidated, so every use still reaches the
 * extension, while staying as close as possible to what the app asked for. Values that
 * already force revalidation or uncacheability (`no-store`, `no-cache`, `private`,
 * `max-age=0`) do not grant freshness and are kept verbatim — including the `no-store` the
 * RSC guard above may have just stamped. A response with NO Cache-Control is left alone:
 * Cloud CDN runs USE_ORIGIN_HEADERS and stores nothing without an explicit directive, so
 * adding a header there would change observable behavior for zero security gain.
 */
function withMiddlewareCachePolicy(headers: Record<string, string>): Record<string, string> {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== "cache-control") continue;
    if (grantsSharedCacheFreshness(headers[key]!)) headers[key] = "no-cache";
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
  // The build-derived request headers the dispatch proof must bind (see buildProofHeaderNames):
  // the middleware-matcher inputs, because `matchesMiddleware` below derives the `x-mw-evaluated`
  // verdict from them (so a proof that left them unbound could be lifted from a `skip-nomatch`
  // request onto one the matcher DOES cover), and the RSC negotiation headers, because they pick
  // the `x-output-id` variant the pool dispatches. Derived once from the build's manifest — the
  // pool derives the identical list from its copy of the same manifest.
  const proofHeaderNames = buildProofHeaderNames(manifest);
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
    // Internal (trailing-slash retry only). N40: middleware ALREADY ran in the first pass —
    // it is the same request with the same verdict, so re-invoking it violates Next's
    // single-pass middleware contract (duplicated Set-Cookie, duplicated waitUntil/after()
    // side effects, doubled latency inside the ext_proc budget, and a second consume of the
    // same body stream). pool-server/resolve.ts refuses for exactly this reason
    // (`middlewareAlreadyRan`); this tier used to re-enter blind. The first pass's
    // `x-mw-evaluated` verdict rides along so the retry stamps what was actually determined
    // instead of the pessimistic `error`, which would just move the double execution to the
    // pool.
    //
    // N40b (SECURITY). So do the first pass's MUTATED REQUEST HEADERS. Inheriting the verdict
    // without them reintroduced exactly the bypass N40 closed, on this one path: the retried
    // response stamped a trusted `x-mw-evaluated: ran` while `middlewareRequestHeaders` was
    // re-initialized to undefined, so the pool skipped its own middleware AND kept the ORIGINAL
    // client headers — an auth middleware's header deletion / credential injection silently
    // undone by a trailing-slash retry. The verdict and the header set are two halves of one
    // fact and must travel together.
    retry?: {
      middlewareAlreadyRan: true;
      mwEvaluated: MwEvaluated;
      middlewareRequestHeaders?: Headers | undefined;
      // N40c (SECURITY/AVAILABILITY). The `:path` of the ORIGINAL request — the target the POOL
      // will actually see. See `wireTarget` below: the retry recursion resolves against a
      // REWRITTEN `:path`, but nothing ever mutates `:path` on the wire, so the dispatch proof
      // must be signed with this value and not with the recursion's own view of the target.
      // OCTETS, not a string (A0-DP-2): this is a proof input, and the two tiers decode the
      // target's bytes differently (Envoy raw_value is UTF-8, the pool's `req.url` is latin1).
      wireTarget: Buffer;
    },
  ): Promise<ProcessingResponse> {
    const rawPath = getHeader(requestHeaders, ":path") ?? "/";
    // N40c (SECURITY/AVAILABILITY). The request target the POOL will read back as `req.url`, and
    // therefore the only target the dispatch proof may be signed with.
    //
    // It is NOT always `rawPath`. The trailing-slash/i18n retry below recurses into this handler
    // with a header list whose `:path` is replaced by the retried (locale-prefixed) URL, so the
    // recursion resolves the real target — but the mutation response deliberately never mutates
    // `:path` (the public target is preserved for the client; the rewrite travels in
    // `x-invoke-path`), so Envoy forwards the ORIGINAL target upstream. Signing the recursion's
    // own `rawPath` therefore produced a transcript the pool could never reproduce: EVERY retried
    // request failed verification, the pool silently stripped the dispatch vocabulary and
    // re-resolved locally, and middleware ran a second time — the exact double execution the
    // retry's `middlewareAlreadyRan` plumbing (N40) exists to prevent, on every i18n build whose
    // root resolves through the internal 308 artifact.
    const wireTarget =
      retry?.wireTarget ?? getRawHeader(requestHeaders, ":path") ?? Buffer.from("/", "latin1");
    const method = getHeader(requestHeaders, ":method") ?? "GET";
    const scheme = getHeader(requestHeaders, ":scheme") ?? "https";
    // Raw authority, absence preserved: the dispatch proof covers it (the pool reads the same
    // value as `Host`, which Envoy writes from `:authority`), and ABSENT is a distinct covered
    // value from any present one. `:authority` is the HTTP/2-normalized form Envoy hands ext_proc;
    // the `host` fallback is for a caller that only sets the HTTP/1.1 spelling. The proof is
    // signed from the OCTETS (A0-DP-2); the decoded string below is what routing parses.
    const rawAuthorityBytes =
      getRawHeader(requestHeaders, ":authority") ?? getWireHeaderBytes(requestHeaders, "host");
    const rawAuthority = rawAuthorityBytes?.toString("utf-8");
    const authority = rawAuthority ?? "localhost";
    // N10/N40 (SECURITY). Both tiers parse the request target through the SHARED
    // parseRequestUrl: the authority comes from `:authority`/Host and NEVER from the target
    // (so `//evil.example/x` stays a PATH and the shared repeated-slash 308 normalizes it),
    // and an authority that is not a bare host — `evil.com/foo`, `user@evil` — is REJECTED
    // instead of being spliced in verbatim. This tier used to interpolate `:authority`
    // straight into a template string, so attacker path segments reached detectDomainLocale,
    // `has: { type: "host" }` matcher gating and the redirect same-origin test. Envoy should
    // reject such an `:authority` upstream — this is defense-in-depth, and the parity is what
    // routing-common.ts exists for.
    let url: URL;
    try {
      url = parseRequestUrl(rawPath, authority);
      // parseRequestUrl resolves against an http:// base (it only needs a valid authority to
      // splice after). Restore the real wire scheme so same-origin comparisons and emitted
      // Locations keep https. The setter is a no-op for a non-special scheme, which GXLB never
      // sends on this filter (:scheme is http or https).
      if (scheme !== "http") url.protocol = `${scheme}:`;
    } catch {
      // A malformed authority is the client's own protocol error, not a 500. Matches the
      // pool's 400 for the same input (pool-server/index.ts).
      return buildImmediateResponse(400, { "content-type": "text/plain; charset=utf-8" });
    }

    // Ingress hygiene: a client can send any x-* header, and the egress mutations
    // below only overwrite the keys they set — so strip the whole internal dispatch
    // vocabulary (plus BOTH credential headers — the legacy raw secret and the dispatch
    // proof) BEFORE anything else sees it. Spoofed values must
    // never reach resolveRoutes or middleware (an auth middleware reading a spoofed
    // x-output-id / x-mw-evaluated would be deciding on attacker input). The pool
    // applies the same strip-unless-proof discipline server-side.
    const headers = new Headers(
      requestHeaders
        .filter(
          (h) =>
            !h.key.startsWith(":") &&
            !(INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(h.key.toLowerCase()) &&
            !(UNTRUSTED_NEXT_REQUEST_HEADERS as readonly string[]).includes(h.key.toLowerCase()) &&
            h.key.toLowerCase() !== INTERNAL_SECRET_HEADER &&
            h.key.toLowerCase() !== INTERNAL_DISPATCH_PROOF_HEADER,
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
    if (prep.isDataRequest) headers.set("x-nextjs-data", "1");
    else headers.delete("x-nextjs-data");

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
        [
          ...INTERNAL_DISPATCH_HEADERS,
          ...UNTRUSTED_NEXT_REQUEST_HEADERS,
          INTERNAL_SECRET_HEADER,
          INTERNAL_DISPATCH_PROOF_HEADER,
        ],
      );
    }

    let middlewareResponse: Response | undefined;
    // N40 (SECURITY). Captures the mutated request headers from responseToMiddlewareResult —
    // the x-middleware-override-headers / x-middleware-request-* / x-middleware-set-cookie
    // verdict resolved into one authoritative REPLACEMENT set. Transported to the pool as
    // `x-mw-request-headers` (secret-gated) so Phase 2 installs it the same way Phase 1 does.
    // N40b: SEEDED FROM THE RETRY, whose first pass already produced this set — see the `retry`
    // parameter. It is not re-derivable on that path (middleware deliberately does not run
    // again), so dropping it here is a silent bypass, not a missed optimization.
    let middlewareRequestHeaders: Headers | undefined = retry?.middlewareRequestHeaders;
    // Fail CLOSED on middleware throw — see pool-server/resolve.ts. A crashing
    // middleware must 500, not silently emit trusted dispatch headers that let
    // the request bypass the auth/redirects/rewrites middleware implements.
    let middlewareThrew = false;
    // Positive record of what the middleware STAGE actually did, stamped to `x-mw-evaluated`
    // so the pool can trust the skip instead of inferring "middleware ran" from the presence
    // of routing headers. Pessimistic default `error` while middleware is configured but not
    // yet confirmed to have run (so the pool re-evaluates); `none` when there is no middleware.
    let mwEvaluated: MwEvaluated = retry?.mwEvaluated ?? (middlewareModule ? "error" : "none");

    const resolution = await resolveRoutesWithNextParity({
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
      // The shared Node runtime seam owns shape discrimination and the measured load-bearing
      // invocation order. The pool's edge sandbox remains separate because this service only
      // executes Node middleware.
      invokeMiddleware: middlewareModule
        ? async (ctx) => {
            try {
              // N40: the trailing-slash retry is a CONTINUATION of a request whose middleware
              // verdict is already in hand. Refuse to re-invoke — same position and same
              // reasoning as pool-server/resolve.ts's `middlewareAlreadyRan` guard, ahead of
              // the matcher check so `mwEvaluated` keeps the inherited verdict.
              if (retry?.middlewareAlreadyRan) return {};
              // Honor the middleware `matcher` config (parity with the pool
              // resolver) — skip middleware for requests it doesn't match.
              if (!matchesMiddleware(manifest.middleware?.matchers, ctx.url, ctx.headers)) {
                mwEvaluated = "skip-nomatch";
                return {};
              }

              const invoked = await invokeNodeMiddleware(middlewareModule, {
                url: ctx.url,
                headers: ctx.headers,
                method,
                requestBody: ctx.requestBody,
                // The same shed signal reaches generated/direct Request.signal and the request
                // object consumed by web-adapter/legacy wrappers. A fresh never-aborted signal
                // here previously let timed-out middleware keep running detached.
                signal: shedSignal ?? null,
                nextConfig: manifestNextConfig(manifest),
                logBackgroundError(error) {
                  console.error("[routing-service] middleware background work failed:", error);
                },
              });

              // Preserve the existing fail-safe for an unknown module shape: `mwEvaluated`
              // remains its pessimistic `error` value, which is not a trusted skip verdict, so
              // the pool discards the edge dispatch and runs full local resolution.
              if (invoked.kind === "unsupported") return {};
              // A recognized callable with an unrecognized result is not a successful
              // middleware evaluation. Throw into the existing genuine-error policy; never stamp
              // it as `ran` and never fall through to a second callable.
              if (invoked.kind === "invalid-result") throw invoked.error;

              mwEvaluated = "ran";
              middlewareResponse = invoked.response;
              // N40 (SECURITY). responseToMiddlewareResult MUTATES the Headers it is handed
              // into the middleware's FINAL request-header set (applying
              // x-middleware-override-headers / x-middleware-request-* /
              // x-middleware-set-cookie). This tier used to construct that object inline and
              // throw it away, so `NextResponse.next({ request: { headers } })` was a total
              // no-op at the edge — and because we still stamp `x-mw-evaluated: ran`, the
              // pool skipped its own middleware and the client's spoofed header reached the
              // handler unmodified. Capture it and transport it below (x-mw-request-headers),
              // exactly as pool-server/resolve.ts does for Phase 1.
              const reqHeaders = new Headers(ctx.headers);
              const mwResult = responseToMiddlewareResult(
                invoked.response.clone(),
                reqHeaders,
                ctx.url,
              );
              middlewareRequestHeaders = reqHeaders;
              return mwResult;
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
      // N40: a plain `NextResponse.next()` is NOT a middleware-authored redirect — the shared
      // discriminator requires a `location` header. Passing `middlewareResponse != null` made
      // the N15 request-query carry inert for every app with middleware.
      middlewareAuthored: middlewareAuthoredRedirect(middlewareResponse),
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
        // new budget that outlives the shed response. And carry the middleware verdict, so
        // the retry does NOT run middleware a second time (see the `retry` parameter) —
        // TOGETHER WITH the request headers that pass mutated (N40b), or the retried response
        // pairs a trusted `x-mw-evaluated: ran` with the client's own headers.
        // N40c: and carry the ORIGINAL wire target, which is what the pool will see as `req.url`
        // — the recursion's own `:path` is the retried one and exists only to steer resolution.
        return handleRequest(retried, shedSignal, {
          middlewareAlreadyRan: true,
          mwEvaluated,
          middlewareRequestHeaders,
          wireTarget,
        });
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
        // S4: this redirect is a middleware/rule verdict, so it may never carry
        // shared-cache freshness — a cached 3xx is served without the callout running.
        withMiddlewareCachePolicy(withRscCacheBustingGuard(responseHeaders, unvalidatedRscRequest)),
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
        // N40: never forward the middleware's own content-length. The body below is
        // re-serialized (and the redirect branch above drops the body entirely), so a
        // forwarded length can disagree with the bytes actually sent — Envoy then frames a
        // truncated or stalled response. The redirect branch already skipped it; this one
        // didn't. Envoy sets the correct length for an immediate response.
        if (key.toLowerCase() === "content-length") continue;
        respHeaders[key] = value;
      }
      const setCookies = mwRes.headers.getSetCookie();
      return buildImmediateResponse(
        mwRes.status,
        // S4: a middleware-AUTHORED body is the middleware-covered case by definition.
        withMiddlewareCachePolicy(withRscCacheBustingGuard(respHeaders, unvalidatedRscRequest)),
        // N40: carry the body as BYTES. `await mwRes.text()` decoded it as UTF-8 and
        // server.ts's `toBytes` re-encoded it, so every byte >= 0x80 in a
        // middleware-authored binary body became U+FFFD (3 bytes) — measured: an 8-byte PNG
        // signature arrived as 10 bytes. Phase 1 streams the real body
        // (pool-server/dispatch.ts), so this was edge-only corruption.
        new Uint8Array(await mwRes.arrayBuffer()),
        setCookies,
      );
    }

    if (resolution.externalRewrite) {
      // N40. NEVER author a status the other tier doesn't. Phase 1 returns
      // `external-rewrite` and pool-server/dispatch.ts PROXIES it, matching `next start`;
      // this tier used to answer 502 ("not supported in adapter-k8s v1"). Because the CEL
      // match condition is `!(…)` — i.e. approximately everything — whenever the app has
      // middleware, a next.config external rewrite worked in the e2e harness (pool only) and
      // 502'd in production. Hand it to the pool exactly as the body-request backstop above
      // does: CONTINUE with the whole internal dispatch vocabulary CLEARED and no secret
      // added, so the pool treats the request as untrusted, re-resolves locally, and owns the
      // proxy hop. (Middleware runs again in the pool for this request — that is the same
      // cost the body backstop pays, and it is the fail-safe direction.)
      return buildHeaderMutationResponse(
        [],
        [
          ...INTERNAL_DISPATCH_HEADERS,
          ...UNTRUSTED_NEXT_REQUEST_HEADERS,
          INTERNAL_SECRET_HEADER,
          INTERNAL_DISPATCH_PROOF_HEADER,
        ],
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
    const clear = new Set<string>([
      ...INTERNAL_DISPATCH_HEADERS,
      ...UNTRUSTED_NEXT_REQUEST_HEADERS,
      INTERNAL_SECRET_HEADER,
      INTERNAL_DISPATCH_PROOF_HEADER,
    ]);
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
      const serialized = serializeHeaderMap(responseHeaders);
      if (serialized) setDispatch("x-resolved-headers", serialized);
    }

    // N40 (SECURITY). The middleware's final REQUEST header set — `NextResponse.next({ request:
    // { headers } })`. `responseToMiddlewareResult` already resolved the override list into it,
    // so this value is the authoritative REPLACEMENT set the pool installs over `req.headers`
    // (pool-server/dispatch.ts, same code path Phase 1 feeds via
    // ResolveResult.middlewareRequestHeaders). Secret-gated like every other name in
    // INTERNAL_DISPATCH_HEADERS — a client cannot forge its own request-header rewrite, and any
    // spoofed copy is in the `clear` set above.
    //
    // Only stamped when middleware actually ran: on any other path the pool must not be told a
    // header set is authoritative. Not stamping it is fail-safe in one direction only — the
    // pool then keeps the client's own headers — which is precisely why the pool must not skip
    // its own middleware without a trusted `x-mw-evaluated`, and why an unstamped
    // header-sanitizing middleware was a live bypass.
    if (middlewareRequestHeaders) {
      const serializedRequestHeaders = serializeHeaderMap(middlewareRequestHeaders);
      if (serializedRequestHeaders) {
        setDispatch("x-mw-request-headers", serializedRequestHeaders);
      }
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

    // Authenticate the dispatch headers to the pool with a PER-REQUEST PROOF, never the raw
    // secret (INTERNAL_DISPATCH_PROOF_HEADER in routing-common.ts): HMAC over EVERY routing input
    // the pool will trust — the method, the request target, the authority, the forwarding
    // witnesses (`x-forwarded-proto`, which is the pool's only scheme witness, and
    // `x-forwarded-host`), the complete dispatch set stamped above (the middleware verdict and its
    // final request-header set included), and this build's derived inputs — the matcher headers
    // that decided that verdict and the RSC negotiation headers that chose the output id. So no
    // verdict can be swapped onto another request, host, scheme, matcher state or content
    // negotiation, nor edited in transit.
    //
    // NOT a caller-authentication scheme: this service answers any peer that can open a stream to
    // :8443 and will hand that peer a valid proof for a request of its own choosing. The emitted
    // NetworkPolicy is therefore still REQUIRED, not defense-in-depth — see the residual-risk
    // paragraph on INTERNAL_DISPATCH_PROOF_HEADER.
    //
    // Absent in emulate/tests (no secret configured) — the pool re-resolves locally. Computed
    // BEFORE the header-budget projection below so the proof counts against it, and so the bail
    // path (which clears the vocabulary and stamps nothing) stays consistent.
    if (internalSecret) {
      const covered: Record<string, ProofFieldValue> = {};
      for (const m of mutations) {
        const key = m.key.toLowerCase();
        // A0-DP-2: a mutation value is a JS string this tier authored, and Envoy carries it in
        // the proto3 `string` field of HeaderValue — so the octets that reach the pool are its
        // UTF-8 encoding, which is exactly what a `string` ProofFieldValue means. (These are the
        // values that made the divergence reachable with ordinary traffic: `x-invoke-query`
        // carries percent-DECODED query values and `x-mw-request-headers` carries whatever
        // middleware set, both via plain JSON.stringify, which does not \u-escape non-ASCII.)
        if ((INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(key)) covered[key] = m.value;
      }
      // Context and matcher inputs are signed as they sit ON THE WIRE, because this response
      // neither sets nor clears them: the client's own bytes are what the pool will read back.
      // (Names the egress `clear` set removes — the dispatch vocabulary and
      // UNTRUSTED_NEXT_REQUEST_HEADERS — can never appear here: buildProofHeaderNames excludes
      // them precisely because their wire value differs across the hop.)
      for (const name of [...PROOF_COVERED_CONTEXT_HEADERS, ...proofHeaderNames]) {
        covered[name] = getWireHeaderBytes(requestHeaders, name);
      }
      mutations.push({
        key: INTERNAL_DISPATCH_PROOF_HEADER,
        value: computeDispatchProof(internalSecret, {
          method,
          // N40c: the target the POOL will read back, not this pass's `:path` — they differ
          // across the trailing-slash/i18n retry recursion (see `wireTarget`).
          target: wireTarget,
          authority: rawAuthorityBytes,
          headers: covered,
          proofHeaderNames,
          // A0-DP-5. Bind the mint time, so a captured exchange stops verifying once the window
          // closes instead of replaying forever. No body digest: the header-phase ext_proc callout
          // never has a body, so this tier binds the ABSENT symbol — and a build with middleware
          // never reaches here for a body-capable request anyway (see the non-GET/HEAD bail
          // above, which clears the whole vocabulary and stamps nothing).
          issuedAtMs: Date.now(),
        }),
      });
      clear.delete(INTERNAL_DISPATCH_PROOF_HEADER);
    }

    // N40b (AVAILABILITY). The dispatch headers are ADDITIVE on the wire, and
    // `x-mw-request-headers` carries the middleware's whole final request-header set while the
    // client's originals stay put — the pool needs those originals, because index.ts derives the
    // RSC/preview/forced-cache verdicts from them BEFORE dispatch.ts installs the replacement
    // set. So the set is duplicated, and a request with ~8 KiB of cookies/auth can cross Node's
    // 16 KiB `maxHeaderSize` (pool-server/server.ts takes the default) only AFTER ext_proc
    // processing: MEASURED 8849 bytes → 200 before the extension, 17490 bytes → 431 after.
    // Node answers that 431 from the parser (HPE_HEADER_OVERFLOW), so the pool never gets the
    // chance to read the transport header — the request simply stops working.
    //
    // The fix is the SAME fail-safe the body-request and external-rewrite backstops above use:
    // clear the whole dispatch vocabulary, add no secret, and let the pool treat the request as
    // untrusted and re-resolve it locally (Phase 1 — which re-runs middleware and re-derives the
    // header mutations in-process, where no wire budget applies). That is strictly better than
    // the alternatives: dropping just `x-mw-request-headers` would leave a trusted
    // `x-mw-evaluated: ran` next to un-mutated client headers, i.e. the Finding-1 bypass, and
    // dropping the client's originals instead would blind the pool's own pre-dispatch header
    // reads. It also SHRINKS the request rather than growing it, so a request that worked before
    // the N40 transport keeps working. Cost: middleware runs a second time (in the pool) for
    // these requests only — the same cost the two backstops above already pay, and the fail-safe
    // direction for invariant 2 (middleware is never bypassed).
    const overwritten = new Set(mutations.map((m) => m.key.toLowerCase()));
    const projectedBytes = headerBlockBytes([
      // Everything the client sent that this response neither overwrites nor removes, plus the
      // pseudo-headers (`:path` becomes the upstream request line, which counts against the
      // same limit).
      ...requestHeaders
        .filter((h) => {
          const k = h.key.toLowerCase();
          return !overwritten.has(k) && !clear.has(k);
        })
        .map((h) => [h.key, h.value ?? h.rawValue?.toString("utf-8") ?? ""] as [string, string]),
      ...mutations.map((m) => [m.key, m.value] as [string, string]),
    ]);
    if (!fitsPoolHeaderBudget(projectedBytes)) {
      console.warn(
        `[routing-service] dispatch headers would exceed the pool's header budget ` +
          `(${projectedBytes} bytes projected); handing the request to the pool untrusted so it ` +
          `re-resolves locally`,
      );
      return buildHeaderMutationResponse(
        [],
        [
          ...INTERNAL_DISPATCH_HEADERS,
          ...UNTRUSTED_NEXT_REQUEST_HEADERS,
          INTERNAL_SECRET_HEADER,
          INTERNAL_DISPATCH_PROOF_HEADER,
        ],
      );
    }

    return buildHeaderMutationResponse(mutations, [...clear]);
  };
}
