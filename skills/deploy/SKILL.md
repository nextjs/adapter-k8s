---
name: deploy
description: adapter-k8s deploy and GitOps cluster-PR guidance. Use when deploying a Next.js app to Kubernetes with @next-community/adapter-k8s, preparing a second PR in a Flux or Argo CD repository from an adapter-ready project, inspecting a named kubeconfig/environment, rendering a GitOps bundle with emit, reading blue/green cutover output, verifying with doctor/describe/tail, or recovering from a failed readiness gate. Do not use for Vercel or generic Helm deployments.
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

| Requirement                                             | Check                                                                                           | Notes                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js >= 20.16.0 on Node 20, or >= 22.3.0 on Node 22+ | `node --version`                                                                                | `engines` requirement; host-side emulate/cache paths use `process.getBuiltinModule`                                                       |
| Node.js >= 24 for `emulate`                             | `node --version`                                                                                | local pool/routing processes compile the generated scoped regexp modifiers; emitted images already pin Node 24                            |
| kubectl in PATH                                         | `kubectl version --client`                                                                      | context must point at the target cluster                                                                                                  |
| Helm >= 3.2                                             | `helm version --short`                                                                          | deploy probes `--create-namespace` support and aborts on older Helm; Helm 3 = client-side upgrade, Helm 4 = server-side apply             |
| Container runtime                                       | `docker`/`podman`/`nerdctl`                                                                     | probed in that order; force one with `ADAPTER_K8S_CONTAINER_CLI`                                                                          |
| Adapter wired                                           | `NEXT_ADAPTER_PATH=@next-community/adapter-k8s` exported, or `adapterPath` set in `next.config` | wires the adapter into `next build`; without it the build emits no `.k8s-adapter` output and deploy fails with "Build metadata not found" |
| Adapter config                                          | `adapter.config.mjs`/`.ts`/`.js` in the project root                                            | `init` scaffolds it; missing config falls back to defaults with a console note                                                            |
| Infra config                                            | `.k8s-adapter/infrastructure.json` exists                                                       | written by `npx adapter-k8s init`; deploy fails without `containerRegistry`                                                               |

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
npx adapter-k8s tail              # color-coded logs from all workloads; for an unpinned
                                  # portable target, check `kubectl config current-context`
                                  # first, then add --yes
```

## Reading Deploy Output

`deploy` is blue/green: each build gets its own versioned Deployments; the stable active Service selector is patched only after every gate passes. Expect this sequence:

1. `→ Running next build...` then image build/push — images are pinned to registry `@sha256:` digests (registry-first; local podman digests are untrusted).
2. `→ Running helm upgrade...` — from here the ext_proc edge MAY run the new build; pools still serve the old one.
3. Readiness gates, in order: pool Deployment rollouts (`kubectl rollout status`, 600s each — these Deployments are created fresh per build, so their pods come up in parallel) → routing-service rollout (the one Deployment patched IN PLACE per build, so it surges serially: budget DERIVED per deploy from that tier's own live replica count x the chart's 285s surge cost — 600s floor, 1800s cap, and the failure message quotes the budget it used) → ext_proc registration Job complete (GKE) or `EnvoyExtensionPolicy accepted ✓` (generic) → composition-plan readiness → capacity warm-up (`→ Warming <hpa>...` temporarily lifts HPA bounds to match outgoing replicas) → `→ Verifying new pods are serving...` (per-pool ready count must match the outgoing build's live count, probed via `/readyz`, 2-minute budget).
4. `→ Switching traffic to new build...` — the actual cutover: stable Service selectors patched to the new version label.
5. Cleanup: `→ Previous build scaled to 0 (kept for rollback)`, old builds deleted, CDN invalidated.
6. `✓ Deploy complete (build: <id>)`.

Any gate failure prints `Traffic was NOT switched — the previous build's pools are still serving`, restores the edge, and exits 1.

### Long-lived requests at cutover

The Service-selector flip sends new connections to the new build; it does not transfer an open
connection or handler state between pods. The old pool drains finite HTTP/RSC responses for up to
60 seconds after SIGTERM, ends surviving SSE responses with a clean EOF, and sends established
WebSockets close code `1001` before forced teardown. SSE clients need event `id` fields plus shared
replay storage for `Last-Event-ID`; WebSocket clients need reconnect/backoff and application-level
resume state. An abrupt node/process failure can bypass those graceful signals. See
`docs/lifecycle.md#long-lived-requests-during-cutover` in the package repository for the full
contract.

## Post-Deploy Verification

```bash
npx adapter-k8s doctor      # prerequisites, local config, deploy state (current +
                            # previous build), cloud resources, K8s resources,
                            # composition-plan readiness, ext_proc wiring, DNS + TLS
npx adapter-k8s describe    # confirm the serving build id and per-pool pod counts
npx adapter-k8s tail        # watch for runtime errors; on an unpinned portable target, check
                            # `kubectl config current-context` first, then add --yes
```

Confirm each checkpoint: doctor shows 0 failures; `describe` shows the new build id serving; `tail` shows no crash loops. If verification fails, stop and report the exact failing check plus its printed `Fix:` line.

## GitOps clusters: emit, do not deploy

If the cluster is reconciled by Argo CD or Flux, `deploy` is the wrong verb: CI has no kubeconfig, and pointing an auto-syncing reconciler at a chart produced by `deploy` causes an outage — the chart holds the traffic pointer at its pre-cutover value by design, so drift correction repoints traffic onto the build that was just scaled to zero (measured against real Argo CD: ~2.4 minutes, Application still reporting Synced).

### Second PR: application commit → cluster repository

For a two-PR onboarding, begin only after the application PR is merged or the user names an exact
reviewed commit. The second agent needs the application checkout, cluster-repository path, and
kubeconfig path. Then:

1. Read the cluster repository's agent instructions and obtain any consent they require before
   edits. Use a fresh clean branch/worktree; never build a demo PR on unrelated local changes.
2. Point `KUBECONFIG` at the named environment and inspect it read-only: server version, node
   architecture/CIDRs, Gateway/Ingress classes, existing shared Gateways, certificate issuers,
   registry pull Secrets, DNS controller sources, and public tunnel/ingress conventions. GETs are
   discovery, not authorization to apply.
3. Recreate the ignored `.k8s-adapter/infrastructure*.json` from the application PR handoff and
   verify release, namespace, registry, hostname, platform, and config variant match the reviewed
   config. Obtain the internal-secret key through an environment/secret store; never log or commit
   it.
4. Build and push the application and cutover images, resolve immutable registry digests, and run
   `emit` from the application checkout. `emit` itself makes no cluster contact.
5. Replace the cluster repo's release bundle wholesale and add only cluster-owned integration:
   Flux/Argo wrappers, SOPS decryption, namespace/pull-secret components, DNS, certificate/shared
   Gateway references, and tunnel routes required by that environment.
6. Validate the cluster-repository build locally, show the diff, open the cluster PR, and stop.
   Do not merge it, run `kubectl apply`, or force a Flux reconcile unless the user separately
   authorizes that live deployment action. The PR merge is the intended deployment trigger.

Record the exact application commit and `emit-metadata.json` build ID in the cluster PR so reviewers
can prove which source produced every digest in the bundle.

```bash
# Existing imperative release only, once before its first reconciler sync:
npx adapter-k8s migrate

# First GitOps build for a genuinely new release:
npx adapter-k8s emit --cutover job \
  --cutover-image ghcr.io/example/adapter-k8s-cutover@sha256:<digest> \
  --secrets sops \
  --first-deploy

# Later builds use this history flag instead of --first-deploy:
npx adapter-k8s emit --cutover job \
  --cutover-image ghcr.io/example/adapter-k8s-cutover@sha256:<digest> \
  --secrets sops \
  --previous-bundle ../cluster-repo/kubernetes/apps/<namespace>/<release>/app/bundle
```

Under `--cutover job` the bundle's stable Services render at the PREVIOUS build (sync is not cutover) and an in-cluster Job runs the same gate battery this skill describes, then promotes. `--cutover-image` must be digest-pinned (`name@sha256:<64 hex>`); `:latest` is refused. Under the default `--cutover none` the bundle is inert: you cut over yourself per the [CI/CD guide](../../docs/ci-cd.md). Split repos (app repo emits, cluster repo holds bundles) need `--previous-bundle <path>` — emit refuses rather than guessing that a missing prior bundle means a first deploy.

Build the cutover image before emit. Inspect the API server minor and node architecture; the
Dockerfile intentionally has no kubectl default because Kubernetes supports kubectl only within
one minor of the API server. Build for the node platform even when the workstation differs, push,
then resolve and use the immutable registry digest:

```bash
# Example only: amd64 nodes and a Kubernetes 1.35 API server.
npm run build
docker build --platform=linux/amd64 --build-arg KUBECTL_VERSION=v1.35.7 \
  -f docker/cutover-job.Dockerfile -t <registry>/adapter-k8s-cutover:<version> .
docker push <registry>/adapter-k8s-cutover:<version>
```

When working from an installed package rather than this source repository, the same Dockerfile and
built `dist/` are under `node_modules/@next-community/adapter-k8s`; use that package directory as
the Docker build context.

For Flux with a chart committed in the cluster repository, use the copy-ready
[GitRepository/HelmRelease recipe](../../docs/gitops.md#flux-recipe-a-chart-committed-in-the-cluster-repository).
The non-negotiable pieces are:

- copy the emitted bundle wholesale; do not hand-edit image fields inside it;
- use a Git-sourced `HelmRelease` with the default `ChartVersion` strategy and the emitted values
  file; each emitted build bumps `Chart.yaml`, while an unrelated cluster-repository commit must
  not trigger an upgrade that reapplies pre-cutover Service selectors;
- when the Flux objects live in the app namespace but their `GitRepository` lives in
  `flux-system`, confirm both controllers allow cross-namespace source references; otherwise use
  an equivalent same-namespace source;
- enable drift detection but ignore `/spec/selector` on `Service` resources, kind-wide;
- reconcile `bundle/secrets` through a SOPS-enabled Flux `Kustomization` before the HelmRelease,
  and set its `spec.targetNamespace` to the app namespace (the Flux object's own namespace does
  not default namespace-less Secret manifests);
- make the app repo's `.sops.yaml` creation rule cover `.k8s-adapter/gitops/secrets/*.sops.yaml`;
- leave Job waiting enabled and give the HelmRelease enough timeout for the sequential cutover
  gates. Budget pool rollouts, the routing rollout, provider registration, the sum of the
  composition-plan readiness deadlines, the capacity gate, and command overhead (see
  docs/gitops.md); a timeout that fires mid-cutover makes Flux roll the release back onto the
  pre-cutover Service selectors while the Job patches them forward;
- inspect how existing apps make a hostname reachable and mirror every cluster-owned prerequisite
  the adapter does not emit: DNS records/controllers, tunnel routes, certificate issuers, shared
  Gateway parentRefs, registry pull Secrets, and SOPS keys. An accepted HTTPRoute alone does not
  prove that public DNS or a tunnel reaches that Gateway;
- merge the emitted Renovate ignore path into the cluster repository's root config;
- for the next build, pass the committed prior `bundle` path to `--previous-bundle` and replace it wholesale.

Respect the cluster repository's own agent instructions before creating files or opening a PR.
For a repository that requires consent before GitOps changes, stop after showing the proposed diff
until the user approves it.

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
