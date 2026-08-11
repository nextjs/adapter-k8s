import { createServer } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleWebSocketUpgrade } from "../../src/pool-server/websocket-upgrade.js";

function captureSocket() {
  const socket = new PassThrough();
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return {
    socket,
    text: () => Buffer.concat(chunks).toString("latin1"),
  };
}

class NetworkLikeSocket extends Duplex {
  readonly writes: Buffer[] = [];

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }

  receive(chunk: Buffer | string) {
    this.push(chunk);
  }

  text() {
    return Buffer.concat(this.writes).toString("latin1");
  }
}

function request(url = "/rooms/alpha?existing=1", headers: Record<string, string> = {}) {
  return {
    method: "GET",
    url,
    headers: {
      host: "example.com",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      ...headers,
    },
  } as any;
}

function dependencies(
  options: {
    resolution?: Record<string, unknown>;
    upgradeHandler?: ((...args: any[]) => unknown) | undefined;
    runtime?: "nodejs" | "edge";
    handshakeTimeoutMs?: number;
  } = {},
) {
  const resolution = {
    kind: "route",
    pool: "default",
    matchedPathname: "/rooms/[room]",
    routeMatches: { room: "alpha" },
    resolvedHeaders: undefined,
    ...options.resolution,
  };
  const resolve = vi.fn(async () => resolution as any);
  const handlerLoader = {
    has: vi.fn(() => true),
    get: vi.fn(() => ({ runtime: options.runtime ?? "nodejs" })),
    loadUpgrade: vi.fn(async () => options.upgradeHandler),
  } as any;
  return {
    deps: {
      resolve,
      handlerLoader,
      poolName: "default",
      releaseName: "app",
      buildId: "b1",
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    } as any,
    resolve,
    handlerLoader,
  };
}

describe("handleWebSocketUpgrade", () => {
  it("invokes Next's generated entrypoint once with raw primitives and request metadata", async () => {
    const upgradeHandler = vi.fn(async () => undefined);
    const { deps } = dependencies({ upgradeHandler });
    const req = request(undefined, { "x-forwarded-proto": "https" });
    const { socket } = captureSocket();
    const head = Buffer.from("early-frame");

    await expect(handleWebSocketUpgrade(deps, req, socket, head)).resolves.toBe("accepted");

    expect(upgradeHandler).toHaveBeenCalledOnce();
    const [context, transport] = upgradeHandler.mock.calls[0]!;
    expect(transport).toEqual({ node: { req, socket, head } });
    expect(context.requestMeta).toMatchObject({
      minimalMode: true,
      outputId: "/rooms/[room]",
      matchedPathname: "/rooms/[room]",
      resolvedPathname: "/rooms/alpha",
      initURL: "https://example.com/rooms/alpha?existing=1",
      params: { room: "alpha" },
    });
    socket.destroy();
  });

  it("reuses a trusted phase-two verdict and does not execute middleware/routing twice", async () => {
    const upgradeHandler = vi.fn(async (_context, { node }) => {
      expect(node.req.headers["x-authenticated-user"]).toBe("david");
      expect(node.req.headers["x-output-id"]).toBeUndefined();
      expect(node.req.headers["x-mw-request-headers"]).toBeUndefined();
    });
    const { deps, resolve } = dependencies({ upgradeHandler });
    const req = request("/socket", {
      "x-output-id": "/rooms/[room]",
      "x-upstream-pool": "default",
      "x-route-matches": JSON.stringify({ room: "alpha" }),
      "x-mw-evaluated": "ran",
      "x-mw-request-headers": JSON.stringify({
        host: "example.com",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
        "x-authenticated-user": "david",
      }),
    });
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0))).resolves.toBe(
      "accepted",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(upgradeHandler).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it("falls back to local routing when an upstream middleware verdict is incomplete", async () => {
    const upgradeHandler = vi.fn(async () => undefined);
    const { deps, resolve } = dependencies({ upgradeHandler });
    const req = request("/rooms/alpha", {
      "x-output-id": "/forged",
      "x-mw-evaluated": "error",
    });
    const { socket } = captureSocket();

    await handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0));
    expect(resolve).toHaveBeenCalledOnce();
    expect(req.headers["x-output-id"]).toBeUndefined();
    socket.destroy();
  });

  it("flushes 426 for an ordinary HTTP-only route", async () => {
    const { deps } = dependencies({ upgradeHandler: undefined });
    const { socket, text } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).resolves.toBe(
      "rejected",
    );
    expect(text()).toContain("HTTP/1.1 426 Upgrade Required");
    expect(text()).toContain("upgrade: websocket");
  });

  it("rejects non-WebSocket upgrades before routing", async () => {
    const upgradeHandler = vi.fn();
    const { deps, resolve } = dependencies({ upgradeHandler });
    const req = request();
    req.headers.upgrade = "h2c";
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0));
    expect(text()).toContain("HTTP/1.1 426 Upgrade Required");
    expect(resolve).not.toHaveBeenCalled();
    expect(upgradeHandler).not.toHaveBeenCalled();
  });

  it("relays a bounded middleware rejection with cookies but no internal headers", async () => {
    const headers = new Headers({
      "content-type": "text/plain",
      "x-middleware-rewrite": "/private",
      "x-visible": "yes",
    });
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    const { deps } = dependencies({
      resolution: {
        kind: "middleware-response",
        response: new Response("denied", { status: 401, headers }),
      },
    });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0));
    expect(text()).toContain("HTTP/1.1 401 Unauthorized");
    expect(text()).toContain("denied");
    expect(text()).toContain("x-visible: yes");
    expect(text()).toContain("set-cookie: a=1; Path=/");
    expect(text()).toContain("set-cookie: b=2; Path=/");
    expect(text()).not.toContain("x-middleware-rewrite");
  });

  it("rejects Edge outputs before attempting a raw Node upgrade", async () => {
    const upgradeHandler = vi.fn();
    const { deps, handlerLoader } = dependencies({ runtime: "edge", upgradeHandler });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0));
    expect(text()).toContain("HTTP/1.1 501 Not Implemented");
    expect(handlerLoader.loadUpgrade).not.toHaveBeenCalled();
  });

  it("tunnels a wrong-pool handshake with asserted headers, repeated cookies, and early data", async () => {
    let siblingSocket: Duplex | undefined;
    let siblingHeaders: Record<string, string | string[] | undefined> | undefined;
    const fromClient: Buffer[] = [];
    const sibling = createServer();
    sibling.on("upgrade", (req, socket) => {
      siblingSocket = socket;
      siblingHeaders = { ...req.headers };
      socket.on("data", (chunk) => fromClient.push(Buffer.from(chunk)));
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Set-Cookie: a=1; Path=/\r\nSet-Cookie: b=2; Path=/\r\n\r\nwelcome",
      );
    });
    await new Promise<void>((resolve) => sibling.listen(0, "127.0.0.1", resolve));
    const address = sibling.address();
    if (!address || typeof address === "string") throw new Error("missing test server address");

    const middlewareHeaders = new Headers({
      host: "example.com",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "x-authenticated-user": "david",
    });
    const { deps } = dependencies({
      resolution: {
        pool: "chat",
        middlewareRequestHeaders: middlewareHeaders,
        invokePath: "/rooms/alpha?joined=1",
        invocationQuery: { joined: "1" },
      },
    });
    deps.internalSecret = "internal-secret";
    deps.resolvePoolEndpoint = () => ({ hostname: "127.0.0.1", port: address.port });
    const socket = new NetworkLikeSocket();
    const earlyFrame = Buffer.from([0x81, 0x00]);

    try {
      await expect(handleWebSocketUpgrade(deps, request(), socket, earlyFrame)).resolves.toBe(
        "accepted",
      );
      expect(siblingHeaders?.["x-output-id"]).toBe("/rooms/[room]");
      expect(siblingHeaders?.["x-mw-evaluated"]).toBe("ran");
      expect(siblingHeaders?.["x-internal-secret"]).toBe("internal-secret");
      expect(siblingHeaders?.["x-authenticated-user"]).toBe("david");
      expect(siblingHeaders?.["x-invoke-query"]).toBe(JSON.stringify({ joined: "1" }));
      expect(socket.text()).toContain("101 Switching Protocols");
      expect(socket.text().toLowerCase()).toContain("set-cookie: a=1; path=/");
      expect(socket.text().toLowerCase()).toContain("set-cookie: b=2; path=/");
      expect(socket.text()).toContain("welcome");

      socket.receive(Buffer.from("client-frame"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(Buffer.concat(fromClient)).toEqual(
        Buffer.concat([earlyFrame, Buffer.from("client-frame")]),
      );
    } finally {
      socket.destroy();
      siblingSocket?.destroy();
      await new Promise<void>((resolve) => sibling.close(() => resolve()));
    }
  });

  it("bounds a generated handler that never finishes accepting", async () => {
    const upgradeHandler = vi.fn(() => new Promise(() => undefined));
    const { deps } = dependencies({ upgradeHandler, handshakeTimeoutMs: 20 });
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).rejects.toThrow(
      /handshake deadline/,
    );
    socket.destroy();
  });

  it("bounds local route resolution before a module is selected", async () => {
    const { deps, resolve, handlerLoader } = dependencies({ handshakeTimeoutMs: 20 });
    resolve.mockImplementation(() => new Promise(() => undefined));
    const { socket, text } = captureSocket();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).resolves.toBe(
        "rejected",
      );
      expect(text()).toContain("HTTP/1.1 504 Gateway Timeout");
      expect(handlerLoader.loadUpgrade).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
