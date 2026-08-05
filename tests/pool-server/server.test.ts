// tests/pool-server/server.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createPoolServer, filterWriteHeadHeadersArg } from "../../src/pool-server/server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

describe("createPoolServer", () => {
  let server: ReturnType<typeof createPoolServer> | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("responds to /healthz with 200", async () => {
    const onRequest = vi.fn();
    server = createPoolServer({ onRequest, port: 0 });
    const address = await server.start();

    const res = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("delegates non-health requests to onRequest", async () => {
    const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200);
      res.end("handled");
    });
    server = createPoolServer({ onRequest, port: 0 });
    const address = await server.start();

    const res = await fetch(`http://127.0.0.1:${address.port}/some-page`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("handled");
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("closes gracefully", async () => {
    const onRequest = vi.fn();
    server = createPoolServer({ onRequest, port: 0 });
    await server.start();
    await server.close();
    server = null; // already closed
  });

  it("survives a client disconnect mid-response (central socket error guard)", async () => {
    const onRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/plain" });
      // Keep writing after the client hangs up — writes to the dead socket emit
      // 'error' on res, which must be swallowed (else the process crashes).
      for (let i = 0; i < 100; i++) {
        res.write(Buffer.alloc(64 * 1024, 65));
        await new Promise((r) => setTimeout(r, 1));
      }
      res.end();
    });
    server = createPoolServer({ onRequest, port: 0 });
    const { port } = await server.start();

    const net = await import("node:net");
    await new Promise<void>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.write(`GET /big HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      });
      socket.once("data", () => {
        socket.destroy();
        resolve();
      });
    });
    // Give the server time to hit the dead socket with more writes.
    await new Promise((r) => setTimeout(r, 300));

    // The process survived and the server keeps serving.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("returns a generic body when onRequest throws (L1: no internals to the client)", async () => {
    const onRequest = vi.fn(() => {
      throw new Error("sensitive internals: /secret/db password");
    });
    server = createPoolServer({ onRequest, port: 0 });
    const address = await server.start();

    const res = await fetch(`http://127.0.0.1:${address.port}/boom`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe("Internal Server Error");
    expect(body).not.toContain("sensitive");
  });

  it("logs only the pathname, never the query string (tokens stay out of logs)", async () => {
    const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200);
      res.end("ok");
    });
    server = createPoolServer({ onRequest, port: 0 });
    const { port } = await server.start();

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await fetch(`http://127.0.0.1:${port}/page?sig=secret-token&x=1`);
      const requestLog = logSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("GET /page"));
      expect(requestLog).toBeDefined();
      expect(requestLog).toContain("GET /page");
      expect(requestLog).not.toContain("sig");
      expect(requestLog).not.toContain("secret-token");
      expect(requestLog).not.toContain("x=1");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("internal header security", () => {
  let server: ReturnType<typeof createPoolServer> | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  describe("ingress — stripping internal request headers", () => {
    const INTERNAL_HEADERS = [
      "x-output-id",
      "x-matched-pathname",
      "x-route-matches",
      "x-upstream-pool",
      // Rewrite invocation target — spoofing these would let a client pick the
      // handler's internal URL/query, so they are secret-gated like the rest.
      "x-invoke-path",
      "x-invoke-query",
    ];

    it("strips internal routing headers by default (untrusted mode)", async () => {
      const seen: Record<string, string | undefined> = {};
      const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        for (const h of INTERNAL_HEADERS) {
          seen[h] = req.headers[h] as string | undefined;
        }
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: {
          "x-output-id": "/admin/secrets",
          "x-matched-pathname": "/admin/secrets",
          "x-route-matches": '{"id":"evil"}',
          "x-upstream-pool": "admin",
          "x-invoke-path": "/admin/secrets?leak=1",
          "x-invoke-query": '{"leak":"1"}',
        },
      });

      expect(onRequest).toHaveBeenCalledTimes(1);
      for (const h of INTERNAL_HEADERS) {
        expect(seen[h]).toBeUndefined();
      }
    });

    it("preserves internal routing headers when trustInternalHeaders is true", async () => {
      const seen: Record<string, string | undefined> = {};
      const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        seen["x-output-id"] = req.headers["x-output-id"] as string | undefined;
        seen["x-upstream-pool"] = req.headers["x-upstream-pool"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0, trustInternalHeaders: true });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: {
          "x-output-id": "/api/data",
          "x-upstream-pool": "api",
        },
      });

      expect(seen["x-output-id"]).toBe("/api/data");
      expect(seen["x-upstream-pool"]).toBe("api");
    });

    it("does not strip non-internal headers", async () => {
      let authHeader: string | undefined;
      const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        authHeader = req.headers["authorization"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: { authorization: "Bearer token123" },
      });

      expect(authHeader).toBe("Bearer token123");
    });

    it("always strips client-supplied Next resume headers on a trusted dispatch hop", async () => {
      let outputId: string | undefined;
      let nextResume: string | undefined;
      let resumeStateLength: string | undefined;
      const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        outputId = req.headers["x-output-id"] as string | undefined;
        nextResume = req.headers["next-resume"] as string | undefined;
        resumeStateLength = req.headers["x-next-resume-state-length"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({
        onRequest,
        port: 0,
        internalSecret: "the-secret",
      });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, {
        method: "POST",
        headers: {
          "x-internal-secret": "the-secret",
          "x-output-id": "/page",
          "next-resume": "1",
          "x-next-resume-state-length": "32",
        },
        body: "attacker-controlled-postponed-state",
      });

      expect(outputId).toBe("/page");
      expect(nextResume).toBeUndefined();
      expect(resumeStateLength).toBeUndefined();
    });

    it("preserves the public Pages Router middleware prefetch hint", async () => {
      let prefetchHeader: string | undefined;
      let privateHeader: string | undefined;
      const onRequest = vi.fn((req: IncomingMessage, res: ServerResponse) => {
        prefetchHeader = req.headers["x-middleware-prefetch"] as string | undefined;
        privateHeader = req.headers["x-middleware-next"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();
      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: { "x-middleware-prefetch": "1", "x-middleware-next": "1" },
      });

      expect(prefetchHeader).toBe("1");
      expect(privateHeader).toBeUndefined();
    });
  });

  describe("ingress — secret-gated trust", () => {
    const DISPATCH_HEADERS = {
      "x-output-id": "/admin/action",
      "x-upstream-pool": "admin",
      "x-internal-secret": "the-secret",
    };

    function seeingServer(seen: Record<string, string | undefined>) {
      return vi.fn((req: IncomingMessage, res: ServerResponse) => {
        seen["x-output-id"] = req.headers["x-output-id"] as string | undefined;
        seen["x-internal-secret"] = req.headers["x-internal-secret"] as string | undefined;
        res.writeHead(200);
        res.end("ok");
      });
    }

    it("trusts dispatch headers when the secret matches", async () => {
      const seen: Record<string, string | undefined> = {};
      server = createPoolServer({
        onRequest: seeingServer(seen),
        port: 0,
        internalSecret: "the-secret",
      });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, { headers: DISPATCH_HEADERS });

      expect(seen["x-output-id"]).toBe("/admin/action");
      // The secret itself must never reach the handler.
      expect(seen["x-internal-secret"]).toBeUndefined();
    });

    it("RED TEAM: strips a spoofed x-output-id when no/invalid secret is presented (secret configured)", async () => {
      const seen: Record<string, string | undefined> = {};
      server = createPoolServer({
        onRequest: seeingServer(seen),
        port: 0,
        internalSecret: "the-secret",
      });
      const { port } = await server.start();

      // Attacker knows the dispatch protocol but not the secret.
      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: { "x-output-id": "/admin/action", "x-internal-secret": "wrong-guess" },
      });

      // Dispatch header stripped → pool falls to Phase-1 resolution (runs middleware), not a
      // direct handler dispatch that would bypass middleware auth.
      expect(seen["x-output-id"]).toBeUndefined();
    });

    it("RED TEAM: a matching secret alone does NOT let trustInternalHeaders be bypassed when unset", async () => {
      // With a secret configured, trustInternalHeaders is irrelevant — trust is secret-only.
      const seen: Record<string, string | undefined> = {};
      server = createPoolServer({
        onRequest: seeingServer(seen),
        port: 0,
        internalSecret: "the-secret",
        trustInternalHeaders: false,
      });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, { headers: DISPATCH_HEADERS });
      expect(seen["x-output-id"]).toBe("/admin/action");
    });

    it("always strips x-internal-secret even in legacy trustInternalHeaders mode (no secret configured)", async () => {
      const seen: Record<string, string | undefined> = {};
      server = createPoolServer({
        onRequest: seeingServer(seen),
        port: 0,
        trustInternalHeaders: true,
      });
      const { port } = await server.start();

      await fetch(`http://127.0.0.1:${port}/page`, {
        headers: { "x-output-id": "/api/data", "x-internal-secret": "anything" },
      });

      expect(seen["x-output-id"]).toBe("/api/data"); // trusted via legacy flag
      expect(seen["x-internal-secret"]).toBeUndefined(); // secret never forwarded
    });
  });

  describe("egress — stripping internal response headers", () => {
    it("preserves the public Pages Router middleware prefetch response", async () => {
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("x-middleware-skip", "1");
        res.setHeader("x-middleware-next", "1");
        res.writeHead(200);
        res.end("{}");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();
      const res = await fetch(`http://127.0.0.1:${port}/page`);

      expect(res.headers.get("x-middleware-skip")).toBe("1");
      expect(res.headers.has("x-middleware-next")).toBe(false);
    });

    it("strips x-middleware-* headers from responses", async () => {
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("x-middleware-next", "1");
        res.setHeader("x-middleware-rewrite", "http://internal/path");
        res.setHeader("x-middleware-refresh", "1");
        res.setHeader("x-middleware-override-headers", "cookie,authorization");
        res.setHeader("x-middleware-set-cookie", "session=abc; Path=/");
        res.setHeader("x-middleware-request-authorization", "Bearer internal");
        res.setHeader("content-type", "text/plain");
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.status).toBe(200);

      expect(res.headers.has("x-middleware-next")).toBe(false);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
      expect(res.headers.has("x-middleware-refresh")).toBe(false);
      expect(res.headers.has("x-middleware-override-headers")).toBe(false);
      expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
      expect(res.headers.has("x-middleware-request-authorization")).toBe(false);
      // Non-internal headers pass through
      expect(res.headers.get("content-type")).toBe("text/plain");
    });

    it("preserves set-cookie while stripping x-middleware-set-cookie", async () => {
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("set-cookie", "session=abc; Path=/");
        res.setHeader("x-middleware-set-cookie", "session=abc; Path=/");
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.headers.get("set-cookie")).toBe("session=abc; Path=/");
      expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
    });

    it("strips internal headers passed via the writeHead(status, headers) argument", async () => {
      // Real paths pass headers as the writeHead argument, which never enters the
      // setHeader-map — the wrapper must strip them from the object too.
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          "x-middleware-next": "1",
          "x-middleware-rewrite": "http://internal/path",
          "x-middleware-set-cookie": "session=abc; Path=/",
          "x-middleware-request-authorization": "Bearer internal",
          "x-middleware-anything-else": "leak",
          "content-type": "text/plain",
        });
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.status).toBe(200);
      expect(res.headers.has("x-middleware-next")).toBe(false);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
      expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
      expect(res.headers.has("x-middleware-request-authorization")).toBe(false);
      expect(res.headers.has("x-middleware-anything-else")).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/plain");
    });

    it("strips internal headers passed via writeHead(status, statusMessage, headers)", async () => {
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, "OK", {
          "x-middleware-rewrite": "http://internal/path",
          "content-type": "text/plain",
        });
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/plain");
    });

    it("strips internal headers passed via the array form of writeHead", async () => {
      // writeHead(status, [[name, value], ...]) bypassed the object-map strip —
      // internal headers must be filtered from the array form too.
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, [
          ["x-middleware-rewrite", "http://internal/path"],
          ["x-middleware-set-cookie", "session=abc; Path=/"],
          ["content-type", "text/plain"],
        ]);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.status).toBe(200);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
      expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/plain");
    });

    it("strips internal headers passed via the FLAT array form of writeHead", async () => {
      // Node also accepts writeHead(status, [name1, value1, name2, value2]) — the
      // rawHeaders layout. The tuple-only filter took String(entry[0]) — the first
      // CHARACTER of the header name — so nothing matched and internal headers
      // leaked to the client (verified).
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, [
          "x-middleware-rewrite",
          "http://internal/x",
          "x-middleware-set-cookie",
          "session=abc; Path=/",
          "content-type",
          "text/plain",
          "x-should-survive",
          "yes",
        ] as unknown as Parameters<typeof res.writeHead>[1]);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0 });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.status).toBe(200);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
      expect(res.headers.has("x-middleware-set-cookie")).toBe(false);
      expect(res.headers.get("content-type")).toBe("text/plain");
      expect(res.headers.get("x-should-survive")).toBe("yes");
    });

    it("strips response headers regardless of trustInternalHeaders setting", async () => {
      const onRequest = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("x-middleware-next", "1");
        res.setHeader("x-middleware-rewrite", "http://internal/path");
        res.writeHead(200);
        res.end("ok");
      });

      server = createPoolServer({ onRequest, port: 0, trustInternalHeaders: true });
      const { port } = await server.start();

      const res = await fetch(`http://127.0.0.1:${port}/page`);
      expect(res.headers.has("x-middleware-next")).toBe(false);
      expect(res.headers.has("x-middleware-rewrite")).toBe(false);
    });
  });
});

describe("filterWriteHeadHeadersArg", () => {
  // Shared by server.ts's internal-header strip and index.ts's forced cache-policy
  // wrapper — pin every headers shape Node's writeHead accepts.
  const banned = (name: string) => name.toLowerCase() === "x-banned";

  it("filters the object form in place", () => {
    const obj = { "x-banned": "1", "X-Banned": "2", keep: "yes" };
    const result = filterWriteHeadHeadersArg(obj, banned) as Record<string, string>;
    expect(result).toEqual({ keep: "yes" });
  });

  it("filters the tuple-array form", () => {
    const result = filterWriteHeadHeadersArg(
      [
        ["x-banned", "1"],
        ["keep", "yes"],
      ],
      banned,
    );
    expect(result).toEqual([["keep", "yes"]]);
  });

  it("filters the FLAT array form pairwise (name/value pairs, not tuples)", () => {
    const result = filterWriteHeadHeadersArg(
      ["x-banned", "1", "keep", "yes", "X-BANNED", "2", "also-keep", "sure"],
      banned,
    );
    expect(result).toEqual(["keep", "yes", "also-keep", "sure"]);
  });

  it("leaves non-object arguments untouched", () => {
    expect(filterWriteHeadHeadersArg(undefined, banned)).toBeUndefined();
    expect(filterWriteHeadHeadersArg("OK", banned)).toBe("OK");
  });
});
