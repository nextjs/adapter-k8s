# @next-community/adapter-k8s

Deploy Next.js applications to GKE with a single command. The adapter generates everything from your build output -- Helm charts, Dockerfiles, routing manifests -- so your infrastructure evolves with your routes, not with hand-maintained YAML.

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
npx adapter-k8s deploy
```

## What it does

The adapter plugs into Next.js 16.2+'s `adapterPath` API. At build time, it analyzes your route structure and generates:

- **Pool servers** that invoke your handlers directly via `import()` -- no `next start`, no `MINIMAL_MODE`
- **A routing service** (ext_proc over HTTP/2 + TLS) that runs `@next/routing` for middleware, rewrites, and redirects -- wired as a **traffic extension** on the load balancer
- **A Helm chart** with Deployments, Services, Gateway, HTTPRoute, an optional Cloud CDN filter, and the traffic-extension registration Job
- **Dockerfiles** with only the traced assets each pool needs

At deploy time, the CLI builds images, pushes them, and runs `helm upgrade` with zero-downtime blue/green cutover.

With a shared cache configured, the pool servers register a Valkey-backed `use cache` handler so **cache components and Partial Prerendering (PPR)** work correctly across replicas: cached entries are shared, and `revalidateTag` / `revalidatePath` on one pod is seen by all. (Next's default `use cache` store is per-process, which diverges the moment you run more than one replica.) See [Distributed Cache](#distributed-cache-cache-components--ppr).

> **Where middleware runs relative to the CDN.** On GCP's global external Application Load Balancer, ext*proc is only supported as a **traffic extension**, which runs **after** the Cloud CDN cache. Cache \_hits* are served without invoking middleware; the routing service runs on cache _misses_ on the way to origin. Pool servers therefore send `Cache-Control: no-cache` on middleware-covered routes so those responses are never cached ahead of the middleware that gates them. (Route extensions -- which would run pre-cache -- are not supported on this load balancer.)

## Project Status

**This adapter is experimental and optimized for correctness, not yet for throughput.** The goal so far has been to prove that Next.js's harder edges -- middleware, Partial Prerendering, cache components, and ISR -- behave correctly in front of a CDN on GCP with no edge compute, across multiple replicas. It follows _make it work, make it correct, make it fast_ -- and "fast" is deliberately last.

Concretely, that means:

- **Correctness is validated; performance is not.** Cross-replica cache sharing and `revalidateTag` for `use cache`, ISR, and PPR shells are verified end-to-end against real infrastructure, but the adapter has **not** been load-tested or tuned for high QPS, and there are no published benchmarks yet.
- **The hot paths favor clarity over peak throughput.** The Valkey client is a small zero-dependency RESP2 client written for correctness (bounded timeouts, defensive degrade-to-miss) rather than maximum throughput -- no connection pooling, pipelining heuristics, or backpressure tuning yet. The routing service runs `@next/routing` per request over ext_proc. Both are correct and bounded, not squeezed.
- **APIs and generated infrastructure may change** between versions as the design firms up.

Treat it as a way to evaluate and validate Next.js-on-GKE semantics today, not as a hardened, benchmarked production tier. Performance work (pooling, request-decomposition upstream in the routing service, benchmarking) is planned once correctness has real usage behind it. Issues and contributions are welcome.

## Requirements

- Node.js >= 20.9.0
- Next.js >= 16.2.0
- A GKE cluster (Autopilot or Standard)
- `gcloud`, `kubectl`, `helm`, `docker` in PATH

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
        hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
      },
    },
  },
});
```

### 3. Initialize infrastructure

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
```

This provisions (idempotently via `gcloud`):

- GKE Autopilot cluster
- Global static IP
- Artifact Registry repository
- GCS bucket for static assets
- IAM service accounts + Workload Identity bindings
- Certificate Manager DNS authorization + managed certificate
- Certificate map for TLS on Gateway API

After running, add the DNS records printed in the output (A record + CNAME for cert validation).

### 4. Deploy

```bash
npx adapter-k8s deploy
```

The deploy flow:

1. `next build` (adapter generates artifacts in `.k8s-adapter/output/`)
2. Provision the managed cache (Memorystore) and write its connection Secret -- only when `cache.enabled` with no `url` (idempotent; reuses an existing instance, waits for it to be ready)
3. `docker build` + `push` per pool + the routing service
4. `helm upgrade --install` with the generated chart (attaches the Cloud CDN filter to the HTTPRoute when CDN is enabled)
5. Wait for the new pool + routing-service Deployments to roll out
6. Verify each new pod is serving (`/healthz` checked directly on the pod -- not via GCP LB health)
7. Patch active Service selectors to route traffic to the new build (blue/green cutover)
8. Invalidate the previous build's Cloud CDN cache tag (when CDN is enabled) so the new build never serves the old build's stale same-URL content from the edge -- best-effort and non-fatal (TTL self-heals)
9. Keep the previous build at 0 replicas (rollback target)
10. Run the traffic-extension registration Job: attach the routing-service NEG to the ext_proc backend and register the extension across every forwarding rule

## CLI Commands

### `init`

Provision GCP infrastructure and scaffold config.

```bash
npx adapter-k8s init --project-id <id> --host <hostname>
```

| Flag             | Description                                                        | Default                                       |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `--project-id`   | GCP project ID                                                     | `$GCP_PROJECT_ID`                             |
| `--region`       | GCP region                                                         | `us-central1`                                 |
| `--host`         | Hostname(s), comma-separated. Supports wildcards (`*.example.com`) | `$APP_HOST`                                   |
| `--bucket`       | GCS bucket name                                                    | `{project-id}-nextjs-static`                  |
| `--registry`     | Container registry URL                                             | `{region}-docker.pkg.dev/{project-id}/nextjs` |
| `--release-name` | Helm release name                                                  | Directory name                                |
| `--dry-run`      | Show commands without executing                                    |                                               |

### `deploy`

Build, push images, and deploy via Helm with zero-downtime blue/green cutover.

```bash
npx adapter-k8s deploy [--skip-build] [--skip-push] [--dry-run]
```

### `rollback`

Roll back to the previous deployment. The previous build is kept at 0 replicas after each deploy, so rollback is a scale + selector patch -- no image pull or build needed. When CDN is enabled, it also invalidates the outgoing build's cache tag on cutover.

```bash
npx adapter-k8s rollback [--dry-run]
```

Rollback is symmetric: running it twice rolls forward to the original build.

### `doctor`

Run health checks across your entire stack.

```bash
npx adapter-k8s doctor
```

Checks prerequisites (gcloud/kubectl/helm/docker), GCP resources (IP, bucket, registry, auth), Kubernetes resources (Gateway, HTTPRoute, deployments with rollout awareness), active Service endpoints (that each active Service's selector actually matches ready pods -- catches a mis-patched cutover before it 503s), LB backend health, ext_proc traffic-extension wiring (registered across all forwarding rules, NEG attached, backend scheme, TCP health check), and per-host DNS + TLS certificate status.

`doctor` resolves the release name from `.k8s-adapter/infrastructure.json`, so it targets the deployed release regardless of the current directory name (override with `--release-name`).

### `emulate`

Run the full adapter infrastructure locally: Envoy, routing service (ext_proc), and pool server.

```bash
npx adapter-k8s emulate [--skip-build] [--port 8080]
```

Replicates the GKE request flow on your machine: `Client → Envoy (:8080) → Routing Service (:8443) → Pool Server (:3000)`. Uses Docker for Envoy if no local binary is found. Falls back to pool-server-only mode if Envoy is unavailable.

### `describe`

Show a live architecture diagram of your deployment.

```bash
npx adapter-k8s describe
```

Renders the full request flow with live pod counts, revision tags, and the actual generated CEL expression.

### `tail`

Stream logs from all running workloads.

```bash
npx adapter-k8s tail
```

Color-coded per component (pool servers, routing service). Automatically picks up new pods and survives pod termination.

### `destroy`

Tear down the release-scoped resources: the Helm release, GCS bucket, deploy service account, the ext_proc traffic extension + routing backend + health check, the static IP, and the managed cache (Memorystore) when the adapter provisioned it. Shared, expensive infrastructure -- the GKE cluster, Artifact Registry, and Certificate Manager cert/DNS -- is **kept and reported** (with the exact commands to remove it manually), and local state under `.k8s-adapter/` is preserved so a later `deploy` can rebuild everything else.

```bash
npx adapter-k8s destroy [--dry-run]
```

## Configuration

### Pool Decomposition

Split your routes across independent scaling groups:

```js
export default createK8sAdapter({
  pools: {
    ssr: {
      routes: ["appPages"],
      scaling: { min: 2, max: 20, targetCPU: 70 },
    },
    api: {
      routes: ["appRoutes", "pagesApi"],
      scaling: { min: 2, max: 10, targetCPU: 60 },
    },
    heavy: {
      routes: ["/api/generate-report", "/api/export/*"],
      scaling: { min: 1, max: 5, targetCPU: 50 },
    },
  },
  // ...
});
```

Routes can be matched by output type (`appPages`, `appRoutes`, `pagesApi`) or glob pattern. First-match-wins -- pools are evaluated in config order.

### Multiple Hosts & Wildcards

```js
gateway: {
  hosts: [
    { hostname: 'app.example.com', tls: { enabled: true, managedCert: true } },
    { hostname: 'api.example.com', tls: { enabled: true, managedCert: true } },
    { hostname: '*.example.com', tls: { enabled: true, managedCert: true } },
  ],
}
```

Wildcard domains are supported via Certificate Manager DNS authorization.

### Container Strategy

```js
// Per-pool minimal containers (default) -- each pool only has its traced assets
containerStrategy: 'traced-assets',

// Single image for all pools -- simpler CI/CD, one image to scan
containerStrategy: 'shared-image',
```

### Cloud CDN

Enable Cloud CDN under `provider.gke`. The adapter attaches a `GCPHTTPFilter` to the HTTPRoute and configures a Next.js-aware cache key (whitelisting the RSC/prefetch `Vary` headers so App Router HTML and RSC payloads partition correctly).

```js
provider: {
  gke: {
    cdn: {
      enabled: true,
      bucket: 'my-project-nextjs-static',
      // cacheMode: 'USE_ORIGIN_HEADERS',   // default -- honor the app's Cache-Control
      // cacheKeyHeaders: [...],            // override the cache-key header set
      // invalidateOnDeploy: true,          // default -- purge the previous build's cache tag on cutover
    },
    gateway: { /* ... */ },
  },
},
```

Cache _hits_ are served before the routing service runs, so middleware-covered routes are sent `Cache-Control: no-cache` to keep them out of the cache. Deploys emit `x-cache-status` / `x-cache-id` response headers for diagnostics.

**Cross-deploy invalidation.** Mutable cacheable responses -- Pages-Router SSG HTML and `public/` files, served at the same URL across deploys -- carry a per-build `Cache-Tag` (`build-<hash>`). On cutover, `deploy` (and `rollback`) invalidate the _outgoing_ build's tag via `gcloud compute url-maps invalidate-cdn-cache --tags=...`, so a new build never serves the previous build's stale content from the edge. Immutable, content-hashed assets (`/_next/static/*`) are left untagged -- they're safe to share across deploys and never need purging. The purge is best-effort and non-fatal (a failure just lets the TTL self-heal); set `invalidateOnDeploy: false` to opt out.

### Distributed Cache (Cache Components & PPR)

Next's `use cache` handler defaults to a per-process in-memory store, which diverges across replicas: two pods cache different values, and a `revalidateTag` on one is invisible to the others. Enable a shared cache so **cache components** and **PPR** behave correctly on more than one pod.

Enable `cacheComponents: true` in your `next.config` (that's what turns on `use cache` / PPR), then point the adapter at a store:

```js
cache: {
  enabled: true,
  provider: 'valkey',                 // 'valkey' | 'redis' (wire-compatible)
  // Managed (GKE default): the adapter provisions Memorystore and injects the connection.
  memorystore: {
    region: 'us-central1',
    sizeGb: 1,
    tier: 'BASIC',
    // auth: true,                    // recommended — Redis AUTH + in-transit encryption
  },
  // — or bring your own, and the adapter provisions nothing —
  // url: 'redis://my-valkey.internal:6379',
  // password: '...',
},
```

> **Secure the cache endpoint.** Without `auth: true`, the managed instance has no AUTH and no in-transit encryption — any workload that can reach the VPC endpoint can read and write the shared cache (and cached pages can carry PII). With `auth: true` the instance is created with AUTH + TLS (`SERVER_AUTHENTICATION`), and the pods connect over `rediss://` with the instance AUTH string and server CA injected from the connection Secret (`VALKEY_AUTH` / `VALKEY_CA_CERT`). AUTH can only be set at instance creation, so enable it before the first deploy (or destroy the instance first). Treat one Memorystore instance as one tenant: cache keys are namespaced by build id, but that namespace is **not** a security boundary — don't point two unrelated applications at the same instance.

> **Don't commit a BYO cache password.** `adapter.config.mjs` is typically checked into git — a literal `cache.password` there leaks the cache's AUTH string into your repository history. Prefer the managed path (`memorystore` with `auth: true`; its AUTH string only ever lives in the cluster Secret), or inject the secret at runtime (`password: process.env.VALKEY_PASSWORD`). The generated connection Secret under `.k8s-adapter/` is kept out of git either way (init scaffolds the ignore) — the config file itself is the exposure.

What it does:

- The pool server registers a **Valkey-backed `use cache` handler** (`{ DefaultCache, RemoteCache }`) before your app loads, so every `use cache` entry lives in the shared store.
- `revalidateTag` / `revalidatePath` propagate through a **shared tag manifest** (updated atomically, last-event-wins, with concurrent profiled and hard revalidations merged per watermark rather than overwriting each other), so an invalidation on one replica is immediately seen by all -- the thing a per-process handler cannot do. The manifest itself carries a 30-day TTL, refreshed on every write, so old builds' manifests don't accumulate in the instance.
- The client connects lazily with bounded connect/command timeouts and a **short circuit breaker**: after a Valkey failure, reads fail fast into a cache miss for ~1.5s instead of every render paying a fresh reconnect + timeout, then probe again automatically. `rediss://` with a pinned CA is supported (managed `auth: true` uses it), `redis://user:pass@host` sends ACL-form AUTH, and a `redis://host/<n>` DB index is ignored with a one-time warning -- the keyspace is namespaced by build id (DB 0 only).
- **PPR routes** stream the static shell, then resume the dynamic holes pool-native, and are sent `Cache-Control: no-store` so the CDN never caches the per-request dynamic tail. (Chunked encoding alone does _not_ keep a response out of Cloud CDN.)
- **PPR shells and ISR pages** revalidate cross-replica too: the adapter registers a Valkey-backed **incremental cache handler** (`next.config.cacheHandler`) so `use cache` baked into a static PPR shell, and `revalidate`-based ISR pages, are shared and invalidated across every pod. Verified live: `revalidateTag` regenerates a baked PPR shell (and an ISR page) consistently across replicas.
- With `memorystore` (and no `url`), `deploy` provisions the instance idempotently and `destroy` tears it down. Provide `url` to use your own Valkey/Redis and the adapter provisions nothing.

> **Requires Node middleware (`proxy.ts`), not edge.** The incremental cache handler is a Node module (it talks to Valkey over `node:net`/`node:tls` using the adapter's own zero-dependency RESP2 client -- no `ioredis` dependency). Legacy **edge** `middleware.ts` makes the bundler pull it into the edge runtime, which can't run it -- so the adapter registers the incremental handler only for apps whose middleware runs on Node, i.e. Next 16.2's `proxy.ts` (the non-deprecated replacement for edge middleware). Apps still on edge `middleware.ts` keep cross-replica `use cache` (the V2 handler) but fall back to per-replica for PPR-shell/ISR revalidation. Migrate `middleware.ts` → `proxy.ts` to get the full behavior.

### Routing Service Tuning

The ext_proc routing tier (the middleware service) is tunable independently of your pools:

```js
routingService: {
  scaling: { min: 2, max: 10, targetCPU: 70 },
  resources: { cpu: '250m', memory: '256Mi', cpuLimit: '1000m', memoryLimit: '512Mi' },
  requestTimeoutMs: 4000,        // per-request handler budget (< the 5s ext_proc deadline)
  failureMode: 'auto',           // 'auto' (default) fails closed when the app has middleware
                                 // (never bypass auth), fails open otherwise; 'open'/'closed' force it
},
```

## Security Posture

What the generated infrastructure does by default:

- **Non-root, read-only workloads.** Pool and routing-service containers run as `USER node` with `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, all capabilities dropped, seccomp `RuntimeDefault`, and no service-account token (the traffic-extension Job keeps its Workload Identity token — it needs it — but runs with the same hardening). Writable scratch space is provided by `emptyDir` mounts at `/tmp` and `/app/.next/cache` (per-pod, ephemeral).
- **NetworkPolicies.** The chart blocks in-cluster pods from the dataplane: the routing service and pools accept traffic only from sources **outside the cluster's pod CIDR** (the LB and health-check probes arrive with non-pod source IPs), plus sibling-**pool** pods for cross-pool proxying (the routing service can't originate pool traffic). Be precise about the boundary: it is the pod CIDR, not the VPC — VPC-level sources outside the pod CIDR (VMs on the network, `hostNetwork` pods using node IPs, pods in another cluster with routable peering) can still reach the dataplane ports. The fail-safe design contains that: such direct access bypasses the routing service but still gets full local resolution on the pool (middleware runs), and internal dispatch headers are honored only with the shared secret, so it cannot impersonate trusted routing. Deploy discovers the cluster pod CIDR and **aborts** if it can't — pass `--allow-no-network-policy` to explicitly deploy without isolation. Standard clusters are created with `--enable-network-policy`; Autopilot always enforces it. Neither posture governs **egress** (`policyTypes: [Ingress]`), so pool → Valkey/GCS/Artifact Registry/DNS traffic is unaffected.
- **Strict ingress allowlist (opt-in).** The default above is a _denylist_ (everything except pods). Setting `global.networkPolicy.strict=true` replaces it with a positive _allowlist_ of the Google-owned load-balancer ranges, which is what closes the VPC-level exposure described above:

  | source                                                  | reaches                        | why                                                                                                                                                                                                                                                                                                                                |
  | ------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `35.191.0.0/16`, `130.211.0.0/22`, `2600:2d00:1:1::/64` | pools `:3000`, routing `:8443` | GFE proxy ranges for a **global external Application Load Balancer** whose backends are zonal NEGs (`GCE_VM_IP_PORT`) — the topology this chart emits (`gke-l7-global-external-managed` + container-native LB, so the GFE talks to the pod IP directly). The ext_proc callout to the routing service arrives from the same ranges. |
  | `35.191.0.0/16`, `2600:2d00:1:b029::/64`                | same                           | Health-check probers for GFE-based load balancers (the Gateway's pool checks and the `<release>-routing-hc` TCP check on `:8443`).                                                                                                                                                                                                 |
  | `global.networkPolicy.nodeCidrs` (you supply)           | pools `:3000`, routing `:8081` | kubelet liveness/readiness probes come from the **node** IP, which no Google range covers. Under Calico host→pod traffic is policed, so omitting this leaves every pod unready — the template `fail`s at render time rather than letting you find out at rollout.                                                                  |
  | sibling **pool** pods (label selector)                  | pools `:3000`                  | cross-pool proxying, unchanged.                                                                                                                                                                                                                                                                                                    |

  Sources: [firewall rules](https://docs.cloud.google.com/load-balancing/docs/firewall-rules), [health checks overview](https://docs.cloud.google.com/load-balancing/docs/health-check-concepts), [GKE network policy](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/network-policy). Enable it in `.k8s-adapter/helm/values.override.yaml`:

  ```yaml
  global:
    networkPolicy:
      strict: true
      nodeCidrs: ["10.128.0.0/20"] # gcloud compute networks subnets describe SUBNET --region REGION --format='value(ipCidrRange)'
  ```

  **The trade.** In exchange for closing the VPC to the dataplane you accept: (1) Google publishes these ranges but guarantees nothing — "Google Cloud can implement new probers automatically without notification" — so a future range addition would show up as unhealthy backends, not as a warning; (2) IPv6 ranges are included unconditionally (inert on single-stack clusters) so a dual-stack cluster needs no second knob; (3) the node range you supply is usually the whole cluster subnet, so any VM sharing it keeps its current reach — give the cluster its own subnet if that matters; (4) `hostNetwork` pods are exempt from NetworkPolicy in _both_ postures. Strict mode never names the pod CIDR, so it does not depend on pod-CIDR discovery and renders even with `--allow-no-network-policy`. It is **off by default** because the default posture is what every existing deploy is running and what the live e2e cluster is validated against; enabling it is a deploy-time flag, so reverting is a redeploy, not a rebuild.

- **A shared secret authenticates internal routing headers** between the routing service and pools (`INTERNAL_HEADER_SECRET`, 32 random bytes per deploy, delivered only via a Kubernetes Secret, compared in constant time). Dispatch headers from any other source are stripped.
- **HTTPS redirect.** When TLS is enabled, the chart emits an HTTP→HTTPS `RequestRedirect` route so plaintext HTTP is never served.
- **Secrets never touch command lines, logs, or git** (init scaffolds `.k8s-adapter/` into `.gitignore`; secret-bearing chart files are written `0600`).
- **Input validation at every boundary**: release name, hostnames, registry, namespace, and the build id are charset-validated before they reach Helm values, YAML, or the privileged registration Job. A custom `generateBuildId()` outside `[A-Za-z0-9._-]` fails the build.
- **Least-privilege deploy identity.** The deploy service account gets a release-scoped custom IAM role for traffic-extension registration and repository-scoped Artifact Registry access — not project-wide LB admin.

## Architecture

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
|                    |       (ext_proc)       |  skips /_next/static/, |
|                    |  Routing Service:      |  /404, /500           |
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

### Request Flow

1. Request arrives at the load balancer and hits **Cloud CDN**. A cache hit is served immediately -- middleware does not run for cached responses.
2. On a **cache miss**, the **traffic extension** fires on the way to origin. Its **CEL match condition** excludes static assets and error pages (`/_next/static/*`, `/404`, `/500`) so those skip the ext_proc callout entirely.
3. The **routing service** (ext_proc over HTTP/2 + TLS) resolves the route via `@next/routing`, executes middleware/rewrites/redirects, and sets the `x-upstream-pool` header.
4. The **HTTPRoute** routes to the correct pool based on `x-upstream-pool`.
5. The **pool server** loads the handler module via `import()` and invokes it with `(req, res, ctx)`. Middleware-covered routes are served `Cache-Control: no-cache` so the CDN never caches them ahead of their middleware.

### Blue/Green Deploys

Each deploy creates a new versioned Deployment alongside the previous one. The HTTPRoute always points to a **stable active Service** whose selector is patched only after the new build is confirmed healthy.

Traffic cutover sequence:

1. Helm creates the new Deployment + versioned Service (old build still serving)
2. New pods pass Kubernetes readiness probes
3. Each new pod is verified serving via `/healthz` (checked directly on the pod, not via GCP LB backend health)
4. Active Service selector patched to the new build's pod label (traffic shifts). The selector value comes from the same sanitizer that stamps the pod label, so it always matches -- a mismatch would drain the Service to zero endpoints, and `doctor`'s "Active Service endpoints" check guards against exactly that.
5. Previous build scaled to 0 (kept for rollback)

The selector flip itself is atomic, but the load balancer reprograms the standalone NEG asynchronously, so expect a brief (typically a few seconds) window where the LB is catching up to the new endpoints before it is fully settled.

To roll back: `npx adapter-k8s rollback` scales up the previous build, waits for it to be ready, patches the active Service selector back to it, and scales down the current build. Rollback is symmetric -- running it again rolls forward to the build you came from.

### Generated Artifacts

After `next build`, the adapter writes to `.k8s-adapter/output/`:

```
.k8s-adapter/output/
+-- chart/                         Helm chart
|   +-- Chart.yaml
|   +-- values.yaml
|   +-- templates/
|       +-- {pool}-deployment.yaml       Per-pool Deployment
|       +-- {pool}-service.yaml          Versioned Service
|       +-- {pool}-active-service.yaml   Stable Service (HTTPRoute target)
|       +-- {pool}-prev-*.yaml           Previous build (kept for rollback)
|       +-- {pool}-hpa.yaml              HorizontalPodAutoscaler
|       +-- gateway.yaml                 Gateway
|       +-- http-route.yaml              HTTPRoute (pool routing + CDN filter ref)
|       +-- cdn-http-filter.yaml         Cloud CDN GCPHTTPFilter (when enabled)
|       +-- routing-service-*.yaml       Routing service Deployment/Service/HPA
|       +-- route-ext-config.yaml        Traffic-extension source config
|       +-- route-ext-update-job.yaml    Traffic-extension registration Job
|       +-- routing-manifest-configmap.yaml
|       +-- internal-secret.yaml         Shared secret for internal dispatch headers
|       +-- valkey-secret.yaml           Cache connection secret (BYO url; managed is created at deploy)
|       +-- deploy-service-account.yaml
+-- pools/{pool}/
|   +-- Dockerfile
|   +-- context/                   Traced assets for this pool
+-- routing-service/
|   +-- Dockerfile
|   +-- context/                   Routing service runtime + manifest
+-- routing-manifest.json
+-- extension-chains.json
+-- cel-expression.txt
+-- static-assets.json
+-- cdn-invalidation.json          CDN tag-invalidation opt-out flag (read by deploy/rollback)
+-- build-metadata.json
```

## CI/CD Integration

For operators who prefer their own CI/CD:

```yaml
# GitHub Actions example
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4
      - run: NEXT_ADAPTER_PATH=@next-community/adapter-k8s npx next build
      - run: |
          docker build -t $REGISTRY/nextjs-app-default:$BUILD_ID \
            .k8s-adapter/output/pools/default
          docker push $REGISTRY/nextjs-app-default:$BUILD_ID
          docker build -f .k8s-adapter/output/routing-service/Dockerfile \
            -t $REGISTRY/routing-service:$BUILD_ID \
            .k8s-adapter/output/routing-service
          docker push $REGISTRY/routing-service:$BUILD_ID
      - run: |
          helm upgrade --install my-app .k8s-adapter/output/chart/ \
            --set global.image.tag=$BUILD_ID \
            --set global.image.registry=$REGISTRY
```

The Helm chart is self-contained -- it includes the traffic-extension registration Job that attaches the routing-service NEG and registers the ext_proc extension, so `helm upgrade` wires the load balancer for you. The blue/green cutover (patching each active Service selector to the new build's pod label) is the one step the CLI performs outside Helm; replicate it with `kubectl patch service <release>-<pool> --type=json -p '[{"op":"replace","path":"/spec/selector/app.kubernetes.io~1version","value":"<sanitized-build-id>"}]'`. The CLI is a convenience wrapper -- everything it does can be done with `docker`, `helm`, and `gcloud` directly.

## Implementation Status

| Phase | Status  | What                                                                                                                                                                                                                                                                                          |
| ----- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Done    | Adapter core, pool server, CLI (init/deploy/destroy/doctor/describe/rollback/tail/emulate)                                                                                                                                                                                                    |
| 2     | Done    | Routing service (ext_proc **traffic extension**), CEL generation, Service Extensions                                                                                                                                                                                                          |
| 3     | Done    | Cloud CDN integration (GCPHTTPFilter, Next.js-aware cache keys, diagnostic headers)                                                                                                                                                                                                           |
| 4     | Done    | Coordinated CDN invalidation — pool servers stamp a per-build `Cache-Tag` on mutable cacheable responses (SSG HTML, `public/` files); `deploy` and `rollback` purge the outgoing build's tag on cutover so a new build never serves the previous build's stale same-URL content from the edge |
| 5     | Done    | Distributed cache — Valkey `use cache` handler + incremental cache handler shared across replicas (cross-replica `revalidateTag` for `use cache`, ISR, and PPR shells); managed Memorystore or BYO. See [Distributed Cache](#distributed-cache-cache-components--ppr)                         |
| 6     | Done    | PPR — pool-native shell resume + `no-store` at the CDN; PPR shells revalidate cross-replica via the incremental cache (needs Node `proxy.ts`)                                                                                                                                                 |
| 7     | Planned | Skew protection (versioned routing for zero-mismatch deploys)                                                                                                                                                                                                                                 |

## License

MIT
