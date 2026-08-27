import { createServer } from "node:http";
import { Duplex, PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleWebSocketUpgrade } from "../../src/pool-server/websocket-upgrade.js";
import { INTERNAL_DISPATCH_PROOF_HEADER, verifyDispatchProof } from "../../src/routing-common.js";

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
  const requestHeaders = {
    host: "example.com",
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    "sec-websocket-version": "13",
    ...headers,
  };
  return {
    method: "GET",
    httpVersion: "1.1",
    url,
    headers: requestHeaders,
    rawHeaders: Object.entries(requestHeaders).flatMap(([name, value]) => [name, value]),
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
    get: vi.fn(() => ({ runtime: options.runtime ?? "nodejs", type: "APP_ROUTE" })),
    loadUpgrade: vi.fn(async () => options.upgradeHandler),
  } as any;
  return {
    deps: {
      resolve,
      handlerLoader,
      poolName: "default",
      releaseName: "app",
      buildId: "b1",
      webSocketRegistryScope: {},
      parseWebSocketExtensions(value: string) {
        if (value === "permessage-deflate; =") throw new SyntaxError("invalid extension");
        return {};
      },
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    } as any,
    resolve,
    handlerLoader,
  };
}

describe("handleWebSocketUpgrade", () => {
  it("invokes Next's generated entrypoint once with raw primitives and request metadata", async () => {
    const upgradeHandler = vi.fn(async () => ({ upgraded: true, statusCode: 101 }));
    const { deps } = dependencies({ upgradeHandler });
    const req = request(undefined, { "x-forwarded-proto": "https" });
    const { socket } = captureSocket();
    const head = Buffer.from("early-frame");

    await expect(handleWebSocketUpgrade(deps, req, socket, head)).resolves.toBe("accepted-local");

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

  it("supplies Next's generated lifecycle scope, routing headers, and outcome contract", async () => {
    const resolvedHeaders = new Headers({ "x-route-header": "present" });
    resolvedHeaders.append("set-cookie", "route-a=1; Path=/");
    resolvedHeaders.append("set-cookie", "route-b=2; Path=/");
    const upgradeHandler = vi.fn(async (context, { node }) => {
      const metadata = (node.req as any)[Symbol.for("NextInternalRequestMeta")];
      expect(metadata.webSocketRegistryScope).toBe(deps.webSocketRegistryScope);
      expect(context.responseHeaders).toEqual({
        "set-cookie": ["route-a=1; Path=/", "route-b=2; Path=/"],
        "x-route-header": "present",
      });
      return { upgraded: false, statusCode: 401 };
    });
    const { deps } = dependencies({
      upgradeHandler,
      resolution: { resolvedHeaders },
    });
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).resolves.toBe(
      "rejected",
    );
    expect(upgradeHandler).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it("fails closed when a generated handler returns a malformed outcome", async () => {
    const { deps } = dependencies({ upgradeHandler: async () => undefined });
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).rejects.toThrow(
      /invalid upgrade outcome/,
    );
    socket.destroy();
  });

  it("reuses a trusted phase-two verdict and does not execute middleware/routing twice", async () => {
    const upgradeHandler = vi.fn(async (_context, { node }) => {
      expect(node.req.headers["x-authenticated-user"]).toBe("david");
      expect(node.req.headers["x-output-id"]).toBeUndefined();
      expect(node.req.headers["x-mw-request-headers"]).toBeUndefined();
      return { upgraded: true, statusCode: 101 };
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
      "accepted-local",
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(upgradeHandler).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it("falls back to local routing when an upstream middleware verdict is incomplete", async () => {
    const upgradeHandler = vi.fn(async () => ({ upgraded: true, statusCode: 101 }));
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

  it("falls back to local routing when trusted dispatch metadata is malformed", async () => {
    const upgradeHandler = vi.fn(async () => ({ upgraded: true, statusCode: 101 }));
    const { deps, resolve } = dependencies({ upgradeHandler });
    const req = request("/rooms/alpha", {
      "x-output-id": "/rooms/[room]",
      "x-mw-evaluated": "ran",
      "x-mw-request-headers": JSON.stringify({ authorization: [123] }),
    });
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0))).resolves.toBe(
      "accepted-local",
    );
    expect(resolve).toHaveBeenCalledOnce();
    expect(req.headers["x-mw-request-headers"]).toBeUndefined();
    socket.destroy();
  });

  it("returns 404 when an App Route has no generated upgrade entrypoint", async () => {
    const { deps } = dependencies({ upgradeHandler: undefined });
    const { socket, text } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).resolves.toBe(
      "rejected",
    );
    expect(text()).toContain("HTTP/1.1 404 Not Found");
    expect(text()).toContain("Not Found");
    expect(text()).toContain("cache-control: private, no-cache, no-store");
  });

  it("rejects non-WebSocket upgrades before routing", async () => {
    const upgradeHandler = vi.fn();
    const { deps, resolve } = dependencies({ upgradeHandler });
    const req = request(undefined, { upgrade: "h2c" });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0));
    expect(text()).toContain("HTTP/1.1 426 Upgrade Required");
    expect(resolve).not.toHaveBeenCalled();
    expect(upgradeHandler).not.toHaveBeenCalled();
  });

  it("rejects malformed handshake fields before middleware or route resolution", async () => {
    for (const [headers, status, message] of [
      [{ "sec-websocket-key": "invalid" }, 400, "Invalid Sec-WebSocket-Key header."],
      [{ "sec-websocket-version": "12" }, 426, "Unsupported WebSocket version."],
      [{ "sec-websocket-protocol": "chat, chat" }, 400, "Invalid Sec-WebSocket-Protocol header."],
      [
        { "sec-websocket-extensions": "permessage-deflate; =" },
        400,
        "Invalid Sec-WebSocket-Extensions header.",
      ],
    ] as const) {
      const { deps, resolve } = dependencies({
        upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
      });
      const { socket, text } = captureSocket();

      await handleWebSocketUpgrade(deps, request(undefined, headers), socket, Buffer.alloc(0));

      expect(text()).toContain(`HTTP/1.1 ${status}`);
      expect(text()).toContain(message);
      expect(resolve).not.toHaveBeenCalled();
    }
  });

  // N89. `next/dist/compiled/ws` exports only the transport classes, so `extension.parse` is
  // undefined on every Next release the adapter has shipped against. Throwing then rejected the
  // upgrade promise, whose handler in createPoolServer destroyed the socket without writing a
  // byte — every browser handshake (they all offer permessage-deflate) died with no HTTP status.
  it("completes a browser handshake when the pinned extension parser is unavailable", async () => {
    const upgradeHandler = vi.fn(async () => ({ upgraded: true, statusCode: 101 }));
    const { deps, resolve } = dependencies({ upgradeHandler });
    deps.parseWebSocketExtensions = undefined;
    const { socket, text } = captureSocket();

    await expect(
      handleWebSocketUpgrade(
        deps,
        request(undefined, {
          "sec-websocket-extensions": "permessage-deflate; client_max_window_bits",
        }),
        socket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe("accepted-local");
    expect(resolve).toHaveBeenCalledOnce();
    expect(upgradeHandler).toHaveBeenCalledOnce();
    // Nothing is written by the adapter: the generated entrypoint owns the 101 and the extension
    // negotiation, exactly as it does for a handshake with no extensions offered at all.
    expect(text()).toBe("");
    socket.destroy();
  });

  it("still uses the pinned parser to reject a malformed extension offer when it exists", async () => {
    const parseWebSocketExtensions = vi.fn((value: string) => {
      if (value === "permessage-deflate; =") throw new SyntaxError("invalid extension");
      return {};
    });
    const { deps, resolve } = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    deps.parseWebSocketExtensions = parseWebSocketExtensions;
    const { socket, text } = captureSocket();

    await expect(
      handleWebSocketUpgrade(
        deps,
        request(undefined, { "sec-websocket-extensions": "permessage-deflate; =" }),
        socket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe("rejected");
    expect(parseWebSocketExtensions).toHaveBeenCalledWith("permessage-deflate; =");
    expect(text()).toContain("HTTP/1.1 400");
    expect(text()).toContain("Invalid Sec-WebSocket-Extensions header.");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("enforces same-origin and configured cross-origin policy before routing", async () => {
    const denied = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    const deniedSocket = captureSocket();
    await handleWebSocketUpgrade(
      denied.deps,
      request(undefined, { origin: "https://attacker.example" }),
      deniedSocket.socket,
      Buffer.alloc(0),
    );
    expect(deniedSocket.text()).toContain("HTTP/1.1 403 Forbidden");
    expect(deniedSocket.text()).toContain("WebSocket origin is not allowed.");
    expect(denied.resolve).not.toHaveBeenCalled();

    const accepted = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    accepted.deps.webSocketAllowedOrigins = ["https://client.example"];
    const acceptedSocket = captureSocket();
    await expect(
      handleWebSocketUpgrade(
        accepted.deps,
        request(undefined, { origin: "https://client.example" }),
        acceptedSocket.socket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe("accepted-local");
    expect(accepted.resolve).toHaveBeenCalledOnce();
    acceptedSocket.socket.destroy();
  });

  it("treats a wss handshake behind the TLS-terminating load balancer as same-origin", async () => {
    // TLS terminates at the load balancer, so the pool's socket is plain http even though the
    // browser dialled wss:// against an https site. The same-origin authority must come from the
    // validated x-forwarded-proto witness — otherwise every https app would need to list itself
    // in webSocketRouteHandlers.allowedOrigins.
    const sameOrigin = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    const sameOriginReq = request(undefined, {
      "x-forwarded-proto": "https",
      origin: "https://example.com",
    });
    sameOriginReq.socket = { encrypted: false };
    const sameOriginSocket = captureSocket();
    await expect(
      handleWebSocketUpgrade(
        sameOrigin.deps,
        sameOriginReq,
        sameOriginSocket.socket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe("accepted-local");
    expect(sameOrigin.deps.webSocketAllowedOrigins).toBeUndefined();
    expect(sameOrigin.resolve).toHaveBeenCalledOnce();
    sameOriginSocket.socket.destroy();

    // The forwarded witness only fixes the scheme — a genuinely different origin is still denied.
    const crossOrigin = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    const crossOriginReq = request(undefined, {
      "x-forwarded-proto": "https",
      origin: "https://attacker.example",
    });
    crossOriginReq.socket = { encrypted: false };
    const crossOriginSocket = captureSocket();
    await expect(
      handleWebSocketUpgrade(
        crossOrigin.deps,
        crossOriginReq,
        crossOriginSocket.socket,
        Buffer.alloc(0),
      ),
    ).resolves.toBe("rejected");
    expect(crossOriginSocket.text()).toContain("HTTP/1.1 403 Forbidden");
    expect(crossOriginSocket.text()).toContain("WebSocket origin is not allowed.");
    expect(crossOrigin.resolve).not.toHaveBeenCalled();
  });

  // S25. webSocketRequestAuthority derives the same-origin authority from the validated
  // x-forwarded-proto witness, so which element of a multi-hop chain wins decides whether a
  // browser's own `wss://` handshake is accepted, not just how a URL is spelled. Append
  // conventions are client-first, so the leftmost element is the TLS-terminating outer hop's and
  // the rightmost belongs to an inner hop that only saw the plaintext leg: reading the rightmost
  // would 403 every wss handshake for an https app behind an appending intermediary. Nothing
  // pinned that before.
  it.each([
    // [x-forwarded-proto, socket.encrypted, Origin, allowed, why]
    [undefined, false, "http://example.com", true, "no witness, plain socket → http authority"],
    [undefined, false, "https://example.com", false, "no witness cannot upgrade the authority"],
    [undefined, true, "https://example.com", true, "direct TLS connection with no edge in front"],
    ["https", false, "https://example.com", true, "TLS-terminating LB: the witness is the scheme"],
    ["HTTPS", false, "https://example.com", true, "case-insensitive witness"],
    ["http", false, "https://example.com", false, "edge witnessed plaintext"],
    // The topology the ordering exists for: TLS-terminating outer LB plus an appending inner hop.
    // The browser's own wss:// handshake must be accepted.
    [
      "https,http",
      false,
      "https://example.com",
      true,
      "leftmost hop (the TLS terminator) said https",
    ],
    [
      ["https", "http"],
      false,
      "https://example.com",
      true,
      "repeated header instances are one chain, joined before the leftmost read",
    ],
    ["http,https", false, "https://example.com", false, "the client-facing leg was plaintext"],
    ["javascript", false, "https://example.com", false, "garbage witness falls back to the socket"],
    ["javascript", false, "http://example.com", true, "garbage witness falls back to the socket"],
    [
      "javascript,https",
      false,
      "https://example.com",
      false,
      "garbage leftmost element does not fall further right",
    ],
    [
      "https,javascript",
      false,
      "https://example.com",
      true,
      "junk appended by an inner hop cannot demote the outer hop's witness",
    ],
  ] as const)(
    "same-origin authority for x-forwarded-proto %j (encrypted=%s, Origin %s) allows=%s",
    async (forwardedProto, encrypted, origin, allowed) => {
      const { deps, resolve } = dependencies({
        upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
      });
      const req = request(undefined, { origin });
      if (forwardedProto !== undefined) req.headers["x-forwarded-proto"] = forwardedProto;
      req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) =>
        Array.isArray(value) ? value.flatMap((entry) => [name, entry]) : [name, value],
      );
      req.socket = { encrypted };
      const { socket, text } = captureSocket();

      const disposition = await handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0));

      if (allowed) {
        expect(disposition).toBe("accepted-local");
        expect(resolve).toHaveBeenCalledOnce();
        socket.destroy();
      } else {
        expect(disposition).toBe("rejected");
        expect(text()).toContain("HTTP/1.1 403 Forbidden");
        expect(text()).toContain("WebSocket origin is not allowed.");
        expect(resolve).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves only framework-authored middleware cookies into the generated request", async () => {
    const middlewareRequestHeaders = new Headers({
      host: "example.com",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "x-middleware-set-cookie": "proxy-cookie=present; Path=/",
    });
    const upgradeHandler = vi.fn(async (_context, { node }) => {
      expect(node.req.headers["x-middleware-set-cookie"]).toBe("proxy-cookie=present; Path=/");
      expect(node.req.headers["x-nextjs-data"]).toBeUndefined();
      expect(node.req.headers[INTERNAL_DISPATCH_PROOF_HEADER]).toBeUndefined();
      expect((node.req as any)[Symbol.for("next.websocket.upgrade-headers-filtered")]).toBe(true);
      const rawNames = node.req.rawHeaders.map((value: string) => value.toLowerCase());
      expect(rawNames).not.toContain("x-middleware-set-cookie");
      expect(rawNames).not.toContain(INTERNAL_DISPATCH_PROOF_HEADER);
      return { upgraded: true, statusCode: 101 };
    });
    const { deps } = dependencies({
      upgradeHandler,
      resolution: { middlewareRequestHeaders },
    });
    const req = request(undefined, {
      "x-middleware-set-cookie": "forged=attacker; Path=/",
      "x-nextjs-data": "forged",
      [INTERNAL_DISPATCH_PROOF_HEADER]: "forged",
    });
    // createPoolServer's shared trust boundary performs this normalized-header deletion before
    // handing the request to handleWebSocketUpgrade; keep the direct unit invocation faithful.
    delete req.headers["x-middleware-set-cookie"];
    delete req.headers["x-nextjs-data"];
    delete req.headers[INTERNAL_DISPATCH_PROOF_HEADER];
    const { socket } = captureSocket();

    await expect(handleWebSocketUpgrade(deps, req, socket, Buffer.alloc(0))).resolves.toBe(
      "accepted-local",
    );
    expect(upgradeHandler).toHaveBeenCalledOnce();
    socket.destroy();
  });

  it.each(["content-length", "transfer-encoding", "expect", "trailer"])(
    "rejects the ambiguous %s framing header before routing",
    async (name) => {
      const { deps, resolve, handlerLoader } = dependencies({
        upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
      });
      const { socket, text } = captureSocket();

      await expect(
        handleWebSocketUpgrade(
          deps,
          request(undefined, { [name]: name === "content-length" ? "0" : "present" }),
          socket,
          Buffer.alloc(0),
        ),
      ).resolves.toBe("rejected");
      expect(text()).toContain("HTTP/1.1 400 Bad Request");
      expect(text()).toContain("WebSocket upgrade requests cannot include HTTP body framing.");
      expect(resolve).not.toHaveBeenCalled();
      expect(handlerLoader.loadUpgrade).not.toHaveBeenCalled();
    },
  );

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

  it("fails closed with Next's external-rewrite response instead of dialing the target", async () => {
    const { deps } = dependencies({
      resolution: { kind: "external-rewrite", url: new URL("http://127.0.0.1:9/socket") },
    });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0));

    expect(text()).toContain("HTTP/1.1 501 Not Implemented");
    expect(text()).toContain(
      "External WebSocket rewrite targets are not proxied while webSocketRouteHandlers is enabled.",
    );
  });

  it("returns 404 for a non-App-Route output", async () => {
    const { deps, handlerLoader } = dependencies({
      upgradeHandler: async () => ({ upgraded: true, statusCode: 101 }),
    });
    handlerLoader.get.mockReturnValue({ runtime: "nodejs", type: "APP_PAGE" });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0));

    expect(text()).toContain("HTTP/1.1 404 Not Found");
    expect(text()).toContain("Not Found");
    expect(handlerLoader.loadUpgrade).not.toHaveBeenCalled();
  });

  it("returns 404 for Edge outputs before attempting a raw Node upgrade", async () => {
    const upgradeHandler = vi.fn();
    const { deps, handlerLoader } = dependencies({ runtime: "edge", upgradeHandler });
    const { socket, text } = captureSocket();

    await handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0));
    expect(text()).toContain("HTTP/1.1 404 Not Found");
    expect(text()).toContain("Not Found");
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
      connection: "keep-alive, Upgrade, x-remove-on-hop",
      "keep-alive": "timeout=5",
      "proxy-authorization": "Basic must-not-cross",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "x-authenticated-user": "david",
      "x-remove-on-hop": "private",
    });
    const resolvedHeaders = new Headers({ "x-route-header": "present" });
    resolvedHeaders.append("set-cookie", "route=1; Path=/");
    const { deps } = dependencies({
      resolution: {
        pool: "chat",
        middlewareRequestHeaders: middlewareHeaders,
        resolvedHeaders,
        invokePath: "/rooms/alpha?joined=1",
        invocationQuery: { joined: "1" },
      },
    });
    deps.internalSecret = "internal-secret";
    deps.resolvePoolEndpoint = () => ({ hostname: "127.0.0.1", port: address.port });
    const socket = new NetworkLikeSocket();
    const earlyFrame = Buffer.from([0x81, 0x00]);
    const clientRequest = request(undefined, {
      connection: "keep-alive, Upgrade, x-remove-on-hop",
      "keep-alive": "timeout=5",
      "proxy-authorization": "Basic must-not-cross",
      "x-remove-on-hop": "private",
    });

    try {
      // N90: a tunnel, not a locally owned socket — shutdown may only write into this relayed pipe
      // where the N91 cursor proves it sits between frames.
      await expect(handleWebSocketUpgrade(deps, clientRequest, socket, earlyFrame)).resolves.toBe(
        "accepted-tunnel",
      );
      expect(siblingHeaders?.["x-output-id"]).toBe("/rooms/[room]");
      expect(siblingHeaders?.["x-mw-evaluated"]).toBe("ran");
      expect(siblingHeaders?.["x-internal-secret"]).toBeUndefined();
      const proof = siblingHeaders?.[INTERNAL_DISPATCH_PROOF_HEADER];
      expect(typeof proof).toBe("string");
      expect(
        verifyDispatchProof(
          "internal-secret",
          {
            method: clientRequest.method,
            target: clientRequest.url,
            headers: siblingHeaders ?? {},
          },
          proof as string,
        ),
      ).toBe(true);
      expect(siblingHeaders?.["x-authenticated-user"]).toBeUndefined();
      expect(siblingHeaders?.["x-mw-request-headers"]).toBe(
        JSON.stringify(Object.fromEntries(middlewareHeaders.entries())),
      );
      expect(siblingHeaders?.["x-invoke-query"]).toBe(JSON.stringify({ joined: "1" }));
      expect(siblingHeaders?.["x-resolved-headers"]).toBe(
        JSON.stringify({ "x-route-header": "present", "set-cookie": ["route=1; Path=/"] }),
      );
      expect(siblingHeaders?.["keep-alive"]).toBeUndefined();
      expect(siblingHeaders?.["proxy-authorization"]).toBeUndefined();
      expect(siblingHeaders?.["x-remove-on-hop"]).toBeUndefined();
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

  it("bounds and cancels a middleware rejection body that never produces bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => undefined),
      cancel() {
        cancelled = true;
      },
    });
    const { deps } = dependencies({
      handshakeTimeoutMs: 20,
      resolution: {
        kind: "middleware-response",
        response: new Response(body, { status: 401 }),
      },
    });
    const { socket } = captureSocket();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(handleWebSocketUpgrade(deps, request(), socket, Buffer.alloc(0))).resolves.toBe(
        "rejected",
      );
      expect(cancelled).toBe(true);
      expect(socket.destroyed).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
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
