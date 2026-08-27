import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { get as httpGet, type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Server as NetServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPoolServer } from "../../src/pool-server/server.js";

// Portable rollout conformance against a real Envoy data plane. Unit assertions prove that the
// generated HTTPRoute contains `request: 0s`; this differential test proves Envoy interprets it
// as intended, and that its HTTP/1.1 proxying preserves the pool's protocol-specific drain
// behavior. The TCP selector models a Kubernetes Service/EndpointSlice at the relevant boundary:
// an accepted connection remains pinned to its old pod, while connections accepted after the
// selector flip reach the new pod.

function docker(args: string[]): string {
  return (
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || ""
  ).trim();
}

function dockerLogs(containerName: string): string {
  const result = spawnSync("docker", ["logs", containerName], { encoding: "utf8" });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function websocketFrame(payload: string): Buffer {
  const bytes = Buffer.from(payload);
  if (bytes.length > 125) throw new Error("Test WebSocket payload exceeds one short frame");
  return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]);
}

function websocketHandler(build: string) {
  return (req: IncomingMessage, socket: NodeJS.WritableStream) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return "rejected" as const;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.write(websocketFrame(build));
    return "accepted" as const;
  };
}

interface SseEvent {
  id?: string;
  data: string;
}

function openEventStream(port: number, lastEventId?: string) {
  const events: SseEvent[] = [];
  let pending = "";
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  let resolveEnded!: () => void;
  let rejectEnded!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });

  const request = httpGet(
    {
      host: "127.0.0.1",
      port,
      path: "/events",
      headers: {
        accept: "text/event-stream",
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    },
    (response) => {
      if (response.statusCode !== 200) {
        const error = new Error(`SSE response returned ${response.statusCode}`);
        rejectConnected(error);
        rejectEnded(error);
        response.resume();
        return;
      }
      resolveConnected();
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        pending += chunk.replaceAll("\r\n", "\n");
        for (let boundary = pending.indexOf("\n\n"); boundary !== -1; ) {
          const record = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          const data: string[] = [];
          let id: string | undefined;
          for (const line of record.split("\n")) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("id:")) id = line.slice(3).trimStart();
            if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (data.length > 0) events.push({ id, data: data.join("\n") });
          boundary = pending.indexOf("\n\n");
        }
      });
      response.once("end", resolveEnded);
      response.once("aborted", () => rejectEnded(new Error("SSE response was aborted")));
      response.once("error", rejectEnded);
    },
  );
  request.once("error", (error) => {
    rejectConnected(error);
    rejectEnded(error);
  });

  return { connected, ended, events, destroy: () => request.destroy() };
}

function openWebSocket(port: number) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  let received = Buffer.alloc(0);
  let upgraded = false;
  let messageSettled = false;
  let closeSettled = false;
  let resolveMessage!: (message: string) => void;
  let rejectMessage!: (error: Error) => void;
  let resolveCloseCode!: (code: number | undefined) => void;
  const message = new Promise<string>((resolve, reject) => {
    resolveMessage = resolve;
    rejectMessage = reject;
  });
  const closeCode = new Promise<number | undefined>((resolve) => (resolveCloseCode = resolve));

  const settleClose = (code: number | undefined) => {
    if (closeSettled) return;
    closeSettled = true;
    resolveCloseCode(code);
  };
  socket.once("connect", () => {
    socket.write(
      "GET /socket HTTP/1.1\r\n" +
        "Host: adapter.test\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: websocket\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
  });
  socket.on("data", (chunk) => {
    received = Buffer.concat([received, chunk]);
    if (!upgraded) {
      const boundary = received.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      const headers = received.subarray(0, boundary).toString("latin1");
      if (!headers.startsWith("HTTP/1.1 101")) {
        const error = new Error(`WebSocket upgrade failed: ${headers.split("\r\n")[0]}`);
        messageSettled = true;
        rejectMessage(error);
        socket.destroy();
        return;
      }
      upgraded = true;
      received = received.subarray(boundary + 4);
    }

    while (received.length >= 2) {
      const opcode = received[0]! & 0x0f;
      let payloadLength = received[1]! & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (received.length < 4) return;
        payloadLength = received.readUInt16BE(2);
        offset = 4;
      }
      if (received.length < offset + payloadLength) return;
      const payload = received.subarray(offset, offset + payloadLength);
      received = received.subarray(offset + payloadLength);
      if (opcode === 0x1 && !messageSettled) {
        messageSettled = true;
        resolveMessage(payload.toString("utf8"));
      }
      if (opcode === 0x8) {
        settleClose(payload.length >= 2 ? payload.readUInt16BE(0) : undefined);
      }
    }
  });
  socket.once("close", () => {
    if (!messageSettled) {
      messageSettled = true;
      rejectMessage(new Error("WebSocket closed before its first message"));
    }
    settleClose(undefined);
  });
  socket.once("error", (error) => {
    if (!messageSettled) {
      messageSettled = true;
      rejectMessage(error);
    }
  });

  return { socket, message, closeCode };
}

function closeNetServer(server: NetServer | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.skipIf(!dockerAvailable)("portable rollout continuity (real Envoy)", () => {
  const containerName = `adapter-k8s-portable-rollout-${process.pid}`;
  const previousPrivateOrigin = process.env.__NEXT_PRIVATE_ORIGIN;
  const eventLog: SseEvent[] = [{ id: "1", data: "before-cutover" }];
  const selectorSockets = new Set<Socket>();
  let activePoolPort = 0;
  let finiteStarted!: () => void;
  let finiteStartedPromise = new Promise<void>((resolve) => (finiteStarted = resolve));
  let oldPool: ReturnType<typeof createPoolServer>;
  let newPool: ReturnType<typeof createPoolServer>;
  let newPoolPort = 0;
  let selector: NetServer | undefined;
  let envoyPort = 0;

  const requestHandler = (build: "old" | "new") => {
    return async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/timeout-control" || req.url === "/finite") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.write(`${build}:first\n`);
        if (req.url === "/finite" && build === "old") finiteStarted();
        await sleep(450);
        res.end(`${build}:last\n`);
        return;
      }
      if (req.url === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
        });
        res.flushHeaders();
        const lastEventId = Number(req.headers["last-event-id"] ?? 0);
        for (const event of eventLog) {
          if (Number(event.id) > lastEventId) {
            res.write(`id: ${event.id}\ndata: ${event.data}\n\n`);
          }
        }
        if (build === "new") {
          res.end();
          return;
        }
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25);
        res.once("close", () => clearInterval(heartbeat));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(build);
    };
  };

  beforeAll(async () => {
    oldPool = createPoolServer({
      onRequest: requestHandler("old"),
      onUpgrade: websocketHandler("old"),
      readiness: () => ({ ready: true, reason: "ready" }),
      port: 0,
    });
    newPool = createPoolServer({
      onRequest: requestHandler("new"),
      onUpgrade: websocketHandler("new"),
      readiness: () => ({ ready: true, reason: "ready" }),
      port: 0,
    });
    const [{ port: oldPort }, { port: newPort }] = await Promise.all([
      oldPool.start(),
      newPool.start(),
    ]);
    activePoolPort = oldPort;
    newPoolPort = newPort;

    selector = net.createServer((client) => {
      const upstream = net.createConnection({ host: "127.0.0.1", port: activePoolPort });
      selectorSockets.add(client);
      selectorSockets.add(upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      const destroyBoth = () => {
        client.destroy();
        upstream.destroy();
      };
      client.once("error", destroyBoth);
      upstream.once("error", destroyBoth);
      client.once("close", () => {
        selectorSockets.delete(client);
        upstream.destroy();
      });
      upstream.once("close", () => {
        selectorSockets.delete(upstream);
        client.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      selector!.once("error", reject);
      selector!.listen(0, "0.0.0.0", resolve);
    });
    const selectorAddress = selector.address();
    if (!selectorAddress || typeof selectorAddress === "string") {
      throw new Error("Could not determine selector port");
    }

    const envoyConfig = `static_resources:
  listeners:
    - name: listener
      address:
        socket_address: { address: 0.0.0.0, port_value: 18080 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: portable_rollout_test
                upgrade_configs:
                  - upgrade_type: websocket
                route_config:
                  name: routes
                  virtual_hosts:
                    - name: app
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/timeout-control" }
                          route:
                            cluster: stable-service
                            timeout: 0.150s
                        - match: { prefix: "/" }
                          route:
                            cluster: stable-service
                            timeout: 0s
                            upgrade_configs:
                              - upgrade_type: websocket
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
    - name: stable-service
      connect_timeout: 1s
      type: STRICT_DNS
      typed_extension_protocol_options:
        envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
          "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
          common_http_protocol_options:
            max_requests_per_connection: 1
          explicit_http_config:
            http_protocol_options: {}
      load_assignment:
        cluster_name: stable-service
        endpoints:
          - lb_endpoints:
              - endpoint:
                  address:
                    socket_address:
                      address: host.docker.internal
                      port_value: ${selectorAddress.port}
`;

    docker([
      "run",
      "-d",
      "--name",
      containerName,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::18080",
      // Envoy Gateway 1.5.x, the adapter's oldest supported controller line, bundles Envoy 1.35.
      // Exercise the floor of the compatibility range rather than an unrelated latest image.
      "envoyproxy/envoy:v1.35-latest",
      "--config-yaml",
      envoyConfig,
      "--log-level",
      "warning",
    ]);
    envoyPort = Number(docker(["port", containerName, "18080/tcp"]).split(":").pop());

    let lastObservation = "no response";
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${envoyPort}/who`, {
          signal: AbortSignal.timeout(500),
        });
        const body = await response.text();
        lastObservation = `${response.status} ${body}`;
        if (body === "old") return;
      } catch (error) {
        // Envoy may still be binding or waiting for its first DNS resolution.
        lastObservation = String(error);
      }
      await sleep(100);
    }
    throw new Error(
      `Envoy on ${envoyPort} did not become ready (${lastObservation}); ` +
        `state=${docker(["inspect", "--format", "{{json .State}}", containerName])}:\n` +
        dockerLogs(containerName),
    );
  }, 120_000);

  afterAll(async () => {
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      // The container may already have exited after a configuration failure.
    }
    for (const socket of selectorSockets) socket.destroy();
    await Promise.all([
      oldPool?.stop({ graceMs: 50 }).catch(() => undefined),
      newPool?.stop({ graceMs: 50 }).catch(() => undefined),
      closeNetServer(selector),
    ]);
    if (previousPrivateOrigin === undefined) delete process.env.__NEXT_PRIVATE_ORIGIN;
    else process.env.__NEXT_PRIVATE_ORIGIN = previousPrivateOrigin;
  });

  it("preserves finite streams and gives SSE/WebSocket clients resumable cutover signals", async () => {
    // Differential control: the same 450ms handler fails under an ordinary total route timeout,
    // proving the successful /finite request below relies on Envoy's `timeout: 0s` behavior.
    const timedOut = await fetch(`http://127.0.0.1:${envoyPort}/timeout-control`);
    let controlBody: string | undefined;
    try {
      controlBody = await timedOut.text();
    } catch {
      // Once upstream headers are committed, Envoy can only reset the response at the timeout;
      // before headers it would synthesize 504. Either form must not look like a complete body.
    }
    expect(controlBody).not.toBe("old:first\nold:last\n");

    const oldSse = openEventStream(envoyPort);
    await oldSse.connected;
    await expect.poll(() => oldSse.events).toEqual([{ id: "1", data: "before-cutover" }]);
    const oldWebSocket = openWebSocket(envoyPort);
    await expect(oldWebSocket.message).resolves.toBe("old");

    finiteStartedPromise = new Promise<void>((resolve) => (finiteStarted = resolve));
    const finiteResponsePromise = fetch(`http://127.0.0.1:${envoyPort}/finite`);
    await finiteStartedPromise;

    eventLog.push({ id: "2", data: "after-cutover" });
    activePoolPort = newPoolPort;
    const drain = oldPool.stop({ graceMs: 650 });

    const newRequest = await fetch(`http://127.0.0.1:${envoyPort}/who`);
    await expect(newRequest.text()).resolves.toBe("new");

    const finiteResponse = await finiteResponsePromise;
    expect(finiteResponse.status).toBe(200);
    await expect(finiteResponse.text()).resolves.toBe("old:first\nold:last\n");
    await expect(oldSse.ended).resolves.toBeUndefined();
    await expect(oldWebSocket.closeCode).resolves.toBe(1001);
    await drain;

    // The adapter supplies a reconnectable boundary, not application state migration. This
    // client sends the standard SSE cursor and the new pod replays from shared event history.
    const resumedSse = openEventStream(envoyPort, oldSse.events.at(-1)?.id);
    await resumedSse.connected;
    await resumedSse.ended;
    expect(resumedSse.events).toEqual([{ id: "2", data: "after-cutover" }]);

    const newWebSocket = openWebSocket(envoyPort);
    await expect(newWebSocket.message).resolves.toBe("new");
    newWebSocket.socket.destroy();
  });
});
