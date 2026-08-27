// @next/routing ships as CommonJS. A *named* import of a CJS module works in our
// CJS bundles (pool-server, routing-service) but breaks Node's ESM loader in the
// adapter's ESM entrypoint (dist/index.js), which Next imports at build time —
// cjs-module-lexer can't statically resolve the named exports, so the import throws
// "Named export 'detectDomainLocale' not found". Import the CJS default (module.exports)
// and destructure; both bundle formats resolve the symbols this way.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import NextRouting from "@next/routing";
import type { ResolveRoutesParams } from "@next/routing";
import { isSafePattern } from "redos-detector";
import { grantsSharedCacheFreshness as grantsSharedCacheFreshnessFromCacheControl } from "./cache-control.js";
const { detectLocale, detectDomainLocale, normalizeLocalePath } = NextRouting;

// Shared routing helpers used by BOTH resolvers — the ext_proc edge
// (routing-service/handler.ts, "Phase 2") and the pool's local resolver
// (pool-server/resolve.ts, "Phase 1"). Keeping these in one place prevents the two
// paths from drifting; a divergence here means production (ext_proc) and emulate
// (Phase 1) route the same request differently.

// Internal request headers set by the routing extension / cross-pool proxy. Clients
// must never be able to speak this dispatch protocol, so the pool strips them unless
// they arrive with a valid internal secret (see pool-server/server.ts), and the routing
// service overwrites/clears them on every response it returns.
export const INTERNAL_DISPATCH_HEADERS = [
  "x-output-id",
  "x-matched-pathname",
  "x-route-matches",
  "x-upstream-pool",
  "x-nextjs-ppr",
  "x-resolved-headers",
  // Positive, secret-gated assertion that the middleware STAGE was evaluated upstream
  // (by the ext_proc routing service or a cross-pool proxy). The pool skips its own
  // middleware ONLY when this is present with a recognized value — never on the mere
  // presence of routing headers. Its ABSENCE means "not evaluated" → the pool fails safe
  // and runs middleware itself. This closes the middleware-bypass class regardless of why
  // an upstream failed to evaluate (TLA-wrapped module, missing file, no callable, spoof).
  "x-mw-evaluated",
  // Rewrite invocation target: the internal handler URL (path + merged query with repeated
  // destination keys restored) and its query record. Stamped by the routing extension and the
  // cross-pool proxy so the receiving pool can supply the REWRITE TARGET to the generated
  // entrypoint as requestMeta (query / params / resolvedPathname / rewrittenPathname) — the
  // loopback request URL itself stays the PUBLIC one, exactly as `next start` does (see
  // pool-server/dispatch.ts invokeLocalHandlerOverHttp). Without these headers a
  // trusted-dispatch request loses the rewrite-added query and the resolved route params
  // entirely (the handler would see only the client's original search params).
  "x-invoke-path",
  "x-invoke-query",
  // Absolute time-to-response-head deadline propagated by a trusted cross-pool hop. Keeping one
  // build-derived deadline prevents the target pool from minting a fresh maxDuration budget.
  "x-adapter-k8s-execution-deadline",
  // N40 (SECURITY). The middleware's FINAL request-header set — what
  // `NextResponse.next({ request: { headers } })` produces. `responseToMiddlewareResult`
  // resolves `x-middleware-override-headers` / `x-middleware-request-*` /
  // `x-middleware-set-cookie` into the Headers it is handed, so the value carried here is
  // already the authoritative REPLACEMENT set (a header the middleware deleted is simply
  // absent — merging would resurrect it). Phase 1 captures it in-process
  // (pool-server/resolve.ts) and pool-server/dispatch.ts installs it over `req.headers`;
  // Phase 2 had NO transport at all, so a middleware that strips a spoofed `x-user-id` or
  // stamps `x-authenticated-user` was a total no-op at the edge while `x-mw-evaluated: ran`
  // told the pool the stage was already done. Secret-gated like every name in this list —
  // a client must never be able to forge its own request-header rewrite.
  "x-mw-request-headers",
] as const;

// Next.js treats these as private request-control headers. `next-resume: 1` tells the App Router
// to deserialize the request body as trusted postponed state; `x-next-resume-state-length` frames
// postponed state prepended to a Server Action body. They are NOT part of the adapter's
// secret-gated dispatch protocol: no network hop is allowed to preserve client-supplied values.
// The pool creates either header only after this boundary, so stripping them at both public
// ingress tiers does not interfere with legitimate resume handling.
export const UNTRUSTED_NEXT_REQUEST_HEADERS = [
  "x-middleware-rewrite",
  "x-middleware-redirect",
  "x-middleware-set-cookie",
  "x-middleware-skip",
  "x-middleware-override-headers",
  "x-middleware-next",
  "x-now-route-matches",
  "x-matched-path",
  "x-nextjs-data",
  "next-resume",
  "x-next-resume-state-length",
] as const;

// Recognized `x-mw-evaluated` verdicts that authorize the pool to skip its own middleware.
// `ran` = matched + executed; `skip-nomatch` = middleware exists but matcher didn't match;
// `none` = the app has no middleware. Anything else (incl. `error` / absent) ⇒ do NOT skip.
export const MW_EVALUATED_TRUSTED = new Set(["ran", "skip-nomatch", "none"]);

/**
 * N40b (AVAILABILITY). Node's default `http.maxHeaderSize` — the ceiling on the ENTIRE request
 * header block a pool pod will parse. The pool server calls `createServer()` with no
 * `maxHeaderSize` override and the emitted container sets no `--max-http-header-size`
 * (pool-server/server.ts, src/emit/), so this default is the real limit in production.
 *
 * MEASURED (Node 24.11.0, a `createServer()` with no options, raw socket writes):
 *   - largest accepted header block: 16408 wire bytes (`http.maxHeaderSize` = 16384 plus the
 *     small slack the llhttp parser allows for the request line/terminator).
 *   - one byte over, Node answers `431 Request Header Fields Too Large` ITSELF
 *     (parser error `HPE_HEADER_OVERFLOW`) — the request never reaches the request handler.
 *
 * That last fact is why this matters to the routing extension and not just to clients: the
 * dispatch headers are added AFTER the client's own headers, and `x-mw-request-headers` carries
 * the middleware's whole final request-header set while the originals stay on the wire (the pool
 * needs them: index.ts derives RSC/preview/cache verdicts from the client's own headers BEFORE
 * dispatch.ts installs the replacement set). The set is therefore duplicated, and a request with
 * ~8 KiB of cookies/auth crossed 16 KiB only after ext_proc processing — MEASURED: 8849 bytes →
 * 200 before the extension, 17490 bytes → 431 after it. The pool cannot honor a transport header
 * on a request it is never handed, so the extension must keep the projected block under budget.
 */
export const POOL_MAX_HEADER_BYTES = 16 * 1024;

/**
 * Slack held back from POOL_MAX_HEADER_BYTES for bytes the extension does not see or control:
 * the HTTP/1.1 request line Envoy writes upstream, and headers Envoy adds after the ext_proc
 * mutation (`x-request-id`, `x-envoy-*`, `x-forwarded-*`, `via`, GFE trace headers — a few
 * hundred bytes in practice). Deliberately generous: over-reserving costs a re-resolution in
 * the pool on a pathologically large request, under-reserving costs a 431.
 */
export const POOL_HEADER_BUDGET_RESERVE_BYTES = 2 * 1024;

/**
 * Wire cost of a header block in HTTP/1.1 framing: `name: value\r\n` per entry. Byte length,
 * not string length — a cookie or JSON value can carry multi-byte UTF-8.
 */
export function headerBlockBytes(entries: Iterable<readonly [string, string]>): number {
  let total = 0;
  for (const [key, value] of entries) {
    total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8") + 4;
  }
  return total;
}

/** Does a projected request header block fit the pool's parser limit (with reserve)? */
export function fitsPoolHeaderBudget(bytes: number): boolean {
  return bytes <= POOL_MAX_HEADER_BYTES - POOL_HEADER_BUDGET_RESERVE_BYTES;
}

// Header carrying the shared secret that authenticates the dispatch headers above.
// LEGACY (v1): it is no longer stamped anywhere — see INTERNAL_DISPATCH_PROOF_HEADER. The
// constant remains because every strip/clear list must keep naming it: a client (or an
// old-build hop) presenting the raw secret must have it deleted, never honored.
export const INTERNAL_SECRET_HEADER = "x-internal-secret";
export const INTERNAL_EXECUTION_DEADLINE_HEADER = "x-adapter-k8s-execution-deadline";

/**
 * Header carrying the dispatch trust credential, v2: a PER-REQUEST HMAC proof, replacing
 * the raw shared secret on the wire.
 *
 * v1 stamped the raw per-build secret (x-internal-secret) into every ext_proc response and
 * every cross-pool hop. Anything able to open ONE ext_proc stream to the routing service —
 * a NetworkPolicy miss, a hostNetwork pod (which bypasses NetworkPolicy entirely), a VPC
 * peer, a non-enforcing CNI — could read the secret out of the header mutation and replay
 * it against any pool with forged dispatch headers, minting trusted `x-mw-evaluated`
 * verdicts for arbitrary routes: a release-wide middleware bypass. Reachability to :8443
 * WAS the credential (2026-08-16 audit, issue #60).
 *
 * The proof binds the secret to EVERY routing input the pool trusts from the edge — see
 * `computeDispatchProof` for the exact covered set: the method, the request target, the
 * authority, the forwarding witnesses the pool's own derivations read, every
 * INTERNAL_DISPATCH_HEADERS value (the middleware verdict `x-mw-evaluated` and the
 * middleware's final request-header set `x-mw-request-headers` among them), and this build's
 * derived inputs — the request headers its middleware `matcher` has/missing conditions consult
 * and the RSC negotiation headers that choose the dispatched output id. So no verdict can be
 * swapped onto a different request, host, scheme, matcher state or content negotiation, nor
 * edited in transit, and the secret itself never crosses the wire.
 *
 * WHAT THIS DOES *NOT* DO — the NetworkPolicy is still a REQUIRED trust boundary. The proof
 * removes the replayable, disclosable credential; it does NOT authenticate CALLERS to the
 * ext_proc port. The routing service answers any peer that can open a stream to :8443, so
 * anything that reaches that port can still submit a request of its own choosing and be handed
 * a valid proof for it — a signing oracle for crafted requests, including requests on paths the
 * CEL match condition normally excludes from the callout, and unmetered use of the middleware
 * compute behind it. Reachability is therefore still the boundary that decides who may ask for
 * a routing verdict at all; issue #60 is narrowed (no wire-readable, replayable secret), not
 * closed. The emitted NetworkPolicy (emit/templates/network-policy.ts) and the strict ingress
 * sources per provider stay REQUIRED, not defense-in-depth.
 *
 * No legacy dual-accept on the pool: trusted pairings are ALWAYS same-build — the secret
 * is HMAC(operatorKey, "release\0buildId") per build, and the edge's secretKeyRef moves
 * with its image (N87) — so same build means same adapter code on both ends. Cross-build
 * traffic already fails closed today (secret mismatch ⇒ strip ⇒ local re-resolution), so
 * a proof-only pool and a raw-secret edge can never form a trusted pair. The covered-input
 * SET is part of that same-build contract: both tiers derive it from the one build's manifest,
 * so it can be extended without a wire-compat shim.
 */
export const INTERNAL_DISPATCH_PROOF_HEADER = "x-internal-dispatch-proof";

// Constant-time string compare, guarding the length side-channel (timingSafeEqual throws on
// unequal-length buffers). Canonical home; pool-server/dispatch.ts re-exports it so the two
// historical import sites can never drift apart.
export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Request-context headers the proof covers ON TOP of the dispatch vocabulary, because the
 * POOL's own routing derivations read them straight off the wire — so a proof that did not
 * bind them would verify for a request whose effective scheme or origin is a different one.
 *
 * REVIEW (PR #61): the first cut of the proof covered only (method, target, dispatch headers),
 * which left `:scheme` and `:authority` unbound. `:authority` is bound directly (see
 * `DispatchProofInputs.authority`). `:scheme` is bound THROUGH `x-forwarded-proto`, which is the
 * pool's only witness of the client-facing scheme — TLS terminates at the load balancer, so the
 * pool's own socket is always plain http and `dispatch.ts requestProtocol()` has nothing else to
 * read. Binding the raw wire value (rather than each tier's own interpretation of it) is what
 * keeps the two sides byte-identical: Envoy sets `x-forwarded-proto` during header sanitization,
 * BEFORE the ext_proc filter runs, and does not touch it again on the way upstream. When the
 * header is absent it is covered as ABSENT at both tiers, and the pool's derived scheme is `http`
 * no matter what the caller does — so the scheme is bound in that case too.
 *
 * OPERATIONAL NOTE. This binding assumes the value the CALLOUT tier sees is the value that
 * reaches the pool. That holds for the in-cluster Envoy Gateway path (above). It is NOT verified
 * for the GKE traffic-extension path, where the callout is made by the GXLB rather than by an
 * Envoy in the request path: if that load balancer sets `x-forwarded-proto` only while forwarding
 * to the backend — i.e. after the extension chain — the two tiers would sign different values.
 * The failure is FAIL-SAFE, not a hole: the proof does not verify, the pool strips the dispatch
 * headers and re-resolves the request locally (middleware runs), so correctness is preserved and
 * the cost is a doubled middleware pass. The live e2e suites (`npm run test:e2e:live`) exercise a
 * real GXLB deployment and would show it as trusted-dispatch never being taken; removing this one
 * entry from the list is the one-line fallback if so.
 */
export const PROOF_COVERED_CONTEXT_HEADERS = [
  // Effective client-facing scheme (pool-server/dispatch.ts requestProtocol).
  "x-forwarded-proto",
  // Honored by the pool when deciding whether a middleware redirect Location is same-origin
  // (pool-server/dispatch.ts middlewareRedirectLocation), so it is a routing input as well.
  "x-forwarded-host",
] as const;

// Names that must never enter the BUILD-DERIVED covered set (`buildProofHeaderNames` and the two
// derivations behind it): the dispatch vocabulary and both credentials are already covered
// explicitly, `host` is covered as the authority, and the UNTRUSTED_NEXT_REQUEST_HEADERS are
// REWRITTEN between the two tiers (the edge sets/deletes `x-nextjs-data` for its own matcher
// evaluation and clears the whole list on egress), so binding a wire value for them would compare
// the edge's pre-strip bytes against the pool's post-clear absence and fail every proof.
//
// The W3C trace headers are excluded for that SAME rewritten-between-the-tiers reason, and are
// worth naming explicitly because only a middleware `matcher` condition can pull them in (they
// are in neither the dispatch vocabulary nor PROOF_COVERED_CONTEXT_HEADERS). An OTel-enabled
// routing tier injects `traceparent`/`tracestate` with OVERWRITE_IF_EXISTS_OR_ADD *after*
// handler() has already minted the proof (routing-service/server.ts injectTraceHeaders), so
// binding them would compare the edge's pre-injection bytes against the pool's post-injection
// value and fail EVERY proof for that build — silently and permanently: trusted dispatch off,
// middleware run twice per request, `x-mw-request-headers` never applied, and nothing logged.
//
// ACCEPTED RESIDUAL: a matcher gating on a trace header is then an UNBOUND proof input. That
// costs no integrity, because the value the pool sees is edge-controlled anyway — the routing
// tier overwrites it unconditionally on every routed and continued response, so the client's own
// bytes never reach the pool and there is nothing an attacker could swap that the edge has not
// already replaced.
const PROOF_EXCLUDED_MATCHER_HEADERS: ReadonlySet<string> = new Set<string>([
  ...INTERNAL_DISPATCH_HEADERS,
  ...UNTRUSTED_NEXT_REQUEST_HEADERS,
  INTERNAL_SECRET_HEADER,
  INTERNAL_DISPATCH_PROOF_HEADER,
  "host",
  "traceparent",
  "tracestate",
]);

/**
 * Header names this build's middleware `matcher` has/missing conditions read — the "skip-nomatch
 * inputs". Sorted and deduped so both tiers derive the same list from the same manifest.
 *
 * WHY THE PROOF MUST COVER THEM: `matchesMiddleware` decides the `x-mw-evaluated` verdict from
 * the request's own headers and cookies. A matcher carrying `missing: [{type:"cookie",
 * key:"session"}]` means an anonymous request legitimately yields the TRUSTED `skip-nomatch`
 * verdict — and with those inputs unbound, that proof could be lifted onto a request that DOES
 * carry the cookie, telling the pool the middleware stage was already settled for a request whose
 * middleware never ran. That is the same middleware-bypass class `x-mw-evaluated` exists to close,
 * re-opened one header at a time.
 *
 * `query` and `host` conditions add no names: they read `url.searchParams` and `url.hostname`,
 * already bound by the request target and the authority. Names in
 * PROOF_EXCLUDED_MATCHER_HEADERS add none either — see that set for why binding a value the two
 * tiers do not see identically would fail every proof rather than bind anything.
 */
export function matcherProofHeaderNames(matchers: MiddlewareMatcher[] | undefined): string[] {
  if (!matchers || matchers.length === 0) return [];
  const names = new Set<string>();
  for (const matcher of matchers) {
    for (const cond of [...(matcher.has ?? []), ...(matcher.missing ?? [])]) {
      // A cookie condition reads the whole `Cookie` header (conditionPresent parses it), so the
      // header — not the cookie name — is the covered input.
      if (cond.type === "cookie") names.add("cookie");
      else if (cond.type === "header" && cond.key) names.add(cond.key.toLowerCase());
    }
  }
  for (const excluded of PROOF_EXCLUDED_MATCHER_HEADERS) names.delete(excluded);
  return [...names].sort();
}

/**
 * Header names the RSC content negotiation reads — the other build-derived routing input. The
 * edge picks `x-output-id` through `resolveRscOutput`, which reads `rsc.header` (whole-page
 * flight) and `rsc.prefetchSegmentHeader` (partial-tree prefetch); the pool then dispatches that
 * output id verbatim. Unbound, a proof for the flight request would verify with the RSC header
 * stripped: the pool serves the `.rsc` output while deriving its cache verdict for a document
 * request, which is a shared-cache confusion, not just a wrong content type.
 */
export function rscProofHeaderNames(rsc: RscConfig | undefined): string[] {
  if (!rsc) return [];
  const names = [rsc.header, rsc.prefetchSegmentHeader]
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .map((name) => name.toLowerCase())
    .filter((name) => !PROOF_EXCLUDED_MATCHER_HEADERS.has(name));
  return [...new Set(names)].sort();
}

/**
 * The build-derived request-header names the proof covers on top of the fixed vocabulary: the
 * middleware-matcher inputs and the RSC negotiation headers. ONE derivation, called by every
 * party that signs (routing-service/handler.ts, pool-server/dispatch.ts's cross-pool hop) and by
 * the verifier (pool-server/server.ts) — all three read the same build's routing manifest, and a
 * trusted pairing is always same-build, so the lists cannot disagree in a live deployment.
 */
export function buildProofHeaderNames(manifest: {
  middleware?: { matchers?: MiddlewareMatcher[] } | null | undefined;
  routeGraph?: unknown;
}): string[] {
  return [
    ...new Set<string>([
      ...matcherProofHeaderNames(manifest.middleware?.matchers),
      ...rscProofHeaderNames(getRscConfig(manifest)),
    ]),
  ].sort();
}

/** The complete covered header-name list for a build, sorted — the proof's canonical order. */
export function proofCoveredHeaderNames(buildHeaderNames?: readonly string[]): string[] {
  return [
    ...new Set<string>([
      ...INTERNAL_DISPATCH_HEADERS,
      ...PROOF_COVERED_CONTEXT_HEADERS,
      ...(buildHeaderNames ?? []),
    ]),
  ].sort();
}

/**
 * A0-DP-3. Header names Node's HTTP parser treats as SINGLETONS: a repeated field is not joined,
 * the FIRST value is kept and every later one is discarded.
 *
 * SOURCE OF TRUTH: Node's `lib/_http_incoming.js` — `matchKnownFields()` returns a `*` flag for
 * these names and `_addHeaderLine` then does `if (dest[field] === undefined) dest[field] = value`.
 * MEASURED against the Node in this environment (v24) through a real socket, two field lines per
 * name: every name below yielded `"A"` (`host` included — a repeated `Host` is not rejected, the
 * second line is simply dropped), while `cookie` yielded `"A; B"` and everything else (including
 * `x-custom`, `accept*`, `if-none-match`, `via`, `x-forwarded-*`) yielded `"A, B"`.
 * `content-length` is on Node's list and kept here for fidelity to it, though llhttp normally
 * rejects a conflicting duplicate before a handler sees the request at all.
 *
 * WHY THE PROOF CARES: this function's first cut joined every non-cookie name with `", "` on the
 * claim that "one rule serves both sides". It does not — `matcherProofHeaderNames` admits
 * ANY non-excluded header name, so a build whose middleware `matcher` gates on (say)
 * `user-agent` or `authorization` plus a client that sends the field twice made the edge sign
 * `"A, B"` (Envoy keeps both entries) while the pool read `"A"`: proof mismatch, dispatch headers
 * stripped, middleware re-run for every such request. Mirroring Node here is what makes the edge
 * sign the value the pool will actually materialize.
 *
 * `set-cookie` is deliberately NOT here: Node keeps it as an ARRAY (measured: `["a=1","b=2"]`)
 * and never joins it, so there is no single "value the next hop sees" to mirror. The `", "` join
 * below is then only a canonical form — both tiers reach it from the same list, which is all the
 * proof needs — and a request-side `Set-Cookie` is not a routing input in any case.
 */
export const NODE_SINGLETON_REQUEST_HEADERS: ReadonlySet<string> = new Set<string>([
  "age",
  "authorization",
  "content-length",
  "content-type",
  "etag",
  "expires",
  "from",
  "host",
  "if-modified-since",
  "if-unmodified-since",
  "last-modified",
  "location",
  "max-forwards",
  "proxy-authorization",
  "referer",
  "retry-after",
  "server",
  "user-agent",
]);

/**
 * Coalesce a repeated header into the single value the NEXT hop will see, at the BYTE level, so
 * the two tiers canonicalize duplicates identically. Three rules, all of them Node's (see
 * NODE_SINGLETON_REQUEST_HEADERS for the measurement): a singleton name keeps its FIRST value,
 * `Cookie` joins with `"; "`, everything else joins with `", "`. Envoy joins with the same two
 * delimiters when it writes an HTTP/1.1 upstream request, and it forwards a singleton's repeated
 * entries unchanged — which is why the first-value rule has to be applied by the SIGNER.
 * An empty list is ABSENT.
 *
 * Bytes, not strings (A0-DP-2): the two tiers decode the same wire octets into DIFFERENT JS
 * strings (Envoy's ext_proc `raw_value` is UTF-8, Node's parser is latin1), so the join has to
 * happen on the octets both of them agree about.
 */
export function coalesceWireHeaderBytes(
  name: string,
  values: readonly Buffer[],
): Buffer | undefined {
  if (values.length === 0) return undefined;
  const first = values[0]!;
  if (values.length === 1) return first;
  const lower = name.toLowerCase();
  if (NODE_SINGLETON_REQUEST_HEADERS.has(lower)) return first;
  const separator = Buffer.from(lower === "cookie" ? "; " : ", ", "latin1");
  const joined: Buffer[] = [];
  for (const value of values) {
    if (joined.length > 0) joined.push(separator);
    joined.push(value);
  }
  return Buffer.concat(joined);
}

/**
 * Read one header off a Node `req.headers`-shaped record as WIRE BYTES.
 *
 * A0-DP-2. Node's HTTP parser decodes header octets as LATIN1 (measured: wire bytes `c3 a9`
 * arrive as the two-char string `"Ã©"`), and Node's HTTP *client* re-encodes an outgoing header
 * value as latin1 (measured: the JS string `"é"` is written as the single octet `e9`). So latin1
 * is the exact inverse of Node's own codec in BOTH directions, which makes it the one encoding
 * that reproduces the wire octets from anything a Node tier holds — a value it parsed off an
 * incoming request AND a value it authored itself and is about to emit. That is what keeps the
 * cross-pool hop self-consistent: `proxyToPool` signs latin1 octets, Node writes those same
 * octets, and the receiving pool parses them back to the identical latin1 string.
 */
function wireHeaderBytes(name: string, value: string | string[] | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return Buffer.from(value, "latin1");
  return coalesceWireHeaderBytes(
    name,
    value.map((entry) => Buffer.from(entry, "latin1")),
  );
}

/**
 * One covered field's value, as the WIRE OCTETS both tiers must agree on (A0-DP-2).
 *
 * A `Buffer` is the octets themselves, and is what every value READ OFF THE WIRE must be: the
 * ext_proc tier passes Envoy's `raw_value` straight through, the pool passes its latin1-decoded
 * `req.headers` string re-encoded as latin1. A `string` is shorthand for "these octets are this
 * string's UTF-8 encoding", which is correct for a value a signer AUTHORS and hands to Envoy — an
 * ext_proc `HeaderValue.value` is a proto3 `string`, so Envoy puts its UTF-8 encoding on the wire
 * — and for an ASCII-only test fixture. It is NOT correct for anything a Node tier read or is
 * about to write (that is latin1, see `wireHeaderBytes`), which is why
 * `dispatchProofInputsFromRequest` never produces one.
 */
export type ProofFieldValue = Buffer | string | undefined;

/** Every routing input the dispatch proof binds. Both tiers fill this in from what they see. */
export interface DispatchProofInputs {
  /** Request method; case-normalized by the proof. An HTTP method token is ASCII by definition. */
  method: string;
  /**
   * Origin-form request target — `:path` at the ext_proc tier, `req.url` at the pool. Both tiers
   * see the same raw, un-normalized octets (query string included) but decode them differently,
   * so pass the octets (see ProofFieldValue).
   */
  target: ProofFieldValue;
  /**
   * `:authority` at the ext_proc tier, `Host` at the pool (Envoy writes the one from the other).
   * `undefined` means the header was absent, which is covered distinctly from any present value.
   */
  authority?: ProofFieldValue;
  /**
   * Covered header values keyed by LOWERCASE name — the dispatch vocabulary, the context
   * witnesses, and this build's derived inputs. A missing key (or an explicit `undefined`) is
   * covered as ABSENT, which the framing keeps distinct from a present empty value.
   */
  headers: Record<string, ProofFieldValue>;
  /** This build's derived covered header names (`buildProofHeaderNames`). */
  proofHeaderNames?: readonly string[] | undefined;
  /**
   * A0-DP-5. Mint time, ms since the epoch — bound into the transcript AND carried in the
   * credential, so the verifier can bound a proof's useful life without a second time source.
   * Required rather than defaulted: a signer must state when it signed, and every test that pins
   * a transcript must pin this too.
   */
  issuedAtMs: number;
  /**
   * A0-DP-5. SHA-256 of the request body, when the signer HAS the body. `undefined` is the
   * explicit ABSENT symbol — the transcript keeps it distinct from any digest, so a hop that
   * bound a body and one that could not are never confusable.
   */
  bodyDigest?: Buffer | undefined;
}

/** SHA-256 over a request body, the form `DispatchProofInputs.bodyDigest` takes. */
export function dispatchBodyDigest(body: Buffer): Buffer {
  return createHash("sha256").update(body).digest();
}

/**
 * A0-DP-5. How long a minted proof stays acceptable.
 *
 * The proof binds an input TUPLE, which made it good per-tuple rather than per-transmission: a
 * captured trusted exchange replayed to a pool verbatim, forever. This bounds that to a window.
 *
 * Anchored on REQUEST_HEAD_TIMEOUT_MS (dispatch.ts), the 60s default time-to-response-head budget
 * for one hop — a proof only has to survive the transit between the tier that minted it and the
 * tier that verifies it, and verification happens at the HEADER boundary, so a slow body upload
 * afterwards does not count against it. Two hops (edge → pool → pool) plus queueing gives 120s as
 * a deliberately generous ceiling that is still finite.
 *
 * The future-dated allowance is separate and one-sided. The codebase ALREADY assumes pod clocks
 * agree closely enough to compare absolute epoch times across pods — that is exactly what
 * INTERNAL_EXECUTION_DEADLINE_HEADER does — so 30s of skew is well past anything that assumption
 * survives, and a proof further ahead than that is rejected rather than silently trusted.
 *
 * Rejection is the SAME fail-safe as a mismatch: strip the dispatch headers, re-resolve locally.
 * A cluster with clocks bad enough to trip this loses trusted dispatch (a doubled middleware pass)
 * rather than correctness — and, unlike before A0-DP-2, says so through
 * `adapter_k8s.pool.dispatch_proof.rejected{reason="stale"|"premature"}`.
 */
export const DISPATCH_PROOF_MAX_AGE_MS = 120_000;
export const DISPATCH_PROOF_MAX_SKEW_MS = 30_000;

/**
 * The credential the proof header carries: `v3.<issuedAtMs>.<bodyDigestHex|-> .<macHex>`.
 *
 * The mint time and the body digest travel WITH the MAC because the verifier cannot reproduce
 * either on its own — it has no clock reading of the signing moment, and at the header trust
 * boundary it has not read the body yet. Both are bound INTO the transcript, so neither can be
 * edited in transit: rewriting the declared digest to match a swapped body invalidates the MAC.
 *
 * A declared digest is therefore an assertion the verifier must still CHECK against the bytes it
 * receives — see `dispatchProofBodyMatches` and the enforcement in pool-server/server.ts. The MAC
 * check alone says "the signer declared this digest", not "the body matches it".
 */
const DISPATCH_PROOF_PREFIX = "v3";
const ABSENT_BODY_DIGEST = "-";

export interface ParsedDispatchProof {
  issuedAtMs: number;
  bodyDigest: Buffer | undefined;
}

export function parseDispatchProof(credential: string): ParsedDispatchProof | undefined {
  const parts = credential.split(".");
  if (parts.length !== 4) return undefined;
  const [prefix, issuedAt, digest, mac] = parts as [string, string, string, string];
  if (prefix !== DISPATCH_PROOF_PREFIX) return undefined;
  if (!/^\d{1,15}$/.test(issuedAt)) return undefined;
  if (!/^[0-9a-f]{64}$/.test(mac)) return undefined;
  if (digest !== ABSENT_BODY_DIGEST && !/^[0-9a-f]{64}$/.test(digest)) return undefined;
  return {
    issuedAtMs: Number(issuedAt),
    bodyDigest: digest === ABSENT_BODY_DIGEST ? undefined : Buffer.from(digest, "hex"),
  };
}

/**
 * Does a body match the digest a verified proof declared? ABSENT means the signer bound no body,
 * which any body satisfies — see the residual note on `verifyDispatchProof`.
 */
export function dispatchProofBodyMatches(
  declared: Buffer | undefined,
  body: Buffer | null | undefined,
): boolean {
  if (declared === undefined) return true;
  const actual = dispatchBodyDigest(body ?? Buffer.alloc(0));
  return declared.length === actual.length && timingSafeEqual(declared, actual);
}

/**
 * Length-prefixed framing for one covered field. `+<byteLength>\n<bytes>` for a present value,
 * `-\n` for an ABSENT one.
 *
 * The v1 construction joined fields with `\n`, which made distinct input tuples share a
 * transcript: a covered header that was ABSENT was skipped entirely, so it signed the same bytes
 * as one present with an empty value, and a value containing a newline could restate a following
 * `name\nvalue` pair. Framing by byte length removes both — no covered value can impersonate the
 * delimiter, and absence is its own symbol rather than the lack of one.
 *
 * A0-DP-2: the framed unit is OCTETS, not a JS string. v2 took `string` and encoded it as UTF-8
 * at both tiers, which silently signed two different transcripts for one request: the edge
 * materialized covered values by decoding Envoy's `raw_value` as UTF-8 while the pool read Node's
 * latin1-decoded `req.headers`, so any covered value carrying a non-ASCII octet (a cookie a
 * matcher gates on, an `x-invoke-query` holding a percent-decoded `/posts/café`, a middleware
 * header in `x-mw-request-headers`) produced `"é"` → 2 bytes at the edge and `"Ã©"` → 4 bytes at
 * the pool. The proof then NEVER verified for that request shape: dispatch headers stripped,
 * middleware re-run at the pool, permanently and (before this change) without a single log line.
 */
function updateProofField(hmac: ReturnType<typeof createHmac>, value: ProofFieldValue): void {
  if (value === undefined) {
    hmac.update("-\n");
    return;
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  hmac.update(`+${bytes.length}\n`);
  hmac.update(bytes);
}

/**
 * ASCII-lowercase the authority's OCTETS. Hostnames are case-insensitive and both tiers route on
 * the lowercased form (URL parsing lowercases `hostname`), so lowercasing here stops a case flip
 * from failing the compare. Deliberately ASCII-only: a registrable hostname reaches this tier
 * punycoded, `toLowerCase()` on decoded octets would be locale- and encoding-dependent (the two
 * tiers hold different strings for the same octets — the whole A0-DP-2 problem), and a
 * non-hostname authority must fail the compare rather than be normalized into one.
 */
function asciiLowerBytes(value: ProofFieldValue): ProofFieldValue {
  if (value === undefined) return undefined;
  const bytes = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte >= 0x41 && byte <= 0x5a) bytes[i] = byte + 0x20;
  }
  return bytes;
}

/**
 * Compute (and verify) the per-request dispatch credential over EVERY routing input the pool
 * trusts from the edge, in one unambiguous transcript:
 *
 *   domain tag │ method │ target │ authority │ issued-at │ body digest │
 *   covered-name count │ (name │ value)*
 *
 * Covered names are the sorted union of INTERNAL_DISPATCH_HEADERS, PROOF_COVERED_CONTEXT_HEADERS
 * and this build's `proofHeaderNames`; every field is length-prefixed (see updateProofField),
 * and an absent header is signed as ABSENT rather than skipped. The name count is signed too, so
 * one build's transcript can never be a prefix of another's.
 *
 * A0-DP-5. The mint time and the body digest are part of the transcript, and the returned
 * CREDENTIAL carries both alongside the MAC (see DISPATCH_PROOF_MAX_AGE_MS and the credential
 * format above) — so the proof is bound to a transmission window and, on a hop that has the body,
 * to those exact bytes, not just to the header tuple.
 *
 * Both tiers MUST pass the same `proofHeaderNames` — they do, because both derive it from the
 * one build's routing manifest and a trusted pairing is always same-build (see
 * INTERNAL_DISPATCH_PROOF_HEADER). A mismatch fails closed: the pool strips the dispatch headers
 * and re-resolves locally.
 *
 * No interop window is needed for the v2 → v3 transcript change: the secret is per BUILD
 * (emit/templates/internal-secret.ts), so a pool only ever verifies proofs minted by its own
 * build's edge. Cross-build traffic already fails closed.
 */
export function computeDispatchProof(secret: string, inputs: DispatchProofInputs): string {
  const names = proofCoveredHeaderNames(inputs.proofHeaderNames);
  const issuedAt = String(Math.trunc(inputs.issuedAtMs));
  const digest = inputs.bodyDigest ? inputs.bodyDigest.toString("hex") : ABSENT_BODY_DIGEST;
  const hmac = createHmac("sha256", secret);
  hmac.update("adapter-k8s-dispatch-v3\n");
  updateProofField(hmac, inputs.method.toUpperCase());
  updateProofField(hmac, inputs.target);
  updateProofField(hmac, asciiLowerBytes(inputs.authority));
  updateProofField(hmac, issuedAt);
  updateProofField(hmac, inputs.bodyDigest);
  updateProofField(hmac, String(names.length));
  for (const name of names) {
    updateProofField(hmac, name);
    updateProofField(hmac, inputs.headers[name]);
  }
  return `${DISPATCH_PROOF_PREFIX}.${issuedAt}.${digest}.${hmac.digest("hex")}`;
}

/** A request as a NODE tier sees (or is about to emit) it — latin1-decoded strings throughout. */
export interface NodeDispatchProofRequest {
  method?: string | undefined;
  target?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  proofHeaderNames?: readonly string[] | undefined;
}

/**
 * Collect the proof inputs off a live request as seen by a NODE tier (a pool's `req.headers`, or
 * the cross-pool proxy's outbound header record). The authority comes from `Host`; every covered
 * name is read verbatim off the wire, with a repeated value coalesced the way the next hop would
 * see it.
 *
 * A0-DP-2: everything here is converted to wire OCTETS with `wireHeaderBytes`, i.e. latin1 — the
 * exact inverse of Node's own header codec on both the read and the write side (measured; see
 * that function). The target gets the same treatment for the same reason. This is the only place
 * a Node-held header string is turned into proof octets, so the edge tier's UTF-8 rule and this
 * tier's latin1 rule cannot be confused at a call site.
 */
export function dispatchProofInputsFromRequest(
  request: NodeDispatchProofRequest,
  options?: {
    /** Mint time. Defaults to now, which is what a SIGNER wants; a verifier passes the parsed one. */
    issuedAtMs?: number | undefined;
    /**
     * A0-DP-5. The request body, when this hop has it buffered — binds those exact bytes into the
     * proof. Omit (or pass `undefined`) on a hop that has no body available; that binds the ABSENT
     * symbol, which is a weaker but unambiguous statement.
     */
    body?: Buffer | undefined;
  },
): DispatchProofInputs {
  const headers: Record<string, ProofFieldValue> = {};
  for (const name of proofCoveredHeaderNames(request.proofHeaderNames)) {
    headers[name] = wireHeaderBytes(name, request.headers[name]);
  }
  return {
    method: request.method ?? "GET",
    target: Buffer.from(request.target ?? "/", "latin1"),
    authority: wireHeaderBytes("host", request.headers["host"]),
    headers,
    proofHeaderNames: request.proofHeaderNames,
    issuedAtMs: options?.issuedAtMs ?? Date.now(),
    ...(options?.body !== undefined ? { bodyDigest: dispatchBodyDigest(options.body) } : {}),
  };
}

/** Why a presented credential was refused — the `reason` on the rejection metric. */
export type DispatchProofRejection =
  | "malformed"
  | "mismatch"
  | "stale"
  | "premature"
  | "body-unexpected";

export type DispatchProofVerdict =
  | {
      trusted: true;
      /**
       * The body digest the signer declared, or `undefined` for ABSENT. A declared digest is an
       * ASSERTION: the caller must still check the body it receives against it once it has the
       * bytes (`dispatchProofBodyMatches`).
       */
      bodyDigest: Buffer | undefined;
    }
  | { trusted: false; reason: DispatchProofRejection };

/**
 * Verify a presented dispatch credential against the request as this tier sees it.
 *
 * A0-DP-5. Beyond the MAC this now enforces FRESHNESS: a credential older than
 * DISPATCH_PROOF_MAX_AGE_MS, or dated further ahead than DISPATCH_PROOF_MAX_SKEW_MS, is refused.
 * Before this, the proof was deterministic over the input tuple with no nonce, timestamp or body
 * binding, so a captured trusted exchange replayed to a pool verbatim forever — SECURITY.md's
 * "authorizes only the one request it was minted for" was true per input-tuple, not per
 * transmission.
 *
 * ACCEPTED RESIDUAL (documented, not overlooked): a credential whose body digest is ABSENT is
 * still replayable with any body inside the freshness window. The ext_proc edge cannot do better —
 * the header-phase callout never sees a body — but it also barely matters there: a build WITH
 * middleware never mints an edge proof for a body-capable request at all (handler.ts clears the
 * whole dispatch vocabulary for non-GET/HEAD when a middleware module exists, so the pool
 * re-resolves with the real body), and a build WITHOUT middleware has no middleware verdict to
 * steal. The cross-pool hop, which DOES have the body buffered, binds it.
 */
export function verifyDispatchProof(
  secret: string,
  request: NodeDispatchProofRequest,
  presentedProof: string,
  options?: { nowMs?: number | undefined },
): DispatchProofVerdict {
  const parsed = parseDispatchProof(presentedProof);
  if (!parsed) return { trusted: false, reason: "malformed" };
  // A signer only declares a digest when it HAS a body, which implies a body-capable method. The
  // method is bound, so this cannot be reached by rewriting one — it means a malformed producer.
  const method = (request.method ?? "GET").toUpperCase();
  if (parsed.bodyDigest && (method === "GET" || method === "HEAD")) {
    return { trusted: false, reason: "body-unexpected" };
  }
  const age = (options?.nowMs ?? Date.now()) - parsed.issuedAtMs;
  if (age > DISPATCH_PROOF_MAX_AGE_MS) return { trusted: false, reason: "stale" };
  if (age < -DISPATCH_PROOF_MAX_SKEW_MS) return { trusted: false, reason: "premature" };
  const expected = computeDispatchProof(secret, {
    ...dispatchProofInputsFromRequest(request, { issuedAtMs: parsed.issuedAtMs }),
    bodyDigest: parsed.bodyDigest,
  });
  if (!timingSafeStringEqual(presentedProof, expected)) {
    return { trusted: false, reason: "mismatch" };
  }
  return { trusted: true, bodyDigest: parsed.bodyDigest };
}

// A compiled middleware matcher entry from middleware-manifest.json.
export interface MiddlewareMatcher {
  regexp: string;
  has?: RouteHasCondition[];
  missing?: RouteHasCondition[];
  originalSource?: string;
}
export interface RouteHasCondition {
  type: "header" | "cookie" | "query" | "host";
  key?: string;
  value?: string;
}

function conditionPresent(cond: RouteHasCondition, headers: Headers, url: URL): boolean {
  let actual: string | null | undefined;
  switch (cond.type) {
    case "header":
      actual = cond.key ? headers.get(cond.key) : undefined;
      break;
    case "query":
      actual = cond.key ? url.searchParams.get(cond.key) : undefined;
      break;
    case "cookie": {
      const cookie = headers.get("cookie");
      if (cookie && cond.key) {
        for (const part of cookie.split(";")) {
          const [k, ...v] = part.trim().split("=");
          if (k === cond.key) {
            actual = v.join("=");
            break;
          }
        }
      }
      break;
    }
    case "host":
      actual = url.hostname;
      break;
  }
  if (actual === null || actual === undefined) return false;
  if (cond.value === undefined) return true; // presence-only
  // Anchored (^…$) on purpose: this evaluates MIDDLEWARE matcher has/missing,
  // which `next start` runs through matchHas (prepare-destination.js) — and
  // matchHas anchors (`new RegExp(`^${value}$`)`). @next/routing's own
  // matchesCondition is unanchored, but it never evaluates middleware matchers
  // (resolveRoutes defers matcher gating to the invokeMiddleware callback), so
  // matchHas is the behavior to mirror. See middleware-matcher.test.ts.
  const re = conditionRegex(cond.value);
  if (!re) return cond.value === actual;
  return re.test(actual);
}

/**
 * S11 (AVAILABILITY). Compile a has/missing condition value ONCE, and refuse a pattern whose
 * shape can backtrack catastrophically.
 *
 * Two defects lived in the old inline `new RegExp(\`^${cond.value}$\`)`:
 *  1. It recompiled on EVERY request — a per-request regex compile on the hot path of both
 *     tiers, for a pattern that is fixed for the life of the process.
 *  2. The pattern comes from the app's middleware matcher config (copied verbatim into the
 *     runtime manifest by manifest.ts) while the SUBJECT is an attacker-controlled header,
 *     cookie, query value or hostname. An app matcher of `^(a+)+$` against ~28 `a`s plus one
 *     mismatching character blocks the event loop for seconds — and the routing service's own
 *     request-shed timer cannot interrupt synchronous CPU work (server.ts says so). Repeated
 *     tiny requests then stall both tiers past their health-check deadlines, so a matcher an
 *     app author wrote for convenience becomes a remote availability bug.
 *
 * Cheap shape checks refuse nested quantifiers and quantified groups containing alternation.
 * A bounded automaton analysis then catches cross-group ambiguity such as `a*a*a*a*a*b`, which
 * no local group walk can see. A rejected pattern degrades to exact string comparison — the same
 * fallback an uncompilable pattern already took — rather than throwing, because a matcher that
 * cannot be evaluated must never silently widen coverage.
 *
 * The degrade is a RUNTIME last resort, not the intended way an author learns about this. The
 * shape is fully known at build time, so `manifest.ts` runs the same predicate
 * (`unsafeConditionPattern`, below — ONE definition, so the two cannot drift) and FAILS the build
 * naming the matcher. A pod-log warning about silently narrowed matcher coverage is a bad channel
 * for a config mistake; `next build` is the right one. Reaching the degrade path therefore means
 * a manifest built before that check existed, or one hand-edited afterwards.
 *
 * The analyzer itself is bounded too. A complex or unsupported expression that exceeds the
 * score or deterministic step budget is unsafe rather than allowed through on an inconclusive
 * verdict. The build-time half shares this exact predicate.
 */
const conditionRegexCache = new Map<string, RegExp | null>();

/**
 * Identify a repeated group that contains either another quantifier or alternation.
 *
 * This is a tiny syntax walk rather than another regexp so escaped metacharacters, character
 * classes, group prefixes and nested groups are handled consistently. State propagates to the
 * parent: `((a|aa))+` and `((aa?))+` retain the hazards of their inner groups. In particular,
 * `?` must count as an INNER quantifier — `(aa?)+` is the same exponential language as
 * `(a|aa)+` — while the `?` that opens `(?:...)`/`(?=...)` is syntax, not repetition.
 */
function quantifiedGroupHazard(value: string): "nested quantifier" | "alternation" | null {
  const groups: Array<{
    openIndex: number;
    containsAlternation: boolean;
    containsQuantifier: boolean;
  }> = [];
  let inCharacterClass = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "\\") {
      i++; // the following code point is literal, including `|`, `[` or `)`
      continue;
    }
    if (inCharacterClass) {
      if (ch === "]") inCharacterClass = false;
      continue;
    }
    if (ch === "[") {
      inCharacterClass = true;
      continue;
    }
    if (ch === "(") {
      groups.push({ openIndex: i, containsAlternation: false, containsQuantifier: false });
      continue;
    }
    if (ch === "|" && groups.length > 0) {
      groups[groups.length - 1]!.containsAlternation = true;
      continue;
    }
    if (
      groups.length > 0 &&
      (ch === "+" || ch === "*" || ch === "?" || ch === "{") &&
      // `?` immediately after this group's opening parenthesis introduces a non-capturing,
      // lookaround or named group. It does not quantify an atom.
      !(ch === "?" && groups[groups.length - 1]!.openIndex === i - 1)
    ) {
      groups[groups.length - 1]!.containsQuantifier = true;
      continue;
    }
    if (ch !== ")" || groups.length === 0) continue;

    const group = groups.pop()!;
    const next = value[i + 1];
    const groupIsQuantified = next === "+" || next === "*" || next === "?" || next === "{";
    const groupIsRepeated = next === "+" || next === "*" || next === "{";
    if (groupIsRepeated) {
      if (group.containsQuantifier) return "nested quantifier";
      if (group.containsAlternation) return "alternation";
    }
    if (groups.length > 0) {
      const parent = groups[groups.length - 1]!;
      parent.containsAlternation ||= group.containsAlternation;
      parent.containsQuantifier ||= group.containsQuantifier || groupIsQuantified;
    }
  }
  return null;
}

/**
 * Why this has/missing pattern must not be evaluated as a regexp, or `null` if it is fine.
 * The returned string is a sentence fragment, usable in both the runtime warning and the
 * build-time error. Shared by both tiers and by the build so there is a single definition of
 * "pathological" (the two-resolver-tier drift problem this module exists to prevent).
 */
export function unsafeConditionPattern(value: string): string | null {
  // Bound parser/compiler work too. This is build-authored in normal operation, but a hand-edited
  // runtime manifest must not turn first-request compilation into a separate CPU spike.
  if (value.length > 4096) {
    return "the pattern exceeds the 4096-character analysis and compilation limit";
  }
  const hazard = quantifiedGroupHazard(value);
  if (hazard === "nested quantifier") {
    return (
      "a quantified group containing another quantifier can backtrack exponentially against a " +
      "request-controlled value, blocking the event loop"
    );
  }
  if (hazard === "alternation") {
    return (
      "a quantified group containing alternation can backtrack exponentially against a " +
      "request-controlled value, blocking the event loop"
    );
  }
  if (/\\k</.test(value)) {
    return "named backreferences are not supported by the bounded automaton analysis";
  }
  try {
    // redos-detector 6.x parses lookbehind and numeric backreferences, but not JavaScript named
    // capture syntax. Names do not change the automaton, so remove only the `?<name>` marker for
    // analysis. Named backreferences were refused above because replacing those would require a
    // capture-numbering rewrite rather than this semantics-preserving marker removal.
    const analyzableValue = value.replace(/\(\?<[$A-Z_a-z][$\w]*>/g, "(");
    const analysis = isSafePattern(`^${analyzableValue}$`, {
      // The library scores alternate paths through the expression. A finite, deterministic step
      // budget is mandatory: an analyzer that can itself run without a bound merely moves the
      // DoS, while a wall-clock timeout could reject a build-approved pattern only when a pod is
      // under load and silently narrow middleware coverage.
      maxScore: 200,
      maxSteps: 500,
    });
    if (!analysis.safe) {
      return (
        "bounded automaton analysis found ambiguous matching paths or could not prove the " +
        "pattern safe within its fixed budget; synchronous evaluation could block the event loop"
      );
    }
  } catch {
    return (
      "bounded automaton analysis could not parse or prove this pattern safe for synchronous " +
      "evaluation against a request-controlled value"
    );
  }
  return null;
}

export function conditionRegex(value: string): RegExp | null {
  const cached = conditionRegexCache.get(value);
  if (cached !== undefined) return cached;
  let compiled: RegExp | null = null;
  const unsafe = unsafeConditionPattern(value);
  if (unsafe) {
    console.warn(
      `[adapter-k8s] Refusing to evaluate middleware matcher condition ${JSON.stringify(value)} ` +
        `as a regular expression: ${unsafe}. ` +
        `Falling back to exact string comparison for this condition.`,
    );
  } else {
    try {
      compiled = new RegExp(`^${value}$`);
    } catch {
      compiled = null;
    }
  }
  // Cache the verdict — including the negative one, so a rejected or uncompilable pattern
  // costs one warning and one check for the life of the process, not one per request.
  conditionRegexCache.set(value, compiled);
  return compiled;
}

// Compiled matcher regexps, memoized per matcher OBJECT (matchers come from the
// routing manifest, which is parsed once per process — object identity is stable,
// so a WeakMap both caches for the process lifetime and lets a replaced manifest
// be GC'd). Compiling per request showed up in profiles: a middleware catch-all
// regexp is ~200 chars and every request re-parsed it.
const matcherRegexCache = new WeakMap<MiddlewareMatcher, RegExp | null>();

// Warn-once bookkeeping for uncompilable matcher patterns. The compile failure
// itself is cached in the WeakMap (per matcher object), but the warn is keyed by
// pattern TEXT so a re-parsed manifest (new objects, same patterns) doesn't re-spam.
const warnedUncompilableMatchers = new Set<string>();

function compileMatcherRegex(m: MiddlewareMatcher): RegExp | null {
  let re = matcherRegexCache.get(m);
  if (re === undefined) {
    try {
      re = new RegExp(m.regexp);
    } catch (err) {
      // Remember the failure too — a bad regexp must not re-throw per request.
      re = null;
      if (!warnedUncompilableMatchers.has(m.regexp)) {
        warnedUncompilableMatchers.add(m.regexp);
        console.warn(
          `[adapter-k8s] middleware matcher regexp failed to compile in this runtime; ` +
            `treating it as MATCHED so middleware always runs for it (fail-safe): ` +
            `${JSON.stringify(m.regexp)} — ${err instanceof Error ? err.message : String(err)}. ` +
            `This usually means the build machine's Node/V8 accepts regex syntax the serving ` +
            `runtime does not (e.g. inline-flag groups like "(?i:)" on an older Node).`,
        );
      }
    }
    matcherRegexCache.set(m, re);
  }
  return re;
}

// Decide whether middleware should run for a request, honoring its `matcher`
// config (source regexp + has/missing conditions). Without this, middleware
// runs on every path — breaking matcher-gated middleware (has/missing) and any
// source-restricted matcher. Empty/absent matchers → run always (a middleware
// with no config.matcher compiles to a catch-all, but be safe).
export function matchesMiddleware(
  matchers: MiddlewareMatcher[] | undefined,
  url: URL,
  headers: Headers,
): boolean {
  if (!matchers || matchers.length === 0) return true;
  // Match against the raw pathname AND its decoded form: a matcher source
  // "/another/hello" must match a request for "/another%2fhello" (encoded
  // slash), which Next normalizes before matching.
  const paths = [url.pathname];
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (decoded !== url.pathname) paths.push(decoded);
  } catch {
    // malformed escape — raw only
  }
  for (const m of matchers) {
    const re = compileMatcherRegex(m);
    // FAIL-SAFE: a matcher that cannot compile in THIS runtime (build-machine vs
    // serving-runtime V8 skew — the `(?i:)` Node-version incident class) is treated
    // as MATCHED, never skipped. Skipping it would return false here, the ext_proc
    // handler would stamp the TRUSTED `skip-nomatch` verdict, and the pool would
    // skip its own middleware too — a silent middleware BYPASS. Running middleware
    // when in doubt is safe; not running it is not. has/missing still gate below,
    // exactly as they would for a genuinely matched source.
    if (re && !paths.some((p) => re.test(p))) continue;
    const hasOk = (m.has ?? []).every((c) => conditionPresent(c, headers, url));
    const missingOk = (m.missing ?? []).every((c) => !conditionPresent(c, headers, url));
    if (hasOk && missingOk) return true;
  }
  return false;
}

/**
 * S2 (SECURITY). "Could middleware EVER cover this pathname?" — the source regexps only,
 * with `has`/`missing` deliberately ignored.
 *
 * `matchesMiddleware` is per-REQUEST because `has`/`missing` read the request's own headers,
 * cookies and query. That is correct for deciding whether to RUN middleware, but it is wrong
 * for deciding whether a response may be shared-cached, because the two verdicts have
 * different granularity: the Cloud CDN cache key (gcp-http-filter.ts) contains neither
 * `Cookie` nor `Authorization`, so both variants of a conditionally-covered URL share ONE
 * cache entry. With a matcher carrying `missing: [{type:"cookie", key:"session"}]`, an
 * authenticated request does not match, keeps its origin `public, max-age=…`, and fills the
 * CDN — and the next unauthenticated request hits that entry BEFORE the post-cache ext_proc
 * extension and receives the protected body with middleware never running. The `has:`
 * polarity is the same defect with the roles swapped.
 *
 * So every consumer whose decision outlives a single request — the forced CDN cache-control
 * verdict and the pool's static/data fast paths — must use THIS predicate, and treat a
 * conditionally-covered path as covered. `matchesMiddleware` stays the gate for actually
 * running middleware.
 */
export function middlewareMayCoverPath(
  matchers: MiddlewareMatcher[] | undefined,
  url: URL,
): boolean {
  if (!matchers || matchers.length === 0) return true;
  const paths = [url.pathname];
  try {
    const decoded = decodeURIComponent(url.pathname);
    if (decoded !== url.pathname) paths.push(decoded);
  } catch {
    // malformed escape — raw only
  }
  for (const m of matchers) {
    const re = compileMatcherRegex(m);
    // Same fail-safe as matchesMiddleware: an uncompilable matcher counts as a match.
    if (!re || paths.some((p) => re.test(p))) return true;
  }
  return false;
}

// Strip basePath only at a segment boundary — "/docsy" must NOT be treated as
// under basePath "/docs" (upstream requires `p === base || p.startsWith(base + "/")`).
export function stripBasePath(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length);
  return pathname;
}

// Match a concrete (percent-decoded) request pathname against dynamic-route
// output templates ("/blog/[slug]", "/docs/[...parts]", "/x/[[...opt]]").
// Handlers for prerendered dynamic routes are keyed by the TEMPLATE while
// routing resolves the concrete path, so dispatch needs this to find them.
export function templateOutputCandidates(pathname: string, outputIds: string[]): string[] {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // keep encoded form
  }
  const paths = decoded === pathname ? [pathname] : [pathname, decoded];
  const matches: string[] = [];
  for (const id of outputIds) {
    if (!id.includes("[")) continue;
    const segs = id.split("/").slice(1);
    let pattern = "";
    let valid = true;
    for (const seg of segs) {
      if (/^\[\[\.\.\..+\]\]$/.test(seg)) {
        pattern += "(?:/.+)?"; // optional catch-all
      } else if (/^\[\.\.\..+\]$/.test(seg)) {
        pattern += "/.+"; // catch-all
      } else if (/^\[.+\]$/.test(seg)) {
        pattern += "/[^/]+"; // dynamic segment
      } else if (seg.includes("[")) {
        valid = false; // partial-segment templates unsupported
        break;
      } else {
        pattern += "/" + seg.replace(/[.*+?^${}()|\\]/g, "\\$&");
      }
    }
    if (!valid) continue;
    const re = new RegExp(`^${pattern}/?$`);
    if (paths.some((c) => re.test(c))) matches.push(id);
  }
  // Prefer more specific templates: catch-alls are less specific than single
  // dynamic segments, which are less specific than literals.
  const weight = (id: string) => (id.match(/\[/g)?.length ?? 0) + (id.includes("...") ? 10 : 0);
  // N9: tie-break on literal segments, most-literal first. i18n expands one Pages route
  // into one output per locale, so `/en-US` matches BOTH `/[[...slug]]` and
  // `/en-US/[[...slug]]` at identical weight — a stable sort then picked whichever came
  // first in the manifest, and feeding the locale-prefixed concrete path to the
  // UNPREFIXED template turned the locale into the first catch-all param (`/` rendered
  // with slug ["en-US"], and locale-prefixed index rewrites 404'd on fallback:false).
  const literalSegments = (id: string) =>
    id.split("/").filter((seg) => seg && !seg.includes("[")).length;
  return matches.sort((a, b) => weight(a) - weight(b) || literalSegments(b) - literalSegments(a));
}

export function trailingSlashVariants(pathname: string): string[] {
  if (pathname === "/") return ["/"];
  const withSlash = pathname.endsWith("/") ? pathname : pathname + "/";
  const withoutSlash = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return [pathname, withoutSlash, withSlash];
}

// Resolve a pathname to its owning pool. A route may be keyed in poolAssignments with or
// without a trailing slash, and i18n routes arrive locale-prefixed (/en/about) while the
// assignment is keyed unprefixed (/about). Falls back to the "default" pool, then the first
// assignment. NOTE: the fallback is a best-effort guess — if it guesses wrong the pool's
// cross-pool proxy (dispatch.ts) still recovers, at the cost of an extra hop.
export function lookupPool(
  poolAssignments: Record<string, string>,
  resolvedPathname: string | undefined,
  matchedPathname: string,
  i18nLocales?: string[],
): string | undefined {
  const candidates: string[] = [];
  if (resolvedPathname) candidates.push(...trailingSlashVariants(resolvedPathname));
  candidates.push(...trailingSlashVariants(matchedPathname));

  // Also try stripping i18n locale prefix (e.g., /en/about → /about)
  if (i18nLocales?.length) {
    const extra: string[] = [];
    for (const c of candidates) {
      for (const locale of i18nLocales) {
        const prefix = `/${locale}`;
        if (c.startsWith(prefix + "/") || c === prefix) {
          extra.push(...trailingSlashVariants(c.slice(prefix.length) || "/"));
        }
      }
    }
    candidates.push(...extra);
  }

  for (const p of candidates) {
    if (poolAssignments[p]) return poolAssignments[p];
  }
  return poolAssignments["default"] ?? Object.values(poolAssignments)[0];
}

// @next/routing locale-prefixes unprefixed request paths internally before
// running route rules, but never surfaces the prefixed URL: when no route
// matches, the caller falls back to the ORIGINAL pathname, losing the locale
// (outputs are keyed locale-prefixed, e.g. "/en/about"). It also malformes the
// root as "/en/" (trailing slash), spuriously firing the trailing-slash 308
// rule and dropping the query. Prevent both at the source: pre-prefix every
// unprefixed page path with the locale resolveRoutes would pick, using
// @next/routing's own exported detection helpers so the logic cannot drift
// (same skip conditions: /_next/*, /api/*, already-prefixed). Next performs
// preferred-locale detection only for the index route; non-root unprefixed
// pages render in the default locale even when Accept-Language prefers another
// locale. Only an index request that should redirect is left to resolveRoutes.
//
// KNOWN DIVERGENCE (deliberate): this means middleware invoked downstream sees
// the locale-PREFIXED ctx.url (/en/about) where `next start` shows the
// unprefixed pathname (/about, locale on nextUrl.locale). We can't un-prefix:
// @next/routing itself prefixes the internal URL before calling
// invokeMiddleware (verified in dist: `u.pathname = ${basePath}/${locale}${path}`
// runs before `invokeMiddleware({url: u})`), and responseToMiddlewareResult +
// the rewrite/redirect normalization below are built around the prefixed form.
// Un-prefixing only for middleware would desync the two tiers (pool + ext_proc)
// and the whole normalization stack, for a cosmetic difference middleware can
// still compensate for via the Accept-Language/cookie hints. Pinned by the i18n
// suites (routing-common.test.ts, fixtures/i18n-rewrite).
export function prefixRequestLocale(
  url: URL,
  headers: Headers,
  i18n:
    | {
        locales: string[];
        defaultLocale: string;
        localeDetection?: false;
        domains?: Array<{ defaultLocale: string; domain: string; http?: true; locales?: string[] }>;
      }
    | null
    | undefined,
  basePath: string,
  trailingSlash?: boolean,
): string | null {
  if (!i18n?.locales?.length) return null;
  const path = stripBasePath(url.pathname, basePath);
  if (path.startsWith("/_next/") || path.startsWith("/api/")) return null;
  if (normalizeLocalePath(path, i18n.locales).detectedLocale) return null; // already prefixed

  const domainLocale = detectDomainLocale(i18n.domains as never, url.hostname);
  const defaultLocale = domainLocale?.defaultLocale || i18n.defaultLocale;
  const isIndex = path === "/" || path === "/index";
  let locale = defaultLocale;
  if (isIndex && i18n.localeDetection !== false) {
    locale = detectLocale({
      pathname: path,
      hostname: url.hostname,
      cookieHeader: headers.get("cookie") ?? undefined,
      acceptLanguageHeader: headers.get("accept-language") ?? undefined,
      i18n: i18n as never,
    }).locale;
    if (locale !== defaultLocale) return null; // resolveRoutes will redirect — leave it
  }
  if (path === "/") {
    // With trailingSlash: true the add-slash rule matches "/en" and would 308
    // the root — prefix in the canonical slashed form so no rule fires.
    url.pathname = trailingSlash ? `${basePath}/${locale}/` : `${basePath}/${locale}`;
  } else {
    url.pathname = `${basePath}/${locale}${path}`;
  }
  return locale;
}

// Rule redirects can also capture the internal locale prefix into their
// destinations. Neither artifact exists upstream (next start applies
// rules to the unprefixed path). Normalize redirect results:
//  - target locale-stripped == original path and status 308: the redirect is
//    purely the internal trailing-slash artifact → caller must RE-RESOLVE with
//    the locale-prefixed path (returned as retryUrl), preserving the query.
//  - target locale-stripped == original path and status 307: this is the i18n
//    locale-detection redirect; keep it but fix the "/fr/" → "/fr" slash.
//  - otherwise: the rule leaked the internal locale prefix → strip it.
// Middleware-issued redirects arrive via resolvedHeaders (not resolution.redirect)
// and are never passed through this function.
export function normalizeI18nRedirect(
  redirect: { url: URL; status: number },
  requestUrl: URL,
  i18n: { locales: string[]; defaultLocale: string } | null | undefined,
  basePath: string,
  addedLocale?: string | null,
): { kind: "keep" } | { kind: "rewrite"; url: URL } | { kind: "retry"; retryUrl: URL } {
  if (!i18n?.locales?.length) return { kind: "keep" };

  const stripBase = (p: string) => stripBasePath(p, basePath);
  const localeOf = (p: string): { locale?: string | undefined; rest: string } => {
    const norm = normalizeLocalePath(p, i18n.locales);
    return { locale: norm.detectedLocale, rest: norm.pathname };
  };

  const origPath = stripBase(requestUrl.pathname);
  if (localeOf(origPath).locale) return { kind: "keep" }; // request was already locale-scoped

  const target = redirect.url;
  const targetPath = stripBase(target.pathname);
  const { locale, rest } = localeOf(targetPath);
  if (!locale) return { kind: "keep" };

  const crossOrigin = target.origin !== requestUrl.origin;
  if (crossOrigin) {
    // Domain locale redirects keep their locale; only fix the root slash artifact.
    if (targetPath === `/${locale}/`) {
      const url = new URL(target.toString());
      url.pathname = url.pathname.slice(0, -1);
      return { kind: "rewrite", url };
    }
    return { kind: "keep" };
  }

  if (rest === origPath) {
    if (redirect.status === 307) {
      // Locale-detection redirect: keep, fixing "/fr/" → "/fr" for the root.
      if (targetPath === `/${locale}/`) {
        const url = new URL(target.toString());
        url.pathname = url.pathname.slice(0, -1);
        return { kind: "rewrite", url };
      }
      return { kind: "keep" };
    }
    // Trailing-slash artifact of internal prefixing: re-resolve, don't redirect.
    const retryUrl = new URL(requestUrl.toString());
    retryUrl.pathname = `${basePath}/${locale}${origPath === "/" ? "" : origPath}`;
    return { kind: "retry", retryUrl };
  }

  // Rule redirects whose target carries exactly the locale WE auto-added
  // captured the internal prefix — upstream ran the rule on the unprefixed
  // path, so its Location has no locale. Explicit locale destinations
  // (`locale: false` rules pointing at a DIFFERENT locale) are untouched, and
  // stripping the auto-added (detected/default) locale is render-equivalent
  // even when the destination named it explicitly.
  if (addedLocale && locale.toLowerCase() === addedLocale.toLowerCase()) {
    const url = new URL(target.toString());
    url.pathname = `${basePath}${rest === "/" ? "" : rest}` || "/";
    return { kind: "rewrite", url };
  }
  return { kind: "keep" };
}

// Trailing-slash normalization rules redirect via a `Location: /$1` header,
// which (a) cannot express "keep the original query" — upstream preserves it —
// and (b) captures the internal locale prefix when the rule ran on the
// locale-prefixed internal URL (upstream applies these rules to the unprefixed
// path, so its Location never contains an auto-added locale). Both corrections
// apply ONLY when the redirect is a pure slash-flip of the request path, so
// middleware redirects to genuinely different paths are untouched.
export function normalizeLocationRedirect(
  target: URL,
  requestUrl: URL,
  i18n: { locales: string[] } | null | undefined,
  basePath: string,
  addedLocale?: string | null,
): void {
  if (target.origin !== requestUrl.origin) return;

  const stripBase = (p: string) => stripBasePath(p, basePath);
  // Pure slash-flip: identical paths modulo exactly one trailing slash.
  const isSlashFlip = (a: string, b: string) => a === `${b}/` || `${a}/` === b;

  const origPath = stripBase(requestUrl.pathname);
  let targetPath = stripBase(target.pathname);

  // Strip an internally-added locale from slash-flip redirects. Only when the
  // original request carried no locale prefix (so explicit locale destinations
  // survive) and the stripped target is a pure slash-flip of the original.
  if (i18n?.locales?.length) {
    const localeOf = (p: string) => {
      const seg = p.split("/", 2)[1]?.toLowerCase();
      const match = seg && i18n.locales.find((l) => l.toLowerCase() === seg);
      return match ? { locale: match, rest: p.slice(match.length + 1) || "/" } : { rest: p };
    };
    if (!localeOf(origPath).locale) {
      const t = localeOf(targetPath);
      // Strip when the target is a pure slash-flip of the original (trailing
      // slash rules), or when the leaked locale is exactly the one we
      // auto-added (config redirects capture it; upstream ran the rule on the
      // unprefixed path). Different-locale targets are deliberate and kept.
      if (
        t.locale &&
        (isSlashFlip(t.rest, origPath) ||
          (addedLocale && t.locale.toLowerCase() === addedLocale.toLowerCase()))
      ) {
        targetPath = t.rest;
        target.pathname = `${basePath}${targetPath === "/" ? "" : targetPath}` || "/";
      }
    }
  }

  // Preserve the query across pure slash-flip redirects.
  if (!target.search && requestUrl.search && isSlashFlip(target.pathname, requestUrl.pathname)) {
    target.search = requestUrl.search;
  }
}

// --- Shared resolution orchestration -----------------------------------------
// The pre-resolution request normalization and post-resolution redirect
// normalization run in BOTH resolvers (pool-server/resolve.ts Phase 1 and
// routing-service/handler.ts Phase 2). They live here as one sequence — not
// just shared primitives — because the two call sites have already proven they
// drift when mirrored by hand. The middleware invocation blocks intentionally
// remain per-resolver (the edge sandbox path exists only in the pool).

export interface PreparedRequest {
  kind: "ok";
  /** Locale-prefixed URL to hand to resolveRoutes. */
  url: URL;
  /** Untouched request URL — redirect normalization compares against this. */
  originalUrl: URL;
  /** Whether the public request used the Pages Router /_next/data protocol. */
  isDataRequest: boolean;
  addedLocale: string | null;
}

export type PrepareResult =
  | PreparedRequest
  | { kind: "error"; status: number }
  | { kind: "redirect"; url: URL; status: number };

export function prepareRequest(
  requestUrl: URL,
  headers: Headers,
  manifest: {
    buildId?: string | undefined;
    i18n?: unknown;
    basePath: string;
    trailingSlash?: boolean | undefined;
  },
): PrepareResult {
  // Strip client-sent x-middleware-* control headers FIRST — this is the shared entry for
  // both tiers, and Phase-2 middleware runs at the routing tier on these very headers. A
  // spoofed `x-middleware-set-cookie` request header round-tripped through
  // NextResponse.next()'s x-middleware-override-headers and materialized as a cookie the
  // client never set (app-middleware-proxy). The pool's server.ts does the same strip for
  // Phase 1; doing it here too is idempotent. The public prefetch hint is protocol, kept.
  // Snapshot before deleting so iteration never depends on Map mutation semantics.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const name of [...headers.keys()]) {
    if (name.startsWith("x-middleware-") && name !== "x-middleware-prefetch") {
      headers.delete(name);
    }
  }

  // Malformed percent-encoding in the path → 400, matching upstream.
  try {
    decodeURIComponent(requestUrl.pathname);
  } catch {
    return { kind: "error", status: 400 };
  }

  // Repeated slashes: 308 to the collapsed path, matching upstream.
  const collapsed = collapseSlashesRedirect(requestUrl);
  if (collapsed) return { kind: "redirect", url: collapsed, status: 308 };

  const originalUrl = new URL(requestUrl.toString());
  const url = new URL(requestUrl.toString());
  const dataPrefix = `${manifest.basePath}/_next/data/${manifest.buildId ?? ""}/`;
  const isDataRequest = Boolean(
    manifest.buildId && url.pathname.startsWith(dataPrefix) && url.pathname.endsWith(".json"),
  );
  if (isDataRequest) {
    const dataPath = url.pathname.slice(dataPrefix.length, -".json".length);
    const pagePath = dataPath === "index" ? "/" : `/${dataPath}`;
    url.pathname = `${manifest.basePath}${pagePath === "/" ? "" : pagePath}` || "/";
    if (manifest.trailingSlash && url.pathname !== "/" && !url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
  }
  const addedLocale = prefixRequestLocale(
    url,
    headers,
    manifest.i18n as never,
    manifest.basePath,
    manifest.trailingSlash,
  );
  return { kind: "ok", url, originalUrl, isDataRequest, addedLocale };
}

// Post-resolution redirect handling, shared verbatim by both resolvers:
//  - resolution.redirect (rule/detection redirects) → i18n-normalized, may retry
//  - Location + redirect-status in resolvedHeaders (middleware / header-only
//    rules) → resolved against the ORIGINAL request URL per HTTP semantics,
//    slash-flip query preservation and locale-leak stripping applied.
// Both shapes carry resolvedHeaders so middleware Set-Cookie and custom
// redirect headers survive on every phase.
export function normalizeResolvedRedirect(
  resolution: {
    redirect?: { url: URL; status: number } | undefined;
    resolvedHeaders?: Headers | undefined;
    status?: number | undefined;
  },
  prep: PreparedRequest,
  manifest: { i18n?: unknown; basePath: string },
  opts?: {
    /** True when MIDDLEWARE authored this Location (its target is authoritative — no query
     * carry). @next/routing surfaces middleware redirects and header-only rule redirects in the
     * same `status` + `resolvedHeaders.location` shape, so only the caller can tell them apart. */
    middlewareAuthored?: boolean;
  },
):
  | { kind: "redirect"; url: URL; status: number; resolvedHeaders: Headers | undefined }
  | { kind: "retry"; retryUrl: URL }
  | null {
  const i18n = manifest.i18n as { locales: string[]; defaultLocale: string } | null | undefined;

  if (resolution.redirect) {
    const norm = normalizeI18nRedirect(
      resolution.redirect,
      prep.originalUrl,
      i18n,
      manifest.basePath,
      prep.addedLocale,
    );
    if (norm.kind === "retry") return { kind: "retry", retryUrl: norm.retryUrl };
    return {
      kind: "redirect",
      url: norm.kind === "rewrite" ? norm.url : resolution.redirect.url,
      status: resolution.redirect.status,
      resolvedHeaders: resolution.resolvedHeaders ?? undefined,
    };
  }

  const location = resolution.resolvedHeaders?.get("location");
  if (location && [301, 302, 303, 307, 308].includes(resolution.status ?? 0)) {
    const target = new URL(location, prep.originalUrl);
    // N15: next.config `redirects()` compile to a ROUTE carrying a Location header and no
    // destination. Upstream carries the REQUEST query onto such a target when the target has
    // none (@next/routing >= 16.3 resolveRedirectLocationWithRequestQuery); the 16.2.x we
    // depend on does not, so mirror it here — `next start` answers GET /redirect/source?foo=1
    // with `location: /redirect/dest?foo=1`, and the App Router flight client REQUIRES the
    // `_rsc` cache-busting param to survive the hop. No-op once the dependency does it itself.
    // Middleware-authored Locations are EXCLUDED: their target is authoritative (an unguarded
    // carry broke e2e/middleware-redirects with ERR_TOO_MANY_REDIRECTS).
    if (!opts?.middlewareAuthored && !target.search && prep.originalUrl.search) {
      target.search = prep.originalUrl.search;
    }
    normalizeLocationRedirect(target, prep.originalUrl, i18n, manifest.basePath, prep.addedLocale);
    return {
      kind: "redirect",
      url: target,
      status: resolution.status!,
      resolvedHeaders: resolution.resolvedHeaders ?? undefined,
    };
  }

  return null;
}

// Manifest-derived config assembled in one place — the web adapter and the edge
// sandbox both need it, across four call sites that previously hand-built it.
export function manifestNextConfig(manifest: {
  basePath: string;
  i18n?: unknown;
  trailingSlash?: boolean | undefined;
}): { basePath?: string | undefined; i18n?: unknown; trailingSlash?: boolean | undefined } {
  return {
    basePath: manifest.basePath || undefined,
    i18n: (manifest.i18n as never) ?? undefined,
    trailingSlash: manifest.trailingSlash || undefined,
  };
}

export function getRscConfig(manifest: { routeGraph?: unknown }): RscConfig | undefined {
  return (manifest.routeGraph as { rsc?: RscConfig } | undefined)?.rsc;
}

/** The `routeGraph` buckets `@next/routing`'s matchRoute walks. Every entry in each of them
 * carries a `sourceRegex` that gets `new RegExp()`'d PER REQUEST with no try/catch. */
const ROUTE_GRAPH_BUCKETS = [
  "beforeMiddleware",
  "beforeFiles",
  "afterFiles",
  "dynamicRoutes",
  "onMatch",
  "fallback",
] as const;

/**
 * N40. Validate a parsed routing manifest AT BOOT and throw on anything unusable.
 *
 * Two failure modes this closes, both of which used to become a per-request 500 with a pod
 * that stays Ready forever (so nothing evicts it and the blue/green health gate passes):
 *
 *  1. A structurally wrong manifest (an empty file, a half-written mount, a hand-edited
 *     ConfigMap) was consumed by a bare `JSON.parse` and only failed later, deep inside
 *     resolveRoutes, on the first request.
 *  2. A route `sourceRegex` the SERVING V8 rejects. `@next/routing`'s matchRoute does
 *     `new RegExp(entry.sourceRegex)` with NO try/catch — unlike compileMatcherRegex above,
 *     which has an explicit fail-safe for exactly this build-machine/serving-runtime skew
 *     (the `(?i:)`-on-older-Node incident). One such route therefore throws on EVERY request
 *     inside resolveRoutes → the routing service's catch → `failOpen === false` whenever the
 *     app has middleware → 500 on everything, while `/healthz` keeps answering 200.
 *
 * Throwing here puts the failure where the startup path already puts a missing TLS identity
 * and a missing middleware module: at deploy time, in front of the readiness gate.
 */
export function assertValidRoutingManifest(parsed: unknown, source: string): void {
  const fail = (detail: string): never => {
    throw new Error(
      `Invalid routing manifest at ${source}: ${detail}. Refusing to start — an unusable ` +
        `manifest fails per REQUEST (deep inside resolveRoutes) while /healthz keeps ` +
        `answering 200, so nothing would evict the pod.`,
    );
  };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }
  const m = parsed as Record<string, unknown>;
  if (typeof m.buildId !== "string" || m.buildId.length === 0) {
    fail("`buildId` must be a non-empty string");
  }
  if (typeof m.basePath !== "string") fail('`basePath` must be a string ("" when unset)');
  if (!Array.isArray(m.pathnames) || m.pathnames.some((p) => typeof p !== "string")) {
    fail("`pathnames` must be an array of strings");
  }
  for (const key of ["poolAssignments", "pprRoutes"]) {
    const value = m[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(`\`${key}\` must be an object`);
    }
  }
  const routeGraph = m.routeGraph;
  if (!routeGraph || typeof routeGraph !== "object" || Array.isArray(routeGraph)) {
    fail("`routeGraph` must be an object");
  }
  const graph = routeGraph as Record<string, unknown>;
  for (const bucket of ROUTE_GRAPH_BUCKETS) {
    const entries = graph[bucket];
    if (entries === undefined) fail(`\`routeGraph.${bucket}\` is missing`);
    if (!Array.isArray(entries)) fail(`\`routeGraph.${bucket}\` must be an array`);
    (entries as unknown[]).forEach((entry, i) => {
      const at = `routeGraph.${bucket}[${i}]`;
      if (!entry || typeof entry !== "object") fail(`\`${at}\` must be an object`);
      const sourceRegex = (entry as Record<string, unknown>).sourceRegex;
      if (typeof sourceRegex !== "string") fail(`\`${at}.sourceRegex\` must be a string`);
      try {
        new RegExp(sourceRegex as string);
      } catch (err) {
        fail(
          `\`${at}.sourceRegex\` does not compile in this runtime: ` +
            `${JSON.stringify(sourceRegex)} — ` +
            `${err instanceof Error ? err.message : String(err)}. This usually means the ` +
            `build machine's Node/V8 accepts syntax the serving runtime does not (e.g. ` +
            `inline-flag groups like "(?i:)" on an older Node). @next/routing's matchRoute ` +
            `compiles this per request with no try/catch`,
        );
      }
    });
  }
  // Middleware matchers are deliberately NOT fatal: compileMatcherRegex treats an
  // uncompilable matcher as MATCHED (middleware runs for everything), which is degraded but
  // never a bypass — turning that documented fail-safe into a crash would convert a working
  // deploy into a failed one. Warn loudly at boot so it is visible before the first request.
  const middleware = m.middleware as { matchers?: unknown } | null | undefined;
  if (middleware && Array.isArray(middleware.matchers)) {
    for (const matcher of middleware.matchers as { regexp?: unknown }[]) {
      if (typeof matcher?.regexp !== "string") continue;
      try {
        new RegExp(matcher.regexp);
      } catch (err) {
        console.warn(
          `[adapter-k8s] routing manifest (${source}): middleware matcher regexp does not ` +
            `compile in this runtime — middleware will run for EVERY request (fail-safe): ` +
            `${JSON.stringify(matcher.regexp)} — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

// Upstream Next normalizes repeated slashes in the request path with a 308 to
// the collapsed path (query preserved). Returns the redirect target, or null
// when the path is already normal.
export function collapseSlashesRedirect(url: URL): URL | null {
  if (!/\/{2,}/.test(url.pathname)) return null;
  const out = new URL(url.toString());
  out.pathname = url.pathname.replace(/\/{2,}/g, "/");
  return out;
}

// A dynamic-route match (e.g. "/[id]") must not shadow a concrete prerendered
// output for the request path — upstream serves the prerender. Outputs are
// keyed by DECODED pathname ("/sticks & stones") while requests arrive encoded
// ("/sticks%20%26%20stones"), so try the decoded form too. Returns the concrete
// output pathname, or undefined to keep the resolver's own result.
export function preferConcreteOutput(
  requestPathname: string,
  resolvedPathname: string,
  poolAssignments: Record<string, string>,
): string | undefined {
  if (poolAssignments[resolvedPathname]) {
    // The resolver's result is itself a known output; only override when it is
    // a dynamic template and a concrete output exists for the request path.
    if (!resolvedPathname.includes("[")) return undefined;
  }
  const candidates = trailingSlashVariants(requestPathname);
  try {
    const decoded = decodeURIComponent(requestPathname);
    if (decoded !== requestPathname) candidates.push(...trailingSlashVariants(decoded));
  } catch {
    // malformed escape — leave as-is
  }
  for (const c of new Set(candidates)) {
    if (c !== resolvedPathname && poolAssignments[c]) return c;
  }
  return undefined;
}

// Map a matched pathname to the key outputs are actually registered under.
// Two shape mismatches arise with trailingSlash: true — requests carry a
// trailing slash while outputs are keyed without one, and the root page is
// keyed "/index" rather than "/". Only remaps when the remapped key actually
// exists, so locale-prefixed pathnames and exact matches pass through.
export function normalizeMatchedPathname(
  pathname: string,
  poolAssignments: Record<string, string>,
): string {
  if (poolAssignments[pathname]) return pathname;
  for (const v of trailingSlashVariants(pathname)) {
    if (poolAssignments[v]) return v;
  }
  if (pathname === "/" && poolAssignments["/index"]) return "/index";
  return pathname;
}

/**
 * Resolve the OUTPUT key (x-output-id / matchedPathname) for a completed resolution: normalize
 * the resolver's pathname to a registered output key, then let a concrete prerendered output win
 * over a dynamic template. Shared by BOTH resolvers.
 *
 * DRIFT FIXED (this was two copies, one of them wrong): the pool (Phase 1) consulted the
 * INVOCATION TARGET first and suppressed the public-path preference for rewritten requests,
 * while the ext_proc edge (Phase 2) only ever consulted the public request pathname. For a
 * non-rewritten request the two are identical (targetPathname === requestPathname), so the edge
 * looked correct; for a rewritten one it dispatched the dynamic template instead of the concrete
 * page. Phase 1's shape is the empirically verified one and is what this function implements.
 */
export function resolveOutputPathname(args: {
  /** Prepared (locale-prefixed) PUBLIC request pathname — `prepareRequest().url.pathname`. */
  requestPathname: string;
  resolvedPathname: string | undefined;
  invocationTargetPathname: string | undefined;
  poolAssignments: Record<string, string>;
}): string {
  const matchedPathname = args.invocationTargetPathname ?? args.requestPathname;
  // (`resolvedPathname ?? matchedPathname` — matchedPathname already falls back through
  // invocationTarget.pathname to the request pathname, so the original three-way chain
  // `resolvedPathname ?? invocationTarget?.pathname ?? matchedPathname` is the same value.)
  const base = normalizeMatchedPathname(
    args.resolvedPathname ?? matchedPathname,
    args.poolAssignments,
  );
  // Concrete outputs win over dynamic templates (decoded lookup). Check the
  // invocation target first: a rewrite to a concrete page (`/rewrite-1` ->
  // `/gssp`) makes @next/routing report resolvedPathname `/[slug]` (the
  // rewrite destination also matches the dynamic route) with an
  // invocationTarget of `/gssp` — the real page. Preferring the concrete
  // output for the target routes to `/gssp` instead of the `[slug]` handler.
  // Fall back to the original request path for the non-rewrite case.
  const concreteInvocationOutput = preferConcreteOutput(
    matchedPathname,
    base,
    args.poolAssignments,
  );
  // Only consult the public request pathname when routing did not rewrite
  // it. A beforeFiles rewrite is allowed to override a real filesystem
  // sibling (`/featured` -> `/some-team`); preferring `/featured` here
  // would silently undo that rewrite. When the invocation target differs,
  // it is authoritative even if it ultimately resolves through a dynamic
  // handler template.
  const requestWasRewritten = matchedPathname !== args.requestPathname;
  return (
    concreteInvocationOutput ??
    (!requestWasRewritten
      ? preferConcreteOutput(args.requestPathname, base, args.poolAssignments)
      : undefined) ??
    base
  );
}

export interface RscConfig {
  header: string;
  suffix: string;
  prefetchSegmentHeader?: string;
  prefetchSegmentDirSuffix?: string;
  prefetchSegmentSuffix?: string;
}

// Map a resolved pathname to its RSC output variant when the request is an RSC request.
// resolveRoutes returns the base pathname (e.g. /page); the handler must be dispatched to the
// .rsc output (e.g. /page.rsc) so it returns a flight payload instead of HTML, and to the
// segment-prefetch output for a partial-tree prefetch. Returns the input unchanged when the
// request isn't RSC or no matching output exists. Pool assignment is unaffected — the .rsc
// output lives in the same pool as its page — so callers look up the pool on the BASE
// pathname and only use this result for the output id (x-output-id).
// Inverse of resolveRscOutput: candidates for the parent page of an RSC output id
// (e.g. "/page.rsc" → "/page", "/index.segments/_tree.segment.rsc" → "/", "/index.rsc" → "/").
// Prerendered RSC variants have no handler of their own — the parent page handler
// serves the flight payload (the rsc request headers drive content negotiation).
export function rscParentCandidates(pathname: string, rsc: RscConfig | undefined): string[] {
  if (!rsc) return [];
  const fromBase = (base: string): string[] => (base === "/index" ? ["/", base] : [base]);
  if (rsc.prefetchSegmentDirSuffix) {
    const i = pathname.indexOf(`${rsc.prefetchSegmentDirSuffix}/`);
    if (i !== -1) return fromBase(pathname.slice(0, i) || "/");
  }
  if (rsc.suffix && pathname.endsWith(rsc.suffix)) {
    return fromBase(pathname.slice(0, -rsc.suffix.length) || "/");
  }
  return [];
}

/**
 * Is this an RSC (flight) request? Exactly `=== "1"` on the manifest's negotiation header,
 * matching upstream `isRSCRequestHeader`. Both resolvers gate rewrite-signal emission and
 * invocation-target derivation on this, and both used to re-derive it inline.
 */
export function isRscRequest(headers: Headers, rscConfig: RscConfig | undefined): boolean {
  return rscConfig ? headers.get(rscConfig.header) === "1" : false;
}

export function resolveRscOutput(
  matchedPathname: string,
  headers: Headers,
  rscConfig: RscConfig | undefined,
  poolAssignments: Record<string, string>,
): string {
  // `!rscConfig` is redundant with isRscRequest but narrows the type for the body below.
  if (!rscConfig || !isRscRequest(headers, rscConfig)) return matchedPathname;

  const basePath = matchedPathname === "/" ? "/index" : matchedPathname;

  // Segment prefetch (a specific RSC segment) takes precedence over the whole-page .rsc.
  if (rscConfig.prefetchSegmentHeader) {
    const segmentPrefetch = headers.get(rscConfig.prefetchSegmentHeader);
    if (segmentPrefetch && segmentPrefetch.length > 0) {
      const normalized = segmentPrefetch.replace(/^\/+/, "");
      const candidate = `${basePath}${rscConfig.prefetchSegmentDirSuffix ?? ""}/${normalized}${rscConfig.prefetchSegmentSuffix ?? ""}`;
      if (poolAssignments[candidate]) return candidate;
    }
  }

  const rscCandidate = `${basePath}${rscConfig.suffix}`;
  if (poolAssignments[rscCandidate]) return rscCandidate;

  return matchedPathname;
}

// --- Rewrite invocation target (shared) ---------------------------------------
// A middleware/next.config rewrite changes the route the HANDLER must run as
// (pathname and/or query) while the public request URL is preserved for the
// client — and preserved all the way into the entrypoint, which reads it as
// req.url / router.asPath / usePathname. The invocation target therefore travels
// as request METADATA, never as the loopback request URL. Both resolvers must
// derive the same internal invocation target:
// Phase 1 (pool-server/resolve.ts) attaches it to the local resolution as
// invokePath/invocationQuery; Phase 2 (routing-service/handler.ts) transports
// it over the trusted dispatch headers x-invoke-path/x-invoke-query. These
// helpers are the single derivation for both; the behaviors they pin
// (URLSearchParams.set collapse restoration, nxtP/_rsc filtering, sentinel
// handling) are documented on each function.

/** Drop @next/routing internal capture params (dynamic-route captures nxtP*, the
 * RSC union query _rsc) so they don't leak into handler URLs or client-facing
 * rewrite headers. */
export function filterInternalQuery(
  query: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | undefined {
  if (!query) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(query)) {
    if (k.startsWith("nxtP") || k === "_rsc") continue;
    const values = Array.isArray(v) ? v : [v];
    // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with
    if (values.some((value) => /^\$nxtP/.test(value))) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Drop @next/routing captures whose value is still the unresolved-dynamic SENTINEL
 * (`$nxtP<param>`) — the same artifact filterInternalQuery removes from a query and
 * computeRewriteInvocation / computeRewriteSignalHeaders refuse to put in a path. Entries are
 * removed by VALUE, so every alias of one unresolved capture (@next/routing emits both the
 * positional `"1"` and the named `nxtPslug`) goes together; an all-sentinel map becomes null.
 *
 * CALLED BY BOTH TIERS (pool-server/resolve.ts Phase 1, routing-service/handler.ts Phase 2).
 * Phase 2 previously stamped `x-route-matches` unsanitized and relied entirely on
 * pool-server/dispatch.ts extractRouteParams re-filtering per value at the far end. That
 * compensation is real and complete today — it is pinned in
 * tests/pool-server/route-matches-sanitization.test.ts — but it made the invariant depend on a
 * consumer two hops away, and two OTHER consumers already read routeMatches raw (dispatch.ts
 * forwards it verbatim as requestMeta.routeMatches, and the edge-param path reads
 * `resolution.routeMatches?.[key]` for the nxtP transport query). Sanitizing at the source is
 * what makes those safe by construction rather than by coincidence.
 *
 * The test is `/^\$nxtP/`, matching filterInternalQuery above and dispatch.ts
 * extractRouteParams — one sentinel shape, three sites. (It was `/^\$nxtP[^/]*$/` while this
 * lived privately in resolve.ts, which kept `$nxtPslug/nested`; extractRouteParams dropped it
 * anyway, so no params change.)
 */
export function sanitizeRouteMatches(
  matches: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!matches) return null;
  const unresolvedValues = new Set(
    // RegExp.test retains the previous coercion behaviour at this trust boundary.
    // oxlint-disable-next-line unicorn/prefer-string-starts-ends-with
    Object.values(matches).filter((value) => /^\$nxtP/.test(value)),
  );
  if (unresolvedValues.size === 0) return matches;
  const sanitized = Object.fromEntries(
    Object.entries(matches).filter(([, value]) => !unresolvedValues.has(value)),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

export function mergeInvocationQuery(
  resolvedQuery: Record<string, string | string[]> | undefined,
  targetQuery: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | undefined {
  if (!resolvedQuery && !targetQuery) return undefined;
  return filterInternalQuery({ ...resolvedQuery, ...targetQuery });
}

/** Read a URL's search params into the resolved-query record shape, collapsing repeated keys
 * into a string[]. Inverse of buildQueryString; both express the one query representation the
 * dispatch protocol (x-invoke-query) and Next's request contract use. */
export function queryFromUrl(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const previous = query[key];
    query[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return query;
}

/** Serialize a resolved query (Record<string, string | string[]>) to a "?a=b&..."
 * string, preserving repeated keys. Empty → "". */
export function buildQueryString(query: Record<string, string | string[]> | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else params.append(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * @next/routing currently applies a rewrite destination with URLSearchParams.set(), which
 * collapses `?items=1&items=2` to the last value. Next's request contract exposes repeated
 * destination keys as string[], so reconstruct only keys that (a) are repeated in a rewrite
 * which matched this public pathname and (b) currently equal that rewrite's final value. The
 * latter guard prevents an unrelated matching rule from replacing middleware/user query data.
 */
export function restoreRepeatedRewriteQuery(
  requestUrl: URL,
  routes: ResolveRoutesParams["routes"],
  query: Record<string, string | string[]> | undefined,
): Record<string, string | string[]> | undefined {
  if (!query) return undefined;

  const out = { ...query };
  const candidates = [
    ...routes.beforeMiddleware,
    ...routes.beforeFiles,
    ...routes.afterFiles,
    ...routes.fallback,
  ];
  for (const route of candidates) {
    if (!route.destination || (route.status && route.status >= 300 && route.status < 400)) continue;
    let match: RegExpMatchArray | null = null;
    try {
      match = requestUrl.pathname.match(new RegExp(route.sourceRegex));
    } catch {
      continue;
    }
    if (!match) continue;

    let destination = route.destination;
    for (let index = 1; index < match.length; index++) {
      const value = match[index];
      if (value !== undefined) {
        destination = destination.replaceAll(`$${index}`, () => value);
      }
    }
    for (const [name, value] of Object.entries(match.groups ?? {})) {
      if (value !== undefined) destination = destination.replaceAll(`$${name}`, () => value);
    }
    const rawQuery = destination.split("?", 2)[1];
    if (!rawQuery) continue;
    const repeated = new Map<string, string[]>();
    for (const [key, value] of new URLSearchParams(rawQuery)) {
      const values = repeated.get(key) ?? [];
      values.push(value);
      repeated.set(key, values);
    }
    for (const [key, values] of repeated) {
      if (values.length > 1 && out[key] === values.at(-1)) out[key] = values;
    }
  }
  return out;
}

/**
 * Strip the locale prefix WE added internally (prefixRequestLocale) from an internal pathname.
 * Handlers and client-facing rewrite signals must see the unprefixed path, matching the
 * non-rewrite case and `next start`. No-op when no locale was auto-added, or when the path is
 * not under it. Was open-coded at three sites (invokePath derivation here, and both the
 * invokePath and x-nextjs-rewritten-path derivations in pool-server/resolve.ts).
 */
export function stripAddedLocale(pathname: string, addedLocale: string | null | undefined): string {
  if (!addedLocale) return pathname;
  const pfx = `/${addedLocale}`;
  if (pathname === pfx) return "/";
  if (pathname.startsWith(pfx + "/")) return pathname.slice(pfx.length);
  return pathname;
}

/**
 * Derive the internal handler-invocation target for a resolved route. Returns
 * invokePath (path+query string, locale-stripped) only when it differs from the
 * public request URL, and the merged invocation query record. RSC and Pages-data
 * requests intentionally get NO invokePath: their flight/JSON rendering already
 * resolved the right handler+params, and the client reconciles rewrites via the
 * x-nextjs-rewritten-path/-query (App) or x-nextjs-rewrite (Pages) response
 * headers instead. CALLED BY BOTH RESOLVERS (pool-server/resolve.ts Phase 1,
 * routing-service/handler.ts Phase 2) — there is deliberately no second copy to
 * keep in lockstep; the pool used to carry one and it is what made the rewrite
 * query semantics driftable. Don't reintroduce a private copy in either tier.
 */
export function computeRewriteInvocation(args: {
  originalUrl: URL;
  addedLocale: string | null;
  isRscRequest: boolean;
  isDataRequest: boolean;
  routes: ResolveRoutesParams["routes"];
  resolvedQuery: Record<string, string | string[]> | undefined;
  invocationTarget: { pathname?: string; query?: Record<string, string | string[]> } | undefined;
  resolvedPathname: string | undefined;
}): {
  invokePath: string | undefined;
  invocationQuery: Record<string, string | string[]> | undefined;
} {
  const invocationQuery = restoreRepeatedRewriteQuery(
    args.originalUrl,
    args.routes,
    mergeInvocationQuery(args.resolvedQuery, args.invocationTarget?.query),
  );
  let invokePath: string | undefined;
  const targetPathRaw = args.invocationTarget?.pathname ?? args.resolvedPathname;
  // An unmatched optional catch-all is represented internally as `/$nxtP<param>`.
  // It is a routing sentinel, never a handler URL.
  const hasUnresolvedDynamicSentinel =
    targetPathRaw?.includes("$nxtP") || /%24nxtP/i.test(targetPathRaw ?? "");
  if (targetPathRaw && !hasUnresolvedDynamicSentinel && !args.isRscRequest && !args.isDataRequest) {
    const targetPath = stripAddedLocale(targetPathRaw, args.addedLocale);
    const qs = buildQueryString(invocationQuery);
    const candidate = targetPath + qs;
    if (candidate !== args.originalUrl.pathname + args.originalUrl.search) invokePath = candidate;
  }
  return { invokePath, invocationQuery };
}

/**
 * N19. App Router rewrite signalling for the CLIENT: `x-nextjs-rewritten-path` /
 * `x-nextjs-rewritten-query`.
 *
 * These are BROWSER-FACING response headers, not internal dispatch vocabulary. The client
 * reads them straight off the `Response` object of its own RSC fetch — see upstream
 * `packages/next/src/client/route-params.ts` (`getRenderedPathname` / `getRenderedSearch`,
 * `response.headers.get(NEXT_REWRITTEN_{PATH,QUERY}_HEADER)`), consumed by
 * `client/flight-data-helpers.ts` (`createInitialRSCPayloadFromFallbackPrerender`) and
 * `client/components/segment-cache/cache.ts`. Without them the router's URL state and its
 * parsed client params stay on the ORIGINAL request path after a rewrite, and
 * `client/route-params.ts` explicitly names a wrong/missing header as the cause of a
 * segment-count mismatch. Next's routes-manifest even declares the two names to adapters
 * (`build/generate-routes-manifest.ts` → `rewriteHeaders.pathHeader/queryHeader`), which is
 * the contract this adapter is satisfying.
 *
 * Upstream emits them from TWO places, and the adapter replaces exactly one of them:
 *   • middleware rewrites — `server/web/adapter.ts` sets them on the middleware `Response`
 *     itself, so they arrive inside the middleware response headers both tiers already
 *     transport (Phase 2 via the secret-gated `x-resolved-headers` JSON). That is why the
 *     middleware case never looked broken at the edge.
 *   • next.config rewrites — `server/lib/router-utils/resolve-routes.ts` sets them in the
 *     router-server, which is precisely the layer this adapter replaces. Nothing re-emitted
 *     them at the ext_proc edge, so a config rewrite lost its client signalling on the
 *     PRODUCTION path while Phase 1 (pool-local resolution) emitted it correctly.
 *
 * RSC-only, mirroring both upstream sites (`isRSCRequest` / `isRSCRequestHeader` guards): a
 * document request re-renders under the rewritten route anyway and upstream sends nothing.
 * Each header is emitted only when its component actually changed against the public request
 * URL, again mirroring upstream (`requestURL.pathname !== destination.pathname` /
 * `requestURL.search !== destination.search`).
 *
 * CALLED BY BOTH RESOLVERS (pool-server/resolve.ts Phase 1, routing-service/handler.ts
 * Phase 2). Don't reintroduce a private copy in either tier — the Phase-2 gap this closes is
 * the same class of bug as the four private helper copies routing-common.ts was created for.
 */
export function computeRewriteSignalHeaders(args: {
  originalUrl: URL;
  addedLocale: string | null;
  isRscRequest: boolean;
  invocationTarget: { pathname?: string } | undefined;
  invocationQuery: Record<string, string | string[]> | undefined;
}): { rewrittenPath?: string; rewrittenQuery?: string } {
  const targetPathname = args.invocationTarget?.pathname;
  if (!args.isRscRequest || !targetPathname) return {};
  // An unmatched optional catch-all is represented internally as `/$nxtP<param>` (sometimes
  // percent-encoded). It is a routing sentinel, never a public URL — the same guard
  // computeRewriteInvocation applies to invokePath. Leaking it here would hand the client
  // router a pathname whose segment count does not match the route tree, which is exactly the
  // failure `client/route-params.ts` documents ("could happen if the x-nextjs-rewritten-path
  // header is incorrectly set").
  if (targetPathname.includes("$nxtP") || /%24nxtP/i.test(targetPathname)) return {};

  const rewrittenPath = stripAddedLocale(targetPathname, args.addedLocale);
  const rewrittenSearch = buildQueryString(args.invocationQuery);
  const signal: { rewrittenPath?: string; rewrittenQuery?: string } = {};
  if (rewrittenPath !== args.originalUrl.pathname) signal.rewrittenPath = rewrittenPath;
  // The header carries the query WITHOUT the leading "?" (upstream slices it off).
  if (rewrittenSearch !== args.originalUrl.search) {
    signal.rewrittenQuery = rewrittenSearch.replace(/^\?/, "");
  }
  return signal;
}

/** The two client-facing rewrite-signal header names, in one place so neither tier spells
 * them itself. Values come from upstream `client/components/app-router-headers.ts`
 * (NEXT_REWRITTEN_PATH_HEADER / NEXT_REWRITTEN_QUERY_HEADER) and are re-declared to adapters
 * in the routes manifest as `rewriteHeaders.pathHeader` / `.queryHeader`. */
export const REWRITTEN_PATH_HEADER = "x-nextjs-rewritten-path";
export const REWRITTEN_QUERY_HEADER = "x-nextjs-rewritten-query";

/** Apply a computeRewriteSignalHeaders() verdict onto a response-header set. Returns the
 * same Headers instance for chaining; a `{}` verdict is a no-op. */
export function applyRewriteSignalHeaders(
  headers: Headers,
  signal: { rewrittenPath?: string; rewrittenQuery?: string },
): Headers {
  if (signal.rewrittenPath !== undefined) headers.set(REWRITTEN_PATH_HEADER, signal.rewrittenPath);
  if (signal.rewrittenQuery !== undefined) {
    headers.set(REWRITTEN_QUERY_HEADER, signal.rewrittenQuery);
  }
  return headers;
}

/**
 * Serialize a Headers into the JSON object shape carried by the internal dispatch headers
 * (`x-resolved-headers`, `x-mw-request-headers`) and reconstructed by the pool's
 * `parseResolvedHeaders`. Returns null when there is nothing to carry, so a caller can skip
 * the header entirely.
 *
 * `Headers.entries()` folds repeated `Set-Cookie` into one comma-joined value, which is lossy
 * for cookies whose Expires attribute contains a comma — collect those through
 * `getSetCookie()` so each survives intact. This is ONE implementation on purpose: the edge
 * writes the wire value and the pool reads it, and the two shapes drifting is the same class
 * of bug routing-common.ts exists to prevent.
 */
export function serializeHeaderMap(headers: Headers): string | null {
  const obj: Record<string, string | string[]> = {};
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    obj[key] = value;
  }
  const cookies = headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) obj["set-cookie"] = cookies;
  if (Object.keys(obj).length === 0) return null;
  return JSON.stringify(obj);
}

/**
 * N15/N40. Did MIDDLEWARE author this response's `Location`?
 *
 * `@next/routing` surfaces a middleware redirect and a header-only next.config `redirects()`
 * rule in the SAME `status` + `resolvedHeaders.location` shape, so only the caller can tell
 * them apart — and the two must be treated differently (`normalizeResolvedRedirect` carries the
 * request query onto a rule redirect's query-less target, but a middleware target is
 * authoritative). The discriminator is deliberately NARROW: `middlewareResponse != null` is
 * true for a plain `NextResponse.next()`, and because a typical matcher covers `/(.*)` that made
 * the N15 query carry inert for every app with middleware (probed: `redirects()` lost `?foo=1`
 * from its Location on both tiers). A `location` header is precisely the condition under which
 * `responseToMiddlewareResult` produces `r.redirect` from the middleware response.
 */
export function middlewareAuthoredRedirect(
  middlewareResponse: Response | null | undefined,
): boolean {
  return middlewareResponse != null && middlewareResponse.headers.has("location");
}

// N9: the concrete route selected by routing may retain an i18n locale prefix while the
// executable template chosen for it does not carry that literal segment (a pool can hold
// only the unprefixed template — e.g. a multi-pool split). Handing the prefixed path to
// such a template makes the locale segment become the first catch-all param (`/` renders
// with slug ["en-US"]). Strip the locale in exactly that mismatch case.
export function localeAlignedRouteParamPathname(
  concretePathname: string,
  handlerPathname: string,
  i18nLocales: string[],
): string {
  const locale = i18nLocales.find(
    (l) => concretePathname === `/${l}` || concretePathname.startsWith(`/${l}/`),
  );
  if (!locale) return concretePathname;
  if (handlerPathname === `/${locale}` || handlerPathname.startsWith(`/${locale}/`)) {
    return concretePathname;
  }
  return concretePathname.slice(locale.length + 1) || "/";
}

// N10 (SECURITY). RFC 9110 origin-form: a request's authority comes from the Host
// header, NEVER from the request target. `new URL("//evil.example/x", base)` treats the
// target as a PROTOCOL-RELATIVE reference — it parses with host `evil.example` and
// pathname `/x`, so the pool served `/x`'s content under the request key
// `//evil.example/x` (CDN key/content confusion, cached `public, max-age=3600` with a
// deploy cache-tag) and emitted `Location: http://evil.example/x` for any rule-driven
// redirect — an OPEN REDIRECT. It also threw outright for a bare `//` (empty authority).
// Splicing the target after a validated authority keeps `//…` a PATH, so the shared
// repeated-slash 308 (collapseSlashesRedirect) normalizes it exactly as `next start`
// does, before any handler, cache key, or middleware sees it.
//
// COMMENT CORRECTION (N40): this used to claim "the routing-service tier already parsed this
// way (handler.ts) — the pool was the outlier". That was true only for the `//evil/x` PATH
// half. The edge spliced `:authority` VERBATIM into a template string and never ran the
// malformed-authority check below, so an authority of `evil.com/foo` injected attacker
// path segments into the URL that feeds detectDomainLocale, `has: { type: "host" }` matcher
// gating, and the redirect same-origin test. Both tiers now route through this function —
// which is the only way the claim can be true. (Envoy should reject such an `:authority`
// upstream, so the edge half is defense-in-depth; the false comment was the part that would
// have stopped the next reviewer from checking.)
// Throws (→ 400 at the call site) when the Host header is not a bare authority.
export function parseRequestUrl(target: string, hostHeader: string | undefined): URL {
  const base = new URL(`http://${hostHeader ?? "localhost"}`);
  // A Host carrying a path/query/fragment/userinfo ("foo/bar", "user@evil") is a
  // malformed authority: splicing it would inject attacker-controlled path segments.
  // Reject rather than guess.
  if (base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new Error("malformed Host header");
  }
  // This is an origin server, not a forward proxy. Accepting absolute-form here lets its
  // authority replace the validated Host/:authority value used by middleware, redirects, cache
  // keys, and dispatch proofs. Asterisk-form is not used by Next's request pipeline either.
  if (!target.startsWith("/")) throw new Error("request target must use origin-form");
  return new URL(`http://${base.host}${target}`);
}

// Pathname of a request target, safe for targets that `new URL(target, base)` would
// reject or misread as an authority ("//", "//evil.example/x"). Used by dispatch-level
// bookkeeping that only needs the path. See parseRequestUrl (N10).
export function requestTargetPathname(target: string): string {
  return parseRequestUrl(target, "localhost").pathname;
}

// --- RSC cache-busting search param (`_rsc`) — N18 (SECURITY) --------------------------
//
// The App Router client appends `_rsc=<hash of this request's RSC headers>` to every flight
// fetch, and upstream REFUSES to answer an RSC request whose `_rsc` doesn't match those
// headers. Upstream's own words (base-server.ts renderToResponseWithComponentsImpl):
//
//   "Not all CDNs respect the Vary header when caching. We must assume that only the URL is
//    used to vary the responses. The Next client computes a hash of the header values and
//    sends it as a search param. Before responding to a request, we must verify that the hash
//    matches the expected value. Neglecting to do this properly can lead to cache poisoning
//    attacks on certain CDNs."
//
// That check is guarded by `!this.minimalMode`, and this adapter invokes EVERY entrypoint in
// minimal mode — upstream's contract is that the PLATFORM does it instead. Nothing here did:
// `_rsc` only ever appeared as a param to strip (filterInternalQuery). The deployment shape is
// exactly the one upstream warns about (Cloud CDN in front of the pools), so the check belongs
// here. See `rscCacheBustingUnvalidated` for where it is enforced and why we do NOT 307.
//
// Inputs, join order, both encodings and the server-side normalization below are transcribed
// from Next 16.3.0-canary.84:
//   packages/next/src/shared/lib/router/utils/cache-busting-search-param.ts
//     (createCacheBustingSearchParamInput / computeCacheBustingSearchParam /
//      computeLegacyCacheBustingSearchParam)
//   packages/next/src/server/base-server.ts ~L2080-2158 (the caller's header normalization)
//   packages/next/src/client/components/router-reducer/set-cache-busting-search-param.ts
//     (the CLIENT side — same two functions, so both ends agree by construction)
// The identical code ships compiled in 16.2.10 (dist/server/base-server.js ~L1195) with ONE
// difference, noted on `normalizeRscPrefetchHeader`.
//
// Ground truth: every value here was verified against a live `next start`
// (16.3.0-canary.84, `experimental.validateRSCRequestHeaders: true`) over 13 header tuples —
// see tests/routing-common.rsc-cache-busting.test.ts for the recorded table.

/** Next's `NEXT_RSC_UNION_QUERY` (client/components/app-router-headers.ts). */
export const RSC_CACHE_BUSTING_QUERY = "_rsc";
/** Next's `RSC_HEADER`. Overridable per build via the routing manifest's `rsc.header`. */
export const RSC_REQUEST_HEADER = "rsc";
/**
 * The four header values the `_rsc` hash is computed over, in Next's argument order. These are
 * exactly `NEXTJS_VARY_HEADERS` (emit/templates/gcp-http-filter.ts) minus `RSC` itself, which
 * is the negotiation flag rather than a hash input — the two lists must stay in step: a header
 * that varies the response but is neither in the CDN cache key nor in this hash is a poisoning
 * primitive.
 */
export const RSC_ROUTER_PREFETCH_HEADER = "next-router-prefetch";
export const RSC_ROUTER_SEGMENT_PREFETCH_HEADER = "next-router-segment-prefetch";
export const RSC_ROUTER_STATE_TREE_HEADER = "next-router-state-tree";
export const RSC_NEXT_URL_HEADER = "next-url";

/** Node's `IncomingMessage.headers` value shape; `Headers.get` narrows to `string | null`. */
type RscHeaderValue = string | string[] | undefined;

/**
 * Only `'1' | '2' | '3'` are recognized; every other value (including the `string[]` a
 * repeated header produces) is STRIPPED and hashes as if the header were absent — so
 * `next-router-prefetch: 9` yields the same hash as no prefetch header at all.
 *
 * Next 16.2.x recognizes only `'1' | '2'`; `'3'` (runtime segment prefetch) is emitted only by
 * a 16.3+ client, which is bundled with — and therefore only ever talks to — a 16.3+ server.
 * Recognizing all three is a strict superset with no false rejection on either version.
 */
function normalizeRscPrefetchHeader(value: RscHeaderValue): "1" | "2" | "3" | undefined {
  if (value === undefined) return undefined;
  return value === "1" || value === "2" || value === "3" ? value : undefined;
}

/** Next's `normalizeCacheBustingInput`: absent ⇒ `"0"`, repeated ⇒ comma-joined. */
function normalizeRscCacheBustingInput(value: RscHeaderValue): string {
  if (value === undefined) return "0";
  return Array.isArray(value) ? value.join(",") : value;
}

/**
 * Next's `createCacheBustingSearchParamInput`. Returns null — meaning "the expected `_rsc` is
 * the EMPTY string", i.e. the client must send the bare `?_rsc` form — when none of the four
 * inputs is present. Note the asymmetry, which is upstream's and must be preserved: a prefetch
 * value of `"0"` counts as absent, while an EMPTY-STRING state tree / next-url counts as
 * PRESENT (`=== undefined` is the presence test, not truthiness).
 */
function rscCacheBustingInput(
  prefetch: "1" | "2" | "3" | "0" | undefined,
  segmentPrefetch: RscHeaderValue,
  stateTree: RscHeaderValue,
  nextUrl: RscHeaderValue,
): string | null {
  if (
    (prefetch === undefined || prefetch === "0") &&
    segmentPrefetch === undefined &&
    stateTree === undefined &&
    nextUrl === undefined
  ) {
    return null;
  }
  return [
    prefetch ?? "0",
    normalizeRscCacheBustingInput(segmentPrefetch),
    normalizeRscCacheBustingInput(stateTree),
    normalizeRscCacheBustingInput(nextUrl),
  ].join(",");
}

/**
 * Next's `computeCacheBustingSearchParam`: SHA-256 of the joined input, truncated to 96 bits,
 * base64url without padding (16 chars). Upstream uses `crypto.subtle.digest` + `btoa` +
 * `+/`→`-_` + strip `=`; `createHash(...).digest().subarray(0, 12).toString("base64url")`
 * produces byte-identical output SYNCHRONOUSLY, which matters because the pool must decide
 * cacheability inside a `writeHead` wrapper that cannot await.
 */
export function computeRscCacheBustingParam(
  prefetch: "1" | "2" | "3" | "0" | undefined,
  segmentPrefetch: RscHeaderValue,
  stateTree: RscHeaderValue,
  nextUrl: RscHeaderValue,
): string {
  const input = rscCacheBustingInput(prefetch, segmentPrefetch, stateTree, nextUrl);
  if (input === null) return "";
  return createHash("sha256").update(input, "utf8").digest().subarray(0, 12).toString("base64url");
}

/**
 * Next's `computeLegacyCacheBustingSearchParam`: djb2-xor 32-bit hash, base36, first 5 chars
 * (`shared/lib/hash.ts` `hexHash`). Clients without a secure context have no `crypto.subtle`
 * and send THIS shorter form; upstream accepts either, so we must too — rejecting it would
 * mark real traffic unvalidated. Transcribed arithmetic (the `& 0xffffffff` before the final
 * `>>> 0` is load-bearing).
 */
export function computeLegacyRscCacheBustingParam(
  prefetch: "1" | "2" | "3" | "0" | undefined,
  segmentPrefetch: RscHeaderValue,
  stateTree: RscHeaderValue,
  nextUrl: RscHeaderValue,
): string {
  const input = rscCacheBustingInput(prefetch, segmentPrefetch, stateTree, nextUrl);
  if (input === null) return "";
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(36).slice(0, 5);
}

export interface RscCacheBustingVerdict {
  /** The request carries the RSC negotiation header (`rsc: 1`) — nothing else is enforced. */
  isRscRequest: boolean;
  /** `_rsc` matches the hash of this request's RSC headers, in either the modern or legacy form. */
  validated: boolean;
  /** The value this request SHOULD carry. `""` means the bare `?_rsc` form (no value). */
  expected: string;
}

/**
 * Reproduce upstream's verdict for one request. `header` is a case-insensitive lookup over the
 * request's own headers (Node's lowercased `req.headers` record, or `Headers.get`).
 *
 * Deliberate fidelity notes:
 *  • RSC-ness is `value === '1'` exactly (`server/lib/is-rsc-request.ts` `isRSCRequestHeader`)
 *    — a repeated header (`string[]`) is NOT an RSC request.
 *  • `segmentPrefetch` uses `||`, not `??`, exactly as base-server does: an EMPTY-STRING
 *    `next-router-segment-prefetch` therefore hashes as ABSENT.
 *  • `actual` is read off the PUBLIC request URL. A missing `_rsc` reads as `null`, which never
 *    equals the empty-string expectation — so an RSC request with no `_rsc` at all is
 *    unvalidated, which is upstream's behavior (its own comment: "When no headers are present,
 *    expectedHash is empty string and client must send `_rsc` param").
 *  • base-server also falls back to `getRequestMeta(req, 'isPrefetchRSCRequest')` /
 *    `'segmentPrefetchRSCRequest'` when the headers are absent. Those metas are set ONLY by
 *    Next's own `.rsc` / `.segments` URL-suffix normalizers (base-server handleRSCRequest),
 *    which cannot fire here: this adapter never rewrites the public URL to an output suffix —
 *    it dispatches by `x-output-id` and leaves the client's URL and headers untouched. There is
 *    no adapter tier that strips these headers either, so the header IS the whole input.
 */
export function validateRscCacheBustingParam(args: {
  header: (name: string) => RscHeaderValue;
  searchParams: URLSearchParams;
  rsc?: RscConfig | undefined;
}): RscCacheBustingVerdict {
  // Manifest-supplied names are lowercased before lookup: the pool reads Node's `req.headers`
  // record, whose keys are always lowercase, so a `RSC`-cased manifest value would miss.
  const rscHeader = args.header((args.rsc?.header ?? RSC_REQUEST_HEADER).toLowerCase());
  if (rscHeader !== "1") return { isRscRequest: false, validated: true, expected: "" };

  const prefetch = normalizeRscPrefetchHeader(args.header(RSC_ROUTER_PREFETCH_HEADER));
  const segmentPrefetch =
    args.header(
      (args.rsc?.prefetchSegmentHeader ?? RSC_ROUTER_SEGMENT_PREFETCH_HEADER).toLowerCase(),
    ) || undefined;
  const stateTree = args.header(RSC_ROUTER_STATE_TREE_HEADER);
  const nextUrl = args.header(RSC_NEXT_URL_HEADER);

  const expected = computeRscCacheBustingParam(prefetch, segmentPrefetch, stateTree, nextUrl);
  const actual = args.searchParams.get(RSC_CACHE_BUSTING_QUERY);
  let validated = expected === actual;
  if (!validated && actual !== null) {
    validated =
      computeLegacyRscCacheBustingParam(prefetch, segmentPrefetch, stateTree, nextUrl) === actual;
  }
  return { isRscRequest: true, validated, expected };
}

/**
 * True when this request is an RSC request whose `_rsc` does NOT authenticate its RSC headers —
 * i.e. its response MUST NOT be storable by a shared cache. Both tiers call this; keeping the
 * derivation here is the point of routing-common.ts (a drift between tiers would either poison
 * a cache or break real traffic).
 *
 * FAIL-SAFE CHOICE (deliberate divergence from `next start`, which answers 307). We make the
 * response UNCACHEABLE instead of redirecting:
 *  1. Upstream's own gate is `experimental.validateRSCRequestHeaders`, which defaults to FALSE
 *     on stable 16.2.x (`!!(process.env.__NEXT_TEST_MODE || !isStableBuild())`) and TRUE on
 *     16.3 canary. That flag is not carried in the routing manifest, so an unconditional 307
 *     would diverge from `next start` for every 16.2.x app the adapter supports.
 *  2. A 307 is an availability risk with a redirect-loop failure mode — upstream guards its own
 *     404 case for exactly that reason. Any future tier that adds/strips one of the four inputs,
 *     or any change to the input tuple, would turn REAL traffic into a loop. A wrong hash input
 *     is worse than no check.
 *  3. Cache poisoning requires STORAGE. `no-store` closes the entire class at zero availability
 *     cost: the request is still answered 200 with correct content for its own headers, it just
 *     cannot be stored under a URL another header set would resolve to.
 * Errors computing the hash cannot make a request look validated (see the callers): the unsafe
 * direction is "validated", so anything unexpected lands on "unvalidated ⇒ uncacheable", which
 * costs cache hit rate and never correctness.
 */
export function rscCacheBustingUnvalidated(args: {
  header: (name: string) => RscHeaderValue;
  searchParams: URLSearchParams;
  rsc?: RscConfig | undefined;
}): boolean {
  try {
    const verdict = validateRscCacheBustingParam(args);
    return verdict.isRscRequest && !verdict.validated;
  } catch {
    // Unknown Next shape / unavailable digest ⇒ treat as unvalidated. Uncacheable is the only
    // direction that cannot poison a shared cache.
    return true;
  }
}

// Keep the established routing-common export as a function declaration. The tier-parity guard
// audits this declaration, while the implementation now lives in the dependency-light module
// that cdn-tags can use without pulling @next/routing into build-time code.
export function grantsSharedCacheFreshness(cacheControl: string): boolean {
  return grantsSharedCacheFreshnessFromCacheControl(cacheControl);
}

export {
  hasUnqualifiedCacheControlDirective,
  parseCacheControlDirectives,
  type CacheControlDirective,
} from "./cache-control.js";
