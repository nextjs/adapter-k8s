// Next.js generated App Route WebSocket dispatch for the pool server.
//
// The public application API is intentionally NOT implemented here. Next owns the future
// `NextResponse.upgrade()` object, executes the route's normal GET exactly once, and compiles an
// additive adapter-facing `upgradeHandler(ctx, { node: { req, socket, head } })` export. This file
// supplies the persistent Node transport around that generated entrypoint: trusted routing,
// fail-safe local resolution, cross-pool tunnelling, bounded handshakes, and HTTP rejection.
import {
  request as httpRequest,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  computeDispatchProof,
  dispatchProofInputsFromRequest,
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_EXECUTION_DEADLINE_HEADER,
  INTERNAL_SECRET_HEADER,
  MW_EVALUATED_TRUSTED,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
  parseRequestUrl,
} from "../routing-common.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";
import {
  applyMiddlewareRequestHeaders,
  extractRouteParams,
  validatedForwardedProtocol,
} from "./dispatch.js";
import type { HandlerLoader } from "./handler-loader.js";
import type { ResolveResult } from "./resolve.js";
import { trackTunnelFraming } from "./websocket-frame-cursor.js";

/**
 * N90. Who owns FRAMING on an accepted socket, which is what shutdown needs to know before it
 * writes anything into one (createPoolServer's drain, and the same union on its `onUpgrade`).
 *
 * - `accepted-local`: Next's generated ws stack owns this socket. It writes each frame
 *   synchronously under cork, so a close frame injected between frames cannot interleave with a
 *   partially written one — the drain path may stamp RFC 6455 code 1001 itself.
 * - `accepted-tunnel`: the socket is one end of `proxyUpgradeToPool`'s byte pipe. Nothing here
 *   owns its framing: a frame relayed from the sibling pool routinely spans several TCP chunks, so
 *   at any instant the client may hold a partially relayed frame whose header already promised N
 *   more payload bytes, and a close frame written there lands INSIDE that payload and corrupts the
 *   stream. The drain path therefore asks websocket-frame-cursor.ts whether the client-bound relay
 *   is provably between frames (N91) and injects only then; otherwise it injects nothing and
 *   relays whatever close frame the peer pool's own drain emits.
 *
 * Deliberately not a boolean `accepted`: conflating the two ownership models is exactly what put
 * a close frame into the middle of a relayed frame, so every accepting path must now say which.
 */
export type UpgradeDisposition = "accepted-local" | "accepted-tunnel" | "rejected";

export interface WebSocketUpgradeDispatcher {
  resolve(
    url: URL,
    headers: Headers,
    method: string,
    body: ReadableStream<Uint8Array>,
  ): Promise<ResolveResult>;
  handlerLoader: HandlerLoader;
  poolName: string;
  releaseName: string;
  buildId: string;
  internalSecret?: string | undefined;
  /** Build-derived matcher and RSC headers covered by the cross-pool dispatch proof. */
  proofHeaderNames?: readonly string[] | undefined;
  /** Stable server-owned scope required by Next's generated connection registry. */
  webSocketRegistryScope: object;
  /** Exact cross-origin values accepted by experimental.webSocketRouteHandlers. */
  webSocketAllowedOrigins?: readonly string[];
  /** Parser from the app's pinned `next/dist/compiled/ws` transport. */
  parseWebSocketExtensions?: ((value: string) => unknown) | undefined;
  /** Absolute budget for resolution + module load + generated handler acceptance. */
  handshakeTimeoutMs?: number;
  /** Test seam for a sibling pool endpoint; production uses Kubernetes service DNS on port 3000. */
  resolvePoolEndpoint?: ((poolName: string) => { hostname: string; port: number }) | undefined;
}

const MAX_REJECTION_BODY_BYTES = 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;
const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");
const NEXT_WEBSOCKET_HEADERS_FILTERED = Symbol.for("next.websocket.upgrade-headers-filtered");
const BODY_FRAMING_HEADERS = ["content-length", "transfer-encoding", "expect", "trailer"];
const BODY_FRAMING_ERROR = "WebSocket upgrade requests cannot include HTTP body framing.";
const RAW_HTTP_ERROR_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

interface GeneratedUpgradeOutcome {
  statusCode?: number;
  upgraded: boolean;
}

interface WebSocketHandshakeError {
  status: number;
  message: string;
  headers?: Record<string, string>;
}

class HandshakeDeadlineError extends Error {
  constructor(stage: string) {
    super(`WebSocket ${stage} exceeded the handshake deadline`);
    this.name = "HandshakeDeadlineError";
  }
}

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function isPrivateResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "x-next-cache-tags" ||
    lower === INTERNAL_SECRET_HEADER ||
    lower === INTERNAL_DISPATCH_PROOF_HEADER ||
    (INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(lower) ||
    lower.startsWith("x-middleware-")
  );
}

function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
  }
  return headers;
}

function rawHeaderValues(req: IncomingMessage, headerName: string): string[] {
  const values: string[] = [];
  if (Array.isArray(req.rawHeaders) && req.rawHeaders.length > 0) {
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
      if (req.rawHeaders[index]?.toLowerCase() === headerName) {
        values.push(req.rawHeaders[index + 1] ?? "");
      }
    }
    return values;
  }
  const value = req.headers[headerName];
  if (value === undefined) return values;
  return Array.isArray(value) ? value : [value];
}

function exactHttpOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.hostname.includes("*") &&
      url.origin === value
    ) {
      return url;
    }
  } catch {
    // Invalid authorities and Origins are protocol errors, not URL-parser failures.
  }
  return undefined;
}

// Same-origin authority a browser's `Origin` is compared against. TLS terminates at the load
// balancer, so the pool's own socket is plain http even for a wss:// handshake against an https
// site — deriving the scheme from `socket.encrypted` computed `http://host` and 403'd every
// legitimate same-origin `Origin: https://host`. The validated x-forwarded-proto witness is the
// same signal the HTTP path uses (requestProtocol in dispatch.ts); socket.encrypted is only the
// fallback for a direct connection that carries no witness at all.
function webSocketRequestAuthority(req: IncomingMessage): URL | undefined {
  const hosts = rawHeaderValues(req, "host");
  if (hosts.length !== 1 || !hosts[0] || /\s|[\\/@?#,]/.test(hosts[0])) return undefined;
  const encrypted = Boolean((req.socket as { encrypted?: boolean } | undefined)?.encrypted);
  const scheme = validatedForwardedProtocol(req) ?? (encrypted ? "https" : "http");
  return exactHttpOrigin(`${scheme}://${hosts[0]}`);
}

function validateWebSocketHandshake(
  req: IncomingMessage,
  parseWebSocketExtensions: ((value: string) => unknown) | undefined,
): WebSocketHandshakeError | undefined {
  if (req.httpVersion !== "1.1") {
    return { status: 400, message: "WebSocket upgrades require HTTP/1.1." };
  }
  if (req.method !== "GET") {
    return { status: 405, message: "WebSocket upgrades require GET.", headers: { allow: "GET" } };
  }
  if (BODY_FRAMING_HEADERS.some((name) => rawHeaderValues(req, name).length > 0)) {
    return { status: 400, message: BODY_FRAMING_ERROR };
  }
  if (rawHeaderValues(req, "host").length !== 1) {
    return { status: 400, message: "Invalid WebSocket Host header." };
  }
  if (rawHeaderValues(req, "upgrade").length !== 1) {
    return { status: 400, message: "Invalid WebSocket Upgrade header." };
  }
  if (rawHeaderValues(req, "sec-websocket-version").length !== 1) {
    return {
      status: 426,
      message: "Unsupported WebSocket version.",
      headers: { "sec-websocket-version": "13" },
    };
  }
  if (rawHeaderValues(req, "sec-websocket-key").length !== 1) {
    return { status: 400, message: "Invalid Sec-WebSocket-Key header." };
  }
  if (rawHeaderValues(req, "origin").length > 1) {
    return { status: 400, message: "Invalid WebSocket Origin header." };
  }
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    return { status: 400, message: "Invalid WebSocket Upgrade header." };
  }
  const connection = req.headers.connection;
  if (!connection?.split(",").some((value) => value.trim().toLowerCase() === "upgrade")) {
    return { status: 400, message: "Invalid WebSocket Connection header." };
  }
  if (req.headers["sec-websocket-version"] !== "13") {
    return {
      status: 426,
      message: "Unsupported WebSocket version.",
      headers: { "sec-websocket-version": "13" },
    };
  }
  if (!webSocketRequestAuthority(req)) {
    return { status: 400, message: "Invalid WebSocket Host header." };
  }
  const key = req.headers["sec-websocket-key"];
  if (
    typeof key !== "string" ||
    !/^[+/0-9A-Za-z]{22}==$/.test(key) ||
    Buffer.from(key, "base64").byteLength !== 16
  ) {
    return { status: 400, message: "Invalid Sec-WebSocket-Key header." };
  }
  const protocolHeader = req.headers["sec-websocket-protocol"];
  if (protocolHeader !== undefined) {
    const protocols = (Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader)
      .split(",")
      .map((protocol) => protocol.trim());
    const seen = new Set<string>();
    for (const protocol of protocols) {
      if (!HTTP_TOKEN.test(protocol) || seen.has(protocol)) {
        return { status: 400, message: "Invalid Sec-WebSocket-Protocol header." };
      }
      seen.add(protocol);
    }
  }
  // Sec-WebSocket-Extensions is validated ONLY when the app's pinned ws transport actually
  // exports its parser — RFC 6455's extension grammar has enough edge cases that a hand-rolled
  // approximation would drift from what the ws stack downstream accepts, and two disagreeing
  // parsers on one handshake is worse than one.
  //
  // N89. The adapter must DEGRADE, not fail, when that parser is absent. `next/dist/compiled/ws`
  // is an nccc bundle whose only public exports are the transport classes (CONNECTING…CLOSED,
  // createWebSocketStream, Server, Receiver, Sender, WebSocket, WebSocketServer) — `extension` is
  // internal to the bundle and is NOT exported as of Next 16.3.0. Throwing here therefore fired
  // on every handshake carrying this header, i.e. every real browser (all of them offer
  // permessage-deflate): the rejected promise landed in createPoolServer's upgrade `.catch`,
  // which destroyed the socket after writing ZERO bytes, so the client saw a bare TCP close
  // rather than any HTTP status and the pod logged one "Unhandled WebSocket upgrade error" per
  // attempt. Skipping the check keeps browser WebSockets working and costs no trust boundary:
  // nothing in this file reads the extensions header (unlike host/origin/key/version, which
  // decide same-origin and handshake validity), it is relayed verbatim on a cross-pool hop, and
  // the party that negotiates extensions is Next's generated ws stack — `WebSocketServer`
  // parses this header itself and answers 400 when perMessageDeflate is enabled, and ignores it
  // (negotiating nothing, so framing stays plain RFC 6455) when it is not. An unparseable value
  // can therefore never reach frame decoding as an active extension.
  const extensions = rawHeaderValues(req, "sec-websocket-extensions");
  if (extensions.length > 0 && parseWebSocketExtensions) {
    try {
      // Use the exact parser pinned by the application's Next transport, as Next itself does.
      parseWebSocketExtensions(extensions.join(","));
    } catch {
      return { status: 400, message: "Invalid Sec-WebSocket-Extensions header." };
    }
  }
  return undefined;
}

function validateWebSocketOrigin(
  req: IncomingMessage,
  allowedOrigins: readonly string[] = [],
): WebSocketHandshakeError | undefined {
  const origins = rawHeaderValues(req, "origin");
  if (origins.length === 0) return undefined;
  if (origins.length !== 1) {
    return { status: 403, message: "WebSocket origin is not allowed." };
  }
  const origin = exactHttpOrigin(origins[0]!);
  if (!origin) return { status: 403, message: "WebSocket origin is not allowed." };
  const authority = webSocketRequestAuthority(req);
  if (!authority) return { status: 400, message: "Invalid WebSocket Host header." };
  if (allowedOrigins.includes(origin.origin) || authority.origin === origin.origin)
    return undefined;
  return { status: 403, message: "WebSocket origin is not allowed." };
}

function removePrivateRawRequestHeaders(req: IncomingMessage): void {
  const privateNames = new Set<string>([
    INTERNAL_SECRET_HEADER,
    INTERNAL_DISPATCH_PROOF_HEADER,
    ...INTERNAL_DISPATCH_HEADERS,
    ...UNTRUSTED_NEXT_REQUEST_HEADERS,
  ]);
  const isPrivate = (name: string) => {
    const lower = name.toLowerCase();
    return privateNames.has(lower) || lower.startsWith("x-middleware-");
  };
  // Node derives headersDistinct lazily from rawHeaders while retaining the parser's original
  // field count. Materialize and sanitize it BEFORE compacting rawHeaders; doing this in the
  // opposite order made Node read past the shortened array (`undefined.toLowerCase()`) only when
  // a client actually supplied a private field.
  const distinct = req.headersDistinct;
  if (distinct) {
    for (const name of Object.keys(distinct)) {
      if (isPrivate(name)) delete distinct[name];
    }
  }
  if (Array.isArray(req.rawHeaders)) {
    let writeIndex = 0;
    for (let readIndex = 0; readIndex < req.rawHeaders.length; readIndex += 2) {
      const name = req.rawHeaders[readIndex];
      if (!name || isPrivate(name)) continue;
      req.rawHeaders[writeIndex++] = name;
      if (readIndex + 1 < req.rawHeaders.length) {
        req.rawHeaders[writeIndex++] = req.rawHeaders[readIndex + 1]!;
      }
    }
    req.rawHeaders.length = writeIndex;
  }
}

function parseHeaderMap(raw: string | undefined): Headers | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const headers = new Headers();
    for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
        item.forEach((entry) => headers.append(name, entry));
      } else if (typeof item === "string") {
        headers.set(name, item);
      } else {
        return undefined;
      }
    }
    return headers;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== "string") return null;
      record[key] = item;
    }
    return record;
  } catch {
    return null;
  }
}

function parseInvocationQuery(
  raw: string | undefined,
): Record<string, string | string[]> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const query: Record<string, string | string[]> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") query[key] = item;
      else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) {
        query[key] = item as string[];
      } else {
        return undefined;
      }
    }
    return query;
  } catch {
    return undefined;
  }
}

function responseHeadersRecord(
  headers: Headers | undefined,
): Record<string, string | string[]> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string | string[]> = {};
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") record[name] = value;
  }
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) record["set-cookie"] = cookies;
  return record;
}

function installWebSocketRegistryScope(req: IncomingMessage, scope: object): void {
  // The generated entrypoint deliberately refuses a lifecycle scope supplied through ctx: that
  // object can cross an Adapter boundary. Next's own router stamps the server-owned object on the
  // raw request before calling the same entrypoint. The pool owns the raw socket, so mirror that
  // boundary using Next's process-global request-meta symbol rather than importing a private Next
  // module whose path would couple the adapter to one canary build.
  const request = req as IncomingMessage & Record<symbol, unknown>;
  const current = request[NEXT_REQUEST_META];
  const metadata = current && typeof current === "object" ? { ...current } : {};
  (metadata as Record<string, unknown>).webSocketRegistryScope = scope;
  request[NEXT_REQUEST_META] = metadata;
}

function generatedUpgradeDisposition(outcome: unknown): UpgradeDisposition {
  if (!outcome || typeof outcome !== "object" || typeof (outcome as any).upgraded !== "boolean") {
    throw new TypeError("Next generated upgradeHandler returned an invalid upgrade outcome");
  }
  const { upgraded, statusCode } = outcome as GeneratedUpgradeOutcome;
  if (
    statusCode !== undefined &&
    (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)
  ) {
    throw new TypeError("Next generated upgradeHandler returned an invalid status code");
  }
  if (
    (upgraded && statusCode !== undefined && statusCode !== 101) ||
    (!upgraded && statusCode === 101)
  ) {
    throw new TypeError("Next generated upgradeHandler returned an inconsistent upgrade outcome");
  }
  // Accepted here means the GENERATED entrypoint took the socket, so ws owns its framing.
  return upgraded ? "accepted-local" : "rejected";
}

/** Read the proof-gated phase-two routing verdict, then erase the transport vocabulary. */
function trustedResolutionFromHeaders(req: IncomingMessage): ResolveResult | undefined {
  const discardDispatch = () => {
    for (const header of INTERNAL_DISPATCH_HEADERS) delete req.headers[header];
  };
  const outputId =
    typeof req.headers["x-output-id"] === "string" ? req.headers["x-output-id"] : undefined;
  const middlewareVerdict =
    typeof req.headers["x-mw-evaluated"] === "string" ? req.headers["x-mw-evaluated"] : undefined;
  if (!outputId || !middlewareVerdict || !MW_EVALUATED_TRUSTED.has(middlewareVerdict)) {
    discardDispatch();
    return undefined;
  }

  const routeMatchesRaw =
    typeof req.headers["x-route-matches"] === "string" ? req.headers["x-route-matches"] : undefined;
  const resolvedHeadersRaw =
    typeof req.headers["x-resolved-headers"] === "string"
      ? req.headers["x-resolved-headers"]
      : undefined;
  const middlewareRequestHeadersRaw =
    typeof req.headers["x-mw-request-headers"] === "string"
      ? req.headers["x-mw-request-headers"]
      : undefined;
  const invocationQueryRaw =
    typeof req.headers["x-invoke-query"] === "string" ? req.headers["x-invoke-query"] : undefined;
  const routeMatches = parseJsonRecord(routeMatchesRaw);
  const resolvedHeaders = parseHeaderMap(resolvedHeadersRaw);
  const middlewareRequestHeaders = parseHeaderMap(middlewareRequestHeadersRaw);
  const invokePath =
    typeof req.headers["x-invoke-path"] === "string" ? req.headers["x-invoke-path"] : undefined;
  const invocationQuery = parseInvocationQuery(invocationQueryRaw);
  const deadlineRaw = req.headers[INTERNAL_EXECUTION_DEADLINE_HEADER];
  const deadline = typeof deadlineRaw === "string" ? Number(deadlineRaw) : Number.NaN;
  const executionDeadlineAt = Number.isSafeInteger(deadline) && deadline > 0 ? deadline : undefined;
  const pool =
    typeof req.headers["x-upstream-pool"] === "string" ? req.headers["x-upstream-pool"] : undefined;

  // Optional means absent, not malformed. A trusted-but-corrupt extension verdict must not skip
  // middleware while silently discarding its authoritative request-header replacement, rewrite
  // query, route params, response headers, or inherited deadline. Re-resolve the whole request.
  if (
    (routeMatchesRaw !== undefined && routeMatches === null) ||
    (resolvedHeadersRaw !== undefined && resolvedHeaders === undefined) ||
    (middlewareRequestHeadersRaw !== undefined && middlewareRequestHeaders === undefined) ||
    (invocationQueryRaw !== undefined && invocationQuery === undefined) ||
    (deadlineRaw !== undefined && executionDeadlineAt === undefined)
  ) {
    discardDispatch();
    return undefined;
  }

  discardDispatch();
  return {
    kind: "route",
    pool: pool ?? "",
    matchedPathname: outputId,
    routeMatches,
    resolvedHeaders,
    ...(middlewareRequestHeaders ? { middlewareRequestHeaders } : {}),
    ...(invokePath ? { invokePath } : {}),
    ...(invocationQuery ? { invocationQuery } : {}),
    ...(executionDeadlineAt ? { executionDeadlineAt } : {}),
  };
}

function publicRequestUrl(req: IncomingMessage): URL {
  const url = parseRequestUrl(req.url ?? "/", req.headers.host);
  const protocol = validatedForwardedProtocol(req);
  if (protocol) url.protocol = `${protocol}:`;
  return url;
}

function appendHeader(
  lines: string[],
  name: string,
  value: string,
  options: { allowUpgrade?: boolean } = {},
): void {
  const lower = name.toLowerCase();
  if (isPrivateResponseHeader(lower)) return;
  if (
    HOP_BY_HOP_RESPONSE_HEADERS.has(lower) &&
    !(options.allowUpgrade && (lower === "connection" || lower === "upgrade"))
  ) {
    return;
  }
  // Node already rejected CR/LF in parsed response headers, but keep this serializer safe for
  // values originating in a Web Headers object too.
  if (/\r|\n/.test(name) || /\r|\n/.test(value)) return;
  lines.push(`${name}: ${value}\r\n`);
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new HandshakeDeadlineError(stage)),
          Math.max(1, deadlineAt - Date.now()),
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function webHeaderEntries(headers: Headers): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== "set-cookie") entries.push([name, value]);
  }
  for (const cookie of headers.getSetCookie()) entries.push(["set-cookie", cookie]);
  return entries;
}

function mergedResponseHeaderEntries(
  responseHeaders: Headers,
  resolvedHeaders?: Headers,
): Array<[string, string]> {
  const merged = new Map<string, Array<[string, string]>>();
  for (const [name, value] of webHeaderEntries(responseHeaders)) {
    const lower = name.toLowerCase();
    const current = merged.get(lower) ?? [];
    current.push([name, value]);
    merged.set(lower, current);
  }
  if (resolvedHeaders) {
    for (const [name, value] of webHeaderEntries(resolvedHeaders)) {
      const lower = name.toLowerCase();
      if (lower === "set-cookie") {
        const current = merged.get(lower) ?? [];
        current.push([name, value]);
        merged.set(lower, current);
      } else {
        merged.set(lower, [[name, value]]);
      }
    }
  }
  return [...merged.values()].flat();
}

async function readResponseBody(response: Response, deadlineAt: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await beforeDeadline(
        reader.read(),
        deadlineAt,
        "rejection response body",
      );
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REJECTION_BODY_BYTES) {
        await reader.cancel("WebSocket rejection response exceeded adapter limit");
        throw new Error("WebSocket rejection response exceeded 1 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    // A middleware may return a stream which never produces a byte. Release its resources when
    // the absolute handshake budget expires instead of leaving a detached reader behind.
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function writeHttpResponse(
  socket: Duplex,
  response: Response,
  deadlineAt: number,
  resolvedHeaders?: Headers,
): Promise<void> {
  if (socket.destroyed) return;
  const body = await readResponseBody(response, deadlineAt);
  const lines = [
    `HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}\r\n`,
    "Connection: close\r\n",
    `Content-Length: ${body.length}\r\n`,
  ];
  for (const [name, value] of mergedResponseHeaderEntries(response.headers, resolvedHeaders)) {
    appendHeader(lines, name, value, {
      // RFC 9110's 426 response advertises the required protocol in Upgrade. Every other
      // hop-by-hop field is transport state owned by this socket and stays stripped.
      allowUpgrade: response.status === 426 && name.toLowerCase() === "upgrade",
    });
  }
  lines.push("\r\n");
  try {
    await beforeDeadline(
      new Promise<void>((resolve) => {
        const done = () => resolve();
        socket.once("close", done);
        socket.once("error", done);
        socket.end(Buffer.concat([Buffer.from(lines.join("")), body]), done);
      }),
      deadlineAt,
      "rejection response write",
    );
  } catch (error) {
    if (!socket.destroyed) socket.destroy();
    throw error;
  }
}

async function rejectUpgrade(
  socket: Duplex,
  status: number,
  deadlineAt: number,
  headers?: Record<string, string>,
  resolvedHeaders?: Headers,
): Promise<UpgradeDisposition> {
  await writeHttpResponse(
    socket,
    new Response(null, { status, ...(headers ? { headers } : {}) }),
    deadlineAt,
    resolvedHeaders,
  );
  return "rejected";
}

async function rejectUpgradeWithMessage(
  socket: Duplex,
  error: WebSocketHandshakeError,
  deadlineAt: number,
): Promise<UpgradeDisposition> {
  const headers = new Headers(error.headers);
  headers.set("cache-control", RAW_HTTP_ERROR_CACHE_CONTROL);
  headers.set("content-type", "text/plain; charset=utf-8");
  await writeHttpResponse(
    socket,
    new Response(error.message, { status: error.status, headers }),
    deadlineAt,
  );
  return "rejected";
}

function sanitizedUpgradeResponseHead(res: IncomingMessage): Buffer {
  const lines = [
    `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? STATUS_CODES[res.statusCode ?? 101] ?? ""}\r\n`,
  ];
  for (let index = 0; index + 1 < res.rawHeaders.length; index += 2) {
    appendHeader(lines, res.rawHeaders[index]!, res.rawHeaders[index + 1]!, {
      allowUpgrade: true,
    });
  }
  lines.push("\r\n");
  return Buffer.from(lines.join(""));
}

function forwardedUpgradeHeaders(
  req: IncomingMessage,
  resolution: Extract<ResolveResult, { kind: "route" }>,
  deps: WebSocketUpgradeDispatcher,
  executionDeadlineAt: number,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  const nominated = new Set<string>();
  const connection = req.headers.connection;
  for (const value of Array.isArray(connection) ? connection : connection ? [connection] : []) {
    for (const token of value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name) nominated.add(name);
    }
  }
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (
      lower === INTERNAL_SECRET_HEADER ||
      lower === INTERNAL_DISPATCH_PROOF_HEADER ||
      (INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(lower) ||
      HOP_BY_HOP_REQUEST_HEADERS.has(lower) ||
      nominated.has(lower)
    ) {
      continue;
    }
    headers[lower] = value;
  }
  // These are the only connection-scoped fields intentionally carried onto the NEW hop.
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  headers["x-output-id"] = resolution.matchedPathname;
  headers["x-matched-pathname"] = resolution.matchedPathname;
  headers["x-route-matches"] = resolution.routeMatches
    ? JSON.stringify(resolution.routeMatches)
    : "";
  headers["x-mw-evaluated"] = "ran";
  const middlewareRequestHeaders = responseHeadersRecord(resolution.middlewareRequestHeaders);
  if (middlewareRequestHeaders) {
    headers["x-mw-request-headers"] = JSON.stringify(middlewareRequestHeaders);
  }
  const resolvedHeaders = responseHeadersRecord(resolution.resolvedHeaders);
  if (resolvedHeaders) headers["x-resolved-headers"] = JSON.stringify(resolvedHeaders);
  if (resolution.invokePath) headers["x-invoke-path"] = resolution.invokePath;
  if (resolution.invocationQuery) {
    headers["x-invoke-query"] = JSON.stringify(resolution.invocationQuery);
  }
  headers[INTERNAL_EXECUTION_DEADLINE_HEADER] = String(executionDeadlineAt);
  if (deps.internalSecret) {
    headers[INTERNAL_DISPATCH_PROOF_HEADER] = computeDispatchProof(
      deps.internalSecret,
      dispatchProofInputsFromRequest({
        method: req.method,
        target: req.url,
        headers,
        proofHeaderNames: deps.proofHeaderNames,
      }),
    );
  }
  return headers;
}

async function proxyUpgradeToPool(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  resolution: Extract<ResolveResult, { kind: "route" }>,
  deps: WebSocketUpgradeDispatcher,
  deadlineAt: number,
): Promise<UpgradeDisposition> {
  return new Promise<UpgradeDisposition>((resolve) => {
    const endpoint = deps.resolvePoolEndpoint?.(resolution.pool) ?? {
      hostname: sanitizeK8sName(`${deps.releaseName}-${resolution.pool}-${deps.buildId}`),
      port: 3000,
    };
    let settled = false;
    const finish = (result: UpgradeDisposition) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(result);
    };
    const proxyReq = httpRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      method: "GET",
      path: req.url,
      headers: forwardedUpgradeHeaders(req, resolution, deps, deadlineAt),
    });
    const deadline = setTimeout(
      () => {
        proxyReq.destroy(new Error("cross-pool WebSocket handshake deadline exceeded"));
      },
      Math.max(1, deadlineAt - Date.now()),
    );
    deadline.unref?.();

    const abortProxy = () => {
      if (!settled) proxyReq.destroy(new Error("WebSocket client disconnected during handshake"));
    };
    socket.once("close", abortProxy);

    proxyReq.once("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.off("close", abortProxy);
      try {
        socket.write(sanitizedUpgradeResponseHead(proxyRes));
        if (proxyHead.length > 0) socket.write(proxyHead);
        if (head.length > 0) proxySocket.write(head);
      } catch {
        proxySocket.destroy();
        if (!socket.destroyed) socket.destroy();
        finish("rejected");
        return;
      }

      // Either end closing takes the other with it, so shutdown needs no separate handle on the
      // upstream socket: when the drain path destroys the client socket after its bounded flush
      // window, this teardown closes the sibling-pool connection in the same tick and the back
      // pool's generated stack sees its peer leave. N90: the drain path may write into the client
      // end ONLY at a frame boundary, which is what the N91 cursor below exists to establish.
      const teardown = () => {
        if (!socket.destroyed) socket.destroy();
        if (!proxySocket.destroyed) proxySocket.destroy();
      };
      socket.on("error", teardown);
      proxySocket.on("error", teardown);
      socket.on("close", teardown);
      proxySocket.on("close", teardown);
      socket.pipe(proxySocket);
      proxySocket.pipe(socket);
      // N91. Track only the CLIENT-BOUND direction: it is the one shutdown may write into, and
      // `proxyHead` is already part of that stream (it was written above, before the pipe existed).
      trackTunnelFraming(socket, proxySocket, proxyHead);
      finish("accepted-tunnel");
    });

    proxyReq.once("response", (proxyRes) => {
      socket.off("close", abortProxy);
      const lines = [
        `HTTP/1.1 ${proxyRes.statusCode ?? 502} ${proxyRes.statusMessage ?? STATUS_CODES[proxyRes.statusCode ?? 502] ?? ""}\r\n`,
        "Connection: close\r\n",
      ];
      for (let index = 0; index + 1 < proxyRes.rawHeaders.length; index += 2) {
        appendHeader(lines, proxyRes.rawHeaders[index]!, proxyRes.rawHeaders[index + 1]!);
      }
      lines.push("\r\n");
      if (!socket.destroyed) socket.write(lines.join(""));
      let relayedBytes = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        relayedBytes += chunk.length;
        if (relayedBytes > MAX_REJECTION_BODY_BYTES) {
          proxyRes.destroy(new Error("cross-pool WebSocket rejection exceeded 1 MiB"));
          if (!socket.destroyed) socket.destroy();
          finish("rejected");
          return;
        }
        if (!socket.destroyed) socket.write(chunk);
      });
      proxyRes.once("end", () => {
        if (!socket.destroyed) socket.end();
        finish("rejected");
      });
      proxyRes.once("error", () => {
        if (!socket.destroyed) socket.destroy();
        finish("rejected");
      });
    });

    proxyReq.once("error", (error) => {
      socket.off("close", abortProxy);
      if (!settled) {
        console.error(
          `[pool-server] cross-pool WebSocket handshake to pool "${resolution.pool}" failed:`,
          error,
        );
        void rejectUpgrade(socket, 502, deadlineAt).finally(() => finish("rejected"));
      }
    });
    proxyReq.end();
  });
}

function handlerContext(
  req: IncomingMessage,
  resolution: Extract<ResolveResult, { kind: "route" }>,
): Record<string, unknown> {
  const publicUrl = publicRequestUrl(req);
  const resolvedPathname = resolution.invokePath
    ? new URL(resolution.invokePath, publicUrl).pathname
    : publicUrl.pathname;
  const params = extractRouteParams(
    resolution.matchedPathname,
    resolution.routeMatches,
    resolvedPathname,
  );
  return {
    waitUntil(waitable: Promise<unknown>) {
      Promise.resolve(waitable).catch((error) => {
        console.error("[pool-server] WebSocket waitUntil failed:", error);
      });
    },
    requestMeta: {
      relativeProjectDir: ".",
      hostname: req.headers.host?.split(":", 1)[0] ?? "127.0.0.1",
      minimalMode: true,
      outputId: resolution.matchedPathname,
      matchedPathname: resolution.matchedPathname,
      routeMatches: resolution.routeMatches,
      resolvedPathname,
      initURL: publicUrl.toString(),
      ...(resolution.invokePath ? { rewrittenPathname: resolvedPathname } : {}),
      ...(resolution.invocationQuery ? { query: resolution.invocationQuery } : {}),
      ...(params ? { params } : {}),
    },
    ...(resolution.resolvedHeaders
      ? { responseHeaders: responseHeadersRecord(resolution.resolvedHeaders) }
      : {}),
  };
}

/** Dispatch one Node HTTP upgrade through Next routing to a generated App Route entrypoint. */
export async function handleWebSocketUpgrade(
  deps: WebSocketUpgradeDispatcher,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<UpgradeDisposition> {
  const timeoutMs = Math.max(1, deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const localDeadlineAt = Date.now() + timeoutMs;
  if (
    !rawHeaderValues(req, "upgrade").some((value) =>
      value.split(",").some((protocol) => protocol.trim().toLowerCase() === "websocket"),
    )
  ) {
    return rejectUpgrade(socket, 426, localDeadlineAt, { Upgrade: "websocket" });
  }

  // These checks intentionally precede proxy.ts/middleware. Apart from matching Next's owner
  // ordering, it prevents malformed credentials, Origins, or framing from reaching application
  // code which may have side effects or relax those same headers.
  const handshakeError = validateWebSocketHandshake(req, deps.parseWebSocketExtensions);
  if (handshakeError) {
    return rejectUpgradeWithMessage(socket, handshakeError, localDeadlineAt);
  }
  const originError = validateWebSocketOrigin(req, deps.webSocketAllowedOrigins);
  if (originError) return rejectUpgradeWithMessage(socket, originError, localDeadlineAt);

  // The shared request trust boundary removed private fields from req.headers. Remove their raw
  // parser views too before user code can inspect the request, then mark the equivalent Next
  // filter complete. Middleware-generated x-middleware-set-cookie is added later and must survive
  // into the generated request store; allowing Next to re-run its ingress filter would erase it.
  removePrivateRawRequestHeaders(req);

  const trustedResolution = trustedResolutionFromHeaders(req);
  const publicUrl = (() => {
    try {
      return publicRequestUrl(req);
    } catch {
      return undefined;
    }
  })();
  if (!publicUrl) return rejectUpgrade(socket, 400, localDeadlineAt);

  let resolution: ResolveResult;
  try {
    resolution =
      trustedResolution ??
      (await beforeDeadline(
        deps.resolve(publicUrl, requestHeaders(req), "GET", emptyBody()),
        localDeadlineAt,
        "route resolution",
      ));
  } catch (error) {
    console.error("[pool-server] WebSocket route resolution failed:", error);
    return rejectUpgrade(
      socket,
      error instanceof HandshakeDeadlineError ? 504 : 500,
      localDeadlineAt,
    );
  }

  switch (resolution.kind) {
    case "redirect":
      return rejectUpgrade(
        socket,
        resolution.status,
        localDeadlineAt,
        { Location: resolution.url.toString() },
        resolution.resolvedHeaders,
      );
    case "error":
      return rejectUpgrade(socket, resolution.status, localDeadlineAt);
    case "not-found":
      return rejectUpgradeWithMessage(
        socket,
        { status: 404, message: "Not Found" },
        localDeadlineAt,
      );
    case "middleware-response":
      try {
        await writeHttpResponse(socket, resolution.response, localDeadlineAt);
      } catch (error) {
        console.error("[pool-server] WebSocket rejection response failed:", error);
        if (!socket.destroyed) socket.destroy();
      }
      return "rejected";
    case "external-rewrite":
      // A safe external raw-socket dial needs the same DNS rebinding and address-range checks as
      // the HTTP external-rewrite proxy. Do not turn an experimental feature into an SSRF bypass.
      return rejectUpgradeWithMessage(
        socket,
        {
          status: 501,
          message:
            "External WebSocket rewrite targets are not proxied while webSocketRouteHandlers is enabled.",
        },
        localDeadlineAt,
      );
    case "route":
      break;
  }

  if (!resolution.pool) resolution.pool = deps.poolName;

  const deadlineAt = Math.min(
    localDeadlineAt,
    resolution.executionDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  if (resolution.pool !== deps.poolName) {
    return proxyUpgradeToPool(req, socket, head, resolution, deps, deadlineAt);
  }

  applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders, {
    preserveMiddlewareCookieHeader: true,
  });

  if (!deps.handlerLoader.has(resolution.matchedPathname)) {
    return rejectUpgradeWithMessage(socket, { status: 404, message: "Not Found" }, deadlineAt);
  }
  const output = deps.handlerLoader.get(resolution.matchedPathname);
  if (output?.type !== "APP_ROUTE" || output.runtime === "edge") {
    return rejectUpgradeWithMessage(socket, { status: 404, message: "Not Found" }, deadlineAt);
  }

  let upgradeHandler;
  try {
    upgradeHandler = await beforeDeadline(
      deps.handlerLoader.loadUpgrade(resolution.matchedPathname),
      deadlineAt,
      "route module load",
    );
  } catch (error) {
    console.error("[pool-server] WebSocket route module load failed:", error);
    return rejectUpgrade(
      socket,
      error instanceof HandshakeDeadlineError ? 504 : 500,
      deadlineAt,
      undefined,
      resolution.resolvedHeaders,
    );
  }
  if (!upgradeHandler) {
    return rejectUpgradeWithMessage(socket, { status: 404, message: "Not Found" }, deadlineAt);
  }

  const context = handlerContext(req, resolution);
  (req as IncomingMessage & Record<symbol, unknown>)[NEXT_WEBSOCKET_HEADERS_FILTERED] = true;
  installWebSocketRegistryScope(req, deps.webSocketRegistryScope);
  const outcome = await beforeDeadline(
    Promise.resolve(upgradeHandler(context, { node: { req, socket, head } })),
    deadlineAt,
    "generated handler",
  );
  return generatedUpgradeDisposition(outcome);
}
