---
name: deploy
description: adapter-k8s deploy expert guidance. Use when deploying a Next.js app to Kubernetes with @next-community/adapter-k8s, running next build with the adapter, reading blue/green cutover output, verifying a deploy with doctor/describe/tail, recovering from a failed readiness gate, or rendering a GitOps bundle with emit for an Argo CD / Flux cluster. Do not use for Vercel or generic Helm deployments.
metadata:
  priority: 8
  docs:
    - "https://www.npmjs.com/package/@next-community/adapter-k8s"
  pathPatterns:
    - "adapter.config.*"
    - ".k8s-adapter/**"
  importPatterns:
    - "@next-community/adapter-k8s"
  bashPatterns:
    - '\badapter-k8s\s+(deploy|emit|migrate|rollback|doctor|describe|tail|init|emulate|destroy)\b'
    - '^\s*npx\s+adapter-k8s(?:\s|$)'
    - '\bNEXT_ADAPTER_PATH='
    - '\bADAPTER_K8S_(CONFIG|CONTAINER_CLI|TARGET_PLATFORM)='
  promptSignals:
    phrases:
      - "deploy to kubernetes"
      - "adapter-k8s"
      - "blue/green cutover"
      - "readiness gate"
      - "pods not ready"
      - "gitops bundle"
      - "argo cd"
      - "flux"
    allOf:
      - [deploy, kubernetes]
      - [next, k8s]
    anyOf:
      - "rollback"
      - "cutover"
      - "helm upgrade"
    noneOf:
      - "vercel deploy"
      - "terraform"
    minScore: 6
retrieval:
  aliases:
    - kubernetes deploy
    - blue/green deploy
    - next.js k8s deploy
    - helm deploy next
  intents:
    - deploy the app to the cluster
    - run next build with the adapter
    - verify a deploy
    - roll back a bad build
    - debug a failed readiness gate
  entities:
    - adapter-k8s
    - NEXT_ADAPTER_PATH
    - adapter.config.mjs
    - .k8s-adapter/infrastructure.json
    - /readyz
    - helm upgrade
---

# Deploy

You are guiding a deploy of a Next.js app to Kubernetes with `@next-community/adapter-k8s`. Execute in strict order: prerequisites → build → deploy → readiness gates → cutover → verification. Do not skip verification because the CLI printed success — confirm with `doctor`.

## Rules

- **Never run `helm rollback`.** Helm revisions are reconciliation snapshots captured before the adapter's verified Service-selector cutover — a raw Helm rollback does not restore adapter state, routing state, pool capacity, or CDN state, and can restore a pre-cutover stable Service selector. Use `npx adapter-k8s rollback` only.
- **A failed deploy is not a cut-over deploy.** Every readiness gate aborts BEFORE traffic switches and restores the ext_proc edge to the previous build — the fix is diagnose + re-run `deploy`, never `rollback`.
- **Never pass `--skip-build` after changing config, target, namespace, or `ADAPTER_K8S_TARGET_PLATFORM`** — the chart bakes registry, namespace, and platform at build time, and deploy hard-rejects mismatched artifacts.
- **Never put secrets or `NEXT_PUBLIC_*` in `adapter.config.mjs` `env`** — use `{ secret, key }` references; `NEXT_PUBLIC_*` is inlined at build time and validation rejects it.
- Boolean flags never take a value (`--dry-run foo` is a parse warning, not a value). `--flag value` and `--flag=value` both work for value flags.

## Prerequisites

Check before anything else; `npx adapter-k8s doctor` runs these as its Prerequisites section.

| Requirement       | Check                                                                                           | Notes                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js >= 20.9.0 | `node --version`                                                                                | `engines` requirement of the package                                                                                                      |
| kubectl in PATH   | `kubectl version --client`                                                                      | context must point at the target cluster                                                                                                  |
| Helm >= 3.2       | `helm version --short`                                                                          | deploy probes `--create-namespace` support and aborts on older Helm; Helm 3 = client-side upgrade, Helm 4 = server-side apply             |
| Container runtime | `docker`/`podman`/`nerdctl`                                                                     | probed in that order; force one with `ADAPTER_K8S_CONTAINER_CLI`                                                                          |
| Adapter wired     | `NEXT_ADAPTER_PATH=@next-community/adapter-k8s` exported, or `adapterPath` set in `next.config` | wires the adapter into `next build`; without it the build emits no `.k8s-adapter` output and deploy fails with "Build metadata not found" |
| Adapter config    | `adapter.config.mjs`/`.ts`/`.js` in the project root                                            | `init` scaffolds it; missing config falls back to defaults with a console note                                                            |
| Infra config      | `.k8s-adapter/infrastructure.json` exists                                                       | written by `npx adapter-k8s init`; deploy fails without `containerRegistry`                                                               |

## Quick Start

```bash
# 1) One-time: provision infra + scaffold adapter.config.mjs (GKE preset shown)
npx adapter-k8s init --project-id my-project --host app.example.com

# 2) Wire the adapter for every next build in this shell (or set adapterPath in next.config).
export NEXT_ADAPTER_PATH=@next-community/adapter-k8s

# 3) Deploy — runs next build itself (the adapter's onBuildComplete emits chart,
#    Dockerfiles, manifests), then builds/pushes images and helm-upgrades
npx adapter-k8s deploy            # add --yes in CI to skip the unpinned-context prompt

# 4) Verify
npx adapter-k8s doctor            # exits 1 on any FAIL
npx adapter-k8s describe          # live architecture diagram, pod counts, revision tags
npx adapter-k8s tail              # color-coded logs from all workloads
```

## Reading Deploy Output

`deploy` is blue/green: each build gets its own versioned Deployments; the stable active Service selector is patched only after every gate passes. Expect this sequence:

1. `→ Running next build...` then image build/push — images are pinned to registry `@sha256:` digests (registry-first; local podman digests are untrusted).
2. `→ Running helm upgrade...` — from here the ext_proc edge MAY run the new build; pools still serve the old one.
3. Readiness gates, in order: pool Deployment rollouts (`kubectl rollout status`, 600s budget each — matching the chart's `progressDeadlineSeconds`; the printed failure message still says "120s") → routing-service rollout → ext_proc registration Job complete (GKE) or `EnvoyExtensionPolicy accepted ✓` (generic) → composition-plan readiness → capacity warm-up (`→ Warming <hpa>...` temporarily lifts HPA bounds to match outgoing replicas) → `→ Verifying new pods are serving...` (per-pool ready count must match the outgoing build's live count, probed via `/readyz`, 2-minute budget).
4. `→ Switching traffic to new build...` — the actual cutover: stable Service selectors patched to the new version label.
5. Cleanup: `→ Previous build scaled to 0 (kept for rollback)`, old builds deleted, CDN invalidated.
6. `✓ Deploy complete (build: <id>)`.

Any gate failure prints `Traffic was NOT switched — the previous build's pools are still serving`, restores the edge, and exits 1.

## Post-Deploy Verification

```bash
npx adapter-k8s doctor      # prerequisites, local config, deploy state (current +
                            # previous build), cloud resources, K8s resources,
                            # composition-plan readiness, ext_proc wiring, DNS + TLS
npx adapter-k8s describe    # confirm the serving build id and per-pool pod counts
npx adapter-k8s tail        # watch for runtime errors under first traffic
```

Confirm each checkpoint: doctor shows 0 failures; `describe` shows the new build id serving; `tail` shows no crash loops. If verification fails, stop and report the exact failing check plus its printed `Fix:` line.

## GitOps clusters: emit, do not deploy

If the cluster is reconciled by Argo CD or Flux, `deploy` is the wrong verb: CI has no kubeconfig, and pointing an auto-syncing reconciler at a chart produced by `deploy` causes an outage — the chart holds the traffic pointer at its pre-cutover value by design, so drift correction repoints traffic onto the build that was just scaled to zero (measured against real Argo CD: ~2.4 minutes, Application still reporting Synced).

```bash
npx adapter-k8s migrate                     # ONCE per release previously deployed imperatively:
                                            # applies prune-protection to the retained rollback set
npx adapter-k8s emit --cutover job \
  --cutover-image ghcr.io/example/adapter-k8s-cutover@sha256:<digest> \

  --secrets sops                            # or the default --secrets external
# commit .k8s-adapter/gitops/ ; the reconciler applies it
```

Under `--cutover job` the bundle's stable Services render at the PREVIOUS build (sync is not cutover) and an in-cluster Job runs the same gate battery this skill describes, then promotes. `--cutover-image` must be digest-pinned (`name@sha256:<64 hex>`); `:latest` is refused. Under the default `--cutover none` the bundle is inert: you cut over yourself per `docs/ci-cd.md`. Split repos (app repo emits, cluster repo holds bundles) need `--previous-bundle <path>` — emit refuses rather than guessing that a missing prior bundle means a first deploy. Full recipes and the ignore rules a reconciler needs: `docs/gitops.md`.

## Failure Playbook

See [references/failure-playbook.md](references/failure-playbook.md) for:

- Diagnosing each readiness-gate failure (rollout timeout, ext_proc not accepted, capacity gate shortfall, `/readyz` reasons)
- When to re-run `deploy` vs when to `rollback` (and rollback's symmetric roll-forward)
- Why `helm rollback` is forbidden, with the exact failure modes
- Escape-hatch flags (`--allow-no-network-policy`, `--allow-mutable-tags`, `--allow-unretained-manifest`) and what each trades away

## Gotchas

- **Wrong cluster**: deploy prompts `Type "yes" to confirm this kubectl context` when the context cannot be verified as the intended cluster. In CI pass `--yes` only after pinning the context. `rollback` gates on the same confirmation — an unpinned context makes it exit with "Rollback target access is not independently verifiable"; re-run with `--yes` after confirming the context.
- **Release name drift**: commands resolve the release from `--release-name`, then `.k8s-adapter/infrastructure.json`, then the sanitized directory name. Running from a differently-named directory without the persisted file targets the wrong release.
- **Multi-target projects**: `ADAPTER_K8S_CONFIG=<variant>` selects `adapter.config.<variant>.mjs` + `.k8s-adapter/infrastructure.<variant>.json` + its own build output. Mixing a variant's flags with another's output is rejected by the target fingerprint.
- **`/healthz` and `/readyz` are reserved** — an app route at either path fails the build; `/readyz` is the cutover gate.
- **ARM nodes**: the platform DEFAULTS to `linux/amd64` regardless of the host or cluster — check first (`kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'`) and set `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` for BOTH `next build` and `deploy` on arm64 nodes (Apple Silicon k3d/kind, Graviton, GKE T2A); the platform is baked into the artifact and a mismatch is rejected. The chart also stamps a `kubernetes.io/arch` node selector, so a wrong-platform build does not `exec format error` — pods sit **Pending** with `FailedScheduling: node(s) didn't match Pod's node affinity/selector` until the rollout gate times out.
