# GitOps: `adapter-k8s emit`

`adapter-k8s emit` (alias: `adapter-k8s deploy --render-only`) runs the pipeline-safe subset of `deploy`—build fingerprints, image build/push, registry digest resolution, collision guards—with **no cluster contact at all**, and writes a hydrated, committable bundle:

```
.k8s-adapter/gitops/
├── chart/               # the chart, verbatim, minus secret templates (--secrets external, default)
├── values/values.yaml   # digests pinned, registry/tag set, CIDRs from config,
│                        #   activeBuildId pinned to the PREVIOUS build (cutover.mode: none)
├── manifests/all.yaml   # local `helm template` output (skipped, with a note, when helm is absent)
├── emit-metadata.json   # buildId, previousBuildId, digests, cdnTag, pool topology, platforms
└── README.md            # cutover model + required Secret names/keys
```

When the config sets `imagePullSecrets` (private registries—see [configuration.md](./configuration.md#registry-pull-auth)), every pod spec in the bundle references those Secrets and the README lists them as an operator prerequisite: they must exist in the target namespace before the bundle is applied, delivered by your secrets flow—the bundle never carries them.

Design and rationale: [plans/gitops-deployment-strategies.md](../plans/gitops-deployment-strategies.md). This page covers what ships today (`cutover.mode: none` only—the in-cluster cutover Job and the Argo/Flux recipes are later PRs).

## ⛔ The drift hazard, first

**Do not point an auto-syncing reconciler (Argo CD `automated` + `selfHeal`, Flux drift detection) at this bundle without selector ignore rules.** The bundle renders the stable Services' selectors at the _previous_ build; cutover is an out-of-band patch (docs/ci-cd.md). A reconciler that "corrects" the selector after your cutover repoints production traffic at a build that has been scaled down—**this reverts a verified cutover onto an empty Deployment and the site 503s.** Measured live, not hypothesized (2026-08-10 audit, [design doc §3.1](../plans/gitops-deployment-strategies.md)): with auto-sync + selfHeal, Argo CD reverted a post-cutover selector in **~2.4 minutes** with the Application still reporting "Synced"—the stable Service drained to **zero endpoints** because the reverted-to build was parked at 0 replicas. A plain no-op `helm upgrade` (what Flux's helm-controller does every interval) reverted it **immediately**. HPA warm-up bounds and routing-image rollback patches were reverted identically; `--field-manager=helm` offers no protection.

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

The parked previous build's objects (Deployment, HPA, dispatch Secret, manifest snapshot) are **not in the new bundle's rendered manifest**. Argo CD with `prune: true` deletes them on the first sync—including, observed live in the same audit, **the still-serving previous build's Deployment while the stable Service still selected it** (endpoints not-ready, pods Terminating, mid-outage). The keep-annotated dispatch Secret, manifest snapshot, and composition-plan ConfigMap were deleted too: Helm honors `helm.sh/resource-policy: keep`; Argo's prune does not. Builds deployed by the imperative CLI carry no prune-protection annotations at all, so the _first_ pruning sync over an existing release deletes your rollback target. Until keep-at-birth rendering and the `migrate` subcommand ship (PR2), run reconcilers with prune disabled against releases that have imperative deploy history.

## Workflow (Mode 0 with rendered inputs)

1. CI: `next build` → `npx adapter-k8s emit` → commit `.k8s-adapter/gitops/` (or copy it into a deploy repo, replaced wholesale per release).
2. Apply the bundle: `helm upgrade --install <release> chart/ -n <namespace> -f values/values.yaml`, or `kubectl apply -f manifests/all.yaml`. This stands the new build up **without repointing traffic**. Before a `helm upgrade` over a serving release, perform the [retention steps from ci-cd.md](./ci-cd.md#retention-helm-upgrade-deletes-your-rollback-target-unless-you-keep-it)—otherwise the upgrade prunes the serving build's Deployment out from under the stable Services.
3. Cut over per [docs/ci-cd.md](./ci-cd.md): verify `/readyz` per pod, then patch the stable Service selectors—or run `adapter-k8s deploy` from a credentialed machine, which performs the full gate battery.

Mode `none` is exactly the ci-cd.md flow with rendered inputs: emit replaces the build/push/digest/values steps, and the cutover, retention, and rollback commands documented there apply to the bundle unchanged.

## Previous-build semantics (fail-closed)

The bundle's `activeBuildId` pins to the previous build, so emit must know it:

1. `--previous-build <id>` — explicit.
2. Otherwise the prior bundle's `emit-metadata.json` in `.k8s-adapter/gitops/` (the normal CI flow: the last committed bundle is checked out).
3. Otherwise emit **refuses**. "No prior bundle found" is _not_ "first deploy"—a shallow, sparse, or wrong-directory checkout looks exactly like a first deploy, and rendering first-deploy semantics against a serving cluster pins the selectors at the unverified new build. Assert a genuine first deploy explicitly with `--first-deploy`.

A present-but-corrupt prior bundle is an error, never a first deploy. Re-emitting the same build reuses the prior bundle's own previous-build pointer, so re-emits are byte-idempotent (the re-emit diff is the audit for chart determinism).

## Secrets

`--secrets external` (default): the bundle chart omits `internal-secret.yaml`/`valkey-secret.yaml` and emits `templates/external-secret.yaml`—ExternalSecrets gated on `externalSecrets.storeName` in values—plus a README table of the exact Secret names/keys the pods reference. Load the values into your store from the build output (the gitignored `chart/templates/internal-secret.yaml` holds the rendered dispatch secret).

`--secrets inline`: today's chart verbatim, with a loud warning—committing the bundle commits real credentials, and Git does not preserve the 0600 file mode.

Either way, CI must pin `ADAPTER_K8S_INTERNAL_SECRET_KEY` (or restore `.k8s-adapter/internal-secret.key`): the dispatch secret is an HMAC of the build id under that key, and without a stable key every emit of the same build derives a different secret, breaking bundle determinism.

## CIDRs

Emit performs no discovery; NetworkPolicy ranges come from config (`networkPolicy.nodeCidrs` / `podCidrs`—see [docs/configuration.md](./configuration.md#static-networkpolicy-ranges-adapter-k8s-emit)). With no `nodeCidrs`, emit refuses to render the strict posture; `--allow-no-network-policy` is the explicit opt-out. Applying the chart outside emit entirely? The [ci-cd.md CIDR guard section](./ci-cd.md#the-networkpolicy-cidr-guard) covers the `{{- fail }}` guard and its two `--set` escape hatches.

## `destroy` under a reconciler

Audit-observed: after `helm uninstall`, an Argo CD Application with `selfHeal` re-created the entire release within a minute. Before running `adapter-k8s destroy` (or `helm uninstall`) against a release a reconciler manages, delete or pause the Application/Kustomization first—otherwise the reconciler and destroy fight forever.

## See also

- [CI/CD](./ci-cd.md) — the cutover and retention steps this bundle's `cutover.mode: none` relies on
- [Configuration](./configuration.md) — static NetworkPolicy ranges, config variants
- [Lifecycle](./lifecycle.md) — what the imperative deploy does that this bundle deliberately does not
- [plans/gitops-deployment-strategies.md](../plans/gitops-deployment-strategies.md) — full design, live audit findings, PR2/PR3 roadmap
