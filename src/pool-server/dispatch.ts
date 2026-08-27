// src/pool-server/dispatch.ts
import { createServer, request as httpRequest } from "node:http";
import { createReadStream, readFileSync, existsSync, statSync } from "node:fs";
import { pipeline } from "node:stream";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { splitCookiesString } from "next/dist/server/web/utils.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HandlerLoader } from "./handler-loader.js";
import type { ResolveResult } from "./resolve.js";
import type { StaticAssetEntry } from "../types.js";
import {
  INTERNAL_EXECUTION_DEADLINE_HEADER,
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_SECRET_HEADER,
  computeDispatchProof,
  dispatchProofInputsFromRequest,
  timingSafeStringEqual,
  localeAlignedRouteParamPathname,
  queryFromUrl,
  requestTargetPathname,
  rscParentCandidates,
  stripBasePath,
  templateOutputCandidates,
  trailingSlashVariants,
  type RscConfig,
} from "../routing-common.js";
import { cdnCacheTag } from "../cdn-tags.js";
import {
  ifNoneMatchMatches,
  STATIC_STREAM_THRESHOLD_BYTES,
  staticAssetEtagForFileAsync,
} from "./http-cache.js";
// The pool-server bundle is esbuild-bundled, so cross-importing the emit-side sanitizer
// is fine — and REQUIRED: this module previously carried a local copy that stripped
// trailing hyphens BEFORE truncating to 63 chars, so a >63-char name with a hyphen at
// the cut kept its trailing hyphen → invalid DNS hostname → cross-pool proxy dial
// failure. The emit version truncates first, then strips, so it can't regress that.
import { sanitizeK8sName } from "../emit/templates/utils.js";

const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");

// The request body buffered under Next's request-meta symbol (set by the action-body
// buffering upstream), if any.
function bufferedActionBody(req: IncomingMessage): Buffer | undefined {
  return (req as IncomingMessage & { [NEXT_REQUEST_META]?: { actionBody?: Buffer } })[
    NEXT_REQUEST_META
  ]?.actionBody;
}

function toNodeHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "undefined") continue;
    headers[key] = value;
  }
  return headers;
}

// Next's BaseServer preserves the public authority before a generated entrypoint can forward a
// Server Action to another worker. The pool invokes entrypoints directly, so it must supply that
// missing parity step itself. Node fetch replaces Host with __NEXT_PRIVATE_ORIGIN's loopback
// authority on the worker hop; x-forwarded-host is the value Next's CSRF check deliberately keeps.
// Missing-only matches upstream and preserves an ingress- or middleware-supplied public host.
function preserveServerActionAuthority(req: IncomingMessage): void {
  if (req.headers["next-action"] === undefined) return;
  if (req.headers["x-forwarded-host"] !== undefined) return;
  if (typeof req.headers.host === "string" && req.headers.host.length > 0) {
    req.headers["x-forwarded-host"] = req.headers.host;
  }
}

// Convert a web `Headers` to a Node headers object, preserving multiple Set-Cookie
// values as an array. `Headers.entries()` collapses repeated Set-Cookie into a single
// comma-joined string, which would drop all but the last cookie once written to a client.
function webHeadersToNodeHeaders(webHeaders: Headers): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of webHeaders.entries()) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") continue;
    // N39: Next transports cache tags between an entrypoint and the incremental cache in this
    // header. It is internal bookkeeping, it exposes route/tag structure, and `next start` removes
    // it before the public response. writeInnerResponse and the manifest serve each deleted it
    // with an explicit "never forward it to clients" comment, but EVERY web-`Response` boundary —
    // edge routes, `Response`-returning handlers, render404/renderError, rule/middleware redirects
    // and middleware-authored bodies — passed it through. One rule, at the single conversion point
    // all of them share.
    if (lower === "x-next-cache-tags") continue;
    headers[key] = value;
  }
  const setCookies = webHeaders
    .getSetCookie()
    .flatMap((maybeCompoundCookie) => splitCookiesString(maybeCompoundCookie));
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  return headers;
}

// Client-supplied forwarding headers are only a hint. x-forwarded-host is honored solely when it
// is a plain host[:port] token — anything else (URL syntax, whitespace, empty) falls back to the
// Host header so a malformed value can neither throw during URL construction nor smuggle an
// attacker-chosen origin into the relative-vs-absolute Location comparison below.
const FORWARDED_HOST_RE = /^[a-zA-Z0-9.-]+(:[0-9]{1,5})?$/;

// The client's real scheme as witnessed by x-forwarded-proto, or undefined when the header is
// absent or carries anything other than one of the two real schemes (e.g. a spoofed
// `javascript:`). Exported so websocket-upgrade.ts derives the handshake's same-origin authority
// from the same witness this file uses — an https site behind the TLS-terminating load balancer
// must compare a browser's `Origin: https://…` against `https://…`, not against the plain-http
// scheme of the pool's own socket.
//
// S25. The LEFTMOST value wins, and pinning that down is the whole reason the parse is
// centralized here. Both supported topologies OVERWRITE, so a single element is what actually
// arrives and every reading of it is byte-identical; element order only decides what happens in a
// topology that APPENDS, and there the leftmost element is the client-facing one:
//   • RFC 7239 §4 — the standardized form of this field, and the equivalent MDN points at —
//     orders its element list client-first, so the `proto` of the connection the client actually
//     made is the FIRST element. De-facto `x-forwarded-proto` follows the `X-Forwarded-For`
//     convention it was cloned from, which is client-first for the same reason: each proxy
//     appends what it saw on the connection IT received. The hop that terminates TLS is the
//     OUTERMOST one, so it contributes the LEFTMOST element, while an appending intermediary
//     between it and this pool saw the already-decrypted plaintext leg and contributes the
//     rightmost. "The last hop to write it" and "the trusted edge" are therefore opposite ends of
//     an appended chain — reading the rightmost element derives `http` for an https site behind a
//     TLS-terminating outer LB, which is a 403 on every browser `wss://` handshake against the
//     app's own origin (webSocketRequestAuthority), an `http://` initURL, and a same-origin
//     middleware redirect emitted absolute with the wrong scheme.
//   • Leftmost is also what the ecosystem reads and what operators configure against: Express's
//     `req.protocol` takes the substring before the first comma.
//
// What a leftmost read gives up is a client PREPENDING an element of its own in an appending
// topology (client sends `https`, a hop appends `http`, leftmost → https). That buys an attacker
// nothing reachable. The value is load-bearing only for this request's own derived scheme, and
// the single security decision it feeds — websocket-upgrade.ts's same-origin `Origin` check —
// exists to stop a hostile WEB PAGE, which cannot put a request header on a WebSocket handshake
// at all (the browser WebSocket API admits no custom headers) and cannot get one past CORS
// preflight elsewhere. A non-browser client is not constrained by `Origin` in the first place, so
// moving the scheme gains it nothing either. An unreachable spoof does not justify a permanent
// 403 for a legitimate topology, so the fail-safe direction here is the ecosystem's ordering.
//
// Both EMITTED topologies overwrite, which is why any of this is only a requirement on
// operator-supplied ingress (docs/targets.md):
//   • Generic provider (Envoy Gateway / the emitted Envoy in front of the pool): Envoy's HCM
//     documents that downstream `x-forwarded-proto` headers are trusted only when
//     `xff_num_trusted_hops` is non-zero, and that when it is zero the downstream
//     `x-forwarded-proto` and `:scheme` are SET from whether the downstream connection is TLS.
//     Nothing the adapter emits configures that knob (see client-traffic-policy.ts: the only
//     ClientTrafficPolicy knob emitted is escapedSlashesAction) and integration/envoy.yaml sets
//     no XFF knob either, so the zero default applies and Envoy overwrites with a single value.
//   • GKE / GXLB: the load-balancer header documentation is explicit that X-Forwarded-For is
//     appended to and specifies X-Forwarded-Proto as a single `[http | https]` value, but it does
//     NOT state overwrite-vs-append for it. That is the same gap routing-common.ts's
//     PROOF_COVERED_CONTEXT_HEADERS operational note already records for this header.
//
// A garbage leftmost element yields undefined rather than falling further right: junk in the
// client-facing position means there is no witness, and an https site must not be derived from a
// hop that only ever saw the plaintext leg. Empty elements are skipped (no hop writes an empty
// scheme). Comparison is case-insensitive because URI schemes are (RFC 3986 §3.1) and treating
// `HTTPS` as unknown silently downgrades the derived scheme; it grants nothing extra, since a
// client that can write `HTTPS` can write `https`. The proof binds the RAW wire bytes
// (routing-common.ts), so none of this parsing is part of the covered value.
//
// One asymmetry no reading here can fix, which docs/targets.md states as the operator
// requirement instead: Next's own base-server derives `isHttps` from
// `xForwardedProto === "https"` — an EXACT single value (node_modules/next/dist/server/
// base-server.js) — so on ANY comma-joined chain Next itself reads http regardless of which
// element this picks. A multi-valued chain is a misconfigured ingress for the whole app, not
// just for this witness.
export function validatedForwardedProtocol(req: IncomingMessage): "http" | "https" | undefined {
  const forwardedProto = req.headers["x-forwarded-proto"];
  // Repeated header instances are semantically one comma-joined list (RFC 9110 §5.3). Node
  // already joins them for this field; joining an array shape too keeps both identical.
  const chain = Array.isArray(forwardedProto) ? forwardedProto.join(",") : forwardedProto;
  if (!chain) return undefined;
  for (const element of chain.split(",")) {
    const value = element.trim().toLowerCase();
    if (!value) continue;
    return value === "https" || value === "http" ? value : undefined;
  }
  return undefined;
}

// Effective public scheme of a request that reached this pool. TLS terminates at the load
// balancer (GXLB) which stamps x-forwarded-proto, so the pool's own socket is always plain
// http — the forwarded value is the only witness of the client's real scheme.
function requestProtocol(req: IncomingMessage): "http" | "https" {
  return validatedForwardedProtocol(req) ?? "http";
}

function middlewareRedirectLocation(req: IncomingMessage, target: URL): string {
  const forwardedHost = req.headers["x-forwarded-host"];
  const forwardedHostValue = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost;
  const host =
    (forwardedHostValue && FORWARDED_HOST_RE.test(forwardedHostValue)
      ? forwardedHostValue
      : undefined) ??
    req.headers.host ??
    "localhost";
  const protocol = requestProtocol(req);
  try {
    const requestOrigin = new URL(`${protocol}://${host}`).origin;
    return target.origin === requestOrigin
      ? `${target.pathname}${target.search}${target.hash}`
      : target.toString();
  } catch {
    // The port group above admits out-of-range ports (e.g. :99999), which the URL parser
    // rejects. A bad forwarded value must never turn a middleware redirect into a 500 —
    // the absolute target is always a valid Location.
    return target.toString();
  }
}

// Constant-time string compare. The canonical implementation lives in routing-common.ts
// (it is also the proof verifier's compare); re-exported so the historical import sites
// (server.ts, this file's preview check) can never drift apart.
export { timingSafeStringEqual };

// Extract one cookie's value from a Cookie header, percent-decoded the way Next's RequestCookies
// does it (next/dist/compiled/@edge-runtime/cookies). Returns undefined when the cookie is absent.
function readCookieValue(cookieHeader: string, name: string): string | undefined {
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const raw = pair.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Malformed percent-encoding: keep the raw value so the equality check below simply fails.
      return raw;
    }
  }
  return undefined;
}

// The strict-dynamic-route 404 (fallback:false / dynamicParams:false) may only yield to an
// AUTHENTICATED preview/draft or on-demand-revalidate request. Both credentials are validated
// against the build's random previewModeId, which pool-server/index.ts loads from
// prerender-manifest.json into __NEXT_PREVIEW_MODE_ID — the same values upstream Next 16.2 checks:
//  - `x-prerender-revalidate`: direct equality with previewModeId (checkIsOnDemandRevalidate in
//    next/dist/server/api-utils/index.js).
//  - `__prerender_bypass` cookie: Next sets the cookie's VALUE to the previewModeId itself
//    (setDraftMode in next/dist/server/api-utils/node/api-resolver.js), and tryGetPreviewData
//    (next/dist/server/api-utils/node/try-get-preview-data.js) accepts it when the decoded value
//    equals previewModeId. NOTE: the previewModeSigningKey signs only the separate legacy Preview
//    Mode `__next_preview_data` JWT — the bypass cookie carries no HMAC — so an exact,
//    constant-time equality against the random build-time id IS the complete upstream scheme.
// When the build produced no preview identity, neither credential is ever honored.
// Exported: index.ts's `_next/data` static fast path must yield to an authenticated
// draft-mode request the same way this file's strict-404 gate does (survey Tier 1 #2 —
// `next start` renders fresh in draft mode; the staged prerender must not be served).
export function isVerifiedPreviewRequest(req: IncomingMessage): boolean {
  const previewModeId = process.env.__NEXT_PREVIEW_MODE_ID;
  if (!previewModeId) return false;
  const revalidateHeader = req.headers["x-prerender-revalidate"];
  const revalidateValue = Array.isArray(revalidateHeader) ? revalidateHeader[0] : revalidateHeader;
  if (
    typeof revalidateValue === "string" &&
    timingSafeStringEqual(revalidateValue, previewModeId)
  ) {
    return true;
  }
  const cookieHeader = req.headers.cookie;
  const bypassValue = readCookieValue(
    Array.isArray(cookieHeader) ? cookieHeader.join("; ") : (cookieHeader ?? ""),
    "__prerender_bypass",
  );
  return bypassValue !== undefined && timingSafeStringEqual(bypassValue, previewModeId);
}

// Swallow socket errors on a client stream. A mid-response client disconnect emits an
// 'error' on req/res; with no listener Node rethrows it as an uncaught 'error' event and
// takes the whole process down. There's nothing to recover — the connection is gone.
// Exported so server.ts can attach the same guard at the single per-request choke point
// (the static/public/image fast paths in index.ts write responses without one).
export function guardStreamErrors(stream: IncomingMessage | ServerResponse): void {
  if (typeof (stream as { on?: unknown }).on === "function") {
    stream.on("error", () => undefined);
  }
}

// Marker for a deliberate upstream teardown after the CLIENT hung up. The teardown
// surfaces as an 'error' event on the proxied request; without the marker it was
// reported as `cross-pool proxy failed: socket hang up` at error level — a client
// closing a tab is not an upstream failure and must not page anyone.
class ClientAbortError extends Error {
  constructor() {
    super("client disconnected before the proxied response completed");
    this.name = "ClientAbortError";
  }
}

class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

// Cancel an upstream request when the client connection dies before the response
// completes — otherwise a wedged/slow upstream keeps running into a dead socket.
// Guarded because unit-test response doubles don't implement the EventEmitter surface.
function abortOnClientClose(res: ServerResponse, abort: () => void): void {
  if (typeof (res as { on?: unknown }).on === "function") {
    res.on("close", () => {
      if (!res.writableEnded) abort();
    });
  }
}

/**
 * S19. Absolute cap on a proxied exchange, connect through response body — as opposed to
 * PROXY_TIMEOUT_MS, which is an IDLE timeout a slow-drip upstream never trips. Generous
 * (10 min) because a legitimate streamed response may run long; the point is that it is
 * FINITE, so sockets and request state cannot accumulate without bound.
 */
const PROXY_ABSOLUTE_DEADLINE_MS = 600_000;

// N37: one default time-to-response-head budget for local handlers and cross-pool hops. Separate
// 60s/30s defaults made the same route succeed or 502 depending only on which pool received it.
// The server-wide `requestTimeout` measures
// request RECEIPT and not handler runtime — so a handler that never answered held a listening
// loopback server, an ephemeral port, its pendingWaitUntil set and the client socket for as long
// as the process lived. This bounds TIME TO THE RESPONSE HEAD only, and is disarmed once the
// entrypoint answers: the same discipline proxyToPool applies to its own idle timeout, and for the
// same reason — capping the streaming phase would kill SSE and long PPR resumes that a same-pool
// route is expected to serve. Generous by default (a blocking SSG render on a cold pod is
// legitimately slow); the point is that it is finite.
export const REQUEST_HEAD_TIMEOUT_MS = Math.max(
  1_000,
  parseInt(process.env.ADAPTER_K8S_HANDLER_TIMEOUT_MS ?? "", 10) || 60_000,
);
const PROXY_TIMEOUT_MS = REQUEST_HEAD_TIMEOUT_MS;
const HANDLER_TIMEOUT_MS = REQUEST_HEAD_TIMEOUT_MS;

// RFC 9110 §7.6.1 hop-by-hop headers describe a single transport-level connection.
// Forwarding an upstream's `connection`/`transfer-encoding`/etc. to our client
// mis-describes framing WE own (and a `connection: close` from the target would
// wrongly tear down our client keep-alive). Strip them at both proxy boundaries.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

function stripHopByHopHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  return out;
}

// Same principle on the REQUEST side: the client's hop-by-hop headers describe the
// client↔pool connection, not the new pool↔upstream connection we are about to open.
// RFC 9110 §7.6.1 additionally lets the incoming Connection header NOMINATE arbitrary
// headers as connection-scoped — those must be dropped too, or a client can tunnel a
// header past the boundary (`connection: x-anything` + `x-anything: …`). Node sets its
// own connection semantics (keep-alive/close, framing) on the outbound request.
function stripRequestHopByHopHeaders(
  headers: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const nominated = new Set<string>();
  const connection = headers["connection"];
  for (const value of Array.isArray(connection) ? connection : connection ? [connection] : []) {
    for (const token of value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name) nominated.add(name);
    }
  }
  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || nominated.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

// Delete a header from a plain headers object regardless of the casing it was written
// with (build-time manifest headers keep their original casing; Node lowercases live ones).
function deleteHeaderCaseInsensitive(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

/**
 * Headers persisted on a platform-cache entry include Next's internal cache-transport
 * headers (`x-next-cache-tags` — route/tag structure `next start` strips before the public
 * response). The stored-entry DIRECT serves bypass the loopback pipe that normally strips
 * them, so every direct `writeHead` from a cache entry must go through this.
 */
function sanitizeStoredEntryHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { ...headers };
  deleteHeaderCaseInsensitive(out, "x-next-cache-tags");
  return out;
}

// Restate honest framing headers on a forwarded request: drop any client-supplied
// content-length/transfer-encoding, then set content-length from the ACTUAL buffered
// body when there is one. Forwarding the client's declared length without the bytes
// (forged `Content-Length: 100` on a GET) makes the receiving server await a body
// that never arrives — hanging the invocation until the 300s requestTimeout, an
// unauthenticated resource pin. Delete case-insensitively (Node lowercases incoming
// names, but invocation headers may not be).
function restateFramingHeaders(
  headers: Record<string, string | string[] | undefined>,
  bufferedBody: Buffer | undefined,
  method: string | undefined,
  setExplicitEmpty: boolean,
): void {
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding") {
      delete headers[key];
    }
  }
  if (bufferedBody && bufferedBody.length > 0) {
    headers["content-length"] = String(bufferedBody.length);
  } else if (setExplicitEmpty && method !== "GET" && method !== "HEAD") {
    // Body was consumed but empty — send an explicit empty body.
    headers["content-length"] = "0";
  }
}

// Keep Pages fallback:true shells away from crawlers that require a complete blocking render.
// This mirrors Next 16's isBot union (Googlebot plus HTML_LIMITED_BOT_UA_RE). It lives here rather
// than importing a private next/dist module so the adapter bundle is not coupled to an unstable
// internal file path; the upstream prerender-crawler E2E locks behavior across canary updates.
const FALLBACK_BLOCKING_BOT_UA_RE =
  /Googlebot(?!-)|Googlebot$|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

// Write a chunk to the client, bailing out if the socket has gone away. Returns false
// when streaming should stop (socket destroyed/ended), true when it's safe to continue.
async function writeChunkSafely(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  let flushed: boolean;
  try {
    flushed = res.write(chunk);
  } catch {
    return false;
  }
  if (!flushed) {
    // Wait for drain, but stop waiting if the socket closes/errors first (else we hang).
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        res.off("error", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
      res.once("error", done);
    });
  }
  return !res.writableEnded && !res.destroyed;
}

// Exported for unit tests (PPR shell/resume set-cookie merge is pinned there).
export function mergeResponseHeaders(
  prefix: Record<string, string | string[]> | undefined,
  response: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const merged: Record<string, string | string[] | undefined> = {};
  // HTTP field names are case-insensitive. PPR shell metadata preserves the casing emitted at
  // build time, while Node normalizes the resume response to lowercase. A plain object spread
  // therefore sends both `Link` and `link`, doubling React's configured header budget and possibly
  // overflowing Node's HTTP parser. Normalize at the shell/resume boundary and let the live resume
  // value replace the persisted copy, matching a normal single-render response.
  for (const headers of [prefix, response]) {
    if (!headers) continue;
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      // Set-Cookie is the one header that must never be folded: the PPR shell and the
      // resume stream are two responses merged into one client answer, and each may
      // carry its own cookies. Wholesale replacement (the normal rule above) silently
      // drops the shell's cookies — append instead.
      if (lower === "set-cookie" && merged["set-cookie"] !== undefined) {
        const existing = merged["set-cookie"];
        const combined = Array.isArray(existing) ? [...existing] : [existing!];
        if (Array.isArray(value)) combined.push(...value);
        else if (value !== undefined) combined.push(value);
        merged["set-cookie"] = combined;
      } else {
        merged[lower] = value;
      }
    }
  }
  return merged;
}

// Merge the resolved routing verdict (next.config headers() + middleware response
// headers) into the headers argument a serve site passed to writeHead. Node accepts
// THREE shapes there: an object map, an array of [name, value] tuples, and a FLAT
// array [name1, value1, name2, value2] (the request.rawHeaders layout). The array
// forms never enter an Object.keys loop usefully (it yields indices), which silently
// dropped middleware headers — normalize arrays to tuples and merge pairwise.
// Set-Cookie is APPENDED (both the serve site's and middleware's cookies must
// survive); any other resolved header REPLACES the serve site's value, because
// next.config headers() and explicit middleware response headers are the final
// public response policy in Next's router-server — adapter defaults (including
// static/public cache-control) must not silently win over that app-owned value.
// Name comparison is case-insensitive (Node and Web Headers normalize differently).
export function mergeResolvedHeadersIntoHeadersArg(
  resolvedHeaders: Headers,
  headersArg: unknown,
): unknown {
  if (headersArg === undefined || headersArg === null) return headersArg;

  const resolvedSetCookies = resolvedHeaders
    .getSetCookie()
    .flatMap((maybeCompoundCookie) => splitCookiesString(maybeCompoundCookie));

  if (Array.isArray(headersArg)) {
    const pairs: [string, unknown][] = [];
    if (headersArg.length > 0 && !Array.isArray(headersArg[0])) {
      // Flat form: even offsets are names, odd offsets are values.
      for (let i = 0; i + 1 < headersArg.length; i += 2) {
        pairs.push([String(headersArg[i]), headersArg[i + 1]]);
      }
    } else {
      for (const entry of headersArg as [unknown, unknown][]) {
        pairs.push([String(entry[0]), entry[1]]);
      }
    }
    for (const [key, value] of resolvedHeaders.entries()) {
      if (key.toLowerCase() === "set-cookie") continue;
      for (let i = pairs.length - 1; i >= 0; i--) {
        if (pairs[i]![0].toLowerCase() === key.toLowerCase()) pairs.splice(i, 1);
      }
      pairs.push([key, value]);
    }
    for (const cookie of resolvedSetCookies) pairs.push(["set-cookie", cookie]);
    // Tuple form back to Node — it accepts tuples regardless of the input shape.
    return pairs;
  }

  if (typeof headersArg === "object") {
    const handlerHeaders = headersArg as Record<string, string | string[]>;
    for (const [key, value] of resolvedHeaders.entries()) {
      if (key.toLowerCase() === "set-cookie") continue;
      for (const existingKey of Object.keys(handlerHeaders)) {
        if (existingKey.toLowerCase() === key.toLowerCase()) {
          delete handlerHeaders[existingKey];
        }
      }
      handlerHeaders[key] = value;
    }
    if (resolvedSetCookies.length > 0) {
      const existingKey = Object.keys(handlerHeaders).find(
        (name) => name.toLowerCase() === "set-cookie",
      );
      const existing = existingKey ? handlerHeaders[existingKey] : undefined;
      const cookies = Array.isArray(existing)
        ? [...existing, ...resolvedSetCookies]
        : existing
          ? [existing, ...resolvedSetCookies]
          : resolvedSetCookies;
      if (existingKey && existingKey !== "set-cookie") delete handlerHeaders[existingKey];
      handlerHeaders["set-cookie"] = cookies;
    }
    return handlerHeaders;
  }

  return headersArg;
}

const WEBSOCKET_FALLBACK_REPLACED_HEADERS = new Set([
  "accept-ranges",
  "age",
  "cache-control",
  "connection",
  "content-digest",
  "content-disposition",
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-range",
  "content-type",
  "digest",
  "edge-control",
  "etag",
  "expires",
  "keep-alive",
  "last-modified",
  "proxy-connection",
  "repr-digest",
  "sec-websocket-accept",
  "sec-websocket-extensions",
  "sec-websocket-key",
  "sec-websocket-protocol",
  "sec-websocket-version",
  "surrogate-control",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-lighttpd-send-file",
  "x-sendfile",
]);

function headersArgPairs(headersArg: unknown): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const append = (name: unknown, value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) pairs.push([String(name), String(item)]);
    } else if (value !== undefined) {
      pairs.push([String(name), String(value)]);
    }
  };
  if (Array.isArray(headersArg)) {
    if (headersArg.length > 0 && !Array.isArray(headersArg[0])) {
      for (let index = 0; index + 1 < headersArg.length; index += 2) {
        append(headersArg[index], headersArg[index + 1]);
      }
    } else {
      for (const entry of headersArg as Array<[unknown, unknown]>) append(entry[0], entry[1]);
    }
  } else if (headersArg && typeof headersArg === "object") {
    for (const [name, value] of Object.entries(headersArg)) append(name, value);
  }
  return pairs;
}

function isGeneratedWebSocketFallback(status: number, headersArg: unknown): boolean {
  if (status !== 426) return false;
  const headers = new Headers(headersArgPairs(headersArg));
  return (
    headers.get("connection")?.toLowerCase() === "close" &&
    headers.get("upgrade")?.toLowerCase() === "websocket" &&
    headers.get("sec-websocket-version") === "13"
  );
}

/**
 * The generated App Route has already canonicalized an ordinary HTTP invocation of
 * NextResponse.upgrade() into a safe 426. Routing headers live outside the loopback entrypoint in
 * this adapter, so merging them with the normal "routing wins" rule would re-introduce forbidden
 * Connection/framing/internal fields after Next removed them. Recreate the fallback's inheritance
 * order: safe routing fields first, then handler fields, while its canonical transport fields win.
 */
function mergeResolvedHeadersIntoWebSocketFallback(
  resolvedHeaders: Headers,
  headersArg: unknown,
): unknown {
  const handlerPairs = headersArgPairs(headersArg);
  const handlerNames = new Set(handlerPairs.map(([name]) => name.toLowerCase()));
  const nominated = new Set(
    (resolvedHeaders.get("connection") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const isForbidden = (name: string) => {
    const lower = name.toLowerCase();
    return (
      WEBSOCKET_FALLBACK_REPLACED_HEADERS.has(lower) ||
      nominated.has(lower) ||
      lower.endsWith("-cache-control") ||
      lower.startsWith("x-accel-") ||
      lower.startsWith("x-middleware-") ||
      lower.startsWith("x-nextjs-") ||
      lower === INTERNAL_SECRET_HEADER ||
      (INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(lower)
    );
  };

  const inherited: Array<[string, string]> = [];
  for (const [name, value] of resolvedHeaders.entries()) {
    const lower = name.toLowerCase();
    if (lower === "set-cookie" || isForbidden(lower) || handlerNames.has(lower)) continue;
    inherited.push([name, value]);
  }
  if (!nominated.has("set-cookie")) {
    for (const cookie of resolvedHeaders.getSetCookie()) inherited.push(["set-cookie", cookie]);
  }
  return [...inherited, ...handlerPairs];
}

/** Apply Next middleware's authoritative request-header replacement to a Node request. */
export function applyMiddlewareRequestHeaders(
  req: IncomingMessage,
  middlewareRequestHeaders: Headers | undefined,
  options: { preserveMiddlewareCookieHeader?: boolean } = {},
): void {
  if (!middlewareRequestHeaders) return;
  const originalHost = req.headers.host;
  const nextHeaders: IncomingMessage["headers"] = {};
  for (const [key, value] of middlewareRequestHeaders.entries()) {
    if (key === "x-middleware-set-cookie") {
      // WebSocket routing is split across Node's `upgrade` event and Next's generated
      // entrypoint. Next preserves this framework-authored header across that handoff so its
      // request store can merge middleware cookies without treating a client-forged cookie as
      // input. Ordinary HTTP dispatch keeps the historical cookie-header projection below.
      if (options.preserveMiddlewareCookieHeader) {
        nextHeaders[key] = value;
        continue;
      }
      const cookies: string[] = [];
      for (const setCookie of splitCookiesString(value)) {
        const nameValue = setCookie.trim().split(";")[0];
        if (nameValue) cookies.push(nameValue);
      }
      if (cookies.length > 0) {
        const existing = middlewareRequestHeaders.get("cookie") ?? "";
        nextHeaders.cookie = [existing, ...cookies].filter(Boolean).join("; ");
      }
      continue;
    }
    if (key.startsWith("x-middleware-")) continue;
    nextHeaders[key] = value;
  }
  if (!nextHeaders.host && originalHost) nextHeaders.host = originalHost;
  req.headers = nextHeaders;
}

/** Merge routing and middleware response headers into the next Node writeHead call. */
export function installResolvedResponseHeaders(
  res: ServerResponse,
  resolvedHeaders: Headers | undefined,
): void {
  if (!resolvedHeaders) return;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((status: number, ...args: unknown[]) => {
    const headersIndex = typeof args[0] === "string" ? 1 : 0;
    if (args[headersIndex] !== undefined && args[headersIndex] !== null) {
      args[headersIndex] = isGeneratedWebSocketFallback(status, args[headersIndex])
        ? mergeResolvedHeadersIntoWebSocketFallback(resolvedHeaders, args[headersIndex])
        : mergeResolvedHeadersIntoHeadersArg(resolvedHeaders, args[headersIndex]);
    }
    return Reflect.apply(originalWriteHead, res, [status, ...args]) as ServerResponse;
  }) as typeof res.writeHead;
}

// Record a response's status/headers/body as it streams to the client, so a
// fully-keyed platform entry can be replayed byte-identically on later serves. Patches the
// live response object in place (per-request; same technique as the trust boundary wrapper).
// An over-budget body abandons recording — the serve itself is never affected.
function captureResponseForStore(res: ServerResponse, maxBytes: number) {
  let status = 200;
  let total = 0;
  let over = false;
  const chunks: Buffer[] = [];
  const headHeaders: Record<string, string | string[]> = {};
  const record = (chunk: unknown) => {
    if (over || chunk == null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buf.length;
    if (total > maxBytes) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buf);
  };
  const origWriteHead = res.writeHead.bind(res);
  (res as any).writeHead = function (s: number, ...args: unknown[]) {
    status = s;
    const headersArg = typeof args[0] === "string" ? args[1] : args[0];
    if (headersArg && typeof headersArg === "object" && !Array.isArray(headersArg)) {
      Object.assign(headHeaders, headersArg as Record<string, string | string[]>);
    }
    return origWriteHead(s, ...(args as [never]));
  };
  const origWrite = res.write.bind(res);
  (res as any).write = function (chunk: unknown, ...args: unknown[]) {
    record(chunk);
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  };
  const origEnd = res.end.bind(res);
  (res as any).end = function (chunk?: unknown, ...args: unknown[]) {
    record(chunk);
    return (origEnd as (...a: unknown[]) => ServerResponse)(chunk, ...args);
  };
  return {
    finish():
      | { status: number; headers: Record<string, string | string[]>; body: Buffer }
      | undefined {
      if (over) return undefined;
      const merged: Record<string, string | string[]> = {
        ...(res.getHeaders?.() as Record<string, string | string[]> | undefined),
        ...headHeaders,
      };
      // The stored copy replays under its own verdict; drop the first serve's.
      delete merged["x-vercel-cache"];
      return { status, headers: merged, body: Buffer.concat(chunks) };
    },
  };
}

async function writeInnerResponse(
  outerRes: ServerResponse,
  innerRes: IncomingMessage,
  forceStatus?: number,
  prefix?: {
    body: Buffer;
    headers?: Record<string, string | string[]>;
    status?: number;
  },
  normalizePrerenderCacheControl = false,
  // Option D: a pending canonical-resume response whose body is APPENDED after the inner
  // (shell) body. Headers were already sent with the shell, so the tail's headers are
  // discarded; a failed/errored tail (null or status >= 400) degrades to shell-only.
  resumeSuffix?: Promise<IncomingMessage | null>,
  // A build-time fallback artifact backs this route (pprRoutes membership) — feeds the
  // x-vercel-cache verdict when the entrypoint owns the serve (see the classifier below).
  buildFallbackBacked = false,
  // Seen-key registry verdict — a repeat serve of a known platform cache key is HIT
  // regardless of how the bytes were produced.
  platformCacheSeen?: boolean,
): Promise<void> {
  // A direct adapter entrypoint can produce either of two valid shapes from postponed state:
  // a resume tail (which needs the persisted shell prepended), or a complete HTML document (the
  // partial-fallback chain already replayed its prelude). Peek at the first chunk before committing
  // headers so we do not concatenate two documents for the latter shape.
  //
  // N36: peek ONLY when there is a shell to decide about. This wait used to be unconditional,
  // which withheld the response head until the handler produced its first BODY byte — measured
  // 1213 ms to headers for a handler that flushes at 0 ms and writes at 1200 ms, where
  // `next start` sends the head at +14 ms (so an EventSource/SSE consumer connects immediately
  // instead of hanging until the first event). Nothing else in this function needs the chunk:
  // `handlerRenderedDocument` is already gated on `!!prefix`.
  const iterator = innerRes[Symbol.asyncIterator]();
  let firstChunk: Buffer | undefined;
  if (prefix) {
    const first = await iterator.next();
    firstChunk = first.done ? undefined : Buffer.from(first.value as Buffer);
  }
  const handlerRenderedDocument =
    !!prefix &&
    !!firstChunk &&
    /^\s*(?:<!doctype\s+html(?:\s[^>]*)?>|<html(?:\s|>))/i.test(
      firstChunk.toString("utf8", 0, Math.min(firstChunk.length, 256)),
    );
  const effectivePrefix = handlerRenderedDocument ? undefined : prefix;
  const headers = mergeResponseHeaders(effectivePrefix?.headers, innerRes.headers);
  // The same HTTP field must not be forwarded twice. On a shared-cache MISS, Next's generated
  // app-page template appends the freshly captured cache-entry headers onto a response whose
  // streaming render already set them (React's onHeaders `link` preload budget being the
  // observable victim: the loopback response carries two identical `link` fields, which Node
  // folds into one comma-joined value of double the length — blowing the app's configured
  // reactMaxHeadersLength budget at the client). Collapse EXACT-duplicate repeats using the
  // raw (unfolded) header list; distinct values and set-cookie are never touched.
  const rawHeaders = innerRes.rawHeaders ?? [];
  const seenRawValues = new Map<string, string[]>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i]!.toLowerCase();
    const values = seenRawValues.get(name) ?? [];
    values.push(rawHeaders[i + 1]!);
    seenRawValues.set(name, values);
  }
  for (const [name, values] of seenRawValues) {
    if (name === "set-cookie" || values.length < 2) continue;
    if (values.every((v) => v === values[0])) headers[name] = values[0]!;
  }
  // Next uses this header to transport cache tags between its entrypoint and incremental cache.
  // It is internal bookkeeping, can expose route/tag structure, and `next start` removes it before
  // the public response. The adapter owns that server boundary, so never forward it to clients.
  delete headers["x-next-cache-tags"];
  // Platform cache status (plans/prerender-matrix-catchup.md Phase 1). The pool IS the
  // platform in the deploy harness and in production, and upstream's prerender-matrix suite
  // asserts `x-vercel-cache` with these semantics: PRERENDER = a BUILD fallback artifact
  // answered a never-seen key (the prepended shell); HIT = a stored entry answered (Next's
  // cache said HIT/STALE — STALE still served stored bytes); MISS = blocking generation
  // with no servable fallback (an Option-D live resume is exactly that: no build artifact
  // existed, the document rendered per-request). An entrypoint-supplied verdict wins.
  if (headers["x-vercel-cache"] === undefined) {
    const nextCache = String(headers["x-nextjs-cache"] ?? "");
    headers["x-vercel-cache"] = platformCacheSeen
      ? // Repeat serve of a known platform key: HIT even when the entry contributes zero
        // bytes and the document re-renders (the matrix's empty-entry sharing contract).
        "HIT"
      : effectivePrefix
        ? "PRERENDER"
        : nextCache === "HIT" || nextCache === "STALE"
          ? "HIT"
          : (nextCache === "MISS" || headers["x-nextjs-postponed"] !== undefined) &&
              buildFallbackBacked
            ? // A BUILD fallback artifact answered this serve. Two measured shapes: Next
              // reports x-nextjs-cache MISS (it rendered over the fallback and cached just
              // now), or — fresh-key shell+resume — the response carries only
              // `x-nextjs-postponed: 1` with no cache verdict at all. Both are PRERENDER
              // by the platform contract. Cached entries keep HIT:
              // the HIT/STALE arm above runs first.
              "PRERENDER"
            : "MISS";
  }
  // The combined response is shell bytes followed by resume bytes, so neither
  // component's content length describes the final body.
  if (effectivePrefix || resumeSuffix) delete headers["content-length"];
  // Entrypoints emit origin-oriented s-maxage/private cache directives for
  // incremental responses. In adapter deploy mode the platform cache owns ISR,
  // while the browser-facing response must always revalidate. Next marks this
  // response class explicitly, so avoid altering SSR, APIs, or user headers.
  // `x-nextjs-prerender` marks the same class: a cache-miss render of a prerenderable
  // route carries it WITHOUT `x-nextjs-cache`, and its `cache-control: s-maxage=31536000`
  // previously passed through untagged — Cloud CDN stored it for a year and tag-based
  // cutover invalidation could never purge it (M13 stale-apex incident, stamping side).
  // Only CDN-storable directives are rewritten: a prerender-marked response the entry
  // already declared uncacheable (PPR documents are `private, no-cache, no-store`) keeps
  // that stricter verdict — this guard exists to stop long-lived leaks, not to loosen.
  const innerCacheControl = String(headers["cache-control"] ?? "");
  const uncacheableAlready = /\b(?:no-store|no-cache|private)\b/i.test(innerCacheControl);
  const prerenderLeaksCacheable =
    headers["x-nextjs-prerender"] !== undefined && !uncacheableAlready;
  // N30 (SECURITY/CACHE): `x-nextjs-postponed` marks the same leak class and was NOT in this
  // guard. A postponed response is an UNFINISHED shell whose dynamic holes stream per request,
  // and it need carry neither `x-nextjs-cache` nor `x-nextjs-prerender` — so a minimal-mode
  // entrypoint's `s-maxage=31536000` passed straight through, untagged, and Cloud CDN kept an
  // incomplete document for a year that no cutover tag invalidation could purge (M13 class).
  // `next start` answers a PPR document `private, no-cache, no-store, max-age=0,
  // must-revalidate` (measured). Same one-directional rule as the prerender guard above: a
  // response the entry already declared uncacheable keeps its stricter verdict.
  const postponedLeaksCacheable =
    headers["x-nextjs-postponed"] !== undefined && !uncacheableAlready;
  if (
    normalizePrerenderCacheControl ||
    headers["x-nextjs-cache"] !== undefined ||
    prerenderLeaksCacheable ||
    postponedLeaksCacheable
  ) {
    headers["cache-control"] = "public, max-age=0, must-revalidate";
    delete headers["cache-tag"];
  }
  outerRes.writeHead(forceStatus ?? effectivePrefix?.status ?? innerRes.statusCode ?? 200, headers);
  // N36: writeHead alone does not put the head on the wire — Node holds the header bytes until
  // the first body write, so a stream whose first chunk is seconds away still had its head
  // withheld even after the peek was removed. In `next start` the app's own `res.flushHeaders()`
  // acts on the socket response directly; here the app flushed the LOOPBACK response, so the
  // adapter has to carry that flush across the boundary. (No-op when a prefix body follows
  // immediately below, and harmless for fixed-length responses beyond one extra small segment.)
  if (typeof (outerRes as { flushHeaders?: unknown }).flushHeaders === "function") {
    outerRes.flushHeaders();
  }
  if (effectivePrefix && !(await writeChunkSafely(outerRes, effectivePrefix.body))) {
    innerRes.destroy();
    return;
  }
  if (firstChunk && !(await writeChunkSafely(outerRes, firstChunk))) {
    innerRes.destroy();
    return;
  }
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const canContinue = await writeChunkSafely(outerRes, next.value as Buffer);
    if (!canContinue) {
      // Client is gone — stop reading the inner response and let it be discarded.
      innerRes.destroy();
      return;
    }
  }
  if (resumeSuffix) {
    const tail = await resumeSuffix.catch(() => null);
    if (tail && (tail.statusCode ?? 500) < 400) {
      for await (const chunk of tail) {
        if (!(await writeChunkSafely(outerRes, chunk as Buffer))) {
          tail.destroy();
          return;
        }
      }
    } else if (tail) {
      // Error tail: never forward the body, but drain it so the loopback socket closes.
      tail.resume();
    }
  }
  if (!outerRes.writableEnded) outerRes.end();
}

type Render404 = (
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl?: { pathname?: string | null; query?: Record<string, unknown> },
  setHeaders?: boolean,
) => Promise<void>;

type RenderError = (req: IncomingMessage, res: ServerResponse, error: Error) => Promise<void>;

type Revalidate = (config: {
  urlPath: string;
  headers: Record<string, string | string[]>;
  opts: { unstable_onlyGenerated?: boolean };
}) => Promise<void>;

async function writeWebResponseToNode(
  res: ServerResponse,
  response: Response,
  forceStatus?: number,
): Promise<void> {
  res.writeHead(forceStatus ?? response.status, webHeadersToNodeHeaders(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!res.writableEnded) res.end();
}

export async function invokeLocalHandlerOverHttp({
  handler,
  req,
  res,
  matchedPathname,
  routeMatches,
  bufferedBody,
  invocationPath,
  routeParamPathname,
  invocationQuery,
  mergeInvocationQueryIntoUrl = false,
  responsePrefix,
  invocationHeaders,
  discardResponse,
  minimalMode = false,
  normalizePrerenderCacheControl = false,
  forceStatus,
  invokeStatus,
  render404,
  renderError,
  revalidate,
  i18nLocales,
  handlerTimeoutMs = HANDLER_TIMEOUT_MS,
  executionTimeoutMs,
  capturePostponedState = false,
  buildFallbackBacked = false,
  platformCacheSeen,
}: {
  handler: HandlerLoader extends { load(outputId: string): Promise<infer T> } ? T : never;
  req: IncomingMessage;
  res: ServerResponse;
  matchedPathname: string;
  routeMatches: Record<string, string> | null;
  bufferedBody: Buffer | undefined;
  /** Concrete internal rewrite target. The loopback request keeps the public URL; this target is
   * supplied through documented request metadata for route params/query resolution. */
  invocationPath?: string;
  /** Concrete route selected by routing before it is mapped back to an executable dynamic output.
   * This may retain an i18n prefix that invocationPath intentionally removes from handler URL
   * metadata. Use it only to recover dynamic params from the output template. */
  routeParamPathname?: string;
  /** Query resolved by @next/routing, excluding internal capture placeholders. */
  invocationQuery?: Record<string, string | string[]>;
  /** App ROUTE handlers only: fold the rewrite's invocation query onto the PUBLIC request URL.
   * `NextRequestAdapter.fromNodeNextRequest` builds `request.nextUrl` purely from the request
   * URL, so this is the only channel a route handler has for rewrite-added search params. */
  mergeInvocationQueryIntoUrl?: boolean;
  /** Build-time PPR shell prepended to the handler's resumed render stream. */
  responsePrefix?: {
    filePath?: string;
    /** In-memory shell bytes (a materialized platform-cache entry) — wins over filePath. */
    content?: Buffer;
    headers?: Record<string, string | string[]>;
    status?: number;
  };
  /** Headers prescribed by the build output's internal invocation chain (for example next-resume). */
  invocationHeaders?: Record<string, string>;
  /** Drain the entrypoint response without forwarding it. Used only by the explicitly E2E-gated
   * platform-cache simulation to let a segment prefetch schedule a background shell fill. */
  discardResponse?: boolean;
  /** Next direct-entrypoint runtime mode. False is reserved for the E2E filesystem stand-in. */
  minimalMode?: boolean;
  /** The adapter knows this Pages response is backed by a prerender even when the generated direct
   * entrypoint omits x-nextjs-cache. Keep mutable ISR in Valkey, not Cloud CDN. */
  normalizePrerenderCacheControl?: boolean;
  /** Override the response status regardless of what the handler set — used to make a not-found
   * render return 404 even when the underlying page handler (e.g. Pages Router `/404`) renders 200. */
  forceStatus?: number;
  /** Status supplied to Next's internal error entrypoint through documented request metadata. */
  invokeStatus?: number;
  /** Adapter-provided 404 renderer used when a Pages handler returns `notFound: true`. */
  render404?: Render404;
  /** Adapter-provided error renderer used when an entrypoint throws before sending a response. */
  renderError?: RenderError;
  /** In-process on-demand revalidation, matching Next's documented requestMeta contract. */
  revalidate?: Revalidate;
  /** Pages i18n locale prefixes are protocol routing state, not dynamic page params. */
  i18nLocales?: string[];
  /** N37: bound on time-to-response-head for this invocation. See HANDLER_TIMEOUT_MS. */
  handlerTimeoutMs?: number;
  /** Next output maxDuration. Unlike the head timeout, this remains active while streaming. */
  executionTimeoutMs?: number;
  /**
   * Option D: for a shell-less PPR-capable route running minimal, swap the inert onCacheEntryV2 stub for a
   * capturing one (same signature, still returns false — the callback's PRESENCE is part of
   * the measured baseline and must never vary, only its body). If the render then postpones
   * (`x-nextjs-postponed: 1`), the pool performs the platform half itself: POST the captured
   * state back to the same entrypoint with `next-resume: 1` (the canonical resume contract,
   * app-page.ts:384-406 — gated on header+method, NOT on minimal mode) and append the resumed
   * stream after the shell. Runtime discrimination: a render that does not postpone is never
   * touched, which is what the build-time signal could not provide (rev 3).
   */
  capturePostponedState?: boolean;
  /** pprRoutes membership: a build fallback artifact backs this route (x-vercel-cache). */
  buildFallbackBacked?: boolean;
  /** Seen-key registry verdict: this platform cache key was served before (→ HIT). */
  platformCacheSeen?: boolean;
}): Promise<void> {
  // Option D applies only to MINIMAL invocations: a non-minimal render is resumed inline by
  // Next itself (app-page.ts:2038), so capturing there would only risk a duplicate resume.
  const captureActive = capturePostponedState && minimalMode;
  await new Promise<void>((resolve, reject) => {
    // Option D: the postponed state of a live minimal-mode render, observed (never consumed)
    // through the documented onCacheEntryV2 callback. Written at most once per invocation.
    let capturedPostponed: string | undefined;
    const pendingWaitUntil = new Set<Promise<void>>();
    const trackWaitUntil = (waitable: Promise<unknown>): void => {
      const observed: Promise<void> = Promise.resolve(waitable)
        .then(() => undefined)
        .catch((error): void => {
          console.error(`[pool-server] background work failed for ${matchedPathname}:`, error);
        })
        .finally(() => {
          pendingWaitUntil.delete(observed);
        });
      pendingWaitUntil.add(observed);
    };
    const settleWaitUntil = async (): Promise<void> => {
      // A settled callback can enqueue another callback, so drain to a fixed point. The response
      // has already been streamed to the client; this only keeps the invocation/server lifecycle
      // alive until Next's cache writes, revalidations, and after() work have completed.
      while (pendingWaitUntil.size > 0) {
        // Snapshot the Set: callbacks may delete themselves and enqueue more work while this
        // batch settles; the outer loop deliberately picks up the next fixed-point batch.
        // oxlint-disable-next-line unicorn/no-useless-spread
        await Promise.all([...pendingWaitUntil]);
      }
    };
    const server = createServer((innerReq, innerRes) => {
      void (async () => {
        try {
          // The PPR resume token is set on the OUTER req's meta symbol by the caller
          // (see the pprRoutes branch below). The loopback createServer only carries req/res
          // streaming — `ctx` here is a direct JS argument, so we thread `postponed` through it
          // rather than relying on the symbol surviving the hop (it does not). The generated
          // app-page handler calls setRequestMeta(req, ctx.requestMeta) then reads
          // getRequestMeta(req, 'postponed') and resumes the dynamic holes onto the prebuilt
          // shell, streamed. Spike-proven: injecting just `postponed` streams a correct resume
          // (no minimal mode / resolvedPathname needed). See the PPR/cache-components design doc.
          const outerMeta =
            ((req as IncomingMessage & { [NEXT_REQUEST_META]?: { postponed?: string } })[
              NEXT_REQUEST_META
            ] as { postponed?: string } | undefined) ?? {};
          // The scheme must come from the validated x-forwarded-proto witness: TLS terminates
          // at the load balancer, so hardcoding `http://` here made every absolute redirect a
          // generated App Route entry derives from request.url/nextUrl (initURL below) escape
          // to `http://` on an https deployment (live 307 form-redirect regression).
          const publicRequestUrl = new URL(
            req.url ?? "/",
            `${requestProtocol(req)}://${req.headers.host ?? "localhost"}`,
          );
          const publicRequestPathname = publicRequestUrl.pathname;
          const concreteInvocationPath = invocationPath
            ? new URL(invocationPath, "http://localhost").pathname
            : (pagesDataRequestPathnameToPagePath(publicRequestPathname, i18nLocales) ??
              publicRequestPathname);
          const params = extractRouteParams(
            matchedPathname,
            routeMatches,
            routeParamPathname ?? concreteInvocationPath,
          );
          let invocationMeta: Record<string, unknown> = {
            // Always provide the concrete decoded/interpolated target. Direct dynamic requests do
            // not have an `invocationPath`, but the entrypoint still needs this to match the right
            // prerender/fallback record rather than treating the route template as the request.
            resolvedPathname: concreteInvocationPath,
            // Generated App Route handlers use initURL to construct request.nextUrl. Preserve the
            // public host and port for ordinary requests; falling back to bare http://localhost
            // makes an absolute 307/308 form redirect escape to port 80. Server Actions are
            // intentionally excluded: their generated entrypoint owns a separate worker-forwarding
            // URL protocol, and injecting initURL there turns single-pass action redirects into an
            // extra network request (and breaks cross-worker action forwarding).
            ...(req.headers["next-action"] === undefined
              ? { initURL: publicRequestUrl.toString() }
              : {}),
            ...(invocationQuery ? { query: invocationQuery } : {}),
            ...(invokeStatus !== undefined ? { invokeStatus } : {}),
          };
          if (params) invocationMeta.params = params;
          if (new URL(req.url ?? "/", "http://localhost").pathname.includes("/_next/data/")) {
            invocationMeta.isNextDataReq = true;
          }
          if (invocationPath) {
            const target = new URL(invocationPath, `http://${req.headers.host ?? "localhost"}`);
            // Shared with both resolvers (routing-common.ts) — this was a byte-identical
            // third copy of the repeated-key accumulation, the same duplication class that
            // let Phase 2's output resolution drift from Phase 1's.
            const query = queryFromUrl(target);
            invocationMeta = {
              ...invocationMeta,
              query: invocationQuery ?? query,
              // `matchedPathname`/`outputId` carry the executable route template. The documented
              // request-meta contract instead defines `resolvedPathname` as decoded and with
              // dynamic params interpolated, so it must carry the concrete invocation target.
              resolvedPathname: target.pathname,
              rewrittenPathname: target.pathname,
            };
          }
          const maybeResult = await (handler as any)(innerReq, innerRes, {
            waitUntil(waitable: Promise<unknown>) {
              trackWaitUntil(waitable);
            },
            requestMeta: {
              relativeProjectDir: ".",
              hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
              minimalMode,
              outputId: matchedPathname,
              matchedPathname,
              routeMatches,
              ...invocationMeta,
              ...(outerMeta.postponed ? { postponed: outerMeta.postponed } : {}),
              // Cache Components entrypoints use the presence of the documented V2 callback to
              // select adapter/minimal-mode cache semantics (including RDC generation). Returning
              // false means the adapter observed the entry but did not write the HTTP response.
              // Option D: for eligible shell-less PPR routes the same callback also OBSERVES the
              // entry's postponed state (capture only — still returns false, and the callback is
              // present either way so Next's presence-keyed branches cannot vary by eligibility).
              onCacheEntryV2: captureActive
                ? async (entry: unknown) => {
                    const postponed = (entry as { value?: { postponed?: unknown } } | undefined)
                      ?.value?.postponed;
                    if (typeof postponed === "string" && postponed.length > 0) {
                      capturedPostponed = postponed;
                    }
                    return false;
                  }
                : async () => false,
              ...(render404 ? { render404 } : {}),
              ...(revalidate ? { revalidate } : {}),
            },
          });

          if (maybeResult instanceof Response) {
            await writeWebResponseToNode(innerRes, maybeResult);
            return;
          }
          // Node entrypoints own the response lifecycle. A Pages API handler may return while
          // an outbound stream is still piping into `res`; ending here truncates that body to
          // empty. The loopback client naturally completes when the entrypoint finishes `res`.
        } catch (error) {
          console.error(`[pool-server] handler error for ${matchedPathname}:`, error);
          if (!innerRes.headersSent) {
            if (renderError) {
              await renderError(
                innerReq,
                innerRes,
                error instanceof Error ? error : new Error(String(error)),
              );
              return;
            }
            innerRes.statusCode = 500;
            innerRes.end("Internal Server Error");
          } else if (!innerRes.writableEnded) {
            innerRes.end();
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate loopback port")));
        return;
      }

      const reqHeaders = toNodeHeaders(req);
      Object.assign(reqHeaders, invocationHeaders);
      // Matrix B-cluster: canary's ResponseCache grew a minimal-mode LRU keyed
      // (pathname + invocationID) — the platform stamps a unique `x-invocation-id` per
      // invocation (route-module.ts:1153) so reuse is scoped to ONE request; without it the
      // cache falls back to TTL mode and replays minimal renders byte-identically across
      // requests (measured: the empty-shell "frozen badge" bake). Always overwrite: the id
      // is a cache-scoping key, so a client-supplied value must never survive. The Option-D
      // resume invocation clones these headers and deliberately SHARES the id — the resume
      // is the same logical invocation.
      if (minimalMode) {
        reqHeaders["x-invocation-id"] = randomUUID();
      }
      // We forward a fixed-length buffered body (or none), so restate the framing:
      // Node's HTTP parser rejects a request carrying BOTH transfer-encoding and
      // content-length (spurious 400 before the handler runs), and a forged
      // content-length with no body (e.g. `Content-Length: 100` on a GET) makes the
      // loopback server await bytes that never arrive — hanging the invocation until
      // the 300s requestTimeout, an unauthenticated resource pin.
      restateFramingHeaders(reqHeaders, bufferedBody, req.method, true);

      // The loopback request URL is the PUBLIC request URL, verbatim. This mirrors Next's own
      // boundary into a generated entrypoint: `BaseServer.renderToResponseWithComponentsImpl`
      // sets `request.url = initURL.pathname + initURL.search` — the URL the CLIENT asked for,
      // reconstructed from requestMeta.initURL — immediately before calling the entry, and
      // carries the rewrite target only through requestMeta (`query`, `params`, and the
      // `resolvedPathname`/`rewrittenPathname` the entry recomputes). Passing the rewrite
      // DESTINATION here instead leaked it into everything user code sees, because generated
      // entries derive `req.url`/`request.nextUrl`/`resolvedAsPath` from
      // `new URL(innerReq.url, initURL)`: `/blog-post-2` (rewritten to
      // `/blog/post-2?hello=world`) rendered `req.url` and `router.asPath` as
      // `/blog/post-2?hello=world`, `/rewrite-source/foo` as `/rewrite-target?path=foo`, and
      // `usePathname()` on a rewritten App page returned the destination. Empirically pinned
      // against `next start` (Next 16.2.10, upstream getserversideprops/getinitialprops/
      // app-dir-hooks fixtures): the public URL is `req.url`/`asPath`/`usePathname`, while the
      // destination surfaces only as `resolvedUrl` and as merged `query`/`params`.
      let loopbackPath = req.url ?? "/";
      if (mergeInvocationQueryIntoUrl && invocationPath && invocationQuery) {
        // App ROUTE (route.ts) entries are the single exception: their request has no
        // requestMeta channel for search params (NextRequestAdapter reads the URL only), so a
        // rewrite-added query has nowhere else to travel. Fold it onto the PUBLIC pathname —
        // the identical treatment the edge App Route path in this file already applies. This is
        // a deliberate, bounded divergence from `next start` (which drops these params); route
        // handlers expose no asPath/usePathname/resolvedUrl, so nothing observable regresses.
        const queryStart = loopbackPath.indexOf("?");
        const rawPath = queryStart === -1 ? loopbackPath : loopbackPath.slice(0, queryStart);
        const params = new URLSearchParams(
          queryStart === -1 ? "" : loopbackPath.slice(queryStart + 1),
        );
        for (const [key, value] of Object.entries(invocationQuery)) {
          params.delete(key);
          for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
        }
        const search = params.toString();
        loopbackPath = search ? `${rawPath}?${search}` : rawPath;
      }

      // N37: arm the invocation deadline. It covers everything up to the entrypoint's response
      // HEAD — including the loopback dial — and is disarmed the moment those headers arrive, so
      // a legitimately long stream is untouched. On expiry the loopback request is destroyed
      // (which closes the ephemeral server and releases the port through the error path below)
      // and the client gets a 504 if nothing has been written yet.
      let invocationTimedOut = false;
      let executionTimedOut = false;
      let activeClientRes: IncomingMessage | undefined;
      const invocationDeadline = setTimeout(() => {
        invocationTimedOut = true;
        console.error(
          `[pool-server] handler for ${matchedPathname} did not respond within ` +
            `${handlerTimeoutMs}ms — aborting the invocation`,
        );
        clientReq.destroy(new Error(`handler invocation timed out after ${handlerTimeoutMs}ms`));
      }, handlerTimeoutMs);
      invocationDeadline.unref?.();

      const clientReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          method: req.method,
          path: loopbackPath,
          headers: reqHeaders,
        },
        (clientRes) => {
          activeClientRes = clientRes;
          clearTimeout(invocationDeadline);
          const closeThenSettle = (onError: (error: unknown) => void): void => {
            // App Router wires after() through res.on("close"). Close the loopback response first
            // so that callback can register its waitUntil promise, then drain the complete batch.
            // Draining before server.close races the close callback and silently loses after().
            server.close(() => {
              void settleWaitUntil()
                .then(resolve)
                .catch(onError)
                .finally(() => {
                  if (executionDeadline) clearTimeout(executionDeadline);
                });
            });
          };
          if (discardResponse) {
            void (async () => {
              for await (const _chunk of clientRes) {
                // Drain the response so the loopback connection can close cleanly.
              }
            })()
              .then(() => closeThenSettle(reject))
              .catch((error) => server.close(() => reject(error)));
            return;
          }
          // Option D: the render postponed and the state was captured — start the canonical
          // resume NOW, in parallel with streaming the shell (the App Hosting model). POST,
          // same loopback URL, `next-resume: 1`, raw state as the body (app-page.ts:384-406).
          // Failure resolves null: the client gets the shell alone, never an error tail.
          let resumeSuffix: Promise<IncomingMessage | null> | undefined;
          if (
            captureActive &&
            clientRes.headers["x-nextjs-postponed"] === "1" &&
            capturedPostponed
          ) {
            const stateBody = Buffer.from(capturedPostponed, "utf8");
            const resumeHeaders = { ...reqHeaders, "next-resume": "1" };
            restateFramingHeaders(resumeHeaders, stateBody, "POST", true);
            resumeSuffix = new Promise<IncomingMessage | null>((resolveResume) => {
              const resumeDeadline = setTimeout(() => {
                console.error(
                  `[pool-server] PPR resume for ${matchedPathname} did not respond within ` +
                    `${handlerTimeoutMs}ms — serving the shell alone`,
                );
                resumeReq.destroy();
                resolveResume(null);
              }, handlerTimeoutMs);
              resumeDeadline.unref?.();
              const resumeReq = httpRequest(
                {
                  hostname: "127.0.0.1",
                  port: address.port,
                  method: "POST",
                  path: loopbackPath,
                  headers: resumeHeaders,
                },
                (resumeRes) => {
                  clearTimeout(resumeDeadline);
                  resolveResume(resumeRes);
                },
              );
              resumeReq.once("error", () => {
                clearTimeout(resumeDeadline);
                resolveResume(null);
              });
              resumeReq.end(stateBody);
            });
          }
          void writeInnerResponse(
            res,
            clientRes,
            forceStatus,
            responsePrefix
              ? {
                  body: responsePrefix.content ?? readFileSync(responsePrefix.filePath!),
                  ...(responsePrefix.headers ? { headers: responsePrefix.headers } : {}),
                  ...(responsePrefix.status ? { status: responsePrefix.status } : {}),
                }
              : undefined,
            normalizePrerenderCacheControl,
            resumeSuffix,
            buildFallbackBacked,
            platformCacheSeen,
          )
            .then(() => closeThenSettle(reject))
            .catch((error) => {
              server.close(() => (executionTimedOut ? resolve() : reject(error)));
            });
        },
      );

      const executionDeadline =
        executionTimeoutMs !== undefined
          ? setTimeout(() => {
              executionTimedOut = true;
              console.error(
                `[pool-server] handler for ${matchedPathname} exceeded maxDuration after ` +
                  `${executionTimeoutMs}ms — aborting the invocation`,
              );
              const error = new DeadlineExceededError(
                `handler execution timed out after ${executionTimeoutMs}ms`,
              );
              activeClientRes?.destroy(error);
              clientReq.destroy(error);
              if (!discardResponse && !res.headersSent) {
                res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
                res.end("Gateway Timeout");
              } else if (!discardResponse && !res.writableEnded) {
                res.destroy(error);
              }
              server.close(() => resolve());
            }, executionTimeoutMs)
          : undefined;
      executionDeadline?.unref?.();

      clientReq.once("error", (error) => {
        clearTimeout(invocationDeadline);
        // Cleared on EVERY exit from this handler, including the timed-out branch below: a
        // head-timeout abort used to leave the (unref'd) execution timer armed, and when it
        // fired minutes later it logged a bogus "exceeded maxDuration" for a request that
        // had already 504'd and re-destroyed the settled invocation. Clearing a timer that
        // already fired (executionTimedOut) is a no-op.
        if (executionDeadline) clearTimeout(executionDeadline);
        // N37: a deadline abort is the adapter's own teardown, not an entrypoint crash — answer
        // 504 and settle, rather than rejecting into the generic 500 path. `discardResponse`
        // invocations share the outer `res` with a response already sent to the client, so they
        // must never write; they just release the socket and the port.
        if (invocationTimedOut || executionTimedOut) {
          if (!discardResponse && !res.headersSent) {
            res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
            res.end("Gateway Timeout");
          } else if (!discardResponse && !res.writableEnded) {
            res.end();
          }
          server.close(() => resolve());
          return;
        }
        server.close(() => reject(error));
      });

      // If the outer client goes away while the handler is still computing, cancel the
      // loopback request instead of letting the invocation run to completion into a
      // dead socket. Skipped for discardResponse: that invocation is deliberately
      // detached background work (E2E PPR shell fill) that shares the outer res
      // object and must outlive the client response.
      if (!discardResponse) {
        abortOnClientClose(res, () =>
          clientReq.destroy(new Error("client disconnected during handler invocation")),
        );
      }

      if (bufferedBody && bufferedBody.length > 0) {
        clientReq.end(bufferedBody);
      } else {
        clientReq.end();
      }
    });
  });
}

export function extractRouteParams(
  matchedPathname: string,
  routeMatches: Record<string, string> | null,
  concretePathname?: string,
): Record<string, string | string[]> | undefined {
  const params: Record<string, string | string[]> = {};
  for (const match of matchedPathname.matchAll(/\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const value = routeMatches?.[name] ?? routeMatches?.[`nxtP${name}`];
    // `x-route-matches` is JSON from the trusted routing tier, not a runtime-enforced TypeScript
    // value. A buggy or skewed tier can therefore send an array/object here. Never coerce it
    // into a handler param, and never let a catch-all call `.split()` on it: an invalid routing
    // hint is a bounded missing param, not a reason for the pool to answer 500.
    if (typeof value !== "string" || value.startsWith("$nxtP")) continue;
    if (match[1]) {
      const segments = value.split("/");
      // With `trailingSlash: true`, @next/routing can preserve the terminal slash in a
      // catch-all capture (for example `a/b/`). It is a pathname delimiter, not an
      // additional empty route parameter. Keep interior empty segments untouched so this
      // normalization remains limited to the routing artifact we actually observed.
      while (segments.at(-1) === "") segments.pop();
      if (segments.length === 0) continue;
      params[name] = segments.map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    } else {
      // @next/routing transports dynamic captures in URL-encoded form. Generated entrypoints
      // expect requestMeta.params to contain the decoded segment, including an encoded slash as
      // one ordinary dynamic-param value. Catch-alls already decode each segment above; applying
      // the same single decode here prevents `%2F` becoming `%252F` during cache-key generation.
      try {
        params[name] = decodeURIComponent(value);
      } catch {
        params[name] = value;
      }
    }
  }

  // @next/routing may match a partially specialized PPR output such as
  // `/with-root-param/en/posts/[id].rsc`. Its routeMatches contains `id`, but the
  // executable handler template also needs the already-specialized root param `lang`.
  // Recover only missing values from the concrete invocation pathname.
  if (concretePathname && matchedPathname.includes("[")) {
    const names: { name: string; catchAll: boolean }[] = [];
    let pattern = "";
    const templatePathname = matchedPathname.endsWith(".rsc")
      ? matchedPathname.slice(0, -".rsc".length)
      : matchedPathname;
    for (const rawSegment of templatePathname.split("/").slice(1)) {
      // Interception markers select a route-tree branch but do not consume a public URL segment.
      // `/[locale]/(.)[username]/p/[id].rsc` therefore matches `/en/foo/p/1`; treating `(.)` or
      // the `.rsc` output suffix as pathname text prevents recovery of the otherwise-missing
      // `locale` param and makes the generated App entrypoint throw an invariant error.
      const segment = rawSegment.replace(/^(?:\(\.{1,3}\))+/, "");
      const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
      const dynamic = /^\[(.+)\]$/.exec(segment);
      if (optionalCatchAll) {
        names.push({ name: optionalCatchAll[1]!, catchAll: true });
        pattern += "(?:/(.*))?";
      } else if (catchAll) {
        names.push({ name: catchAll[1]!, catchAll: true });
        pattern += "/(.+)";
      } else if (dynamic) {
        names.push({ name: dynamic[1]!, catchAll: false });
        pattern += "/([^/]+)";
      } else {
        pattern += "/" + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    const concreteMatch = new RegExp(`^${pattern}/?$`).exec(concretePathname);
    if (concreteMatch) {
      names.forEach(({ name, catchAll }, index) => {
        if (params[name] !== undefined) return;
        const raw = concreteMatch[index + 1];
        if (raw === undefined || raw === "") return;
        const decode = (value: string) => {
          try {
            return decodeURIComponent(value);
          } catch {
            return value;
          }
        };
        if (catchAll) {
          const segments = raw.split("/");
          // The optional terminal slash belongs to the pathname, not the catch-all value.
          // This fallback is used when @next/routing's internal alias normalizes a param name
          // (for example `product-params` -> `nxtPproductparams`) and cannot be read by name.
          while (segments.at(-1) === "") segments.pop();
          if (segments.length > 0) params[name] = segments.map(decode);
        } else {
          params[name] = decode(raw);
        }
      });
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Convert the public Pages Router data protocol URL back to the page pathname used by the
 * entrypoint's request metadata. Keep `req.url` itself untouched: Pages needs to observe
 * `/_next/data/...` to negotiate JSON, while `resolvedPathname` and dynamic-param recovery must
 * describe the public page. In particular, treating `/_next/data/<id>/index.json` as the concrete
 * path for a root `[[...slug]]` route leaks the protocol segments into `params.slug`.
 */
export function pagesDataRequestPathnameToPagePath(
  pathname: string,
  i18nLocales: string[] = [],
): string | null {
  const marker = "/_next/data/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return null;

  const basePath = pathname.slice(0, markerIndex);
  const buildAndDataPath = pathname.slice(markerIndex + marker.length);
  const separatorIndex = buildAndDataPath.indexOf("/");
  if (separatorIndex < 1) return null;

  const dataPath = buildAndDataPath.slice(separatorIndex + 1);
  if (!dataPath.endsWith(".json")) return null;

  let pagePath = dataPath.slice(0, -".json".length);
  if (pagePath === "index") return basePath || "/";

  // Pages' i18n data protocol includes the locale before the actual page path
  // (`/_next/data/<id>/fr/about.json`). The generated entrypoint infers locale from the untouched
  // public URL; requestMeta.resolvedPathname must describe `/about`, otherwise a root optional
  // catch-all incorrectly receives `{ slug: ["fr"] }` during locale navigation.
  const [firstSegment, ...remainingSegments] = pagePath.split("/");
  if (i18nLocales.some((locale) => locale.toLowerCase() === firstSegment?.toLowerCase())) {
    pagePath = remainingSegments.join("/") || "index";
  }

  if (pagePath === "index") return basePath || "/";
  // `${basePath}/${pagePath}` always contains the leading "/", so it is never falsy.
  return `${basePath}/${pagePath}`;
}

function pagesDataPathToPagePath(
  pathname: string,
  basePath: string,
  buildId: string,
): string | null {
  const prefix = `${basePath}/_next/data/${buildId}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".json")) return null;
  const dataPath = pathname.slice(prefix.length, -".json".length);
  const pagePath = dataPath === "index" ? "/" : `/${dataPath}`;
  return `${basePath}${pagePath === "/" ? "" : pagePath}` || "/";
}

type LocalHandlerInvoker = typeof invokeLocalHandlerOverHttp;

// Render the best available custom 404, then fall back to plain text. Order: App Router handler
// (`/_not-found`), Pages Router handler (`/404`), a prerendered Pages Router `/404.html` from the
// static manifest, then plain text. Previously only `/_not-found` was attempted, so a pages-router
// app with a custom `pages/404` (which prerenders to a static `404.html`) got a bare "Not Found".
// Mirrors upstream next/src/server/lib/is-non-html-sec-fetch-dest.ts (canary.97): request
// destinations that cannot display HTML. Excludes `document`/`iframe` (HTML-capable) and
// `empty` (fetch()/XHR, including RSC requests) — and absent headers, which must keep full
// handler semantics.
const NON_HTML_SEC_FETCH_DESTS = new Set([
  "audio",
  "audioworklet",
  "font",
  "image",
  "json",
  "manifest",
  "paintworklet",
  "report",
  "script",
  "serviceworker",
  "sharedworker",
  "style",
  "track",
  "video",
  "webidentity",
  "worker",
  "xslt",
]);

function isNonHtmlSecFetchDest(req: IncomingMessage): boolean {
  const dest = req.headers["sec-fetch-dest"];
  return typeof dest === "string" && NON_HTML_SEC_FETCH_DESTS.has(dest);
}

async function serveNotFound(
  handlerLoader: HandlerLoader,
  localHandlerInvoker: LocalHandlerInvoker,
  staticAssets: StaticAssetEntry[],
  req: IncomingMessage,
  res: ServerResponse,
  bufferedBody: Buffer | undefined,
  basePath = "",
  notFoundIsPrerendered = false,
  distDir = path.join(process.cwd(), ".next"),
): Promise<void> {
  // Deploy contract (upstream not-found-non-document, canary.97): for non-HTML subresource
  // requests (sec-fetch-dest: image/font/manifest/…) the deployed routing layer serves the
  // PRERENDERED App Router /_not-found "without invoking Next.js" (the upstream test's own
  // comment — Vercel's CDN behavior). Invoking the /_not-found entrypoint instead runs
  // base-server's new isNonHtmlSecFetchDest branch, which answers text/plain — `next start`
  // semantics, where the deploy branch asserts text/html from the prerender. Deliberately
  // SCOPED to that request class: document/RSC/fetch requests keep the proven handler path
  // (fresh render, draft-capable). Two prerender sources, in order: the static-assets
  // manifest entry, then the build artifact on disk — the build's INJECTED /_not-found has
  // no source file, so its adapter output carries no fallback.filePath and no asset entry
  // is emitted, but `.next/server/app/_not-found.html` is always staged with the app.
  const nonHtmlSubresource = isNonHtmlSecFetchDest(req);
  if (nonHtmlSubresource) {
    const prerenderedNotFound = staticAssets.find(
      (a) =>
        (a.pathname === (basePath ? `${basePath}/_not-found` : "/_not-found") ||
          a.pathname === "/_not-found") &&
        (a as { prerender?: boolean }).prerender,
    );
    const candidates = [
      ...(prerenderedNotFound ? [path.resolve(process.cwd(), prerenderedNotFound.filePath)] : []),
      path.join(distDir, "server", "app", "_not-found.html"),
    ];
    for (const fullPath of candidates) {
      if (existsSync(fullPath) && !res.writableEnded) {
        res.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
          ...(prerenderedNotFound?.headers as Record<string, string> | undefined),
        });
        res.end(readFileSync(fullPath));
        return;
      }
    }
  }
  // The platform prerender candidates missed (canary cache-components builds emit no
  // _not-found.html artifact at all) — the handler is the fallback, and it must render the
  // HTML DOCUMENT: base-server's isNonHtmlSecFetchDest branch would answer text/plain,
  // breaking the deploy contract (not-found-non-document expects text/html deployed). The
  // subresource decision was the platform's and it was already made above.
  if (nonHtmlSubresource && notFoundIsPrerendered) {
    delete req.headers["sec-fetch-dest"];
  }
  const notFoundPaths = [
    ...(basePath ? [`${basePath}/_not-found`, `${basePath}/404`] : []),
    "/_not-found",
    "/404",
  ];
  for (const notFoundPath of notFoundPaths) {
    if (!handlerLoader.has(notFoundPath)) continue;
    try {
      const handler = await handlerLoader.load(notFoundPath);
      await localHandlerInvoker({
        handler,
        req,
        res,
        matchedPathname: notFoundPath,
        routeMatches: null,
        bufferedBody,
        // A Pages Router `/404` entrypoint renders like a normal page, so force the status here.
        forceStatus: 404,
        // …and tell the RENDER it is a 404: Next emits the default not-found metadata
        // (robots noindex) only when the render itself knows the status
        // (metadata-navigation "root not-found with default metadata").
        invokeStatus: 404,
      });
      return;
    } catch (error) {
      // A broken custom 404 must not take down the request, but swallowing this made adapter
      // contract mismatches indistinguishable from a genuinely absent not-found output.
      console.error(`[pool-server] failed to invoke not-found handler ${notFoundPath}:`, error);
      // Fall through to the next candidate or the prerendered 404.
    }
  }
  // Prerendered Pages Router 404 (static `404.html`) — serve its body with a 404 status.
  const prerendered404 = staticAssets.find(
    (a) => a.pathname === (basePath ? `${basePath}/404` : "/404") || a.pathname === "/404",
  );
  if (prerendered404) {
    const fullPath = path.resolve(process.cwd(), prerendered404.filePath);
    if (existsSync(fullPath) && !res.writableEnded) {
      res.writeHead(404, {
        "content-type": "text/html; charset=utf-8",
        ...(prerendered404.headers as Record<string, string> | undefined),
      });
      res.end(readFileSync(fullPath));
      return;
    }
  }
  // Some Pages builds (notably an app-wide getInitialProps) expose no standalone `/404` output:
  // Next's router renders the 404 through `/_error` with invokeStatus metadata. This is the
  // documented entrypoint contract, and must come after an explicit/prerendered custom 404.
  if (handlerLoader.has("/_error")) {
    try {
      const handler = await handlerLoader.load("/_error");
      await localHandlerInvoker({
        handler,
        req,
        res,
        matchedPathname: "/_error",
        routeMatches: null,
        bufferedBody,
        invokeStatus: 404,
        forceStatus: 404,
      });
      return;
    } catch (error) {
      console.error("[pool-server] failed to invoke Pages /_error for not-found:", error);
    }
  }
  if (!res.writableEnded) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

// Edge route runner: uses Next.js's edge sandbox to execute edge-compiled route handlers.
// Returns a web Response which we convert back to Node's ServerResponse.
type EdgeRouteRunner = (params: {
  name: string;
  paths: string[];
  request: Record<string, unknown>;
}) => Promise<{ response: Response; waitUntil: Promise<void> }>;

export interface DispatcherOptions {
  handlerLoader: HandlerLoader;
  poolName: string;
  buildId: string;
  staticAssets: StaticAssetEntry[];
  releaseName?: string;
  localHandlerInvoker?: LocalHandlerInvoker;
  edgeRouteRunner?: EdgeRouteRunner | null;
  pprRoutes?: Record<
    string,
    {
      postponedState: string;
      fallbackFilePath: string;
      chainHeaders?: Record<string, string>;
      initialHeaders?: Record<string, string | string[]>;
      initialStatus?: number;
      tags?: string[];
      /** Params partitioning the platform cache key (build's allowQuery) — seen-key registry. */
      allowQuery?: string[];
    }
  >;
  /** N16: PPR-capable route templates with no build-emitted fallback shell (`fallback: null`),
   * each tagged with unresolved root params. See the RoutingManifest doc comment in types.ts.
   * Root-param templates run non-minimal. The no-root-param flavour stays minimal and completes
   * a postponed response through the runtime capture-and-resume path. `| undefined` is explicit:
   * older manifests have no such key. */
  pprCapableRoutes?: Record<string, { rootParams: string[]; allowQuery?: string[] }> | undefined;
  /** Returns true if any of a PPR shell's baked cache tags have been revalidated since deploy (read
   * live from the shared Valkey manifest). Used only when NO classic incremental cacheHandler is
   * registered (e.g. an edge-middleware app): it withholds the stale build-time postponed token so
   * `revalidateTag` still forces a fresh shell render. Absent when there's no shared cache. */
  checkShellStale?: (tags: string[]) => Promise<boolean>;
  /**
   * True when the BUILD prerendered `/_not-found` (a cache-components build). Upstream's
   * deployed contract then serves that prerender for non-HTML subresource requests
   * ("without invoking Next.js" — not-found-non-document), so if the artifact cannot be
   * found the handler must still render the HTML DOCUMENT. A dynamic app prerenders no
   * not-found and keeps `next start`'s text/plain answer (not-found-non-document-dynamic).
   */
  notFoundIsPrerendered?: boolean;
  /**
   * `next.config.partialPrefetching` — the app opts into the partialFallback serving
   * contract (on-demand shell specialization, entry sharing across never-prerenderable
   * params). The adapter implements NONE of it, and minimal+inject actively harms these
   * builds by freezing one generic shell where Next's own non-minimal path specializes per
   * param set (cache-components-prerender-matrix: 3/60 -> 13/60 when injection landed at
   * baseline v6). Until partialFallback is implemented, leave those routes to Next.
   */
  partialPrefetching?: boolean;
  /**
   * The platform's own view of the shared incremental cache (Valkey classic handler): the
   * serve ladder READS materialized/seed entries through it (get() owns tag staleness).
   * READ-ONLY by design: regeneration goes through the registered `revalidate()` re-entry,
   * whose render persists entries via Next's own cache handler — a direct entry-capture
   * write half was tried and REVERTED (an entry captured from a minimal render is not
   * equivalent to next start's response-cache write; see the materialization dead-end
   * record). Regeneration authorization uses `process.env.__NEXT_PREVIEW_MODE_ID`.
   */
  platformCache?: {
    read: (
      key: string,
      ctx?: { kind?: string },
    ) => Promise<{ lastModified?: number | undefined; value: unknown } | null>;
    /** Like read() but STORED entries only (no seed fallback) — a revalidation's output.
     * `isStale` = soft-stale (tag or age, single-flight lock-gated): serve it AND schedule
     * a regeneration behind it (SWR), never suppress the regen because an entry exists. */
    readStored?: (
      key: string,
      ctx?: { kind?: string },
    ) => Promise<{
      lastModified?: number | undefined;
      value: unknown;
      isStale?: boolean;
    } | null>;
    /** SEED-only read (build artifacts, no stored entries) — the template-shell rung, where
     * a stored entry must never answer (it would share one sibling's page across the route). */
    readSeed?: (
      key: string,
      ctx?: { kind?: string },
    ) => Promise<{ lastModified?: number | undefined; value: unknown } | null>;
  };
  rscConfig?: RscConfig | undefined;
  /** All output ids in this pool's manifest — used to map concrete prerender
   * paths back to their dynamic-route template handler (outputs of dynamic
   * routes are keyed by template, e.g. "/blog/[slug]"). */
  outputIds?: string[];
  /** Dynamic routes with fallback:false / dynamicParams:false — a matching path
   * not in prerenderedPaths must 404 (mirrors `next start`). */
  strictDynamicRoutes?: { pageRegex: RegExp }[];
  /** App route TEMPLATES whose prerender-manifest entry has `fallback: null` — Next may
   * statically GENERATE never-prerendered concrete paths at runtime. Under a shared cache
   * these render non-minimal so Next's own response-cache write materializes them
   * (`next start` parity; a minimal render never writes). */
  runtimeStaticTemplates?: Set<string>;
  prerenderedPaths?: Set<string>;
  buildIdForData?: string;
  /** Build timestamp (ISO) from the routing manifest — anchors the ISR seed-freshness
   * window to build time rather than pod start. Absent in older manifests → pod start. */
  builtAt?: string | undefined;
  /** Bounded wait for proxied upstreams (external rewrite / cross-pool). Defaults to
   * PROXY_TIMEOUT_MS; injectable so tests don't wait out the real budget. */
  proxyTimeoutMs?: number | undefined;
  /** N37: bound on time-to-response-head for a LOCAL handler invocation. Defaults to
   * HANDLER_TIMEOUT_MS (ADAPTER_K8S_HANDLER_TIMEOUT_MS); injectable for the same reason. */
  handlerTimeoutMs?: number | undefined;
  /** Build-derived route execution and pool response-head budgets. */
  routeExecutionTimeouts?: Record<string, number> | undefined;
  poolResponseHeadTimeouts?: Record<string, number> | undefined;
  /** Shared secret used to authenticate cluster-internal cross-pool dispatch headers. */
  internalSecret?: string | undefined;
  /**
   * This build's proof-covered request headers (routing-common.ts `buildProofHeaderNames`) —
   * covered by the dispatch proof, so a cross-pool hop must sign with the same list the receiving
   * pool verifies with. Both come from the one build's manifest.
   */
  proofHeaderNames?: readonly string[] | undefined;
  /** True when a classic incremental `cacheHandler` is registered (via next.config.cacheHandler)
   * and therefore owns the PPR shell. When set, we DON'T inject the build-time postponed token —
   * the incremental cache serves + revalidates the shell instead. This must track the SAME build
   * decision that registers the handler (cache enabled AND no edge middleware), not merely whether
   * VALKEY_URL is present: a cache + edge-middleware app has VALKEY_URL but no classic handler, and
   * must keep injecting to preserve PPR resume. */
  incrementalCacheShared?: boolean;
  /** Test-harness-only equivalent of `incrementalCacheShared`: let the Next entrypoint own PPR
   * shell lookup/upgrades using its built-in filesystem cache. The real adapter must use the
   * registered Valkey incremental handler for this role; this option only simulates that missing
   * platform layer in Next's local deploy E2E and must never be enabled in production. */
  entrypointOwnsPprShell?: boolean;
  /** Test-harness-only stand-in for the platform cache miss/hit lifecycle. Production must leave
   * this false: Valkey, never process-local memory, owns mutable fallback materialization. */
  emulatePlatformCache?: boolean;
  /** Re-enter the pool request pipeline for Pages API `res.revalidate()` without a network hop. */
  revalidate?: Revalidate;
  /** Configured public basePath. Output ids and static 404 assets may be basePath-prefixed. */
  basePath?: string;
  /** Absolute validated Next build directory. */
  distDir?: string;
  /** Configured Pages Router locales, used to keep locale protocol prefixes out of route params. */
  i18nLocales?: string[];
}

export function createDispatcher(options: DispatcherOptions) {
  const {
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName = "nextjs",
    localHandlerInvoker = invokeLocalHandlerOverHttp,
    edgeRouteRunner = null,
    pprRoutes = {},
    pprCapableRoutes: pprCapableRouteMap = {},
    rscConfig,
    outputIds = [],
    strictDynamicRoutes = [],
    runtimeStaticTemplates = new Set<string>(),
    prerenderedPaths = new Set<string>(),
    buildIdForData = "",
    internalSecret,
    proofHeaderNames,
    incrementalCacheShared = false,
    entrypointOwnsPprShell = false,
    emulatePlatformCache = false,
    checkShellStale,
    notFoundIsPrerendered = false,
    partialPrefetching = false,
    platformCache,
    revalidate,
    basePath = "",
    distDir = path.join(process.cwd(), ".next"),
    i18nLocales = [],
    builtAt,
    proxyTimeoutMs = PROXY_TIMEOUT_MS,
    handlerTimeoutMs = HANDLER_TIMEOUT_MS,
    routeExecutionTimeouts = {},
    poolResponseHeadTimeouts = {},
  } = options;

  // Anchor the ISR seed-freshness window to BUILD time, not pod start: a pod
  // (re)started long after the build must not re-serve a stale seed as "fresh" for
  // another full revalidate window. Older manifests carry no builtAt — fall back to
  // pod start (the previous behavior). A garbage timestamp parses to NaN → same fallback.
  const builtAtMs = builtAt ? Date.parse(builtAt) : Number.NaN;
  const deployedAt = Number.isFinite(builtAtMs) ? builtAtMs : Date.now();
  // In-flight canonical regenerations, one per platform-cache key (bounded backstop — a
  // stampede of distinct stale keys must not fan out unbounded background renders).
  const MAX_PENDING_REGENS = 64;
  const pendingRegens = new Set<string>();
  // The Vary header every RSC-flavored platform response carries (mirrors the entrypoints).
  const RSC_VARY_HEADER =
    "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";
  // N16: every shell-less PPR template (used only to recognize the route as PPR), and the
  // root-param subset that must actually run NON-minimal. Splitting these was the fix for
  // app-dir/fallback-shells: treating ALL shell-less PPR templates as non-minimal made Next
  // resume a fallback shell for `without-suspense`/`without-io` routes, which upstream renders
  // dynamically (it answered `x-nextjs-postponed: 1` and a build-time root layout).
  const pprCapableRoutes = new Set(Object.keys(pprCapableRouteMap));
  // The platform seen-key registry. Upstream's contract proves cache-
  // entry sharing THROUGH x-vercel-cache — a key's first serve is PRERENDER/MISS, every
  // later serve of the SAME key (params outside allowQuery mutated) is HIT, even when the
  // entry contributes zero bytes. Keyed template + allowQuery-param values; only routes
  // whose build declared allowQuery participate (bounded, and plain dynamic routes never
  // register). In-process per pool: the harness runs one pool; production cross-replica
  // consistency can later back this with Valkey (SETNX) — see plans/prerender-matrix-catchup.md.
  const PLATFORM_KEY_REGISTRY_CAP = 10_000;
  const platformSeenKeys = new Set<string>();
  function checkAndRecordPlatformKey(key: string): boolean {
    if (platformSeenKeys.has(key)) return true;
    if (platformSeenKeys.size >= PLATFORM_KEY_REGISTRY_CAP) {
      const oldest = platformSeenKeys.values().next().value;
      if (oldest !== undefined) platformSeenKeys.delete(oldest);
    }
    platformSeenKeys.add(key);
    return false;
  }
  // The platform RESPONSE store, for FULLY-KEYED entries only (allowQuery
  // covers every template param → the entry is fully static and the platform must replay
  // the stored bytes on a seen key — on Vercel this replay lives in the edge cache, which
  // the per-request x-invocation-id correctly scopes away from the lambda LRU). Partial
  // keys re-render per request and prove sharing through the header alone. Bounded both
  // ways; an over-size body is simply not stored (every serve stays correct, later serves
  // re-render).
  const PLATFORM_STORE_CAP = 500;
  const PLATFORM_STORE_MAX_BODY = 2 * 1024 * 1024;
  const platformResponseStore = new Map<
    string,
    { status: number; headers: Record<string, string | string[]>; body: Buffer }
  >();
  function storePlatformResponse(
    key: string,
    entry: { status: number; headers: Record<string, string | string[]>; body: Buffer },
  ): void {
    if (entry.body.length > PLATFORM_STORE_MAX_BODY) return;
    if (platformResponseStore.size >= PLATFORM_STORE_CAP) {
      const oldest = platformResponseStore.keys().next().value;
      if (oldest !== undefined) platformResponseStore.delete(oldest);
    }
    platformResponseStore.set(key, entry);
  }
  const TEMPLATE_PARAM_RE = /\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g;
  function templateParamNames(template: string): string[] {
    return [...template.matchAll(TEMPLATE_PARAM_RE)]
      .map((m) => m[1] ?? m[2])
      .filter((name): name is string => !!name);
  }
  // Option D eligibility (spec rev 4): shell-less PPR templates with NO unresolved root params
  // — the class whose minimal render can postpone with nothing to resume it. Root-param
  // templates are excluded (they already run non-minimal for their own documented reason).
  const pprCapableResumeRoutes = new Set(
    Object.entries(pprCapableRouteMap)
      .filter(([, entry]) => (entry.rootParams?.length ?? 0) === 0)
      .map(([route]) => route),
  );
  const pprRootParamRoutes = new Set(
    Object.entries(pprCapableRouteMap)
      .filter(([, entry]) => (entry.rootParams?.length ?? 0) > 0)
      .map(([route]) => route),
  );
  // N13, NEXT_ENABLE_ADAPTER-only (emulatePlatformCache): dynamic-route templates that own
  // at least one BUILD-TIME prerender (generateStaticParams) — the SSG/ISR app routes whose
  // concrete instances a real platform cache would materialize. The harness has no platform
  // cache, so those requests must run NON-minimal and let Next's own filesystem incremental
  // cache own them and report x-nextjs-cache MISS/STALE/HIT like `next start`. Precomputed
  // once; only the membership test runs per request.
  //
  // PRODUCTION FIX (attempt 2, 2026-07-30): the three incrementalCacheShared additions here
  // and below, plus seed-serving static pages (serveConcretePrerenderSeed) with an
  // x-vercel-cache verdict. The bug: these rungs were harness-only, so with Valkey configured
  // every plain SSG/static app page ran MINIMAL — the entrypoint re-rendered per request and
  // emitted no x-nextjs-cache (Next gates it on !isMinimalMode), while the adapter's
  // `max-age=0, must-revalidate` kept Cloud CDN out. MEASURED on GKE, same pod/build:
  // VALKEY_URL set -> 3 requests, 3 renders, MISS; unset -> 1 render, HIT x3.
  //
  // Attempt 1 (reverted) flipped ONLY these rungs. Measured against upstream app-static on
  // GKE: fixed force-static(lazy), broke dynamicParams:false + navigate-to-static-path,
  // untouched the five header/revalidate failures — because with Valkey EMPTY at deploy
  // (a custom cacheHandler never reads build artifacts off disk, unlike the harness's
  // filesystem cache) every first request was still a rendered MISS. Attempt 2 adds the
  // missing platform half: build seeds are served for static pages while fresh and not
  // tag-stale, so the first request answers from the artifact like `next start`.
  // incrementalCacheShared is FALSE in the upstream harness (no adapter config -> no
  // registered handler), so none of this moves the pool-only baseline.
  const emulatedSsgTemplates =
    emulatePlatformCache || incrementalCacheShared
      ? new Set(
          staticAssets
            .filter((asset) => asset.prerender && !asset.ppr)
            .flatMap((asset) => templateOutputCandidates(asset.pathname, outputIds)),
        )
      : new Set<string>();
  // NEXT_ENABLE_ADAPTER-only bookkeeping (unreachable in production — the add site is
  // gated on emulatePlatformCache): one shell-served marker per concrete URL. Cap it so
  // a long-lived harness pod crawling many URLs can't grow it without bound. Eviction
  // only means the harness re-serves a build shell for that URL; production never sees it.
  const MAX_SERVED_FALLBACK_SHELLS = 10_000;
  const servedFallbackShells = new Set<string>();

  // #42 production shell-fill dedupe: one background upgrade attempt per URL per window.
  // Segment prefetches arrive per client navigation, so without this every prefetch of a
  // fallback-served URL would fan out a full document render. Bounded like the marker set
  // above; eviction only means one extra (idempotent) upgrade attempt for that URL.
  const SHELL_FILL_COOLDOWN_MS = 60_000;
  const MAX_SHELL_FILL_URLS = 10_000;
  const shellFillLastAttempt = new Map<string, number>();
  const shellFillCooldownAllows = (url: string): boolean => {
    const now = Date.now();
    const last = shellFillLastAttempt.get(url);
    if (last !== undefined && now - last < SHELL_FILL_COOLDOWN_MS) return false;
    if (shellFillLastAttempt.size >= MAX_SHELL_FILL_URLS) {
      const oldest = shellFillLastAttempt.keys().next().value;
      if (oldest !== undefined) shellFillLastAttempt.delete(oldest);
    }
    // Delete-then-set so a refreshed URL moves to the back of the insertion order — the
    // capped eviction above stays an approximate-LRU instead of evicting hot URLs.
    shellFillLastAttempt.delete(url);
    shellFillLastAttempt.set(url, now);
    return true;
  };

  // Pages entrypoints call requestMeta.render404 when getStaticProps/getServerSideProps returns
  // notFound. In a custom adapter there is no Next router-server above the entrypoint, so provide
  // that missing layer explicitly and render into the SAME response. This also preserves request
  // metadata (locale, original URL, cookies) already attached by the calling pages entrypoint.
  const render404FromEntrypoint: Render404 = async (req, res) => {
    if (res.writableEnded) return;

    const renderHandler = async (notFoundPath: string): Promise<boolean> => {
      if (!handlerLoader.has(notFoundPath)) return false;
      try {
        const handler = await handlerLoader.load(notFoundPath);
        res.statusCode = 404;
        const maybeResult = await (handler as any)(req, res, {
          waitUntil(waitable: Promise<unknown>) {
            void waitable.catch(() => undefined);
          },
          requestMeta: {
            relativeProjectDir: ".",
            hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
            outputId: notFoundPath,
            matchedPathname: notFoundPath,
            routeMatches: null,
            invokeStatus: 404,
          },
        });
        if (maybeResult instanceof Response) {
          await writeWebResponseToNode(res, maybeResult, 404);
        } else if (!res.writableEnded) {
          res.end();
        }
        return true;
      } catch (error) {
        console.error(`[pool-server] failed to render ${notFoundPath}:`, error);
        return false;
      }
    };

    const notFoundPaths = [
      ...(basePath ? [`${basePath}/_not-found`, `${basePath}/404`] : []),
      "/_not-found",
      "/404",
    ];
    for (const notFoundPath of notFoundPaths) {
      if (await renderHandler(notFoundPath)) return;
    }

    // A Pages Router custom 404 is commonly fully prerendered and therefore
    // has no runtime handler. It must win over the generic `/_error` function.
    const prerendered404 = staticAssets.find(
      (asset) =>
        asset.pathname === (basePath ? `${basePath}/404` : "/404") || asset.pathname === "/404",
    );
    if (prerendered404) {
      const fullPath = path.resolve(process.cwd(), prerendered404.filePath);
      if (existsSync(fullPath)) {
        res.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
          ...(prerendered404.headers as Record<string, string> | undefined),
        });
        res.end(readFileSync(fullPath));
        return;
      }
    }

    if (await renderHandler("/_error")) return;

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("This page could not be found");
  };

  const renderErrorFromEntrypoint: RenderError = async (req, res, error) => {
    if (res.writableEnded) return;

    const renderErrorHandler = async (errorPath: string): Promise<boolean> => {
      if (!handlerLoader.has(errorPath)) return false;
      try {
        const handler = await handlerLoader.load(errorPath);
        res.statusCode = 500;
        const maybeResult = await (handler as any)(req, res, {
          waitUntil(waitable: Promise<unknown>) {
            void waitable.catch(() => undefined);
          },
          requestMeta: {
            relativeProjectDir: ".",
            hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
            outputId: errorPath,
            matchedPathname: errorPath,
            routeMatches: null,
            invokeError: error,
            invokeStatus: 500,
          },
        });
        if (maybeResult instanceof Response) {
          await writeWebResponseToNode(res, maybeResult, 500);
        } else if (!res.writableEnded) {
          res.end();
        }
        return true;
      } catch (renderError) {
        console.error(`[pool-server] failed to render ${errorPath}:`, renderError);
        return false;
      }
    };

    if (await renderErrorHandler("/500")) return;

    // A custom Pages /500 is normally fully prerendered and may therefore have no callable output
    // in the adapter build. It must win over Next's generic /_error entrypoint just as a static
    // custom /404 wins on not-found. The original page error has already been logged upstream.
    const prerendered500 = staticAssets.find(
      (asset) =>
        asset.pathname === (basePath ? `${basePath}/500` : "/500") || asset.pathname === "/500",
    );
    if (prerendered500) {
      const fullPath = path.resolve(process.cwd(), prerendered500.filePath);
      if (existsSync(fullPath)) {
        res.writeHead(500, {
          "content-type": "text/html; charset=utf-8",
          ...(prerendered500.headers as Record<string, string> | undefined),
        });
        res.end(readFileSync(fullPath));
        return;
      }
    }

    if (await renderErrorHandler("/_error")) return;

    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  };

  return {
    async dispatch(
      req: IncomingMessage,
      res: ServerResponse,
      resolution: ResolveResult,
    ): Promise<void> {
      // A client that disconnects mid-response emits 'error' on the socket; without a
      // listener Node crashes the process. Guard the outer client response up front.
      guardStreamErrors(res);

      const configuredRequestHeadTimeoutMs =
        resolution.kind === "route"
          ? (poolResponseHeadTimeouts[resolution.pool] ?? handlerTimeoutMs)
          : handlerTimeoutMs;
      const configuredExecutionTimeoutMs =
        resolution.kind === "route"
          ? routeExecutionTimeouts[resolution.matchedPathname]
          : undefined;
      const localExecutionDeadlineAt =
        configuredExecutionTimeoutMs !== undefined
          ? Date.now() + configuredExecutionTimeoutMs
          : undefined;
      const propagatedExecutionDeadlineAt =
        resolution.kind === "route" ? resolution.executionDeadlineAt : undefined;
      const executionDeadlineAt =
        localExecutionDeadlineAt !== undefined && propagatedExecutionDeadlineAt !== undefined
          ? Math.min(localExecutionDeadlineAt, propagatedExecutionDeadlineAt)
          : (localExecutionDeadlineAt ?? propagatedExecutionDeadlineAt);
      const remainingExecutionMs =
        executionDeadlineAt !== undefined
          ? Math.max(1, executionDeadlineAt - Date.now())
          : undefined;
      const requestHeadTimeoutMs =
        remainingExecutionMs !== undefined
          ? Math.min(configuredRequestHeadTimeoutMs, remainingExecutionMs)
          : configuredRequestHeadTimeoutMs;

      // base-server deletes the RSC cache-busting param NEXT_RSC_UNION_QUERY ('_rsc') from
      // the render query (base-server.ts:2719-2722) — it exists only to partition
      // browser/CDN caches. The generated entrypoint parses req.url directly under our
      // loopback, so the param must come off HERE: left on, the entrypoint saw an
      // unexpected query param, ssgCacheKey went null, and the stale-entry background
      // revalidation never armed (resume-data-cache: stale-forever under the suite's
      // cache-busted fetches while the identical param-less sequence passed).
      if (
        req.url !== undefined &&
        req.headers[options.rscConfig?.header ?? "rsc"] === "1" &&
        req.url.includes("_rsc=")
      ) {
        const u = new URL(req.url, "http://localhost");
        if (u.searchParams.has("_rsc")) {
          u.searchParams.delete("_rsc");
          req.url = `${u.pathname}${u.search}`;
        }
      }

      // Pages Router uses this response header to interpret middleware data-request
      // preflights and retain the matched route template. Next's router-server sets
      // it for both static and dynamic data routes.
      // N10: requestTargetPathname, not `new URL(target, base)` — a `//…` target would
      // otherwise throw (bare `//`) or be misread as an authority. See routing-common.
      const requestPathname = req.url ? requestTargetPathname(req.url) : "";
      const isPagesDataRequest = requestPathname.startsWith(`${basePath}/_next/data/`);
      if (resolution.kind === "route" && isPagesDataRequest) {
        const publicMatchedPathname = stripBasePath(resolution.matchedPathname, basePath);
        res.setHeader(
          "x-nextjs-matched-path",
          publicMatchedPathname === "/index" ? "/" : publicMatchedPathname,
        );
      }

      // Install writeHead wrapper early to merge resolved headers (from routing/middleware)
      // into ANY response — static assets, handler responses, and 404s (middleware
      // next() headers must reach the response even when no route matches).
      if (
        (resolution.kind === "route" ||
          resolution.kind === "not-found" ||
          resolution.kind === "external-rewrite") &&
        resolution.resolvedHeaders
      ) {
        installResolvedResponseHeaders(res, resolution.resolvedHeaders);
      }

      // Resolve the handler output id up front (shared by the static fast path
      // decision and the route dispatch below). Prerendered RSC variants
      // (.rsc / segment payloads) have no handler of their own — fall back to
      // the parent page handler, which serves the flight payload based on the
      // rsc request headers.
      let handlerPathname = resolution.kind === "route" ? resolution.matchedPathname : "";
      if (resolution.kind === "route" && !handlerLoader.has(handlerPathname)) {
        const candidates = [
          ...(basePath && handlerPathname === basePath ? [`${basePath}/index`] : []),
          // Pages Router's root function output is keyed as `/index`, while
          // public requests and prerenders use `/`.
          ...(handlerPathname === "/" ? ["/index"] : []),
          ...rscParentCandidates(handlerPathname, rscConfig),
          // Concrete prerender paths (e.g. "/blog/hello") map back to their
          // dynamic-route template handler ("/blog/[slug]") — ISR regeneration
          // and server actions on prerendered dynamic routes need the function.
          ...templateOutputCandidates(handlerPathname, outputIds),
        ];
        for (const candidate of candidates) {
          if (handlerLoader.has(candidate)) {
            handlerPathname = candidate;
            break;
          }
        }
      }
      const hasHandler = resolution.kind === "route" && handlerLoader.has(handlerPathname);
      const handlerOutputInfo = hasHandler ? handlerLoader.get(handlerPathname) : undefined;

      // Pages Router marks speculative middleware data requests explicitly. A
      // dynamic page must not run GSSP during that prefetch: Next returns an
      // empty, non-cacheable result with x-middleware-skip so the client will
      // perform the real request on navigation. In adapter/minimal mode the
      // generated entrypoint can classify the rewritten data URL as SSG, so
      // enforce the documented router protocol at the dispatch boundary where
      // the prerender inventory is authoritative.
      if (
        resolution.kind === "route" &&
        isPagesDataRequest &&
        req.headers["x-middleware-prefetch"]
      ) {
        // N12: `x-nextjs-rewrite` carries the PUBLIC page path of the rewrite destination
        // (`next start` parity — see pagesRewriteSignalPath in resolve.ts). Accept the
        // legacy `/_next/data/<buildId>/….json` form too: parse a data URL when it is
        // one, otherwise treat the path itself as the page path — otherwise every
        // prefetch would bail even when the rewrite target IS prerendered.
        const rewrittenTarget = resolution.resolvedHeaders?.get("x-nextjs-rewrite");
        const rewrittenPathname = rewrittenTarget
          ? new URL(rewrittenTarget, "http://localhost").pathname
          : undefined;
        const dataPagePath =
          rewrittenPathname !== undefined
            ? (pagesDataPathToPagePath(rewrittenPathname, basePath, buildIdForData || buildId) ??
              rewrittenPathname)
            : pagesDataPathToPagePath(requestPathname, basePath, buildIdForData || buildId);
        const isPrerendered =
          dataPagePath !== null &&
          staticAssets.some(
            (asset) =>
              asset.prerender &&
              (asset.pathname === dataPagePath ||
                stripBasePath(asset.pathname, basePath) === stripBasePath(dataPagePath, basePath)),
          );
        if (!isPrerendered) {
          res.writeHead(200, {
            "x-middleware-skip": "1",
            "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
            "content-type": "application/json; charset=utf-8",
          });
          res.end("{}");
          return;
        }
      }

      // 1. Serve static assets from the manifest — build assets, public/ files,
      // and prerenders that have NO handler (fully-static pages-router SSG emits
      // no function; the build file is the only source and can never be
      // revalidated). Prerenders WITH a handler always go through it: Next's
      // incremental cache serves hits cheaply and owns all the semantics the
      // manifest file can't (ISR staleness, revalidatePath/Tag — including from
      // after(), draft mode, PPR resume). Non-GET/HEAD methods also fall
      // through — server actions POST to the page's own pathname.
      let dispatchStaticAsset: (typeof staticAssets)[number] | undefined;
      if (resolution.kind === "route") {
        const mp = resolution.matchedPathname;
        const isRSC = req.headers[rscConfig?.header ?? "rsc"] === "1";
        const staticAsset = staticAssets.find(
          (a) =>
            a.pathname === mp ||
            a.pathname === (mp.endsWith("/") ? mp.slice(0, -1) : mp + "/") ||
            // The Pages Router root prerender is keyed "/index"; a request
            // resolved to "/" (now that "/" is a recognized page) must find it.
            (mp === "/" && a.pathname === "/index") ||
            // Fully-static root outputs may remain keyed as `/` while public
            // routing resolves the configured basePath root (for example `/docs`).
            (basePath && mp === basePath && (a.pathname === "/" || a.pathname === "/index")) ||
            (basePath && mp === basePath && a.pathname === `${basePath}/index`) ||
            // RSC requests: serve the .rsc prerendered payload if available
            (isRSC && a.pathname === mp + ".rsc"),
        );
        dispatchStaticAsset = staticAsset;
        const isReadMethod = req.method === "GET" || req.method === "HEAD";
        // N38 (SECURITY): a VERIFIED credential, not a cookie-name substring. This gate used to be
        // `(req.headers.cookie ?? "").includes("__prerender_bypass=")`, so any client — including
        // one sending `Cookie: not__prerender_bypass=x` — disabled the seed/shell fast paths and
        // forced a full render on every request (cheap CPU amplification, plus a way to keep a
        // shared-cache seed from ever being used). isVerifiedPreviewRequest implements upstream's
        // actual scheme: a constant-time match against this build's random previewModeId, for the
        // bypass cookie AND the on-demand-revalidate header, and never honored when the build
        // produced no preview identity.
        const isPreviewRequest = isVerifiedPreviewRequest(req);
        // Handler-less prerenders (pages SSG emits no function) are served from
        // the manifest file for GET/HEAD only. A POST to a fully-static page 405s
        // below — that IS upstream behavior: `next start` answers non-GET/HEAD on a
        // static Pages prerender with 405 + `Allow: GET, HEAD` (verified against the
        // Next 16.2 renderToResponse path; the "upstream serves SSG on POST too" note
        // that used to live here was wrong). The serve itself stays restricted to
        // this pool's own routes; a wrong-pool guess must fall through so proxyToPool
        // can recover (PPR shells especially must not be served incomplete by a
        // non-owning pool). Build assets and public/ files stay GET/HEAD-only too:
        // upstream 404s writes to them.
        const serveHandlerlessPrerender =
          staticAsset?.prerender && !hasHandler && resolution.pool === poolName;
        // A concrete non-PPR prerender under a dynamic template is the initial response-cache
        // seed. Serve it while its build-time revalidate window is fresh; after expiry (or shared
        // tag invalidation), the handler regenerates and onCacheEntryV2 owns later completed
        // entries. PPR artifacts still require shell + resume and never take this path.
        const seedRevalidate = staticAsset?.revalidate;
        const seedWithinRevalidateWindow =
          seedRevalidate === false ||
          (typeof seedRevalidate === "number" &&
            seedRevalidate > 0 &&
            Date.now() - deployedAt < seedRevalidate * 1000);
        const rawSeedTags = staticAsset?.headers?.["x-next-cache-tags"];
        const seedTags =
          typeof rawSeedTags === "string"
            ? rawSeedTags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean)
            : [];
        const seedTagsStale =
          seedWithinRevalidateWindow && checkShellStale && seedTags.length > 0
            ? await checkShellStale(seedTags)
            : false;
        const serveConcretePrerenderSeed =
          isReadMethod &&
          !isPagesDataRequest &&
          !isPreviewRequest &&
          !!staticAsset?.prerender &&
          seedWithinRevalidateWindow &&
          !seedTagsStale &&
          !staticAsset.ppr &&
          // In NEXT_ENABLE_ADAPTER's no-Valkey harness, let the generated entrypoint load this
          // build seed into Next's filesystem incremental cache. That supported cache owns later
          // revalidatePath/updateTag transitions and reports the real x-nextjs-cache status. The
          // gate is unreachable in production, where Valkey owns the same lifecycle.
          !(emulatePlatformCache && hasHandler) &&
          // Static pages (handlerPathname === mp) serve their seed too. This used to be
          // restricted to concrete instances under a dynamic template, with the static-page
          // half waved at as "Valkey owns the same lifecycle" — it does not: minimal-mode
          // entrypoints never consult the incremental cache for the response, so a static
          // page's first request (and, before the incrementalCacheShared rungs above, EVERY
          // request) rendered instead of serving the artifact `next start` would have served.
          resolution.pool === poolName;
        // Pages Router fallback:true emits a build-time HTML shell under the dynamic route
        // template. A first document request for a path outside getStaticPaths must receive that
        // shell; its subsequent /_next/data request invokes the handler and materializes the
        // concrete result in the platform cache. Minimal-mode entrypoints deliberately block-render
        // instead, so serving this emitted artifact is the adapter's documented fallback role.
        // Keep PPR out of this branch: PPR shells use postponed state and the resume protocol below.
        const servePagesDynamicFallbackShell =
          // Emulate mode models "one platform-cache miss per URL" with a process-local
          // marker; PRODUCTION serves the skeleton whenever the shared platform cache is
          // wired — a materialized entry supersedes it in the serve block below
          // (fallback-route-params: a blocking render put resolved params in the
          // skeleton's __NEXT_DATA__.query where `next start` serves the build skeleton
          // with query {} and lets the client's data fetch materialize the page).
          (emulatePlatformCache
            ? !servedFallbackShells.has(requestPathname)
            : !!platformCache?.readStored) &&
          isReadMethod &&
          !isPagesDataRequest &&
          !isPreviewRequest &&
          !FALLBACK_BLOCKING_BOT_UA_RE.test(req.headers["user-agent"] ?? "") &&
          !!staticAsset?.prerender &&
          !staticAsset.ppr &&
          /\[[^/]+\]/.test(staticAsset.pathname) &&
          handlerPathname === mp &&
          resolution.pool === poolName;
        // Segment-prefetch outputs are independent build-time cache entries, not executable
        // handlers. `handlerPathname` deliberately maps them back to the parent page so dynamic
        // RSC requests can run, but a segment-prefetch request must still read its exact seeded
        // entry. Sending it to the parent with a document postponed token makes the app-page
        // entrypoint reject the request (404) and loses the Resume Data Cache payload.
        const serveRscPrerenderVariant =
          isReadMethod &&
          isRSC &&
          !!staticAsset?.prerender &&
          handlerPathname !== mp &&
          resolution.pool === poolName;
        const serveStaticFile = staticAsset && !staticAsset.prerender && isReadMethod;

        // Pages Router prerenders cannot own Server Actions. Reject writes from the adapter's
        // build metadata instead of relying on x-nextjs-cache: generated direct Pages entrypoints
        // do not consistently expose that internal response header. App prerenders still invoke
        // their handler so Server Actions remain supported.
        if (
          staticAsset?.prerender &&
          !isReadMethod &&
          (!hasHandler || handlerOutputInfo?.type === "PAGES")
        ) {
          res.writeHead(405, { allow: "GET, HEAD" });
          res.end();
          return;
        }

        // #42 (partial-fallback-shell-upgrade): production fires the SAME fill as the E2E
        // stand-in whenever the shared classic handler is registered — the detached
        // non-minimal document render drives Next's own fallback-upgrade scheduling
        // (app-page-runtime.ts:1276-1330, gated !isMinimalMode), whose writes land in
        // Valkey via the registered handler. Without this, segment prefetches are served
        // entirely from the build seed and NOTHING ever triggers the upgrade (the one
        // upstream trigger lives in the entrypoint, which seed serving never invokes).
        // Deduped per URL by a cooldown: prefetch traffic is per-navigation hot-path and
        // must not fan out one document render per prefetch — one attempt per URL per
        // window is enough (the upgrade is idempotent; Next's own gates make a no-op of
        // routes with nothing left to specialize).
        const productionOwnsShellFill = incrementalCacheShared && !!platformCache;
        if (
          (entrypointOwnsPprShell ||
            (productionOwnsShellFill && shellFillCooldownAllows(req.url ?? "/"))) &&
          serveRscPrerenderVariant &&
          typeof req.headers["next-router-segment-prefetch"] === "string"
        ) {
          // Next's deploy E2E has no Cloud CDN/Valkey platform layer. A real platform serves this
          // seeded segment immediately, then fills the more-specific route shell in its durable
          // middle cache. Reproduce only that missing orchestration here: keep the fast seeded
          // response, and run a document render whose output is discarded while Next writes the
          // upgraded shell — to its filesystem cache under the E2E stand-in, to Valkey through
          // the registered classic handler in production.
          const backgroundHeaders = { ...req.headers };
          delete backgroundHeaders.rsc;
          delete backgroundHeaders["next-router-prefetch"];
          delete backgroundHeaders["next-router-segment-prefetch"];
          const backgroundReq = {
            method: "GET",
            url: req.url,
            headers: backgroundHeaders,
          } as IncomingMessage;
          void handlerLoader
            .load(handlerPathname)
            .then((handler) =>
              localHandlerInvoker({
                handler,
                req: backgroundReq,
                res,
                matchedPathname: handlerPathname,
                routeMatches: resolution.routeMatches,
                bufferedBody: undefined,
                discardResponse: true,
                render404: render404FromEntrypoint,
                renderError: renderErrorFromEntrypoint,
                handlerTimeoutMs: requestHeadTimeoutMs,
                ...(remainingExecutionMs !== undefined
                  ? { executionTimeoutMs: remainingExecutionMs }
                  : {}),
                ...(revalidate ? { revalidate } : {}),
              }),
            )
            .catch((error) => {
              console.error("[pool-server] background PPR shell fill failed:", error);
            });
        }

        // A STORED platform-cache entry (written by an on-demand revalidation after deploy)
        // supersedes the build seed for document serves — the seed is the cold-start answer
        // only. Measured: revalidate-reason's res.revalidate() rendered 'on-demand' and
        // persisted the fresh page, but the seed rung kept serving the build artifact.
        if (
          staticAsset?.prerender &&
          !staticAsset.ppr &&
          (serveConcretePrerenderSeed || serveHandlerlessPrerender) &&
          platformCache?.readStored &&
          isReadMethod &&
          !isPagesDataRequest &&
          !isRSC
        ) {
          // Same key contract as the PPR ladder: Next writes under the resolved invocation
          // pathname (rewrite destination), so read under it too — never the public URL.
          const storedConcrete = new URL(
            resolution.invokePath ?? req.url ?? "/",
            "http://localhost",
          ).pathname;
          const storedKey = storedConcrete === "/" ? "/index" : storedConcrete;
          const stored = await platformCache
            .readStored(storedKey, { kind: "APP_PAGE" })
            .catch(() => null);
          const sv = stored?.value as
            | { kind?: string; html?: unknown; headers?: Record<string, string>; status?: number }
            | undefined;
          if (
            (sv?.kind === "PAGES" || sv?.kind === "APP_PAGE") &&
            sv.html !== undefined &&
            sv.html !== null
          ) {
            res.writeHead(sv.status ?? 200, {
              "content-type": "text/html; charset=utf-8",
              ...sanitizeStoredEntryHeaders(sv.headers),
            });
            res.end(Buffer.isBuffer(sv.html) ? sv.html : Buffer.from(String(sv.html)));
            return;
          }
        }

        // A STORED materialized entry supersedes the seeded SEGMENT files too (rdc run 12,
        // 2026-08-04): the fast path below serves segment prefetches straight from the
        // BUILD file, so once the stored-supersedes-seed rung existed only for documents
        // (below), a regenerated page kept serving build-era segment bytes to every
        // prefetch forever. The materialized entry's segmentData is the CURRENT content —
        // exactly how `next start`'s fs-cache read keeps segment prefetches consistent
        // with regenerated documents. Missing/absent stored entry (or a stored entry
        // without this segment) falls through to the seeded file unchanged.
        if (
          serveRscPrerenderVariant &&
          staticAsset &&
          incrementalCacheShared &&
          platformCache?.readStored &&
          typeof req.headers["next-router-segment-prefetch"] === "string"
        ) {
          const segDirSuffix = rscConfig?.prefetchSegmentDirSuffix ?? ".segments";
          const segIdx = staticAsset.pathname.indexOf(`${segDirSuffix}/`);
          if (segIdx > 0) {
            const pageKey = staticAsset.pathname.slice(0, segIdx) || "/index";
            const storedSeg = await platformCache
              .readStored(pageKey, { kind: "APP_PAGE" })
              .catch(() => null);
            const sv = storedSeg?.value as
              | { kind?: string; segmentData?: Map<string, unknown> }
              | undefined;
            const segPath = req.headers["next-router-segment-prefetch"];
            if (
              sv?.kind === "APP_PAGE" &&
              sv.segmentData instanceof Map &&
              sv.segmentData.has(segPath)
            ) {
              const seg = sv.segmentData.get(segPath) as Buffer | string;
              res.writeHead(200, {
                "content-type": "text/x-component",
                "cache-control": "no-store",
                vary: RSC_VARY_HEADER,
              });
              res.end(Buffer.isBuffer(seg) ? seg : Buffer.from(String(seg)));
              return;
            }
          }
        }

        if (
          staticAsset &&
          (serveStaticFile ||
            serveHandlerlessPrerender ||
            serveConcretePrerenderSeed ||
            servePagesDynamicFallbackShell ||
            serveRscPrerenderVariant)
        ) {
          const fullPath = path.resolve(process.cwd(), staticAsset.filePath);
          if (existsSync(fullPath)) {
            if (servePagesDynamicFallbackShell && emulatePlatformCache) {
              // NEXT_ENABLE_ADAPTER's deploy harness has no Valkey. Model one platform cache miss
              // per concrete URL; after the data request materializes the page, later documents
              // invoke Next's filesystem-cache stand-in.
              if (servedFallbackShells.size >= MAX_SERVED_FALLBACK_SHELLS) {
                const oldest = servedFallbackShells.values().next().value;
                if (oldest !== undefined) servedFallbackShells.delete(oldest);
              }
              servedFallbackShells.add(requestPathname);
            }
            if (servePagesDynamicFallbackShell && !emulatePlatformCache) {
              // Production: the client's /_next/data fetch materializes the page through the
              // non-minimal data render (measured: `inc:/second` written by exactly that);
              // once it exists the STORED page supersedes the skeleton — without this rung
              // documents would serve the skeleton forever.
              const fallbackConcrete = new URL(
                resolution.invokePath ?? req.url ?? "/",
                "http://localhost",
              ).pathname;
              const fallbackKey = fallbackConcrete === "/" ? "/index" : fallbackConcrete;
              const stored = await platformCache!.readStored!(fallbackKey, {
                kind: "PAGES",
              }).catch(() => null);
              const sv = stored?.value as
                | {
                    kind?: string;
                    html?: unknown;
                    headers?: Record<string, string>;
                    status?: number;
                  }
                | undefined;
              if ((sv?.kind === "PAGES" || sv?.kind === "APP_PAGE") && sv.html != null) {
                res.writeHead(sv.status ?? 200, {
                  "content-type": "text/html; charset=utf-8",
                  ...sanitizeStoredEntryHeaders(sv.headers),
                });
                res.end(Buffer.isBuffer(sv.html) ? sv.html : Buffer.from(String(sv.html)));
                return;
              }
            }
            const staticStat = statSync(fullPath);
            const assetHeaders = staticAsset.headers;
            const headers: Record<string, string | string[]> = Object.assign(
              {
                "cache-control": staticAsset.cacheControl,
                // Derive the type from the file being served, not the public
                // route: a prerendered page's pathname is extensionless (e.g.
                // "/" or "/index"), which getContentType maps to octet-stream —
                // so the browser downloads the HTML instead of rendering it.
                // The filePath (".next/server/pages/index.html") carries the
                // real extension. assetHeaders still overrides when present.
                "content-type": getStaticAssetContentType(
                  staticAsset.filePath,
                  staticAsset.pathname,
                ),
              },
              assetHeaders || {},
            );
            // Use the CONFIGURED RSC negotiation header (usually "rsc") — the isRSC
            // check at the top of this section already does; hardcoding "rsc" here
            // would skip Vary augmentation for apps with a custom RSC header name.
            const rscRequestHeader = rscConfig?.header ?? "rsc";
            if (req.headers[rscRequestHeader] === "1") {
              const varyKey = Object.keys(headers).find((name) => name.toLowerCase() === "vary");
              const existingVary = varyKey ? headers[varyKey] : undefined;
              const varyTokens = new Set(
                (Array.isArray(existingVary) ? existingVary : [existingVary ?? ""])
                  .flatMap((value) => value.split(","))
                  .map((value) => value.trim().toLowerCase())
                  .filter(Boolean),
              );
              // Even a Pages prerender must vary from the App Router's RSC negotiation request.
              // Next's router-server normally adds these fields above static serving; a direct
              // adapter entrypoint has no such layer, so lock the protocol at this boundary.
              for (const token of [
                rscRequestHeader,
                "next-router-state-tree",
                "next-router-prefetch",
                "next-router-segment-prefetch",
              ]) {
                varyTokens.add(token);
              }
              if (varyKey && varyKey !== "vary") delete headers[varyKey];
              headers.vary = [...varyTokens].join(", ");
            }
            // Next's generated service-worker chunks are deliberately mutable and revalidated.
            // Static files bypass the Next server in this adapter, so the adapter must supply the
            // validator that Next's normal static-file server would have emitted. App-provided
            // ETags still win when an output explicitly owns one.
            const manifestEtagKey = Object.keys(headers).find(
              (name) => name.toLowerCase() === "etag",
            );
            const ownedEtag =
              resolution.resolvedHeaders?.get("etag") ??
              (manifestEtagKey ? headers[manifestEtagKey] : undefined);
            // S41 (AVAILABILITY). Manifest-backed assets used to be synchronously read into a
            // Buffer before this validator was computed — even for a matching If-None-Match.
            // Hash once through a bounded async stream when the build did not supply an ETag,
            // then decide 304/HEAD before allocating or opening the response body.
            const etag =
              ownedEtag === null || ownedEtag === undefined
                ? await staticAssetEtagForFileAsync(fullPath, staticStat)
                : String(ownedEtag);
            if (manifestEtagKey && manifestEtagKey !== "etag") delete headers[manifestEtagKey];
            if (etag !== null) headers.etag = etag;
            if (staticAsset.prerender) {
              // Next's generated entrypoint emits origin-cache directives (s-maxage/SWR) because
              // it normally owns ISR. In this adapter Valkey is the mutable ISR/PPR cache; Cloud
              // CDN must revalidate prerendered HTML rather than retaining a stale copy after a
              // Valkey regeneration. Apply the same client-facing policy as writeInnerResponse()
              // to build-time seeds and fallback shells, which bypass the entrypoint entirely.
              // This is production behavior, not an E2E-only environment-variable exception.
              headers["cache-control"] = "public, max-age=0, must-revalidate";
              deleteHeaderCaseInsensitive(headers, "cache-tag");
            }
            // Manifest headers preserve build-time casing (e.g. `X-Next-Cache-Tags`,
            // `Cache-Tag`) — a literal lowercase delete leaks the internal header to
            // clients whenever the build cased it differently.
            deleteHeaderCaseInsensitive(headers, "x-next-cache-tags");
            // Stamp the CDN cache tag from the EFFECTIVE cache-control (after assetHeaders
            // may have overridden it), and apply it last so it can't itself be overridden.
            // Mutable static (SSG HTML / public files) → tagged; immutable/max-age=0 → not.
            Object.assign(
              headers,
              cdnCacheTag(String(headers["cache-control"] ?? staticAsset.cacheControl), buildId),
            );
            if (etag !== null && ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
              res.writeHead(304, headers);
              res.end();
              return;
            }
            // N31: REQUIRED for HEAD — Node marks a HEAD response body-less and then emits NEITHER
            // Content-Length NOR Transfer-Encoding, so HEAD reported no size where `next start`
            // sends the real one (measured). Third instance of the bug sendImageResponse already
            // documents. Stamped after the manifest headers so it always describes these bytes.
            headers["content-length"] = String(staticStat.size);
            // A stored (build) entry answered this key — that is HIT by the platform contract
            // above (and what `next start` reports for a prerendered page: its filesystem
            // cache reads the build output). Only for the seed path: plain static files and
            // fallback shells keep their existing header surface.
            if (serveConcretePrerenderSeed) headers["x-vercel-cache"] = "HIT";
            res.writeHead(staticAsset.status ?? 200, headers);
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            if (staticStat.size > STATIC_STREAM_THRESHOLD_BYTES) {
              pipeline(createReadStream(fullPath), res, () => undefined);
              return;
            }
            const content = readFileSync(fullPath);
            res.end(content);
            return;
          }
        }
      }

      switch (resolution.kind) {
        case "error": {
          res.writeHead(resolution.status, { "content-type": "text/plain; charset=utf-8" });
          res.end(resolution.status >= 500 ? "Internal Server Error" : "Bad Request");
          return;
        }

        case "redirect": {
          // Middleware/rule redirects can carry additional response headers
          // (e.g. NextResponse.redirect(url, { headers })) — forward them.
          const headers: Record<string, string | string[]> = resolution.resolvedHeaders
            ? webHeadersToNodeHeaders(resolution.resolvedHeaders)
            : {};
          delete headers["content-length"];
          const location = resolution.resolvedHeaders?.has("location")
            ? middlewareRedirectLocation(req, resolution.url)
            : resolution.url.toString();
          // N15: no RSC special-case — `next start` answers RSC redirects with the real 3xx and
          // the App Router flight client follows it (fetch-server-response.ts reads
          // response.redirected). `x-nextjs-redirect` is a PAGES-router protocol (written under
          // isNextDataRequest, read by shared/lib/router/router.ts); emitting it for App Router
          // stranded the flight client, which then fell back to a document load.
          headers["location"] = location;
          if (resolution.status === 308) headers["Refresh"] = `0;url=${location}`;
          res.writeHead(resolution.status, headers);
          res.end(req.method === "HEAD" ? undefined : location);
          return;
        }

        case "middleware-response": {
          const mwRes = resolution.response;
          res.writeHead(mwRes.status, webHeadersToNodeHeaders(mwRes.headers));
          if (mwRes.body) {
            const reader = mwRes.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
              }
            } finally {
              reader.releaseLock();
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        case "external-rewrite": {
          // Proxy the request to the external URL (middleware rewrite / next.config.js rewrite)
          applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders);
          const target = resolution.url;
          const proxyMod =
            target.protocol === "https:" ? await import("node:https") : await import("node:http");
          return new Promise<void>((resolve) => {
            let deadlineExceeded = false;
            const bufferedBody = bufferedActionBody(req);

            // Hop-by-hop headers (and anything the client's Connection header
            // nominated) describe the client↔pool connection — strip them before
            // forwarding; Node sets its own connection semantics on this request.
            // Then the same forged-framing guard as the loopback invocation: a
            // client-declared content-length with no body would make the upstream
            // await bytes that never arrive (hang until its own timeout).
            const forwardHeaders: Record<string, string | string[] | undefined> = {
              ...stripRequestHopByHopHeaders(req.headers),
              host: target.host,
            };
            restateFramingHeaders(forwardHeaders, bufferedBody, req.method, false);

            const proxyReq = proxyMod.request(
              {
                hostname: target.hostname,
                port: target.port || (target.protocol === "https:" ? 443 : 80),
                path: target.pathname + target.search,
                method: req.method,
                headers: forwardHeaders,
              },
              (proxyRes) => {
                clearTimeout(responseHeadDeadline);
                res.writeHead(proxyRes.statusCode ?? 502, stripHopByHopHeaders(proxyRes.headers));
                // pipeline handles errors on either end (e.g. client disconnect) and
                // cleans up both streams, unlike a bare .pipe().
                pipeline(proxyRes, res, () => resolve());
              },
            );

            const responseHeadDeadline = setTimeout(() => {
              deadlineExceeded = true;
              proxyReq.destroy(
                new DeadlineExceededError(`external rewrite to ${target.origin} timed out`),
              );
            }, proxyTimeoutMs);
            responseHeadDeadline.unref?.();

            // S19 (AVAILABILITY). `timeout` above is an IDLE timeout — an upstream that emits
            // one byte just inside each interval holds a client socket, an upstream socket and
            // this request's state indefinitely, and repeating it exhausts file descriptors and
            // memory. The image fetch grew an absolute deadline for exactly this shape (N35);
            // the proxy path did not. Bound the WHOLE exchange, connect through body.
            const absoluteDeadline = setTimeout(() => {
              deadlineExceeded = true;
              proxyReq.destroy(
                new Error(
                  `external rewrite to ${target.origin} exceeded the ${PROXY_ABSOLUTE_DEADLINE_MS}ms absolute deadline`,
                ),
              );
            }, PROXY_ABSOLUTE_DEADLINE_MS);
            // Never hold the event loop open on its own account.
            absoluteDeadline.unref?.();
            // Cleared on the PROXY request's close, which covers both normal completion and
            // an abort. Deliberately not also on `res` close: if the client hangs up while the
            // upstream keeps trickling, letting the deadline fire is the point.
            proxyReq.on("close", () => clearTimeout(absoluteDeadline));

            proxyReq.on("error", (err) => {
              clearTimeout(responseHeadDeadline);
              // A client abort is our own deliberate teardown, not an upstream failure —
              // log it at info level and skip the 502 (the client is gone anyway).
              if (err instanceof ClientAbortError) {
                console.log(
                  `[pool-server] external rewrite to ${target.origin}${target.pathname} aborted: client disconnected`,
                );
                resolve();
                return;
              }
              // The dial error stays in the server log — the client body must not leak
              // upstream error detail (connection failures reveal internal topology/targets).
              console.error(
                `[pool-server] external rewrite to ${target.origin}${target.pathname} failed:`,
                err,
              );
              if (!res.headersSent) {
                res.writeHead(deadlineExceeded ? 504 : 502, { "content-type": "text/plain" });
                res.end(deadlineExceeded ? "Gateway Timeout" : "Bad Gateway");
              }
              resolve();
            });

            // Client disconnected before the upstream answered — cancel the upstream
            // request rather than letting it run to completion into a dead socket.
            abortOnClientClose(res, () => proxyReq.destroy(new ClientAbortError()));

            if (bufferedBody && bufferedBody.length > 0) {
              proxyReq.end(bufferedBody);
            } else if (req.method !== "GET" && req.method !== "HEAD") {
              pipeline(req, proxyReq, () => undefined);
            } else {
              proxyReq.end();
            }
          });
        }

        case "not-found": {
          // Render the app's custom 404 (App Router /_not-found or Pages Router /404), else plain text.
          const bufferedBody = bufferedActionBody(req);
          await serveNotFound(
            handlerLoader,
            localHandlerInvoker,
            staticAssets,
            req,
            res,
            bufferedBody,
            basePath,
            notFoundIsPrerendered,
            distDir,
          );
          return;
        }

        case "route": {
          // fallback: false / dynamicParams: false — a path matching a strict
          // dynamic route but not in the prerendered set 404s (as `next start`
          // does). Skipped only for VERIFIED preview/revalidate requests, which
          // legitimately render non-generated paths on demand. A bare
          // `x-prerender-revalidate` header or a forged `__prerender_bypass`
          // cookie must NOT skip the 404 — that would let any client force
          // renders (which then land in the shared cache) of paths the app
          // declared must 404. See isVerifiedPreviewRequest for the upstream
          // credential scheme this mirrors.
          if (strictDynamicRoutes.length > 0) {
            const reqPath = (resolution.invokePath || req.url || "/").split("?")[0] ?? "/";
            const dataPrefix = `${basePath}/_next/data/${buildIdForData}/`;
            const encodedPagePath = reqPath.startsWith(dataPrefix)
              ? "/" + reqPath.slice(dataPrefix.length).replace(/\.json$/, "")
              : reqPath;
            let pagePath = encodedPagePath;
            try {
              pagePath = decodeURIComponent(encodedPagePath);
            } catch {
              // Keep the encoded value; malformed escapes will simply fail the
              // prerender-manifest membership check below.
            }
            // i18n requests arrive locale-prefixed (/en/blog/x — including data URLs
            // converted above), while the strict-route regexes and prerendered set are
            // unprefixed. Strip the prefix so a locale-prefixed request for a
            // non-generated path still hits the fallback:false 404 instead of sailing
            // past the regex and rendering a path the app declared must not exist.
            if (i18nLocales.length > 0) {
              const firstSegment = pagePath.split("/", 2)[1]?.toLowerCase();
              if (firstSegment && i18nLocales.some((l) => l.toLowerCase() === firstSegment)) {
                pagePath = pagePath.slice(firstSegment.length + 1) || "/";
              }
            }
            const isBypass = isVerifiedPreviewRequest(req);
            if (
              !isBypass &&
              // N11: with `trailingSlash: true` the request path carries a slash while
              // prerender-manifest routes are keyed WITHOUT one — comparing the raw path
              // made every fallback:false prerender 404 (upstream normalizes the slash
              // before this membership test). Reached whenever the concrete seed isn't
              // served, i.e. the harness always AND production once a revalidate window
              // expires, so this was a live 404 for trailingSlash+fallback:false apps.
              !trailingSlashVariants(pagePath).some((variant) => prerenderedPaths.has(variant)) &&
              strictDynamicRoutes.some((r) => r.pageRegex.test(pagePath))
            ) {
              await serveNotFound(
                handlerLoader,
                localHandlerInvoker,
                staticAssets,
                req,
                res,
                undefined,
                basePath,
                notFoundIsPrerendered,
                distDir,
              );
              return;
            }
          }

          // Apply middleware's final request-header set as a replacement, not a merge.
          // responseToMiddlewareResult processes x-middleware-set-cookie,
          // x-middleware-override-headers, and x-middleware-request-* headers.
          // The override list is authoritative: a listed header with no corresponding
          // x-middleware-request-* value means deletion. Merging would resurrect it.
          applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders);
          preserveServerActionAuthority(req);

          // Pool ownership is authoritative. A broad local dynamic template can match the
          // same concrete pathname as an exact route assigned elsewhere (for example an App
          // `/[locale]` beside a Pages `/legacy`). Serving merely because this image has that
          // template runs the wrong router and can feed a Pages cache entry to an App handler.
          // Shared static files have already returned through the fast path above; every
          // remaining foreign execution must go to its assigned pool.
          if (resolution.pool !== poolName) {
            return proxyToPool(
              req,
              res,
              resolution,
              releaseName,
              buildId,
              internalSecret,
              requestHeadTimeoutMs,
              executionDeadlineAt,
              proofHeaderNames,
            );
          }

          // If no handler exists for this output, fall through to 404
          if (!handlerLoader.has(handlerPathname)) {
            if (!handlerLoader.has("/_not-found") && !handlerLoader.has("/404")) {
              // Pathname only, never req.url — the raw query string routinely carries
              // tokens and signed parameters (server.ts's request log follows the same
              // rule), and this line fires on attacker-inducible 404s.
              console.log(
                `[dispatch] 404: no handler for matchedPathname="${handlerPathname}" url="${requestTargetPathname(req.url ?? "/")}"`,
              );
            }
            const bufferedBody = bufferedActionBody(req);
            await serveNotFound(
              handlerLoader,
              localHandlerInvoker,
              staticAssets,
              req,
              res,
              bufferedBody,
              basePath,
              notFoundIsPrerendered,
              distDir,
            );
            return;
          }

          // Edge runtime routes: use the edge sandbox instead of the loopback HTTP server
          const outputInfo = handlerOutputInfo;
          if (edgeRouteRunner && outputInfo?.runtime === "edge") {
            const headerObj: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === "string") headerObj[key] = value;
              else if (Array.isArray(value)) headerObj[key] = value.join(", ");
            }
            // Edge Pages/API entrypoints observe the public request pathname,
            // even after a rewrite, but receive the rewrite-added query. Do
            // not replace req.url with the internal invocation target.
            const fullUrl = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
            if (resolution.invocationQuery) {
              for (const [key, value] of Object.entries(resolution.invocationQuery)) {
                fullUrl.searchParams.delete(key);
                for (const item of Array.isArray(value) ? value : [value]) {
                  fullUrl.searchParams.append(key, item);
                }
              }
            }
            const declaredParams = new Set<string>();
            for (const match of handlerPathname.matchAll(
              /\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g,
            )) {
              const paramName = match[1] ?? match[2];
              if (paramName) declaredParams.add(paramName);
            }
            const extractedEdgeParams =
              extractRouteParams(
                handlerPathname,
                resolution.routeMatches,
                resolution.invokePath ?? fullUrl.pathname,
              ) ?? {};
            const edgeRouteParams: Record<string, string | string[]> = {};
            const edgeRouteQueryParams: Record<string, string> = {};
            for (const key of declaredParams) {
              const internalKey = `nxtP${key}`;
              const routedValue =
                resolution.routeMatches?.[key] ?? resolution.routeMatches?.[internalKey];
              const value = extractedEdgeParams[key];
              if (value !== undefined) {
                edgeRouteParams[key] = value;
                // @next/routing uses nxtP<name> as the transport key. The
                // Edge entrypoints consume this transport key: Pages exposes it
                // as query.<name>, while EdgeRouteModuleWrapper reconstructs
                // App Route params from the URL search params.
                edgeRouteQueryParams[internalKey] =
                  routedValue ?? (Array.isArray(value) ? value.join("/") : value);
              }
            }
            // NextNodeServer.runEdgeFunction merges dynamic params into the
            // request URL query for Pages Router edge functions as well as
            // passing page.params. Pages getServerSideProps/API handlers build
            // `ctx.query` from that URL; page.params alone only populates
            // `ctx.params`. Edge App Routes also require the internal nxtP keys
            // because EdgeRouteModuleWrapper derives params from searchParams.
            // App Pages remain excluded: rewrite params can change their RSC
            // payload and their entrypoint consumes page.params directly.
            if (
              (outputInfo.type === "PAGES" ||
                outputInfo.type === "PAGES_API" ||
                outputInfo.type === "APP_ROUTE") &&
              Object.keys(edgeRouteQueryParams).length > 0
            ) {
              for (const [key, value] of Object.entries(edgeRouteQueryParams)) {
                fullUrl.searchParams.set(key, value);
              }
            }
            const filePath = path.resolve(process.cwd(), outputInfo.filePath);
            // Edge handlers use ctx.waitUntil for stale-while-revalidate and
            // other background cache work. Keep those promises observed but do
            // not await them before streaming the response. This is the same
            // lifecycle boundary NextNodeServer supplies to sandbox.run.
            const waitUntil = (waitable: Promise<unknown>): void => {
              void Promise.resolve(waitable).catch((error) => {
                console.error(`Edge background work failed for ${handlerPathname}:`, error);
              });
            };
            let executionTimer: ReturnType<typeof setTimeout> | undefined;
            const executionExceeded =
              remainingExecutionMs !== undefined
                ? new Promise<never>((_resolve, reject) => {
                    executionTimer = setTimeout(
                      () =>
                        reject(
                          new DeadlineExceededError(
                            `edge route ${handlerPathname} exceeded maxDuration`,
                          ),
                        ),
                      remainingExecutionMs,
                    );
                    executionTimer.unref?.();
                  })
                : undefined;
            const withinExecution = <T>(promise: Promise<T>): Promise<T> =>
              executionExceeded ? Promise.race([promise, executionExceeded]) : promise;
            try {
              let headTimer: ReturnType<typeof setTimeout> | undefined;
              const responseHeadExceeded = new Promise<never>((_resolve, reject) => {
                headTimer = setTimeout(
                  () =>
                    reject(
                      new DeadlineExceededError(
                        `edge route ${handlerPathname} exceeded its response-head deadline`,
                      ),
                    ),
                  requestHeadTimeoutMs,
                );
                headTimer.unref?.();
              });
              const result = await withinExecution(
                Promise.race([
                  edgeRouteRunner({
                    name: handlerPathname,
                    paths: [filePath],
                    request: {
                      url: fullUrl.toString(),
                      method: req.method,
                      headers: headerObj,
                      body:
                        req.method !== "GET" && req.method !== "HEAD"
                          ? bufferedActionBody(req)
                          : undefined,
                      page: {
                        name: handlerPathname,
                        ...(Object.keys(edgeRouteParams).length > 0 && { params: edgeRouteParams }),
                      },
                      waitUntil,
                    },
                  }),
                  responseHeadExceeded,
                ]),
              ).finally(() => {
                if (headTimer) clearTimeout(headTimer);
              });
              const edgeRes = result.response;
              res.writeHead(edgeRes.status, webHeadersToNodeHeaders(edgeRes.headers));
              if (edgeRes.body) {
                const reader = edgeRes.body.getReader();
                try {
                  while (true) {
                    const { done, value } = await withinExecution(reader.read());
                    if (done) break;
                    if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
                  }
                } finally {
                  reader.releaseLock();
                }
              }
              if (!res.writableEnded) res.end();
              // The body is already complete, but the platform invocation must remain alive until
              // Edge after()/cache work settles. This mirrors the Node entrypoint lifecycle above
              // and prevents a pod/request teardown from dropping revalidation side effects.
              if (result.waitUntil) {
                await withinExecution(result.waitUntil).catch((error) => {
                  if (error instanceof DeadlineExceededError) throw error;
                  console.error(`Edge background work failed for ${handlerPathname}:`, error);
                });
              }
            } catch (err) {
              if (err instanceof DeadlineExceededError) {
                console.error(`[pool-server] ${err.message}`);
                if (!res.headersSent) {
                  res.writeHead(504, { "content-type": "text/plain; charset=utf-8" });
                  res.end("Gateway Timeout");
                } else if (!res.writableEnded) {
                  res.destroy(err);
                }
                return;
              }
              console.error(`Edge route handler failed for ${handlerPathname}:`, err);
              if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("Internal Server Error");
              } else if (!res.writableEnded) {
                // The edge stream threw AFTER writeHead — a clean 500 is impossible,
                // but leaving the response open hangs the client until the server-wide
                // timeout. Terminate it instead (mirrors the loopback handler's
                // fail-safe mid-stream behavior).
                if (typeof res.destroy === "function") res.destroy();
                else res.end();
              }
            } finally {
              if (executionTimer) clearTimeout(executionTimer);
            }
            return;
          }

          // For PPR routes, set the postponed state on request metadata so the handler resumes
          // the dynamic holes onto the prebuilt shell — BUT only when no classic incremental
          // cacheHandler is registered. When it is (incrementalCacheShared), that handler owns the
          // PPR shell (populated on first render, shared + revalidated cross-replica exactly like
          // `next start`); injecting the build-time disk token here would bypass that cache and
          // re-serve a stale shell after a cross-replica `revalidateTag`. A cache + edge-middleware
          // app has VALKEY_URL set but NO classic handler registered, so it keeps injecting here.
          // Prefer the route selected by @next/routing over its executable handler template.
          // PPR builds can emit both a generic shell (`/[lang]/[slug]`) and a more-specialized
          // shell (`/en/[slug]`). The handler is necessarily the generic template, but resuming
          // it with the generic postponed state for an `/en/*` request duplicates/misplaces the
          // root-param shell. Fall back to the handler key only when no specialized entry exists.
          const matchedPrerender = staticAssets.find(
            (asset) => asset.prerender && asset.pathname === resolution.matchedPathname,
          );
          const handlerPprInfo = [
            resolution.matchedPathname,
            handlerPathname,
            // Root alias, same as the handler-loader candidates: the router resolves the
            // root page as "/index" while pprRoutes keys the prerender "/" — without this
            // the rdc fixture's root PPR shell was never injected (live values instead of
            // the build shell, measured on k3d).
            ...(resolution.matchedPathname === "/index" || handlerPathname === "/index"
              ? ["/"]
              : []),
            ...(resolution.matchedPathname === "/" ? ["/index"] : []),
            ...rscParentCandidates(resolution.matchedPathname, rscConfig),
            ...rscParentCandidates(handlerPathname, rscConfig),
          ]
            .map((candidate) => pprRoutes[candidate])
            .find((candidate) => candidate !== undefined);
          // N16: PPR-capable without a build-emitted shell (`fallback: null`). Same candidate
          // ladder as handlerPprInfo — an RSC request's output id carries the `.rsc` suffix, so
          // the base route must be recovered before the lookup (LOAD-BEARING: without the
          // rscParentCandidates rungs the document request was fixed but the flight request
          // still truncated). `handlerPprCapable` only says "this route is PPR" (it keeps N13
          // off); `handlerPprRootParams` is the narrower signal that flips minimal mode.
          const pprCapableCandidates = [
            resolution.matchedPathname,
            handlerPathname,
            ...rscParentCandidates(resolution.matchedPathname, rscConfig),
            ...rscParentCandidates(handlerPathname, rscConfig),
          ];
          const handlerPprCapable = pprCapableCandidates.some((candidate) =>
            pprCapableRoutes.has(candidate),
          );
          const handlerPprRootParams = pprCapableCandidates.some((candidate) =>
            pprRootParamRoutes.has(candidate),
          );
          // Platform cache key for the seen-key registry. First
          // candidate with a build-declared allowQuery wins; params resolve from the
          // routing verdict. Recorded on FIRST sight (a failed render then reports HIT on
          // the retry — acceptable: the contract's subjects always 200).
          let platformCacheSeen: boolean | undefined;
          let platformKey: string | undefined;
          let platformFullyKeyed = false;
          // Byte-replay eligibility is NARROWER than key membership (measured against the
          // canary.97 suite): only SHELL-LESS templates (pprCapableRoutes-
          // sourced keys — the matrix's fully-static empty-shell class) and only DOCUMENT
          // requests. Shell-bearing routes replay through Next's own cache (and carry the
          // tag/revalidate surfaces the store must never serve stale); RSC/segment
          // requests have variant payloads the document-keyed store would corrupt.
          //
          // S17 (SECURITY): and only under emulatePlatformCache — i.e. NEVER in production.
          // The store is a process-local stand-in for the CDN edge cache, but its key is
          // `template|param=value` and nothing else: no cookies, no Authorization, no
          // middleware-injected identity. Capture rejects nothing either — not `Set-Cookie`,
          // not `Cache-Control: private`. A PPR route that personalizes inside a dynamic
          // hole would serve one visitor's document, and their session cookie, to the next.
          // A real deployment has Cloud CDN for the sharing this emulates and Valkey for
          // the entries worth keeping; neither is a per-pod Map. The x-vercel-cache HEADER
          // is unaffected in both postures — it comes from the seen-key registry, which
          // records key strings only and never response bytes.
          let platformStoreEligible = false;
          const platformDocumentRequest =
            emulatePlatformCache &&
            req.method === "GET" &&
            req.headers[rscConfig?.header ?? "rsc"] !== "1" &&
            req.headers["next-router-prefetch"] !== "1" &&
            req.headers["next-router-segment-prefetch"] === undefined;
          for (const candidate of pprCapableCandidates) {
            const capableAq = (
              pprCapableRouteMap[candidate] as { allowQuery?: string[] } | undefined
            )?.allowQuery;
            const aq = pprRoutes[candidate]?.allowQuery ?? capableAq;
            if (!aq) continue;
            platformStoreEligible = capableAq !== undefined && platformDocumentRequest;
            const params = extractRouteParams(candidate, resolution.routeMatches ?? null) ?? {};
            // The build emits nxtP-prefixed param names in allowQuery; extracted route
            // params are bare. Try both spellings (measured on the matrix fixture:
            // ["nxtPlang"] vs params.lang — unnormalized, every key per template collapsed).
            const bareAq = aq.map((p) => (p.startsWith("nxtP") ? p.slice(4) : p));
            platformKey =
              candidate +
              "|" +
              aq
                .map((p, i) => {
                  const value =
                    (params as Record<string, unknown>)[bareAq[i]!] ??
                    (params as Record<string, unknown>)[p];
                  return `${p}=${Array.isArray(value) ? value.join("/") : String(value ?? "")}`;
                })
                .join("&");
            // Fully keyed ⟺ every template param partitions the key ⟺ the entry is fully
            // static ⟺ the platform replays stored bytes (the platform response store).
            platformFullyKeyed = templateParamNames(candidate).every((name) =>
              bareAq.includes(name),
            );
            platformCacheSeen = checkAndRecordPlatformKey(platformKey);
            break;
          }
          // Platform replay: a seen, fully-keyed, stored entry is served without invoking
          // anything — the platform-cache behavior the matrix's fully-static cells assert.
          if (platformCacheSeen && platformFullyKeyed && platformStoreEligible && platformKey) {
            const stored = platformResponseStore.get(platformKey);
            if (stored && !res.writableEnded) {
              res.writeHead(stored.status, { ...stored.headers, "x-vercel-cache": "HIT" });
              res.end(stored.body);
              return;
            }
          }

          // A concrete non-PPR prerender under a PPR-capable dynamic handler is a blocking/static
          // branch of that route, not permission to reuse the handler template's generic shell.
          // Falling through to the generic postponed state leaks build-time layouts into requests
          // that Next intentionally classified as full renders.
          const manifestPprInfo =
            matchedPrerender && !matchedPrerender.ppr ? undefined : handlerPprInfo;
          const pprInfo = manifestPprInfo;
          let pprResponsePrefix:
            | {
                filePath?: string;
                content?: Buffer;
                headers?: Record<string, string | string[]>;
                status?: number;
              }
            | undefined;
          let pprInvocationHeaders: Record<string, string> | undefined;
          // Whether the shell actually got injected — the minimal-mode gate keys on this:
          // a usable shell means minimal+inject+prefix; ANY reason the shell is unusable
          // (tag-stale, revalidate window expired, file missing, Server Action, root-alias
          // miss) degrades to the NON-minimal path where Next renders the complete document
          // dynamically. A withheld shell + minimal is a truncated document; measured as
          // vary-params-base-dynamic 15/15 failing when the first injection cut ignored this.
          let pprShellInjected = false;
          /** Trace-only (ADAPTER_K8S_CACHE_TRACE): why the PPR block did or didn't inject. */
          let pprTraceDetail: Record<string, unknown> | undefined;
          if (
            pprInfo?.postponedState &&
            !entrypointOwnsPprShell &&
            !handlerPprRootParams &&
            // partialFallback builds keep Next's own serving path — see the option doc.
            !partialPrefetching
          ) {
            // Do NOT inject the resume token for Server Action requests. Next's app-page handler
            // only splits the postponed state out of the action body (via the
            // `x-next-resume-state-length` framing) when no `postponed` meta is already set —
            // injecting it here would leave the postponed prefix in the action body and corrupt
            // the action. Server actions carry the `next-action` header (or that length header).
            const isServerAction =
              !!req.headers["next-action"] || !!req.headers["x-next-resume-state-length"];
            // Without a classic handler owning the shell, still honor cross-replica revalidation:
            // if a tag baked into the shell has been revalidated since deploy (checked live against
            // the shared Valkey manifest), withhold the stale build-time token so the handler does a
            // fresh blocking render. Absent a shared cache, checkShellStale is undefined → inject.
            const pprTags = pprInfo.tags;
            const shellStale =
              checkShellStale && pprTags && pprTags.length > 0
                ? await checkShellStale(pprTags)
                : false;
            // Time-based revalidate window, same anchor as the concrete-seed path: a shell
            // with `revalidate: <seconds>` stops being injected once the window since BUILD
            // elapses (Next then regenerates per request until a fresher entry exists).
            // `revalidate: false`/absent means tag-lifetime only.
            const shellRevalidate = (pprInfo as { revalidate?: number | false }).revalidate;
            const shellWithinWindow =
              typeof shellRevalidate !== "number" ||
              (shellRevalidate > 0 && Date.now() - deployedAt < shellRevalidate * 1000);
            const shellPath = path.resolve(process.cwd(), pprInfo.fallbackFilePath);
            const shellAvailable = existsSync(shellPath);
            const shellUsable = !isServerAction && !shellStale && shellWithinWindow;
            pprTraceDetail = {
              shellStale,
              shellWithinWindow,
              shellAvailable,
              isServerAction,
            };

            // MATERIALIZATION READ: the platform cache (Valkey classic handler; get() owns
            // tag staleness and falls back to the build seed) is the authority when wired.
            // A materialized entry — written by the canonical regeneration below after a
            // revalidation — supersedes the on-disk build shell: its html/postponed/
            // segmentData reflect the CURRENT content, which is how `next start` keeps
            // segment prefetches consistent with regenerated documents.
            // Read ladder: the CONCRETE request path first (a materialized per-URL entry
            // wins), then the ROUTE TEMPLATE — route-keyed fallback shells live under the
            // template in the fs-mirror seed, and reading only the concrete path missed
            // every one of them (cache-components-prerender-matrix 3/60 -> 13/60, wrong
            // layout-region values from the generic disk shell).
            // Concrete key = what Next WRITES under: the resolved invocation pathname (the
            // rewrite destination when a rewrite fired — requestMeta.resolvedPathname uses
            // the same derivation), never the public URL. `/alias -> /posts/1` writes
            // /posts/1; reading /alias would miss forever and double-schedule regens.
            const concreteReadPath = new URL(
              resolution.invokePath ?? req.url ?? "/",
              "http://localhost",
            ).pathname;
            const platformKey = concreteReadPath === "/" ? "/index" : concreteReadPath;
            const templateKey =
              resolution.matchedPathname === "/" ? "/index" : resolution.matchedPathname;
            let platformEntry: {
              lastModified?: number | undefined;
              value: unknown;
              isStale?: boolean;
            } | null = null;
            const isPprReadMethod = req.method === "GET" || req.method === "HEAD";
            if (platformCache && !isServerAction && isPprReadMethod) {
              // STORED entries first, CONCRETE key only, regardless of SEED staleness: a
              // revalidation's output supersedes the build seed. Stored entries are written
              // under concrete request paths — a stored entry under the TEMPLATE key must
              // never serve (cross-sibling poisoning: /es/2 receiving /es/1's layout).
              if (platformCache.readStored) {
                platformEntry = await platformCache
                  .readStored(platformKey, { kind: "APP_PAGE" })
                  .catch(() => null);
              }
              if (!platformEntry && shellUsable) {
                // Seed rungs: the concrete prerender first (read() is stored-first, but the
                // concrete stored rung just missed, so it degrades to the seed), then the
                // ROUTE TEMPLATE — route-keyed fallback shells live under the template in
                // the fs-mirror seed. The template rung is SEED-ONLY (readSeed); read()'s
                // stored-first order would reintroduce template-stored serving.
                platformEntry = await platformCache
                  .read(platformKey, { kind: "APP_PAGE" })
                  .catch(() => null);
                if (!platformEntry && templateKey !== platformKey) {
                  platformEntry = platformCache.readSeed
                    ? await platformCache
                        .readSeed(templateKey, { kind: "APP_PAGE" })
                        .catch(() => null)
                    : null;
                }
              }
            }
            // CANONICAL REGENERATION scheduling, shared by every arm that needs one — the
            // stale-entry SWR serve below and the no-entry/unusable-shell live render. It
            // rides the pool's own res.revalidate() re-entry (N33 boundary): a
            // mocked-request loopback carrying x-prerender-revalidate, which dispatch
            // verifies and runs NON-minimal as an on-demand revalidation — Next itself
            // writes the fresh entry through the registered cache handler, exactly like
            // `next start`'s response-cache regeneration. One regen per key in flight.
            const scheduleRegen = (): void => {
              if (
                !revalidate ||
                !process.env.__NEXT_PREVIEW_MODE_ID ||
                isServerAction ||
                !isPprReadMethod ||
                pendingRegens.has(platformKey) ||
                pendingRegens.size >= MAX_PENDING_REGENS
              ) {
                return;
              }
              pendingRegens.add(platformKey);
              void revalidate({
                urlPath: req.url ?? resolution.matchedPathname,
                headers: {
                  "x-prerender-revalidate": process.env.__NEXT_PREVIEW_MODE_ID,
                },
                opts: {},
              })
                .catch((error) => {
                  console.error("[pool-server] PPR platform regeneration failed:", error);
                })
                .finally(() => {
                  pendingRegens.delete(platformKey);
                });
            };
            // A soft-stale STORED entry still answers the foreground request (every serve
            // shape below), and dispatch DELIBERATELY does not regenerate it: the
            // x-prerender-revalidate re-entry hard-errors for cache-components routes and
            // its failed render held the single-flight lock to TTL, starving the
            // entrypoint's own WORKING revalidation (forceStaticRender). The next
            // non-minimal dynamic-RSC/action request's entrypoint read wins the lock and
            // regenerates properly (measured end-to-end, 2026-08-03). The no-entry arm
            // below keeps its regen: that is the plain-ISR path (revalidate-reason), whose
            // render mode works.
            const segmentPrefetchPath =
              typeof req.headers["next-router-segment-prefetch"] === "string"
                ? req.headers["next-router-segment-prefetch"]
                : undefined;
            const entryValue = platformEntry?.value as
              | {
                  kind?: string;
                  html?: unknown;
                  postponed?: unknown;
                  headers?: Record<string, string>;
                  status?: number;
                  segmentData?: Map<string, unknown>;
                }
              | undefined;

            // Segment prefetch served straight from the entry's segmentData (build seed or
            // materialized) — never resumed, mirroring the fs-cache read `next start` does.
            if (
              entryValue?.kind === "APP_PAGE" &&
              segmentPrefetchPath !== undefined &&
              entryValue.segmentData instanceof Map &&
              entryValue.segmentData.has(segmentPrefetchPath)
            ) {
              const seg = entryValue.segmentData.get(segmentPrefetchPath) as Buffer | string;
              res.writeHead(200, {
                "content-type": "text/x-component",
                "cache-control": "no-store",
                vary: RSC_VARY_HEADER,
              });
              res.end(Buffer.isBuffer(seg) ? seg : Buffer.from(String(seg)));
              return;
            }

            const entryPostponed =
              typeof entryValue?.postponed === "string" && entryValue.postponed.length > 0
                ? entryValue.postponed
                : undefined;
            const entryHtml =
              entryValue?.html !== undefined && entryValue.html !== null
                ? Buffer.isBuffer(entryValue.html)
                  ? entryValue.html
                  : Buffer.from(String(entryValue.html))
                : undefined;

            // A COMPLETE materialized entry (no postponed state) is a finished document —
            // serve it outright, no resume.
            if (
              entryValue?.kind === "APP_PAGE" &&
              entryHtml !== undefined &&
              entryPostponed === undefined &&
              req.method === "GET" &&
              req.headers[rscConfig?.header ?? "rsc"] !== "1"
            ) {
              res.writeHead(entryValue.status ?? 200, {
                "content-type": "text/html; charset=utf-8",
                ...sanitizeStoredEntryHeaders(entryValue.headers),
              });
              res.end(entryHtml);
              return;
            }

            // A DYNAMIC RSC request (rsc: 1, not a prefetch, not a segment prefetch) must
            // NOT take minimal+inject: a resume produces only the dynamic TAIL, but the
            // values the client asserts on live in the STATIC part (resume-data-cache:
            // seed-era dynamic RSC lacked the shell's number on a virgin keyspace). It runs
            // NON-minimal instead — the entrypoint itself does incrementalCache.get on the
            // resolved pathname and threads the entry's postponed RDC into the full dynamic
            // render (app-page-runtime.ts:1352-1391), self-contained over the shared
            // handler, and schedules its own background revalidation when the entry is
            // tag-stale.
            const isDynamicRsc =
              req.headers[rscConfig?.header ?? "rsc"] === "1" &&
              req.headers["next-router-prefetch"] !== "1" &&
              segmentPrefetchPath === undefined;
            // A STORED entry's postponed token injects even when the SEED is stale — the
            // stored entry passed the handler's own tag check. The disk-shell path keeps
            // the shellUsable gate.
            if (
              !isDynamicRsc &&
              (entryPostponed !== undefined || (shellUsable && shellAvailable))
            ) {
              const meta = ((req as any)[NEXT_REQUEST_META] as Record<string, unknown>) ?? {};
              // The materialized entry's token wins over the build token — it carries the
              // regenerated Resume Data Cache.
              meta.postponed = entryPostponed ?? pprInfo.postponedState;
              (req as any)[NEXT_REQUEST_META] = meta;
              pprInvocationHeaders = pprInfo.chainHeaders;
              pprShellInjected = true;

              // Direct handler invocation with requestMeta.postponed returns only the resumed
              // dynamic stream. For document requests, prepend the fallback shell so the
              // client receives the single `[shell][resume]` response required by the PPR
              // protocol. RSC requests consume only the resumed flight stream and must not get
              // HTML prepended.
              // N43: the BUILD-PINNED RSC header name, as every neighbouring check uses. With
              // `req.headers.rsc` hardcoded, an app with a custom RSC header name had the HTML
              // shell prepended to a flight stream — a corrupt payload, not a degraded one.
              const isDocumentRequest =
                req.method === "GET" &&
                req.headers[rscConfig?.header ?? "rsc"] !== "1" &&
                req.headers["next-router-prefetch"] !== "1";
              if (isDocumentRequest) {
                // An entry-backed prefix carries the REGENERATION's headers/status
                // (sanitized); the build-time initialHeaders/initialStatus belong to the
                // disk shell only.
                const entryBacked = entryPostponed !== undefined && entryHtml !== undefined;
                pprResponsePrefix = {
                  ...(entryBacked ? { content: entryHtml } : { filePath: shellPath }),
                  ...(entryBacked
                    ? {
                        headers: sanitizeStoredEntryHeaders(entryValue?.headers),
                        ...(entryValue?.status ? { status: entryValue.status } : {}),
                      }
                    : {
                        ...(pprInfo.initialHeaders ? { headers: pprInfo.initialHeaders } : {}),
                        ...(pprInfo.initialStatus ? { status: pprInfo.initialStatus } : {}),
                      }),
                };
              }
            } else if (!isDynamicRsc) {
              // No entry and no usable shell: the foreground request degrades to the
              // non-minimal live render while a canonical regeneration fills the store.
              //
              // NEVER from a dynamic RSC request (traced live 2026-08-04, rdc): the
              // x-prerender-revalidate re-entry cannot succeed for cache-components routes
              // — patch-fetch skips every fetch-cache read under
              // workStore.isOnDemandRevalidate (patch-fetch.ts:1019), so the render
              // live-fetches under the prerender's abort signal and dies with "uncached or
              // runtime data" — and its doomed read WINS the single-flight revalidate lock,
              // so the entrypoint's own read milliseconds later is told FRESH and its
              // WORKING background revalidation (forceStaticRender,
              // isOnDemandRevalidate=false) never schedules. Dynamic RSC runs non-minimal
              // and the ENTRYPOINT owns regeneration (app-page-runtime.ts:1395-1435).
              scheduleRegen();
            }
          }

          // Load and invoke the handler directly
          const handler = await handlerLoader.load(handlerPathname);
          const bufferedBody = bufferedActionBody(req);

          // First serve of a fully-keyed platform entry — record it so later
          // serves of the same key replay the stored bytes (see the early-serve above).
          if (process.env.ADAPTER_K8S_CACHE_TRACE === "1") {
            // Rung-input dump for the runtime-static diagnosis (probe deployments only).
            console.log(
              `[cache-trace] ${JSON.stringify({
                op: "gate-inputs",
                injected: pprShellInjected,
                ...pprTraceDetail,
                url: req.url,
                matched: resolution.matchedPathname,
                handlerPathname,
                type: handlerOutputInfo?.type,
                staticAsset: dispatchStaticAsset?.pathname ?? null,
                pprInfo: !!handlerPprInfo,
                pprCapable: handlerPprCapable,
                shared: incrementalCacheShared,
                runtimeStaticHit:
                  runtimeStaticTemplates.has(resolution.matchedPathname) ||
                  runtimeStaticTemplates.has(handlerPathname),
              })}`,
            );
          }
          const storeCapture =
            platformFullyKeyed && !platformCacheSeen && platformKey && platformStoreEligible
              ? captureResponseForStore(res, PLATFORM_STORE_MAX_BODY)
              : undefined;

          await localHandlerInvoker({
            handler,
            req,
            res,
            matchedPathname: handlerPathname,
            routeMatches: resolution.routeMatches,
            bufferedBody,
            ...(resolution.invokePath
              ? {
                  // A dynamic RSC request resolves to the `.rsc` OUTPUT id, but the
                  // invocation path becomes requestMeta.resolvedPathname, and the
                  // entrypoint's RDC branch keys BOTH incrementalCache.get and
                  // prerenderManifest.routes by the PAGE path (app-page-runtime.ts:1373)
                  // — "/index.rsc" misses everything and the render loses the RDC. Strip
                  // the variant suffix for exactly these requests; every other flow keeps
                  // the output id (matrix cache-key semantics depend on it).
                  invocationPath: (() => {
                    const dynRsc =
                      req.headers[rscConfig?.header ?? "rsc"] === "1" &&
                      req.headers["next-router-prefetch"] !== "1" &&
                      typeof req.headers["next-router-segment-prefetch"] !== "string";
                    if (!dynRsc) return resolution.invokePath;
                    const u = new URL(resolution.invokePath, "http://localhost");
                    const base = rscParentCandidates(u.pathname, rscConfig)[0];
                    return base ? `${base}${u.search}` : resolution.invokePath;
                  })(),
                }
              : {}),
            // Next compiles an i18n index rewrite to a locale-prefixed concrete prerender, then
            // maps that artifact back to a locale-prefixed dynamic Pages handler. `invokePath`
            // deliberately strips an auto-added default locale, so it cannot recover the
            // handler's catch-all params. Preserve the resolver's concrete output solely for
            // param extraction. This is normal entrypoint metadata in production as well as the
            // NEXT_ENABLE_ADAPTER filesystem-cache harness; it does not alter req.url or caching.
            ...(resolution.matchedPathname !== handlerPathname &&
            !resolution.matchedPathname.includes("[")
              ? {
                  // N9: align the locale prefix with the chosen template first — see
                  // localeAlignedRouteParamPathname. Handing `/en-US` to `/[[...slug]]`
                  // made the locale itself the first catch-all param.
                  // Strip a concrete RSC/segment variant suffix before deriving params:
                  // @next/routing >= 16.3.0-preview.10 no longer supplies routeMatches for
                  // a statically-matched `.rsc` variant (shouldUseDynamicMatch gate), and
                  // parsing "/prerendered.rsc" against /[slug] put the transport suffix IN
                  // THE PARAM ("Slug: prerendered.rsc", baseline v12).
                  routeParamPathname: localeAlignedRouteParamPathname(
                    rscParentCandidates(resolution.matchedPathname, rscConfig).at(-1) ??
                      resolution.matchedPathname,
                    handlerPathname,
                    i18nLocales,
                  ),
                }
              : {}),
            ...(resolution.invocationQuery ? { invocationQuery: resolution.invocationQuery } : {}),
            // App ROUTE handlers read search params from the request URL only — there is no
            // requestMeta channel for them (see mergeInvocationQueryIntoUrl). Every other entry
            // kind receives the rewrite query through requestMeta.query and must keep the public
            // URL byte-exact so req.url / router.asPath / usePathname match `next start`.
            ...(handlerOutputInfo?.type === "APP_ROUTE"
              ? { mergeInvocationQueryIntoUrl: true }
              : {}),
            ...(i18nLocales.length > 0 ? { i18nLocales } : {}),
            ...(pprResponsePrefix ? { responsePrefix: pprResponsePrefix } : {}),
            ...(pprInvocationHeaders ? { invocationHeaders: pprInvocationHeaders } : {}),
            // Production invokes generated entrypoints in minimal mode because platform caching
            // lives outside Next: Cloud CDN may hold only public-safe variants, while Valkey owns
            // PPR/ISR/tag-sensitive entries. NEXT_ENABLE_ADAPTER's local harness has neither. Its
            // explicitly gated filesystem stand-in must use non-minimal mode only for routes with
            // a real build-emitted PPR shell so Next can read that shell locally. Routes whose
            // prerender metadata says `fallback: null` stay minimal and block-render; otherwise a
            // generic build shell is incorrectly served while the concrete URL renders later.
            // Use handler capability rather than `manifestPprInfo` here. A concrete document can
            // intentionally suppress build-token injection while a dynamic RSC request for the
            // same PPR-capable handler still needs Next's local cache to recover its RDC.
            // PPR routes when a classic incremental cacheHandler is registered
            // (incrementalCacheShared — production Valkey) must ALSO run non-minimal: minimal
            // mode makes the entrypoint answer a document request with the bare postponed shell
            // plus `x-nextjs-postponed: 1` and expects the PLATFORM to run the resume dance —
            // which this adapter does not implement for the entry-owned shell (the build-token
            // injection above is deliberately gated off when the entry owns the shell). Every
            // PPR document was therefore served as an unfinished shell (dynamic holes never
            // streamed) on live. Non-minimal mode lets Next itself do the shell lookup +
            // resume join against the SHARED Valkey-backed incremental cache — the same
            // ownership model the entrypointOwnsPprShell harness case uses with its
            // filesystem cache, and cross-replica correct because revalidateTag writes
            // through the same registered handler.
            minimalMode: !(
              // A partial-prefetch template with no shell or unresolved root params normally
              // stays minimal (N16), but a fully keyed entry is a complete cache value: every
              // route param participates in allowQuery. In production the process-local response
              // store is disabled, so minimal mode would render it without ever calling the
              // registered incremental cache handler. Let Next persist the structured APP_PAGE
              // entry through shared Valkey; templates missing even one key param keep the
              // minimal/platform-owned path.
              (
                (partialPrefetching &&
                  incrementalCacheShared &&
                  handlerPprCapable &&
                  platformFullyKeyed) ||
                // N16: a shell-bearing PPR template, or one the build left shell-less because
                // root params were unresolved. Do not flip every shell-less route non-minimal:
                // upstream dynamically renders the no-root-param flavour, and doing so regressed
                // app-dir/fallback-shells. The capture-and-resume path below handles the subset
                // that postpones at runtime without changing this gate.
                // Shell-bearing templates (handlerPprInfo) go non-minimal ONLY in emulate
                // mode, where the entrypoint's own filesystem cache holds the build shells
                // and Next resumes internally. Under a SHARED cache the entrypoints are
                // per-request render modules with no route-shell orchestration (measured:
                // k3d sub-shell-generation served "(runtime)" layouts), so those routes now
                // take the same minimal+inject path as the no-classic-handler case below.
                // Shell-LESS root-param templates still need non-minimal in both modes (N16).
                // A VERIFIED preview / on-demand-revalidate request always runs NON-minimal:
                // next start serves these through the full server, so getStaticProps sees
                // revalidateReason 'on-demand' and the fresh entry persists through the
                // registered cache handler. The minimal rungs exist for platform-cache
                // emulation, which must never intercept an authenticated revalidation.
                isVerifiedPreviewRequest(req) ||
                ((entrypointOwnsPprShell ||
                  // partialPrefetching builds get NO injection (the partialFallback serving
                  // contract is Next's, see the injection gate) — so they must never run
                  // minimal either: minimal + no injected shell is a truncated document
                  // (bare postponed shell, dynamic holes never streamed). With a shared
                  // cache the rung below already forces non-minimal; this makes the
                  // no-Valkey posture safe too (per-pod cache incoherence over truncation).
                  partialPrefetching ||
                  // Under a shared cache, a shell-bearing route is minimal exactly when its
                  // shell was actually injected above; every unusable-shell reason (stale,
                  // window-expired, missing file, Server Action) falls through to Next's
                  // non-minimal complete render. Shell-less routes keep their own rungs.
                  (incrementalCacheShared && (!handlerPprInfo || !pprShellInjected))) &&
                  // The build-time `.rsc` sibling postponed state is deliberately not a rung
                  // here. It does not discriminate, so using it is indistinguishable from the
                  // blunter `|| handlerPprCapable` that was rejected earlier:
                  //   with the rung:    fallback-shells 8 passed / 5 failed
                  //   without the rung: fallback-shells 13 passed / 0 failed
                  // and in both cases otel-spans stays 3/1 — `early-span` starts passing
                  // while `prerendering at runtime` starts failing, because flipping those
                  // routes non-minimal also changes their MISS→HIT caching.
                  // Runtime capture supplies the missing discriminator. Only a render that
                  // returns x-nextjs-postponed and a captured cache entry starts a resume.
                  (!!handlerPprInfo || handlerPprRootParams)) ||
                ((emulatePlatformCache || incrementalCacheShared) &&
                  !!dispatchStaticAsset?.prerender &&
                  !dispatchStaticAsset.ppr) ||
                // N13: a concrete path served through an SSG/ISR app template has no build
                // artifact of its own (`/rewrite/not-broken` behind `/rewrite/[slug]`).
                // Minimal mode makes the entrypoint re-render it every time and emit NO
                // x-nextjs-cache, so the harness — which stands Next's filesystem cache in
                // for the platform cache — never observes the MISS→HIT transition
                // `next start` reports. PPR keeps its own gate above; Pages Router keeps
                // minimal mode (its fallback-shell emulation owns that lifecycle).
                // `!handlerPprCapable` as well as `!handlerPprInfo`: a PPR template with no
                // build shell is still PPR, and `asset.ppr` is only set on outputs that carry a
                // postponed state, so the concrete `foo` prerender under a PPR `[slug]` looks
                // exactly like a plain SSG instance here. Without this rung, fallback-shells'
                // `without-suspense`/`without-io` routes were flipped non-minimal by THIS clause
                // even after the N16 gate above was narrowed.
                ((emulatePlatformCache || incrementalCacheShared) &&
                  !handlerPprInfo &&
                  !handlerPprCapable &&
                  handlerOutputInfo?.type === "APP_PAGE" &&
                  emulatedSsgTemplates.has(handlerPathname)) ||
                // Runtime-static generation (sub-shell-generation-middleware): a template
                // whose prerender-manifest entry says `fallback: null` is generatable at
                // runtime — `next start` renders a never-prerendered concrete path
                // NON-minimally and MATERIALIZES it (first request writes, second is HIT).
                // A minimal render never writes through the cache handler, so these
                // requests were MISS forever (measured: zero Valkey writes on the lane-4
                // probe). Deliberately narrow: shared cache, an APP_PAGE handler, no
                // concrete build asset (the asset rung above owns that case), and not
                // PPR-capable (PPR templates keep their own rungs).
                (incrementalCacheShared &&
                  !dispatchStaticAsset &&
                  !handlerPprInfo &&
                  !handlerPprCapable &&
                  handlerOutputInfo?.type === "APP_PAGE" &&
                  (runtimeStaticTemplates.has(resolution.matchedPathname) ||
                    runtimeStaticTemplates.has(handlerPathname)))
              )
            ),
            normalizePrerenderCacheControl:
              !!dispatchStaticAsset?.prerender && handlerOutputInfo?.type === "PAGES",
            render404: render404FromEntrypoint,
            renderError: renderErrorFromEntrypoint,
            handlerTimeoutMs: requestHeadTimeoutMs,
            ...(remainingExecutionMs !== undefined
              ? { executionTimeoutMs: remainingExecutionMs }
              : {}),
            // Option D (spec rev 4): shell-less PPR template with no root params — if this
            // MINIMAL render postpones live, the invoker captures the state and performs the
            // canonical POST resume itself. Excluded: shell-bearing routes (their injection
            // path above owns the dance), Server Actions (the x-next-resume-state-length body
            // framing is theirs), and requests that already ARE resumes.
            capturePostponedState:
              !handlerPprInfo &&
              !req.headers["next-action"] &&
              !req.headers["x-next-resume-state-length"] &&
              req.headers["next-resume"] !== "1" &&
              pprCapableCandidates.some((candidate) => pprCapableResumeRoutes.has(candidate)),
            buildFallbackBacked: !!pprInfo,
            ...(platformCacheSeen !== undefined ? { platformCacheSeen } : {}),
            ...(revalidate ? { revalidate } : {}),
          });
          if (storeCapture && platformKey) {
            const entry = storeCapture.finish();
            if (entry && entry.status === 200) storePlatformResponse(platformKey, entry);
          }
          return;
        }
      }
    },
  };
}

/**
 * S15: the dispatch headers `proxyToPool` sets ITSELF. Everything else in the vocabulary is
 * removed from the forwarded request, because this hop attaches the internal secret and would
 * otherwise promote leftovers to trusted input at the sibling pool.
 */
const ASSERTED_BY_THIS_HOP: Record<string, true> = {
  "x-output-id": true,
  "x-matched-pathname": true,
  "x-route-matches": true,
  "x-mw-evaluated": true,
  "x-invoke-path": true,
  "x-invoke-query": true,
  [INTERNAL_EXECUTION_DEADLINE_HEADER]: true,
  [INTERNAL_DISPATCH_PROOF_HEADER]: true,
};

function proxyToPool(
  req: IncomingMessage,
  res: ServerResponse,
  resolution: Extract<ResolveResult, { kind: "route" }>,
  releaseName: string,
  buildId: string,
  internalSecret?: string,
  proxyTimeoutMs: number = PROXY_TIMEOUT_MS,
  executionDeadlineAt?: number,
  proofHeaderNames?: readonly string[] | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let deadlineExceeded = false;
    const targetHost = sanitizeK8sName(`${releaseName}-${resolution.pool}-${buildId}`);
    const bufferedBody = bufferedActionBody(req);

    // Hop-by-hop headers (and anything the client's Connection header nominated) are
    // stripped before forwarding — they describe the client↔pool connection, and Node
    // sets its own connection semantics on the outbound request.
    const forwardHeaders: Record<string, string | string[] | undefined> = {
      ...stripRequestHopByHopHeaders(req.headers),
      "x-output-id": resolution.matchedPathname,
      "x-matched-pathname": resolution.matchedPathname,
      "x-route-matches": resolution.routeMatches ? JSON.stringify(resolution.routeMatches) : "",
      // Rewrite invocation target (path+query with repeated destination keys restored). The
      // public req.url is forwarded as-is above — and stays the entrypoint's req.url — so
      // without these the target pool's dispatch has no rewrite target at all: the handler
      // would run with the ORIGINAL route's params and the rewrite-added query would be
      // silently dropped (same wire vocabulary the ext_proc routing service stamps).
      ...(resolution.invokePath ? { "x-invoke-path": resolution.invokePath } : {}),
      ...(resolution.invocationQuery
        ? { "x-invoke-query": JSON.stringify(resolution.invocationQuery) }
        : {}),
      ...(executionDeadlineAt !== undefined
        ? { [INTERNAL_EXECUTION_DEADLINE_HEADER]: String(executionDeadlineAt) }
        : {}),
      // This pool already ran the middleware stage in its Phase-1 resolve before deciding
      // to proxy; assert it so the target pool trusts the skip instead of re-running
      // middleware (which would double-apply cookies/redirects). Without this, the target's
      // x-mw-evaluated gate would fall through to a second evaluation.
      "x-mw-evaluated": "ran",
    };
    // S15 (SECURITY). Drop any dispatch header this hop did not itself assert. `req.headers`
    // was replaced wholesale a few lines up with the middleware's FINAL request-header set,
    // and the request below carries the dispatch proof — so whatever survives the spread
    // arrives at the sibling pool as TRUSTED input. The explicit assignments above cover only
    // six of the ten names: `x-resolved-headers` (which the receiving pool merges into the
    // RESPONSE), `x-upstream-pool`, `x-nextjs-ppr` and `x-mw-request-headers` used to ride
    // through unguarded. Deleted AFTER the assignments so this is an allowlist of exactly what
    // this hop asserts, not a filter that a new header can slip past.
    for (const h of [
      ...INTERNAL_DISPATCH_HEADERS,
      INTERNAL_SECRET_HEADER,
      INTERNAL_DISPATCH_PROOF_HEADER,
    ]) {
      if (!(h in ASSERTED_BY_THIS_HOP)) delete forwardHeaders[h];
    }

    // The trust credential is a per-request PROOF, never the raw secret (routing-common.ts
    // INTERNAL_DISPATCH_PROOF_HEADER): computed over the exact dispatch set this hop asserts plus
    // the forwarded method/URL, authority, forwarding witnesses and matcher inputs, so a proof
    // observed in transit authenticates only this request. Signed over `forwardHeaders` — the
    // FINAL outbound state, after the eviction above and including the `host`/`x-forwarded-*`
    // values this hop actually relays — so the sibling pool recomputes the identical transcript
    // from what it receives.
    //
    // A0-DP-5 (SECURITY). This is the one hop that CAN bind the body, and it must: the credential
    // authenticated the header tuple only, so an observer of a POST hop could replay the proof with
    // an arbitrary body and the sibling pool would honor `x-mw-evaluated: ran` for bytes middleware
    // never saw. `bufferedActionBody` is populated for every non-GET/HEAD request on the serving
    // path (index.ts buffers the body before routing), so this binds real bytes in practice; the
    // streaming fallback below has no digest to offer and binds ABSENT. The mint time is bound too,
    // which is what bounds a replay in time rather than merely per-tuple.
    //
    // A0-DP-2. The signed octets are latin1 (`wireHeaderBytes`), which is exactly what `httpRequest`
    // below writes for every code point up to U+00FF — and U+00FF is the ceiling for BOTH: Node
    // refuses to emit a header value above it (ERR_INVALID_CHAR) or a path containing one
    // (ERR_UNESCAPED_CHARACTERS). So a forwarded value that latin1 would truncate never reaches
    // the wire from here at all; the hop throws instead, and no sibling pool is handed truncated
    // octets to verify. See the range note on `wireHeaderBytes`.

    // Same forged-framing guard as the loopback invocation: the target pool would
    // otherwise await body bytes that never arrive (hang until requestTimeout).
    // BEFORE signing, deliberately: this rewrites `content-length`, which a middleware `matcher`
    // can pull into the covered set, and the proof's contract is that it signs the FINAL outbound
    // header state. Signing first left the client's declared length in the transcript and the
    // restated one on the wire.
    restateFramingHeaders(forwardHeaders, bufferedBody, req.method, false);

    if (internalSecret) {
      forwardHeaders[INTERNAL_DISPATCH_PROOF_HEADER] = computeDispatchProof(
        internalSecret,
        dispatchProofInputsFromRequest(
          {
            method: req.method,
            target: req.url,
            headers: forwardHeaders,
            proofHeaderNames,
          },
          { body: bufferedBody },
        ),
      );
    }
    // This pool's Phase-1 routing verdict (next.config headers() + middleware response
    // headers) is deliberately NOT forwarded in the x-resolved-headers slot: the
    // resolvedHeaders on this resolution already installed the writeHead merge wrapper
    // on the OUTER res (dispatch() line above), which applies them to the relayed
    // response. Forwarding them too made the target pool's dispatcher merge them a
    // second time — the client received middleware's Set-Cookie twice. The pool that
    // ran the resolve is the single application point.

    const proxyReq = httpRequest(
      {
        hostname: targetHost,
        port: 3000,
        path: req.url,
        method: req.method,
        headers: forwardHeaders,
      },
      (proxyRes) => {
        clearTimeout(responseHeadDeadline);
        res.writeHead(proxyRes.statusCode ?? 502, stripHopByHopHeaders(proxyRes.headers));
        // pipeline handles errors on either end (e.g. client disconnect) and cleans up
        // both streams, unlike a bare .pipe().
        pipeline(proxyRes, res, () => resolve());
      },
    );

    // A socket idle timeout is not a deadline: DNS/connect and informational traffic can reset
    // it. This wall-clock timer starts before dialing and is cleared only by final headers.
    const responseHeadDeadline = setTimeout(() => {
      deadlineExceeded = true;
      proxyReq.destroy(
        new DeadlineExceededError(
          `cross-pool proxy to pool "${resolution.pool}" exceeded its response-head deadline`,
        ),
      );
    }, proxyTimeoutMs);
    responseHeadDeadline.unref?.();

    proxyReq.on("error", (err) => {
      clearTimeout(responseHeadDeadline);
      // A client abort is our own deliberate teardown, not a pool failure — log it at
      // info level and skip the 502 (the client is gone anyway).
      if (err instanceof ClientAbortError) {
        console.log(
          `[pool-server] cross-pool proxy to pool "${resolution.pool}" aborted: client disconnected`,
        );
        resolve();
        return;
      }
      // Pool name + dial error stay in the server log — the client body must not leak
      // pool topology or internal hostnames.
      console.error(
        `[pool-server] cross-pool proxy to pool "${resolution.pool}" (${targetHost}) failed:`,
        err,
      );
      if (!res.headersSent) {
        res.writeHead(deadlineExceeded ? 504 : 502, { "content-type": "text/plain" });
        res.end(deadlineExceeded ? "Gateway Timeout" : "Bad Gateway");
      }
      resolve();
    });

    // Client disconnected before the target pool answered — cancel the upstream request.
    abortOnClientClose(res, () => proxyReq.destroy(new ClientAbortError()));

    if (bufferedBody) {
      proxyReq.end(bufferedBody);
    } else if (req.method !== "GET" && req.method !== "HEAD") {
      // GET/HEAD carry no body: piping the raw stream would wait for bytes that
      // (with a forged content-length) never arrive — hang. End immediately instead.
      pipeline(req, proxyReq, () => undefined);
    } else {
      proxyReq.end();
    }
  });
}

export function getContentType(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".rsc":
      return "text/x-component";
    case ".xml":
      return "application/xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".webmanifest":
      return "application/manifest+json";
    case ".wasm":
      return "application/wasm";
    case ".map":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case "":
      return "text/html; charset=utf-8"; // extensionless routes (/, /about, etc.)
    default:
      return "application/octet-stream";
  }
}

function getStaticAssetContentType(filePath: string, publicPathname: string): string {
  const artifactType = getContentType(filePath);
  if (artifactType !== "application/octet-stream") return artifactType;

  // Next stores prerendered metadata route bodies under opaque artifact names such as `.body`.
  // Their public pathname is the authoritative source of the media type. Keep this deliberately
  // narrow: a generic extensionless public asset may genuinely be binary and must not become HTML.
  if (
    /(?:^|\/)robots\.txt$/.test(publicPathname) ||
    /(?:^|\/)sitemap(?:\/\d+)?\.xml$/.test(publicPathname) ||
    /(?:^|\/)manifest\.(?:json|webmanifest)$/.test(publicPathname) ||
    /(?:^|\/)(?:icon|apple-icon|opengraph-image|twitter-image)(?:-[^/]+)?\.(?:png|svg|ico|jpe?g|gif|webp|avif)$/.test(
      publicPathname,
    )
  ) {
    return getContentType(publicPathname);
  }

  return artifactType;
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
