// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_SECRET_HEADER,
  requestTargetPathname,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
} from "../routing-common.js";
import { guardStreamErrors, timingSafeStringEqual } from "./dispatch.js";

/**
 * LIVENESS. "This process is answering HTTP." Nothing more — do NOT gate traffic on it.
 * Kubernetes should restart the pod when this stops answering.
 */
export const LIVENESS_PATH = "/healthz";

/**
 * READINESS. N32: `/healthz` returned a hardcoded 200 before any routing, handler load, or
 * manifest check, and it was the ONLY path used by both probes and both HealthCheckPolicies —
 * so a build whose `instrumentation.js` `register()` throws, or whose Next output cannot be
 * `import()`ed, kept answering 200 while every app route 500'd, and the blue/green gate read
 * that as a healthy build and gave it 100% of traffic. (The pool's own comments at
 * registerInstrumentationHook already stated the consequence.) `/readyz` answers 503 until the
 * pod has actually reached a serving state: instrumentation registration did not FAIL and at
 * least one route module of this pool imported successfully. Probes and the cutover gate must
 * point HERE; see the deployment/deploy handoff in the review report.
 */
export const READINESS_PATH = "/readyz";

/** Verdict returned by the readiness supplier: `reason` is surfaced in the probe body. */
export interface ReadinessState {
  ready: boolean;
  reason: string;
}

/**
 * Establish the request trust boundary: decide whether this request's internal dispatch headers
 * are trustworthy, strip everything a client must not be able to assert, wrap `writeHead` so no
 * internal control header can leak back, and attach the socket-error guard.
 *
 * Exported because there are TWO doors into `handleRequest`: the HTTP server below and the
 * in-process `revalidate()` re-entry (Pages `res.revalidate()`), which called `handleRequest`
 * directly and therefore skipped all of this while `handleRequest` still read `x-output-id` /
 * `x-mw-evaluated` as trusted. Not exploitable today (Next builds those internal headers itself)
 * but it was a second, unguarded entrance to the same trust boundary; both callers now share
 * this one function. Idempotent — applying it twice strips the same headers and stacks a
 * harmless second wrapper.
 */
export function applyRequestTrustBoundary(
  req: IncomingMessage,
  res: ServerResponse,
  options: { internalSecret?: string | undefined; trustInternalHeaders?: boolean },
): void {
  const { internalSecret, trustInternalHeaders = false } = options;

  // Establish whether the internal dispatch headers on this request can be trusted. With a
  // secret configured (GKE), trust requires a matching x-internal-secret; without one
  // (emulate/tests), fall back to the trustInternalHeaders flag. The secret itself must never
  // reach the handler or leak upstream, so it is always deleted.
  const presentedSecret = req.headers[INTERNAL_SECRET_HEADER];
  const trusted = internalSecret
    ? typeof presentedSecret === "string" && timingSafeStringEqual(presentedSecret, internalSecret)
    : trustInternalHeaders;
  delete req.headers[INTERNAL_SECRET_HEADER];

  // These are Next's private request controls, not trusted adapter dispatch headers. Keep the
  // list aligned with Next 16's server-ipc INTERNAL_HEADERS; legitimate values are synthesized
  // only after this boundary on private invocations.
  for (const h of UNTRUSTED_NEXT_REQUEST_HEADERS) {
    delete req.headers[h];
  }

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
  // 500 fallback in createPoolServer) is then safe from a mid-response client disconnect
  // crashing the process with an unhandled 'error' event.
  guardStreamErrors(res);
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
  /**
   * Readiness verdict for `/readyz`. When ABSENT the endpoint answers 503
   * ("readiness not wired") — deliberately fail-safe: every real deployment goes through
   * startPoolServer, which supplies one, so an absent supplier means an embedding that has not
   * declared what "serving" means and must not be handed traffic. See READINESS_PATH.
   */
  readiness?: () => ReadinessState;
  /**
   * True when the APP owns a probe pathname (`/healthz`, `/readyz`) as a real route. The probe
   * interception below is skipped for it so the app's route is served instead of being silently
   * shadowed. Previously the check was `req.url === "/healthz"`, which both shadowed such a route
   * AND was defeated by a query string — so the shadowing was inconsistent as well as silent.
   */
  appOwnsProbePath?: (pathname: string) => boolean;
}

export function createPoolServer(options: PoolServerOptions) {
  const {
    onRequest,
    port,
    trustInternalHeaders = false,
    internalSecret,
    readiness,
    appOwnsProbePath,
  } = options;

  // /readyz detail goes to the pod LOG, not the wire: the probe interception runs before any
  // trust check and the Gateway catch-all HTTPRoute forwards every path to this port, so the
  // body is internet-visible. The reason string names internal route-output keys ("route
  // module loaded (/ssr)") and startup state — a free side-channel into the release for any
  // client. Log it once per transition; the probe consumer (kubelet, HealthCheckPolicy,
  // cutover gate) reads only the status code.
  let lastLoggedNotReady: string | undefined;
  const server: Server = createServer(async (req, res) => {
    // Probes bypass all routing — unless the app itself owns the pathname (see appOwnsProbePath).
    // The pathname is parsed rather than compared to the raw target so `/healthz?x=1` is still a
    // probe, and so a `//healthz` target cannot be mistaken for one.
    const probePath = requestTargetPathname(req.url ?? "/");
    if (
      (probePath === LIVENESS_PATH || probePath === READINESS_PATH) &&
      !appOwnsProbePath?.(probePath)
    ) {
      if (probePath === LIVENESS_PATH) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      const state = readiness?.() ?? { ready: false, reason: "readiness state not wired" };
      if (!state.ready && state.reason !== lastLoggedNotReady) {
        lastLoggedNotReady = state.reason;
        console.warn(`[pool-server] /readyz unavailable: ${state.reason}`);
      } else if (state.ready) {
        lastLoggedNotReady = undefined;
      }
      res.writeHead(state.ready ? 200 : 503, {
        "content-type": "application/json",
        // A 503 must never be cached by the LB/CDN or a proxy between it and the kubelet.
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ status: state.ready ? "ok" : "unavailable" }));
      return;
    }

    applyRequestTrustBoundary(req, res, { internalSecret, trustInternalHeaders });

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

  // Keep-alive must outlive the proxy tier's upstream idle timeout (Envoy in front of this
  // pool, and Node's default is 5s): when the pool closes an idle socket the proxy just chose
  // for a new request, the client sees an intermittent 502 (and e2e runs see `socket hang up`).
  // 75s mirrors adapter-bun and common ingress defaults; the emitted Envoy/route config must
  // keep its upstream idle timeout STRICTLY below this. headersTimeout must exceed
  // keepAliveTimeout or Node still reaps a kept-alive socket that is merely waiting for the
  // next request line.
  const keepAliveEnv = Number(process.env.ADAPTER_K8S_KEEP_ALIVE_TIMEOUT_MS);
  const keepAliveTimeout =
    Number.isFinite(keepAliveEnv) && keepAliveEnv > 0 ? keepAliveEnv : 75_000;
  server.keepAliveTimeout = keepAliveTimeout;
  server.headersTimeout = keepAliveTimeout + 1_000;

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
          // Next's forwarded Server Action redirects fetch against __NEXT_PRIVATE_ORIGIN. In a
          // multi-replica pool an unset origin resolves through service DNS and can land the
          // internal fetch on a DIFFERENT pod — pin it to this process. Never a wildcard bind
          // address (0.0.0.0/:: are valid binds but invalid fetch targets), and never override
          // an operator-provided value.
          if (!process.env.__NEXT_PRIVATE_ORIGIN) {
            process.env.__NEXT_PRIVATE_ORIGIN = `http://127.0.0.1:${addr.port}`;
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

    /**
     * N41: a shutdown that actually terminates. `close()` above is the strict form — it REJECTS
     * with ERR_SERVER_NOT_RUNNING when the server is already closing (observed as an unhandled
     * rejection on a second SIGTERM) and it never RESOLVES while any connection is open, which
     * for a keep-alive pool means "never" and for a streaming response means "not until the
     * client leaves". `process.exit(0)` after it was therefore unreachable, so every rollout
     * waited out `terminationGracePeriodSeconds` and died to SIGKILL instead.
     *
     * This form always settles: stop accepting, drop idle keep-alive sockets immediately, and at
     * the halfway mark tear down whatever is still streaming so `close()` can complete. Errors
     * are swallowed — "already closing" and "never started" are the only outcomes, and neither
     * should stop a caller from exiting.
     */
    async stop(options: { graceMs?: number } = {}): Promise<void> {
      const graceMs = Math.max(1, options.graceMs ?? 15_000);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // An idle keep-alive socket alone is enough to keep close() pending forever.
      server.closeIdleConnections?.();
      const forceClose = setTimeout(() => server.closeAllConnections?.(), Math.floor(graceMs / 2));
      forceClose.unref?.();
      // Last resort: even closeAllConnections can be defeated (an upgraded socket the HTTP
      // server no longer tracks), so the wait itself is bounded.
      const timedOut = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, graceMs);
        t.unref?.();
      });
      await Promise.race([closed, timedOut]);
      clearTimeout(forceClose);
    },

    get server() {
      return server;
    },
  };
}
