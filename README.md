# @next-community/adapter-k8s

Build and deploy full-fidelity Next.js applications as independently scalable Kubernetes pools. The adapter uses Next.js 16.3's `adapterPath` API to generate Helm charts, Dockerfiles, and routing manifests from the build output.

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

Contributor guidance for a new controller or routing integration is in [CONTRIBUTING.md](./CONTRIBUTING.md) and [Writing a routing adapter](./docs/targets.md#writing-a-routing-adapter).

With a shared cache configured, cache components, Partial Prerendering (PPR), and ISR work correctly across replicas: cached entries are shared, and `revalidateTag` / `revalidatePath` on one pod is seen by all. See [Distributed cache](./docs/configuration.md#distributed-cache-cache-components--ppr).

CDN and middleware behavior are coordinated so cached responses can never bypass middleware-protected routes—see [Architecture](#architecture) for how.

## Status

This package is **not published to npm** and remains **experimental**. APIs and generated infrastructure may change before the first release. Claims are scoped to recorded evidence:

| Profile                         | Current evidence                                                                  | Boundary                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Pool runtime                    | Upstream Next.js e2e suite on the recorded Next ref                               | Known failures and the exact ref are listed in [verification](./docs/verification.md)                                             |
| GKE traffic extension           | Live multi-replica deploy, rollback, roll-forward, CDN, cache, and routing checks | GKE is the only provisioned cloud profile today                                                                                   |
| Generic Envoy Gateway           | Live k3s and Scaleway/Cilium deployments at the recorded versions                 | Other Gateway controllers are not implied                                                                                         |
| Portable Gateway API or Ingress | Unit tests and strict schema validation of native Kubernetes resources            | ingress-nginx is an exposure option with pool-local routing, not a native routing adapter; its live controller matrix is untested |

AWS components are intentionally deferred. The target contract keeps cluster access, registry, exposure, routing, and managed resources separate so an eventual EKS integration can be added without changing the pool runtime; that seam is not an AWS support claim. Performance, load behavior, and published benchmarks remain unverified.

### Why not `output: "standalone"` and three replicas?

That remains the simpler choice for a single process when per-route scaling, shared revalidation,
or adapter-managed rollout semantics are unnecessary. This adapter exists for a different contract:

- Route classes can run in independently scaled pools while `@next/routing` preserves Next's
  middleware, rewrite, redirect, and invocation decisions.
- Shared Valkey state coordinates cache entries and tag/path revalidation across replicas;
  middleware-covered responses are kept out of an upstream CDN cache so a cache hit cannot skip
  the middleware boundary.
- Cutover verifies every new pool and the routing tier before changing stable Service selectors.
  Rollback restores pool capacity, routing image/manifest state, and the traffic pointer; the
  GitOps path retains those rollback objects instead of letting Helm or a reconciler prune them.

Those are the measured differences. Merely scaling the standalone server to three replicas is
ordinary process redundancy, not the same cache, routing, and release protocol.

## Requirements

- Node.js >= 20.16.0 on Node 20, or >= 22.3.0 on Node 22 and newer
- Next.js >= 16.3.0 and < 16.4.0. Each Next.js release line is reviewed before this bound widens;
  the runtime rejects artifacts built outside it. The pinned 16.3 canary used by upstream
  conformance is an explicitly experimental verification lane, not part of the stable promise.
- Kubernetes >= 1.33 with the APIs required by the selected target components. This is the
  adapter's schema compatibility floor, not an upstream security-support promise; use a currently
  maintained Kubernetes minor for production.
- [Envoy Gateway](https://gateway.envoyproxy.io/) only when using `envoyNativeRouting`; `gcloud` only for GKE components
- `kubectl` and Helm >= 3.2 in PATH, plus a container runtime—`docker`, `podman`, or `nerdctl`.
  Helm 3 uses its client-side upgrade path; Helm 4 uses server-side apply.

Emitted pool and routing-service images pin **Node 24**. The current `@next/routing` API exposes
one case-sensitivity flag, while Next applies different defaults to custom and filesystem routes;
the generated manifest uses Node 24 scoped regex modifiers to preserve that split exactly. Local
`emulate` therefore also requires Node 24.

### Reserved paths

`/healthz` (liveness) and `/readyz` (readiness + blue/green cutover gate) belong to the platform. A route, static output, or `public/` file at either path fails the build—a static 200 at `/readyz` could promote a broken pod, and a failing route there would block every deploy. Use `/health` or `/api/ready` instead.

## Quick start: an existing Kubernetes cluster

This portable shape uses standard Kubernetes plus the exposure API selected in the target; it emits no cloud-specific API. Next.js routing executes in the application origin, so no Envoy CRD is emitted. The operator is still responsible for validating the chosen GatewayClass or Ingress controller, CNI enforcement, TLS, and streaming behavior.

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

Next.js 16.2 promoted adapters to the top-level `adapterPath` option. Configure that official
surface directly:

```js
// next.config.mjs
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export default {
  adapterPath: require.resolve("@next-community/adapter-k8s"),
};
```

Or use Next's official zero-config deployment-platform environment variable. It must be exported
where the build runs—your shell or CI job:

```bash
export NEXT_ADAPTER_PATH=@next-community/adapter-k8s
```

The configuration hook is top-level, not `experimental.adapterPath`. The adapter still depends on
experimental `@next/routing`, which is one reason this package remains experimental. See the
[Next.js adapter configuration](https://nextjs.org/docs/app/api-reference/adapters/configuration)
and [`@next/routing` status](https://nextjs.org/docs/app/api-reference/adapters/routing-with-next-routing).

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

This idempotently provisions the cluster, static IP, Artifact Registry repo, GCS bucket, IAM service accounts, and managed TLS certificate. The GKE journey adds Cloud CDN with a Next.js-aware cache key and managed Memorystore-for-Valkey provisioning for the distributed cache. `gkeCluster()` supplies the same managed-cache operation to composed targets; `init` still scaffolds the legacy `provider.gke` shape because Cloud CDN has not moved to the composition contract yet. See [configuration](./docs/configuration.md#distributed-cache-cache-components--ppr) and the full [GKE journey](./docs/targets.md#managed-gke).

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

With the default portable routing there is no callout tier: Next.js routing executes in the application origin. With `envoyNativeRouting` the callout is hosted by an in-cluster Envoy gateway; on GKE it is hosted by the Google load balancer as a traffic extension—the routing service itself is byte-identical across both. Envoy dials plain h2c; GKE uses server-authenticated TLS. Neither transport authenticates the caller to the routing service, so both profiles retain a required NetworkPolicy boundary. Per-target diagrams: [docs/targets.md](./docs/targets.md).

## Configuration

Pools split routes across independently scaling groups; the full reference—route matching semantics, runtime environment, distributed cache, container strategy and runtimes, routing-service tuning, config variants—is in [docs/configuration.md](./docs/configuration.md).

```js
pools: {
  ssr:   { routes: ["appPages"], scaling: { min: 2, max: 20, targetCPU: 70 } },
  api:   { routes: ["appRoutes", "pagesApi"], scaling: { min: 2, max: 10, targetCPU: 60 } },
  heavy: { routes: ["/api/generate-report", "/api/export/*"], scaling: { min: 1, max: 5, targetCPU: 50 } },
},
```

## Experimental WebSocket Route Handlers

The pool runtime supports Next's generated Node.js `upgradeHandler` adapter contract—the same
additive entrypoint consumed by adapter-vercel. This is transport support for the experimental
Next.js WebSocket work; stable Next.js does not yet expose `NextResponse.upgrade()`.

On a compatible Next.js branch, enable the experiment and keep the route dynamic:

```js
// next.config.js
export default {
  experimental: { webSocketRouteHandlers: true },
};
```

```ts
// app/ws/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.upgrade({
    open(peer) {
      peer.send("connected");
    },
    message(peer, message) {
      peer.send(message.rawData);
    },
  });
}
```

Once a compatible Next build generates the entrypoint, an upgrade follows the ordinary routing
path: trusted routing-extension results are reused, untrusted or incomplete results are resolved
locally, middleware and rewrites apply exactly once, and a route assigned to another pool is
tunnelled to its owning pool. A Route Handler can return an ordinary `Response` to reject the
upgrade; missing, non-Node, non-App-Route, and HTTP-only outputs answer `404 Not Found`, matching
Next's route-ownership contract. An ordinary HTTP request to a handler that returns
`NextResponse.upgrade()` receives Next's sanitized `426 Upgrade Required` fallback.

Current boundaries are deliberate:

- Node.js App Route outputs only—Pages Router, Edge Runtime, and static export are unsupported.
- External WebSocket rewrites are rejected instead of bypassing the HTTP proxy's SSRF protections.
- Peers and topic subscriptions are process-local. Multiple replicas need application-level shared
  pub/sub when messages must span pods.
- Connections are not durable across deploys, rollbacks, HPA scale-down, node replacement, or load
  balancer maintenance. Clients must reconnect, and should use a keepalive appropriate for their
  ingress/load-balancer timeout. State continuity needs an application cursor/session token and
  shared replay/pub-sub; a live connection cannot be transferred between pods.
- During shutdown the pod stops accepting upgrades, gives established sockets the configured
  bounded shutdown window, sends close code `1001` (going away), and then force-closes survivors. A
  socket tunnelled to another pool is relayed byte-for-byte, so it gets the `1001` only when its
  relayed frame stream is provably between frames at that instant; a socket caught mid-frame gets
  no injected close frame (splicing one into a frame's payload would corrupt it) and ends in an
  abnormal closure unless the peer pool happens to be draining too. The drain log's `tunnelled=`
  counter is exactly that population.

The same rollout contract covers finite response streams and SSE, including clean SSE EOF and
`Last-Event-ID` replay guidance. See [deploy lifecycle](./docs/lifecycle.md#long-lived-requests-during-cutover).

Treat this as an experimental compatibility surface until the Next.js API and its upstream e2e
suite are published. Exposure components supplied by an operator must preserve HTTP/1.1 WebSocket
upgrade semantics; the adapter cannot infer that property for an arbitrary GatewayClass or Ingress
controller. See the exact [verification boundary](./docs/verification.md#known-coverage-gaps).

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

Run `migrate` once on any release that was previously deployed imperatively: it applies the prune-protection annotations that keep a reconciler from deleting the rollback target. The copy-ready Flux `GitRepository`/`HelmRelease` recipe, ignore rules, and the evidence behind all of this are in [docs/gitops.md](./docs/gitops.md) and [plans/gitops-deployment-strategies.md](./plans/gitops-deployment-strategies.md).

## Security

Defaults, in brief—the full model is in [SECURITY.md](./SECURITY.md):

- Workloads run non-root with read-only filesystems, dropped capabilities, and no service-account tokens.
- NetworkPolicies apply a strict ingress allowlist (load-balancer ranges, kubelet probes, sibling pools) discovered at deploy time; a deploy that can't establish isolation aborts rather than shipping without it.
- Internal dispatch headers between the routing tier and pools are authenticated with a per-request HMAC proof derived from a per-build shared secret that is delivered only via Kubernetes Secrets and never sent on the wire; the proof binds the method, target, authority, scheme witness, dispatch header set and middleware-matcher inputs, and dispatch headers without a valid proof are stripped.
- **Known limit:** the routing-service callout still authenticates no callers, so NetworkPolicy remains a **required** part of the boundary—anything that can reach the routing tier can have a request of its own choosing resolved and signed, even though it can no longer read a replayable credential off the port. mTLS caller authentication is planned. Read the [threat model](./SECURITY.md#threat-model-in-one-paragraph) before using in-cluster native routing in a shared or hostile cluster.
- New deployments and modern rollback state pin the routing tier to immutable image digests. State written before digest recording falls back to the build tag with a warning—see [SECURITY.md](./SECURITY.md#image-provenance). Secrets never touch command lines, logs, or git.
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

The package ships [Agent Skills](https://agentskills.io) in [`skills/`](./skills) — versioned with the CLI so agents use instructions that match the installed adapter. Skills inside `node_modules` are not activated automatically by most agents. After installing the package, either run [`npx skills-npm setup`](https://github.com/antfu/skills-npm) once to discover and symlink package skills, or explicitly tell the agent to read `node_modules/@next-community/adapter-k8s/skills/configure/SKILL.md` (then `deploy/SKILL.md` for the deployment step):

- **configure** — inspects the cluster access you already have (kubeconfig context, GatewayClasses, IngressClasses, registry credentials) and writes a working `adapter.config.mjs`, asking only for what it cannot discover
- **deploy** — walks a deploy end to end and interprets each blue/green readiness gate, with a failure playbook
- **troubleshoot** — doctor-first symptom decision tree for a deployed release

A deterministic first prompt is: "Read `node_modules/@next-community/adapter-k8s/skills/configure/SKILL.md`, inspect this project and my cluster read-only, and prepare an application-only PR without deploying." After that PR is reviewed, point the agent at `skills/deploy/SKILL.md`, name the cluster-repository and kubeconfig paths, and authorize a second cluster PR without authorizing merge or live mutation. See the [two-PR agent workflow](./docs/gitops.md#two-pr-agent-onboarding).

## Roadmap

- Skew protection (versioned routing for zero-mismatch deploys)
- mTLS caller authentication on the routing callout
- Additional exposure/routing presets; AWS components are deferred until after the first release
- Operational hardening: connection pooling, routing-service tuning, published benchmarks

## License

MIT
