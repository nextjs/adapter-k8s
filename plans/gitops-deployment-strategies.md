# `@next-community/adapter-k8s` — GitOps and Deployment Strategies

**Status:** Draft
**Authors:** David Ilie
**Last Updated:** 2026-08-10
**Depends on:** [adapter-gke-design-doc.md](./adapter-gke-design-doc.md) (§6.6 skew protection, §13 chart layout), [docs/lifecycle.md](../docs/lifecycle.md), [docs/ci-cd.md](../docs/ci-cd.md)

---

## 1. Problem Statement

`adapter-k8s deploy` is an imperative orchestrator wrapped around a declarative core. The chart emitted by `onBuildComplete` is genuinely declarative — no hooks, no `lookup`, no `.Capabilities`, byte-deterministic render (helm.ts:104-120, values-yaml.ts:164-170) — but the deploy command surrounds `helm upgrade` with roughly forty imperative steps, and a subset of them are not merely _un_-declarative but actively **fight** any reconciler that syncs the rendered chart against the cluster:

**Steps that fight a controller (drift correction = outage):**

- **The Service selector cutover (deploy.ts:3651-3805).** The chart renders the stable active Service's selector from `.Values.activeBuildId`, and deploy passes `activeBuildId=<previous build>` to `helm upgrade` deliberately (deploy.ts:1193) so the upgrade itself never repoints traffic. Cutover is a later `kubectl patch --type=json` after the `/readyz` gates pass. After cutover, the last-rendered manifest says _previous_ while the live object says _new_. An Argo CD auto-sync "corrects" this drift by patching the selector back to the previous build — **which deploy has just scaled to zero** (deploy.ts:3963-4020). Reconciliation reverts a verified cutover onto an empty Deployment. The site 503s. This is the single sharpest hazard in the whole design.
- **Keep-transfers and retained resources (deploy.ts:2535-2736, 2656-2664).** Deploy patches `helm.sh/resource-policy: keep` onto the live previous-build Deployment and HPA, injects a `<pool>-prev-service.yaml` into the chart dir post-render, and snapshots the live routing-manifest ConfigMap to a build-named copy (rollback.ts:158-457) — all so the outgoing build survives Helm's prune as a rollback target. A GitOps engine rendering the pristine chart sees every one of those objects as an orphan. Argo's default prune deletes the previous build's Deployment, its dispatch Secret, and its manifest snapshot — bricking rollback _and_ any restart of an old pod (`secretKeyRef` → CreateContainerConfigError, internal-secret.ts:63-69).
- **The temporary HPA warm-up (deploy.ts:3242-3459).** Before cutover, deploy lifts the incoming HPA's min/max to the outgoing build's _live_ replica count so the capacity gate is reachable, then restores chart bounds. A reconciler observing the HPA mid-warm-up sees drift on `minReplicas`/`maxReplicas` and reverts it, deadlocking the gate.
- **The deploy-state ConfigMap (state.ts:14, deploy.ts:3807-3927).** `<release>-adapter-state` is written by kubectl, never rendered by the chart, and carries everything rollback needs: the build pointer pair, per-build pool topologies, routing image digests, target platforms, CDN tags, composition-plan trust anchors, and a monotonic generation counter. It is invisible to Git and unowned by any manifest.

**Steps that are perfectly fine — or better — under a reconciler:**

- Every pure verification gate (rollout waits D1-D2, Job completion D3, `EnvoyExtensionPolicy Accepted` with generation guard D4-D5, per-pool `/readyz` capacity gate D7, domain health E7) maps onto reconciler health assessment, CEL health checks, or analysis runs. These gates _are the product_ — each one exists because a real incident got through without it — and they translate.
- Everything CI-shaped: `next build`, target fingerprint checks (A2), docker build/push (A7), registry digest resolution (A8 — digests already enter through values, not post-render patching), build-id collision guards (B2). The ecosystem consensus (rendered-manifests pattern, Flux image-automation) actively endorses moving these to CI and committing the results.
- Cluster-identity preflight (A3) _disappears_ under GitOps: the agent runs in the target cluster, so "which cluster am I mutating" is structural, not a confirmation prompt.
- NetworkPolicy CIDR discovery (A4) gets strictly _better_: an in-cluster controller watching Nodes maintains the CIDR set continuously instead of snapshotting it at deploy time (the staleness on node autoscale is already acknowledged at deploy.ts:1954-1985).

The tension, precisely stated: **the chart deliberately under-describes the cluster.** It renders one build's resources while the cluster must hold two (current serving, previous parked), and it renders the traffic pointer at its _pre-cutover_ value while the cluster holds the _post-cutover_ value. Deploy fills both gaps imperatively. Any GitOps design must either widen what the chart describes (render both builds; render the true pointer) or explicitly fence off the fields the imperative actor owns. Doing neither — pointing Argo at today's chart with auto-sync — is an outage generator, and we must document that in red before we ship anything else.

Nobody else has solved this for Next.js on Kubernetes. OpenNext targets Lambda, Coolify is "no Kubernetes," and the commercial platforms (Qovery, Northflank, Porter) all keep cutover in their own control plane and accept GitOps only as the _source of inputs_. We would be first — which is a reason to be conservative about which mode we bless.

---

## 2. Design Principles

1. **The chart stays the single source of artifacts.** GitOps modes consume the same `onBuildComplete` output — chart, values, Dockerfiles — that imperative deploy consumes. We do not fork a second render pipeline. Where a mode needs something the chart doesn't render today (both builds, a cutover Job), the _chart_ grows, gated behind values, and imperative deploy keeps working with those values off.

2. **Verification gates are the product's value and must survive in every mode.** The `/readyz`-per-pod capacity gate, the exact-version rollout wait, the generation-guarded policy poll — each encodes an incident (12-char-prefix false-pass, N64's one-ready-pod-taking-100%, stale-`Accepted=True`). A mode that trades them for "the Deployment is Available" is a regression sold as a feature. Consequence: the cutover logic ships as a **container image** (the same code the CLI runs), so every mode invokes identical verification, whether from a laptop, a CI job, or an in-cluster Job.

3. **Never two owners for one field.** The selector-drift problem generalizes: every field must have exactly one writer. If the cutover Job patches `spec.selector`, the reconciler must be told to ignore it (`ignoreDifferences` + `RespectIgnoreDifferences=true` on Argo; a drift-detection ignore rule on Flux) — and the chart must ship those instructions, not bury them in docs. Same for HPA bounds during warm-up and for `keep`-retained previous-build objects. Where we can't cleanly fence a field, we change the design so the field has one owner (e.g., per-build ConfigMap names instead of overwriting a stable one).

4. **Rollback must not get worse.** Imperative deploy retains a parked previous build, its Secrets, its manifest snapshot, and enough state to flip back in seconds. Any GitOps mode must either preserve that retained set (render it) or honestly document the narrower rollback it offers. "git revert and wait for sync" is not equivalent, and §5 analyzes exactly why.

5. **CI renders, the cluster verifies and promotes.** This is the 2026 ecosystem consensus (rendered-manifests pattern, Kargo's Freight model) and it matches our existing split: digest resolution is already documented as a CI step (docs/ci-cd.md:40-51), and the gates already run against the live cluster. We lean into it rather than inventing a third boundary.

---

## 3. What the Chart Already Gets Right (and Wrong) for GitOps

Worth stating explicitly, because it constrains every mode below.

**Right:**

| Property                                                                                 | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No hooks, no `lookup`, no `.Capabilities`, no subcharts                                  | Renders offline with `helm template`; identical semantics under Helm, Argo, and Flux                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Digests enter through values (`pools.<pool>.image.digest`)                               | Committable to Git; no post-render kustomize patching; Flux image-automation can write them                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Per-build resource names everywhere (Deployments, Services, Secrets, snapshot CMs, Jobs) | New builds are pure adds — no in-place mutation races for a reconciler to mis-order                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Registration Job is a plain `batch/v1 Job`, not a hook                                   | Works when applied from pre-rendered YAML (Helm hooks don't run under `helm template \| kubectl apply`)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The build's manifest and secret are chart-described at birth                             | The per-build routing-manifest snapshot CM is rendered by the chart itself with `helm.sh/resource-policy: keep` (routing-manifest-configmap.ts:57-85 — the 2026-07-30 propagation incident forced this), and the per-build dispatch Secret likewise (internal-secret.ts:141). The CLI's `retainLiveRoutingManifest` copy-step exists for builds deployed by OLDER adapters that mounted the stable CM. Caveat: `keep` is a **Helm** semantic — Flux's helm-controller honors it, Argo's prune does not (see §4.3 prune safety) |
| Injection-hardened templates (`escapeHelmActions`, charset asserts)                      | A chart committed to a shared GitOps repo can't smuggle template actions                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Wrong (each one is a work item in §4/§6):**

1. **Selector drift by design** — chart renders `activeBuildId`, cutover is out-of-band (§1). No `ignoreDifferences` guidance exists anywhere in the emitted output.
2. **Bare `helm template` fails on defaults** — `global.networkPolicy.strict: true` with empty `nodeCidrs` hits the `{{- fail }}` guard (network-policy.ts:354-355). CIDRs are CLI-discovered; a GitOps consumer has no discovery step.
3. **Secret material in the chart** — `internal-secret.yaml` and `valkey-secret.yaml` carry real credentials in `stringData` (internal-secret.ts:144-145). Committing `chart/` to a repo commits secrets; the 0600 file mode does not survive Git.
4. **The previous-build lifecycle is mostly CLI-managed** — keep-transfers, prev-service injection, GC. The chart _does_ already describe two pieces of the parked build at birth (the per-build routing-manifest snapshot CM and dispatch Secret, both rendered `keep` — see the "Right" table), but the Deployment, HPA, and versioned Service of the parked build are protected only by deploy-time patches on live objects, which no reconciler performs.
5. **Job TTL vs. drift** — `ttlSecondsAfterFinished: 3600` on the registration Job means Argo re-creates (and re-runs) a privileged gcloud Job on every sync after the first hour. Idempotent, but noisy, slow (40×5s wait loops), and alarming in an audit log.
6. **Release name is baked, not `{{ .Release.Name }}`** (helm.ts:81) — a HelmRelease whose `releaseName` disagrees with infrastructure.json diverges silently.
7. **Vestigial `--set previousBuildId`** (deploy.ts:1224-1226) — no template consumes it. Either make it real (see dual-build rendering, §4.3) or delete it.
8. **The routing-service image registry is baked into the template, not values-driven** — `routing-service-deployment.yaml` hardcodes the build-time registry in its `image:` line rather than reading `global.image.registry` the way pool Deployments do. A GitOps repo cannot re-point the routing tier at a different registry through values; verified live in the 2026-08-10 audit (see §3.1 below).
9. **Gateway API objects report perpetual drift under Argo** — the apiserver defaults `group`/`kind`/`weight` onto `backendRefs` that the emitted HTTPRoute/EnvoyExtensionPolicy JSON omits, so Argo shows them permanently OutOfSync. Needs emitted `ignoreDifferences` or templates that pre-bake the defaulted fields.
10. **`destroy` and a self-healing Application fight forever** — audit-observed: after `helm uninstall`, Argo selfHeal re-created the entire release within a minute. `adapter-k8s destroy` under GitOps must delete (or pause) the Application/Kustomization first; docs and the destroy command itself should detect the tracking labels and say so.

### 3.1 Empirical grounding (live audit, 2026-08-10)

Every load-bearing claim in §1/§3 was reproduced on a real cluster (k3d `gitops-audit`, Argo CD core, Envoy Gateway v1.5.5, the real generated chart from the dress-rehearsal app) rather than argued from source:

- **Render purity holds**: `helm template` output was byte-identical to `helm get manifest` after a live install (modulo trailing whitespace); no hooks/lookups anywhere. Argo synced the chart from a real git repo with ServerSideApply. The chart is GitOps-consumable; the _values provenance_ is the problem.
- **Selector revert is real and fast**: with auto-sync + selfHeal, Argo reverted the post-cutover Service selector in ~2.4 minutes with the Application still reporting "Synced"; a plain no-op `helm upgrade` (what Flux does every interval) reverted it immediately. In both cases the stable Service drained to zero endpoints because the reverted-to build was parked at 0 replicas — the §1 outage, observed, not hypothesized.
- **The other patch classes revert identically**: HPA warm-up bounds and a rollback-shape routing image patch were both undone by selfHeal; `--field-manager=helm` offers no protection.
- **Prune is worse than §4.3 assumed**: with `prune=true`, advancing the Application to the next build's chart deleted the keep-annotated dispatch Secret, manifest snapshot, and composition-plan CM **and the still-serving previous build's Deployment while the stable Service still selected it** (observed mid-outage: endpoints not-ready, pods Terminating). Helm's own uninstall honors `keep` exactly as deploy assumes; Argo does not.
- **git revert restores manifests, not semantics**: after a real revert + sync, the parked rollback target stayed at 0 replicas, capacity came back at the chart floor rather than incident size, and the state CM still named the newer build — which trips the CLI's serving-build divergence refusal on the next `deploy`. The routing tier's manifest-digest self-check also confirmed the chart is a per-build artifact: a hand-modified manifest crashloops the routing pod by design.

Audit artifacts: cluster `gitops-audit` (kept alive for inspection), `/tmp/gitops-audit/` (rendered diffs, Argo Application status captures, the git repo with the revert history).

---

## 4. Proposed Modes

Four modes, one recommendation. Summary first:

| Mode                    | Reconciler                              | Cutover actor                          | Verification fidelity                | Rollback                  | Status                                  |
| ----------------------- | --------------------------------------- | -------------------------------------- | ------------------------------------ | ------------------------- | --------------------------------------- |
| 0. Plain helm/kubectl   | none                                    | CI script (documented)                 | full (if scripted)                   | manual, documented        | **shipped** (docs/ci-cd.md)             |
| 1. `emit` + cutover Job | any                                     | in-cluster Job (adapter image)         | **full — same code**                 | full (state CM preserved) | **recommended default**                 |
| 2a. Argo CD native      | Argo CD                                 | PostSync hook Job (same image)         | full                                 | full                      | recipe on top of mode 1                 |
| 2b. Argo Rollouts       | Argo CD + Rollouts                      | Rollouts controller                    | **degraded** (see honest assessment) | degraded                  | optional target component, not flagship |
| 3. Flux                 | Flux (HelmRelease or Kustomization+OCI) | Job via `dependsOn` stage (same image) | full                                 | full                      | recipe on top of mode 1                 |

The recommendation, up front: **Mode 1 is the default GitOps path.** The reconciler owns apply and health; the adapter's own verification-and-cutover code, containerized, owns promotion; Git owns the inputs. This is the Qovery/Northflank shape — every surveyed product that actually ships blue/green on K8s keeps promotion in its own actor and lets GitOps deliver the inputs — and it is the only shape that preserves principle 2 without re-implementing the gates in someone else's DSL. Modes 2a and 3 are _recipes_ for running Mode 1 under a specific reconciler, not separate machinery. Mode 2b exists because users standardized on Rollouts will ask, and the honest answer is "you lose things; here is the exact list."

### 4.1 Mode 0 — Plain `helm template` / `kubectl` (fold-in, don't duplicate)

Already documented in [docs/ci-cd.md](../docs/ci-cd.md): build, push, digest-resolve from the registry, `helm upgrade` with `--set`, verify `/readyz` per pod, patch the selector. This design doc does not restate it; the GitOps docs will link to it as the "no reconciler" baseline and the reference for what any mode must reproduce.

Two gaps to close while we're in there:

- Document the `{{- fail }}` CIDR guard and its two escape hatches (`--set 'global.networkPolicy.nodeCidrs={...}'` or `strict=false`) — today a bare `helm template chart/` exits 1 and the error is only decipherable with the source open.
- Document that the manual pipeline must also perform the keep-transfer/retention steps if rollback matters, or accept single-build rollback semantics. Today ci-cd.md documents the cutover but not the retention, which means a faithful reader builds a pipeline whose `helm upgrade` deletes the rollback target.

**Changes:** docs only. **Lost vs. imperative deploy:** nothing new — this mode already exists; its known cost is that the operator re-implements orchestration.

### 4.2 Mode 1 — `adapter-k8s emit`: rendered artifacts for any GitOps tool (RECOMMENDED)

#### Mechanism

A new CLI verb (`adapter-k8s emit`, with `deploy --render-only` as an alias) that runs the _pipeline-safe_ subset of deploy — everything from Phase A that is verification or artifact production, nothing that mutates a cluster — and writes a **hydrated, committable bundle**:

```
.k8s-adapter/gitops/
├── chart/                      # the chart, verbatim, minus secret templates (see below)
├── values/
│   ├── values.yaml             # pinned: digests resolved from registry, registry/tag set,
│   │                           #   networkPolicy CIDRs from config (NOT discovery),
│   │                           #   activeBuildId=<the build SERVING at emit time> under
│   │                           #   cutover.mode: none — the deploy.ts:1193 trick, preserved —
│   │                           #   and metadata-only under cutover.mode: job (selectors
│   │                           #   render from previousBuildId; see cutover model below)
│   └── values.schema.json
├── cutover/
│   ├── cutover-job.yaml        # the promotion Job (§4.2 cutover Job) — for flows that apply
│   │                           #   it separately (Flux second Kustomization, raw kubectl).
│   │                           #   Under cutover.mode: job the CHART also renders it (values-
│   │                           #   gated template): an Argo Application sourcing chart/ never
│   │                           #   applies files outside its source path, so a hook that only
│   │                           #   lives in cutover/ would silently never run.
│   └── cutover-rbac.yaml       # Role/RoleBinding scoped to exactly what the Job patches
├── manifests/                  # `helm template` output of chart+values, for teams that
│   │                           #   apply raw YAML or use Argo's source hydrator
│   └── all.yaml
├── recipes/
│   ├── argocd-application.yaml # pre-filled ignoreDifferences, sync options, hook wiring
│   └── flux-helmrelease.yaml   # pre-filled driftDetection ignores, dependsOn stages
└── emit-metadata.json          # buildId, digests, cdnTag, poolTopology, defaultPool,
                                #   targetPlatforms — the per-build facts state.json records
```

What `emit` does, mapped to the deploy inventory:

| Deploy step                                  | In `emit`?                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 Helm probe                                | no                              | reconciler owns apply                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A2 build/fingerprint checks                  | **yes**                         | identical validation; refusing a mismatched target is more valuable in CI, not less                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A3 context pinning                           | no                              | no cluster contact at all — this is the point                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| A4 CIDR discovery                            | **replaced**                    | CIDRs come from config or `--set`-style flags. Today the only config key that exists is `provider.generic.nodeCidrs` (types.ts:206) — there is **no** podCidrs config key anywhere; pod CIDRs are exclusively deploy-time discovered. Emit therefore needs a new config surface (`networkPolicy.podCidrs`/`nodeCidrs`, PR1 work item, doc it in configuration.md) or flags. `emit` refuses to render with `strict: true` and no node CIDRs, same fail-closed posture, but the failure is at render time with a doc link |
| A5 Memorystore provisioning                  | no                              | infra provisioning is out of scope for emit; BYO URL or Config Connector (open question §7)                                                                                                                                                                                                                                                                                                                                                                                                                             |
| A6/A7 fetch-cache restage, docker build/push | **yes** (opt-out `--skip-push`) | CI is exactly where these belong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A8 digest resolution                         | **yes**                         | same fail-closed registry resolution; digests written into `values/values.yaml`. `--allow-mutable-tags` carries over                                                                                                                                                                                                                                                                                                                                                                                                    |
| B2 collision guards                          | **yes**                         | render-time validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| everything else (B, C, D, E)                 | no                              | belongs to the reconciler + cutover Job                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

#### The cutover model changes: sync is not cutover — the Job is

Under emit mode, `values.yaml` pins `activeBuildId` to the **new** build, but the stable Services' selector is **not** what enforces safety anymore — the ordering is. This is the one place emit mode deliberately diverges from imperative deploy's "helm applies with the _old_ pointer" trick, because a reconciler cannot express "apply everything except this one field, then patch it later." Instead:

1. The bundle's chart gains a values gate `cutover.mode: job` (default in emitted bundles). With it set, the stable active Services render with a **new** annotation `adapter-k8s.io/cutover: pending` and the selector rendered at the _previous_ build (from `previousBuildId`, which finally earns its keep — see §3 item 7). The rendered selector value must pass through `sanitizeK8sName` exactly as `activeBuildId` does today (values-yaml.ts:156) — invariant 3's mismatch clause (an unsanitized value drains the Service to zero endpoints) applies to this new path verbatim. The previous build id is a render input: `emit --previous-build <id>`, or read from `emit-metadata.json` of the prior bundle in the repo (the normal flow: CI reads the last committed bundle). **"No prior bundle found" is NOT "first deploy"** — that inference is the N20 incident class arriving through a new door (a shallow/sparse/wrong-directory checkout would render first-deploy semantics against a serving cluster: selectors pinned to the unverified new build, no retained previous build). Emit fails closed when it finds no prior bundle, and the operator asserts a genuine first deploy explicitly (`emit --first-deploy`).
2. The **cutover Job** (next section) runs after the reconciler reports the sync healthy. It executes the same gate battery as imperative deploy — exact-version rollout waits, route-ext Job completion, policy `Accepted` with generation guard, HPA warm-up, per-pool `/readyz` capacity gate — then patches the selectors to the new build, writes the state ConfigMap, invalidates CDN, scales down the previous build. On any gate failure it reverts the edge exactly as `restoreEdgeToPreviousBuild` does today and exits nonzero, which the reconciler surfaces as a failed hook/Job.
3. The recipes ship the ignore rules so the reconciler never fights the Job over `spec.selector` (and HPA bounds during warm-up). **These must target Services by NAME, not by label.** The template does stamp `app.kubernetes.io/managed-by: adapter-k8s-active` (service.ts:158), but live debugging recorded in three places (deploy.ts:178-179, doctor.ts:802, rollback.ts:1546) shows Helm rewrites that label to `managed-by: Helm` on the live object — which is exactly why deploy/rollback/doctor all address these Services by name. A Flux `driftDetection.ignore` with that labelSelector matches nothing and silently reverts every cutover; and Argo's `ignoreDifferences` has no label selector at all (group/kind/name/namespace/jsonPointers only). Emit knows the exact stable Service names (`sanitizeK8sName(<release>-<pool>)` plus `-origin`), so the recipes enumerate them per entry — or fall back to kind-wide `/spec/selector` ignoring on `kind: Service`, which is coarser but safe (the chart's versioned Services are never patched, so ignoring their selectors costs nothing).

First deploy (no previous build) renders the selector at the new build directly and the Job's gates degrade to the S18 floor (≥1 ready pod per pool) — same as imperative deploy's first-run path.

#### The sync itself must not delete the serving build (keep-at-birth)

There is a step imperative deploy performs that the original draft of this design silently dropped, and without it Mode 1 is an outage at _sync_ time, before the cutover Job ever runs. Deploy's keep-transfer (B4-B7) patches `helm.sh/resource-policy: keep` onto the **live** outgoing Deployment and HPA immediately before `helm upgrade` (deploy.ts:2594-2622, 2702-2734), because the new chart omits them and Helm would otherwise prune the build serving 100% of traffic. Under a reconciler nobody performs that patch: the bundle is replaced wholesale in Git, the sync applies it, and build A's Deployment — absent from the new manifest, un-annotated — is pruned while every stable Service still selects it. Zero endpoints, site down, cutover Job never reached.

The fix is structural, not another imperative step: under `cutover.mode: job` the chart renders **every per-build resource** (pool Deployments, HPAs, versioned Services) with `helm.sh/resource-policy: keep` — plus `argocd.argoproj.io/sync-options: Prune=false` and `kustomize.toolkit.fluxcd.io/prune: disabled` — **at birth**, the same pattern the per-build dispatch Secret (internal-secret.ts:141), routing-manifest snapshot CM (routing-manifest-configmap.ts:80), and composition-plan CM already follow. Each bundle protects its own build for the day it becomes the parked previous build; the cutover Job owns GC (scale-to-zero, HPA delete, old-build cleanup) exactly as deploy steps 7f/7g do today. This sidesteps the lossy-re-render problem the keep-transfer comment documents (deploy.ts:2522-2529): the object is never re-rendered, merely never deleted. Note the annotations are engine-specific and all three are required — `keep` is a Helm semantic (helm-controller honors it; Argo does not), `Prune=false` is Argo's, `prune: disabled` is Flux Kustomization's.

Consequence for adopters with imperative history: builds deployed by today's CLI have none of these annotations on their live objects, so the _first_ sync of a pruning reconciler over an existing release deletes the parked rollback build (and, if state pointed the selectors anywhere unexpected, worse). The `migrate` subcommand (§7 Q6) must annotate the live retained set before GitOps mode is enabled, and docs/gitops.md treats this as a hard prerequisite, not a recommendation.

#### The cutover Job

This is PR2's deliverable and the load-bearing component of every mode. Extract deploy's Phase D + E1-E5 into a module with no CLI/TTY dependencies (`src/cutover/run.ts`), consuming:

- `emit-metadata.json` (mounted via the bundle's per-build ConfigMap — it is small and non-secret) for the new build's topology, digests, cdnTag;
- the state ConfigMap `<release>-adapter-state` for the previous build's facts (topology, digests, platforms) — **the state CM survives into GitOps mode**, see §5. The Job must reuse `state.ts`'s read/write machinery wholesale, not reimplement it: the N20 distinction (unreadable ≠ absent — `--ignore-not-found` + exit-code discipline, state.ts:424-432), the N21/N69 generation ordering, and the N23/S19 optimistic-concurrency preconditions are each a solved incident, and the Job is a _new concurrent writer_ of exactly the object those guards protect. Note the local-file half of state.ts is meaningless in a Job (no persistent `.k8s-adapter/`); the Job runs cluster-CM-only, which the module must support as a first-class mode — today `writeState` always writes the local file first and derives recovery semantics from it (state.ts:303-311), so this is real extraction work, not `import` moves;
- the live cluster for the two facts Git cannot know: the outgoing build's live replica count (D6/N64) and what the edge is actually serving (B9's cross-check).

Packaged as an image (`ghcr.io/next-community/adapter-k8s-cutover:<version>`, same repo, same release train), run as a per-build-named Job (`<release>-cutover-<buildId>` — per-build naming means re-syncs don't re-run a completed cutover, unlike the TTL'd registration Job) under a ServiceAccount whose Role allows exactly: get/patch on the release's Services, get/patch on HPAs, get on Deployments/Pods, create/exec on pods for the `/readyz` in-pod diagnostics, get/create/patch on the state ConfigMap, and (GKE) the Workload Identity binding for CDN invalidation. The RBAC manifest is emitted, reviewed, and committed like everything else.

The same module becomes what `runDeploy` itself calls, so the CLI path and the Job path cannot drift: one implementation, two entrypoints (principle 2).

#### What the user's repo looks like

```
my-app-deploy/                      # GitOps repo (or a directory of the app repo)
├── apps/my-app/
│   ├── chart/ … values/ … cutover/ …   # the committed bundle, replaced wholesale per release PR
│   └── secrets/                    # SealedSecret/ExternalSecret refs — NOT the raw chart secrets
└── clusters/prod/
    └── my-app.yaml                 # Application / HelmRelease from recipes/, edited once
```

CI on the app repo: `next build` → `adapter-k8s emit` → open a PR against the deploy repo replacing `apps/my-app/`. Merge = release. The reconciler syncs; the cutover Job promotes; the Job's status is the deploy's status.

#### Secrets

`emit` **does not write `internal-secret.yaml`/`valkey-secret.yaml` into the bundle** (§3 item 3). Options, in order of preference: (a) `--secrets external` renders `ExternalSecret` resources referencing the operator's store and emits the derived dispatch-secret value to a separate `--secrets-out` file (0600, gitignored) for one-time loading into the store; (b) `--secrets sealed` pipes them through `kubeseal` when a cert is provided; (c) `--secrets sops` (SHIPPED — real-cluster gap #3) encrypts the secret manifests into `secrets/*.sops.yaml` through the sops CLI, recipients selected by the repo's own `.sops.yaml` creation rules (never argv), fail-closed on a missing binary/config/nonzero exit, `secrets/` excluded from byte-determinism (fresh data keys/MACs per encryption; re-emits reuse an existing file that still decrypts to the same plaintext); (d) `--secrets inline` keeps today's behavior for private repos, with a loud warning.

One determinism trap that bites specifically in CI: `deriveInternalSecret` is an HMAC of the build id under a key read from `ADAPTER_K8S_INTERNAL_SECRET_KEY` or the gitignored `.k8s-adapter/internal-secret.key` — and when neither exists it **mints a fresh random key** (adapter.ts:1130-1146). A fresh CI checkout has no key file, so without the env var every emit of the _same_ build derives a _different_ dispatch secret: the bundle stops being byte-deterministic (defeating the re-emit audit N50 exists for) and, under `--secrets external`, re-loading the store rotates a value the already-rendered pods disagree about. `emit` therefore **requires** a stable key source in CI — it fails closed when neither the env var nor the key file is present, rather than minting one silently. The per-build Secret _name_ stays in the chart in every mode — only the material moves.

#### What changes in the codebase

- `src/cli/emit.ts` (new, ~400 lines): argument surface, bundle assembly, recipes templating. Reuses `runDeploy`'s A2/A6/A7/A8/B2 functions — those need extraction from deploy.ts into `src/pipeline/` (mechanical move, deploy.ts is 4300+ lines and wants this anyway).
- `src/emit/helm.ts`, `service.ts`: `cutover.mode` values gate; `previousBuildId` consumed for real; `adapter-k8s.io/cutover` annotation.
- `src/emit/internal-secret.ts`, new `src/emit/external-secret.ts`: secret externalization modes.
- `src/cutover/` (PR2): the extracted gate+promotion module and its Dockerfile.
- `docs/gitops.md` (new), edits to ci-cd.md per §4.1.

#### What is lost vs. imperative deploy

- **CIDR discovery** — static CIDRs in config go stale on node autoscale. Mitigation: document; long-term a tiny in-cluster CIDR controller (open question §7) is strictly better than what deploy does today.
- **Memorystore provisioning** — emit does not provision cloud infra. Users bring a URL or use Config Connector; `init` still works for day-0.
- **Interactive recovery** — deploy's N20 fallback (discover serving build from the live cluster when state is unreadable) moves into the cutover Job, which has cluster access; nothing actually lost, but failures surface as Job logs, not TTY prompts.
- **Single-command UX** — replaced by PR-merge UX, which is the point.

### 4.3 Mode 2a — Argo CD native

A recipe over Mode 1, not new machinery. The emitted `recipes/argocd-application.yaml`:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source: { repoURL: …, path: apps/my-app/chart, helm: { valueFiles: [../values/values.yaml] } }
  syncPolicy:
    automated: { prune: true, selfHeal: true }
    syncOptions:
      - RespectIgnoreDifferences=true
  ignoreDifferences:
    # ignoreDifferences has NO label selector (group/kind/name/jsonPointers only), and the
    # adapter-k8s-active label is rewritten to managed-by: Helm on live objects anyway
    # (deploy.ts:178-179) — so emit enumerates the stable Services BY NAME, one entry per
    # pool plus origin. Names are known at emit time; this is generated, not hand-kept.
    - kind: Service
      name: <release>-<pool> # one entry per pool, emitted
      jsonPointers: [/spec/selector]
    - group: autoscaling
      kind: HorizontalPodAutoscaler
      jsonPointers: [/spec/minReplicas, /spec/maxReplicas] # warm-up window (D6)
```

with the cutover Job annotated `argocd.argoproj.io/hook: PostSync` + `hook-delete-policy: BeforeHookCreation` (keep the last run's logs; PostSync only fires after all Sync-phase resources are Healthy, which subsumes D1/D2's rollout waits as a first gate — the Job still re-verifies with exact-version matching, because Argo's health check does not know about the 12-char-prefix incident and never will). `BeforeHookCreation` re-runs the hook on **every** sync — including no-op re-syncs and unrelated config edits — so the Job must be cheap-idempotent by design: first step, read the state CM and the live selectors; when both already agree with this bundle's build, log "already promoted" and exit 0 without touching HPAs or re-running the warm-up. Re-running the full gate battery on a Tuesday config tweak is noise; re-running the HPA warm-up is a capacity wobble; the short-circuit avoids both. The registration Job gets `argocd.argoproj.io/hook: Sync` + a sync-wave before the cutover hook, and we **drop `ttlSecondsAfterFinished` when `cutover.mode: job`** (per-build name + `BeforeHookCreation` supersede it) to kill the re-run-on-every-sync noise (§3 item 5).

Prune safety: the previous build's keep-annotated objects are _not in the rendered manifest_, so Argo prune would delete them. The defense is the keep-at-birth rendering from §4.2 — every per-build resource carries `helm.sh/resource-policy: keep` _and_ `argocd.argoproj.io/sync-options: Prune=false` from its own bundle onward (they are different engines' semantics, so both are stamped) — and the docs state plainly that `prune: true` against objects lacking those annotations (anything deployed by the imperative CLI before migration) deletes your rollback target. Longer term, the cleaner fix is **dual-build rendering** — `emit --previous-build` renders the parked build's Deployment (replicas 0, no HPA), versioned Service, Secret, and snapshot CM into the bundle, so the retained set is _in_ the desired state and prune becomes the GC that E6 hand-rolls today. That is the single biggest structural simplification available (it dissolves B4-B7, B9, E5, E6), and it is deliberately **PR3+ scope**, because it doubles the rendered surface and needs its own test matrix.

Sync waves order the phases: wave 0 CRD-consuming config + Secrets, wave 1 workloads, wave 2 registration Job (Sync hook), PostSync cutover. Custom health for `EnvoyExtensionPolicy` (Lua, checking `Accepted` with `observedGeneration >= generation` — D4's exact guard) ships in the recipe as an `argocd-cm` snippet, with the caveat documented that it needs cluster-operator access to install.

**The Argo Rollouts alternative (2b), assessed honestly.** Rollouts BlueGreen replicates the _selector flip_: `activeService`/`previewService`, controller flips the active Service's `rollouts-pod-template-hash` selector after the new ReplicaSet is Available and `prePromotionAnalysis` passes. Structurally it is E1. But:

1. **Routing-tier atomicity does not survive.** A Rollout governs exactly one pod template. Our release decision is _pools + routing tier (image + manifest snapshot) as one unit_ — the routing pod refuses a mismatched manifest by design. Multiple Rollouts promote independently; there is no cross-Rollout transaction. An external promoter (Kargo, or… a Job) would have to sequence them, at which point we have rebuilt the cutover Job with extra controllers. **This is disqualifying for the flagship path, and we say so.** The cutover Job design stays.
2. **The capacity gate is not expressible.** "New build's ready count ≥ outgoing build's _live_ count" (D7/N64) has no Rollouts primitive; `previewReplicaCount` is static, and there's a documented stuck-rollout bug when prePromotionAnalysis meets a scaling event (argo-rollouts#2931). The HPA warm-up choreography (D6) likewise has no equivalent.
3. **Selector determinism is lost.** Rollouts substitutes a random per-ReplicaSet hash for our deterministic sanitized-build-id selector, which the state model, rollback, and monitoring all key on.
4. **Per-pod `/readyz` fidelity degrades** — analysis runs go through the previewService, with a documented race onto old pods (argo-rollouts#2488); recovering per-pod fidelity means re-implementing our check inside an AnalysisTemplate Job… which is the cutover Job again, in Lua-adjacent packaging.

Disposition: ship, later and clearly labeled, an **optional target component** that emits `Rollout` (with `workloadRef`) + an AnalysisTemplate wrapping the adapter's readiness image, for shops that mandate Rollouts. Document the four losses above verbatim. Not the default, not PR1-3 scope.

### 4.4 Mode 3 — Flux

Also a recipe over Mode 1. Two variants, both emitted:

**(a) HelmRelease** — `recipes/flux-helmrelease.yaml`: a `GitRepository` (or preferably `OCIRepository`, below) source pointing at the bundle's `chart/`, `valuesFrom` a per-build ConfigMap that is **itself part of the bundle** (emit writes it as a manifest; a small Kustomization syncs it, and the HelmRelease `dependsOn` that Kustomization — nothing may require a human or CI to `kubectl create` anything, because in this mode CI has no cluster credentials at all), `driftDetection: {mode: enabled, ignore: [...]}` with one entry per stable Service targeted by **kind + name** (`target: {kind: Service, name: <release>-<pool>}, paths: [/spec/selector]` — never by the `adapter-k8s-active` labelSelector, which Helm rewrites on live objects, deploy.ts:178-179, so a label-based ignore matches nothing and the drift corrector reverts the cutover), `releaseName` **pinned to the derived release name** (§3 item 6 — the recipe hardcodes it from emit-metadata so it cannot disagree with the baked names). Flux 2.8's Helm v4 path (SSA + kstatus + release inventory) health-checks the workloads; the route-ext Job is waited on via the release's own readiness.

**(b) Kustomization over `manifests/all.yaml`** for teams that ban Helm in-cluster — this is where `manifests/` earns its place in the bundle. `wait: true`, `healthChecks` on the Deployments, `healthCheckExprs` (CEL) for `EnvoyExtensionPolicy`:

```yaml
healthCheckExprs:
  - apiVersion: gateway.envoyproxy.io/v1alpha1
    kind: EnvoyExtensionPolicy
    current: status.ancestors.exists(a, a.conditions.exists(c, c.type == 'Accepted' && c.status == 'True' && c.observedGeneration >= metadata.generation))
    failed: status.ancestors.exists(a, a.conditions.exists(c, c.type == 'Accepted' && c.status == 'False'))
```

The cutover Job runs as a second Kustomization with `dependsOn` the first and `wait: true` — Flux's answer to PostSync. Ordering is identical: workloads healthy → Job runs gates → promotes.

**Image automation:** Flux's `ImagePolicy digestReflectionPolicy: Always` + `ImageUpdateAutomation` can write `tag@sha256:` back to Git — the ecosystem-blessed version of A8. We document it as an _alternative_ to emit's built-in digest pinning for teams that want the cluster to chase a registry, with the explicit caveat that it bypasses emit's platform-validated child-manifest selection (S23/S24 lineage), so the default remains CI-side resolution.

**OCI artifacts:** `emit --push-oci oci://…` runs `flux push artifact` (or ORAS) so the bundle ships as an immutable, cosign-signable artifact instead of a Git tree. Cleanest fit for a bundle that is regenerated wholesale per build; recipes/(a) then uses `OCIRepository`. Argo consumes the same artifact once its OCI source support is on (or via the manifests path). This is PR3 garnish, not core.

**Lost vs. imperative deploy:** same list as Mode 1; additionally under (a), helm-controller only re-renders on observed source/values change (flux2#3599), so the per-build values ConfigMap must be name-versioned (`<release>-values-<buildId>`) to guarantee a reconcile — the recipe does this.

---

## 5. The State Problem

Deploy's bookkeeping (`.k8s-adapter/state.json` + `<release>-adapter-state` ConfigMap, generation-countered, newer-wins — docs/lifecycle.md) is what rollback runs on. Per mode:

**Mode 0/1/2a/3 with the cutover Job: the state ConfigMap stays, and stays authoritative for live facts.** The Job writes it exactly as deploy does (same module, principle 2). Git owns _inputs_ (chart, values, digests, per-build metadata); the state CM owns _outcomes_ (which build actually passed gates and took traffic, at what generation). This split is principled, not transitional: two facts are unknowable from Git — the outgoing build's live replica count at promotion time (D6) and what the edge was actually serving when the snapshot was taken (B9) — and one fact (the generation counter, N21/N69) exists precisely to order _cluster_ history when Git history and cluster history disagree (e.g., two CI lanes racing). `adapter-k8s rollback` therefore works unchanged in every recommended mode, from a laptop or as a Job (`cutover/rollback-job.yaml`, emitted in PR2, same image with `--rollback`).

**Rollback via `git revert`, analyzed explicitly.** Reverting the bundle PR and letting the reconciler sync is the GitOps-native rollback story, and it half-works. What it CAN restore:

- The previous build's _rendered_ resources: Deployment spec, versioned Service, HPA, per-build ConfigMaps — the reconciler re-applies them (they were never deleted if the Prune=false annotations held; re-created if they were).
- The values pointer: back to the old build; with `cutover.mode: job` the reverted bundle's cutover Job re-runs the gates and re-patches the selectors — but **only if something makes the Job re-run**. A git revert restores byte-identical bundle content, so any name suffix embedded in the bundle is the same as the first time and Kubernetes Jobs are immutable: the completed `<release>-cutover-<oldBuildId>` just sits there and no promotion happens. Under Argo the hook machinery solves this (`BeforeHookCreation` deletes and recreates the hook Job on every sync); under Flux the recipe must force it (a Job name suffixed with the Kustomization's source revision via `postBuild.substituteFrom`, or `spec.force` on the Job-carrying Kustomization). The raw-manifests path has no such machinery, and the docs say so: there, revert restores _resources_, and re-promotion is the explicit rollback Job. Gates on re-promotion are the right default either way — rolling back to a build that no longer comes up should fail loudly, exactly like `runRollback`'s digest-anchored verification does.

What it CANNOT restore, and where the Job + state CM cover the gap:

1. **Incident-sized capacity.** The chart renders `replicas`/HPA bounds from values — floor capacity. What the rollback target must actually come back at is derived from the **live cluster at rollback time**: `planRollbackCapacity` (rollback.ts:872-886, N26) takes the max of the current build's `spec.replicas`, `readyReplicas`, and the HPA's `desiredReplicas` — none of which is in the state CM (AdapterState carries topologies, digests, tags, platforms — no replica counts, state.ts:23-112) and none of which Git can know. Git revert brings back `replicas: <chart default>`; the rollback Job observes the live capacity and recreates the HPA at incident-sized bounds exactly as `runRollback` does (rollback.ts:1253-1355). Pure git revert without the Job serves the rollback build at floor capacity into whatever traffic caused the rollback.
2. **Retained manifests that a pruning reconciler already deleted.** If the operator ran `prune: true` against pre-migration objects, the previous build's dispatch Secret and routing-manifest snapshot are gone; the **routing-manifest snapshot of a build whose bundle was overwritten wholesale is only in Git history**, and the reconciler syncs HEAD, not history. Revert restores it (the revert commit _is_ history becoming HEAD) — but only a full revert; a hand-edit of `activeBuildId`/`previousBuildId` alone does not, and the routing pod then refuses the mismatched manifest (correctly — it fails loudly, docs/ci-cd.md). Docs must say: revert the whole bundle, never cherry-pick the pointer. The dispatch _Secret_ is re-creatable only conditionally: `deriveInternalSecret` is an HMAC of the build id under a key living in gitignored `.k8s-adapter/internal-secret.key` or `ADAPTER_K8S_INTERNAL_SECRET_KEY` (adapter.ts:1130-1146) — deterministic across CI runs **only if the pipeline pins that env var**, and in emit mode the material lives in the external store anyway (§4.2 secrets), so revert-recoverability additionally depends on the store retaining superseded build-scoped entries. docs/gitops.md must state both requirements.
3. **CDN tags.** M13's rule — a build's cdnTag is derived only at its own deploy and carried verbatim — is preserved because `emit-metadata.json` carries the tag _in the bundle_, so revert restores the old build's tag. But the _invalidation_ of the rolled-away-from build's CDN entries is an external action no reconciler performs. Without the rollback Job, stale CDN entries for the bad build serve until TTL. The Job invalidates by the state CM's recorded tag exactly as E4 does; a missing tag degrades to full `/*` purge, same as today.
4. **Time.** Imperative rollback is seconds (scale up parked build, flip selectors). Revert-and-sync is bounded below by reconcile interval + image-pull-free warm-up + gate battery. The parked previous build (replicas 0, retained) is what makes the Job path fast; that retention exists _because_ deploy/the Job maintain it. Pure-declarative rollback speed depends on the dual-build rendering future (§4.3) making the parked build part of desired state.

**Mode 2b (Rollouts):** the state CM's role shrinks to CDN tags and composition anchors; build-pointer state moves into Rollouts' revision history, which cannot express "retain this named build at zero indefinitely as the rollback target" (`scaleDownDelaySeconds` is a delay, not a parking brake). Another reason 2b is not the default.

**CDN invalidation in each mode**, compactly: Mode 0 — documented script step. Modes 1/2a/3 — the cutover Job's final best-effort step, after the state commit, same ordering guarantee as E4 (a CDN failure can never lose a confirmed cutover). Mode 2b — a `postPromotionAnalysis` Job, with the honest caveat that its ordering relative to Rollouts' own promotion commit is weaker than ours.

---

## 6. Sequencing — Stacked PRs

**PR1 — `emit` mode + docs (smallest useful).**
Extract the pipeline-safe steps from deploy.ts into `src/pipeline/` (fingerprints, image build/push, digest resolution, collision guards — mechanical, deploy.ts imports move); add `src/cli/emit.ts`; secret externalization (`--secrets external|sealed|inline`); the bundle layout minus `cutover/` (bundles ship with `cutover.mode: none`, meaning the operator cuts over per docs/ci-cd.md — Mode 0 with rendered inputs). Under `mode: none` the values pin `activeBuildId` to the **previous** build (the deploy.ts:1193 trick, done at values-write time — no chart template changes), which drags three more things into PR1 that the first draft of this section did not count: the `--previous-build` / prior-bundle / `--first-deploy` input semantics with the N20 fail-closed posture (§4.2), a config surface for static CIDRs (`provider.generic.nodeCidrs` exists, types.ts:206; a pod-CIDR key does not and must be added — plus configuration.md), and the `ExternalSecret` template for `--secrets external`. `docs/gitops.md` covers the drift hazard in red, the by-NAME Argo/Flux ignore rules to hand-write, the prune warning for pre-existing releases, and the ci-cd.md fold-ins (§4.1).
_Blast radius:_ deploy.ts (imports only — behavior-neutral refactor, the existing e2e deploy lane is the regression net), ~5 new files in `src/pipeline/`, `src/cli/emit.ts`, one new emit template (external-secret), 2 emit-template touches (secret gating), one config-schema addition. New tests: emit snapshot tests (bundle byte-determinism, secret exclusion, CIDR fail-closed, previous-build pinning, first-deploy refusal), pipeline unit tests moved with their functions. No cluster-touching behavior changes. **Ship risk: low, but the surface is "small CLI verb + real input-semantics design", not "render and write" — the previous-build/first-deploy semantics are the part to review hardest, because they are N20's new front door.**

**PR2 — cutover Job extraction.**
`src/cutover/run.ts` from deploy.ts Phases D + E1-E5 and rollback's revert path; `runDeploy` and `runRollback` rewired onto it (the CLI is now a caller of the module — this is the risky diff, and the e2e deploy + rollback lanes must pass unchanged); `state.ts` gains a cluster-CM-only mode (the Job has no persistent local file — the N20/N21/N23/S19 guards must hold with one store instead of two, see §4.2); Dockerfile + image publish in the release train; `cutover/` and `rollback-job.yaml` join the bundle; chart gains `cutover.mode: job` (annotation, `previousBuildId` selector consumption, keep-at-birth emission: `helm.sh/resource-policy: keep` + Argo `Prune=false` + Flux `prune: disabled` on every per-build resource); the `migrate` subcommand that annotates a live imperative release's retained set before GitOps is enabled (§7 Q6 — a prerequisite, so it lands with the Job, not later).
_Blast radius:_ deploy.ts and rollback.ts (large mechanical extraction, ~1500 lines moved), `src/cutover/` new, 4 emit templates. New tests: cutover module unit tests against a fake cluster (the gate battery has incident-derived cases — 12-char prefix, N64 capacity, stale-Accepted — that must transfer as named tests), one e2e lane running the Job in-cluster instead of the CLI. **Ship risk: medium — mitigated by "one implementation, two entrypoints" making the CLI lane exercise the same code.**

**PR3 — Argo + Flux recipes and e2e lanes.**
`recipes/` generation (Application, HelmRelease, Kustomization+CEL variants); `--push-oci`; the argocd-cm Lua snippet; two e2e lanes (kind + Argo CD, kind + Flux) driving a full deploy→promote→revert cycle through each reconciler, asserting the outage scenario from §1 does _not_ occur (auto-sync enabled, selector ignored, previous build retained).
_Blast radius:_ `src/cli/emit.ts` + new `src/emit/recipes/`, zero changes to deploy/cutover code, CI config. New tests: recipe snapshots, 2 e2e lanes (the expensive part — budget cluster time). **Ship risk: low code / medium CI cost.**

Later, explicitly out of this stack: dual-build rendering (dissolves B4-B7/B9/E5/E6 — the big structural simplification, its own design note), the Rollouts target component (2b), Kargo Freight recipe for multi-env promotion, in-cluster CIDR controller.

---

## 7. Non-Goals and Open Questions

### Non-Goals

- **Replacing imperative deploy.** It remains the day-0 and small-team path; emit mode shares its code, not its users.
- **Multi-environment promotion (dev→staging→prod).** Kargo's Freight model is the right future shape (it uniquely preserves "these N artifacts are one release" across env promotion) — but it's a layer above this design, not part of it.
- **Cluster/infra provisioning via GitOps.** Config Connector/Crossplane claims for Memorystore and the static IP (A5/A9) are plausible emitted components someday; `init` owns them today.
- **Canary/traffic-splitting.** Blue/green with verified cutover is the product; percentage rollouts are a different product.
- **Supporting Argo auto-sync against today's chart without the Job or the ignore rules.** We document it as unsupported and dangerous rather than trying to make it survivable.

### Open Questions

1. **Dual-build rendering's trigger.** Rendering {current, previous} makes prune do E6's job and revert genuinely symmetrical — but doubles the rendered surface and requires the previous bundle as a render input, coupling emit runs. Do we gate it on demand signal, or is it PR4 on principle?
2. **State CM under multi-writer.** Two CI lanes emitting concurrently produce racing bundles; the generation counter orders cluster commits, but nothing orders _merges_. Is "serialize release PRs" a documented requirement, or does emit need a monotonic release sequence baked into the bundle?
3. **CIDR controller vs. static config.** A ~200-line controller watching Nodes and patching the NetworkPolicy would beat both deploy-time discovery and static values. Does it live in this repo, and does imperative deploy adopt it too (deleting A4)?
4. **`ClientTrafficPolicy` conflicts under merged gateways** (see skills warning, commit 58b770c) — do the recipes need a preflight for reconciler-managed gateways that our chart shares with other tenants?
5. **Cutover Job observability.** Job logs are the deploy narrative now. Do we emit Events on the state CM / a `Condition` on a small `AdapterRelease` CR so `kubectl get` tells the story, or is that CRD creep?
6. **Legacy migrations (B8/B10)** — one-time ownership adoptions don't belong in steady-state reconciliation. The `migrate` subcommand now ships in PR2 (it must annotate the live retained set before a pruning reconciler ever syncs — see keep-at-birth, §4.2); the open part is its exact scope: does it also perform the B8/B10 ownership adoptions, and does it verify the reconciler's prune/ignore configuration (read the Application/Kustomization spec?) or only prepare the objects?

---

## 8. Open Risks

Confirmed hazards this design acknowledges but does not yet resolve. Each needs an owner before its PR ships.

1. **The HPA ignore rule is permanent, but the warm-up window is not.** Neither Argo's `ignoreDifferences` nor Flux's `driftDetection.ignore` can be time-scoped, so ignoring `/spec/minReplicas`+`/spec/maxReplicas` to protect the D6 warm-up also means an operator's _deliberate_ HPA bound change in config never converges via the reconciler — it applies only on the next bundle (new HPA name, per-build) or by hand. Tolerable because HPAs are per-build and short-lived, but it is a real "GitOps doesn't manage this field" carve-out the docs must state, and no cleaner mechanism (annotation the Job removes after warm-up? separate warm-up HPA?) has been designed.
2. **Argo UI honesty under keep-at-birth.** A parked previous build is, from Argo's perspective, a set of orphaned resources it has been told not to prune. Depending on Application settings this renders as permanent `OutOfSync` / orphan warnings — an alarm fatigue generator pointed at exactly the operators we most need to trust the sync status. Whether orphaned-resource ignore rules (`orphanedResources.ignore`) can be emitted precisely enough (per-build names change every release) is unverified.
3. **The recipes' Application/Kustomization specs are not static.** The by-name `ignoreDifferences` list and orphan ignores vary with the pool topology, and the repo layout describes `clusters/prod/my-app.yaml` as "edited once." A pool added in a later bundle needs the Application spec updated too, or its Service selector is unprotected — the §1 outage returns for one pool. Options (ApplicationSet templating from emit-metadata, kind-wide Service selector ignore as the emitted default) need a decision; until then the kind-wide rule is the safe default and the doc should say so.
4. **Failed-promotion retry behavior under auto-sync.** A cutover Job that fails its gates exits nonzero and reverts the edge; Argo then retries the sync per its retry policy, re-running the hook — potentially flapping the HPA warm-up against a build that will never pass. The short-circuit (§4.3) only covers the already-promoted case, not the persistently-failing one. Needs a poison-pill: the Job records the failed build id in the state CM and refuses re-promotion of the same build without an explicit override.
5. **Argo `valueFiles` outside the chart path.** The recipe references `../values/values.yaml` relative to a `chart/` source path. Argo's support for value files outside the chart root (same repo) has version-dependent restrictions; if it bites, the fallback is emitting `values.yaml` as the chart's own default values file (it is per-bundle anyway). Verify against the supported Argo version matrix in PR3's e2e lane before blessing the layout.
6. **No-credential emergency rollback latency.** For the Flux-without-any-CI-credentials shop, every remediation path — revert PR, rollback Job manifest — is bounded below by Git merge + reconcile interval. `adapter-k8s rollback` from a credentialed laptop remains the break-glass path, and docs must be honest that pure-GitOps shops are trading rollback latency for credential hygiene; the §5 analysis quantifies what, but not whether that trade is acceptable per incident class.

---

## 9. Decision

**Mode 1 (`emit` + in-cluster cutover Job) is the default GitOps path**, with Argo CD and Flux recipes as first-class packaging of it. Rationale, compressed: it is the only design that (a) keeps every incident-derived verification gate byte-identical across the CLI and GitOps paths, (b) gives every mutable field exactly one owner, (c) keeps rollback as strong as today's — including the two live-cluster facts Git cannot carry — and (d) matches the pattern every surviving product in this space converged on: GitOps delivers the inputs; a purpose-built actor performs the verified promotion. Argo Rollouts cannot express the routing-tier/pool atomicity or the capacity gate, so it is offered as a documented-tradeoff option, never the default.
