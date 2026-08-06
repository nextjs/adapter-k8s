// tests/pool-server/dispatch-proxy.test.ts
// Real-socket regression tests for the proxy boundaries (external rewrite +
// cross-pool): framing-header honesty, bounded timeouts, disconnect abort,
// hop-by-hop stripping, and the x-resolved-headers protocol.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import type { DispatcherOptions } from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, request as httpRequest, type Server } from "node:http";
import dns from "node:dns";
import type { ResolveResult } from "../../src/pool-server/resolve.js";

const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");

function noopHandlerLoader(has: (p: string) => boolean = () => false) {
  return {
    load: vi.fn().mockResolvedValue(vi.fn()),
    has: vi.fn(has),
    get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
  } as any;
}

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  return new Promise<{ server: Server; port: number }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return reject(new Error("no address"));
      resolve({ server, port: addr.port });
    });
  });
}

// Boot a "front" pool server that dispatches every request with the given resolution.
async function startFront(
  resolution: ResolveResult | ((req: IncomingMessage) => ResolveResult),
  options: Partial<DispatcherOptions> = {},
) {
  const dispatcher = createDispatcher({
    handlerLoader: noopHandlerLoader(),
    poolName: "ssr",
    buildId: "test123",
    staticAssets: [],
    ...options,
  });
  return startServer((req, res) => {
    void dispatcher
      .dispatch(req, res, typeof resolution === "function" ? resolution(req) : resolution)
      .catch(() => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
      });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  vi.restoreAllMocks();
});

async function track<T extends { server: Server }>(s: Promise<T>): Promise<T> {
  const started = await s;
  servers.push(started.server);
  return started;
}

describe("external-rewrite proxy hardening", () => {
  it("drops a forged content-length on GET so the upstream doesn't hang", async () => {
    let upstreamContentLength: string | undefined;
    const upstream = await track(
      startServer((req, res) => {
        upstreamContentLength = req.headers["content-length"];
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream-ok");
      }),
    );
    const front = await track(
      startFront({
        kind: "external-rewrite",
        url: new URL(`http://127.0.0.1:${upstream.port}/api`),
      }),
    );

    // GET with a declared but never-sent body. Before the fix this forwarded the
    // header and the upstream hung awaiting 100 bytes until the 300s timeout.
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("request hung")), 5000);
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: front.port,
          path: "/api",
          method: "GET",
          headers: { "content-length": "100" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          });
        },
      );
      req.on("error", reject);
      req.end(); // deliberately send ZERO bytes despite content-length: 100
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("upstream-ok");
    expect(upstreamContentLength).toBeUndefined();
  });

  it("restates content-length from the actual buffered body and drops transfer-encoding", async () => {
    let seen: { contentLength?: string; transferEncoding?: string; body: string } = { body: "" };
    const upstream = await track(
      startServer((req, res) => {
        seen.contentLength = req.headers["content-length"];
        seen.transferEncoding = req.headers["transfer-encoding"];
        req.on("data", (c) => (seen.body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("ok");
        });
      }),
    );
    const payload = Buffer.from("buffered-payload");
    const front = await track(
      startServer((req, res) => {
        // Emulate index.ts: the pool buffers the request body and stashes it on
        // request meta before dispatch.
        (req as unknown as Record<PropertyKey, unknown>)[NEXT_REQUEST_META] = {
          actionBody: payload,
        };
        const dispatcher = createDispatcher({
          handlerLoader: noopHandlerLoader(),
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
        });
        void dispatcher
          .dispatch(req, res, {
            kind: "external-rewrite",
            url: new URL(`http://127.0.0.1:${upstream.port}/api`),
          })
          .catch(() => undefined);
      }),
    );

    const response = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: front.port,
          path: "/api",
          method: "POST",
          headers: { "transfer-encoding": "chunked" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });

    expect(response).toBe(200);
    expect(seen.body).toBe("buffered-payload");
    // The client's transfer-encoding never reaches the upstream; the forwarded
    // content-length describes the ACTUAL buffered body.
    expect(seen.transferEncoding).toBeUndefined();
    expect(seen.contentLength).toBe(String(payload.length));
  });

  it("504s promptly when the upstream exceeds the response-head deadline", async () => {
    const upstream = await track(
      startServer(() => {
        // Accept the request and never respond.
      }),
    );
    const front = await track(
      startFront(
        {
          kind: "external-rewrite",
          url: new URL(`http://127.0.0.1:${upstream.port}/api`),
        },
        { proxyTimeoutMs: 100 },
      ),
    );

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${front.port}/api`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(504);
    expect(await res.text()).toBe("Gateway Timeout");
    expect(elapsed).toBeLessThan(5000);
  });

  it("aborts the upstream request when the client disconnects early", async () => {
    let upstreamSawAbort = false;
    const upstream = await track(
      startServer((req, res) => {
        req.on("close", () => {
          if (!req.readableEnded || !res.writableEnded) upstreamSawAbort = true;
        });
        res.on("close", () => {
          if (!res.writableEnded) upstreamSawAbort = true;
        });
        // Never respond.
      }),
    );
    const front = await track(
      startFront(
        {
          kind: "external-rewrite",
          url: new URL(`http://127.0.0.1:${upstream.port}/api`),
        },
        // Long enough that only the disconnect-abort can cancel the upstream request.
        { proxyTimeoutMs: 30_000 },
      ),
    );

    // Raw socket: send the request, then hang up before the upstream answers.
    const socket = (await import("node:net")).createConnection({
      host: "127.0.0.1",
      port: front.port,
    });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(`GET /api HTTP/1.1\r\nHost: 127.0.0.1:${front.port}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 100));
    socket.destroy();

    // Give the close event time to propagate to the upstream server.
    for (let i = 0; i < 50 && !upstreamSawAbort; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(upstreamSawAbort).toBe(true);
  });

  it("strips request-side hop-by-hop headers (and Connection-nominated ones) before forwarding", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    const upstream = await track(
      startServer((req, res) => {
        seen = { ...req.headers };
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }),
    );
    const front = await track(
      startFront({
        kind: "external-rewrite",
        url: new URL(`http://127.0.0.1:${upstream.port}/api`),
      }),
    );

    // Raw client so we can emit hop-by-hop names fetch/undici refuses to send.
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: front.port,
          path: "/api",
          method: "GET",
          headers: {
            te: "trailers",
            // RFC 9110 §7.6.1: Connection nominates x-hop-nominated as
            // connection-scoped — it must not cross the proxy boundary.
            connection: "keep-alive, x-hop-nominated",
            "x-hop-nominated": "secret",
            "x-normal": "keep",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(seen["te"]).toBeUndefined();
    expect(seen["x-hop-nominated"]).toBeUndefined();
    // The upstream sees OUR connection semantics, never the client's raw value.
    expect(seen["connection"]).not.toContain("x-hop-nominated");
    expect(seen["x-normal"]).toBe("keep");
  });

  it("strips hop-by-hop headers from the upstream response", async () => {
    const upstream = await track(
      startServer((_req, res) => {
        res.writeHead(200, {
          "content-type": "text/plain",
          // Distinctive value: Node's front server emits its OWN keep-alive
          // (timeout=5) — only the upstream's must not survive.
          "keep-alive": "timeout=99",
          te: "trailers",
          trailer: "x-checksum",
          upgrade: "websocket",
          "x-should-survive": "yes",
        });
        res.end("ok");
      }),
    );
    const front = await track(
      startFront({
        kind: "external-rewrite",
        url: new URL(`http://127.0.0.1:${upstream.port}/api`),
      }),
    );

    // Node's raw client — fetch hides these header names from Scripts.
    const headers = await new Promise<Record<string, string | string[] | undefined>>(
      (resolve, reject) => {
        const req = httpRequest(
          { hostname: "127.0.0.1", port: front.port, path: "/api", method: "GET" },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.headers));
          },
        );
        req.on("error", reject);
        req.end();
      },
    );

    expect(headers["keep-alive"]).not.toBe("timeout=99");
    expect(headers["te"]).toBeUndefined();
    expect(headers["trailer"]).toBeUndefined();
    expect(headers["upgrade"]).toBeUndefined();
    expect(headers["x-should-survive"]).toBe("yes");
  });
});

describe("cross-pool proxy hardening", () => {
  // proxyToPool dials sanitizeK8sName(`${release}-${pool}-${build}`):3000. Intercept
  // DNS so the synthetic hostname lands on 127.0.0.1, and bind the target on :3000.
  function pinPoolDns() {
    const lookedUp: string[] = [];
    vi.spyOn(dns, "lookup").mockImplementation(((
      hostname: string,
      options: unknown,
      cb?: unknown,
    ) => {
      lookedUp.push(hostname);
      let opts = options as { all?: boolean } | undefined;
      let callback = cb;
      if (typeof options === "function") {
        callback = options;
        opts = {};
      }
      const done = callback as (
        err: NodeJS.ErrnoException | null,
        address: unknown,
        family?: number,
      ) => void;
      queueMicrotask(() => {
        if (opts?.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
        else done(null, "127.0.0.1", 4);
      });
    }) as typeof dns.lookup);
    return lookedUp;
  }

  async function startTargetPool(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    ctx?: { skip: () => void },
  ): Promise<{ port: number }> {
    try {
      const started = await new Promise<{ server: Server; port: number }>((resolve, reject) => {
        const server = createServer(handler);
        server.once("error", reject);
        server.listen(3000, "127.0.0.1", () => {
          servers.push(server);
          resolve({ server, port: 3000 });
        });
      });
      return started;
    } catch {
      // Port 3000 is hardcoded in proxyToPool; if the dev machine is using it,
      // skip rather than fail spuriously.
      ctx?.skip();
      throw new Error("unreachable");
    }
  }

  it("does not let a local dynamic template steal a route assigned to another pool", async (ctx) => {
    pinPoolDns();
    let targetRequests = 0;
    await startTargetPool((_req, res) => {
      targetRequests += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("from-legacy-pool");
    }, ctx);

    const localHandler = vi.fn();
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(localHandler),
      has: vi.fn((pathname: string) => pathname === "/[locale]"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE" }),
    } as any;
    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "legacy",
          matchedPathname: "/legacy",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        {
          releaseName: "rel",
          handlerLoader,
          outputIds: ["/[locale]"],
          localHandlerInvoker: vi.fn(async ({ res }) => {
            res.writeHead(500, { "content-type": "text/plain" });
            res.end("wrong-local-template");
          }),
        },
      ),
    );

    const response = await fetch(`http://127.0.0.1:${front.port}/legacy`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("from-legacy-pool");
    expect(targetRequests).toBe(1);
    expect(localHandler).not.toHaveBeenCalled();
  });

  it("applies resolvedHeaders exactly once — front wrapper only, never re-forwarded", async (ctx) => {
    const lookedUp = pinPoolDns();
    let seenResolvedHeaders: string | undefined;
    await startTargetPool((req, res) => {
      seenResolvedHeaders = req.headers["x-resolved-headers"] as string | undefined;
      // The target pool answers with its OWN cookie — it must survive alongside
      // middleware's, each exactly once.
      res.writeHead(200, { "content-type": "text/plain", "set-cookie": "app=2; Path=/" });
      res.end("from-target-pool");
    }, ctx);

    const resolvedHeaders = new Headers({
      "x-from-next-config": "present",
      "cache-control": "public, max-age=60",
      "set-cookie": "mw=1; Path=/",
    });
    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api", // ≠ front poolName "ssr" → cross-pool proxy
          matchedPathname: "/api/thing",
          routeMatches: null,
          resolvedHeaders,
        },
        { releaseName: "rel", internalSecret: "shared-secret" },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/thing`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("from-target-pool");

    // The verdict is NOT forwarded in the protocol slot: the front pool (which ran
    // the resolve) is the single application point. Forwarding made the target pool
    // merge them too — the client received middleware's Set-Cookie twice.
    expect(seenResolvedHeaders).toBeUndefined();

    // The client response carries the resolved header even though the target never
    // sent it (merged by the front dispatch's writeHead wrapper)...
    expect(res.headers.get("x-from-next-config")).toBe("present");
    // ...and BOTH cookies appear exactly once.
    const cookies = res.headers.getSetCookie();
    expect(cookies.filter((c) => c.startsWith("mw=1"))).toHaveLength(1);
    expect(cookies.filter((c) => c.startsWith("app=2"))).toHaveLength(1);
    expect(cookies).toHaveLength(2);
    // DNS sanity: the pool hostname was sanitized and looked up (the target
    // server's own listen also looks up 127.0.0.1 — find the pool lookup).
    expect(lookedUp).toContain("rel-api-test123");
  });

  it("forwards the rewrite invocation target (x-invoke-path/x-invoke-query)", async (ctx) => {
    pinPoolDns();
    let seenInvokePath: string | undefined;
    let seenInvokeQuery: string | undefined;
    let seenUrl: string | undefined;
    await startTargetPool((req, res) => {
      seenInvokePath = req.headers["x-invoke-path"] as string | undefined;
      seenInvokeQuery = req.headers["x-invoke-query"] as string | undefined;
      seenUrl = req.url;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api", // ≠ front poolName "ssr" → cross-pool proxy
          matchedPathname: "/api/thing",
          routeMatches: null,
          resolvedHeaders: undefined,
          invokePath: "/api/thing?item=one&item=two",
          invocationQuery: { item: ["one", "two"] },
        },
        { releaseName: "rel", internalSecret: "shared-secret" },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/rewrite-source`);
    expect(res.status).toBe(200);
    // The public URL is preserved on the wire while the rewrite target rides the
    // dispatch vocabulary — without it the target pool invokes the handler with the
    // ORIGINAL URL and the rewrite-added (repeated) query params are silently lost.
    expect(seenUrl).toBe("/rewrite-source");
    expect(seenInvokePath).toBe("/api/thing?item=one&item=two");
    expect(JSON.parse(seenInvokeQuery ?? "null")).toEqual({ item: ["one", "two"] });
  });

  it("produces a valid DNS hostname (no trailing hyphen) for over-long names", async (ctx) => {
    const lookedUp = pinPoolDns();
    await startTargetPool((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ctx);

    const longPiece = "p".repeat(50);
    const front = await track(
      startFront(
        {
          kind: "route",
          pool: longPiece,
          matchedPathname: "/x",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        // releaseName + pool + buildId > 63 chars with a hyphen at the cut: the old
        // local sanitizer left a trailing hyphen → invalid hostname → DNS failure.
        { releaseName: `rel-${longPiece}`, buildId: "b".repeat(30) },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/x`);
    expect(res.status).toBe(200);
    const poolHostname = lookedUp.find((h) => h !== "127.0.0.1");
    expect(poolHostname).toBeDefined();
    expect(poolHostname!.length).toBeLessThanOrEqual(63);
    expect(poolHostname!.endsWith("-")).toBe(false);
  });

  it("504s promptly when the target pool exceeds the response-head deadline", async (ctx) => {
    pinPoolDns();
    await startTargetPool(() => {
      // Never respond.
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/thing",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { handlerTimeoutMs: 100 },
      ),
    );

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${front.port}/api/thing`);
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("Gateway Timeout");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("does not let informational responses extend the response-head deadline", async (ctx) => {
    pinPoolDns();
    await startTargetPool((_req, res) => {
      const timer = setInterval(() => res.writeContinue(), 20);
      res.on("close", () => clearInterval(timer));
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/informational",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { handlerTimeoutMs: 100 },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/informational`);
    expect(res.status).toBe(504);
  });

  it("prefers the route deadline over its pool and default deadlines", async (ctx) => {
    pinPoolDns();
    await startTargetPool((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 250);
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/route-budget",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        {
          handlerTimeoutMs: 2_000,
          poolResponseHeadTimeouts: { api: 1_000 },
          routeExecutionTimeouts: { "/api/route-budget": 100 },
        },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/route-budget`);
    expect(res.status).toBe(504);
  });

  it("uses the pool deadline when the route has no maxDuration", async (ctx) => {
    pinPoolDns();
    await startTargetPool((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 250);
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/pool-budget",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { handlerTimeoutMs: 2_000, poolResponseHeadTimeouts: { api: 100 } },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/pool-budget`);
    expect(res.status).toBe(504);
  });

  it("preserves an existing trusted deadline instead of minting a new budget", async (ctx) => {
    pinPoolDns();
    let forwardedDeadline: string | undefined;
    await startTargetPool((req, res) => {
      forwardedDeadline = req.headers["x-adapter-k8s-execution-deadline"] as string | undefined;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("late");
      }, 250);
    }, ctx);

    const deadlineAt = Date.now() + 100;
    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/shared-budget",
          routeMatches: null,
          resolvedHeaders: undefined,
          executionDeadlineAt: deadlineAt,
        },
        { handlerTimeoutMs: 2_000 },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/shared-budget`);
    expect(res.status).toBe(504);
    expect(forwardedDeadline).toBe(String(deadlineAt));
  });

  it("drops a forged content-length on GET before proxying", async (ctx) => {
    pinPoolDns();
    let upstreamContentLength: string | undefined;
    await startTargetPool((req, res) => {
      upstreamContentLength = req.headers["content-length"];
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ctx);

    const front = await track(
      startFront({
        kind: "route",
        pool: "api",
        matchedPathname: "/api/thing",
        routeMatches: null,
        resolvedHeaders: undefined,
      }),
    );

    const response = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("request hung")), 5000);
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: front.port,
          path: "/api/thing",
          method: "GET",
          headers: { "content-length": "100" },
        },
        (res) => {
          res.resume();
          res.on("end", () => {
            clearTimeout(timer);
            resolve(res.statusCode ?? 0);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(response).toBe(200);
    expect(upstreamContentLength).toBeUndefined();
  });

  it("does not kill a streaming response that stalls after its headers", async (ctx) => {
    pinPoolDns();
    // Headers + first chunk arrive promptly, then the stream goes quiet for LONGER
    // than the (short, injected) response-head timeout before finishing. The timeout is an
    // IDLE timeout that used to stay armed mid-stream and destroyed the response —
    // a parity break: the same route served same-pool has no such cap.
    await startTargetPool((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-");
      setTimeout(() => {
        res.end("second");
      }, 600);
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/stream",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { handlerTimeoutMs: 150 },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/stream`);
    expect(res.status).toBe(200);
    // Before the fix the idle timeout destroyed the socket mid-stall and reading
    // the body threw / truncated.
    expect(await res.text()).toBe("first-second");
  });

  it("still bounds the connect/headers phase after the streaming fix", async (ctx) => {
    pinPoolDns();
    await startTargetPool(() => {
      // Accept and never send headers.
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/never",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { handlerTimeoutMs: 100 },
      ),
    );

    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${front.port}/api/never`);
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("strips request-side hop-by-hop headers (and Connection-nominated ones) before proxying", async (ctx) => {
    pinPoolDns();
    let seen: Record<string, string | string[] | undefined> = {};
    await startTargetPool((req, res) => {
      seen = { ...req.headers };
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ctx);

    const front = await track(
      startFront({
        kind: "route",
        pool: "api",
        matchedPathname: "/api/thing",
        routeMatches: null,
        resolvedHeaders: undefined,
      }),
    );

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: front.port,
          path: "/api/thing",
          method: "GET",
          headers: {
            te: "trailers",
            connection: "keep-alive, x-hop-nominated",
            "x-hop-nominated": "secret",
            "x-normal": "keep",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(seen["te"]).toBeUndefined();
    expect(seen["x-hop-nominated"]).toBeUndefined();
    expect(seen["connection"]).not.toContain("x-hop-nominated");
    expect(seen["x-normal"]).toBe("keep");
    // The dispatch protocol headers still ride along.
    expect(seen["x-output-id"]).toBe("/api/thing");
  });

  it("logs a client abort at info level, not as a pool failure", async (ctx) => {
    pinPoolDns();
    let targetSawRequest = false;
    await startTargetPool(() => {
      targetSawRequest = true;
      // Never respond — only the client abort can end this.
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/slow",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
        { proxyTimeoutMs: 30_000 },
      ),
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const socket = (await import("node:net")).createConnection({
      host: "127.0.0.1",
      port: front.port,
    });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(`GET /api/slow HTTP/1.1\r\nHost: 127.0.0.1:${front.port}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 200));
    expect(targetSawRequest).toBe(true);
    socket.destroy();

    // Wait for the abort to propagate and be logged.
    const abortLogged = () =>
      logSpy.mock.calls.some((call) => String(call[0]).includes("client disconnected"));
    for (let i = 0; i < 50 && !abortLogged(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    expect(abortLogged()).toBe(true);
    // The teardown must NOT be reported as a cross-pool failure at error level.
    const failureLogged = errorSpy.mock.calls.some((call) =>
      String(call[0]).includes("cross-pool proxy"),
    );
    expect(failureLogged).toBe(false);
  });
  it("S15: forwards only the dispatch headers this hop asserts", async (ctx) => {
    // `req.headers` is replaced wholesale with middleware's final request-header set before
    // this proxy runs, and the proxied request carries the internal secret — so anything left
    // in the spread arrives at the sibling pool as TRUSTED input. Six of the ten names were
    // overwritten explicitly; `x-resolved-headers` (which the receiving pool merges into the
    // RESPONSE), `x-upstream-pool`, `x-nextjs-ppr` and `x-mw-request-headers` rode through.
    pinPoolDns();
    let seen: Record<string, string | string[] | undefined> = {};
    await startTargetPool((req, res) => {
      seen = { ...req.headers };
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ctx);

    const front = await track(
      startFront(
        {
          kind: "route",
          pool: "api",
          matchedPathname: "/api/thing",
          routeMatches: null,
          // Middleware's final request-header set, with the dispatch vocabulary re-added.
          middlewareRequestHeaders: new Headers({
            "x-resolved-headers": '{"set-cookie":"admin=1"}',
            "x-upstream-pool": "someone-else",
            "x-nextjs-ppr": "1",
            "x-mw-request-headers": '{"cookie":"stolen"}',
          }),
        },
        { releaseName: "rel", internalSecret: "shared-secret" },
      ),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/api/thing`);
    expect(res.status).toBe(200);
    expect(seen["x-resolved-headers"]).toBeUndefined();
    expect(seen["x-upstream-pool"]).toBeUndefined();
    expect(seen["x-nextjs-ppr"]).toBeUndefined();
    expect(seen["x-mw-request-headers"]).toBeUndefined();
    // …while what this hop genuinely asserts still goes, with the secret.
    expect(seen["x-output-id"]).toBe("/api/thing");
    expect(seen["x-mw-evaluated"]).toBe("ran");
    expect(seen["x-internal-secret"]).toBe("shared-secret");
  });
});

describe("loopback handler invocation hardening", () => {
  it("cancels the loopback request when the client disconnects mid-invocation", async () => {
    let handlerSawAbort = false;
    // The handler never responds; its loopback request must be torn down when the
    // outer client goes away (this is the REAL invokeLocalHandlerOverHttp path).
    const handler = vi.fn((innerReq: IncomingMessage, innerRes: ServerResponse) => {
      innerReq.on("close", () => {
        if (!innerRes.writableEnded) handlerSawAbort = true;
      });
      innerRes.on("close", () => {
        if (!innerRes.writableEnded) handlerSawAbort = true;
      });
    });
    const front = await track(
      startServer((req, res) => {
        const dispatcher = createDispatcher({
          handlerLoader: {
            load: vi.fn().mockResolvedValue(handler),
            has: vi.fn().mockReturnValue(true),
            get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
          } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
        });
        void dispatcher
          .dispatch(req, res, {
            kind: "route",
            pool: "ssr",
            matchedPathname: "/slow",
            routeMatches: null,
            resolvedHeaders: undefined,
          })
          .catch(() => undefined);
      }),
    );

    const socket = (await import("node:net")).createConnection({
      host: "127.0.0.1",
      port: front.port,
    });
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(`GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${front.port}\r\n\r\n`);
    // Let the invocation start, then hang up before the handler answers.
    await new Promise((r) => setTimeout(r, 200));
    socket.destroy();

    for (let i = 0; i < 60 && !handlerSawAbort; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(handlerSawAbort).toBe(true);
  });
});

describe("edge route handler stream failure", () => {
  it("504s an edge runner that never returns response headers", async () => {
    const edgeRouteRunner = vi.fn(() => new Promise<never>(() => undefined));
    const front = await track(
      startServer((req, res) => {
        const dispatcher = createDispatcher({
          handlerLoader: {
            load: vi.fn(),
            has: vi.fn().mockReturnValue(true),
            get: vi
              .fn()
              .mockReturnValue({ runtime: "edge", type: "APP_ROUTE", filePath: "edge.js" }),
          } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
          handlerTimeoutMs: 100,
          edgeRouteRunner,
        });
        void dispatcher.dispatch(req, res, {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/edge-never",
          routeMatches: null,
          resolvedHeaders: undefined,
        });
      }),
    );

    const res = await fetch(`http://127.0.0.1:${front.port}/edge-never`);
    expect(res.status).toBe(504);
    expect(await res.text()).toBe("Gateway Timeout");
  });

  it("keeps maxDuration active after an edge response starts streaming", async () => {
    const edgeRouteRunner = vi.fn(async () => ({
      waitUntil: Promise.resolve(),
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            setTimeout(() => controller.close(), 500);
          },
        }),
      ),
    }));
    const front = await track(
      startServer((req, res) => {
        const dispatcher = createDispatcher({
          handlerLoader: {
            load: vi.fn(),
            has: vi.fn().mockReturnValue(true),
            get: vi
              .fn()
              .mockReturnValue({ runtime: "edge", type: "APP_ROUTE", filePath: "edge.js" }),
          } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
          handlerTimeoutMs: 1_000,
          routeExecutionTimeouts: { "/edge-stream": 100 },
          edgeRouteRunner,
        });
        void dispatcher.dispatch(req, res, {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/edge-stream",
          routeMatches: null,
          resolvedHeaders: undefined,
        });
      }),
    );

    const outcome = await fetch(`http://127.0.0.1:${front.port}/edge-stream`)
      .then((res) => res.text())
      .then(() => "completed" as const)
      .catch(() => "reset" as const);
    expect(outcome).toBe("reset");
  });

  it("terminates the response when the edge body stream throws after writeHead", async () => {
    const edgeRouteRunner = vi.fn(async () => ({
      waitUntil: Promise.resolve(),
      response: new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("first-chunk"));
            // Throw AFTER the first chunk is out — headers are already sent.
            controller.error(new Error("edge stream exploded"));
          },
        }),
        { status: 200, headers: { "content-type": "text/plain" } },
      ),
    }));

    const front = await track(
      startServer((req, res) => {
        const dispatcher = createDispatcher({
          handlerLoader: {
            load: vi.fn().mockResolvedValue(vi.fn()),
            has: vi.fn().mockReturnValue(true),
            get: vi
              .fn()
              .mockReturnValue({ runtime: "edge", type: "APP_ROUTE", filePath: "edge.js" }),
          } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
          edgeRouteRunner,
        });
        void dispatcher
          .dispatch(req, res, {
            kind: "route",
            pool: "ssr",
            matchedPathname: "/edge-page",
            routeMatches: null,
            resolvedHeaders: undefined,
          })
          .catch(() => undefined);
      }),
    );

    // The socket is destroyed mid-stream: the client must see a terminated
    // response, not a hang.
    const outcome = await Promise.race([
      fetch(`http://127.0.0.1:${front.port}/edge-page`)
        .then(async (res) => {
          // If we somehow got a response, reading the body must fail (truncated).
          await res.text();
          return "completed" as const;
        })
        .catch(() => "reset" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 5000)),
    ]);

    expect(outcome).not.toBe("hung");
  });
});
