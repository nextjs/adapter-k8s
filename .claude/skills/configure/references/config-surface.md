# adapter.config.mjs Surface

Everything here exists in `src/types.ts` (K8sAdapterConfig) and `src/target/components.ts`. Do not use keys not listed.

## Top-level `K8sAdapterConfig`

| Key                 | Type                                                        | Notes                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pools`             | `Record<string, PoolConfig>`                                | Required; at least one pool, max 15                                                                                                                                                        |
| `defaultPool`       | `string`                                                    | Pool hosting the stable portable origin; defaults to first declared pool                                                                                                                   |
| `env`               | `Record<string, EnvValue>`                                  | Runtime env for every app container; uppercase names only; `NEXT_PUBLIC_*` and reserved names (`NODE_ENV`, `NEXT_BUILD_ID`, `POOL_NAME`, `RELEASE_NAME`, `PORT`, `VALKEY_*`, ...) rejected |
| `envFrom`           | `EnvFromSource[]`                                           | Bulk `envFrom`; individual `env` entries win                                                                                                                                               |
| `cache`             | see below                                                   | Shared Valkey/Redis for ISR/PPR/fetch cache                                                                                                                                                |
| `containerStrategy` | `'traced-assets' \| 'shared-image'`                         | Default `traced-assets` (per-pool minimal images)                                                                                                                                          |
| `imageOptimizer`    | `{ enabled: boolean; mode: 'sidecar' }`                     |                                                                                                                                                                                            |
| `skewProtection`    | `{ enabled: boolean; duration: string }`                    | Validates but throws at build time — not yet implemented                                                                                                                                   |
| `routeExtension`    | `{ mode: 'auto' \| 'wasm' \| 'extproc' }`                   |                                                                                                                                                                                            |
| `routingService`    | `{ resources?, scaling?, requestTimeoutMs?, failureMode? }` | `failureMode: 'auto'` (default) fails closed when middleware exists                                                                                                                        |
| `target`            | `defineTarget(...)`                                         | Preferred composition API                                                                                                                                                                  |
| `provider`          | `{ gke } \| { generic }`                                    | Deprecated legacy blocks; exactly one; never combined with `target`                                                                                                                        |

### `PoolConfig`

```js
{
  routes: ['appPages', 'appRoutes', 'pagesApi', 'pages'],  // output types or route-template globs; first match wins
  scaling: { min: 2, max: 10, targetCPU: 70 },
  resources: { cpu: '500m', memory: '512Mi', cpuLimit: '1', memoryLimit: '1Gi' },
  timeout: 30,                       // seconds to response headers
  env: { KEY: { secret: 'app-secrets', key: 'KEY' } },  // merged OVER top-level env
  envFrom: [{ secret: 'app-secrets' }],                 // appended AFTER top-level envFrom
}
```

Route globs match build-time template pathnames; dynamic segments are literal (`/blog/[slug]`, `(.)[slug]`), `**` and normal glob syntax work elsewhere (`/api/export/*`, `/api/v[12]/**`).

### `EnvValue` / `EnvFromSource`

```js
env: {
  LITERAL: 'value',                                       // rendered inline — never for credentials
  FROM_SECRET: { secret: 'name', key: 'KEY', optional: true },
  FROM_CM:     { configMap: 'name', key: 'KEY' },
},
envFrom: [
  { secret: 'app-secrets', prefix: 'APP_' },
  { configMap: 'app-config', optional: true },
],
```

### `cache`

```js
cache: {
  enabled: true,
  provider: 'valkey',              // or 'redis'
  url: 'rediss://host:6380',       // bring-your-own; skips managed provisioning
  password: process.env.CACHE_AUTH, // AUTH string (source from deploy environment, not a literal)
  memorystore: {                   // GKE managed path, used when url is absent
    region: 'us-central1',
    sizeGb: 1,
    tier: 'BASIC',                 // or 'STANDARD_HA'
    // auth: leave UNSET (defaults to on). true = require, false = explicit opt-out (warned every deploy)
  },
},
```

## Target components (`src/target/components.ts`)

| Layer     | Built-ins                                                                             | Custom hook               |
| --------- | ------------------------------------------------------------------------------------- | ------------------------- |
| cluster   | `kubernetesCluster(options?)`, `gkeCluster(options?)`                                 | `defineClusterComponent`  |
| exposure  | `gatewayApiExposure(opts)`, `ingressExposure(opts)`, `manualExposure(opts)`           | `defineExposureComponent` |
| routing   | `portableRouting()` (default), `envoyNativeRouting(opts?)`, `gkeNativeRouting(opts?)` | `defineRoutingComponent`  |
| resources | none required                                                                         | `defineResourceComponent` |

### `kubernetesCluster(options?)`

All optional. Defaults: unverified identity + current kubeconfig context (both require explicit confirmation at deploy), ambient registry credentials, OCI-distribution digest lookup, Kubernetes-discovered pod/node CIDRs.

```js
kubernetesCluster({
  identity: { kind: "kubernetes-namespace-uid", namespace: "kube-system", uid: "EXPECTED-UID" },
  access: { kind: "kubeconfig-context", context: "production" },
  registry: {
    authentication: { kind: "ambient-credentials" },
    digestLookup: { kind: "oci-distribution" },
  },
  network: {
    podCidrs: { kind: "kubernetes-node-pod-cidrs" },
    nodeCidrs: { kind: "static", cidrs: ["10.0.0.0/16"] }, // for autoscaling clusters
    missingSourcePolicy: "fail",
  },
});
```

### `gkeCluster(options?)`

`projectId` / `region` fall back to `.k8s-adapter/infrastructure.json`; missing both is a build error. `clusterName` defaults to `<releaseName>-cluster`. Artifact Registry (`*.pkg.dev`) registries get gcloud-helper auth and AR digest lookup automatically.

### `gatewayApiExposure(options)`

```js
gatewayApiExposure({
  className: 'eg',                                  // required; validated DNS-ish name
  hosts: [{ hostname: 'app.example.com', tls: { enabled: true } }],  // required, >= 1
  tlsSecretName: 'app-tls',       // required when TLS enabled, unless controllerManagedTls
  controllerManagedTls: true,     // controller terminates TLS (GKE certmap path)
  controllerManagedCertificate: { annotation: 'networking.gke.io/certmap', nameSuffix: '-certmap' },
  annotations: {},
  addresses: [{ type: 'IPAddress', value: '1.2.3.4' }],
  releaseAddresses: [{ type: 'NamedAddress', nameSuffix: '-ip' }],
  ingressSources: { cidrs: [], podSelectors: [{ namespace: 'envoy-gateway-system', labels: {...} }] },
})
```

Cannot mix TLS and plaintext hosts. Emits Gateway + HTTPRoute (+ HTTP→HTTPS redirect when TLS) and waits for `Programmed`/`Accepted`.

### `ingressExposure(options)`

`{ className, hosts, tlsSecretName?, annotations?, ingressSources? }` — `tlsSecretName` required when any host has TLS.

### `manualExposure(options)`

`{ hosts, ingressSources? }` — emits nothing; you own exposure. Routing defaults to portable.

### `envoyNativeRouting(options?)`

`{ gatewayClassName? /* default 'eg' */, messageTimeoutMs? /* default 4000 */, escapedSlashes? /* 'policy' | 'external' */ }`.
Requires the exposure to provide a Gateway API capability with the SAME class, and that class must be controlled by `gateway.envoyproxy.io/gatewayclass-controller` — emits `EnvoyExtensionPolicy` (+ `ClientTrafficPolicy` unless `escapedSlashes: 'external'`).

### `gkeNativeRouting(options?)`

`{ projectId?, addressName?, extensionName?, gatewayClassName? /* default 'gke-l7-global-external-managed' */ }` — GCP traffic-extension ext_proc over TLS. Requires matching Gateway API exposure and a projectId.

## Complete non-GKE example (Envoy Gateway)

```js
import {
  createK8sAdapter,
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  kubernetesCluster,
} from "@next-community/adapter-k8s";

export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pagesApi"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },
  cache: { enabled: true, provider: "valkey", url: "rediss://valkey.cache.svc:6379" },
  target: defineTarget({
    cluster: kubernetesCluster(),
    exposure: gatewayApiExposure({
      className: "eg",
      hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
      tlsSecretName: "app-tls",
      ingressSources: {
        cidrs: [],
        podSelectors: [
          {
            namespace: "envoy-gateway-system",
            labels: {
              "app.kubernetes.io/name": "envoy",
              "gateway.envoyproxy.io/owning-gatewayclass": "eg",
            },
          },
        ],
      },
    }),
    routing: envoyNativeRouting({ gatewayClassName: "eg" }),
  }),
});
```

## `.k8s-adapter/infrastructure.json` (hand-written for non-GKE)

```json
{
  "hosts": ["app.example.com"],
  "containerRegistry": "ghcr.io/acme/nextjs",
  "releaseName": "my-app",
  "namespace": "default"
}
```

`containerRegistry` is mandatory for `deploy` (image tags cannot be formed without it). `projectId`/`region`/`gcsBucket` are GKE-only fields. The persisted `releaseName` is what read-only commands (doctor/describe/rollback/tail/destroy) target — keep it in sync with what was deployed.
