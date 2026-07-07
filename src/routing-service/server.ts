import { createServer, type Http2Server } from "node:http2";
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

// Builds the bidi-streaming Process handler. Exported for unit testing without
// standing up a server.
export function createProcessHandler(handler: RoutingServerOptions["handler"], failOpen: boolean) {
  return async function* process(
    requests: AsyncIterable<ProcessingRequest>,
  ): AsyncGenerator<ProcessingResponse> {
    for await (const req of requests) {
      const requestHeaders = requestHeadersToPlain(req);
      if (!requestHeaders) continue;
      try {
        const result = await handler(requestHeaders);
        yield plainResponseToProto(result);
      } catch (err) {
        console.error("ext_proc handler error:", err);
        yield failOpen ? continueResponse() : internalError500();
      }
    }
  };
}

export function createRoutingServer(options: RoutingServerOptions) {
  const { handler, port, failOpen = true } = options;

  const processImpl = createProcessHandler(handler, failOpen);
  const routes = (router: ConnectRouter) =>
    router.service(ExternalProcessor, { process: processImpl });

  // Plaintext HTTP/2 (h2c) matches the previous insecure gRPC transport; Envoy
  // ext_proc connects over gRPC, which Connect serves natively over HTTP/2.
  const server: Http2Server = createServer(connectNodeAdapter({ routes }));

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
