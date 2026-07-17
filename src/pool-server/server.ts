// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER } from "../routing-common.js";

// Constant-time string compare, guarding the length side-channel (timingSafeEqual throws on
// unequal-length buffers).
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Internal headers that must not leak to the client.
const INTERNAL_RESPONSE_HEADERS = [
  "x-middleware-next",
  "x-middleware-rewrite",
  "x-middleware-refresh",
  "x-middleware-override-headers",
  "x-middleware-set-cookie",
];

// These two x-middleware-* names are part of the public Pages Router prefetch
// protocol, not middleware control state. The browser sends `prefetch`; a
// dynamic handler answers `skip` so the router discards the speculative result.
const PUBLIC_MIDDLEWARE_REQUEST_HEADERS = new Set(["x-middleware-prefetch"]);
const PUBLIC_MIDDLEWARE_RESPONSE_HEADERS = new Set(["x-middleware-skip"]);

// True for any internal control header that must never reach the client, whether it
// arrives via the setHeader-map or as a key in a headers object passed to writeHead.
function isInternalResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (PUBLIC_MIDDLEWARE_RESPONSE_HEADERS.has(lower)) return false;
  return (
    INTERNAL_RESPONSE_HEADERS.includes(lower) ||
    lower.startsWith("x-middleware-request-") ||
    lower.startsWith("x-middleware-")
  );
}

export interface PoolServerOptions {
  onRequest: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  /**
   * Optional WebSocket handshake handler. A WS upgrade is an HTTP GET with `Connection: Upgrade`
   * that Node routes to the `upgrade` event (never `onRequest`). When omitted, upgrade requests
   * fall through to Node's default (the socket is closed).
   */
  onUpgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
  port: number;
  /**
   * When true, trust x-output-id etc. from the request WITHOUT a secret. Legacy fallback used
   * only when no `internalSecret` is configured (e.g. tests). Ignored once a secret is set.
   */
  trustInternalHeaders?: boolean;
  /**
   * Shared secret proving a request's internal dispatch headers came from the routing
   * extension / cross-pool proxy (they carry it in x-internal-secret). When set, dispatch
   * headers are trusted ONLY if the secret matches — regardless of trustInternalHeaders — so a
   * client that speaks the dispatch protocol on a CEL-excluded path or during a fail-open
   * outage is still rejected. Absent in emulate/tests.
   */
  internalSecret?: string | undefined;
}

export function createPoolServer(options: PoolServerOptions) {
  const { onRequest, onUpgrade, port, trustInternalHeaders = false, internalSecret } = options;

  const server: Server = createServer(async (req, res) => {
    // Health check — bypass all routing
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Establish whether the internal dispatch headers on this request can be trusted. With a
    // secret configured (GKE), trust requires a matching x-internal-secret; without one
    // (emulate/tests), fall back to the trustInternalHeaders flag. The secret itself must never
    // reach the handler or leak upstream, so it is always deleted.
    const presentedSecret = req.headers[INTERNAL_SECRET_HEADER];
    const trusted = internalSecret
      ? typeof presentedSecret === "string" && secretsMatch(presentedSecret, internalSecret)
      : trustInternalHeaders;
    delete req.headers[INTERNAL_SECRET_HEADER];

    // Strip internal routing headers from untrusted sources. A client must not be able to
    // spoof the dispatch protocol (e.g. x-output-id → dispatch straight to a handler, skipping
    // middleware auth); stripping forces the pool's Phase-1 resolver to run with the real body.
    if (!trusted) {
      for (const h of INTERNAL_DISPATCH_HEADERS) {
        delete req.headers[h];
      }
    }

    // Strip private middleware control headers from incoming requests. The
    // Pages Router's public prefetch hint is deliberately retained.
    for (const h of Object.keys(req.headers)) {
      if (h.startsWith("x-middleware-") && !PUBLIC_MIDDLEWARE_REQUEST_HEADERS.has(h)) {
        delete req.headers[h];
      }
    }

    // Wrap res.writeHead to strip internal headers from responses.
    // Real paths pass headers both ways: via the setHeader-map AND as the headers
    // object argument to writeHead(status[, statusMessage], headers). Strip both.
    const origWriteHead = res.writeHead.bind(res);
    (res as any).writeHead = function (statusCode: number, ...args: any[]) {
      // Strip from the setHeader-map.
      for (const name of res.getHeaderNames()) {
        if (isInternalResponseHeader(name)) {
          res.removeHeader(name);
        }
      }
      // Strip from the headers object passed as an argument, if present.
      // writeHead(status, headers) or writeHead(status, statusMessage, headers).
      const headersArgIdx = typeof args[0] === "string" ? 1 : 0;
      const headersArg = args[headersArgIdx];
      if (headersArg && typeof headersArg === "object" && !Array.isArray(headersArg)) {
        for (const key of Object.keys(headersArg)) {
          if (isInternalResponseHeader(key)) {
            delete headersArg[key];
          }
        }
      }
      return origWriteHead(statusCode, ...args);
    };

    const start = Date.now();
    httpInflight++;
    try {
      await onRequest(req, res);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("Unhandled request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`Internal Server Error: ${errMsg}`);
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      httpInflight--;
      const ms = Date.now() - start;
      console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
    }
  });

  // Track established WebSocket sockets so shutdown can drain them gracefully (blue/green cutover,
  // rollback, HPA scale-down all SIGTERM the pod) instead of dropping them mid-connection.
  const wsSockets = new Set<Duplex>();
  // In-flight ordinary HTTP requests — drain must let these finish too, else a rollout/scale-down
  // truncates responses (the pre-drain behavior was `await server.close()`, which waited for them).
  let httpInflight = 0;
  let draining = false;

  if (onUpgrade) {
    server.on("upgrade", (req, socket: Duplex, head: Buffer) => {
      if (draining) {
        // Terminating: refuse new upgrades so the client reconnects to a live pod/build.
        try {
          socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        } catch {
          // socket already gone
        }
        socket.destroy();
        return;
      }
      wsSockets.add(socket);
      socket.once("close", () => wsSockets.delete(socket));
      // A peer reset (common when a client drops mid-connection or during drain) must not surface
      // as an uncaught 'error' and crash the pool; the route handler adds its own handling on top.
      socket.on("error", () => {});
      // A throw after the route takes over the socket must not leak an open connection.
      Promise.resolve(onUpgrade(req, socket, head)).catch((err) => {
        console.error("Unhandled WebSocket upgrade error:", err);
        if (!socket.destroyed) socket.destroy();
      });
    });
  }

  // WebSocket CLOSE frame, status 1001 "going away" (FIN|close, len 2, code 0x03E9). Unmasked
  // because server→client frames are never masked.
  const GOING_AWAY = Buffer.from([0x88, 0x02, 0x03, 0xe9]);

  return {
    /**
     * Stop accepting new connections and drain established WebSocket sockets: wait up to `drainMs`
     * for clients to disconnect, then send a `going away` close and force-destroy the rest so
     * clients reconnect to the new build. Resolves once the socket set is empty or forced.
     */
    async drain({ drainMs }: { drainMs: number }): Promise<{ drained: number; forced: number }> {
      draining = true;
      // Stop accepting NEW connections immediately. We do NOT await the close callback — it only
      // fires once every socket (including live WebSockets) is gone, which is what we bound below.
      server.close();
      const total = wsSockets.size;
      const deadline = Date.now() + drainMs;
      // Wait for both established WebSockets AND in-flight HTTP requests to finish — exiting while
      // an ordinary request is mid-response would truncate it on every rollout/scale-down.
      while ((wsSockets.size > 0 || httpInflight > 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const remaining = wsSockets.size;
      if (remaining > 0) {
        for (const s of wsSockets) {
          try {
            if (!s.destroyed) s.write(GOING_AWAY);
          } catch {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, 1000)); // let close frames flush
        for (const s of wsSockets) {
          try {
            if (!s.destroyed) s.destroy();
          } catch {
            /* ignore */
          }
        }
      }
      return { drained: total - remaining, forced: remaining };
    },

    start(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
          const addr = server.address();
          if (!addr || typeof addr === "string") {
            reject(new Error("Failed to get server address"));
            return;
          }
          console.log(`Pool server listening on port ${addr.port}`);
          resolve({ port: addr.port });
        });
      });
    },

    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    get server() {
      return server;
    },
  };
}
