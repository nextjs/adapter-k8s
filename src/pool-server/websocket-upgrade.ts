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
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_EXECUTION_DEADLINE_HEADER,
  INTERNAL_SECRET_HEADER,
  MW_EVALUATED_TRUSTED,
  parseRequestUrl,
} from "../routing-common.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";
import { applyMiddlewareRequestHeaders, extractRouteParams } from "./dispatch.js";
import type { HandlerLoader } from "./handler-loader.js";
import type { ResolveResult } from "./resolve.js";

export type UpgradeDisposition = "accepted" | "rejected";

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
  /** Absolute budget for resolution + module load + generated handler acceptance. */
  handshakeTimeoutMs?: number;
  /** Test seam for a sibling pool endpoint; production uses Kubernetes service DNS on port 3000. */
  resolvePoolEndpoint?: ((poolName: string) => { hostname: string; port: number }) | undefined;
}

const MAX_REJECTION_BODY_BYTES = 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;

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

function parseHeaderMap(raw: string | undefined): Headers | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, string | string[]>;
    const headers = new Headers();
    for (const [name, item] of Object.entries(value)) {
      if (Array.isArray(item)) item.forEach((entry) => headers.append(name, entry));
      else if (typeof item === "string") headers.set(name, item);
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

/** Read the secret-gated phase-two routing verdict, then erase the transport vocabulary. */
function trustedResolutionFromHeaders(req: IncomingMessage): ResolveResult | undefined {
  const outputId =
    typeof req.headers["x-output-id"] === "string" ? req.headers["x-output-id"] : undefined;
  const middlewareVerdict =
    typeof req.headers["x-mw-evaluated"] === "string" ? req.headers["x-mw-evaluated"] : undefined;
  if (!outputId || !middlewareVerdict || !MW_EVALUATED_TRUSTED.has(middlewareVerdict)) {
    for (const header of INTERNAL_DISPATCH_HEADERS) delete req.headers[header];
    return undefined;
  }

  const routeMatches = parseJsonRecord(
    typeof req.headers["x-route-matches"] === "string" ? req.headers["x-route-matches"] : undefined,
  );
  const resolvedHeaders = parseHeaderMap(
    typeof req.headers["x-resolved-headers"] === "string"
      ? req.headers["x-resolved-headers"]
      : undefined,
  );
  const middlewareRequestHeaders = parseHeaderMap(
    typeof req.headers["x-mw-request-headers"] === "string"
      ? req.headers["x-mw-request-headers"]
      : undefined,
  );
  const invokePath =
    typeof req.headers["x-invoke-path"] === "string" ? req.headers["x-invoke-path"] : undefined;
  const invocationQuery = parseInvocationQuery(
    typeof req.headers["x-invoke-query"] === "string" ? req.headers["x-invoke-query"] : undefined,
  );
  const deadlineRaw = req.headers[INTERNAL_EXECUTION_DEADLINE_HEADER];
  const deadline = typeof deadlineRaw === "string" ? Number(deadlineRaw) : Number.NaN;
  const executionDeadlineAt = Number.isSafeInteger(deadline) && deadline > 0 ? deadline : undefined;
  const pool =
    typeof req.headers["x-upstream-pool"] === "string" ? req.headers["x-upstream-pool"] : undefined;

  for (const header of INTERNAL_DISPATCH_HEADERS) delete req.headers[header];
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
  const forwarded = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",", 1)[0]?.trim();
  if (protocol === "https" || protocol === "http") url.protocol = `${protocol}:`;
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

async function readResponseBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REJECTION_BODY_BYTES) {
        await reader.cancel("WebSocket rejection response exceeded adapter limit");
        throw new Error("WebSocket rejection response exceeded 1 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function writeHttpResponse(
  socket: Duplex,
  response: Response,
  resolvedHeaders?: Headers,
): Promise<void> {
  if (socket.destroyed) return;
  const body = await readResponseBody(response);
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
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    socket.once("close", done);
    socket.once("error", done);
    socket.end(Buffer.concat([Buffer.from(lines.join("")), body]), done);
  });
}

async function rejectUpgrade(
  socket: Duplex,
  status: number,
  headers?: Record<string, string>,
  resolvedHeaders?: Headers,
): Promise<UpgradeDisposition> {
  await writeHttpResponse(
    socket,
    new Response(null, { status, ...(headers ? { headers } : {}) }),
    resolvedHeaders,
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
      (INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(lower) ||
      (nominated.has(lower) && lower !== "upgrade")
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
  if (resolution.invokePath) headers["x-invoke-path"] = resolution.invokePath;
  if (resolution.invocationQuery) {
    headers["x-invoke-query"] = JSON.stringify(resolution.invocationQuery);
  }
  headers[INTERNAL_EXECUTION_DEADLINE_HEADER] = String(executionDeadlineAt);
  if (deps.internalSecret) headers[INTERNAL_SECRET_HEADER] = deps.internalSecret;
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
      finish("accepted");
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
        void rejectUpgrade(socket, 502).finally(() => finish("rejected"));
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
  };
}

/** Dispatch one Node HTTP upgrade through Next routing to a generated App Route entrypoint. */
export async function handleWebSocketUpgrade(
  deps: WebSocketUpgradeDispatcher,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<UpgradeDisposition> {
  if (req.method !== "GET" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    return rejectUpgrade(socket, 426, { Upgrade: "websocket" });
  }

  const timeoutMs = Math.max(1, deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const localDeadlineAt = Date.now() + timeoutMs;
  const trustedResolution = trustedResolutionFromHeaders(req);
  const publicUrl = (() => {
    try {
      return publicRequestUrl(req);
    } catch {
      return undefined;
    }
  })();
  if (!publicUrl) return rejectUpgrade(socket, 400);

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
    return rejectUpgrade(socket, error instanceof HandshakeDeadlineError ? 504 : 500);
  }

  switch (resolution.kind) {
    case "redirect":
      return rejectUpgrade(
        socket,
        resolution.status,
        { Location: resolution.url.toString() },
        resolution.resolvedHeaders,
      );
    case "error":
      return rejectUpgrade(socket, resolution.status);
    case "not-found":
      return rejectUpgrade(socket, 404, undefined, resolution.resolvedHeaders);
    case "middleware-response":
      try {
        await writeHttpResponse(socket, resolution.response);
      } catch (error) {
        console.error("[pool-server] WebSocket rejection response failed:", error);
        if (!socket.destroyed) socket.destroy();
      }
      return "rejected";
    case "external-rewrite":
      // A safe external raw-socket dial needs the same DNS rebinding and address-range checks as
      // the HTTP external-rewrite proxy. Do not turn an experimental feature into an SSRF bypass.
      return rejectUpgrade(socket, 502);
    case "route":
      break;
  }

  if (!resolution.pool) resolution.pool = deps.poolName;
  applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders);

  const deadlineAt = Math.min(
    localDeadlineAt,
    resolution.executionDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  if (resolution.pool !== deps.poolName) {
    return proxyUpgradeToPool(req, socket, head, resolution, deps, deadlineAt);
  }

  if (!deps.handlerLoader.has(resolution.matchedPathname)) {
    return rejectUpgrade(socket, 404);
  }
  const output = deps.handlerLoader.get(resolution.matchedPathname);
  if (output?.runtime === "edge") {
    return rejectUpgrade(socket, 501);
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
    return rejectUpgrade(socket, error instanceof HandshakeDeadlineError ? 504 : 500);
  }
  if (!upgradeHandler) return rejectUpgrade(socket, 426, { Upgrade: "websocket" });

  const context = handlerContext(req, resolution);
  await beforeDeadline(
    Promise.resolve(upgradeHandler(context, { node: { req, socket, head } })),
    deadlineAt,
    "generated handler",
  );
  return "accepted";
}
