# Kubernetes targets

`defineTarget` composes four independent layers into a single deployment target. Each layer is a component with a typed `build()` hook; the compiler turns the composition into one versioned plan that every lifecycle command consumes—deploy, rollback, doctor, describe, and destroy all read the same plan, including cluster identity, API requirements, readiness, diagnostics, and exact cleanup ownership.

| Layer     | Built-ins                                                   | Extension hook            |
| --------- | ----------------------------------------------------------- | ------------------------- |
| cluster   | `kubernetesCluster`, `gkeCluster`                           | `defineClusterComponent`  |
| exposure  | `gatewayApiExposure`, `ingressExposure`, `manualExposure`   | `defineExposureComponent` |
| routing   | `portableRouting`, `envoyNativeRouting`, `gkeNativeRouting` | `defineRoutingComponent`  |
| resources | none required                                               | `defineResourceComponent` |

- **cluster** — how the CLI reaches the cluster (kubeconfig context or `gcloud get-credentials`), how it verifies it's the _right_ cluster, how images are pushed and digests resolved, and where the NetworkPolicy CIDRs come from.
- **exposure** — how traffic enters: a Gateway API Gateway + HTTPRoute, an Ingress, or nothing (you own the exposure).
- **routing** — where `@next/routing` executes: in the application origin (portable, the default), or at the data plane as an ext_proc callout (Envoy Gateway in-cluster, or a GKE traffic extension).
- **resources** — additional typed Kubernetes objects deployed and cleaned up with the release.

Routing defaults to `portableRouting()` when omitted.

## Portable Gateway API or Ingress

Gateway API and Ingress are exposure choices, not providers. With the default portable routing, Next.js routing executes in the application origin and no Envoy CRD is emitted—any conformant cluster and any conformant controller works:

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

Use `gatewayApiExposure` instead for any conformant GatewayClass.

Notes on this journey:

- **Cluster access and identity.** Pinning `access` to a named kubeconfig context and `identity` to the cluster's `kube-system` namespace UID makes a deploy refuse to run against the wrong cluster. If either is left at its default (`kubeconfig-current-context`, `unverified`), the CLI requires explicit confirmation of the current context before mutating anything (`--yes` in CI).
- **Registry.** The CLI reads `containerRegistry` from `.k8s-adapter/infrastructure.json`—create it by hand for an existing cluster (see the README quick start). Digest lookup uses the OCI distribution API by default; authentication uses your ambient credentials.
- **TLS** terminates from a Kubernetes Secret; `tls.enabled` without `tlsSecretName` is a config error.
- **CDN**: put any CDN in front of the exposure. The routing tier always runs post-cache (see the architecture note in the README).
- **Cache**: bring your own Valkey/Redis via `cache.url`. Disabling the cache makes ISR/PPR revalidation per-replica. Set `managedCache: "none"` for custom clusters—managed cache provisioning is currently supplied only by the GKE preset. See [configuration](./configuration.md#distributed-cache-cache-components--ppr).

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
- **NetworkPolicy** is what isolates the routing tier in-cluster, so your CNI must enforce it (verified on Cilium). The in-cluster callout is plain h2c; reachability to the routing service is equivalent to holding the dispatch credential. See [SECURITY.md](../SECURITY.md#generic-clusters-envoy-gateway).
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

The callout arrives from Google's frontend over TLS—a stronger trust story than the in-cluster h2c path. GKE-specific features on this journey:

- **Cloud CDN** with a Next.js-aware cache key and per-build cache-tag purge on cutover—see [configuration](./configuration.md#cloud-cdn-gke).
- **Managed Memorystore-for-Valkey** provisioning for the distributed cache, created with AUTH + TLS by default—see [configuration](./configuration.md#distributed-cache-cache-components--ppr) and [SECURITY.md](../SECURITY.md#cache-security). Managed cache provisioning currently requires the legacy `provider.gke` config shape (which is what `init` scaffolds); a hand-written `target: defineTarget(...)` composition—including `gkeCluster()`—must set `cache.url` when the cache is enabled.
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
      managedCache: "none",
    };
  },
});
```

Custom exposure and resource components emit typed Kubernetes objects. They must declare their API requirements and readiness conditions; the adapter checks them before mutation and records their exact object identities for rollback and cleanup. Raw YAML and inferred cloud names are deliberately outside this boundary.

Set `managedCache: "none"` for custom clusters and configure an operator-managed Valkey/Redis endpoint through `cache.url`. Managed cache provisioning is currently supplied only by the GKE preset.

## Legacy provider configuration

`provider.gke` and `provider.generic` remain accepted for compatibility and are translated into built-in target components. New integrations should use `target: defineTarget(...)`; adding another provider enum is not required. Configuring both `target` and `provider` is an error—the two definitions can select different clusters and routing paths.

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
