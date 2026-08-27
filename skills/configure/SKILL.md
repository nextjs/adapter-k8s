---
name: configure
description: adapter.config.mjs and application-PR authoring guidance for @next-community/adapter-k8s. Use when preparing a project for the adapter, opening a project-only setup PR, creating or editing adapter.config.mjs, picking a target composition (kubernetesCluster, gkeCluster, gatewayApiExposure, httpRouteExposure, ingressExposure, manualExposure, envoyNativeRouting), setting up pools, or preparing to run npx adapter-k8s deploy or emit.
---

# Configure adapter-k8s

You are a configuration author for `@next-community/adapter-k8s`. Your job is to produce a working `adapter.config.mjs` from what the user's environment already knows — discover first, ask only for what discovery cannot answer, then validate with a dry run.

## Rules

- **Discover before asking.** Never ask for anything `kubectl`, `gcloud`, or the environment can answer.
- **Never put a secret in `adapter.config.mjs`** — it is committed. Use `{ secret, key }` / `{ configMap, key }` env references. `NEXT_PUBLIC_*` in `env` is rejected by validation (build-time only).
- **`envoyNativeRouting` only for Envoy-controlled classes.** A non-Envoy GatewayClass programs the Gateway and then silently never calls the routing service. When unsure, omit `routing` — the default `portableRouting()` works on any exposure.
- **One of `target` or legacy `provider`, never both** — config validation rejects the pair.
- Every key you write must exist in `K8sAdapterConfig` (shipped as `dist/types.d.ts` in the installed package) and every component in `dist/target/components.d.ts`. Do not invent options.
- **Keep a project-PR request inside the project.** It may add the dependency, lockfile, adapter wiring, config, and non-secret SOPS recipient policy. It must not edit a cluster repository, push deployment images, run `emit`, apply Kubernetes resources, or merge either PR.

## Step 1 — Inspect what access exists

```bash
# Cluster access and flavor (a *.gke.gcloud.google.com context or gke_* name means GKE)
kubectl config get-contexts -o name   # zero contexts -> stop: no cluster access to configure against
kubectl config current-context        # may fail even when contexts exist (none selected)
kubectl cluster-info

# Exposure options actually installed
kubectl get gatewayclass          # CONTROLLER column: gateway.envoyproxy.io/... = Envoy Gateway
kubectl get ingressclass
# Shared Gateways already serving other apps — PREFER attaching to one (see step 3)
kubectl get gateway -A

# Node CPU architecture — decides ADAPTER_K8S_TARGET_PLATFORM (default linux/amd64)
kubectl get nodes -o jsonpath='{range .items[*]}{.status.nodeInfo.architecture}{"\n"}{end}' | sort -u

# GCP auth + registry hints
gcloud config get-value project 2>/dev/null
grep -o '"[^"]*"' ~/.docker/config.json 2>/dev/null | grep -E 'pkg.dev|gcr.io|docker.io|ghcr.io'

# Existing state — respect it if present
cat .k8s-adapter/infrastructure.json 2>/dev/null
ls adapter.config.* 2>/dev/null
```

## Step 2 — Ask only what is undiscoverable

| Always ask                     | Ask only if                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hostname(s) the app will serve | TLS secret name — TLS wanted and no cert-manager/controller-managed cert found                                                                                                                                     |
|                                | Registry — no `.k8s-adapter/infrastructure.json` and no usable hint from gcloud/docker config                                                                                                                      |
|                                | Which GatewayClass/IngressClass — more than one plausible candidate exists                                                                                                                                         |
|                                | Which kubectl context — more than one exists or none is current; pin the choice with `kubernetesCluster({ access: { kind: 'kubeconfig-context', context: '<name>' } })` so deploy stops prompting for confirmation |
|                                | Which shared Gateway to attach to — `kubectl get gateway -A` returned more than one candidate                                                                                                                      |
|                                | `imagePullSecrets` — the registry is private and the nodes have no ambient pull credentials (fleet convention is a `docker-regcred` Secret in the app namespace; the adapter references it, you create it)         |

Do not ask about pools, scaling, cache, or container strategy up front — scaffold sensible defaults (one `default` pool, `routes: ['appPages', 'appRoutes', 'pagesApi', 'pages']`, `scaling: { min: 2, max: 10, targetCPU: 70 }`) and mention they are tunable. Include `pages` even for App Router projects: it is one of the four output types, and omitting it fails classification the moment a Pages Router file appears.

## Step 3 — Pick the target composition

- **A shared Gateway already exists** (`kubectl get gateway -A` returned one serving other apps — the common fleet pattern, where TLS/DNS/tunnels are solved once) → `kubernetesCluster()` + `httpRouteExposure({ className, parentRefs: [{ name, namespace }], hosts })`. This emits HTTPRoutes ONLY — no Gateway, no Certificate, no ClientTrafficPolicy — so the adapter never touches a fleet-owned object and TLS stays the Gateway owner's concern. Add `envoyNativeRouting()` when that Gateway is Envoy-managed: the extension policy targets the emitted HTTPRoute, not the shared Gateway. Prefer this over creating a second Gateway, which on some fleets provisions a whole new proxy deployment and load-balancer IP per app.
- **GKE cluster** (context/cluster is GKE, gcloud authed) → `gkeCluster()` + `gatewayApiExposure({ className: 'gke-l7-global-external-managed', ... })` + `gkeNativeRouting()`; `npx adapter-k8s init --project-id <id> --host <host>` scaffolds and provisions this path end to end (as a legacy `provider.gke` block, which translates to the same composition) — prefer it over hand-writing.
- **Envoy Gateway class present, no shared Gateway to attach to** (controller `gateway.envoyproxy.io/gatewayclass-controller`, class usually `eg`) → `kubernetesCluster()` + `gatewayApiExposure({ className: 'eg', ingressSources: ... })` + `envoyNativeRouting({ gatewayClassName: 'eg' })`. The ingress allowlist must cover both non-merged proxies (the `owning-gateway-name` + `owning-gateway-namespace` pair) and merged proxies (`owning-gatewayclass`); copy the full example in `config-surface.md` and keep its release/namespace values aligned with `infrastructure.json`.
- **Any other GatewayClass** → `kubernetesCluster()` + `gatewayApiExposure({ className, hosts, tlsSecretName })`, no `routing` (portable default).
- **Only IngressClasses** → `kubernetesCluster()` + `ingressExposure({ className, hosts, tlsSecretName })`.
- **User manages exposure themselves** (mesh, existing LB) → `kubernetesCluster()` + `manualExposure({ hosts })`.

`gatewayApiExposure` requires `tlsSecretName`, `certManager`, or `controllerManagedTls` when any host has `tls.enabled`; it cannot mix TLS and plaintext hosts in one exposure. `ingressExposure` requires `tlsSecretName` or `certManager` when TLS is enabled. Either dedicated exposure can issue its own certificate with `certManager: { issuerRef: { name: 'letsencrypt-production', kind: 'ClusterIssuer' } }`; the adapter emits a cert-manager `Certificate` and gates readiness on it. `httpRouteExposure` takes none of these — it inherits the parent Gateway's TLS.

Full option surface, env/cache/pool details, and a complete non-GKE example: [references/config-surface.md](references/config-surface.md).

## Step 4 — Write, then validate

1. Write `adapter.config.mjs` at the project root (imports from `@next-community/adapter-k8s`, `export default createK8sAdapter({...})`).
2. For non-GKE targets, ensure `.k8s-adapter/infrastructure.json` exists with at least `containerRegistry` (deploy hard-fails without it) plus `releaseName`/`namespace`. `init` writes it on GKE; write it by hand otherwise.
3. Validate without touching the cluster. Config validation and target compilation run inside `next build` (the adapter's hooks), so build first; `--dry-run` alone reads the previous build's output and fails with "Build metadata not found" on a fresh project:

```bash
export NEXT_ADAPTER_PATH=@next-community/adapter-k8s
npx next build                    # validates config, compiles the target
npx adapter-k8s deploy --dry-run  # prints the deploy plan; never builds or touches the cluster
```

If validation fails, fix the exact reported key — the validators name the offending field. For an
imperatively managed cluster, tell the user the next command is:

```bash
npx adapter-k8s deploy
```

### Project-PR mode

When the user asks to prepare the application as the first half of a two-PR GitOps onboarding:

1. The adapter dependency must be reproducible on another checkout. Never commit `npm link`, an
   absolute `file:/Users/...` dependency, or a tarball path that exists only on this machine. Use a
   published/canary package or a stable package artifact URL. If none exists, validate locally but
   report package distribution as the blocker to opening a mergeable PR.
2. Commit only application-owned files: package manifest + lockfile, adapter wiring,
   `adapter.config.*`, and an optional `.sops.yaml` rule containing public recipients. Keep
   `.k8s-adapter/` ignored; it holds credentials, generated output, and local infrastructure state.
3. Create the ignored `.k8s-adapter/infrastructure*.json` only for local validation. Put its
   non-secret handoff facts in the PR description: release name, namespace, registry, hostname,
   target platform, and config variant. Never print or commit the internal-secret key.
4. Run `next build`, review the generated target/composition summary, and leave the tracked tree
   containing only the intended project setup.
5. Open the application PR and stop. The cluster PR is a later deploy-skill task against the exact
   reviewed application commit; generating it early makes its image digests and bundle stale.

**If the cluster is reconciled by Argo CD or Flux**, `deploy` is the wrong verb — CI has no kubeconfig there and the reconciler owns apply. Hand off to the packaged [deploy skill](../deploy/SKILL.md) and its [GitOps guide](../../docs/gitops.md), which use `npx adapter-k8s emit` to render a committable bundle without cluster contact. Two things to raise before they commit anything: run `npx adapter-k8s migrate` first on a release that was previously deployed imperatively, and use `--secrets sops` (or the default `external`) so the bundle never carries plaintext secrets.

## Gotchas

- **`.env` files never reach the containers** — supply runtime env via `env` / `envFrom` in the config (secret/configMap references preferred).
- **`nodeCidrs`**: leave unset on fixed-size clusters; set it on any cluster that autoscales or replaces nodes, or new nodes' kubelets cannot probe pods. Shape for `kubernetesCluster()`: `network: { nodeCidrs: { kind: 'static', cidrs: ['10.0.0.0/16'] } }` (the bare-array form belongs to the legacy `provider.generic` block only).
- **Cache off = per-replica ISR/PPR revalidation.** For shared revalidation set `cache: { enabled: true, provider: 'valkey' }`. `gkeCluster()` contributes managed Memorystore provisioning for both explicit and legacy GKE targets. Other targets require `cache.url` (`redis://`/`rediss://`) or their own managed-cache resource component.
- **Multi-cluster projects**: use variants (`adapter.config.<name>.mjs` + `.k8s-adapter/infrastructure.<name>.json`, selected by `ADAPTER_K8S_CONFIG=<name>`) instead of editing one file back and forth. A variant must provide both files — there is no fallback.
- **arm64 nodes need an explicit platform.** The image platform defaults to `linux/amd64` on every host (including Apple Silicon) and the chart stamps a matching `kubernetes.io/arch` node selector. If discovery showed `arm64` nodes, export `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` before `next build` AND `deploy` — otherwise pods sit Pending with `FailedScheduling` (not `exec format error`).
- **`/healthz` and `/readyz` are reserved** — an app route or public file at either path fails the build.
