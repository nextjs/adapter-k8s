# OpenTelemetry runtime bindings

Status: request-boundary bindings and provider-contributed telemetry inventory implemented on
`codex/otel-runtime-bindings`.

## What exists today

The adapter already preserves an application's own Next.js instrumentation:

- pool images stage `instrumentation.js` and its traced/external dependencies;
- the pool awaits Next's `ensureInstrumentationRegistered()` before it listens, sharing Next's
  memoized registration promise so an SDK is never started twice;
- `/readyz` stays unavailable when registration throws; and
- existing tests cover early-acquired OTEL tracers and the dependency-staging failures previously
  found in the Next deploy suite.

That is application instrumentation support, not adapter instrumentation. Before this branch the
routing service, pool request boundary, dispatcher, Valkey client, PPR orchestration, and deploy
lifecycle created no adapter-owned spans or metrics. The observability section of the main design
document described a target state, not shipped behavior.

## First PR boundary

The first slice adds `@opentelemetry/api` as the only production dependency and remains
provider-neutral:

- no SDK, exporter, collector, sidecar, or vendor package is selected by the adapter;
- all hooks are no-op when no provider is registered;
- telemetry-provider failures are caught and never change a dataplane response;
- the pool's adapter span becomes active around its request handler, so Next/application spans
  are children of it;
- the ext_proc service extracts the configured trace context, creates a routing span, and mutates
  `traceparent` / `tracestate` on pool-bound requests to continue that span;
- request counters and duration histograms use bounded attributes only; and
- the target compiler records adapter and provider-contributed telemetry sources in the authenticated
  composition plan and fingerprints them as part of target compatibility.

The pool can use the provider registered by the app's normal `instrumentation.ts`. The routing
service does not currently execute that hook; it exports only when an SDK/provider is preloaded or
injected into that process before its first request. Choosing a durable routing-provider injection
surface is deliberately a follow-up rather than smuggling an SDK policy into this API binding PR.

## Signal contract in this slice

| Signal                                 | Kind/unit            | Attributes                                                                                            |
| -------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `adapter-k8s.routing.request`          | internal span        | component, normalized HTTP method, result, resolved pool when present, immediate-response HTTP status |
| `adapter-k8s.pool.request`             | internal span        | component, normalized HTTP method, pool, result, HTTP status                                          |
| `adapter_k8s.routing.request.count`    | counter, `{request}` | component, normalized HTTP method, result, resolved pool when present                                 |
| `adapter_k8s.routing.request.duration` | histogram, seconds   | same as routing count                                                                                 |
| `adapter_k8s.pool.request.count`       | counter, `{request}` | component, normalized HTTP method, result, HTTP status, pool                                          |
| `adapter_k8s.pool.request.duration`    | histogram, seconds   | same as pool count                                                                                    |

The metric method vocabulary is `GET`, `HEAD`, `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, and
`_OTHER`. Paths, query strings, headers, hostnames, error messages, route params, and trace IDs are
not metric attributes. Pool names are build-configured and bounded. Status codes are bounded by
the HTTP vocabulary. Every adapter-owned signal also carries the validated
`adapter_k8s.provider.name` selected by the routing target component.

Tracers, meters, and metric instruments are resolved lazily. This is a correctness requirement,
not an optimization. The app can register through a different physical copy of
`@opentelemetry/api` than the adapter bundle; a tracer acquired earlier belongs to the adapter
copy's private no-op proxy and does not receive the other copy's delegate. `metrics.getMeter()`
also returns the current provider's meter rather than a proxy, and an instrument created against
the initial no-op meter stays no-op. The pool awaits instrumentation registration before accepting
a request, so request-time lookup observes the process-global provider.

## Propagation model

```text
incoming traceparent
       │
       ▼
adapter-k8s.routing.request
       │  ext_proc overwrites traceparent/tracestate with the routing span context
       ▼
adapter-k8s.pool.request
       │  active context around dispatch/render
       ▼
Next.js and application spans
```

Only `traceparent` and `tracestate` are authored by the adapter. A configured composite propagator
may extract baggage so in-process instrumentation can read it, but the adapter does not inject or
rewrite baggage. Existing baggage remains ordinary Envoy/request pass-through state. This avoids
growing the already-strict pool header budget with adapter-authored baggage.

When the routing process has no provider, its span is no-op and no trace-header mutation is added;
the original incoming trace headers continue to the pool unchanged. That preserves the client's
trace continuity without pretending a routing span was exported.

If node:http auto-instrumentation has already created a pool server span, the adapter prefers that
active context and creates its pool span beneath it. Without auto-instrumentation it extracts the
wire context directly. This avoids sibling spans for the same request.

## Provider and deployment choices

Top-level adapter `env` / `envFrom` already reaches both the routing-service container and pool
containers because Node middleware executes in the routing tier. Pool-specific `env` can override
the top-level values. This is enough to carry standard `OTEL_*` exporter/resource configuration,
but environment alone does not install an SDK.

Recommended direction:

1. Keep the API bindings in the runtime bundle and keep SDK/exporter ownership outside it.
2. Add an explicit pod-template annotation/injection seam for an OpenTelemetry Operator (or a
   narrowly-scoped preload module seam) so the routing process can get a provider reproducibly.
3. Continue using the app's Next instrumentation hook for pool processes; do not start a second
   adapter-owned SDK in the same process.
4. Never deploy a collector implicitly. A shared collector/agent is cluster infrastructure; a
   chart option may reference it, but should not create fleet-wide policy as a side effect of an
   application build.

Reusing the app's compiled `instrumentation.js` inside the routing image remains an alternative,
but it needs a separate proof: the routing context does not carry every app-server asset, and an
instrumentation hook may reasonably assume the complete Next server image. Staging and running it
without that proof turns observability into a routing-service CrashLoop risk.

## Provider-contributed telemetry

Telemetry is cross-cutting target composition, not an Envoy-only feature. Cluster, exposure,
routing, and resource components already contribute Kubernetes objects, API requirements,
readiness, cleanup, and diagnostics. They can now contribute telemetry without the core compiler
learning conditionals such as `if nginx` or `if envoy`.

There are two separate extension planes:

1. **Runtime signals.** Source code the adapter owns imports one fail-safe telemetry core and
   creates its own scoped spans/instruments. A future Envoy binding, NGINX routing process, cache
   provider, or image service can add signals next to the operation it owns. It must not import an
   exporter or start an SDK. Common operations keep common names plus a bounded provider
   attribute; genuinely provider-specific operations use a provider namespace.
2. **Deployment and inventory.** Target components contribute a declarative description of signal
   producers, propagation, activation, ownership, and expected signals. The compiler merges and
   fingerprints it into the composition plan so deploy, rollback, doctor, describe, and generated
   docs all see the same topology. Concrete components can also emit the Kubernetes resources they
   own through the existing contribution mechanism.

A component returns `telemetry: TelemetrySource[]` alongside its existing operational
contributions. `TelemetrySource` is exported from the package and serialized without executable
callbacks:

```ts
interface TelemetrySource {
  id: string;
  producer: {
    kind: "adapter-runtime" | "data-plane" | "ingress-controller" | "managed-provider";
    name: string;
  };
  owner: "adapter" | "application" | "operator" | "cloud-provider";
  activation:
    | { kind: "app-instrumentation-hook" }
    | { kind: "otel-operator"; instrumentation: KubernetesObjectRef }
    | { kind: "external-precondition"; description: string }
    | { kind: "managed" };
  protocols: Array<"otel-api" | "otlp" | "prometheus" | "cloud-managed">;
  propagation: Array<"tracecontext" | "tracestate" | "baggage-pass-through">;
  signals: TelemetrySignal[];
  workloads: TelemetryWorkload[];
  attributes: Record<string, string>;
}
```

Signals and workloads are closed discriminated unions. The parser bounds collection sizes and
attribute cardinality, validates names, rejects duplicate source IDs, and rejects provider sources
using the adapter-reserved `adapter.*` prefix. The inventory is part of the target fingerprint, so
rollback cannot silently combine a build with a different telemetry topology. Older authenticated
v1alpha1 plans remain valid: the parser preserves an absent telemetry field rather than changing
their digest.

Examples:

- **Envoy Gateway / GKE traffic extensions:** the compiler records the adapter ext_proc runtime
  source under the selected routing provider. A routing component can additionally declare native
  Envoy or managed load-balancer sources when it actually owns or can verify them; none are implied
  today.
- **Future NGINX Ingress:** code shipped by this project can create
  `adapter_k8s.provider.nginx_ingress.*` signals through the shared runtime core. If the target
  creates a per-application NGINX workload, it can emit its activation objects too. If it points at
  a shared operator-owned controller, the application chart records/verifies an external
  precondition; it must not mutate a cluster-wide controller ConfigMap behind the operator's back.
- **Manual/direct exposure:** contributes no ingress producer, while pool runtime signals still
  work. Missing provider-level signals are an explicit capability result, not a fake zero-valued
  metric.

Provider support therefore does not mean every topology promises identical internals. It means
each target declares which signal sources and propagation edges exist. `describe` and `doctor`
show the inventory count today; richer activation verification and collector/dashboard generation
can consume only the capabilities actually present.

Once a second adapter-owned producer exists, `src/telemetry.ts` should grow a small validated scope
factory for provider modules. The first request-boundary PR should not freeze that API before there
is a real second consumer.

## Follow-up slices

### Provider injection and resources

- Teach `describe` and `doctor` to report per-source activation details, missing activation, and
  broken collector reachability without making telemetry a deploy-readiness dependency by default.
- Give both pod templates a stable OTEL Operator/preload configuration surface.
- Establish resource attributes for release, namespace, build ID, component, and pool without
  duplicating `service.name` across routing and pool processes.
- Flush providers during bounded graceful shutdown when the provider exposes a supported hook;
  do not lengthen the existing termination bound indefinitely.

### Internal dataplane spans and metrics

- handler load/cold start;
- local resolution versus trusted dispatch;
- cross-pool proxy hops;
- handler invocation and response-head deadline;
- PPR preamble read and resume;
- background revalidation; and
- Valkey get/set/tag invalidation latency and outcome.

These need internal result types or callbacks rather than parsing logs/headers after the fact.
Attributes must remain bounded: use operation/result/pool/output template, never cache keys, raw
URLs, tag values, invocation queries, or exception messages as metric dimensions.

### Operations

- document collector examples for generic Kubernetes and Google Cloud exporters for GKE;
- add dashboard/alert examples only after metric names survive one compatibility cycle; and
- add trace/log correlation when structured JSON logging is implemented (the current request logs
  are human-readable despite the older design document's target-state wording).

## Tests and acceptance

This slice's integration test registers real in-memory OTEL trace and metric providers _after_ the
adapter modules load, then proves:

- adapter modules can load before a provider registered through a separate physical API copy;
- metrics are not lost to an early no-op meter;
- one trace continues from an incoming client span through routing, pool, and an application span;
- ext_proc authors no baggage mutation;
- routing/pool result attributes are present; and
- the four request metrics export.

A later end-to-end fixture should run an OTLP collector and verify exported signals from both pod
types. It should remain Docker/cluster-gated; unit tests stay hermetic.
