---
name: configure
description: adapter.config.mjs authoring expert guidance for @next-community/adapter-k8s. Use when creating or editing adapter.config.mjs, picking a target composition (kubernetesCluster, gkeCluster, gatewayApiExposure, ingressExposure, manualExposure, envoyNativeRouting), setting up pools, or preparing a project to run npx adapter-k8s deploy.
metadata:
  priority: 8
  docs:
    - "https://github.com/nextjs/adapter-k8s#readme"
  pathPatterns:
    - "adapter.config.*"
    - ".k8s-adapter/**"
  bashPatterns:
    - '\badapter-k8s\s+init\b'
    - '\badapter-k8s\s+deploy\b'
    - '\bnpx\s+adapter-k8s\b'
    - '\bkubectl\s+get\s+gatewayclass'
  importPatterns:
    - "@next-community/adapter-k8s"
  promptSignals:
    phrases:
      - "adapter.config"
      - "deploy next.js to kubernetes"
      - "adapter-k8s"
      - "set up the adapter"
    allOf:
      - [next, kubernetes]
      - [configure, adapter]
    anyOf:
      - "gatewayclass"
      - "ingress"
      - "gke"
    noneOf:
      - "terraform"
      - "vercel deploy"
    minScore: 6
retrieval:
  aliases:
    - adapter config
    - k8s adapter setup
    - kubernetes target
  intents:
    - create adapter.config.mjs
    - pick a target composition
    - configure pools and scaling
    - choose gateway or ingress exposure
    - prepare a project for adapter-k8s deploy
  entities:
    - adapter.config.mjs
    - defineTarget
    - kubernetesCluster
    - gatewayApiExposure
    - envoyNativeRouting
    - gkeCluster
    - infrastructure.json
---

# Configure adapter-k8s

You are a configuration author for `@next-community/adapter-k8s`. Your job is to produce a working `adapter.config.mjs` from what the user's environment already knows — discover first, ask only for what discovery cannot answer, then validate with a dry run.

## Rules

- **Discover before asking.** Never ask for anything `kubectl`, `gcloud`, or the environment can answer.
- **Never put a secret in `adapter.config.mjs`** — it is committed. Use `{ secret, key }` / `{ configMap, key }` env references. `NEXT_PUBLIC_*` in `env` is rejected by validation (build-time only).
- **`envoyNativeRouting` only for Envoy-controlled classes.** A non-Envoy GatewayClass programs the Gateway and then silently never calls the routing service. When unsure, omit `routing` — the default `portableRouting()` works on any exposure.
- **One of `target` or legacy `provider`, never both** — config validation rejects the pair.
- Every key you write must exist in `K8sAdapterConfig` (shipped as `dist/types.d.ts` in the installed package) and every component in `dist/target/components.d.ts`. Do not invent options.

## Step 1 — Inspect what access exists

```bash
# Cluster access and flavor (a *.gke.gcloud.google.com context or gke_* name means GKE)
kubectl config get-contexts -o name   # zero contexts -> stop: no cluster access to configure against
kubectl config current-context        # may fail even when contexts exist (none selected)
kubectl cluster-info

# Exposure options actually installed
kubectl get gatewayclass          # CONTROLLER column: gateway.envoyproxy.io/... = Envoy Gateway
kubectl get ingressclass

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

Do not ask about pools, scaling, cache, or container strategy up front — scaffold sensible defaults (one `default` pool, `routes: ['appPages', 'appRoutes', 'pagesApi']`, `scaling: { min: 2, max: 10, targetCPU: 70 }`) and mention they are tunable.

## Step 3 — Pick the target composition

- **GKE cluster** (context/cluster is GKE, gcloud authed) → `gkeCluster()` + `gatewayApiExposure({ className: 'gke-l7-global-external-managed', ... })` + `gkeNativeRouting()`; `npx adapter-k8s init --project-id <id> --host <host>` scaffolds and provisions this path end to end (as a legacy `provider.gke` block, which translates to the same composition) — prefer it over hand-writing.
- **Envoy Gateway class present** (controller `gateway.envoyproxy.io/gatewayclass-controller`, class usually `eg`) → `kubernetesCluster()` + `gatewayApiExposure({ className: 'eg', ... })` + `envoyNativeRouting({ gatewayClassName: 'eg' })`.
- **Any other GatewayClass** → `kubernetesCluster()` + `gatewayApiExposure({ className, hosts, tlsSecretName })`, no `routing` (portable default).
- **Only IngressClasses** → `kubernetesCluster()` + `ingressExposure({ className, hosts, tlsSecretName })`.
- **User manages exposure themselves** (mesh, existing LB) → `kubernetesCluster()` + `manualExposure({ hosts })`.

`gatewayApiExposure` requires `tlsSecretName` or `controllerManagedTls` when any host has `tls.enabled`; it cannot mix TLS and plaintext hosts in one exposure. `ingressExposure` requires `tlsSecretName` when TLS is enabled.

Full option surface, env/cache/pool details, and a complete non-GKE example: [references/config-surface.md](references/config-surface.md).

## Step 4 — Write, then validate

1. Write `adapter.config.mjs` at the project root (imports from `@next-community/adapter-k8s`, `export default createK8sAdapter({...})`).
2. For non-GKE targets, ensure `.k8s-adapter/infrastructure.json` exists with at least `containerRegistry` (deploy hard-fails without it) plus `releaseName`/`namespace`. `init` writes it on GKE; write it by hand otherwise.
3. Validate without touching the cluster. Config validation and target compilation run inside `next build` (the adapter's hooks), so build first; `--dry-run` alone reads the previous build's output and fails with "Build metadata not found" on a fresh project:

```bash
# Absolute file path, not the bare package name — Next resolves adapterPath with
# require.resolve(), and the package's exports map is ESM-only, so
# NEXT_ADAPTER_PATH=@next-community/adapter-k8s fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
export NEXT_ADAPTER_PATH="$PWD/node_modules/@next-community/adapter-k8s/dist/index.js"
npx next build                    # validates config, compiles the target
npx adapter-k8s deploy --dry-run  # prints the deploy plan; never builds or touches the cluster
```

If validation fails, fix the exact reported key — the validators name the offending field. Then tell the user the next command is:

```bash
npx adapter-k8s deploy
```

## Gotchas

- **`.env` files never reach the containers** — supply runtime env via `env` / `envFrom` in the config (secret/configMap references preferred).
- **`nodeCidrs`**: leave unset on fixed-size clusters; set it on any cluster that autoscales or replaces nodes, or new nodes' kubelets cannot probe pods. Shape for `kubernetesCluster()`: `network: { nodeCidrs: { kind: 'static', cidrs: ['10.0.0.0/16'] } }` (the bare-array form belongs to the legacy `provider.generic` block only).
- **Cache off = per-replica ISR/PPR revalidation.** For shared revalidation set `cache: { enabled: true, provider: 'valkey' }`. Every `target` composition requires `cache.url` (`redis://`/`rediss://`) when cache is enabled; managed Memorystore provisioning happens only on the legacy `provider.gke` path (what `init` scaffolds).
- **Multi-cluster projects**: use variants (`adapter.config.<name>.mjs` + `.k8s-adapter/infrastructure.<name>.json`, selected by `ADAPTER_K8S_CONFIG=<name>`) instead of editing one file back and forth. A variant must provide both files — there is no fallback.
- **arm64 nodes need an explicit platform.** The image platform defaults to `linux/amd64` on every host (including Apple Silicon) and the chart stamps a matching `kubernetes.io/arch` node selector. If discovery showed `arm64` nodes, export `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` before `next build` AND `deploy` — otherwise pods sit Pending with `FailedScheduling` (not `exec format error`).
- **`/healthz` and `/readyz` are reserved** — an app route or public file at either path fails the build.
