import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { create } from "@bufbuild/protobuf";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { context, metrics, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createPoolServer } from "../src/pool-server/server.js";
import { recordDispatchProofRejected } from "../src/telemetry.js";
import type { DispatchProofRejectionReason } from "../src/routing-common.js";
import { createProcessHandler } from "../src/routing-service/server.js";
import {
  ProcessingRequestSchema,
  type ProcessingRequest,
  type ProcessingResponse,
} from "../src/routing-service/protos/envoy/service/ext_proc/v3/external_processor_pb.js";
import type { ProcessingResponse as PlainProcessingResponse } from "../src/routing-service/ext-proc-types.js";

// telemetry.ts is imported transitively ABOVE, before these providers are registered. Production
// also has two physical API copies: one bundled into the adapter and one used by the app's
// instrumentation hook. Register through a throwaway SECOND copy below so the test catches any
// adapter tracer/meter cached against its own private no-op API state.
const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spanExporter)],
});
const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  // Tests call forceFlush explicitly; keep the background interval out of the way.
  exportIntervalMillis: 60_000,
});
const meterProvider = new MeterProvider({ readers: [metricReader] });
const contextManager = new AsyncLocalStorageContextManager();
const appApiRoot = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-otel-api-"));
const rootRequire = createRequire(import.meta.url);
const installedApiDir = path.resolve(
  path.dirname(rootRequire.resolve("@opentelemetry/api")),
  "../..",
);
const copiedApiDir = path.join(appApiRoot, "node_modules", "@opentelemetry", "api");
mkdirSync(path.dirname(copiedApiDir), { recursive: true });
cpSync(installedApiDir, copiedApiDir, { recursive: true });
const appApi = createRequire(path.join(appApiRoot, "app.cjs"))(
  "@opentelemetry/api",
) as typeof import("@opentelemetry/api");
const originalProviderName = process.env.ADAPTER_K8S_PROVIDER_NAME;

beforeAll(() => {
  process.env.ADAPTER_K8S_PROVIDER_NAME = "nginx-ingress";
  appApi.context.setGlobalContextManager(contextManager.enable());
  appApi.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  appApi.trace.setGlobalTracerProvider(tracerProvider);
  appApi.metrics.setGlobalMeterProvider(meterProvider);
});

afterAll(async () => {
  await tracerProvider.shutdown();
  await meterProvider.shutdown();
  trace.disable();
  metrics.disable();
  propagation.disable();
  context.disable();
  if (originalProviderName === undefined) delete process.env.ADAPTER_K8S_PROVIDER_NAME;
  else process.env.ADAPTER_K8S_PROVIDER_NAME = originalProviderName;
  rmSync(appApiRoot, { recursive: true, force: true });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function* once<T>(value: T): AsyncGenerator<T> {
  yield value;
}

function routingCallout(traceparent?: string): ProcessingRequest {
  const headers = [
    { key: ":path", rawValue: encoder.encode("/products/one") },
    { key: ":method", rawValue: encoder.encode("GET") },
    // The adapter deliberately MUTATES traceparent/tracestate only; Envoy may still
    // pass this original baggage through unchanged with the rest of the request.
    { key: "baggage", rawValue: encoder.encode("account.id=private") },
  ];
  if (traceparent) headers.push({ key: "traceparent", rawValue: encoder.encode(traceparent) });
  return create(ProcessingRequestSchema, {
    request: {
      case: "requestHeaders",
      value: {
        headers: { headers },
      },
    },
  });
}

async function collect(
  generator: AsyncGenerator<ProcessingResponse>,
): Promise<ProcessingResponse[]> {
  const responses: ProcessingResponse[] = [];
  for await (const response of generator) responses.push(response);
  return responses;
}

describe("adapter-owned OpenTelemetry bindings", () => {
  it("continues one trace from ext_proc through the pool and application work", async () => {
    const clientTraceId = "0123456789abcdef0123456789abcdef";
    const clientSpanId = "0123456789abcdef";
    const handler = vi.fn(async () => {
      // The routing handler runs inside the adapter routing span, so middleware/resolution spans
      // created here naturally become children.
      expect(trace.getActiveSpan()?.spanContext().traceId).toBe(clientTraceId);
      return {
        requestHeaders: {
          response: {
            status: "CONTINUE",
            headerMutation: {
              setHeaders: [
                {
                  header: { key: "x-upstream-pool", value: "web" },
                  appendAction: "OVERWRITE_IF_EXISTS_OR_ADD",
                },
              ],
            },
          },
        },
      } satisfies PlainProcessingResponse;
    });
    const process = createProcessHandler(handler, false);
    const [routingResponse] = await collect(
      process(once(routingCallout(`00-${clientTraceId}-${clientSpanId}-01`))),
    );

    expect(routingResponse?.response.case).toBe("requestHeaders");
    if (routingResponse?.response.case !== "requestHeaders") throw new Error("wrong response");
    const mutations = routingResponse.response.value.response?.headerMutation?.setHeaders ?? [];
    const propagated = Object.fromEntries(
      mutations.map((entry) => [
        entry.header?.key.toLowerCase(),
        decoder.decode(entry.header?.rawValue),
      ]),
    );
    expect(propagated.traceparent).toMatch(new RegExp(`^00-${clientTraceId}-[0-9a-f]{16}-01$`));
    expect(propagated).not.toHaveProperty("baggage"); // no adapter-authored baggage mutation

    const appTracer = appApi.trace.getTracer("test-app");
    const pool = createPoolServer({
      port: 0,
      poolName: "web",
      onRequest: async (_req, res) => {
        expect(trace.getActiveSpan()?.spanContext().traceId).toBe(clientTraceId);
        appTracer.startActiveSpan("app.render", (span) => span.end());
        res.writeHead(201);
        res.end("created");
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { port } = await pool.start();
      const response = await fetch(`http://127.0.0.1:${port}/products/one`, {
        headers: { traceparent: propagated.traceparent! },
      });
      expect(response.status).toBe(201);
      await response.text();
    } finally {
      await pool.close();
      logSpy.mockRestore();
    }

    await tracerProvider.forceFlush();
    const spans = spanExporter.getFinishedSpans();
    const routingSpan = spans.find((span) => span.name === "adapter-k8s.routing.request");
    const poolSpan = spans.find((span) => span.name === "adapter-k8s.pool.request");
    const appSpan = spans.find((span) => span.name === "app.render");
    expect(routingSpan?.spanContext().traceId).toBe(clientTraceId);
    expect(routingSpan?.parentSpanContext?.spanId).toBe(clientSpanId);
    expect(poolSpan?.parentSpanContext?.spanId).toBe(routingSpan?.spanContext().spanId);
    expect(appSpan?.parentSpanContext?.spanId).toBe(poolSpan?.spanContext().spanId);
    expect(routingSpan?.attributes).toMatchObject({
      "adapter_k8s.provider.name": "nginx-ingress",
      "adapter_k8s.routing.result": "routed",
      "adapter_k8s.pool.name": "web",
      "http.request.method": "GET",
    });
    expect(poolSpan?.attributes).toMatchObject({
      "adapter_k8s.provider.name": "nginx-ingress",
      "adapter_k8s.pool.name": "web",
      "adapter_k8s.pool.result": "ok",
      "http.response.status_code": 201,
    });
  });

  // Runs BEFORE the rejection-counter test below on purpose: that counter is created lazily, so
  // a clean process exports exactly these four.
  it("exports the four bounded request metrics", async () => {
    await meterProvider.forceFlush();
    const names = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .map((metric) => metric.descriptor.name);
    expect(new Set(names)).toEqual(
      new Set([
        "adapter_k8s.routing.request.count",
        "adapter_k8s.routing.request.duration",
        "adapter_k8s.pool.request.count",
        "adapter_k8s.pool.request.duration",
      ]),
    );
  });

  it("exports the dispatch-proof rejection counter, keyed by every documented reason", async () => {
    // A0-DP-2. The pool's proof-rejection branch used to be entirely silent, which is how a
    // canonicalization bug could keep trusted dispatch permanently off (middleware running twice
    // per request) with nothing to see in logs or metrics. Lazily created, so it appears only once
    // a rejection has actually happened — which is also why the metric-set test below still lists
    // four instruments for a clean process.
    //
    // The label's value set is pinned BY TYPE as well as by assertion: `Record<union, true>` fails
    // to compile until a new DispatchProofRejectionReason member is listed here. `body-mismatch`
    // is why that matters — it is raised after the body is read (enforceDispatchBodyBinding), not
    // by the header verdict, so it drifted in as a sixth label value that the exported reason type
    // did not list and a `reason: string` parameter could not catch. It is also the one value that
    // means an active replay attempt rather than a configuration problem, so a dashboard built
    // from the type silently omitted the alert worth having.
    const REASONS: Record<DispatchProofRejectionReason, true> = {
      malformed: true,
      mismatch: true,
      "invalid-utf8": true,
      stale: true,
      premature: true,
      "body-unexpected": true,
      "body-mismatch": true,
    };
    const reasons = Object.keys(REASONS) as DispatchProofRejectionReason[];
    for (const reason of reasons) recordDispatchProofRejected(reason);
    await meterProvider.forceFlush();
    const counter = metricExporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "adapter_k8s.pool.dispatch_proof.rejected");
    expect(counter).toBeDefined();
    expect(
      counter!.dataPoints.map((point) => point.attributes["adapter_k8s.dispatch_proof.reason"]),
    ).toEqual(expect.arrayContaining(reasons));
  });

  it("does not parent independent headerless requests to a long-lived Connect span", async () => {
    const transportTracer = appApi.trace.getTracer("test-connect-transport");
    await transportTracer.startActiveSpan("connect.stream", async (transportSpan) => {
      const handler = vi.fn(async () => {
        expect(trace.getActiveSpan()?.spanContext().spanId).not.toBe(
          transportSpan.spanContext().spanId,
        );
        return {
          requestHeaders: { response: { status: "CONTINUE" } },
        } satisfies PlainProcessingResponse;
      });
      const process = createProcessHandler(handler, false);
      await collect(process(once(routingCallout())));
      transportSpan.end();
    });

    await tracerProvider.forceFlush();
    const routingSpan = spanExporter
      .getFinishedSpans()
      .filter((span) => span.name === "adapter-k8s.routing.request")
      .at(-1);
    expect(routingSpan?.parentSpanContext).toBeUndefined();
  });

  it("continues the routing span to the pool after a fail-open error", async () => {
    const clientTraceId = "1123456789abcdef0123456789abcdef";
    const clientSpanId = "1123456789abcdef";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const process = createProcessHandler(async () => {
        throw new Error("routing failed");
      }, true);
      const [routingResponse] = await collect(
        process(once(routingCallout(`00-${clientTraceId}-${clientSpanId}-01`))),
      );

      expect(routingResponse?.response.case).toBe("requestHeaders");
      if (routingResponse?.response.case !== "requestHeaders") throw new Error("wrong response");
      const mutations = routingResponse.response.value.response?.headerMutation?.setHeaders ?? [];
      const propagated = Object.fromEntries(
        mutations.map((entry) => [
          entry.header?.key.toLowerCase(),
          decoder.decode(entry.header?.rawValue),
        ]),
      );
      expect(propagated.traceparent).toMatch(new RegExp(`^00-${clientTraceId}-[0-9a-f]{16}-01$`));

      await tracerProvider.forceFlush();
      const routingSpan = spanExporter
        .getFinishedSpans()
        .filter((span) => span.name === "adapter-k8s.routing.request")
        .at(-1);
      expect(propagated.traceparent).toContain(`-${routingSpan?.spanContext().spanId}-`);
      expect(routingSpan?.status.code).toBe(SpanStatusCode.ERROR);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
