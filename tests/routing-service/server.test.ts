import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http2 from "node:http2";
import https from "node:https";
import { request as httpRequest } from "node:http";
import { connect as tcpConnect } from "node:net";
import { once as eventOnce } from "node:events";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  createRoutingServer,
  createProcessHandler,
  plainResponseToProto,
  startHealthServer,
} from "../../src/routing-service/server.js";
import {
  ProcessingRequestSchema,
  ProcessingResponseSchema,
  CommonResponse_ResponseStatus,
  type ProcessingRequest,
  type ProcessingResponse,
} from "../../src/routing-service/protos/envoy/service/ext_proc/v3/external_processor_pb.js";
import { HeaderValueOption_HeaderAppendAction } from "../../src/routing-service/protos/envoy/config/core/v3/base_pb.js";
import type { ProcessingResponse as PlainProcessingResponse } from "../../src/routing-service/ext-proc-types.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function* once<T>(value: T): AsyncGenerator<T> {
  yield value;
}

function makeRequestHeadersCallout(path: string): ProcessingRequest {
  return create(ProcessingRequestSchema, {
    request: {
      case: "requestHeaders",
      value: { headers: { headers: [{ key: ":path", rawValue: enc.encode(path) }] } },
    },
  });
}

async function collect(gen: AsyncGenerator<ProcessingResponse>): Promise<ProcessingResponse[]> {
  const out: ProcessingResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

describe("createRoutingServer", () => {
  let server: ReturnType<typeof createRoutingServer> | null = null;
  let tmpDir: string | null = null;
  const savedTlsEnv: Record<string, string | undefined> = {};

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
    for (const key of ["TLS_CERT_FILE", "TLS_KEY_FILE"]) {
      if (savedTlsEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedTlsEnv[key];
      delete savedTlsEnv[key];
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function continueHandler() {
    return vi.fn().mockResolvedValue({
      requestHeaders: { response: { headerMutation: { setHeaders: [] }, status: "CONTINUE" } },
    } as PlainProcessingResponse);
  }

  it("creates an HTTP/2 ext_proc server that can start and stop", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0 });
    const address = await server.start();
    expect(address.port).toBeGreaterThan(0);
    await server.stop();
    server = null;
  });

  it("honors an explicit loopback bind for local emulation", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0, host: "127.0.0.1" });
    await server.start();
    const address = server.server.address();
    expect(address).toMatchObject({ address: "127.0.0.1" });
  });

  it("keeps accepting callouts during the readiness propagation window", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0, host: "127.0.0.1" });
    const { port } = await server.start();
    let closed = false;
    const stopped = server.stop({ delayMs: 100, graceMs: 100 }).then(() => {
      closed = true;
    });
    const client = http2.connect(`http://127.0.0.1:${port}`);
    try {
      await eventOnce(client, "connect");
      expect(closed).toBe(false);
      const call = client.request({ ":path": "/" });
      call.resume();
      await eventOnce(call, "end");
      expect(closed).toBe(false);
    } finally {
      client.destroy();
      await stopped;
      server = null;
    }
  });

  it("drains an idle HTTP/2 connection so shutdown does not wait for the client to disconnect", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0, host: "127.0.0.1" });
    const { port } = await server.start();
    const accepted = eventOnce(server.server, "session");
    const client = http2.connect(`http://127.0.0.1:${port}`);
    await accepted;
    const goaway = vi.fn();
    client.on("goaway", goaway);
    const stopped = server.stop();
    try {
      await expect(
        Promise.race([
          stopped.then(() => "stopped"),
          new Promise((resolve) => setTimeout(() => resolve("still waiting for client"), 200)),
        ]),
      ).resolves.toBe("stopped");
      expect(goaway).toHaveBeenCalled();
    } finally {
      client.destroy();
      await stopped;
      server = null;
    }
  });

  it("bounds shutdown even when a peer never completes its HTTP/2 handshake", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0, host: "127.0.0.1" });
    const { port } = await server.start();
    const accepted = eventOnce(server.server, "connection");
    const client = tcpConnect(port, "127.0.0.1");
    await accepted;
    try {
      await expect(
        Promise.race([
          server.stop({ graceMs: 30 }).then(() => "stopped"),
          new Promise((resolve) => setTimeout(() => resolve("unbounded"), 300)),
        ]),
      ).resolves.toBe("stopped");
    } finally {
      client.destroy();
    }
  });

  it("tells the caller to reconnect while allowing an in-flight middleware verdict to finish", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server = createRoutingServer({
      port: 0,
      host: "127.0.0.1",
      failOpen: false,
      handler: async () => {
        entered();
        await pending;
        return { immediateResponse: { status: { code: 403 }, body: "denied during drain" } };
      },
    });
    const { port } = await server.start();
    const client = http2.connect(`http://127.0.0.1:${port}`);
    const call = client.request({
      ":method": "POST",
      ":path": "/envoy.service.ext_proc.v3.ExternalProcessor/Process",
      "content-type": "application/grpc",
      te: "trailers",
    });
    const payload = Buffer.from(
      toBinary(ProcessingRequestSchema, makeRequestHeadersCallout("/protected")),
    );
    const frame = Buffer.alloc(5 + payload.length);
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    const chunks: Buffer[] = [];
    call.on("data", (chunk) => chunks.push(chunk));
    const ended = eventOnce(call, "end");
    call.end(frame);
    await started;
    const goaway = eventOnce(client, "goaway");
    const stopped = server.stop();
    try {
      await expect(
        Promise.race([
          goaway.then(() => "draining"),
          new Promise((resolve) => setTimeout(() => resolve("no drain notice"), 200)),
        ]),
      ).resolves.toBe("draining");
      finish();
      await ended;
      const body = Buffer.concat(chunks);
      const verdict = fromBinary(
        ProcessingResponseSchema,
        body.subarray(5, 5 + body.readUInt32BE(1)),
      );
      expect(verdict.response.case).toBe("immediateResponse");
      if (verdict.response.case === "immediateResponse")
        expect(verdict.response.value.status?.code).toBe(403);
      await stopped;
    } finally {
      finish();
      client.destroy();
      await stopped;
      server = null;
    }
  });

  it("keeps the plaintext h2c path working for emulate (no TLS env)", async () => {
    server = createRoutingServer({ handler: continueHandler(), port: 0 });
    const { port } = await server.start();

    // An h2 client connects to the plaintext server — the local/emulate path is unchanged.
    const session = http2.connect(`http://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });
    session.close();
  });

  // H1b: the TLS ext_proc data path is HTTP/2-only (allowHTTP1: false). Health checks run
  // on the separate plaintext HTTP server, so HTTP/1.1 must never reach the Connect handler.
  it("serves HTTP/2 over TLS and rejects HTTP/1.1 clients", async () => {
    // Mint a throwaway self-signed pair — the same openssl invocation the container-start
    // path in index.ts uses (L11).
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "routing-tls-test-"));
    const certFile = path.join(tmpDir, "tls-cert.pem");
    const keyFile = path.join(tmpDir, "tls-key.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=test-routing-service",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    savedTlsEnv.TLS_CERT_FILE = process.env.TLS_CERT_FILE;
    savedTlsEnv.TLS_KEY_FILE = process.env.TLS_KEY_FILE;
    process.env.TLS_CERT_FILE = certFile;
    process.env.TLS_KEY_FILE = keyFile;

    server = createRoutingServer({ handler: continueHandler(), port: 0 });
    // Track TLS sockets so the test can force-close the ALPN-rejected HTTP/1.1 connection:
    // Node answers it with a terminal 403 but deliberately keeps the socket open, which
    // would otherwise stall server.stop() waiting for it.
    const sockets = new Set<import("node:net").Socket>();
    server.server.on("secureConnection", (socket: import("node:net").Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    const { port } = await server.start();

    // HTTP/2 over TLS works — this is the GCP ext_proc data path.
    const session = http2.connect(`https://127.0.0.1:${port}`, { rejectUnauthorized: false });
    await new Promise<void>((resolve, reject) => {
      session.once("connect", () => resolve());
      session.once("error", reject);
    });
    session.destroy();

    // An HTTP/1.1 client is rejected at the ALPN layer (allowHTTP1: false) and never
    // reaches the Connect handler.
    const http1Status = await new Promise<number>((resolve, reject) => {
      const req = https.request(
        { host: "127.0.0.1", port, path: "/", rejectUnauthorized: false, agent: false },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(http1Status).toBe(403);
    for (const socket of sockets) socket.destroy();
  });
});

describe("routing readiness withdrawal", () => {
  it("only accepts drain from loopback and keeps liveness healthy while readiness is withdrawn", async () => {
    let ready = true;
    const health = await startHealthServer(
      0,
      () => ready,
      "127.0.0.1",
      () => {
        ready = false;
      },
    );
    const probe = (path: string, method = "GET", localAddress = "127.0.0.1") =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: "127.0.0.1", port: health.port, path, method, localAddress, agent: false },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode!));
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      expect(await probe("/readyz")).toBe(200);
      expect(await probe("/drain", "POST", "127.0.0.2")).toBe(403);
      expect(await probe("/readyz")).toBe(200);
      expect(await probe("/drain", "POST")).toBe(200);
      expect(await probe("/readyz")).toBe(503);
      expect(await probe("/healthz")).toBe(200);
      expect(await probe("/drain", "POST")).toBe(200);
      expect(await probe("/readyz")).toBe(503);
    } finally {
      await health.close();
    }
  });
});

// Fix E: verify the boundary converter produces generated protobuf messages that
// serialize/deserialize correctly with the real Envoy ext_proc types.
// NOTE: this proves the converter + generated codec are internally consistent —
// it does NOT prove wire-compatibility with a live Envoy/GCP caller.
describe("plainResponseToProto (Fix E converter)", () => {
  it("round-trips a header-mutation response through protobuf binary", () => {
    const proto = plainResponseToProto({
      requestHeaders: {
        response: {
          headerMutation: {
            setHeaders: [
              {
                header: { key: "x-upstream-pool", value: "ssr" },
                appendAction: "OVERWRITE_IF_EXISTS_OR_ADD",
              },
            ],
          },
          clearRouteCache: true,
          status: "CONTINUE",
        },
      },
    });
    const decoded = fromBinary(ProcessingResponseSchema, toBinary(ProcessingResponseSchema, proto));
    expect(decoded.response.case).toBe("requestHeaders");
    if (decoded.response.case !== "requestHeaders") throw new Error("wrong case");
    const common = decoded.response.value.response!;
    expect(common.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
    expect(common.clearRouteCache).toBe(true);
    const h = common.headerMutation!.setHeaders[0]!;
    expect(h.header!.key).toBe("x-upstream-pool");
    expect(dec.decode(h.header!.rawValue)).toBe("ssr");
    expect(h.appendAction).toBe(HeaderValueOption_HeaderAppendAction.OVERWRITE_IF_EXISTS_OR_ADD);
  });

  it("round-trips an immediate response (redirect) through protobuf binary", () => {
    const proto = plainResponseToProto({
      immediateResponse: {
        status: { code: 301 },
        headers: {
          setHeaders: [{ header: { key: "location", value: "https://example.com/new" } }],
        },
        body: "moved",
      },
    });
    const decoded = fromBinary(ProcessingResponseSchema, toBinary(ProcessingResponseSchema, proto));
    expect(decoded.response.case).toBe("immediateResponse");
    if (decoded.response.case !== "immediateResponse") throw new Error("wrong case");
    const ir = decoded.response.value;
    expect(ir.status!.code).toBe(301);
    expect(dec.decode(ir.body)).toBe("moved");
    const loc = ir.headers!.setHeaders.find((h) => h.header!.key === "location")!;
    expect(dec.decode(loc.header!.rawValue)).toBe("https://example.com/new");
  });
});

// Fix D: the fail behavior on handler error must respect the failOpen flag.
// Driven through the real Process bidi generator (which also exercises the
// request-header decoding and the protobuf response construction).
describe("createProcessHandler fail behavior (Fix D)", () => {
  it("fails open (CONTINUE) when failOpen is true and the handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const proc = createProcessHandler(handler, true);
    const [response] = await collect(proc(once(makeRequestHeadersCallout("/"))));
    expect(response!.response.case).toBe("requestHeaders");
    if (response!.response.case !== "requestHeaders") throw new Error("wrong case");
    expect(response!.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
  });

  it("fails closed (immediate 500) when failOpen is false and the handler throws", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const proc = createProcessHandler(handler, false);
    const [response] = await collect(proc(once(makeRequestHeadersCallout("/"))));
    expect(response!.response.case).toBe("immediateResponse");
    if (response!.response.case !== "immediateResponse") throw new Error("wrong case");
    expect(response!.response.value.status!.code).toBe(500);
  });

  it("decodes rawValue request headers and passes them to the handler", async () => {
    const handler = vi.fn().mockResolvedValue({
      requestHeaders: { response: { headerMutation: { setHeaders: [] }, status: "CONTINUE" } },
    } as PlainProcessingResponse);
    const proc = createProcessHandler(handler, true);
    await collect(proc(once(makeRequestHeadersCallout("/about"))));
    expect(handler).toHaveBeenCalledTimes(1);
    const passedHeaders = handler.mock.calls[0]![0] as Array<{ key: string; rawValue?: Buffer }>;
    const pathHeader = passedHeaders.find((h) => h.key === ":path");
    expect(pathHeader!.rawValue!.toString("utf-8")).toBe("/about");
  });

  it("times out a slow handler and applies the fail policy", async () => {
    const slow = vi.fn().mockImplementation(() => new Promise(() => {})); // never resolves
    const open = createProcessHandler(slow, true, 15);
    const [r1] = await collect(open(once(makeRequestHeadersCallout("/"))));
    expect(r1!.response.case).toBe("requestHeaders"); // timeout + fail-open → CONTINUE

    const closed = createProcessHandler(slow, false, 15);
    const [r2] = await collect(closed(once(makeRequestHeadersCallout("/"))));
    expect(r2!.response.case).toBe("immediateResponse"); // timeout + fail-closed → 500
    if (r2!.response.case !== "immediateResponse") throw new Error("wrong case");
    expect(r2!.response.value.status!.code).toBe(500);
  });

  it("answers unexpected phases by echoing the phase-matching CONTINUE response", async () => {
    // We only negotiate REQUEST_HEADERS, but a config skew can deliver other phases —
    // silence would stall the bidi stream, and a fully-EMPTY ProcessingResponse (no
    // oneof set) may itself be a protocol error for Envoy. Each phase must get its
    // matching response case with a default-CONTINUE verdict, and the routing
    // handler must NOT be invoked for any of them.
    const handler = vi.fn();
    const proc = createProcessHandler(handler, true);

    const requestBodyCallout = create(ProcessingRequestSchema, {
      request: { case: "requestBody", value: { body: enc.encode("x") } },
    });
    const [bodyRes] = await collect(proc(once(requestBodyCallout)));
    expect(bodyRes!.response.case).toBe("requestBody");
    if (bodyRes!.response.case !== "requestBody") throw new Error("wrong case");
    expect(bodyRes!.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);

    const responseHeadersCallout = create(ProcessingRequestSchema, {
      request: { case: "responseHeaders", value: { headers: { headers: [] } } },
    });
    const [rhRes] = await collect(proc(once(responseHeadersCallout)));
    expect(rhRes!.response.case).toBe("responseHeaders");
    if (rhRes!.response.case !== "responseHeaders") throw new Error("wrong case");
    expect(rhRes!.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);

    const responseBodyCallout = create(ProcessingRequestSchema, {
      request: { case: "responseBody", value: { body: enc.encode("y") } },
    });
    const [rbRes] = await collect(proc(once(responseBodyCallout)));
    expect(rbRes!.response.case).toBe("responseBody");

    const requestTrailersCallout = create(ProcessingRequestSchema, {
      request: { case: "requestTrailers", value: {} },
    });
    const [rtRes] = await collect(proc(once(requestTrailersCallout)));
    expect(rtRes!.response.case).toBe("requestTrailers");

    const responseTrailersCallout = create(ProcessingRequestSchema, {
      request: { case: "responseTrailers", value: {} },
    });
    const [resTrRes] = await collect(proc(once(responseTrailersCallout)));
    expect(resTrRes!.response.case).toBe("responseTrailers");

    expect(handler).not.toHaveBeenCalled();
  });
});
