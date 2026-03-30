# @next-community/adapter-k8s

Deploy Next.js applications to GKE with a single command. The adapter generates everything from your build output -- Helm charts, Dockerfiles, routing manifests -- so your infrastructure evolves with your routes, not with hand-maintained YAML.

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
npx adapter-k8s deploy
```

## What it does

The adapter plugs into Next.js 16.2+'s `adapterPath` API. At build time, it analyzes your route structure and generates:

- **Pool servers** that invoke your handlers directly via `import()` -- no `next start`, no `MINIMAL_MODE`
- **A routing service** (ext_proc gRPC) that runs `@next/routing` pre-CDN for middleware, rewrites, redirects
- **A Helm chart** with Deployments, Services, Gateway, HTTPRoute, and HealthCheckPolicies
- **Dockerfiles** with only the traced assets each pool needs

At deploy time, the CLI builds images, pushes them, and runs `helm upgrade` with zero-downtime blue/green cutover.

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
import { createK8sAdapter } from '@next-community/adapter-k8s';

export default createK8sAdapter({
  pools: {
    default: {
      routes: ['appPages', 'appRoutes', 'pagesApi'],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },
  provider: {
    gke: {
      gateway: {
        type: 'gateway-api',
        className: 'gke-l7-global-external-managed',
        hosts: [
          { hostname: 'app.example.com', tls: { enabled: true, managedCert: true } },
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
2. `docker build` + `push` per pool + routing service
3. `helm upgrade --install` with the generated chart
4. Wait for new pods to be ready
5. Wait for GCP load balancer health checks to pass
6. Patch active Service selectors to route traffic to new build
7. Scale down previous build to 0 (kept for rollback)
8. Clean up older builds

## CLI Commands

### `init`

Provision GCP infrastructure and scaffold config.

```bash
npx adapter-k8s init --project-id <id> --host <hostname>
```

| Flag | Description | Default |
|------|-------------|---------|
| `--project-id` | GCP project ID | `$GCP_PROJECT_ID` |
| `--region` | GCP region | `us-central1` |
| `--host` | Hostname(s), comma-separated. Supports wildcards (`*.example.com`) | `$APP_HOST` |
| `--bucket` | GCS bucket name | `{project-id}-nextjs-static` |
| `--registry` | Container registry URL | `{region}-docker.pkg.dev/{project-id}/nextjs` |
| `--release-name` | Helm release name | Directory name |
| `--dry-run` | Show commands without executing | |

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

Checks prerequisites (gcloud/kubectl/helm/docker), GCP resources (IP, bucket, registry, auth), Kubernetes resources (Gateway, HTTPRoute, deployments with rollout awareness), LB backend health, and per-host DNS + TLS certificate status.

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
      routes: ['appPages'],
      scaling: { min: 2, max: 20, targetCPU: 70 },
    },
    api: {
      routes: ['appRoutes', 'pagesApi'],
      scaling: { min: 2, max: 10, targetCPU: 60 },
    },
    heavy: {
      routes: ['/api/generate-report', '/api/export/*'],
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

## Architecture

```
                     GCP Application Load Balancer
+----------------------------------------------------------+
|                                                          |
|  Internet --> [CEL Filter] --> URL Map --> [Cloud CDN]   |
|                    |                           |         |
|              +-----v------+               cache miss     |
|              |  Route Ext  |                   |         |
|              |  (ext_proc) |                   |         |
|              |  @next/     |                   |         |
|              |   routing   |                   |         |
|              |  middleware  |                   |         |
|              +-------------+                   |         |
|                                                |         |
+------------------------------------------------+---------+
                                                 |
                                          +------v------+
                                          |  GKE Cluster |
                                          |              |
                                          |  +--------+  |
                                          |  | Pool A |  |
                                          |  | (SSR)  |  |
                                          |  +--------+  |
                                          |  +--------+  |
                                          |  | Pool B |  |
                                          |  | (API)  |  |
                                          |  +--------+  |
                                          +--------------+
```

### Request Flow

1. Request arrives at the GCP Application Load Balancer
2. **CEL filter** checks the path -- static assets (`/_next/static/*`) skip ext_proc entirely
3. **Route Extension Service** (ext_proc gRPC) resolves the route via `@next/routing`, executes middleware, sets `x-upstream-pool` header
4. **URL Map** routes to the correct pool based on the header
5. **Pool server** loads the handler module via `import()` and invokes it with `(req, res, ctx)`

### Blue/Green Deploys

Each deploy creates a new versioned Deployment alongside the previous one. The HTTPRoute always points to a **stable active Service** whose selector is patched only after the new build is confirmed healthy.

Traffic cutover sequence:
1. Helm creates new Deployment + versioned Service (old build still serving)
2. New pods pass Kubernetes readiness probes
3. New backends pass GCP load balancer health checks (`/healthz`)
4. Active Service selector patched to new build (traffic shifts)
5. Previous build scaled to 0 (kept for rollback)

To roll back: `npx adapter-k8s rollback` scales up the previous build, waits for health, patches the selector back, and scales down the current build.

### Generated Artifacts

After `next build`, the adapter writes to `.k8s-adapter/output/`:

```
.k8s-adapter/output/
+-- chart/                         Helm chart
|   +-- Chart.yaml
|   +-- values.yaml
|   +-- templates/
|       +-- *-deployment.yaml      Per-pool Deployments
|       +-- *-service.yaml         Versioned Services
|       +-- *-active-service.yaml  Stable Services (HTTPRoute targets)
|       +-- *-hpa.yaml             HorizontalPodAutoscalers
|       +-- gateway.yaml           Gateway + HTTPRoute
|       +-- routing-service-*      Route extension Deployment/Service/HPA
|       +-- routing-manifest-configmap.yaml
+-- pools/{pool}/
|   +-- Dockerfile
|   +-- context/                   Traced assets for this pool
+-- routing-service/
|   +-- Dockerfile
|   +-- context/                   Routing service runtime + manifest
+-- routing-manifest.json
+-- extension-chains.json
+-- cel-expression.txt
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
      - run: |
          helm upgrade --install my-app .k8s-adapter/output/chart/ \
            --set global.image.tag=$BUILD_ID \
            --set global.image.registry=$REGISTRY
```

The Helm chart is self-contained. The CLI is a convenience wrapper -- everything it does can be done with `docker`, `helm`, and `gcloud` directly.

## Implementation Status

| Phase | Status | What |
|-------|--------|------|
| 1 | Done | Adapter core, pool server, CLI (init/deploy/destroy/doctor/describe/rollback) |
| 2 | Done | Route extension service (ext_proc), CEL generation, Service Extensions |
| 3 | Planned | Distributed caching (Valkey/Redis for ISR + `use cache`) |
| 4 | Planned | Cloud CDN integration with coordinated invalidation |
| 5 | Planned | PPR (partial prerendering with cache-first preamble) |
| 6 | Planned | Skew protection (versioned routing for zero-mismatch deploys) |

## License

MIT
