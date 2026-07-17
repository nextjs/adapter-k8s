// WebSocket upgrade dispatch for the pool server.
//
// A WebSocket handshake is an HTTP GET carrying `Connection: Upgrade` — Node's http.Server routes
// it to the `upgrade` event, NOT the normal request handler, so it needs its own dispatch path.
// This resolves the route the same way HTTP requests do (the shared resolver), applies the same
// middleware request-header mutations and rewrites, and — if the route module exports Next 16.3+'s
// `upgradeHandler` (nextjs/adapter-vercel#86) — hands it the raw socket via
// `upgradeHandler(ctx, { node: { req, socket, head } })`. Routes without an `upgradeHandler` (older
// Next, or an ordinary HTTP route) get a clean `426 Upgrade Required` and never crash.
//
// Resolution is always LOCAL: the upgrade event bypasses server.ts's internal-secret gate, so we
// strip the trusted dispatch headers and re-resolve here rather than trust a (possibly spoofed)
// x-output-id on the handshake. When a path rule lands the upgrade on the wrong pool (Gateway API
// precedence can shadow the x-upstream-pool header rule), we forward the raw upgrade to the owning
// pool — mirroring the HTTP dispatcher's proxyToPool.
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { extractRouteParams } from "./dispatch.js";
import type { ArtifactRouteHandler } from "./handler-loader.js";
import { applyMiddlewareRequestHeaders } from "./middleware-headers.js";
import { INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER } from "../routing-common.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";

// Structural subset of the resolver's result — only what the upgrade path reads.
type UpgradeResolution =
  | {
      kind: "route";
      pool: string;
      matchedPathname: string;
      routeMatches: Record<string, string> | null;
      middlewareRequestHeaders?: Headers | undefined;
      invokePath?: string | undefined;
      invocationQuery?: Record<string, string | string[]> | undefined;
    }
  | { kind: "redirect"; url: URL; status: number }
  | { kind: "error"; status: number }
  | { kind: "middleware-response"; response: Response }
  | { kind: "external-rewrite"; url: URL }
  | { kind: "not-found" };

export interface UpgradeDispatcher {
  /** The same resolver the HTTP path uses (Phase 1 local resolution). */
  resolve(url: URL, headers: Headers, method: string, body: unknown): Promise<UpgradeResolution>;
  /** Feature-detected WebSocket handler for an output; undefined ⇒ no WS support on this route. */
  loadUpgrade(outputId: string): Promise<ArtifactRouteHandler | undefined>;
  /** Whether THIS pool owns the output (used to decide cross-pool forwarding). */
  hasOutput(outputId: string): boolean;
  /** A fresh empty request-body stream for the resolver (WS handshakes carry no body). */
  makeEmptyBody(): unknown;
  minimalMode: boolean;
  poolName: string;
  releaseName: string;
  buildId: string;
  internalSecret?: string | undefined;
}

const STATUS_TEXT: Record<number, string> = {
  301: "Moved Permanently",
  302: "Found",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
  404: "Not Found",
  426: "Upgrade Required",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

/** Write a plain HTTP response on the pre-upgrade socket and close it. */
function rejectUpgrade(
  socket: Duplex,
  status: number,
  extraHeaders: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  let head = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(extraHeaders)) head += `${k}: ${v}\r\n`;
  head += "Content-Length: 0\r\n\r\n";
  try {
    socket.write(head);
  } catch {
    // socket already gone — nothing to send
  }
  socket.destroy();
}

/** Relay a middleware short-circuit (auth redirect, 401, …) to the client, then close. */
async function writeResponseAndClose(socket: Duplex, response: Response): Promise<void> {
  if (socket.destroyed) return;
  const body = Buffer.from(await response.arrayBuffer());
  let head = `HTTP/1.1 ${response.status} ${STATUS_TEXT[response.status] ?? ""}\r\nConnection: close\r\n`;
  response.headers.forEach((value, key) => {
    head += `${key}: ${value}\r\n`;
  });
  head += `Content-Length: ${body.length}\r\n\r\n`;
  try {
    socket.write(head);
    if (body.length) socket.write(body);
  } catch {
    // socket already gone
  }
  socket.destroy();
}

/**
 * Forward a raw WebSocket upgrade to the pool that owns the route (a path rule landed it here). We
 * open an upgrade request to `<release>-<pool>-<buildId>:3000` and pipe the two sockets once the
 * sibling switches protocols — the raw-socket analogue of the HTTP dispatcher's proxyToPool.
 * NOTE: the target re-resolves locally (it strips these dispatch headers), so middleware runs again
 * on the target for the handshake; the forwarded x-output-id/secret are attached for a future
 * trusted-dispatch fast path that would skip that second evaluation.
 */
function proxyUpgradeToPool(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  resolution: Extract<UpgradeResolution, { kind: "route" }>,
  deps: UpgradeDispatcher,
): void {
  const targetHost = sanitizeK8sName(`${deps.releaseName}-${resolution.pool}-${deps.buildId}`);
  const proxyReq = httpRequest({
    hostname: targetHost,
    port: 3000,
    path: req.url,
    method: "GET",
    headers: {
      ...req.headers,
      "x-output-id": resolution.matchedPathname,
      "x-route-matches": resolution.routeMatches ? JSON.stringify(resolution.routeMatches) : "",
      "x-mw-evaluated": "ran",
      ...(deps.internalSecret ? { [INTERNAL_SECRET_HEADER]: deps.internalSecret } : {}),
    },
  });

  let settled = false;
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    settled = true;
    let handshake = `HTTP/1.1 ${proxyRes.statusCode ?? 101} ${proxyRes.statusMessage ?? "Switching Protocols"}\r\n`;
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      const val = Array.isArray(v) ? v.join(", ") : v;
      if (val !== undefined) handshake += `${k}: ${val}\r\n`;
    }
    handshake += "\r\n";
    try {
      socket.write(handshake);
      if (proxyHead?.length) socket.write(proxyHead);
      if (head?.length) proxySocket.write(head);
    } catch {
      /* client gone */
    }
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
    const teardown = () => {
      if (!socket.destroyed) socket.destroy();
      if (!proxySocket.destroyed) proxySocket.destroy();
    };
    socket.on("error", teardown);
    proxySocket.on("error", teardown);
    socket.on("close", teardown);
    proxySocket.on("close", teardown);
  });
  proxyReq.on("response", (proxyRes) => {
    // The sibling declined the upgrade (returned an ordinary response) — relay its status.
    if (!settled) {
      settled = true;
      rejectUpgrade(socket, proxyRes.statusCode ?? 502);
    }
    proxyRes.resume();
  });
  proxyReq.on("error", () => {
    if (!settled) {
      settled = true;
      rejectUpgrade(socket, 502);
    }
  });
  proxyReq.end();
}

/**
 * Dispatch one WebSocket upgrade. Never throws for a pre-handoff failure (it answers 500 on the
 * socket); once the route's `upgradeHandler` takes over the socket, a throw propagates to the
 * caller, which destroys the socket.
 */
export async function handleWebSocketUpgrade(
  deps: UpgradeDispatcher,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let upgradeHandler: ArtifactRouteHandler;
  let handlerContext: unknown;
  try {
    // The upgrade event bypasses the request-path secret gate — strip trusted dispatch headers so
    // a client cannot smuggle routing state past middleware. We always re-resolve locally.
    for (const h of INTERNAL_DISPATCH_HEADERS) delete req.headers[h];
    delete req.headers[INTERNAL_SECRET_HEADER];

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    }

    const resolution = await deps.resolve(url, headers, "GET", deps.makeEmptyBody());

    switch (resolution.kind) {
      case "redirect":
        return rejectUpgrade(socket, resolution.status, { location: resolution.url.toString() });
      case "error":
        return rejectUpgrade(socket, resolution.status);
      case "not-found":
        return rejectUpgrade(socket, 404);
      case "external-rewrite":
        return rejectUpgrade(socket, 502); // external rewrites unsupported (parity with routing svc)
      case "middleware-response":
        return await writeResponseAndClose(socket, resolution.response);
      case "route":
        break;
    }

    const { matchedPathname, routeMatches } = resolution;

    // Cross-pool: a Gateway path rule can outrank the x-upstream-pool header and land the upgrade on
    // the wrong pool. If this pool doesn't own the resolved output, forward the raw upgrade to the
    // owning pool (parity with the HTTP dispatcher's proxyToPool). The owning pool re-resolves and
    // runs the handler.
    if (resolution.pool !== deps.poolName && !deps.hasOutput(matchedPathname)) {
      return proxyUpgradeToPool(req, socket, head, resolution, deps);
    }

    // Apply middleware's AUTHORITATIVE request-header set (deletions included) before the handler,
    // so a WebSocket route sees exactly the headers middleware intended — never a spoofed header
    // middleware removed, and always one it injected.
    if (resolution.middlewareRequestHeaders) {
      applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders);
    }

    const found = await deps.loadUpgrade(matchedPathname);
    if (typeof found !== "function") {
      // Route resolved but declares no WebSocket handler — older Next, or a plain HTTP route.
      return rejectUpgrade(socket, 426, { Upgrade: "websocket" });
    }
    upgradeHandler = found;

    // Apply middleware/config rewrites: run the handler against the rewritten path+query. Sync the
    // raw request URL (the Vercel adapter does the same before invoking upgradeHandler) and carry
    // the rewrite + resolved query in requestMeta.
    const resolvedPathname = resolution.invokePath
      ? new URL(resolution.invokePath, url).pathname
      : url.pathname;
    if (resolution.invokePath) req.url = resolution.invokePath;
    const params = extractRouteParams(matchedPathname, routeMatches, resolvedPathname);

    handlerContext = {
      waitUntil(waitable: Promise<unknown>) {
        Promise.resolve(waitable).catch((err) =>
          console.error("[pool-server] ws waitUntil failed:", err),
        );
      },
      requestMeta: {
        relativeProjectDir: ".",
        hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
        minimalMode: deps.minimalMode,
        outputId: matchedPathname,
        matchedPathname,
        routeMatches,
        resolvedPathname,
        initURL: url.toString(), // the original public URL; rewrites live in rewrittenPathname/query
        ...(resolution.invokePath ? { rewrittenPathname: resolvedPathname } : {}),
        ...(resolution.invocationQuery ? { query: resolution.invocationQuery } : {}),
        ...(params ? { params } : {}),
      },
    };
  } catch (err) {
    console.error("[pool-server] WebSocket upgrade resolution failed:", err);
    rejectUpgrade(socket, 500);
    return;
  }

  // Handoff: the route now owns the socket. A throw here propagates to the caller (server.ts),
  // which destroys the socket — we must not write an HTTP status after a partial upgrade.
  await upgradeHandler(handlerContext, { node: { req, socket, head } });
}
