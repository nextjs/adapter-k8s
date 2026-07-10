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

> **Where middleware runs relative to the CDN.** On GCP's global external Application Load Balancer, ext_proc is only supported as a **traffic extension**, which runs **after** the Cloud CDN cache. Cache *hits* are served without invoking middleware; the routing service runs on cache *misses* on the way to origin. Pool servers therefore send `Cache-Control: no-cache` on middleware-covered routes so those responses are never cached ahead of the middleware that gates them. (Route extensions -- which would run pre-cache -- are not supported on this load balancer.)

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
2. `docker build` + `push` per pool + the routing service
3. `helm upgrade --install` with the generated chart (attaches the Cloud CDN filter to the HTTPRoute when CDN is enabled)
4. Wait for the new pool + routing-service Deployments to roll out
5. Verify each new pod is serving (`/healthz` checked directly on the pod -- not via GCP LB health)
6. Patch active Service selectors to route traffic to the new build (blue/green cutover)
7. Keep the previous build at 0 replicas (rollback target)
8. Run the traffic-extension registration Job: attach the routing-service NEG to the ext_proc backend and register the extension across every forwarding rule

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

Roll back to the previous deployment. The previous build is kept at 0 replicas after each deploy, so rollback is a scale + selector patch -- no image pull or build needed.

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

Tear down all resources.

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
    },
    gateway: { /* ... */ },
  },
},
```

Cache *hits* are served before the routing service runs, so middleware-covered routes are sent `Cache-Control: no-cache` to keep them out of the cache. Deploys emit `x-cache-status` / `x-cache-id` response headers for diagnostics.

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

| Phase | Status  | What                                                                                    |
| ----- | ------- | --------------------------------------------------------------------------------------- |
| 1     | Done    | Adapter core, pool server, CLI (init/deploy/destroy/doctor/describe/rollback/tail/emulate) |
| 2     | Done    | Routing service (ext_proc **traffic extension**), CEL generation, Service Extensions     |
| 3     | Done    | Cloud CDN integration (GCPHTTPFilter, Next.js-aware cache keys, diagnostic headers)      |
| 4     | Planned | Coordinated CDN invalidation (tag-based purge for ISR / `revalidate`)                    |
| 5     | Planned | Distributed caching (Valkey/Redis for ISR + `use cache`)                                |
| 6     | Planned | PPR (partial prerendering with cache-first preamble)                                     |
| 7     | Planned | Skew protection (versioned routing for zero-mismatch deploys)                            |

## License

MIT
