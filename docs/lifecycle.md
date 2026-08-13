# Deploy lifecycle

What `deploy`, `rollback`, `destroy`, and `doctor` actually do, and where deploy state lives. The commands consume the same versioned composition plan the build emitted—see [targets](./targets.md)—so preflight, readiness, diagnostics, and cleanup all follow the target you configured rather than a provider name.

## Deploy

`npx adapter-k8s deploy` runs, in order:

1. **Preflight.** Validates `.k8s-adapter/infrastructure.json` and probes the Helm client (Helm 3 uses its client-side upgrade path; Helm 4 uses server-side apply).
2. **Build.** Runs `next build` (skip with `--skip-build`); the adapter's `onBuildComplete` generates the chart, Dockerfiles, and routing manifest under `.k8s-adapter/output/`. Deploying output built for a different registry, namespace, or platform is refused—the chart bakes those at build time, so a mismatch always means the output belongs to a different target.
3. **Cluster verification.** Establishes cluster access per the plan (`kubeconfig-context` or `gcloud get-credentials`) and verifies cluster identity. An unpinned context requires explicit confirmation (`--yes` in CI). Checks the cluster serves the Kubernetes APIs the target's components declared. A container runtime is then resolved (`docker`, `podman`, then `nerdctl`; force one with `ADAPTER_K8S_CONTAINER_CLI`; skipped with `--skip-push`) before anything with mutating side effects.
4. **Isolation.** Discovers pod and node CIDRs from the plan's sources and emits the NetworkPolicy allowlist. A deploy that can't establish isolation **aborts** rather than shipping without it (`--allow-no-network-policy` opts out, loudly).
5. **Push and pin.** Builds and pushes per-pool images plus the routing service when the target hosts one, then resolves every image to its immutable `@sha256:` digest **from the registry** and deploys that. If a digest cannot be resolved, the deploy aborts unless `--allow-mutable-tags` is passed (see [SECURITY.md](../SECURITY.md#image-provenance)).
6. **`helm upgrade`**, then readiness: every declared readiness condition (Gateway `Programmed`, HTTPRoute `Accepted`, extension policy `Accepted`, traffic-extension state on GKE) must hold before cutover.
7. **Blue/green cutover** (below), then the deploy-state commit, then—where a CDN is configured—invalidation of the outgoing build's cache tag and the scale-down of the previous build to zero replicas. Those last steps run after the state commit deliberately: a failure there must never be able to lose a confirmed cutover.

## Blue/green semantics

Each deploy creates a new versioned Deployment alongside the previous one. Traffic points at a stable active Service whose selector is patched only after every new pod passes readiness _and_ is verified serving via `/readyz` directly on the pod. The previous build is kept at zero replicas as a rollback target.

`/readyz` is the pod's own verdict: it answers 503 until instrumentation registration has succeeded and at least one route module has imported. The selector value comes from the same sanitizer that stamps the pod label—a mismatch would drain the Service to zero endpoints, which is why both sides derive from one function.

## Rollback

`npx adapter-k8s rollback` returns to the previous build: pools scale back up, the routing tier reverts to that build's image and manifest snapshot, and the Service selectors patch back. It is symmetric—running it again rolls forward. Deploys resolve images by digest; the routing tier's rollback path currently reconstructs its image reference from the build tag (digest-pinned rollback is on the [roadmap](../README.md#roadmap)).

The routing pod refuses to start on a manifest that does not match its own image, so a mismatched image/manifest pair fails loudly rather than serving another build's route classification.

### Why not `helm rollback`

Use `npx adapter-k8s rollback`, not `helm rollback`. Helm revisions are reconciliation snapshots captured before the adapter's verified Service-selector cutover, not application release checkpoints. A raw Helm rollback does not restore adapter state, routing state, pool capacity, or CDN state, and can restore a pre-cutover stable Service selector. On Helm 4 it can also conflict with HPA-owned Deployment replicas; `--force-conflicts` bypasses that conflict but does not make the rollback safe.

## Destroy

`npx adapter-k8s destroy` tears down **release-scoped** resources and keeps **shared infrastructure**, reporting what it retained:

- Removed:
  - The Helm release.
  - The previous build's pool Deployments/HPAs/Services (kept until now as rollback targets).
  - Routing-manifest and composition-plan snapshot ConfigMaps.
  - The per-build internal-dispatch Secrets. They carry `helm.sh/resource-policy: keep` on purpose—a build's secret must outlive the upgrade that renders the next build's—so `helm uninstall` deliberately does not remove them, and destroy must.
  - On GKE, release-scoped cloud resources: the managed Memorystore instance, traffic extension, backend service, health check, static address, and the release's IAM identities.
- Retained and reported: the cluster itself, the Artifact Registry repository, and managed certificates—infrastructure that other releases (or the next `init`) share.

Kubernetes cleanup is exact: every object recorded in the composition plan is independently checked for its release ownership label before deletion, so destroy cannot take out objects a different release owns. `--dry-run` prints every command without executing.

## Doctor

`npx adapter-k8s doctor` health-checks the whole stack: prerequisites (`kubectl`, `helm`, a container runtime, `gcloud` where the target needs it), cloud resources, Kubernetes state, load-balancer backend health, and per-host DNS + TLS. Checks come from the composition plan's diagnostics, so a portable target is not probed for GCP resources. Failures print a concrete fix command where one exists.

## Deploy state

State (current build, previous build) lives in two places, and the newer wins:

- `.k8s-adapter/state.json` locally (variant-scoped—see [config variants](./configuration.md#config-variants); sharing one state file across deploy targets could repoint one cluster's Services at a build that only ever existed on another).
- A cluster ConfigMap (`<release>-adapter-state`), so state survives the local checkout and multiple operators.

Every successful write bumps a monotonic generation counter, and reads take the newer of the two copies. This ordering matters: unconditionally preferring the ConfigMap once turned a failed-write recovery into a second outage, because the re-run read stale state and patched the active Service selector onto a build already scaled to zero.

State is committed only after cutover—an interrupted deploy leaves the previous build serving.

## See also

- [Targets](./targets.md) — what the composition plan contains
- [CI/CD](./ci-cd.md) — replicating deploy and the cutover without the CLI
- [Verification](./verification.md) — how rollback and cutover are tested
- [SECURITY.md](../SECURITY.md) — image provenance, dispatch-secret lifecycle
