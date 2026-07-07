# Plan: Body-Reading Middleware on the ext_proc Edge — Runtime Backstop + Secret-Gated Trust

**Status:** v4 — **IMPLEMENTED on branch `k8s-adapter-review-fixes`.** The GET/HEAD **CEL
method gate** (v3) was found to open a middleware-auth bypass: skipping the callout on POSTs
meant the extension no longer stripped client-spoofed dispatch headers, and GKE pools trust
dispatch headers. v4 **reverts the CEL gate** and instead:
- keeps a **runtime backstop** in `handler.ts` that, for non-GET/HEAD requests with
  middleware, runs no `resolveRoutes` (no empty-body middleware) AND actively CLEARS the
  internal dispatch headers, so the pool re-resolves Phase-1 with the real body;
- adds **secret-gated pool trust**: the routing extension authenticates its dispatch headers
  with a shared `x-internal-secret`; the pool trusts them ONLY on a match, so a spoofed
  `x-output-id` on a CEL-excluded path or during a fail-open outage is rejected too.

Also landed in this round: the pre-existing router gaps #1 (headers() forwarding), #2 (RSC
edge mapping), #3 (header-trust), and #7 (lookupPool dedup). The tripwire design is preserved
in Appendix A (rejected). The redirect prerequisite is in Appendix B.

---

## 1. Problem

The routing service runs `@next/routing` (`resolveRoutes` + middleware) as a GCP **route
extension** (`LbRouteExtension`) in the **request-headers phase**, pre-CDN
(`src/extension-chain.ts:31` — `supportedEvents: ["REQUEST_HEADERS"]`). The header-phase
callout never receives the request body (`handler.ts` calls `resolveRoutes` with an empty
body stream). So middleware that reads the body (`request.json()/.text()/.formData()/.body`)
sees an empty body at the edge and can decide wrong, throw, or hang.

## 2. Why gating (not a tripwire)

Edge evaluation of a body-capable request (POST/PUT/…) with middleware buys essentially
nothing:

- **CDN protection:** none. Cloud CDN only caches **GET** responses
  (https://docs.cloud.google.com/cdn/docs/caching); POSTs always reach origin.
- **Correct pool via `x-upstream-pool`:** marginal. Per Gateway API precedence
  (exact > longest path-prefix > headers), path-prefix rules shadow the header rules anyway
  (`gateway.ts`), and `proxyToPool` (`dispatch.ts:478`) already recovers a wrong-pool guess.
- **Avoiding pool-side resolution:** not a saving, a *relocation* — `resolveRoutes` +
  middleware runs exactly once per request either way; gating just moves it from the routing
  service to the pool.

Against that, running body-middleware at the edge is either wrong (empty body) or requires
the rejected tripwire machinery (Appendix A). The pool's Phase-1 path
(`pool-server/resolve.ts`) is the **reference resolver** — the same code emulate runs — and
is where `headers()` are actually applied and external rewrites actually proxy (both of which
the ext_proc Phase-2 path currently does *not* do; see "Related router gaps" below). So
sending body-capable requests straight to the pool is the more correct path today.

## 3. Implemented change

1. **`src/cel.ts` — no method gate.** The middleware CEL branch is back to `!(<exclusions>)`.
   The extension MUST run on POSTs so it can strip client-spoofed dispatch headers; a CEL
   method gate would skip the callout and let a spoofed `x-output-id` reach the pool. (The
   `escapeCelString` / `initialRevalidate` fixes from v3 are kept.)

2. **`src/routing-service/handler.ts` — runtime backstop + hygiene.**
   - Non-GET/HEAD with middleware: run no `resolveRoutes`, and return `CONTINUE` that
     `removeHeaders` **all** internal dispatch headers (+ `x-internal-secret`). No secret is
     added → the pool re-resolves Phase-1 with the real body.
   - Normal path: every internal dispatch header the response does NOT set is added to
     `removeHeaders` (so a client can't smuggle e.g. `x-route-matches` when the route has no
     params — closes the conditional-header spoof). The shared `x-internal-secret` is added
     from `INTERNAL_HEADER_SECRET` (env) to authenticate the dispatch headers.
   - `resolvedHeaders` (next.config `headers()` + middleware response headers) are serialized
     into `x-resolved-headers` (JSON) instead of leaking as individual request mutations
     (gap #1); the output id is RSC-mapped via the shared helper (gap #2).

3. **`src/routing-common.ts` (new).** Shared `lookupPool` + `trailingSlashVariants` (gap #7,
   de-duped from `handler.ts`/`resolve.ts`), `resolveRscOutput` (gap #2, shared by both
   resolvers), and the canonical `INTERNAL_DISPATCH_HEADERS` / `INTERNAL_SECRET_HEADER` lists.

4. **`src/pool-server/server.ts` — secret-gated trust.** Dispatch headers are trusted only
   when the request's `x-internal-secret` matches the configured secret (constant-time
   compare); `trustInternalHeaders` is a legacy no-secret fallback. The secret is always
   stripped so it never reaches the handler. `index.ts` Phase-2 now parses `x-resolved-headers`
   and passes it to the dispatcher (which merges it into the RESPONSE), closing gap #1's pool
   half.

5. **Infra.** `emit/templates/internal-secret.ts` (new) renders a per-release `Secret`;
   `helm.ts` renders it and both the pool and routing-service Deployments inject
   `INTERNAL_HEADER_SECRET` from it via `secretKeyRef`. Secret regenerates per build and fails
   safe (mismatch → Phase-1 re-resolve during a rolling window).

**Tests (all green, 162 pass):** `cel.test.ts` (no method gate); `handler.test.ts` (backstop
strips dispatch headers; conditional-header removal; `x-resolved-headers` serialization incl.
Set-Cookie; secret add/clear; RSC → `.rsc` output id); `server.test.ts` (secret match trusts;
RED-TEAM spoofed/invalid secret is stripped; secret never forwarded); `helm.test.ts` (Secret +
secretKeyRef wiring on both deployments).

## 4. Trade-offs (documented, not dismissed)

- **POSTs pay the callout again.** Reverting the CEL gate means the extension is invoked for
  body-capable requests; it does no `resolveRoutes` work (parse headers → strip → CONTINUE),
  a tiny cost that buys the header-strip trust boundary. This is the price of not depending on
  the secret alone for safety.
- **Body-capable requests still resolve at the pool** (Phase 1, real body) — the correctness
  win from v3 is unchanged; only the *mechanism* moved from CEL to the runtime backstop.
- **GET/HEAD middleware still runs at the edge** with the empty stream — correct only because
  GET/HEAD have no body to read.
- **Secret regenerates per build.** Acceptable: the chart updates both sides together and a
  mismatch fails safe. A stable secret (helm `lookup`) is a possible future refinement.
- **NEEDS LIVE VERIFICATION** (per `feedback_architectural_precision`): that the LB forwards
  the extension's `x-internal-secret` request-header mutation to the backend (same mechanism as
  the existing dispatch headers, which demonstrably work — so high confidence, but confirm on a
  real GXLB before relying on the secret as the *sole* trust layer). Safety today does NOT
  depend on it: the backstop's `removeHeaders` already strips spoofed dispatch headers on the
  POST path via the proven overwrite/remove mechanism.

## 5. Verification

- Unit tests above (landed, green).
- **Delphi:** a POST through a **body-reading** middleware app resolves correctly at the pool;
  plus a no-regression check that GET/HEAD middleware still behaves (per
  `feedback_dont_rewrite_middleware` — rebuild + user verifies).

---

## Related router gaps (surfaced during review — pre-existing)

The edge/Phase-2 path silently did less than emulate/Phase-1 in several places. Status:

1. **FIXED — `next.config` `headers()` on the ext_proc path.** Now serialized into
   `x-resolved-headers` (JSON) by `handler.ts` and applied to the RESPONSE by the Phase-2
   dispatch (`index.ts` → dispatcher's `resolvedHeaders` merge). No longer leak into the
   upstream request as individual mutations. `x-resolved-headers` is in the internal strip set.
2. **FIXED — RSC output mapping at the edge.** `handler.ts` now RSC-maps the output id via the
   shared `resolveRscOutput` (same helper `resolve.ts` uses), so dynamic RSC navigations +
   segment prefetches dispatch to the `.rsc`/segment output, not the base handler.
3. **FIXED — header-trust hole.** Two layers: (a) `handler.ts` `removeHeaders` every internal
   dispatch header it doesn't set (so conditional `x-route-matches`/`x-nextjs-ppr` can't be
   spoofed on the trusted path); (b) secret-gated trust in `server.ts` closes the CEL-excluded
   and fail-open variants (no extension → no secret → pool strips + Phase-1).
4. **OPEN — rewrite destination queries dropped** (both phases — consistent, not a regression).
   Needs `invocationTarget.query` threaded through to the handler's reconstructed URL; deferred
   (bigger cross-phase change, no emulate/prod split).
5. **OPEN (by design) — external rewrites:** emulate proxies (`dispatch.ts:370`), prod 502s
   (`handler.ts`). Deliberate v1 scoping; documented emulate/prod split.
6. **FIXED (doc) — Gateway API precedence comment.** See gateway.ts note; `proxyToPool` rescues
   correctness (extra hop, not wrong answer). [If not yet edited, low-priority doc-only.]
7. **FIXED — `lookupPool` dedup.** Extracted to `src/routing-common.ts`, imported by both
   `handler.ts` and `resolve.ts`. (Its `default ?? first pool` fallback can still mis-guess →
   `proxyToPool` recovers; noted in the shared helper's comment.)

### Newly noticed (not in the original 7, deferred)

- **Middleware REQUEST-header mutations (`x-middleware-request-*`) are dropped on the ext_proc
  GET path.** Phase-1 (`resolve.ts`) captures them via `responseToMiddlewareResult`'s
  `reqHeaders` (`middlewareRequestHeaders`) and applies them (`dispatch.ts:455`); the ext_proc
  handler doesn't surface them (resolveRoutes applies them to its internal `f` but never
  returns it). Sibling of gap #1 but on the REQUEST side. Fix would capture them in
  `invokeMiddleware` and carry them in a second internal header. Deferred.

---

## Appendix A — Rejected alternative: runtime request-body tripwire

Considered and rejected. Detect body access at runtime (a lazy `pull` body stream that flags
on read), and on trip drop the dispatch headers so the pool re-runs middleware with the real
body. Rejected because method gating achieves the same correctness with none of the costs:

- Stream instrumentation with a residual false-positive class in the Next.js middleware
  adapter wrapper (would trip on *every* POST if the wrapper tees the stream).
- Double middleware execution with empty-body side effects on every trip.
- A discarded-computation branch that had to dominate all five resolution-derived output
  channels (redirect, resolvedHeaders+status, middlewareResponded, externalRewrite, resolved
  pathname/headers).
- An eventual Next.js API ask (Option A) to distinguish user-body-reads from framework
  plumbing.

The research was not wasted: the key fact that **Cloud CDN only caches GET** is exactly what
justifies the gate (there is nothing to protect for non-GET, so no reason to evaluate at the
edge). The CDN-bypass sub-idea (`bypassCacheOnRequestHeaders`) was independently shown moot for
the same reason.

## Appendix B — Prerequisite bug FIXED: middleware redirects in `handler.ts`

A middleware redirect surfaces as `resolvedHeaders` (with `Location`) + a redirect `status`
(e.g. 307), **not** as `resolution.redirect`. `handler.ts` never read `resolution.status`, so
it fell through to normal dispatch — `Location` emitted as a request-header mutation, pool
served the page **200**. `pool-server/resolve.ts:263-270` handles it correctly (works in
emulate, latent on the real ext_proc path). **Fixed:** `handler.ts:236-243` now checks
`resolvedHeaders.get("location")` + redirect status right after the `resolution.redirect`
branch, resolving relative Locations against the request URL. Two tests added
(`tests/routing-service/handler.test.ts`). Keeps the two resolvers in agreement.
