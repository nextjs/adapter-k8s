// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER } from "../routing-common.js";
import { guardStreamErrors, timingSafeStringEqual } from "./dispatch.js";

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

// Filter banned names out of the headers argument passed to writeHead. Node accepts
// THREE shapes there: an object map, an array of [name, value] tuples, AND a flat
// array [name1, value1, name2, value2] (the request.rawHeaders layout). A tuple-only
// filter silently fails on the flat form — `String(entry[0])` is the first CHARACTER
// of the header name, so nothing matches and banned headers sail through to the
// client (verified leak: writeHead(200, ["x-middleware-rewrite", …])). Shared by the
// internal-header strip below and index.ts's forced cache-policy wrapper.
export function filterWriteHeadHeadersArg(
  headersArg: unknown,
  isBanned: (name: string) => boolean,
): unknown {
  if (Array.isArray(headersArg)) {
    if (headersArg.length > 0 && !Array.isArray(headersArg[0])) {
      // Flat form: even offsets are names, odd offsets are values — filter pairwise.
      const filtered: unknown[] = [];
      for (let i = 0; i + 1 < headersArg.length; i += 2) {
        if (!isBanned(String(headersArg[i]))) filtered.push(headersArg[i], headersArg[i + 1]);
      }
      return filtered;
    }
    return headersArg.filter((entry) => !isBanned(String((entry as [unknown])[0])));
  }
  if (headersArg && typeof headersArg === "object") {
    for (const key of Object.keys(headersArg)) {
      if (isBanned(key)) {
        delete (headersArg as Record<string, unknown>)[key];
      }
    }
  }
  return headersArg;
}

export interface PoolServerOptions {
  onRequest: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
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
  const { onRequest, port, trustInternalHeaders = false, internalSecret } = options;

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
      ? typeof presentedSecret === "string" &&
        timingSafeStringEqual(presentedSecret, internalSecret)
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
      // Strip from the headers argument, if present — object, tuple-array, AND
      // flat-array forms (writeHead(status[, statusMessage], headers)); any of them
      // sails past the setHeader-map checks above.
      const headersArgIdx = typeof args[0] === "string" ? 1 : 0;
      if (args[headersArgIdx] !== undefined) {
        args[headersArgIdx] = filterWriteHeadHeadersArg(
          args[headersArgIdx],
          isInternalResponseHeader,
        );
      }
      return origWriteHead(statusCode, ...args);
    };

    // Attach the no-op socket-error guard at the single per-request choke point: every
    // downstream write (the index.ts static/public/image fast paths, dispatch, and the
    // 500 fallback below) is then safe from a mid-response client disconnect crashing
    // the process with an unhandled 'error' event.
    guardStreamErrors(res);

    const start = Date.now();
    try {
      await onRequest(req, res);
    } catch (err) {
      // The full error stays in the server log — the client body must not leak internal
      // error messages (stack fragments, paths, upstream hostnames).
      console.error("Unhandled request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("Internal Server Error");
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      const ms = Date.now() - start;
      // Log the pathname only — the raw query string routinely carries tokens and
      // signed parameters (pre-signed URLs, session hints) that must not land in logs.
      const logPath = req.url?.split("?", 1)[0] ?? "";
      console.log(`${req.method} ${logPath} → ${res.statusCode} (${ms}ms)`);
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
