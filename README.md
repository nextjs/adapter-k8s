# @next-community/adapter-k8s

Deploy full-fidelity Next.js—middleware, Partial Prerendering, cache components, ISR—to Kubernetes with a single command. The adapter plugs into Next.js 16.3+'s `adapterPath` API and generates Helm charts, Dockerfiles, and routing manifests from your build output.

```bash
npx adapter-k8s deploy
```

## What it does

At build time, the adapter analyzes your route structure and generates:

- **Pool servers** that invoke your handlers directly via `import()`—no `next start`
- **A routing service** running `@next/routing` for middleware, rewrites, and redirects—attached to the data plane as an ext_proc extension when a native routing component is selected
- **A Helm chart** with Deployments, Services, Gateway, HTTPRoute, and NetworkPolicies
- **Dockerfiles** containing only the traced assets each pool needs

At deploy time, the CLI builds and pushes images, then runs `helm upgrade` with zero-downtime blue/green cutover.

Deployment targets are composed from independent cluster, exposure, and routing components—see [docs/targets.md](./docs/targets.md).

With a shared cache configured, cache components, Partial Prerendering (PPR), and ISR work correctly across replicas: cached entries are shared, and `revalidateTag` / `revalidatePath` on one pod is seen by all. See [Distributed cache](./docs/configuration.md#distributed-cache-cache-components--ppr).

CDN and middleware behavior are coordinated so cached responses can never bypass middleware-protected routes—see [Architecture](#architecture) for how.

## Status

Framework compatibility is verified against the upstream Next.js e2e suite; operational hardening remains.

Middleware, PPR, cache components, and ISR are verified through the upstream Next.js e2e suite, local full-path emulation, and live multi-replica deployments on GKE and generic clusters—see [docs/verification.md](./docs/verification.md) for what each layer covers and what it can't. The aim is a reference implementation for running full-fidelity Next.js on Kubernetes; remaining work centers on load testing, throughput tuning, skew protection, and published benchmarks. Expect APIs and generated infrastructure to change as that work lands. Issues and contributions welcome.

## Requirements

- Node.js >= 20.9.0
- Next.js >= 16.3.0
- Kubernetes >= 1.33 with the APIs required by the selected target components
- [Envoy Gateway](https://gateway.envoyproxy.io/) only when using `envoyNativeRouting`; `gcloud` only for GKE components
- `kubectl` and Helm >= 3.2 in PATH, plus a container runtime—`docker`, `podman`, or `nerdctl`.
  Helm 3 uses its client-side upgrade path; Helm 4 uses server-side apply.

Emitted container images run **Node 24** (the generated routing manifest requires it; the build fails on older bases rather than failing with a 500 at runtime).

### Reserved paths

`/healthz` (liveness) and `/readyz` (readiness + blue/green cutover gate) belong to the platform. A route, static output, or `public/` file at either path fails the build—a static 200 at `/readyz` could promote a broken pod, and a failing route there would block every deploy. Use `/health` or `/api/ready` instead.

## Quick start: an existing Kubernetes cluster

This is the portable path: any conformant cluster, any Gateway API or Ingress controller, no cloud-specific APIs. Next.js routing executes in the application origin, so no Envoy CRD is emitted.

### 1. Install

> **Good to know:** the package is not yet published to npm. Until it ships, install from source:
>
> ```bash
> git clone https://github.com/nextjs/adapter-k8s && cd adapter-k8s
> npm install && npm run build && npm link
> cd ../your-app && npm link @next-community/adapter-k8s
> ```

Once published:

```bash
npm install @next-community/adapter-k8s
```

### 2. Configure the adapter

Set the adapter via environment variable (no `next.config.ts` change needed). It must be exported in the environment where the build runs—your shell, or the CI job env:

```bash
export NEXT_ADAPTER_PATH=@next-community/adapter-k8s
```

Then create `adapter.config.mjs`:

```js
import {
  createK8sAdapter,
  defineTarget,
  gatewayApiExposure,
  kubernetesCluster,
} from "@next-community/adapter-k8s";

export default createK8sAdapter({
  pools: {
    default: {
      routes: ["appPages", "appRoutes", "pagesApi", "pages"],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },
  target: defineTarget({
    cluster: kubernetesCluster({
      access: { kind: "kubeconfig-context", context: "production" },
    }),
    exposure: gatewayApiExposure({
      className: "example",
      hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
      tlsSecretName: "app-tls",
    }),
  }),
});
```

Use `ingressExposure({ className: "nginx", ... })` instead for an Ingress controller—Gateway API and Ingress are exposure choices, not providers. `deploy` asks you to confirm the target cluster (`--yes` in CI) unless both the kubeconfig context (`access`, pinned above) and the cluster identity (`identity`) are pinned—see [cluster access and identity](./docs/targets.md#portable-gateway-api-or-ingress).

**Already run a shared Gateway?** Most clusters terminate TLS, DNS, and tunnels once on a fleet-wide Gateway rather than per app. Use `httpRouteExposure` to attach to it instead of creating another one—the adapter then emits HTTPRoutes only, and TLS stays the Gateway owner's concern:

```js
exposure: httpRouteExposure({
  className: "envoy",
  parentRefs: [{ name: "envoy-external", namespace: "network" }],
  hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
}),
```

If the images are in a private registry, add `imagePullSecrets: ["docker-regcred"]` at the top level—the Secret is yours to create; the adapter only references it.

### 3. Declare the registry

The CLI reads the container registry and release identity from `.k8s-adapter/infrastructure.json`. For an existing cluster, create it by hand:

```json
{
  "releaseName": "my-app",
  "containerRegistry": "registry.example.com/my-app",
  "hosts": ["app.example.com"]
}
```

The cluster's nodes must be able to pull from this registry.

### 4. Deploy

```bash
npx adapter-k8s deploy
```

This builds and pushes per-pool images plus the routing service when selected, runs the plan's preflight checks and `helm upgrade`, verifies the new pods and target resources are serving, and cuts traffic over blue/green.

Full walkthrough, TLS and NetworkPolicy notes: [docs/targets.md](./docs/targets.md#portable-gateway-api-or-ingress).

## Envoy Gateway: middleware at the edge

When the selected GatewayClass is managed by [Envoy Gateway](https://gateway.envoyproxy.io/), add `envoyNativeRouting()` to run middleware, rewrites, and redirects at the gateway as an ext_proc callout instead of in the application origin:

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

`deploy` verifies the `EnvoyExtensionPolicy` reports `Accepted=True` before cutting traffic. The in-cluster callout is plain h2c bounded by NetworkPolicy, so your CNI must actually enforce policy (verified on Cilium)—read [SECURITY.md](./SECURITY.md) before using this on a shared cluster. Full journey: [docs/targets.md](./docs/targets.md#envoy-gateway-native-routing).

Verified against Envoy Gateway 1.5.4–1.8.3; `deploy` warns (never fails) outside that range. Upgrading Envoy Gateway across a minor needs its CRDs applied first—`helm upgrade` does not upgrade CRDs, and 1.8 crashloops without `ListenerSet` until they are.

`httpRouteExposure` composes with this: when the shared Gateway is Envoy-managed, the extension policy targets the emitted HTTPRoute rather than the fleet's Gateway, so middleware runs at the edge without the adapter touching a shared object.

## Managed GKE: provisioned infrastructure

For GKE, `init` provisions everything and scaffolds the config:

```bash
npx adapter-k8s init --project-id my-project --host app.example.com
```

This idempotently provisions the cluster, static IP, Artifact Registry repo, GCS bucket, IAM service accounts, and managed TLS certificate. The GKE journey adds Cloud CDN with a Next.js-aware cache key and managed Memorystore-for-Valkey provisioning for the distributed cache (managed cache provisioning currently requires the `provider.gke` config shape that `init` scaffolds—see [configuration](./docs/configuration.md#distributed-cache-cache-components--ppr)). Full journey: [docs/targets.md](./docs/targets.md#managed-gke).

## CLI commands

| Command    | What it does                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`     | Provision cloud infrastructure and scaffold config. `--project-id`, `--region`, `--host`, `--dry-run`                                               |
| `deploy`   | Build, push, and deploy with blue/green cutover. `--skip-build`, `--skip-push`, `--dry-run`                                                         |
| `emit`     | Render a committable GitOps bundle—no cluster contact at all. `--cutover`, `--secrets`, `--previous-bundle`. See [docs/gitops.md](./docs/gitops.md) |
| `migrate`  | Annotate an existing release's retained set before pointing a pruning reconciler at it (GitOps prerequisite)                                        |
| `rollback` | Return to the previous build—pools scale back up, the routing tier reverts, traffic cuts over. Symmetric: running it again rolls forward            |
| `doctor`   | Health-check the whole stack: prerequisites, cloud resources, Kubernetes state, LB backend health, DNS + TLS                                        |
| `emulate`  | Run the full request path locally: Envoy → routing service → pool server                                                                            |
| `describe` | Live architecture diagram of your deployment with pod counts and revision tags                                                                      |
| `tail`     | Stream color-coded logs from all workloads                                                                                                          |
| `destroy`  | Tear down release-scoped resources; shared infrastructure (cluster, registry, certs) is kept and reported                                           |

Run `adapter-k8s --help` for the full flag list. Deploy, rollback, destroy, doctor, and state semantics are documented in [docs/lifecycle.md](./docs/lifecycle.md).

## Architecture

> **Middleware runs behind the CDN, not in front of it.** No CDN runs your compute before its cache, so cache _hits_ are served without invoking middleware; the routing service runs on cache _misses_ on the way to origin. To keep this correct, middleware-covered routes are sent `Cache-Control: no-cache` so they are never cached ahead of the middleware that gates them. This constraint shapes the whole architecture and applies to every target.

```
   Internet --> [CDN, optional] --> load balancer / gateway
                                          |
                                    cache miss
                                          |
                              +-----------v------------+
                              |    Routing service     |   ext_proc callout
                              |      @next/routing     |   (native routing targets)
                              |  middleware / rewrites |
                              |      / redirects       |
                              +-----------+------------+
                                          | sets x-upstream-pool
                          HTTPRoute header routing on x-upstream-pool
                                          |
                                   +------v-------+
                                   |   Cluster    |
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

With the default portable routing there is no callout tier: Next.js routing executes in the application origin. With `envoyNativeRouting` the callout is hosted by an in-cluster Envoy gateway; on GKE it is hosted by the Google load balancer as a traffic extension—the routing service itself is byte-identical across both. The difference that matters is trust: GXLB authenticates the callout by arriving from Google's frontend over TLS, whereas an in-cluster Envoy gateway dials plain h2c and is bounded by NetworkPolicy instead. Per-target diagrams: [docs/targets.md](./docs/targets.md).

## Configuration

Pools split routes across independently scaling groups; the full reference—route matching semantics, runtime environment, distributed cache, container strategy and runtimes, routing-service tuning, config variants—is in [docs/configuration.md](./docs/configuration.md).

```js
pools: {
  ssr:   { routes: ["appPages"], scaling: { min: 2, max: 20, targetCPU: 70 } },
  api:   { routes: ["appRoutes", "pagesApi"], scaling: { min: 2, max: 10, targetCPU: 60 } },
  heavy: { routes: ["/api/generate-report", "/api/export/*"], scaling: { min: 1, max: 5, targetCPU: 50 } },
},
```

## CI/CD

The CLI is a convenience wrapper—everything it does can be done with a container runtime, `helm`, and (on GKE) `gcloud`. The chart is self-contained, including the load-balancer extension registration. See [docs/ci-cd.md](./docs/ci-cd.md) for the pipeline shape, the blue/green cutover commands, and known runtime requirements—including why image digests must be resolved from the registry, not the local daemon.

## GitOps: Argo CD and Flux

`deploy` needs cluster credentials and performs the traffic cutover itself. On GitOps clusters neither is available: CI has no kubeconfig, and a reconciler owns apply. `emit` renders the same build's artifacts as a committable bundle instead—digest-pinned values, secrets externalized or SOPS-encrypted, no cluster contact at any point:

```bash
npx adapter-k8s emit --secrets sops        # or --secrets external (default)
# → .k8s-adapter/gitops/ : chart/ values/ manifests/ secrets/ emit-metadata.json
```

Commit the bundle; your reconciler applies it. Because a build's chart is an artifact of _that_ build, it is replaced wholesale on each emit—never edited in place, and never a target for Renovate or Flux image automation (the bundle ships a fence for both).

> **Do not point an auto-syncing reconciler at a chart produced by `deploy`.** The chart holds the traffic pointer at its pre-cutover value by design, so drift correction repoints traffic onto a build that has been scaled to zero. Measured against real Argo CD: reverted in ~2.4 minutes, with the Application still reporting Synced. `emit --cutover job` is the answer—the promotion runs in-cluster, gated by the same checks the CLI runs.

Run `migrate` once on any release that was previously deployed imperatively: it applies the prune-protection annotations that keep a reconciler from deleting the rollback target. Full recipes, ignore rules, and the evidence behind all of this: [docs/gitops.md](./docs/gitops.md) and [plans/gitops-deployment-strategies.md](./plans/gitops-deployment-strategies.md).

## Security

Defaults, in brief—the full model is in [SECURITY.md](./SECURITY.md):

- Workloads run non-root with read-only filesystems, dropped capabilities, and no service-account tokens.
- NetworkPolicies apply a strict ingress allowlist (load-balancer ranges, kubelet probes, sibling pools) discovered at deploy time; a deploy that can't establish isolation aborts rather than shipping without it.
- Internal dispatch headers between the routing tier and pools are authenticated with a per-build shared secret delivered only via Kubernetes Secrets; unauthenticated dispatch headers are stripped.
- **Known limit:** the routing-service callout currently relies on NetworkPolicy as its caller boundary—network reachability to the routing tier is equivalent to holding the dispatch credential. mTLS caller authentication is planned. Read the [threat model](./SECURITY.md#threat-model-in-one-paragraph) before using in-cluster native routing in a shared or hostile cluster.
- New deployments are pinned to immutable image digests (rollback's routing tier is currently tag-reconstructed—see [SECURITY.md](./SECURITY.md#image-provenance)); secrets never touch command lines, logs, or git.
- Cloud IAM is split into a minimally-scoped in-cluster identity and a push-capable CLI identity that no pod can assume.

## Documentation

- [docs/targets.md](./docs/targets.md) — the target model, the three journeys in full, custom components, legacy providers
- [docs/configuration.md](./docs/configuration.md) — full config reference
- [docs/lifecycle.md](./docs/lifecycle.md) — deploy, blue/green, rollback, destroy, doctor, state
- [docs/verification.md](./docs/verification.md) — what is verified, and how
- [docs/ci-cd.md](./docs/ci-cd.md) — running the pipeline without the CLI
- [docs/gitops.md](./docs/gitops.md) — `adapter-k8s emit`: committable GitOps bundles, and the reconciler hazards to know first
- [SECURITY.md](./SECURITY.md) — the security model

## Agent skills

The package ships [Agent Skills](https://agentskills.io) in [`skills/`](./skills) — the same convention Next.js and Vercel use to make their tools legible to coding agents. Once the package is installed, point your agent at them (tools following the [`skills/` in npm packages convention](https://github.com/antfu/skills-npm) discover `node_modules/@next-community/adapter-k8s/skills/*/SKILL.md` automatically):

- **configure** — inspects the cluster access you already have (kubeconfig context, GatewayClasses, IngressClasses, registry credentials) and writes a working `adapter.config.mjs`, asking only for what it cannot discover
- **deploy** — walks a deploy end to end and interprets each blue/green readiness gate, with a failure playbook
- **troubleshoot** — doctor-first symptom decision tree for a deployed release

A prompt like "prepare this project to deploy to my cluster" is enough: the configure skill handles discovery, target selection, and validation.

## Roadmap

- Skew protection (versioned routing for zero-mismatch deploys)
- mTLS caller authentication on the routing callout
- Digest-pinned rollback for the routing tier
- Additional exposure/routing presets
- Operational hardening: connection pooling, routing-service tuning, published benchmarks

## License

MIT
