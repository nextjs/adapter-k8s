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
import { INTERNAL_DISPATCH_PROOF_HEADER } from "../../src/routing-common.js";
import { signDispatch } from "../helpers/dispatch-proof.js";

let pool: ReturnType<typeof createPoolServer> | null = null;
afterEach(async () => {
  if (pool) {
    await pool.stop({ graceMs: 200 });
    pool = null;
  }
});

describe("createPoolServer().stop()", () => {
  it("tracks upgraded sockets and closes them with WebSocket 1001 after the grace window", async () => {
    pool = createPoolServer({
      onRequest: () => undefined,
      onUpgrade: (_req, socket) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        );
        return "accepted";
      },
      port: 0,
    });
    const { port } = await pool.start();
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(
      "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n" +
        "Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));

    await pool.stop({ graceMs: 80 });
    const received = Buffer.concat(chunks);
    expect(received.toString("latin1")).toContain("101 Switching Protocols");
    expect(received.subarray(-4)).toEqual(Buffer.from([0x88, 0x02, 0x03, 0xe9]));
    socket.destroy();
    pool = null;
  });

  it("applies the same proof-gated request boundary to upgrade traffic", async () => {
    const seen: Array<Record<string, string | string[] | undefined>> = [];
    pool = createPoolServer({
      onRequest: () => undefined,
      onUpgrade: (req, socket) => {
        seen.push({ ...req.headers });
        socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
        return "rejected";
      },
      internalSecret: "correct-secret",
      port: 0,
    });
    const { port } = await pool.start();

    const send = (proof: string) =>
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.write(
            "GET /socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\n" +
              "Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
              "Sec-WebSocket-Version: 13\r\nX-Output-Id: /admin\r\n" +
              `X-Internal-Dispatch-Proof: ${proof}\r\n\r\n`,
          );
        });
        socket.on("data", () => undefined);
        socket.once("close", () => resolve());
        socket.once("error", reject);
      });

    const signed = signDispatch(
      "correct-secret",
      "GET",
      "/socket",
      { "x-output-id": "/admin" },
      { authority: "localhost" },
    );
    await send("invalid-proof");
    await send(signed[INTERNAL_DISPATCH_PROOF_HEADER]!);
    expect(seen[0]?.["x-output-id"]).toBeUndefined();
    expect(seen[1]?.["x-output-id"]).toBe("/admin");
    expect(seen[0]?.[INTERNAL_DISPATCH_PROOF_HEADER]).toBeUndefined();
    expect(seen[1]?.[INTERNAL_DISPATCH_PROOF_HEADER]).toBeUndefined();
  });

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
