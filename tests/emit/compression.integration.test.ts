import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  brotliDecompressSync,
  gunzipSync,
  zstdDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createZstdDecompress,
} from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPRESSION_ENVOY_IMAGE,
  compressionProxyConfig,
} from "../../src/emit/envoy-compression.js";
import {
  computeDispatchProof,
  dispatchProofInputsFromRequest,
  verifyDispatchProof,
} from "../../src/routing-common.js";

// Linux host networking keeps every socket on loopback. Opt into Podman with the same
// container CLI override used by deploy/emulate; ordinary unit runs skip without a runtime.
const runtime = process.env.ADAPTER_K8S_CONTAINER_CLI ?? "docker";
function container(...args: string[]) {
  return execFileSync(runtime, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  }).trim();
}
let available = false;
try {
  available = process.platform === "linux" && !!container("info");
} catch {
  /* Docker-gated */
}
const body = Buffer.from("<p>Next.js response compression and streaming.</p>".repeat(512));
const secret = "compression-test-secret";
const proofHeaderNames = ["accept-encoding", "cookie", "x-request-id"];
const decompress = { br: brotliDecompressSync, gzip: gunzipSync, zstd: zstdDecompressSync };
const decoders = { br: createBrotliDecompress, gzip: createGunzip, zstd: createZstdDecompress };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}
async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe.skipIf(!available)("response compression (real Envoy)", () => {
  const name = `adapter-compression-${process.pid}`;
  let dir: string;
  let backend: Server;
  let port: number;
  let adminPort: number;
  let finishStream: (() => void) | undefined;
  const seen: { url?: string; headers: IncomingHttpHeaders }[] = [];
  function get(url = "/", headers: Record<string, string> = {}, method = "GET") {
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>(
      (resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port, path: url, method, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("request timed out")));
        req.end();
      },
    );
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "adapter-compression-"));
    chmodSync(dir, 0o755); // The non-root container needs to read this public proxy config.
    backend = createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      if (req.url?.startsWith("/proof")) {
        const verdict = verifyDispatchProof(
          secret,
          { method: req.method, target: req.url, headers: req.headers, proofHeaderNames },
          req.headers["x-internal-dispatch-proof"] as string,
        );
        res.writeHead(verdict.trusted ? 200 : 401);
        res.end("proof");
        return;
      }
      res.setHeader(
        "content-type",
        req.url === "/image"
          ? "image/png"
          : req.url === "/sse"
            ? "text/event-stream"
            : "text/x-component",
      );
      res.setHeader("vary", "RSC, Next-Router-State-Tree");
      res.setHeader("server", "app");
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.setHeader("etag", req.url === "/weak-etag" ? 'W/"original"' : '"original"');
      if (req.url === "/no-transform") res.setHeader("cache-control", "private, no-transform");
      if (req.url === "/range") {
        res.statusCode = 206;
        res.setHeader("content-range", `bytes 0-${body.length - 1}/${body.length * 2}`);
      }
      if (req.url === "/encoded") res.setHeader("content-encoding", "gzip");
      if (req.url === "/empty") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.url === "/stream") {
        res.write(body);
        finishStream = () => res.end("tail");
        return;
      }
      const payload = req.url === "/tiny" ? Buffer.from("small") : body;
      res.setHeader("content-length", payload.length);
      res.end(payload);
    });
    backend.on("upgrade", (req, socket) => {
      const accept = createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("error", () => {});
      socket.on("data", () => socket.end(Buffer.from([0x81, 4, 112, 111, 110, 103])));
    });
    const backendPort = await listen(backend);
    port = await freePort();
    adminPort = await freePort();
    const config = compressionProxyConfig(backendPort, port);
    config.static_resources.listeners[0]!.address.socket_address.address = "127.0.0.1";
    config.admin.address.socket_address.port_value = adminPort;
    writeFileSync(path.join(dir, "envoy.json"), JSON.stringify(config));
    container(
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "host",
      "--read-only",
      "--user",
      "1000",
      "--cap-drop",
      "ALL",
      "-v",
      `${dir}:/etc/envoy:ro`,
      "--entrypoint",
      "/usr/local/bin/envoy",
      COMPRESSION_ENVOY_IMAGE,
      "-c",
      "/etc/envoy/envoy.json",
      "--concurrency",
      "2",
      "--log-level",
      "warn",
    );
    let lastResponse;
    for (let i = 0; i < 100; i++) {
      try {
        lastResponse = await get();
        if (lastResponse.status === 200) return;
      } catch {
        /* boot */
      }
      await sleep(50);
    }
    const logs = spawnSync(runtime, ["logs", name], { encoding: "utf8" });
    throw new Error(
      `Envoy did not start: ${JSON.stringify(lastResponse)} ${logs.stdout}${logs.stderr}`,
    );
  }, 60_000);

  afterAll(async () => {
    finishStream?.();
    try {
      container("rm", "-f", name);
    } catch {
      /* failed startup */
    }
    if (backend) {
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.each(["br", "zstd", "gzip"] as const)(
    "compresses and decodes %s with correct response metadata",
    async (encoding) => {
      const response = await get("/", { "accept-encoding": encoding });
      expect(response.headers["content-encoding"]).toBe(encoding);
      expect(response.body.length).toBeLessThan(body.length);
      expect(decompress[encoding](response.body)).toEqual(body);
      expect(response.headers["vary"]).toContain("Accept-Encoding");
      expect(response.headers["vary"]).toContain("RSC");
      expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
      expect(response.headers["server"]).toBe("app");
      expect(response.headers["etag"]).toBeUndefined();
      expect(response.headers["content-length"]).toBeUndefined();
    },
  );

  it.each([
    ["gzip, zstd, br", "br"],
    ["br;q=0.5, zstd;q=0.9, gzip;q=0.1", "zstd"],
    ["gzip;q=1, br;q=0.2", "gzip"],
    ["br;q=0, zstd;q=0, gzip;q=0", undefined],
    ["identity", undefined],
    ["", undefined],
  ])("negotiates %s", async (accept, encoding) => {
    const response = await get("/", { "accept-encoding": accept! });
    expect(response.headers["content-encoding"]).toBe(encoding);
    if (!encoding) expect(response.body).toEqual(body);
  });

  it.each(["/no-transform", "/range", "/image", "/sse", "/tiny", "/empty"])(
    "leaves %s uncompressed",
    async (url) => {
      const response = await get(url, { "accept-encoding": "br,zstd,gzip" });
      expect(response.headers["content-encoding"]).toBeUndefined();
      if (url === "/range") {
        expect(response.status).toBe(206);
        expect(response.body).toEqual(body);
      }
    },
  );

  it("does not recompress an already encoded response and preserves weak validators", async () => {
    const encoded = await get("/encoded", { "accept-encoding": "br,gzip" });
    expect(encoded.headers["content-encoding"]).toBe("gzip");
    expect(encoded.body).toEqual(body);
    const weak = await get("/weak-etag", { "accept-encoding": "br" });
    expect(weak.headers["etag"]).toBe('W/"original"');
    const head = await get("/", { "accept-encoding": "br" }, "HEAD");
    expect(head.body.length).toBe(0);
  });

  it("preserves signed authority, raw target, forwarded headers and Accept-Encoding", async () => {
    const url = "/proof/a%2Fb//c?q=a%20b&q=a+b";
    const headers = {
      host: "app.example.com",
      "accept-encoding": "br,zstd,gzip",
      cookie: "a=1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-for": "192.0.2.1",
      "x-output-id": "/proof",
      "x-mw-evaluated": "ran",
    };
    const proof = computeDispatchProof(
      secret,
      dispatchProofInputsFromRequest({ method: "GET", target: url, headers, proofHeaderNames }),
    );
    const response = await get(url, { ...headers, "x-internal-dispatch-proof": proof });
    expect(response.status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ url, headers });
  });

  it.each([undefined, "", "http", "https", "vhttp"])(
    "preserves proofs with forwarded proto %s",
    async (proto) => {
      const headers = {
        host: "app.example.com",
        "accept-encoding": "gzip",
        ...(proto !== undefined ? { "x-forwarded-proto": proto } : {}),
      };
      const proof = computeDispatchProof(
        secret,
        dispatchProofInputsFromRequest({
          method: "GET",
          target: "/proof",
          headers,
          proofHeaderNames,
        }),
      );
      const response = await get("/proof", { ...headers, "x-internal-dispatch-proof": proof });
      expect(response.status).toBe(200);
      expect(seen.at(-1)?.headers["x-request-id"]).toBeUndefined();
      expect(seen.at(-1)?.headers["x-forwarded-proto"]).toBe(proto);
    },
  );

  it("passes WebSocket upgrades and frames without compression", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1",
        port,
        path: "/socket",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "accept-encoding": "br,zstd,gzip",
        },
      });
      req.on("error", reject);
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`upgrade returned ${res.statusCode}`));
      });
      req.on("upgrade", (res, socket, head) => {
        expect(res.headers["content-encoding"]).toBeUndefined();
        const chunks: Buffer[] = [head];
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", reject);
        socket.setTimeout(2000, () => socket.destroy(new Error("upgrade timed out")));
        socket.on("end", () => {
          socket.destroy();
          try {
            expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x81, 4, 112, 111, 110, 103]));
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        socket.write(Buffer.from([0x81, 0x84, 1, 2, 3, 4, 113, 107, 109, 99]));
      });
      req.end();
    });
  });

  it.each(["br", "zstd", "gzip"] as const)(
    "flushes %s RSC chunks before the origin ends",
    async (encoding) => {
      try {
        await new Promise<void>((resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port,
              path: "/stream",
              headers: { "accept-encoding": encoding },
            },
            (res) => {
              expect(res.headers["content-encoding"]).toBe(
                encoding === "zstd" ? undefined : encoding,
              );
              const decoder = encoding === "zstd" ? new PassThrough() : decoders[encoding]();
              const chunks: Buffer[] = [];
              decoder.once("data", () => finishStream?.());
              decoder.on("data", (chunk) => chunks.push(chunk));
              decoder.on("error", reject);
              decoder.on("end", () => {
                try {
                  expect(Buffer.concat(chunks)).toEqual(Buffer.concat([body, Buffer.from("tail")]));
                  resolve();
                } catch (error) {
                  reject(error);
                }
              });
              res.pipe(decoder);
            },
          );
          req.on("error", reject);
          req.setTimeout(2000, () => req.destroy(new Error("compressor buffered the stream")));
          req.end();
        });
      } finally {
        finishStream?.();
        finishStream = undefined;
      }
    },
  );

  it("supports the image's shell-based graceful drain hook without curl", () => {
    const response = container(
      "exec",
      name,
      "/bin/bash",
      "-c",
      `exec 3<>/dev/tcp/127.0.0.1/${adminPort}; printf 'POST /drain_listeners?graceful HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 0\r\n\r\n' >&3; head -n 1 <&3`,
    );
    expect(response).toContain("200 OK");
  });
});
