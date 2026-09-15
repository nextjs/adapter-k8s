# GitOps: `adapter-k8s emit`

`adapter-k8s emit` (alias: `adapter-k8s deploy --render-only`) runs the pipeline-safe subset of `deploy`—build fingerprints, image build/push, registry digest resolution, collision guards—with **no cluster contact at all**, and writes a hydrated, committable bundle:

```
.k8s-adapter/gitops/
├── chart/               # the chart, verbatim, minus secret templates (--secrets external, default)
├── values/values.yaml   # digests pinned, registry/tag set, CIDRs from config,
│                        #   activeBuildId pinned to the PREVIOUS build (cutover.mode: none)
├── manifests/all.yaml   # local `helm template` output (skipped, with a note, when helm is absent)
├── secrets/             # --secrets sops only: the secret manifests, SOPS-encrypted (*.sops.yaml)
├── emit-metadata.json   # buildId, previousBuildId, digests, cdnTag, pool topology, platforms
├── renovate.json5       # update-bot fence (copy source — see "Renovate and image automation")
└── README.md            # cutover model + required Secret names/keys + update-bot fence
```

When the config sets `imagePullSecrets` (private registries—see [configuration.md](./configuration.md#registry-pull-auth)), every pod spec in the bundle references those Secrets and the README lists them as an operator prerequisite: they must exist in the target namespace before the bundle is applied, delivered by your secrets flow—the bundle never carries them.

Design and rationale: [plans/gitops-deployment-strategies.md](../plans/gitops-deployment-strategies.md). Two cutover models ship today: `cutover.mode: none` (the default—promotion stays out-of-band, below) and `--cutover job` (the [in-cluster cutover Job](#in-cluster-cutover---cutover-job), which promotes inside the target namespace after the same gate battery `deploy` runs). A copy-ready Flux recipe is included below; an equivalent generated Argo CD recipe remains future work.

## ⛔ The drift hazard, first

**Do not point an auto-syncing reconciler (Argo CD `automated` + `selfHeal`, Flux drift detection) at this bundle without selector ignore rules—under EITHER cutover mode.** The bundle renders the stable Services' selectors at the _previous_ build; the cutover that repoints them is a live-object patch (out-of-band under `mode: none`, the in-cluster Job's under `mode: job`—the bundle itself never moves traffic). A reconciler that "corrects" the selector after the promotion repoints production traffic at a build that has been scaled down—**this reverts a verified cutover onto an empty Deployment and the site 503s.** Measured live, not hypothesized (2026-08-10 audit, [design doc §3.1](../plans/gitops-deployment-strategies.md)): with auto-sync + selfHeal, Argo CD reverted a post-cutover selector in **~2.4 minutes** with the Application still reporting "Synced"—the stable Service drained to **zero endpoints** because the reverted-to build was parked at 0 replicas. A plain no-op `helm upgrade` (what Flux's helm-controller does every interval) reverted it **immediately**. HPA warm-up bounds and routing-image rollback patches were reverted identically; `--field-manager=helm` offers no protection.

Until the recipes ship (PR3), hand-write the ignore rules, and target Services **by name, not by label** (Helm rewrites the `managed-by: adapter-k8s-active` label on live objects, so a label selector matches nothing and silently reverts every cutover):

```yaml
# Argo CD Application — one entry per pool, plus -origin
syncPolicy:
  syncOptions: [RespectIgnoreDifferences=true]
ignoreDifferences:
  - kind: Service
    name: <release>-<pool>
    jsonPointers: [/spec/selector]
```

```yaml
# Flux HelmRelease driftDetection — same names, kind + name, never labelSelector
driftDetection:
  mode: enabled
  ignore:
    - target: { kind: Service, name: <release>-<pool> }
      paths: [/spec/selector]
```

**The kind-wide variant is the safe default**: ignore `/spec/selector` on every `Service` (omit `name`). It is coarser but costs nothing—the versioned Services are never patched, so ignoring their selectors changes no behavior—and unlike the by-name list it does not need updating when a later bundle adds a pool. A pool added without its ignore entry is unprotected, and the drift hazard above returns for exactly that pool's Service.

```yaml
# Argo CD, kind-wide (the safe default)
ignoreDifferences:
  - kind: Service
    jsonPointers: [/spec/selector]
```

Argo additionally shows Gateway API objects (HTTPRoute, EnvoyExtensionPolicy) as perpetually OutOfSync: the apiserver defaults `group`/`kind`/`weight` onto `backendRefs` that the rendered JSON omits. This is cosmetic—do not "fix" it by enabling selfHeal; add `ignoreDifferences` entries for those defaulted fields if the noise matters.

## ⛔ Prune deletes your rollback target

The parked previous build's objects (Deployment, HPA, dispatch Secret, manifest snapshot) are **not in the new bundle's rendered manifest**. Argo CD with `prune: true` deletes them on the first sync—including, observed live in the same audit, **the still-serving previous build's Deployment while the stable Service still selected it** (endpoints not-ready, pods Terminating, mid-outage). The keep-annotated dispatch Secret, manifest snapshot, and composition-plan ConfigMap were deleted too: Helm honors `helm.sh/resource-policy: keep`; Argo's prune does not.

Two mechanisms close this, both shipped:

- **`adapter-k8s migrate`** — run it ONCE against any release with imperative deploy history, _before_ enabling a pruning reconciler. Builds deployed by the imperative CLI carry no prune-protection annotations at all, so the _first_ pruning sync deletes your rollback target; `migrate` annotates the live retained set (per-build Deployments/Services/HPAs, dispatch Secrets, snapshot and plan ConfigMaps, the state ConfigMap) with all three engines' protections, is idempotent, and exits nonzero if anything could not be annotated.
- **Keep-at-birth rendering** — under `cutover.mode: job` every per-build resource in the bundle carries `helm.sh/resource-policy: keep`, `argocd.argoproj.io/sync-options: Prune=false`, and `kustomize.toolkit.fluxcd.io/prune: disabled` from its own bundle onward, so the sync that applies build N+1 cannot prune build N out from under the stable Services.

Under `cutover.mode: job` the in-chart Secret/ExternalSecret and per-build ConfigMap templates render the Argo/Flux prune annotations too (Argo ignores Helm's `keep`, so `keep` alone did not protect them). Mode-`none` charts stay byte-identical and carry Helm's `keep` only—if you point a pruning reconciler at a mode-`none` bundle, keep prune disabled for those kinds or re-run `migrate` after each sync.

## ⛔ Renovate and image automation

Nothing inside the bundle may be independently updated—it is a build artifact of one `emit` run, and the routing tier refuses a manifest that does not byte-match the digest baked into its own image (the manifest-digest check, fail-closed by design). A bot edit to any image tag/digest field in the bundle—Renovate's `helm-values` manager, Flux image-automation's `$imagepolicy` markers—desyncs that check and **crashloops the routing pod after automerge**. Point Renovate and Flux image-automation at your **app repo** (where the next build runs), never at bundle contents; new images reach the cluster via the next `emit`, which replaces the directory wholesale.

The bundle ships a `renovate.json5` fence at its root. Renovate does not auto-discover config at that path—it is a **copy source**: merge its entry into your repo's existing Renovate config (note `ignorePaths` _replaces_ Renovate's defaults when set, so keep your existing entries alongside it):

```json5
"ignorePaths": [".k8s-adapter/gitops/**"]
```

Config variants emit to `.k8s-adapter/gitops.<variant>/`; the bundled fence carries the matching path.

## In-cluster cutover (`--cutover job`)

`adapter-k8s emit --cutover job` renders the same bundle with three additions in the chart—a per-build-named **cutover Job**, its namespace-scoped ServiceAccount/Role/RoleBinding, and a per-build emit-metadata ConfigMap the Job mounts—and flips the stable Services to render their selectors at the _previous_ build with an `adapter-k8s.io/cutover: pending` annotation. The sync stands the new build up **without moving traffic**; the Job then runs the SAME gate battery imperative `deploy` runs (exact-version rollout waits, ext_proc registration/policy acceptance, HPA warm-up to the outgoing build's live capacity, per-pool `/readyz`) and only then patches the selectors, commits the state ConfigMap (cluster-only mode), and parks the previous build. On promotion the Job clears the annotation (absent = promoted; a value-writing "complete" is not expressible under server-side apply — any Update-owner value conflicts with the next sync's re-stamp); the next bundle's sync stamps `pending` again, which is again true for that bundle's build.

Operational notes:

- **It is a plain `batch/v1` Job**—no Argo hook or sync-wave semantics required (Flux has none). Its per-build name is the idempotency key: a no-op re-sync finds the completed Job and does nothing, and a re-created pod for an already-promoted build logs "already promoted" and exits 0 without touching HPAs.
- **A gate failure restores the edge first, then exits nonzero** (the reconciler reports a failed Job), and records the build in the state ConfigMap's `failedPromotions` — the **poison pill**. Reconciler retries then refuse cheaply (one short-lived pod, no HPA warm-up wobble) until you fix the build and emit a new one, or override deliberately with `cutover.forcePromotion: true` (which renders the Job under a `-force` name — Jobs are immutable, so the override could not otherwise re-run beside the original failed Job). The pill clears on the next successful promotion. Find the pods with `kubectl logs -l app.kubernetes.io/component=cutover-job -n <ns>`.
- **`cutover.image` is required at emit time, by digest.** `emit --cutover job` refuses to render a bundle without a digest-pinned image (`--cutover-image <name@sha256:…>` or `ADAPTER_K8S_CUTOVER_IMAGE`)—the chart-default tag is neither published nor immutable. Build it from this repo's [docker/cutover-job.Dockerfile](../docker/cutover-job.Dockerfile) after `npm run build`. The Dockerfile deliberately requires `KUBECTL_VERSION`: choose a release within one minor of the target API server, and build for the cluster node architecture (not the workstation's). For an amd64 Kubernetes 1.35 cluster, for example: `docker build --platform=linux/amd64 --build-arg KUBECTL_VERSION=v1.35.7 -f docker/cutover-job.Dockerfile -t <registry>/adapter-k8s-cutover:<version> .`. Push it, resolve the registry digest, and pass that digest to emit. The same Dockerfile and built `dist/` are included in the npm package, so an installed copy can be used as the build context too.
- **Prerequisite for existing releases:** run [`adapter-k8s migrate`](#-prune-deletes-your-rollback-target) once before pointing a pruning reconciler at a release with imperative deploy history.
- **Selector ignore rules are still required** (see [the drift hazard](#-the-drift-hazard-first)): the bundle renders selectors at the previous build, so a self-healing reconciler reverts the Job's promotion exactly as it reverts an out-of-band one.
- **Composed-target readiness is part of the gate battery.** For composed-target bundles the Job loads the per-build composition-plan ConfigMap and verifies owned Gateway and HTTPRoute conditions, shared-parent HTTPRoute conditions, optional Certificate readiness, and origin Service endpoints before promoting; a missing plan ConfigMap is a refusal, not a skip. Its namespace Role is generated from those checks, so a new namespaced CRD gets only the required read verb. `emit --cutover job` rejects a readiness reference with no namespace or a different namespace instead of silently widening the Job to a ClusterRole. Kubernetes Ingress has no portable standard readiness condition, so controller-specific Ingress status remains an operator check. (Provider-ingress bundles render no plan and promote on the base battery.)
- **Known gap** (tracked on the PR): CDN invalidation from inside the pod needs a workload identity—it fails non-fatal today.

## Workflow (Mode 0 with rendered inputs)

1. CI: `next build` → `npx adapter-k8s emit` → commit `.k8s-adapter/gitops/` (or copy it into a deploy repo, replaced wholesale per release).
2. Apply the bundle: `helm upgrade --install <release> chart/ -n <namespace> -f values/values.yaml`, or `kubectl apply -f manifests/all.yaml`. This stands the new build up **without repointing traffic**. Before a `helm upgrade` over a serving release, perform the [retention steps from ci-cd.md](./ci-cd.md#retention-helm-upgrade-deletes-your-rollback-target-unless-you-keep-it)—otherwise the upgrade prunes the serving build's Deployment out from under the stable Services.
3. Cut over per [docs/ci-cd.md](./ci-cd.md): verify `/readyz` per pod, then patch the stable Service selectors—or run `adapter-k8s deploy` from a credentialed machine, which performs the full gate battery.

Mode `none` is exactly the ci-cd.md flow with rendered inputs: emit replaces the build/push/digest/values steps, and the cutover, retention, and rollback commands documented there apply to the bundle unchanged.

## Previous-build semantics (fail-closed)

The bundle's `activeBuildId` pins to the previous build, so emit must know it:

1. `--previous-bundle <path>` — the prior bundle in **another checkout** (split app/cluster repos, below). Authoritative when given: the same-repo lookup is skipped, and a missing or unreadable path is a hard error—never a fallback.
2. `--previous-build <id>` — explicit bare id.
3. Otherwise the prior bundle's `emit-metadata.json` in `.k8s-adapter/gitops/` (the monorepo CI flow: the last committed bundle is checked out).
4. Otherwise emit **refuses**. "No prior bundle found" is _not_ "first deploy"—a shallow, sparse, or wrong-directory checkout looks exactly like a first deploy, and rendering first-deploy semantics against a serving cluster pins the selectors at the unverified new build. Assert a genuine first deploy explicitly with `--first-deploy`.

A present-but-corrupt prior bundle is an error, never a first deploy. Re-emitting the same build reuses the prior bundle's own previous-build pointer, so re-emits are byte-idempotent (the re-emit diff is the audit for chart determinism). `--previous-bundle` contradicts `--first-deploy` (one names a prior bundle, the other asserts none exists) and `--previous-build` (two sources of truth); either pair is refused.

## Split app/cluster repos (`--previous-bundle`)

When the app repo runs CI/`emit` and a separate cluster repo holds the committed bundles, the same-repo lookup never finds a prior bundle—every emit would look like a first deploy and refuse. Point emit at the cluster-repo checkout instead:

```yaml
# app-repo CI (shape, not a literal workflow)
- checkout: cluster-repo # e.g. into ../cluster-repo
- run: npx adapter-k8s emit \
    --previous-bundle ../cluster-repo/apps/myapp/.k8s-adapter/gitops
- run: | # replace the cluster repo's bundle WHOLESALE
    rm -rf ../cluster-repo/apps/myapp/.k8s-adapter/gitops
    cp -R .k8s-adapter/gitops ../cluster-repo/apps/myapp/.k8s-adapter/gitops
- commit + PR against cluster-repo
```

The path may name the bundle directory or its `emit-metadata.json` directly (relative paths resolve against the project directory). The foreign bundle passes the **same** validation battery as a same-repo one—wrong release, wrong namespace, newer `emitVersion`, or corrupt JSON are refusals, and its `previousDefaultPool` is consumed identically on a re-emit of the same build. The flag is fail-closed in the direction that matters for CI: a wrong path (or a checkout step that silently didn't run) is a hard error, never silently treated as a first deploy. The genuine first deploy of a split-repo release uses `--first-deploy` with no `--previous-bundle`.

## Two-PR agent onboarding

For an existing application and a separately reconciled cluster repository, keep ownership and
authorization visible as two PRs:

1. **Application PR — prepare, do not deploy.** Add a reproducible adapter dependency and lockfile,
   wire `adapterPath`, add `adapter.config.*`, and optionally add the app repo's public-recipient
   `.sops.yaml` rule. Validate with `next build`. Keep `.k8s-adapter/` ignored and do not push
   images or emit a cluster bundle from an unreviewed application diff. The PR description hands
   off the non-secret release facts: release, namespace, registry, hostname, platform, and variant.
2. **Cluster PR — build the reviewed commit, then integrate.** From the merged or explicitly named
   application commit, inspect the supplied kubeconfig read-only, recreate the ignored
   `infrastructure*.json`, build/push images, and run `emit`. Copy the bundle wholesale into a
   clean cluster-repo branch, then add the environment-owned Flux/Argo, SOPS, pull-secret, DNS,
   certificate/Gateway, and tunnel resources. Open the PR without applying or merging it; merge is
   the reconciler's deployment trigger.

The adapter package must be resolvable from a fresh application checkout. Never commit `npm link`,
an absolute `file:/Users/...` dependency, or a tarball path that exists only on the present laptop.
Until a registry release exists, use a stable reviewed package artifact URL; otherwise package
distribution—not Kubernetes—is the honest blocker to a mergeable first PR.

Prompt shape for PR 1:

> Read the installed `skills/configure/SKILL.md`. Inspect this project and the named kubeconfig
> read-only. Prepare and validate an application-only PR for adapter-k8s. Do not edit the cluster
> repo, push deployment images, emit a bundle, or deploy.

Prompt shape for PR 2:

> Read the installed `skills/deploy/SKILL.md`. Use this exact reviewed application commit and the
> cluster repo at `<path>` with kubeconfig `<path>`. You may edit the cluster repo and open a PR;
> do not merge it or mutate the live cluster. Generate the digest-pinned SOPS bundle and include
> every environment-owned DNS/Gateway/tunnel prerequisite discovered from existing apps.

## Flux recipe: a chart committed in the cluster repository

This is the portable split-repository shape for a Flux cluster whose existing `GitRepository`
source is named `flux-system`. Replace every `<...>` placeholder and keep the emitted bundle
whole—the chart, values, metadata, encrypted Secrets, and update-bot fence are one build artifact:

```text
kubernetes/apps/<namespace>/<release>/
├── ks.yaml
└── app/
    ├── kustomization.yaml
    ├── helmrelease.yaml
    └── bundle/                 # wholesale copy of .k8s-adapter/gitops/
        ├── chart/
        ├── values/
        ├── manifests/
        ├── secrets/            # --secrets sops
        ├── emit-metadata.json
        ├── renovate.json5
        └── README.md
```

Add `<release>/ks.yaml` to the namespace/category Kustomization that already discovers Flux
objects in your cluster repository. In repositories where the top-level Flux `Kustomization`
recursively discovers those objects, no additional parent entry is needed.

SOPS encryption happens in the app checkout **before** the bundle is copied. The app repo's
`.sops.yaml` must therefore match the emitted source path, even when the cluster repo has its own
rule for `kubernetes/**`. An age recipient is public and can safely be shared between the two
configs:

```yaml
# app-repo/.sops.yaml
creation_rules:
  - path_regex: ^\.k8s-adapter/gitops/secrets/.*\.sops\.ya?ml$
    encrypted_regex: "^(data|stringData)$"
    key_groups:
      - age:
          - age1replace_with_the_cluster_recipient
```

`--sops-config ../cluster-repo/.sops.yaml` selects that file but does not rewrite the secret's
path for `creation_rules`; a cluster-only `path_regex: kubernetes/.*` still will not match the
app repo's `.k8s-adapter/gitops/secrets/...` path.

For SOPS mode, reconcile the encrypted Secrets separately and make the application wait for
them. Pointing a Flux `Kustomization` directly at `bundle/secrets` is intentional: Flux generates
the small Kustomize file for that directory, while `app/kustomization.yaml` prevents it from trying
to parse the Helm chart and values as Kubernetes resources. The `sops-age` Secret must exist in
the same namespace as the `<release>-secrets` Flux `Kustomization`; many cluster repositories copy
it into each application namespace through a reusable component.

The example keeps the shared `GitRepository` in `flux-system` while the two `Kustomization`
objects and the `HelmRelease` live in the application namespace. It therefore requires both
kustomize-controller and helm-controller to allow cross-namespace source references. Clusters that
set `--no-cross-namespace-refs=true` must provide an equivalent `GitRepository` in the application
namespace and remove `namespace: flux-system` from each `sourceRef` below.

```yaml
# kubernetes/apps/<namespace>/<release>/ks.yaml
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: <release>-secrets
  namespace: <namespace>
spec:
  interval: 30m
  retryInterval: 1m
  path: ./kubernetes/apps/<namespace>/<release>/app/bundle/secrets
  targetNamespace: <namespace>
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  decryption:
    provider: sops
    secretRef:
      name: sops-age
  wait: true
  timeout: 5m
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: <release>
  namespace: <namespace>
spec:
  interval: 30m
  retryInterval: 1m
  path: ./kubernetes/apps/<namespace>/<release>/app
  targetNamespace: <namespace>
  prune: true
  sourceRef:
    kind: GitRepository
    name: flux-system
    namespace: flux-system
  dependsOn:
    - name: <release>-secrets
  wait: true
  timeout: 155m
```

If `--secrets external` is used instead, omit the Secrets `Kustomization` and `dependsOn`, and
make sure the named `ExternalSecret` store and registry pull Secrets already exist.

```yaml
# kubernetes/apps/<namespace>/<release>/app/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ./helmrelease.yaml
```

```yaml
# kubernetes/apps/<namespace>/<release>/app/helmrelease.yaml
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: <release>
  namespace: <namespace>
spec:
  interval: 30m
  timeout: 150m
  chart:
    spec:
      chart: ./kubernetes/apps/<namespace>/<release>/app/bundle/chart
      sourceRef:
        kind: GitRepository
        name: flux-system
        namespace: flux-system
      valuesFiles:
        - ./kubernetes/apps/<namespace>/<release>/app/bundle/values/values.yaml
  driftDetection:
    mode: enabled
    ignore:
      - target:
          kind: Service
        paths:
          - /spec/selector
```

The kind-wide Service ignore is deliberate and is safer than enumerating pool names: a later
bundle can add a pool without silently reintroducing selector drift. Do not set
`install.disableWaitForJobs` or `upgrade.disableWaitForJobs`; Flux must wait for the cutover Job.
Keep the chart's default `ChartVersion` reconciliation strategy. Every emitted build has a
build-specific `Chart.yaml` version, so a new bundle triggers an upgrade while an unrelated commit
elsewhere in the shared cluster repository does not. `Revision` is unsafe here: it turns every
repository commit into a Helm upgrade, which can reapply the chart's pre-cutover Service selectors.
The 150-minute timeout is a conservative small-topology example, and it must be recomputed for
yours: an
overrun is not a benign retry. When the `HelmRelease` timeout fires mid-cutover, Flux marks the
release failed and — under the default `upgrade.remediation` — rolls it back, reapplying the
chart's pre-cutover Service selectors, while the cutover Job (which has no
`activeDeadlineSeconds`) keeps running and later patches those same selectors forward. That
split-selector state is what the cutover design exists to avoid.

Keep the `HelmRelease` timeout above the emitted Job's SEQUENTIAL gate budget:
`pools x 10m` (pool rollouts, awaited one at a time) `+ 30m` (the routing rollout, at its
ceiling) `+ 10m` (the ext_proc registration Job, GKE only; allow 1m for the generic policy gate)
`+ the composition-plan readiness budget` `+ 2m` (the readiness/capacity gate), then add at
least 10m for the bounded kubectl reads and patches between waits. Do not omit the composition
term: `waitForCompositionPlanReadiness` waits its distinct entries ONE AT A TIME, each with its
own deadline. Read `.k8s-adapter/output/composition-plan.json` and sum the `timeoutSeconds` of
the distinct entries in `operations.resources.readiness` and
`operations.routing.dataplane.readiness`; count `kubernetes-service-endpoints` as 120s and
`gcp-traffic-extension` as 600s because those two kinds carry fixed runtime defaults instead.
Identical entries present in both arrays are waited once. For example, three pools, GKE
registration, four distinct 10-minute composition checks, and the 10-minute command cushion need
at least `30 + 30 + 10 + 40 + 2 + 10 = 122m`, not 72m. Two of those numbers are worst cases rather
than typical ones: the routing gate derives its wait from that tier's live replica count (10
minutes at the default HPA floor of 2, rising to the 30-minute ceiling around 6 replicas), and a
pool rollout only spends its full budget if pods are slow to boot. Budget the ceiling anyway —
the failure mode above is worse than a long reconciliation. Keep the parent Kustomization timeout
larger than the HelmRelease timeout.

For every subsequent build, the app pipeline checks out the cluster repository, passes the old
`app/bundle` to `--previous-bundle`, replaces `app/bundle` wholesale, copies the emitted
`renovate.json5` ignore path into the cluster repository's root Renovate config, and opens a PR.
The PR is the review boundary; merging it is the deployment trigger. Never let Renovate or Flux
image automation edit files inside `bundle/` independently.

## Secrets

`--secrets external` (default): the bundle chart omits `internal-secret.yaml`/`valkey-secret.yaml` and emits `templates/external-secret.yaml`—ExternalSecrets gated on `externalSecrets.storeName` in values—plus a README table of the exact Secret names/keys the pods reference. Load the values into your store from the build output (the gitignored `chart/templates/internal-secret.yaml` holds the rendered dispatch secret).

`--secrets sops`: the same secret objects inline mode ships in-chart—the per-build dispatch Secret and, when the cache is enabled, the Valkey connection Secret—are written as plain YAML and encrypted through the `sops` CLI into `secrets/<name>.sops.yaml`. The chart omits the secret templates (like external mode); the encrypted files are applied by your GitOps engine's SOPS integration. **Recipients come from the repo's own `.sops.yaml` creation rules**: emit walks up from the bundle directory for `.sops.yaml` and runs sops with its cwd at that directory, never passing recipients on argv—so the same rules that govern every other secret in the repo govern these (`--sops-config <path>` names a config explicitly). Fail-closed: a missing `sops` binary, no discoverable `.sops.yaml`, or a nonzero sops exit is a hard error—emit **never** falls back to writing plaintext.

With Flux, decrypt via a Kustomization pointed at `secrets/`. This same-repository example keeps
the emitted path; for a split app/cluster repository, use the complete recipe above and point at
the copied `app/bundle/secrets` directory instead:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
spec:
  path: ./.k8s-adapter/gitops/secrets
  targetNamespace: <namespace>
  decryption:
    provider: sops
    secretRef:
      name: sops-age # the Secret holding your age key
```

(Argo CD needs a SOPS plugin such as KSOPS; `sops -d secrets/<f> | kubectl apply -f -` works for hand-applied flows.)

**Determinism caveat**: `secrets/` is excluded from the bundle's byte-determinism guarantee—sops embeds fresh data keys and MACs per encryption. Emit keeps re-emit diffs quiet by reusing an existing encrypted file when it still decrypts (recipients unchanged) to the identical plaintext, re-encrypting otherwise; a changed `secrets/` file in a re-emit diff therefore means the plaintext or the recipients changed, never noise. As with external mode, a build's dispatch Secret must outlive the sync that applies the next build's bundle (the retained previous build references it by name—the rollback target).

`--secrets inline`: today's chart verbatim, with a loud warning—committing the bundle commits real credentials, and Git does not preserve the 0600 file mode.

CI must pin `ADAPTER_K8S_INTERNAL_SECRET_KEY` (or restore `.k8s-adapter/internal-secret.key`): the dispatch secret is an HMAC of the build id under that key, and without a stable key every emit of the same build derives a different secret, breaking bundle determinism. Under `--secrets inline` and `--secrets sops`—the modes that embed the secret material in the bundle—emit **refuses to run** when neither key source exists (the build would silently mint a fresh random key and every re-emit would rotate the secret).

## CIDRs

Emit performs no discovery; NetworkPolicy ranges come from config (`networkPolicy.nodeCidrs` / `podCidrs`—see [docs/configuration.md](./configuration.md#static-networkpolicy-ranges-adapter-k8s-emit)). With no `nodeCidrs`, emit refuses to render the strict posture; `--allow-no-network-policy` is the explicit opt-out. Applying the chart outside emit entirely? The [ci-cd.md CIDR guard section](./ci-cd.md#the-networkpolicy-cidr-guard) covers the `{{- fail }}` guard and its two `--set` escape hatches.

## `destroy` under a reconciler

Audit-observed: after `helm uninstall`, an Argo CD Application with `selfHeal` re-created the entire release within a minute. Before running `adapter-k8s destroy` (or `helm uninstall`) against a release a reconciler manages, delete or pause the Application/Kustomization first—otherwise the reconciler and destroy fight forever.

## See also

- [CI/CD](./ci-cd.md) — the cutover and retention steps this bundle's `cutover.mode: none` relies on
- [Configuration](./configuration.md) — static NetworkPolicy ranges, config variants
- [Lifecycle](./lifecycle.md) — what the imperative deploy does that this bundle deliberately does not
- [plans/gitops-deployment-strategies.md](../plans/gitops-deployment-strategies.md) — full design, live audit findings, PR2/PR3 roadmap
