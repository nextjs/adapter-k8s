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

Design and rationale: [plans/gitops-deployment-strategies.md](../plans/gitops-deployment-strategies.md). Two cutover models ship today: `cutover.mode: none` (the default—promotion stays out-of-band, below) and `--cutover job` (the [in-cluster cutover Job](#in-cluster-cutover---cutover-job), which promotes inside the target namespace after the same gate battery `deploy` runs). The Argo CD/Flux recipes are a later PR.

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

One gap remains (tracked on the PR): the in-chart Secret/ExternalSecret and per-build ConfigMap templates carry Helm's `keep` but not yet the Argo/Flux annotations at render time—`migrate` covers the live objects, but until the chart renders them keep prune disabled under Argo/Flux for those kinds or re-run `migrate` after each sync.

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
- **A gate failure restores the edge first, then exits nonzero** (the reconciler reports a failed Job), and records the build in the state ConfigMap's `failedPromotions` — the **poison pill**. Reconciler retries then refuse cheaply (one short-lived pod, no HPA warm-up wobble) until you fix the build and emit a new one, or override deliberately with `cutover.forcePromotion: true`. The pill clears on the next successful promotion. Find the pods with `kubectl logs -l app.kubernetes.io/component=cutover-job -n <ns>`.
- **`cutover.image` must exist before the first job-mode sync.** Build it from this repo's [docker/cutover-job.Dockerfile](../docker/cutover-job.Dockerfile) (`npm run build`, then `docker build -f docker/cutover-job.Dockerfile …`), push it to your registry, and set the values key to the pushed image **by digest**. The chart default names the release-train tag, which your cluster may not be able to pull.
- **Prerequisite for existing releases:** run [`adapter-k8s migrate`](#-prune-deletes-your-rollback-target) once before pointing a pruning reconciler at a release with imperative deploy history.
- **Selector ignore rules are still required** (see [the drift hazard](#-the-drift-hazard-first)): the bundle renders selectors at the previous build, so a self-healing reconciler reverts the Job's promotion exactly as it reverts an out-of-band one.
- **Known gaps** (tracked on the PR): the Job does not yet load the compiled composition readiness plan (HTTPRoute/Certificate readiness on composed targets), and CDN invalidation from inside the pod needs a workload identity—both fail non-fatal today.

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

## Secrets

`--secrets external` (default): the bundle chart omits `internal-secret.yaml`/`valkey-secret.yaml` and emits `templates/external-secret.yaml`—ExternalSecrets gated on `externalSecrets.storeName` in values—plus a README table of the exact Secret names/keys the pods reference. Load the values into your store from the build output (the gitignored `chart/templates/internal-secret.yaml` holds the rendered dispatch secret).

`--secrets sops`: the same secret objects inline mode ships in-chart—the per-build dispatch Secret and, when the cache is enabled, the Valkey connection Secret—are written as plain YAML and encrypted through the `sops` CLI into `secrets/<name>.sops.yaml`. The chart omits the secret templates (like external mode); the encrypted files are applied by your GitOps engine's SOPS integration. **Recipients come from the repo's own `.sops.yaml` creation rules**: emit walks up from the bundle directory for `.sops.yaml` and runs sops with its cwd at that directory, never passing recipients on argv—so the same rules that govern every other secret in the repo govern these (`--sops-config <path>` names a config explicitly). Fail-closed: a missing `sops` binary, no discoverable `.sops.yaml`, or a nonzero sops exit is a hard error—emit **never** falls back to writing plaintext.

With Flux, decrypt via a Kustomization pointed at `secrets/`:

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
spec:
  path: ./.k8s-adapter/gitops/secrets
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
