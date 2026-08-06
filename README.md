# @next-community/adapter-k8s

Deploy full-fidelity Next.js—middleware, Partial Prerendering, cache components, ISR—to Kubernetes with a single command. The adapter plugs into Next.js 16.3+'s `adapterPath` API and generates everything from your build output—Helm charts, Dockerfiles, routing manifests—so your infrastructure evolves with your routes, not with hand-maintained YAML.

```bash
npx adapter-k8s deploy
```

Two providers ship today: **GKE** (Google's load balancer + Cloud CDN) and **generic** (any conformant cluster behind in-cluster [Envoy Gateway](https://gateway.envoyproxy.io/)). See [Providers](#providers).

## What it does

At build time, the adapter analyzes your route structure and generates:

- **Pool servers** that invoke your handlers directly via `import()`—no `next start`
- **A routing service** running `@next/routing` for middleware, rewrites, and redirects—attached to the data plane as an ext_proc extension
- **A Helm chart** with Deployments, Services, Gateway, HTTPRoute, and NetworkPolicies
- **Dockerfiles** containing only the traced assets each pool needs

At deploy time, the CLI builds and pushes images, then runs `helm upgrade` with zero-downtime blue/green cutover.

With a shared cache configured, **cache components, Partial Prerendering (PPR), and ISR** work correctly across replicas: cached entries are shared, and `revalidateTag` / `revalidatePath` on one pod is seen by all. See [Distributed Cache](#distributed-cache-cache-components--ppr).

CDN and middleware behavior are coordinated so cached responses can never bypass middleware-protected routes—see [Architecture](#architecture) for how.

## Status

**Framework compatibility is strongly validated; operational hardening remains.**

Middleware, PPR, cache components, and ISR are verified through the upstream Next.js e2e suite, local full-path emulation, and live multi-replica deployments on GKE and generic clusters—see [docs/verification.md](./docs/verification.md) for what each layer covers and what it can't. The aim is a reference implementation for running full-fidelity Next.js on Kubernetes; remaining work centers on load testing, throughput tuning, skew protection, and published benchmarks. Expect APIs and generated infrastructure to change as that work lands. Issues and contributions welcome.

## Requirements

- Node.js >= 20.9.0
- Next.js >= 16.3.0
- A Kubernetes cluster:
  - **GKE** (Autopilot or Standard) for `provider.gke`, plus `gcloud` in PATH
  - **any conformant cluster** for `provider.generic`, with [Envoy Gateway](https://gateway.envoyproxy.io/) installed and a CNI that enforces NetworkPolicy
- `kubectl` and Helm >= 3.2 in PATH, plus a container runtime—`docker`, `podman`, or `nerdctl`.
  Helm 3 uses its client-side upgrade path; Helm 4 uses server-side apply.

Emitted container images run **Node 24** (the generated routing manifest requires it; the build fails on older bases rather than 500ing at runtime).

### Reserved paths

`/healthz` (liveness) and `/readyz` (readiness + blue/green cutover gate) belong to the platform. A route, static output, or `public/` file at either path fails the build—a static 200 at `/readyz` could promote a broken pod, and a failing route there would block every deploy. Use `/health` or `/api/ready` instead.

## Quick Start

### 1. Install

```bash
npm install @next-community/adapter-k8s
```

### 2. Configure Next.js

Set the adapter via environment variable (no `next.config.ts` change needed):

```bash
NEXT_ADAPTER_PATH=@next-community/adapter-k8s
```

Or create `adapter.config.mjs` (scaffolded by `init`):

```js
import { createK8sAdapter } from "@next-community/adapter-k8s";

export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pagesApi"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        hosts: [
          {
            hostname: "app.example.com",
            tls: { enabled: true, managedCert: true },
          },
        ],
      },
    },
  },
});
```

### 3. Initialize infrastructure

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
```

Idempotently provisions the GKE cluster, static IP, Artifact Registry repo, GCS bucket, IAM service accounts, and managed TLS certificate. Add the DNS records printed at the end.

### 4. Deploy

```bash
npx adapter-k8s deploy
```

This builds and pushes per-pool images plus the routing service, provisions the managed cache if configured, runs `helm upgrade`, verifies the new pods are serving, and cuts traffic over blue/green. New deployments resolve every image to its immutable `@sha256:` registry digest and deploy that; the routing tier's _rollback_ path currently reconstructs its image reference from the build tag (digest-pinned rollback is on the [roadmap](#roadmap)).

## CLI Commands

| Command    | What it does                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | Provision cloud infrastructure and scaffold config. `--project-id`, `--region`, `--host`, `--dry-run`                                    |
| `deploy`   | Build, push, and deploy with blue/green cutover. `--skip-build`, `--skip-push`, `--dry-run`                                              |
| `rollback` | Return to the previous build—pools scale back up, the routing tier reverts, traffic cuts over. Symmetric: running it again rolls forward |
| `doctor`   | Health-check the whole stack: prerequisites, cloud resources, Kubernetes state, LB backend health, DNS + TLS                             |
| `emulate`  | Run the full request path locally: Envoy → routing service → pool server                                                                 |
| `describe` | Live architecture diagram of your deployment with pod counts and revision tags                                                           |
| `tail`     | Stream color-coded logs from all workloads                                                                                               |
| `destroy`  | Tear down release-scoped resources; shared infrastructure (cluster, registry, certs) is kept and reported                                |

Run any command with `--help` for the full flag set.

## Providers

Exactly one `provider` key selects the target. It decides how the routing tier attaches to the data plane—the one genuinely platform-specific part of the architecture.

| provider  | ingress                                 | ext_proc registration  | CDN       | managed cache   |
| --------- | --------------------------------------- | ---------------------- | --------- | --------------- |
| `gke`     | GXLB (`gke-l7-global-external-managed`) | traffic extension      | Cloud CDN | Memorystore     |
| `generic` | Envoy Gateway (`eg`)                    | `EnvoyExtensionPolicy` | BYO       | BYO `cache.url` |

`aks` and `eks` are planned and will use the `generic` shape.

### `provider.generic`

Any conformant cluster: k3s, kind, on-prem, or a managed cluster whose cloud integrations you'd rather not adopt.

```js
provider: {
  generic: {
    gateway: {
      className: 'eg',                  // must be an Envoy Gateway class
      hosts: [{ hostname: 'app.example.com', tls: { enabled: true } }],
      tlsSecretName: 'app-tls',         // required when TLS is enabled
    },
    gatewayNamespace: 'envoy-gateway-system',
    nodeCidrs: ['10.0.0.0/16'],         // optional; see NetworkPolicy note below
  },
},
```

- **Gateway class** must be controlled by `gateway.envoyproxy.io/gatewayclass-controller`—`deploy` verifies the extension policy reports `Accepted=True` before cutting traffic.
- **TLS** terminates from a Kubernetes Secret; `tls.enabled` without `tlsSecretName` is a config error.
- **Cache**: bring your own Valkey/Redis via `cache.url`. Disabling the cache makes ISR/PPR revalidation per-replica.
- **CDN**: put any CDN in front of the gateway. The routing tier always runs post-cache (see the note above).
- **NetworkPolicy** is what isolates the routing tier in-cluster, so your CNI must enforce it (verified on Cilium). See [SECURITY.md](./SECURITY.md).
- **`nodeCidrs`** is optional. Left unset, `deploy` discovers the node addresses and allows exactly those—correct, but a snapshot: a node added afterwards can't probe the pods it hosts, so they never become ready. Set it to your node subnet on any cluster that autoscales or replaces nodes.

### Config variants

`ADAPTER_K8S_CONFIG=scaleway npx adapter-k8s deploy` selects a complete target: `adapter.config.scaleway.mjs`, `.k8s-adapter/infrastructure.scaleway.json`, its own build output, and its own deploy state. One project can therefore target several clusters without editing files between deploys.

A requested variant must provide **both** the config and the infrastructure file—there is deliberately no fallback to the default. Falling back would build one cluster's config against another's registry, which is silent until pods try to pull images they have no credentials for.

## Configuration

### Pool decomposition

Split routes across independently scaling groups:

```js
pools: {
  ssr:   { routes: ["appPages"], scaling: { min: 2, max: 20, targetCPU: 70 } },
  api:   { routes: ["appRoutes", "pagesApi"], scaling: { min: 2, max: 10, targetCPU: 60 } },
  heavy: { routes: ["/api/generate-report", "/api/export/*"], scaling: { min: 1, max: 5, targetCPU: 50 } },
},
```

Routes match by output type (`appPages`, `appRoutes`, `pagesApi`) or glob pattern, first-match-wins in config order.

### Multiple hosts & wildcards

```js
gateway: {
  hosts: [
    { hostname: 'app.example.com', tls: { enabled: true, managedCert: true } },
    { hostname: '*.example.com',   tls: { enabled: true, managedCert: true } },
  ],
}
```

### Container strategy

```js
containerStrategy: 'traced-assets',  // default: per-pool minimal images
containerStrategy: 'shared-image',   // one image for all pools—simpler CI/CD
```

### Container runtimes

`deploy` probes for `docker`, `podman`, then `nerdctl` (force one with `ADAPTER_K8S_CONTAINER_CLI`). Each build publishes one platform, `linux/amd64` by default; set `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` while running `next build`/`adapter-k8s deploy` for ARM nodes. The platform is recorded in the build artifact, used for native Sharp packages and Docker builds, and enforced with a pod node selector. Changing it after a skipped build is rejected—rebuild instead. Sharp is the only native dependency the adapter retargets itself; staged foreign ELF, Mach-O, PE, Prisma engines, and `.node` addons fail the build. Prisma `linux-musl` engines are also rejected because the emitted runtime is Debian/glibc, even when their CPU architecture matches. Apps with other native dependencies must install and build them on a matching Linux runner/container. This does not publish a multi-architecture image index.

### Environment variables

`.env` files are never staged into an image — they routinely hold secrets, and an image layer
is a poor place for one. Runtime environment is supplied to the containers instead:

```js
export default createK8sAdapter({
  env: {
    API_URL: "https://api.example.com", // literal
    API_KEY: { secret: "app-secrets", key: "api-key" }, // -> secretKeyRef
    FLAGS: { configMap: "app-config", key: "flags" }, // -> configMapKeyRef
  },
  envFrom: [{ secret: "app-secrets" }, { configMap: "app-config", prefix: "CFG_" }],

  pools: {
    // Merged OVER the top-level map, so a pool can override a shared default.
    worker: { routes: ["pagesApi"], env: { TIER: "worker" } },
  },
});
```

You manage the referenced Secret/ConfigMap; the adapter only points at them. That is the
preferred shape for two reasons: `adapter.config.mjs` is committed, so a literal is the wrong
home for a credential — and the chart is emitted during `next build`, so changing a _literal_
needs a rebuild while changing a referenced Secret only needs a pod restart.

Precedence matches Next: the pool server calls `loadEnvConfig`, which does not overwrite an
already-set variable, so anything set here wins over a `.env` file the app loads itself.

**Not for `NEXT_PUBLIC_*`.** Those are inlined into client bundles at _build_ time; setting one
as container environment produces a value the browser never sees. The build fails rather than
let that pass silently — put them in `.env.production` or the build environment.

Names the adapter emits itself (`NODE_ENV`, `NEXT_BUILD_ID`, `POOL_NAME`, `RELEASE_NAME`,
`INTERNAL_HEADER_SECRET`, `VALKEY_*`, `PORT`, `CONFIG_DIR`) are reserved and rejected —
shadowing `NEXT_BUILD_ID` in particular would cross-wire two builds' cache namespaces.

### Cloud CDN (GKE)

```js
provider: {
  gke: {
    cdn: { enabled: true, bucket: 'my-project-nextjs-static' },
    gateway: { /* ... */ },
  },
},
```

The adapter attaches a Cloud CDN filter to the HTTPRoute with a Next.js-aware cache key (RSC/prefetch `Vary` headers partition App Router HTML and RSC payloads correctly). Mutable cacheable responses carry a per-build `Cache-Tag`, and `deploy`/`rollback` purge the outgoing build's tag on cutover—so a new build never serves the previous build's stale content from the edge. Content-hashed `/_next/static/*` assets are shared across builds and never purged.

### Distributed Cache (Cache Components & PPR)

Next's default `use cache` store is per-process, which diverges the moment you run more than one replica: pods cache different values, and `revalidateTag` on one pod is invisible to the others. Enable a shared cache so cache components, PPR, and ISR behave correctly across replicas.

Set `cacheComponents: true` in `next.config`, then:

```js
cache: {
  enabled: true,
  provider: 'valkey',                 // 'valkey' | 'redis' (wire-compatible)
  memorystore: {                      // managed (GKE): provisioned on deploy
    region: 'us-central1',
    sizeGb: 1,
    tier: 'BASIC',
  },
  //—or bring your own —
  // url: 'redis://my-valkey.internal:6379',
  // password: process.env.VALKEY_PASSWORD,
},
```

- Managed Memorystore instances are created **with AUTH + TLS by default**; pods connect over `rediss://` with credentials injected from a cluster Secret. Treat one instance as one tenant—the per-build key namespace is not a security boundary.
- Never put a literal `cache.password` in `adapter.config.mjs` (it's typically committed); inject it from the environment.
- Cross-replica PPR-shell and ISR revalidation requires Node middleware (`proxy.ts`, Next 16.2's replacement for edge `middleware.ts`). Apps still on edge middleware keep cross-replica `use cache` but fall back to per-replica shell/ISR revalidation.
- Cache reads degrade to a miss on store failure—a cache outage slows the site, it doesn't take it down.

### Routing service tuning

```js
routingService: {
  scaling: { min: 2, max: 10, targetCPU: 70 },
  resources: { cpu: '250m', memory: '256Mi', cpuLimit: '1000m', memoryLimit: '512Mi' },
  requestTimeoutMs: 4000,
  failureMode: 'auto',   // fails closed when the app has middleware (never bypass auth),
                         // fails open otherwise; 'open'/'closed' force it
},
```

## Architecture

> **Middleware runs behind the CDN, not in front of it.** No CDN runs your compute before its cache, so cache _hits_ are served without invoking middleware; the routing service runs on cache _misses_ on the way to origin. To keep this correct, middleware-covered routes are sent `Cache-Control: no-cache` so they are never cached ahead of the middleware that gates them. This constraint shapes the whole architecture and applies to both providers.

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
|                    |    middleware /        |                       |
|                    |    rewrites / redirects|                       |
|                    +-----------+------------+                       |
|                                | sets x-upstream-pool               |
|             HTTPRoute header routing on x-upstream-pool             |
+--------------------------------+------------------------------------+
                                 |
                          +------v-------+
                          |  GKE Cluster |
                          |              |
                          |  +--------+  |
                          |  | Pool A |  |  (SSR)
                          |  +--------+  |
                          |  +--------+  |
                          |  | Pool B |  |  (API)
                          |  +--------+  |
                          +--------------+
```

1. A request hits the CDN; a cache hit is served immediately.
2. On a miss, the routing service runs `@next/routing`—middleware, rewrites, redirects—and sets `x-upstream-pool`. Static assets and middleware-free `public/` files skip the callout entirely.
3. The HTTPRoute routes to the matching pool, whose server invokes the handler directly.

On `provider.generic` the shape is the same, with the callout hosted in-cluster instead of by the
load balancer—the routing service itself is byte-identical:

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

The difference that matters is trust: GXLB authenticates the callout by arriving from Google's
frontend over TLS, whereas an in-cluster gateway dials plain h2c and is bounded by NetworkPolicy
instead. That is why the generic provider's CNI must actually enforce policy—see
[SECURITY.md](./SECURITY.md).

### Blue/green deploys

Each deploy creates a new versioned Deployment alongside the previous one. Traffic points at a stable active Service whose selector is patched only after every new pod passes readiness _and_ is verified serving via `/readyz` directly on the pod. The previous build is kept at zero replicas as a rollback target; `rollback` scales it up, reverts the routing tier to that build's image and manifest, and patches the selector back.

Use `npx adapter-k8s rollback`, not `helm rollback`. Helm revisions are reconciliation snapshots
captured before the adapter's verified Service-selector cutover, not application release
checkpoints. A raw Helm rollback does not restore adapter state, routing state, pool capacity, or
CDN state, and can restore a pre-cutover stable Service selector. On Helm 4 it can also conflict
with HPA-owned Deployment replicas; `--force-conflicts` bypasses that conflict but does not make
the rollback safe.

## CI/CD

For operators who prefer their own pipeline, the CLI is a convenience wrapper—everything it does can be done with a container runtime, `helm`, and `gcloud`:

```yaml
# GitHub Actions example
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
      - run: NEXT_ADAPTER_PATH=@next-community/adapter-k8s npx next build
      - run: |
          docker build --platform=linux/amd64 -t $REGISTRY/nextjs-app-default:$BUILD_ID \
            .k8s-adapter/output/pools/default
          docker push $REGISTRY/nextjs-app-default:$BUILD_ID
          docker build --platform=linux/amd64 -f .k8s-adapter/output/routing-service/Dockerfile \
            -t $REGISTRY/routing-service:$BUILD_ID \
            .k8s-adapter/output/routing-service
          docker push $REGISTRY/routing-service:$BUILD_ID
      - run: |
          helm upgrade --install my-app .k8s-adapter/output/chart/ \
            --set global.image.tag=$BUILD_ID \
            --set global.image.registry=$REGISTRY
```

The chart is self-contained, including the load-balancer extension registration. Replicate the blue/green cutover by patching each active Service's version selector, and resolve image digests from the **registry** (not the local daemon) before deploying—see [docs/ci-cd.md](./docs/ci-cd.md) for the exact commands and known runtime gotchas.

## Security

Defaults, in brief—the full model is in [SECURITY.md](./SECURITY.md):

- Workloads run non-root with read-only filesystems, dropped capabilities, and no service-account tokens.
- NetworkPolicies apply a strict ingress allowlist (load-balancer ranges, kubelet probes, sibling pools) discovered at deploy time; a deploy that can't establish isolation **aborts** rather than shipping without it.
- Internal dispatch headers between the routing tier and pools are authenticated with a per-build shared secret delivered only via Kubernetes Secrets; unauthenticated dispatch headers are stripped.
- **Known limit:** the routing-service callout currently relies on NetworkPolicy as its caller boundary—network reachability to the routing tier is equivalent to holding the dispatch credential. mTLS caller authentication is planned. Read the [threat model](./SECURITY.md#threat-model-in-one-paragraph) before using the generic provider in a shared or hostile cluster.
- New deployments are pinned to immutable image digests (rollback's routing tier is currently tag-reconstructed—see [SECURITY.md](./SECURITY.md#image-provenance)); secrets never touch command lines, logs, or git.
- Cloud IAM is split into a minimally-scoped in-cluster identity and a push-capable CLI identity that no pod can assume.

## Roadmap

Skew protection (versioned routing for zero-mismatch deploys), mTLS caller authentication on the routing callout, digest-pinned rollback for the routing tier, `aks`/`eks` providers, and the hardening work above—connection pooling, routing-service tuning, published benchmarks.

## License

MIT
