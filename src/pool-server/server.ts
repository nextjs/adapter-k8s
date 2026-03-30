// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

// Internal headers set by ext_proc / cross-pool proxy — must not be trusted from external clients.
const INTERNAL_REQUEST_HEADERS = [
  "x-output-id",
  "x-matched-pathname",
  "x-route-matches",
  "x-upstream-pool",
];

// Internal headers that must not leak to the client.
const INTERNAL_RESPONSE_HEADERS = [
  "x-middleware-next",
  "x-middleware-rewrite",
  "x-middleware-refresh",
  "x-middleware-override-headers",
  "x-middleware-set-cookie",
];

export interface PoolServerOptions {
  onRequest: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  port: number;
  /** When true, trust x-output-id etc. from the request (set by ext_proc or cross-pool proxy). */
  trustInternalHeaders?: boolean;
}

export function createPoolServer(options: PoolServerOptions) {
  const { onRequest, port, trustInternalHeaders = false } = options;

  const server: Server = createServer(async (req, res) => {
    // Health check — bypass all routing
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Strip internal routing headers from untrusted sources (defense in depth).
    // In GKE, ext_proc sets these; in emulate mode, there's no Envoy to strip them.
    if (!trustInternalHeaders) {
      for (const h of INTERNAL_REQUEST_HEADERS) {
        delete req.headers[h];
      }
    }

    // Always strip x-middleware-* from incoming requests — clients must not
    // be able to spoof middleware control headers (e.g. x-middleware-set-cookie).
    for (const h of Object.keys(req.headers)) {
      if (h.startsWith("x-middleware-")) {
        delete req.headers[h];
      }
    }

    // Wrap res.writeHead to strip internal headers from responses
    const origWriteHead = res.writeHead.bind(res);
    (res as any).writeHead = function (statusCode: number, ...args: any[]) {
      for (const h of INTERNAL_RESPONSE_HEADERS) {
        res.removeHeader(h);
      }
      // Also strip x-middleware-request-* headers
      const headerNames = res.getHeaderNames();
      for (const name of headerNames) {
        if (name.startsWith("x-middleware-request-")) {
          res.removeHeader(name);
        }
      }
      return origWriteHead(statusCode, ...args);
    };

    const start = Date.now();
    try {
      await onRequest(req, res);
    } catch (err) {
      console.error("Unhandled request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      const ms = Date.now() - start;
      console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`);
    }
  });

  return {
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
