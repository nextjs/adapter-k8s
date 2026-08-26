import {
  context,
  isSpanContextValid,
  metrics,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Context,
  type Histogram,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
} from "@opentelemetry/api";

const INSTRUMENTATION_NAME = "@next-community/adapter-k8s";

// The app can register its provider through a DIFFERENT physical copy of @opentelemetry/api than
// the copy esbuild placed in this adapter bundle. A tracer acquired before that registration
// belongs to this copy's private proxy and never receives the other copy's delegate. Resolve the
// tracer at span start, after pool startup awaited instrumentation.ts; getTracer() then sees the
// process-global provider. Metrics are likewise acquired lazily on the first request.

interface RequestMetricInstruments {
  count: Counter;
  duration: Histogram;
}

let routingRequestInstruments: RequestMetricInstruments | undefined;
let poolRequestInstruments: RequestMetricInstruments | undefined;

function getRoutingRequestInstruments(): RequestMetricInstruments {
  const meter = metrics.getMeter(INSTRUMENTATION_NAME);
  return (routingRequestInstruments ??= {
    count: meter.createCounter("adapter_k8s.routing.request.count", {
      description: "Requests processed by the adapter-k8s ext_proc routing service",
      unit: "{request}",
    }),
    duration: meter.createHistogram("adapter_k8s.routing.request.duration", {
      description: "Time spent processing an adapter-k8s ext_proc routing request",
      unit: "s",
    }),
  });
}

function getPoolRequestInstruments(): RequestMetricInstruments {
  const meter = metrics.getMeter(INSTRUMENTATION_NAME);
  return (poolRequestInstruments ??= {
    count: meter.createCounter("adapter_k8s.pool.request.count", {
      description: "Requests processed by an adapter-k8s pool server",
      unit: "{request}",
    }),
    duration: meter.createHistogram("adapter_k8s.pool.request.duration", {
      description: "Time spent processing an adapter-k8s pool request",
      unit: "s",
    }),
  });
}

export type TraceHeaderCarrier = Record<string, string | string[] | undefined>;

const COMMON_HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]);
const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Provider identity emitted by the target compiler; ignore an invalid operator override. */
export function runtimeTelemetryAttributes(): Attributes {
  const providerName = process.env.ADAPTER_K8S_PROVIDER_NAME;
  return providerName && PROVIDER_NAME_RE.test(providerName)
    ? { "adapter_k8s.provider.name": providerName }
    : {};
}

/** Bound the user-controlled HTTP method metric dimension. */
export function metricHttpMethod(method: string | undefined): string {
  const normalized = method?.toUpperCase() ?? "";
  return COMMON_HTTP_METHODS.has(normalized) ? normalized : "_OTHER";
}

const traceHeaderGetter: TextMapGetter<TraceHeaderCarrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => carrier[key.toLowerCase()],
};

const traceHeaderSetter: TextMapSetter<Record<string, string>> = {
  set: (carrier, key, value) => {
    carrier[key.toLowerCase()] = value;
  },
};

/**
 * Extract the configured propagator's context from HTTP headers.
 *
 * `preferActive` is for the pool HTTP boundary: when node:http auto-instrumentation has already
 * created a server span, our adapter span must be its child instead of a sibling reconstructed
 * from the same wire header. The ext_proc routing service passes false because a Connect stream
 * can carry many independent HTTP callouts; each request's own trace header is authoritative.
 */
export function requestParentContext(carrier: TraceHeaderCarrier, preferActive: boolean): Context {
  const active = context.active();
  const activeSpanContext = trace.getSpanContext(active);
  if (preferActive && activeSpanContext && isSpanContextValid(activeSpanContext)) return active;
  try {
    // A Connect ext_proc stream can stay open across many unrelated HTTP requests. Starting from
    // ROOT_CONTEXT for that tier prevents header-less requests from all becoming children of one
    // long-lived transport span. The pool uses its active node:http span when one exists.
    return propagation.extract(ROOT_CONTEXT, carrier, traceHeaderGetter);
  } catch {
    // Observability is never allowed to change dataplane availability. A broken custom
    // propagator degrades to an unparented/no-op adapter span; the request still runs.
    return preferActive ? active : ROOT_CONTEXT;
  }
}

export interface AdapterSpanScope {
  /** Undefined only when a custom tracer provider itself threw while starting the span. */
  span?: Span;
  /** The span-bearing context to use for propagation to the next process. */
  spanContext: Context;
}

/** Run work inside one adapter-owned span without letting telemetry failures fail the request. */
export async function withAdapterSpan<T>(
  name: string,
  parentContext: Context,
  attributes: Attributes,
  run: (scope: AdapterSpanScope) => Promise<T>,
): Promise<T> {
  let span: Span;
  try {
    const tracer = trace.getTracer(INSTRUMENTATION_NAME);
    span = tracer.startSpan(name, { kind: SpanKind.INTERNAL, attributes }, parentContext);
  } catch {
    return run({ spanContext: parentContext });
  }

  const spanContext = trace.setSpan(parentContext, span);
  try {
    return await context.with(spanContext, run, undefined, { span, spanContext });
  } catch (err) {
    recordSpanError(span, err);
    throw err;
  } finally {
    try {
      span.end();
    } catch {
      // A provider/exporter bug is telemetry loss, not a request failure.
    }
  }
}

export function setSpanAttributes(span: Span | undefined, attributes: Attributes): void {
  try {
    span?.setAttributes(attributes);
  } catch {
    // See withAdapterSpan: all observability hooks fail open with respect to the dataplane.
  }
}

export function recordSpanError(span: Span | undefined, err: unknown): void {
  try {
    span?.recordException(err instanceof Error ? err : String(err));
    span?.setStatus({ code: SpanStatusCode.ERROR });
  } catch {
    // See withAdapterSpan.
  }
}

export function setSpanHttpStatus(span: Span | undefined, statusCode: number): void {
  setSpanAttributes(span, { "http.response.status_code": statusCode });
  if (statusCode >= 500) {
    try {
      span?.setStatus({ code: SpanStatusCode.ERROR });
    } catch {
      // See withAdapterSpan.
    }
  }
}

/**
 * Inject only W3C trace context into a pool-bound request.
 *
 * The global propagator may also carry baggage. The adapter intentionally does not INJECT or
 * rewrite baggage: it is operator-controlled, can be large or sensitive, and the ext_proc tier
 * has a strict request-header budget before Node starts answering 431. Existing request baggage
 * remains ordinary pass-through data-plane state. Standard NodeSDK setup uses a W3C
 * trace-context propagator, producing the two fields accepted below.
 */
export function injectTraceHeaders(
  spanContext: Context,
  setHeader: (key: "traceparent" | "tracestate", value: string) => void,
): void {
  const carrier: Record<string, string> = {};
  try {
    propagation.inject(spanContext, carrier, traceHeaderSetter);
  } catch {
    return;
  }
  for (const key of ["traceparent", "tracestate"] as const) {
    const value = carrier[key];
    if (value) setHeader(key, value);
  }
}

function recordRequestMetrics(
  instruments: RequestMetricInstruments,
  durationMs: number,
  attributes: Attributes,
): void {
  try {
    instruments.count.add(1, attributes);
    instruments.duration.record(Math.max(0, durationMs) / 1_000, attributes);
  } catch {
    // A custom meter provider/exporter must never participate in request correctness.
  }
}

export function recordRoutingRequest(durationMs: number, attributes: Attributes): void {
  try {
    recordRequestMetrics(getRoutingRequestInstruments(), durationMs, attributes);
  } catch {
    // getMeter/createInstrument can be implemented by operator-provided code too.
  }
}

export function recordPoolRequest(durationMs: number, attributes: Attributes): void {
  try {
    recordRequestMetrics(getPoolRequestInstruments(), durationMs, attributes);
  } catch {
    // See recordRoutingRequest.
  }
}
