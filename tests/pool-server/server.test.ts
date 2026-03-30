// tests/pool-server/server.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { createPoolServer } from "../../src/pool-server/server.js";
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
  });

  describe("egress — stripping internal response headers", () => {
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
