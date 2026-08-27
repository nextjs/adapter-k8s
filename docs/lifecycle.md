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

### Long-lived requests during cutover

A cutover changes where **new** connections go; it cannot move a live TCP connection or an
in-memory handler from one pod to another. Existing connections remain on the previous pod while,
after the selector change has propagated through the data plane, new connections select the new
build. The previous pod first receives Kubernetes' `preStop` window, then SIGTERM; on SIGTERM it
stops readiness and new work, closes idle keep-alives, and gives active protocols a 60-second
drain window. The pod's 210-second termination grace leaves a 30-second cushion after the
120-second `preStop` and application drain phases.

The terminal behavior is protocol-specific:

- A finite HTTP/RSC stream may use the full application drain window. If it still has not
  completed, the adapter resets it; ending it normally would make a truncated representation look
  complete. The client must retry requests for which that is safe.
- An SSE response may use the full window, then receives a clean EOF so `EventSource` can
  reconnect. Durable continuity remains an application contract: send `id:` fields, resume from
  `Last-Event-ID`, keep replayable events in shared storage, and emit comment heartbeats more
  frequently than every proxy/CDN idle timeout. The adapter does not fabricate events or migrate
  process memory.
- An established WebSocket may use the full window, then receives close code `1001` (going away)
  before bounded forced teardown. Clients should reconnect with jittered backoff and send an
  application cursor/session token when missed state matters. Cross-pod topics and replay require
  shared pub/sub or storage; socket state itself is not transferable.
- A WebSocket **tunnelled to another pool** of the same build is the one qualified case: the pod
  relaying it does not own its framing, so it may only write a close frame where the relayed byte
  stream sits between frames. It checks: an idle tunnel — the ordinary case, and the only one for a
  tunnel that never carried a frame — gets the same clean `1001`. A tunnel caught mid-frame gets
  nothing injected, because a `1001` written there would land inside the payload the frame's header
  already promised. Such a client sees the owning pool's own `1001` relayed only if that pool is
  draining at the same moment (a full-build rollout drains every pool, but a per-pool HPA
  scale-down or single-pod eviction does not), and otherwise an abnormal closure — which is what
  the reconnect guidance above already requires. `tunnelled=` on the drain-complete line counts the
  tunnels that could not be given a `1001`; a persistent non-zero value under scale-down is the
  signal that clients are ending on close code 1006.

For the generic Envoy target, generated application rules disable Envoy's 15-second total route
deadline with `timeouts.request: 0s`; the gateway's stream-idle timeout still detects a connection
that stops making progress. Other exposure layers supplied by an operator need equivalent
streaming and WebSocket behavior. Provider-specific GKE backend draining/timeout policy is not
changed by this portable contract.

This is graceful degradation, not an exactly-once guarantee. An involuntary node loss, process
crash, exhausted grace period, or abrupt load-balancer reset can still break a connection without
EOF/1001. Application-level IDs, idempotency, replay, and reconnect logic are what make those
failures recoverable.

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
