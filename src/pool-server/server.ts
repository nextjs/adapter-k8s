// src/pool-server/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_SECRET_HEADER,
  requestTargetPathname,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
  verifyDispatchProof,
} from "../routing-common.js";
import { guardStreamErrors } from "./dispatch.js";
import {
  metricHttpMethod,
  recordPoolRequest,
  recordSpanError,
  requestParentContext,
  runtimeTelemetryAttributes,
  setSpanAttributes,
  setSpanHttpStatus,
  withAdapterSpan,
  type TraceHeaderCarrier,
} from "../telemetry.js";

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

export interface RequestTrustOptions {
  internalSecret?: string | undefined;
  trustInternalHeaders?: boolean;
  /** Build-derived matcher and RSC headers covered by the per-request dispatch proof. */
  proofHeaderNames?: readonly string[] | undefined;
}

/**
 * Request-only half of the pool trust boundary, shared by ordinary HTTP and Node's separate
 * `upgrade` event. Returns whether proof-gated dispatch headers were accepted.
 */
export function applyIncomingRequestTrustBoundary(
  req: IncomingMessage,
  options: RequestTrustOptions,
): boolean {
  const { internalSecret, trustInternalHeaders = false, proofHeaderNames } = options;

  // Establish whether the internal dispatch headers on this request can be trusted. With a
  // secret configured (GKE), trust requires a valid PER-REQUEST PROOF over every routing input
  // this pool is about to act on — the method, the request target, the authority, the forwarding
  // witnesses, the complete dispatch header set, and this build's derived inputs — its
  // middleware-matcher headers and its RSC negotiation headers
  // (routing-common.ts INTERNAL_DISPATCH_PROOF_HEADER / computeDispatchProof). Verified against
  // the RAW wire headers, before the strips below rewrite any of them. The v1 raw-secret header
  // is NEVER honored: it is no longer stamped by any producer, and accepting it would keep the
  // "read one ext_proc response, replay forever" hole open. Trusted pairings are always
  // same-build (per-build secret + N87's secretKeyRef-moves-with-image), so a legacy raw-secret
  // producer and a proof-only pool can never share a credential anyway — cross-build mismatches
  // fail closed to local resolution exactly as before. Without a secret (emulate/tests), fall
  // back to the trustInternalHeaders flag. Both credential headers are always deleted.
  const presentedProof = req.headers[INTERNAL_DISPATCH_PROOF_HEADER];
  const trusted = internalSecret
    ? typeof presentedProof === "string" &&
      verifyDispatchProof(
        internalSecret,
        {
          method: req.method,
          target: req.url,
          headers: req.headers,
          proofHeaderNames,
        },
        presentedProof,
      )
    : trustInternalHeaders;
  delete req.headers[INTERNAL_SECRET_HEADER];
  delete req.headers[INTERNAL_DISPATCH_PROOF_HEADER];

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

  return trusted;
}

/**
 * Full HTTP trust boundary: apply the shared incoming-request checks, prevent internal response
 * headers from leaking, and guard client-disconnect errors.
 *
 * Exported because both the HTTP server below and Pages `res.revalidate()` re-entry call the same
 * handler. Idempotent: applying it twice strips the same headers and stacks a harmless wrapper.
 */
export function applyRequestTrustBoundary(
  req: IncomingMessage,
  res: ServerResponse,
  options: RequestTrustOptions,
): void {
  applyIncomingRequestTrustBoundary(req, options);

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
  /**
   * Node upgrade transport used by Next's generated App Route `upgradeHandler`. Returning
   * `accepted` marks the still-open socket as an established WebSocket for graceful shutdown.
   */
  onUpgrade?: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => "accepted" | "rejected" | Promise<"accepted" | "rejected">;
  port: number;
  /**
   * When true, trust x-output-id etc. from the request WITHOUT a secret. Legacy fallback used
   * only when no `internalSecret` is configured (e.g. tests). Ignored once a secret is set.
   */
  trustInternalHeaders?: boolean;
  /**
   * Shared secret proving a request's internal dispatch headers came from the routing
   * extension / cross-pool proxy. Never carried on the wire itself: trusted requests carry
   * a per-request HMAC proof in x-internal-dispatch-proof (routing-common.ts), verified
   * against this value. When set, dispatch headers are trusted ONLY with a valid proof —
   * regardless of trustInternalHeaders — so a client that speaks the dispatch protocol on
   * a CEL-excluded path or during a fail-open outage is still rejected, and anyone able to
   * observe a trusted exchange gains a credential valid for exactly that one request.
   * Absent in emulate/tests.
   */
  internalSecret?: string | undefined;
  /**
   * This build's proof-covered request headers (routing-common.ts `buildProofHeaderNames`: the
   * middleware-matcher inputs plus the RSC negotiation headers) — part of the dispatch proof's
   * covered set, so the pool must verify with the SAME list the routing service and the
   * cross-pool proxy sign with. Absent means "none", correct for a build with neither.
   */
  proofHeaderNames?: readonly string[] | undefined;
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
  /** Validated build-time pool name, used only as a bounded telemetry attribute. */
  poolName?: string;
}

interface ActiveResponseState {
  settled: boolean;
  eventStream: boolean;
  /** Terminal action initiated by the adapter, rather than the handler or peer. */
  terminalAction?: "end-sse" | "force-close";
}

/**
 * One drain outcome per tracked response, and one per tracked socket. The HTTP categories
 * (completed, clientClosed, sseEnded, sseForced, httpForceClosed) are mutually exclusive and never
 * sum past httpAtStart — an operator reading the single "drain complete" line after an incident has
 * to be able to add them up, so a response that receives an SSE EOF and is then destroyed because
 * the EOF never flushed must land in exactly one of them (sseForced), not in two.
 */
interface DrainMetrics {
  httpAtStart: number;
  httpCompleted: number;
  httpClientClosed: number;
  sseEnded: number;
  sseForced: number;
  httpForceClosed: number;
  webSocketsAtStart: number;
  webSocketsPeerClosed: number;
  webSocketsSignalled: number;
  webSocketsForceClosed: number;
}

function isEventStreamContentType(value: unknown): boolean {
  const contentType = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return /^\s*text\/event-stream(?:\s*;|\s*$)/i.test(contentType);
}

/** Read one header from any of Node's writeHead header argument shapes. */
function writeHeadHeaderValue(args: unknown[], wantedName: string): unknown {
  const headers = args[typeof args[0] === "string" ? 1 : 0];
  if (Array.isArray(headers)) {
    if (headers.length > 0 && Array.isArray(headers[0])) {
      const tuple = (headers as Array<[unknown, unknown]>).find(
        ([name]) => String(name).toLowerCase() === wantedName,
      );
      return tuple?.[1];
    }
    for (let index = 0; index + 1 < headers.length; index += 2) {
      if (String(headers[index]).toLowerCase() === wantedName) return headers[index + 1];
    }
    return undefined;
  }
  if (headers && typeof headers === "object") {
    const key = Object.keys(headers).find((name) => name.toLowerCase() === wantedName);
    return key === undefined ? undefined : (headers as Record<string, unknown>)[key];
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(1, ms));
    timer.unref?.();
  });
}

export function createPoolServer(options: PoolServerOptions) {
  const {
    onRequest,
    onUpgrade,
    port,
    trustInternalHeaders = false,
    internalSecret,
    proofHeaderNames,
    readiness,
    appOwnsProbePath,
    poolName,
  } = options;

  // /readyz detail goes to the pod LOG, not the wire: the probe interception runs before any
  // trust check and the Gateway catch-all HTTPRoute forwards every path to this port, so the
  // body is internet-visible. The reason string names internal route-output keys ("route
  // module loaded (/ssr)") and startup state — a free side-channel into the release for any
  // client. Log it once per transition; the probe consumer (kubelet, HealthCheckPolicy,
  // cutover gate) reads only the status code.
  let lastLoggedNotReady: string | undefined;

  // N88. HTTP responses and protocol upgrades have different ownership in Node. Ordinary
  // responses stay attached to the HTTP server; upgraded sockets do not. Track both explicitly so
  // shutdown can let finite responses complete, end SSE with a reconnectable EOF, and close a
  // WebSocket with RFC 6455 code 1001 instead of applying one blunt socket operation to all three.
  const activeResponses = new Map<ServerResponse, ActiveResponseState>();
  const upgradedSockets = new Map<Duplex, { accepted: boolean; serverSignalled: boolean }>();
  let draining = false;
  let drainMetrics: DrainMetrics | undefined;
  let stopPromise: Promise<void> | undefined;

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
      const state = draining
        ? { ready: false, reason: "shutting down" }
        : (readiness?.() ?? { ready: false, reason: "readiness state not wired" });
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

    // server.close() stops NEW TCP connections, but an already-established HTTP/1.1 connection
    // can pipeline another request across the signal boundary. Refuse that new unit of work while
    // allowing the response already in flight on the same connection to finish.
    if (draining) {
      res.writeHead(503, {
        "content-type": "text/plain",
        "cache-control": "no-store",
        connection: "close",
        "retry-after": "1",
      });
      res.end("Service Unavailable");
      return;
    }

    applyRequestTrustBoundary(req, res, {
      internalSecret,
      trustInternalHeaders,
      proofHeaderNames,
    });

    const responseState: ActiveResponseState = { settled: false, eventStream: false };
    activeResponses.set(res, responseState);
    // ServerResponse.getHeader() no longer exposes committed headers on every supported Node
    // version. Capture Content-Type at the public mutation boundary so the terminal drain phase
    // does not need private `_header` parsing or unreliable heuristics based on the pathname.
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toLowerCase() === "content-type") {
        responseState.eventStream = isEventStreamContentType(value);
      }
      return originalSetHeader(name, value);
    }) as ServerResponse["setHeader"];
    const originalRemoveHeader = res.removeHeader.bind(res);
    res.removeHeader = ((name: string) => {
      const result = originalRemoveHeader(name);
      if (name.toLowerCase() === "content-type") responseState.eventStream = false;
      return result;
    }) as ServerResponse["removeHeader"];
    const originalTrackedWriteHead = res.writeHead.bind(res);
    (res as any).writeHead = function (statusCode: number, ...args: unknown[]) {
      const contentType = writeHeadHeaderValue(args, "content-type");
      if (contentType !== undefined) {
        responseState.eventStream = isEventStreamContentType(contentType);
      }
      return originalTrackedWriteHead(statusCode, ...(args as [never]));
    };
    const settleResponse = (finished: boolean) => {
      if (responseState.settled) return;
      responseState.settled = true;
      activeResponses.delete(res);
      if (!drainMetrics) return;
      // Adapter-initiated terminal actions are counted where they are initiated — except the SSE
      // EOF, whose outcome is only known once the response settles. Counting it here keeps a
      // stream that flushed (sseEnded) apart from one still queued when the flush window expired,
      // which the terminal phase counts as sseForced after flipping terminalAction.
      if (responseState.terminalAction === "end-sse") {
        drainMetrics.sseEnded += 1;
        return;
      }
      if (responseState.terminalAction) return;
      if (finished || res.writableFinished) drainMetrics.httpCompleted += 1;
      else drainMetrics.httpClientClosed += 1;
    };
    res.once("finish", () => settleResponse(true));
    res.once("close", () => settleResponse(false));

    const start = performance.now();
    const method = metricHttpMethod(req.method);
    const providerAttributes = runtimeTelemetryAttributes();
    const parentContext = requestParentContext(req.headers as TraceHeaderCarrier, true);
    await withAdapterSpan(
      "adapter-k8s.pool.request",
      parentContext,
      {
        "adapter_k8s.component": "pool-server",
        "http.request.method": method,
        ...providerAttributes,
        ...(poolName ? { "adapter_k8s.pool.name": poolName } : {}),
      },
      async ({ span }) => {
        let requestFailed = false;
        try {
          await onRequest(req, res);
        } catch (err) {
          requestFailed = true;
          recordSpanError(span, err);
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
          const ms = performance.now() - start;
          const result = requestFailed || res.statusCode >= 500 ? "error" : "ok";
          const metricAttributes = {
            "adapter_k8s.component": "pool-server",
            "adapter_k8s.pool.result": result,
            "http.request.method": method,
            "http.response.status_code": res.statusCode,
            ...providerAttributes,
            ...(poolName ? { "adapter_k8s.pool.name": poolName } : {}),
          };
          setSpanAttributes(span, {
            "adapter_k8s.pool.result": result,
            ...(poolName ? { "adapter_k8s.pool.name": poolName } : {}),
          });
          setSpanHttpStatus(span, res.statusCode);
          recordPoolRequest(ms, metricAttributes);

          // Log the pathname only — the raw query string routinely carries tokens and
          // signed parameters (pre-signed URLs, session hints) that must not land in logs.
          const logPath = req.url?.split("?", 1)[0] ?? "";
          console.log(`${req.method} ${logPath} → ${res.statusCode} (${Math.round(ms)}ms)`);
        }
      },
    );
  });

  // Node removes upgraded connections from ordinary HTTP connection management. Keep explicit
  // ownership so a rollout has a bounded, protocol-aware shutdown instead of either leaking the
  // process until SIGKILL or dropping every connection without a close frame.
  if (onUpgrade) {
    server.on("upgrade", (req, socket, head) => {
      if (draining) {
        socket.end(
          "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n" + "Content-Length: 0\r\n\r\n",
        );
        return;
      }

      applyIncomingRequestTrustBoundary(req, {
        internalSecret,
        trustInternalHeaders,
        proofHeaderNames,
      });
      const socketState = { accepted: false, serverSignalled: false };
      upgradedSockets.set(socket, socketState);
      socket.once("close", () => {
        upgradedSockets.delete(socket);
        if (drainMetrics && !socketState.serverSignalled) {
          drainMetrics.webSocketsPeerClosed += 1;
        }
      });
      // Client resets are normal for long-lived connections and must never become an uncaught
      // EventEmitter error that terminates the whole pool.
      socket.on("error", () => undefined);

      Promise.resolve(onUpgrade(req, socket, head))
        .then((disposition) => {
          const state = upgradedSockets.get(socket);
          if (state && disposition === "accepted") state.accepted = true;
          if (disposition === "rejected" && !socket.destroyed && !socket.writableEnded) {
            // The SERVER is ending this handshake. Without the flag a rejection that lands after
            // drain begins is reported as webSocketsPeerClosed — a voluntary peer departure the
            // peer never made — because the close listener treats every unsignalled close as one.
            if (state) state.serverSignalled = true;
            socket.end();
          }
        })
        .catch((error) => {
          console.error("Unhandled WebSocket upgrade error:", error);
          if (!socket.destroyed) socket.destroy();
        });
    });
  }

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
     * This form always settles: stop accepting, drop idle keep-alive sockets immediately, let
     * active responses use the COMPLETE grace window, then close each surviving protocol
     * honestly. SSE receives a normal EOF (EventSource can reconnect); an incomplete finite body
     * is reset rather than pretending truncated bytes are complete; established WebSockets get
     * RFC 6455 code 1001 before forced teardown. Errors are swallowed — "already closing" and
     * "never started" are the only outcomes, and neither should stop a caller from exiting.
     */
    async stop(options: { graceMs?: number } = {}): Promise<void> {
      if (stopPromise) return stopPromise;

      stopPromise = (async () => {
        const graceMs = Math.max(1, options.graceMs ?? 60_000);
        const startedAt = Date.now();
        const deadline = startedAt + graceMs;
        draining = true;
        drainMetrics = {
          httpAtStart: activeResponses.size,
          httpCompleted: 0,
          httpClientClosed: 0,
          sseEnded: 0,
          sseForced: 0,
          httpForceClosed: 0,
          webSocketsAtStart: upgradedSockets.size,
          webSocketsPeerClosed: 0,
          webSocketsSignalled: 0,
          webSocketsForceClosed: 0,
        };

        let serverClosed = false;
        const closed = new Promise<void>((resolve) => {
          // Ignore ERR_SERVER_NOT_RUNNING: stop() is deliberately settle-always and idempotent.
          server.close(() => {
            serverClosed = true;
            resolve();
          });
        });
        // An idle keep-alive socket alone is enough to keep close() pending forever, and carries no
        // in-flight work worth preserving.
        server.closeIdleConnections?.();

        // Wait for every tracked protocol to leave voluntarily. Polling is deliberate and bounded:
        // finish/close can race each other and Node offers no single event spanning HTTP responses,
        // half-read requests, and upgraded sockets.
        while (Date.now() < deadline) {
          if (activeResponses.size === 0 && upgradedSockets.size === 0 && serverClosed) break;
          await delay(Math.min(25, Math.max(1, deadline - Date.now())));
        }

        // The deadline belongs to application work, so no finite response is cut at an arbitrary
        // halfway point. Only survivors reach this protocol-aware terminal phase.
        let terminalFlushRequired = false;
        for (const [res, state] of activeResponses) {
          if (res.writableEnded || res.destroyed) continue;
          if (state.eventStream) {
            state.terminalAction = "end-sse";
            // Counted on settle (sseEnded) or in the final destroy loop (sseForced), not here: a
            // client that is not reading leaves this EOF queued past the flush window, and the
            // same stream must not be reported as both cleanly ended and force-closed.
            // Do not invent an SSE data/control event: event IDs and replay semantics belong to
            // the application. A clean HTTP EOF is sufficient for EventSource to reconnect.
            res.end();
            terminalFlushRequired = true;
          } else {
            state.terminalAction = "force-close";
            drainMetrics.httpForceClosed += 1;
            // A normal end would falsely authenticate a partial finite body as complete.
            res.destroy();
          }
        }

        if (upgradedSockets.size > 0) {
          // RFC 6455 close code 1001: endpoint is going away (rollout, rollback, HPA scale-down).
          // Pending handshakes are still HTTP, so only established sockets receive a WS frame.
          const goingAway = Buffer.from([0x88, 0x02, 0x03, 0xe9]);
          for (const [socket, state] of upgradedSockets) {
            try {
              if (!socket.destroyed) {
                state.serverSignalled = true;
                if (state.accepted) {
                  drainMetrics.webSocketsSignalled += 1;
                  socket.write(goingAway);
                } else {
                  socket.end();
                }
                terminalFlushRequired = true;
              }
            } catch {
              // The peer disappeared between the set iteration and the write.
            }
          }
        }

        // The process signal path has a one-second hard-exit cushion. Spend at most 250ms of it
        // flushing SSE EOF / WebSocket close frames, then make termination deterministic.
        // server.close() does not own upgraded sockets and may resolve while their close frames
        // are still queued. Give terminal protocol bytes their own bounded flush window instead
        // of racing that unrelated callback (a fast callback otherwise wins with a 0ms flush).
        if (terminalFlushRequired) await delay(Math.min(250, graceMs));
        for (const [socket, state] of upgradedSockets) {
          if (!socket.destroyed) {
            state.serverSignalled = true;
            drainMetrics.webSocketsForceClosed += 1;
            socket.destroy();
          }
        }
        for (const [res, state] of activeResponses) {
          if (!res.destroyed) {
            if (state.terminalAction !== "force-close") {
              // An SSE EOF still queued here never reached the client, so it belongs in its own
              // category rather than in httpForced on top of the sseEnded it would otherwise also
              // be credited with. Flipping terminalAction first keeps settleResponse from
              // counting the destroy that follows a second time.
              if (state.terminalAction === "end-sse") drainMetrics.sseForced += 1;
              else drainMetrics.httpForceClosed += 1;
              state.terminalAction = "force-close";
            }
            res.destroy();
          }
        }
        // Catches a connection still receiving headers and therefore not yet represented by a
        // ServerResponse. Node intentionally excludes upgraded sockets; those were handled above.
        server.closeAllConnections?.();
        await Promise.race([closed, delay(250)]);

        const elapsedMs = Date.now() - startedAt;
        console.log(
          `[pool-server] drain complete in ${elapsedMs}ms: ` +
            `http=${drainMetrics.httpAtStart} completed=${drainMetrics.httpCompleted} ` +
            `clientClosed=${drainMetrics.httpClientClosed} sseEnded=${drainMetrics.sseEnded} ` +
            `sseForced=${drainMetrics.sseForced} httpForced=${drainMetrics.httpForceClosed}; ` +
            `webSockets=${drainMetrics.webSocketsAtStart} ` +
            `peerClosed=${drainMetrics.webSocketsPeerClosed} ` +
            `signalled=${drainMetrics.webSocketsSignalled} ` +
            `wsForced=${drainMetrics.webSocketsForceClosed}`,
        );
      })();

      return stopPromise;
    },

    get server() {
      return server;
    },
  };
}
