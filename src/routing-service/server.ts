import { createServer, createSecureServer, type Http2Server } from "node:http2";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { create } from "@bufbuild/protobuf";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter } from "@connectrpc/connect";
import {
  ExternalProcessor,
  ProcessingResponseSchema,
  CommonResponse_ResponseStatus,
  type ProcessingRequest,
  type ProcessingResponse,
} from "./protos/envoy/service/ext_proc/v3/external_processor_pb.js";
import { HeaderValueOption_HeaderAppendAction } from "./protos/envoy/config/core/v3/base_pb.js";
import type { StatusCode } from "./protos/envoy/type/v3/http_status_pb.js";
import type {
  HeaderValue,
  HeaderValueOption as PlainHeaderValueOption,
  ProcessingResponse as PlainProcessingResponse,
} from "./ext-proc-types.js";

export interface RoutingServerOptions {
  handler: (requestHeaders: HeaderValue[]) => Promise<PlainProcessingResponse>;
  port: number;
  // When a handler throws, fail-open (CONTINUE, let the request through) if true,
  // else fail-closed with an immediate 500. Defaults to true to preserve the
  // historical behavior. See ROUTING_FAIL_OPEN wiring in index.ts.
  failOpen?: boolean;
  // Per-request budget (ms) for the handler; 0 disables. Shed a slow request
  // deterministically before the ext_proc deadline. Only bounds async slowness.
  timeoutMs?: number;
}

const encoder = new TextEncoder();
const toBytes = (s: string): Uint8Array => encoder.encode(s);

// --- Boundary converters -------------------------------------------------
// The handler (fixes A-D) works with the plain internal ext-proc-types shape.
// Envoy/GCP speak protobuf, so we translate at the transport edge only, using
// the generated protobuf-es messages (real envoy.service.ext_proc.v3 types).

// Extracts the request-header list from an incoming ProcessingRequest, or null
// for any other callout kind (we only act on request_headers, as before).
// Envoy usually delivers header values in `raw_value` (bytes), leaving `value`
// empty — the handler already reads both, so both are carried across.
function requestHeadersToPlain(req: ProcessingRequest): HeaderValue[] | null {
  if (req.request.case !== "requestHeaders") return null;
  const headers = req.request.value.headers?.headers ?? [];
  return headers.map((h) => {
    const out: HeaderValue = { key: h.key };
    if (h.value) out.value = h.value;
    if (h.rawValue.length) out.rawValue = Buffer.from(h.rawValue);
    return out;
  });
}

function mapAppendAction(
  action: PlainHeaderValueOption["appendAction"],
): HeaderValueOption_HeaderAppendAction {
  return action === "APPEND_IF_EXISTS_OR_ADD"
    ? HeaderValueOption_HeaderAppendAction.APPEND_IF_EXISTS_OR_ADD
    : HeaderValueOption_HeaderAppendAction.OVERWRITE_IF_EXISTS_OR_ADD;
}

// Header values are emitted as raw_value (bytes) to match how Envoy/GCP expect
// mutated headers (mirrors the App Hosting adapter POC, where `value` is empty).
function toProtoSetHeaders(entries: PlainHeaderValueOption[]) {
  return entries.map((e) => ({
    header: { key: e.header.key, rawValue: toBytes(e.header.value ?? "") },
    appendAction: mapAppendAction(e.appendAction),
  }));
}

// Converts the handler's plain ProcessingResponse into the generated protobuf
// message that goes on the wire.
export function plainResponseToProto(plain: PlainProcessingResponse): ProcessingResponse {
  if (plain.immediateResponse) {
    const ir = plain.immediateResponse;
    return create(ProcessingResponseSchema, {
      response: {
        case: "immediateResponse",
        value: {
          status: { code: (ir.status?.code ?? 200) as StatusCode },
          headers: { setHeaders: toProtoSetHeaders(ir.headers?.setHeaders ?? []) },
          body: ir.body != null ? toBytes(ir.body) : new Uint8Array(),
        },
      },
    });
  }

  const common = plain.requestHeaders?.response;
  return create(ProcessingResponseSchema, {
    response: {
      case: "requestHeaders",
      value: {
        response: {
          status:
            common?.status === "CONTINUE_AND_REPLACE"
              ? CommonResponse_ResponseStatus.CONTINUE_AND_REPLACE
              : CommonResponse_ResponseStatus.CONTINUE,
          headerMutation: {
            setHeaders: toProtoSetHeaders(common?.headerMutation?.setHeaders ?? []),
            removeHeaders: common?.headerMutation?.removeHeaders ?? [],
          },
        },
      },
    },
  });
}

function continueResponse(): ProcessingResponse {
  return create(ProcessingResponseSchema, {
    response: {
      case: "requestHeaders",
      value: { response: { status: CommonResponse_ResponseStatus.CONTINUE } },
    },
  });
}

function internalError500(): ProcessingResponse {
  return create(ProcessingResponseSchema, {
    response: {
      case: "immediateResponse",
      value: {
        status: { code: 500 as StatusCode },
        body: toBytes("Internal routing error"),
      },
    },
  });
}

// Reject a handler promise after `ms` so a slow request is shed deterministically
// *before* the ext_proc deadline, instead of piling up. NOTE: this only bounds
// ASYNC slowness (e.g. middleware awaiting a slow upstream) — a synchronously
// CPU-blocking middleware stalls the single event loop and the timer can't fire;
// isolating that needs worker threads (future work).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`routing handler timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Builds the bidi-streaming Process handler. Exported for unit testing without
// standing up a server.
export function createProcessHandler(
  handler: RoutingServerOptions["handler"],
  failOpen: boolean,
  timeoutMs = 0,
) {
  return async function* process(
    requests: AsyncIterable<ProcessingRequest>,
  ): AsyncGenerator<ProcessingResponse> {
    for await (const req of requests) {
      const requestHeaders = requestHeadersToPlain(req);
      if (!requestHeaders) continue;
      try {
        const result = await withTimeout(handler(requestHeaders), timeoutMs);
        yield plainResponseToProto(result);
      } catch (err) {
        console.error("ext_proc handler error:", err);
        yield failOpen ? continueResponse() : internalError500();
      }
    }
  };
}

// A lightweight plaintext HTTP health endpoint on a side port. A TCP probe passes
// at the socket layer even when the event loop is wedged; an httpGet probe must be
// *processed* by the loop, so a blocked/broken service fails it and gets evicted —
// which is the failure the ext_proc callout would otherwise hit silently.
export function startHealthServer(port: number, isReady: () => boolean): HealthServer {
  const srv = createHttpServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/readyz") {
      const ready = isReady();
      res.writeHead(ready ? 200 : 503, { "content-type": "text/plain" });
      res.end(ready ? "ok" : "not-ready");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.listen(port, "0.0.0.0", () => console.log(`Routing health server on port ${port}`));
  return { close: () => new Promise<void>((r) => srv.close(() => r())) };
}
interface HealthServer {
  close(): Promise<void>;
}

export function createRoutingServer(options: RoutingServerOptions) {
  const { handler, port, failOpen = true, timeoutMs = 0 } = options;

  const processImpl = createProcessHandler(handler, failOpen, timeoutMs);
  const routes = (router: ConnectRouter) =>
    router.service(ExternalProcessor, { process: processImpl });

  // GCP ext_proc callouts require HTTP/2 over TLS on the data path (the gRPC health
  // check can be plaintext, which is why an h2c server looks HEALTHY but the callout
  // silently fails). Serve TLS when a cert is provided; fall back to plaintext h2c
  // (emulate / local) otherwise. allowHTTP1 stays OFF on the TLS server: the ext_proc
  // data path is HTTP/2-only and health checks run on the separate plaintext HTTP
  // server, so HTTP/1.1 would be pure attack surface (it lets any Connect-protocol
  // client speak to the service trivially).
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  const useTls = !!(certFile && keyFile && existsSync(certFile) && existsSync(keyFile));
  const nodeHandler = connectNodeAdapter({ routes });
  const server: Http2Server = useTls
    ? createSecureServer(
        { cert: readFileSync(certFile!), key: readFileSync(keyFile!), allowHTTP1: false },
        nodeHandler,
      )
    : createServer(nodeHandler);
  console.log(`Routing service transport: ${useTls ? "TLS (h2)" : "plaintext (h2c)"}`);

  return {
    start(): Promise<{ port: number }> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", () => {
          const address = server.address();
          const boundPort = typeof address === "object" && address ? address.port : port;
          console.log(`Routing service listening on port ${boundPort}`);
          resolve({ port: boundPort });
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },

    get server() {
      return server;
    },
  };
}
