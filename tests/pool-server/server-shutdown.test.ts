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
import { get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
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

  it("lets a finite stream finish after the old halfway cutoff", async () => {
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.flushHeaders();
        res.write("first\n");
        // With graceMs=500 the former halfway close fired at 250ms and truncated this response.
        setTimeout(() => res.end("last\n"), 350);
      },
      port: 0,
    });
    const { port } = await pool.start();

    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => (responseStarted = resolve));
    const body = new Promise<string>((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port, path: "/finite" }, (res) => {
        let value = "";
        responseStarted();
        res.on("data", (chunk) => (value += String(chunk)));
        res.on("end", () => resolve(value));
        res.on("aborted", () => reject(new Error("finite response aborted")));
        res.on("error", reject);
      }).on("error", reject);
    });
    await started;

    const drain = pool.stop({ graceMs: 500 });
    await expect(body).resolves.toBe("first\nlast\n");
    await drain;
    pool = null;
  });

  it("keeps SSE open for the full grace window, then ends it cleanly", async () => {
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
        res.flushHeaders();
        const timer = setInterval(() => res.write(": heartbeat\n\n"), 20);
        res.on("close", () => clearInterval(timer));
      },
      port: 0,
    });
    const { port } = await pool.start();

    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => (responseStarted = resolve));
    let clientSawBytes = 0;
    const ended = new Promise<void>((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port, path: "/events" }, (res) => {
        responseStarted();
        res.on("data", (chunk) => (clientSawBytes += chunk.length));
        res.on("end", resolve);
        res.on("aborted", () => reject(new Error("SSE response aborted")));
        res.on("error", reject);
      }).on("error", reject);
    });
    await started;

    const drainStartedAt = Date.now();
    const drain = pool.stop({ graceMs: 300 });
    await ended;
    expect(Date.now() - drainStartedAt).toBeGreaterThanOrEqual(260);
    expect(clientSawBytes).toBeGreaterThan(0);
    await drain;
    pool = null;
  });

  it("resets an unfinished finite body at the deadline instead of authenticating truncation", async () => {
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write("partial-body");
        // Never finishes: a normal res.end() during drain would make the client accept these bytes
        // as the complete representation even though the handler promised more.
      },
      port: 0,
    });
    const { port } = await pool.start();

    let responseStarted!: () => void;
    const started = new Promise<void>((resolve) => (responseStarted = resolve));
    const aborted = new Promise<boolean>((resolve, reject) => {
      httpGet({ host: "127.0.0.1", port, path: "/finite-never-ends" }, (res) => {
        responseStarted();
        res.on("data", () => undefined);
        res.on("aborted", () => resolve(true));
        res.on("end", () => resolve(false));
        res.on("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(true);
          else reject(error);
        });
      }).on("error", reject);
    });
    await started;

    const drainStartedAt = Date.now();
    const drain = pool.stop({ graceMs: 180 });
    await expect(aborted).resolves.toBe(true);
    expect(Date.now() - drainStartedAt).toBeGreaterThanOrEqual(150);
    await drain;
    pool = null;
  });

  it("rejects pipelined work that arrives on an existing connection after drain starts", async () => {
    let firstResponse!: ServerResponse;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    let requestCount = 0;
    pool = createPoolServer({
      onRequest: (_req: IncomingMessage, res: ServerResponse) => {
        requestCount += 1;
        if (requestCount === 1) {
          firstResponse = res;
          res.writeHead(200, { "content-type": "text/plain" });
          res.write("first");
          firstStarted();
          return;
        }
        res.end("application handled second request");
      },
      port: 0,
    });
    const { port } = await pool.start();

    const socket = net.createConnection({ host: "127.0.0.1", port });
    let received = "";
    socket.on("data", (chunk) => (received += chunk.toString("latin1")));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET /one HTTP/1.1\r\nHost: localhost\r\n\r\n");
    await started;

    const drain = pool.stop({ graceMs: 250 });
    socket.write("GET /two HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    firstResponse.end();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await drain;

    expect(requestCount).toBe(1);
    expect(received).toContain("503 Service Unavailable");
    expect(received.toLowerCase()).toContain("retry-after: 1");
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
