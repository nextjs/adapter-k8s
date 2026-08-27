# Kubernetes targets

`defineTarget` composes four independent layers into a single deployment target. Each layer is a component with a typed `build()` hook. The compiler turns the composition into one versioned plan that every lifecycle command consumes. Deploy, rollback, doctor, describe, and destroy read the same cluster identity, API requirements, readiness checks, diagnostics, and cleanup ownership.

| Layer     | Built-ins                                                                      | Extension hook            |
| --------- | ------------------------------------------------------------------------------ | ------------------------- |
| cluster   | `kubernetesCluster`, `gkeCluster`                                              | `defineClusterComponent`  |
| exposure  | `httpRouteExposure`, `gatewayApiExposure`, `ingressExposure`, `manualExposure` | `defineExposureComponent` |
| routing   | `portableRouting`, `envoyNativeRouting`, `gkeNativeRouting`                    | `defineRoutingComponent`  |
| resources | none required                                                                  | `defineResourceComponent` |

- **cluster** — how the CLI reaches the cluster (kubeconfig context or `gcloud get-credentials`), how it verifies it's the _right_ cluster, how images are pushed and digests resolved, and where the NetworkPolicy CIDRs come from.
- **exposure** — how traffic enters: an HTTPRoute attached to an existing shared Gateway, a Gateway API Gateway + HTTPRoute the release owns, an Ingress, or nothing (you own the exposure).
- **routing** — where `@next/routing` executes: in the application origin (portable, the default), or at the data plane as an ext_proc callout (Envoy Gateway in-cluster, or a GKE traffic extension).
- **resources** — additional typed Kubernetes objects deployed and cleaned up with the release.

Routing defaults to `portableRouting()` when omitted.

## Portable Gateway API or Ingress

Gateway API and Ingress are exposure choices, not providers. With the default portable routing, Next.js routing executes in the application origin and no Envoy CRD is emitted. The generated objects use the selected standard API; controller-specific TLS, streaming, and policy behavior still belongs to the operator's verification matrix:

```js
import {
  createK8sAdapter,
  defineTarget,
  ingressExposure,
  kubernetesCluster,
} from "@next-community/adapter-k8s";

export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pagesApi"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },
  target: defineTarget({
    cluster: kubernetesCluster({
      access: { kind: "kubeconfig-context", context: "production" },
      identity: {
        kind: "kubernetes-namespace-uid",
        namespace: "kube-system",
        uid: "EXPECTED-CLUSTER-UID",
      },
    }),
    exposure: ingressExposure({
      className: "nginx",
      hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
      tlsSecretName: "app-tls",
    }),
  }),
});
```

Use `gatewayApiExposure` instead for a GatewayClass whose controller behavior you have verified.

**One requirement on whatever terminates TLS.** The pool's own socket is always plaintext, so
`x-forwarded-proto` is its only witness of the client-facing scheme: it decides middleware's
request URL, whether a middleware redirect `Location` is same-origin, and the origin a WebSocket
handshake's `Origin` header is compared against. **It must reach the pool single-valued, written by
the hop that terminated TLS.** Envoy — and Envoy Gateway, with the default zero trusted hops —
overwrites it from the downstream connection's TLS state, so both emitted topologies satisfy this
with no configuration. Two ways operator-supplied ingress can break it:

- **Forwarding a client-supplied value unchanged.** Then an https app evaluates its own routing
  against a scheme the client chose. Overwrite it at the edge.
- **An appending intermediary between the TLS terminator and the pool.** Append conventions are
  client-first (the `X-Forwarded-For` ordering, standardized in RFC 7239), so a second hop turns
  the header into `https,http` — its own plaintext observation on the right. The adapter reads the
  **leftmost** element, so it still derives `https`, but Next's own `x-forwarded-proto` handling
  treats only the exact single value `https` as secure and will read `http` from that chain
  regardless. Anything the app derives itself (absolute URLs, its own redirects) is then wrong even
  though adapter-level routing is right. Configure the inner hop to overwrite, not append.

### TLS for dedicated exposures (cert-manager)

A dedicated Gateway or Ingress terminates TLS from a Secret **in the app's namespace** — Gateway `certificateRefs` and Ingress `spec.tls` are namespace-local. Wildcard-cert fleets typically keep their certificate in the gateway owner's namespace (e.g. `network`), so no such Secret exists per app namespace. Both dedicated exposures accept `certManager` to emit a `cert-manager.io/v1` Certificate that issues it in place:

```js
exposure: gatewayApiExposure({          // or ingressExposure({ className: "nginx", ...
  className: "eg",
  hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
  certManager: {
    issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" }, // or kind: "Issuer" (+ optional group)
  },
}),
```

- **Secret naming.** `tlsSecretName` becomes the Certificate's `secretName` when both are set; without it the Secret derives as `<release>-tls`. The Certificate object shares the Secret's name (cert-manager's own convention), so re-emits are idempotent and GitOps diffs stay stable.
- **`dnsNames`** covers every `tls.enabled` host in the exposure.
- **Preflight** checks the `cert-manager.io/v1` `certificates` API exists (same mechanism as the Gateway API CRD checks) and **readiness** gates on the Certificate's `Ready` condition alongside the exposure's own readiness — a deploy will not cut traffic to a listener whose certificate never issued.
- **Validation**: `certManager` with no `tls.enabled` host is a config error (nothing would reference the cert), as is combining it with `controllerManagedTls` (two certificate managers for one listener). `issuerRef.name` must name the existing issuer exactly and is asserted K8s-safe, never sanitized.
- **Why a Certificate object rather than the `cert-manager.io/cluster-issuer` annotation on Ingress**: the emitted Certificate is adapter-owned (visible in the bundle diff, cleaned up with the release), its `Ready` condition is checkable by a name known at render time, the CRD requirement is preflight-checked, and `issuerRef` can express namespaced `Issuer`s and external issuer groups — the ingress-shim annotation can do none of that, and the Certificate it creates behind the scenes is invisible to readiness. If you want the annotation path anyway it needs no adapter surface: pass it via `annotations` with a `tlsSecretName`, and ingress-shim owns issuance (no readiness gate).
- **Wildcard-cert fleets**: if the cluster already runs shared Gateways with fleet-managed TLS, prefer [`httpRouteExposure`](#shared-gateways-recommended-for-clusters-with-existing-gateways) — the route inherits the parent Gateway's termination and needs no per-namespace Secret, no Certificate, and none of this section.

## Shared Gateways (recommended for clusters with existing Gateways)

Most fleets already run shared Gateways — a home-ops cluster typically has `envoy-external` and `envoy-internal` in a `network` namespace, with TLS, DNS, cert-manager, and tunnel ingress solved once for every app. `httpRouteExposure` is the exposure for that pattern: it emits **exactly one HTTPRoute** in the app's namespace, attached to the named parent Gateway(s) via `spec.parentRefs`, and nothing else — no per-app Gateway (which would spawn a whole proxy deployment and LoadBalancer IP), no Certificate, no traffic policies. TLS terminates at the parent; certificates and DNS remain the gateway owner's job, where the fleet already solves them.

```js
import {
  createK8sAdapter,
  defineTarget,
  httpRouteExposure,
  kubernetesCluster,
} from "@next-community/adapter-k8s";

export default createK8sAdapter({
  pools: {
    default: { routes: ["appPages", "appRoutes"], scaling: { min: 2, max: 6, targetCPU: 70 } },
  },
  target: defineTarget({
    cluster: kubernetesCluster({
      access: { kind: "kubeconfig-context", context: "home-ops" },
      identity: {
        kind: "kubernetes-namespace-uid",
        namespace: "kube-system",
        uid: "EXPECTED-CLUSTER-UID",
      },
    }),
    exposure: httpRouteExposure({
      className: "envoy", // the shared GatewayClass
      parentRefs: [{ name: "envoy-external", namespace: "network", sectionName: "https" }],
      hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
    }),
  }),
});
```

Notes on this journey:

- **parentRefs are verbatim.** Each `name` must match an existing Gateway exactly; `namespace` defaults to the release namespace (per Gateway API); `sectionName` picks a listener (e.g. `"https"`). The parent Gateway's `allowedRoutes` must admit the app's namespace — deploy surfaces `Accepted=False` / `NotAllowedByListeners` in-band if it doesn't, and `NoMatchingListenerHostname` when the hostnames don't intersect the listener.
- **Readiness** gates on the emitted HTTPRoute reporting `Accepted=True` and `ResolvedRefs=True` from **every** named parent, and on every named parent having reported at all — a parentRef naming a nonexistent Gateway produces no status entry, which would otherwise pass silently. Failure output includes each parent Gateway's programmed address.
- **`host.tls.enabled`** only informs post-deploy verification (which scheme to probe); it has no structural effect — termination is the parent's.
- **No HTTP→HTTPS redirect route is emitted.** On a typical fleet the shared gateway's http listener already carries a fleet-wide redirect; a per-app redirect would require the owner to permit a second attach on the http listener and buys nothing there.
- **Escaped slashes**: `gatewayApiExposure` + `envoyNativeRouting` normally emits a `ClientTrafficPolicy` (`escapedSlashesAction: KeepUnchanged`) for `next start` parity on paths like `/a%2Fb`. A ClientTrafficPolicy is Gateway-scoped and namespace-local, so it **cannot** reach a shared Gateway in another namespace — and Envoy Gateway rejects a second conflicting CTP per listener anyway. With a cross-namespace parent, the policy is suppressed automatically and an explicit `escapedSlashes: "policy"` is a build error. Escaped-slash parity becomes a documented requirement on the shared gateway's owner (a CTP or EnvoyPatchPolicy in the gateway's namespace).
- **Envoy Gateway version floor** for `envoyNativeRouting` on this exposure: the EnvoyExtensionPolicy attaches to the app's HTTPRoute by name (route-scoped ext_proc — the callout fires only for this app's route, not every app on the shared gateway). Route-targeted ext_proc requires **Envoy Gateway ≥ 1.1.0**; the adapter's live-verified range is **>=1.5.4 <1.9** (see [Envoy Gateway native routing](#envoy-gateway-native-routing)).

### NetworkPolicy under `strict` with a shared gateway

The shared gateway's proxy pods live in the **parent's** namespace, not the app's. Under `networkPolicy.strict`, `ingressSources` is the allowlist admitting traffic to the pools (`:3000`) and the routing tier (`:8443`) — and because the routing tier authenticates no callers, reachability to `:8443` is what decides who can obtain a pool-trusted routing verdict. Omitting `ingressSources` with strict NetworkPolicy means an **empty allowlist**: the shared gateway's proxies are blocked and every request fails closed.

Both selector values are static strings (the parent's namespace is known at config time):

```js
exposure: httpRouteExposure({
  className: "envoy",
  parentRefs: [{ name: "envoy-external", namespace: "network", sectionName: "https" }],
  hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
  ingressSources: {
    cidrs: [],
    podSelectors: [
      {
        // The proxy namespace — where the Envoy data-plane pods run
        // (e.g. "envoy-gateway-system", or "network" if proxies deploy beside the Gateway).
        namespace: "network",
        labels: {
          "app.kubernetes.io/name": "envoy",
          "gateway.envoyproxy.io/owning-gateway-name": "envoy-external",
          "gateway.envoyproxy.io/owning-gateway-namespace": "network",
        },
      },
      {
        // Merged/class-owned proxies (EnvoyProxy mergeGateways) carry ONLY the class label,
        // never the per-gateway pair above.
        namespace: "network",
        labels: {
          "app.kubernetes.io/name": "envoy",
          "gateway.envoyproxy.io/owning-gatewayclass": "envoy",
        },
      },
    ],
  },
}),
```

The proxy-pod labels are verified against a live Envoy Gateway v1.5.4 data plane — the data-plane pods carry `app.kubernetes.io/name: envoy` plus the `owning-gateway-{name,namespace}` (or, merged, `owning-gatewayclass`) labels; the controller deployment does not serve traffic.

Notes on this journey:

- **Cluster access and identity.** Pinning `access` to a named kubeconfig context and `identity` to the cluster's `kube-system` namespace UID makes a deploy refuse to run against the wrong cluster. If either is left at its default (`kubeconfig-current-context`, `unverified`), the CLI requires explicit confirmation of the current context before mutating anything (`--yes` in CI).
- **Registry.** The CLI reads `containerRegistry` from `.k8s-adapter/infrastructure.json`—create it by hand for an existing cluster (see the README quick start). Digest lookup uses the OCI distribution API by default; authentication uses your ambient credentials.
- **TLS** terminates from a Kubernetes Secret; `tls.enabled` without a TLS source (`tlsSecretName` or [`certManager`](#tls-for-dedicated-exposures-cert-manager)) is a config error.
- **CDN**: put any CDN in front of the exposure. The routing tier always runs post-cache (see the architecture note in the README).
- **Cache**: bring your own Valkey/Redis via `cache.url`. Enabling the cache without a URL is a managed-cache request and fails unless a target component contributes a concrete provisioning operation. `kubernetesCluster()` deliberately contributes none. Disabling the cache makes ISR/PPR revalidation per-replica. See [configuration](./configuration.md#distributed-cache-cache-components--ppr).

## Envoy Gateway native routing

Add `envoyNativeRouting()` only when the selected GatewayClass is managed by Envoy Gateway and ext_proc routing is desired: middleware, rewrites, and redirects then execute at the gateway, before a request reaches any pool.

```js
target: defineTarget({
  cluster: kubernetesCluster(),
  exposure: gatewayApiExposure({
    className: "eg",
    hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
    tlsSecretName: "app-tls",
  }),
  routing: envoyNativeRouting(),
}),
```

```
   Internet --> [your CDN, optional] --> Envoy Gateway (in-cluster)
                                                |
                                         EnvoyExtensionPolicy
                                                | ext_proc (h2c)
                                    +-----------v------------+
                                    |    Routing Service     |
                                    |      @next/routing     |
                                    +-----------+------------+
                                                | sets x-upstream-pool
                                          HTTPRoute --> Pools
```

- **Gateway class** must be controlled by `gateway.envoyproxy.io/gatewayclass-controller`—`deploy` verifies the extension policy reports `Accepted=True` before cutting traffic. A non-Envoy class would program the Gateway and then silently never call the routing service.
- **Verified Envoy Gateway range: >=1.5.4 <1.9.** The adapter's full surface (ext_proc, ClientTrafficPolicy, deploy gates, cutover, rollback) is live-verified on Envoy Gateway v1.5.4, v1.5.5, and v1.8.3 — identical manifests Accepted on all, no adapter-visible behavior change between 1.5.5 and 1.8.3 (1.6/1.7 are untested but inside the range). `deploy` and `doctor` print a soft warning (never a failure) when the detected controller image is outside this range.
- **Streaming timeout parity:** generated application rules set `timeouts.request: 0s`. Envoy's
  default is a 15-second whole-response deadline, which is inappropriate for Route Handler
  streams, RSC, and SSE because it expires even while a response is making progress. Disabling
  that total deadline does not make dead requests immortal: the pool still bounds time to response
  headers and route `maxDuration`, and Envoy retains its stream-idle timeout. Applications using
  SSE should send periodic comment heartbeats frequently enough for their operator's gateway/CDN
  idle timeout.
- **Upgrading Envoy Gateway 1.5.x → 1.8.x in place: apply the CRDs first.** `helm upgrade` never touches the chart's `crds/` subchart, and Envoy Gateway ≥ 1.8 unconditionally watches `ListenerSet` — so an in-place upgrade crashloops the new controller with `no matches for kind "ListenerSet" in version "gateway.networking.k8s.io/v1"`. Server-side-apply the chart's CRD bundle **before** upgrading the controller (verified live: applied over live CRDs with no data loss, traffic served throughout):

  ```bash
  helm pull oci://docker.io/envoyproxy/gateway-helm --version v1.8.3 --untar
  kubectl apply --server-side --force-conflicts -f gateway-helm/charts/crds/crds/gatewayapi-crds.yaml
  kubectl apply --server-side --force-conflicts -f gateway-helm/charts/crds/crds/generated/
  ```

  `doctor` reports the ListenerSet CRD's presence as an informational line when the controller is ≥ 1.8.

- **An explicit `ingressSources` override replaces the strict default entirely** — including the two proxy-pod selector sets the adapter emits by default (the per-gateway `owning-gateway-{name,namespace}` pair AND the merged-mode `owning-gatewayclass` label). Non-merged proxy pods carry only the per-gateway pair, never the class label (verified in Envoy Gateway source at v1.5.5 and v1.8.3: the class label is applied only under `mergeGateways`). An override listing only the class label therefore blocks Envoy→ext_proc under `networkPolicy.strict`, and because the routing tier fails closed when the app has middleware, the symptom is total: every request returns 500 (`ext_proc_error_gRPC_error_14`) and pool traffic 503s. If you override `ingressSources`, include the per-gateway labels (`gateway.envoyproxy.io/owning-gateway-name: <release>-gateway`, `gateway.envoyproxy.io/owning-gateway-namespace: <ns>`) unless the EnvoyProxy resource sets `mergeGateways: true`.
- **NetworkPolicy** is what isolates the routing tier in-cluster, so your CNI must enforce it (verified on Cilium). The in-cluster callout is plain h2c and the routing service authenticates no callers, so reachability to it is enough to have a crafted request resolved and signed — the dispatch credential is no longer readable off the wire, but the policy is still a required boundary rather than defense-in-depth. See [SECURITY.md](../SECURITY.md#generic-clusters-envoy-gateway).
- **Node CIDRs.** Left unconfigured, `deploy` discovers the node addresses and allows exactly those—correct, but a snapshot: a node added afterwards can't probe the pods it hosts, so they never become ready. On any cluster that autoscales or replaces nodes, pin the node subnet with a static CIDR source on the cluster component (or `nodeCidrs` in the legacy `provider.generic` block).
- **Failure mode** follows the routing-service policy: fail-closed when the app has middleware, fail-open otherwise. See [routing service tuning](./configuration.md#routing-service-tuning).

## Managed GKE

The GKE journey provisions its own infrastructure. `init` idempotently creates the cluster, static IP, Artifact Registry repo, GCS bucket, IAM service accounts, and managed TLS certificate, then scaffolds `adapter.config.mjs` and `.k8s-adapter/infrastructure.json`:

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
```

The GKE target composes `gkeCluster()` + `gatewayApiExposure` (controller-managed TLS via Certificate Manager) + `gkeNativeRouting()`, which hosts the ext_proc callout on the Google load balancer as a traffic extension:

```
                 GCP Global External Application Load Balancer
+---------------------------------------------------------------------+
|                                                                     |
|  Internet --> URL Map --> [Cloud CDN] --cache hit--> response       |
|                                |                                    |
|                            cache miss                               |
|                                |                                    |
|                    +-----------v------------+                       |
|                    |   Traffic Extension    |  CEL match condition  |
|                    |       (ext_proc)       |  skips /_next/static/ |
|                    |  Routing Service:      |  + uncovered public/  |
|                    |    @next/routing       |                       |
|                    +-----------+------------+                       |
|                                | sets x-upstream-pool               |
|             HTTPRoute header routing on x-upstream-pool             |
+--------------------------------+------------------------------------+
                                 |
                          +------v-------+
                          |  GKE Cluster |
                          |  Pool A / B  |
                          +--------------+
```

The callout arrives over server-authenticated TLS from Google's frontend, unlike the in-cluster h2c path. This protects transport to the expected server but does not authenticate the caller to the routing service; NetworkPolicy remains required. GKE-specific features on this journey:

- **Cloud CDN** with a Next.js-aware cache key and per-build cache-tag purge on cutover—see [configuration](./configuration.md#cloud-cdn-gke).
- **Managed Memorystore-for-Valkey** provisioning for the distributed cache, created with AUTH + TLS by default—see [configuration](./configuration.md#distributed-cache-cache-components--ppr) and [SECURITY.md](../SECURITY.md#cache-security). Both the legacy GKE preset and an explicit target using `gkeCluster()` compile an enabled cache without `cache.url` into the same verified `gcp-memorystore` operation and deployment path.
- **Split cloud IAM**: a minimally-scoped in-cluster identity and a push-capable CLI identity no pod can assume—see [SECURITY.md](../SECURITY.md#cloud-iam-two-identities-split-by-pod-assumability).

## Custom cluster components

Cluster components declare operations rather than a provider name. This example uses ordinary kubeconfig, OCI registry APIs, and Kubernetes-discovered network ranges:

```js
const clusterUid = process.env.CLUSTER_UID;
if (!clusterUid) throw new Error("CLUSTER_UID is required");

const cluster = defineClusterComponent({
  name: "on-prem",
  build(ctx) {
    return {
      identity: {
        kind: "kubernetes-namespace-uid",
        namespace: "kube-system",
        uid: clusterUid,
      },
      access: { kind: "kubeconfig-context", context: "on-prem" },
      registry: {
        repository: ctx.imageRegistry,
        authentication: { kind: "ambient-credentials" },
        digestLookup: { kind: "oci-distribution" },
      },
      network: {
        podCidrs: { kind: "kubernetes-node-pod-cidrs" },
        nodeCidrs: {
          kind: "kubernetes-node-addresses",
          addressTypes: ["InternalIP"],
        },
        missingSourcePolicy: "fail",
      },
    };
  },
});
```

Custom exposure and resource components emit typed Kubernetes objects. They must declare their API requirements and readiness conditions; the adapter checks them before mutation and records their exact object identities for rollback and cleanup. Raw YAML and inferred cloud names are deliberately outside this boundary.

Cluster or resource components may also return `cache: CacheProvisioning` when the build context requests a managed cache. The compiler accepts exactly one contribution, fingerprints it, validates the operation through the composition-plan parser, and derives its cleanup operation. Do not branch on provider names: a target that cannot provision the requested cache should contribute nothing, which produces an actionable build error. External `cache.url` and disabled-cache builds remain operator-managed and `none` respectively.

Any cluster, exposure, routing, or resource component can also return `telemetry: TelemetrySource[]`. A source identifies its producer and owner, activation mechanism, protocols, propagation, signal names, workloads, and static attributes. The compiler merges the sources, rejects duplicate IDs and the adapter-reserved `adapter.*` prefix, includes them in the target fingerprint, and stores them for `describe` and `doctor`. A project-owned NGINX ingress component can declare Prometheus or OTLP signals without adding an `if nginx` branch to the compiler. This is inventory. It cannot run callbacks, choose exporters, or mutate a shared controller.

Configure an operator-managed Valkey or Redis endpoint through `cache.url`. `gkeCluster()` is the only built-in managed-cache contributor today; other cluster types intentionally make no cloud assumption. This keeps a future managed-cache component additive without coupling Kubernetes access, registry, exposure, or routing to a provider enum.

## Writing a routing adapter

A routing adapter is a routing component created with `defineRoutingComponent`. Keep exposure and routing separate. `ingressExposure({ className: "nginx" })` already supports ingress-nginx with portable routing. ingress-nginx does not have an ext_proc integration, so it is not a native routing adapter. A controller-specific native adapter only makes sense when that controller can run `@next/routing` before the origin and pass the resulting dispatch decision to the selected pool.

The routing component interface has two methods:

- `origin(context)` returns the destination that an exposure should reference. The only supported kind today is `{ kind: "kubernetes-service", service }`. The explicit kind leaves room for a future proxy origin without pretending it already works. It must return the same result for the same context.
- `build(context)` returns the routing plan, routing-tier settings, Kubernetes objects, API requirements, readiness checks, diagnostics, cleanup operations, and telemetry. An enabled tier must state its caller-authentication posture. Both current native tiers declare no caller authentication and require enforced NetworkPolicy. Envoy uses cleartext h2c. GKE adds server-authenticated TLS, which does not authenticate the caller.

### Deferred proxy origins and BYOC migration

The `RoutingOrigin` discriminant intentionally leaves room for an external proxy origin, including
an incremental migration between a customer's Kubernetes deployment and Vercel or another control
plane. Version 0.1 supports only `{ kind: "kubernetes-service", service }`; there is no proxy mode
or Vercel integration to enable.

A future origin kind must define, and test, at least this contract before it can ship:

1. Stable external-origin identity, certificate validation, and TLS policy.
2. Explicit path ownership and fallback behavior when only part of an application has migrated.
3. Authentication plus stripping of internal dispatch and forwarding headers at both trust
   boundaries.
4. Request/response streaming, cancellation, body limits, and WebSocket upgrade semantics.
5. Health and readiness signals that can block cutover rather than silently falling back.
6. Cache ownership and middleware ordering that cannot turn an external cache hit or proxy failure
   into a middleware bypass.

That contract can later support a Vercel control plane or BYOC product without teaching the pool
runtime about a specific vendor. The discriminant is preparation for that work, not an implemented
proxy.

The adapter's internal `compileTarget` enforces the contract before it emits YAML. It rejects invalid Service references, pool-local plans that enable a routing tier, ext_proc plans that omit one, transport disagreements, failure-policy disagreements, unknown fields, duplicate objects, unsafe ownership labels, and invalid composition-plan values. The TypeScript types reject the same plan and tier mismatches during development. Contributor tests may import it from `@next-community/adapter-k8s/internal`; that subpath deliberately has no compatibility guarantee.

External control-plane attachment is an authenticated composition-plan operation, separate from the routing-tier interface. The only executor today is `gcp-traffic-extension-v1`, which runs the GKE registration job; a future control plane must add its own versioned operation, parser, executor, readiness proof, and cleanup instead of adding a provider field to `RoutingBuildResult`. A third-party component cannot select an unknown executor or smuggle an arbitrary command through the plan.

Start a routing adapter test at the public interface:

```ts
import { compileTarget } from "@next-community/adapter-k8s/internal";

const compiled = compileTarget(
  defineTarget({
    cluster: kubernetesCluster(),
    exposure: myCompatibleExposure,
    routing: myRoutingAdapter(),
  }),
  {
    releaseName: "conformance",
    namespace: "apps",
    buildId: "build-123",
    imageRegistry: "registry.example.com/team/app",
    pools: ["default", "api"],
    defaultPool: "default",
    failurePolicy: "closed",
  },
);

expect(compiled.plan.operations.routing.failurePolicy).toBe("closed");
expect(compiled.plan.operations.resources.objects).toContainEqual(
  expect.objectContaining({ kind: "YourRoutingPolicy" }),
);
```

Compilation is the first conformance level, not the last. A native routing adapter also needs controller-backed tests for all of these behaviors:

1. Middleware, redirects, rewrites, and headers match `next start`.
2. A client cannot smuggle trusted dispatch headers to a pool.
3. The declared failure policy matches controller behavior when the routing service is unavailable. Middleware-covered routes must fail closed.
4. Request bodies arrive byte-for-byte, response streaming starts before completion, and WebSocket upgrades work when the controller claims support.
5. Every emitted object reports the readiness condition the adapter declared. A missing controller or rejected attachment must block cutover with a useful reason.
6. Cleanup removes adapter-owned objects and leaves shared Gateways, certificates, controllers, and namespaces alone.
7. NetworkPolicy enforcement is verified on the tested CNI. API discovery alone does not prove enforcement, and the h2c routing service does not authenticate callers itself.

Record the controller name, controller version, Kubernetes version, CRD versions, CNI, transport, and tested failure mode in [verification](./verification.md). Do not add a provider enum or a branch in the target compiler. New cluster and registry support belongs in cluster components, ingress choices belong in exposure components, native request dispatch belongs here, and managed dependencies belong in resource components. This keeps a future EKS or other cluster adapter independent from its registry and ingress choices without implementing those adapters today.

## Legacy provider configuration

`provider.gke` and `provider.generic` remain accepted through the 0.x release line and are planned for removal in 1.0. One internal translator maps them to built-in target definitions. Managed cache no longer depends on this compatibility layer. It remains because `init` still scaffolds `provider.gke`, Cloud CDN has no composed target operation/emitter yet, and the legacy GKE route-extension timeout still lives under `provider.gke.serviceExtensions`. New integrations must use `target: defineTarget(...)`. Do not extend the provider union. Configuring both `target` and `provider` is an error because they can select different clusters and routing paths.

### `provider.generic`

Any conformant cluster: k3s, kind, on-prem, or a managed cluster whose cloud integrations you'd rather not adopt. Translates to `kubernetesCluster` + `gatewayApiExposure` + `envoyNativeRouting`.

```js
provider: {
  generic: {
    gateway: {
      className: 'eg',                  // must be an Envoy Gateway class
      hosts: [{ hostname: 'app.example.com', tls: { enabled: true } }],
      tlsSecretName: 'app-tls',         // required when TLS is enabled
    },
    gatewayNamespace: 'envoy-gateway-system',
    nodeCidrs: ['10.0.0.0/16'],         // optional; see the node-CIDR note above
  },
},
```

`gatewayNamespace` is the namespace where the Gateway controller runs its proxy pods—the source the emitted NetworkPolicy admits to the routing tier's ext_proc port. It defaults to Envoy Gateway's `envoy-gateway-system`. Note this is the proxies' namespace, not the app's.

### `provider.gke`

Translates to `gkeCluster` + `gatewayApiExposure` (controller-managed certificates, named address) + `gkeNativeRouting`. `provider.gke.gateway.type: "ingress"` is rejected—the GKE traffic extension requires Gateway API.

## See also

- [Configuration reference](./configuration.md) — pools, env, cache, container strategy, variants
- [Lifecycle](./lifecycle.md) — deploy, rollback, destroy, doctor semantics
- [Verification](./verification.md) — what each target journey has been validated against
- [SECURITY.md](../SECURITY.md) — the trust boundaries per target
