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
