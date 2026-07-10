import { describe, it, expect, vi, afterEach } from "vitest";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  createRoutingServer,
  createProcessHandler,
  plainResponseToProto,
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

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("creates an HTTP/2 ext_proc server that can start and stop", async () => {
    const handler = vi.fn().mockResolvedValue({
      requestHeaders: { response: { headerMutation: { setHeaders: [] }, status: "CONTINUE" } },
    } as PlainProcessingResponse);

    server = createRoutingServer({ handler, port: 0 });
    const address = await server.start();
    expect(address.port).toBeGreaterThan(0);
    await server.stop();
    server = null;
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
          status: "CONTINUE",
        },
      },
    });
    const decoded = fromBinary(ProcessingResponseSchema, toBinary(ProcessingResponseSchema, proto));
    expect(decoded.response.case).toBe("requestHeaders");
    if (decoded.response.case !== "requestHeaders") throw new Error("wrong case");
    const common = decoded.response.value.response!;
    expect(common.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
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
});
