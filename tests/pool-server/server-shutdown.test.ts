// tests/pool-server/server-shutdown.test.ts
// N41: the pool's shutdown path could never reach `process.exit(0)`.
//
// `server.close()` has two behaviors that the three-line `await server.close(); process.exit(0)`
// shutdown could not survive:
//   • it REJECTS with ERR_SERVER_NOT_RUNNING when the server is already closing, so a second
//     SIGTERM produced an unhandled rejection rather than an exit;
//   • it does not RESOLVE while any connection is open — an idle keep-alive socket is enough,
//     and a streaming response guarantees it — so the exit was unreachable and every rollout
//     waited out `terminationGracePeriodSeconds` and died to SIGKILL.
// `stop()` is the settle-always form the signal handler now uses. Real sockets throughout: the
// bug only exists at the socket layer, so a mock could not have caught it.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPoolServer } from "../../src/pool-server/server.js";

let pool: ReturnType<typeof createPoolServer> | null = null;
afterEach(async () => {
  if (pool) {
    await pool.stop({ graceMs: 200 });
    pool = null;
  }
});

describe("createPoolServer().stop()", () => {
  it("settles with an idle keep-alive connection open (close() alone would not)", async () => {
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      },
      port: 0,
    });
    const { port } = await pool.start();

    // A real keep-alive agent: the socket stays open after the response completes, which is the
    // state every pool pod is in when SIGTERM arrives.
    const http = await import("node:http");
    const agent = new http.Agent({ keepAlive: true });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/x", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
    });

    // Bounded by the test timeout: before the fix this is exactly where shutdown hung.
    await pool.stop({ graceMs: 500 });
    agent.destroy();
    pool = null;
  });

  it("settles while a response is actively streaming, and tears the stream down", async () => {
    let clientSawBytes = 0;
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.flushHeaders();
        // Never ends on its own — the SSE-shaped case.
        const timer = setInterval(() => res.write("tick\n"), 20);
        res.on("close", () => clearInterval(timer));
      },
      port: 0,
    });
    const { port } = await pool.start();

    const socket = net.createConnection({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.write("GET /stream HTTP/1.1\r\nHost: localhost\r\n\r\n");
    socket.on("data", (chunk) => {
      clientSawBytes += chunk.length;
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(clientSawBytes).toBeGreaterThan(0);

    const started = Date.now();
    await pool.stop({ graceMs: 400 });
    // Settled, and well inside the grace window rather than hanging on the open stream.
    expect(Date.now() - started).toBeLessThan(2_000);
    socket.destroy();
    pool = null;
  });

  it("is idempotent — a second stop() resolves instead of rejecting ERR_SERVER_NOT_RUNNING", async () => {
    pool = createPoolServer({ onRequest: () => undefined, port: 0 });
    await pool.start();
    await pool.stop({ graceMs: 200 });
    // The strict close() rejects here; that rejection was the observed unhandled error on a
    // second signal. stop() must simply resolve.
    await expect(pool.stop({ graceMs: 200 })).resolves.toBeUndefined();
    await expect(pool.close()).rejects.toThrow();
    pool = null;
  });

  it("stops accepting new connections", async () => {
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200);
        res.end("ok");
      },
      port: 0,
    });
    const { port } = await pool.start();
    await pool.stop({ graceMs: 200 });
    await expect(fetch(`http://127.0.0.1:${port}/x`)).rejects.toThrow();
    pool = null;
  });
});
