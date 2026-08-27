# What is verified, and how

The README's status claim—framework compatibility verified, hardening pending—rests on the verification described here. It is organized by layer; each layer states what it covers and what it structurally _cannot_.

## The layers

### 1. Unit suite—2,620 tests

Covers the adapter, both runtime tiers (pool server and routing service), the CLI, and the emitted templates. Several template tests render through **real `helm`**, because the question being asked is what helm does with the file, not what the file contains.

**Cannot see:** anything about a live cluster, load balancer, or CDN. Template tests prove the chart renders and carries the intended values; they cannot prove GKE programs it.

### 2. Upstream Next.js e2e suite—two topologies

The upstream conformance suite (1,082 suites, run in the adapter deploy mode upstream uses)
runs against this adapter in two configurations.

**Pool topology** — the harness starts the pool server only. This is the strongest evidence
that handler invocation via `import()` is faithful to `next start` semantics across the
framework's surface area:

```text
Next.js:        v16.3.0-canary.97 (367e5215)
adapter-k8s:    db4bd0c
run date:       2026-07-29
result:         3,439 passed / 2 failed / 1,082 suites
reproduce:      NEXT_TEST_CONCURRENCY=4 bash scripts/e2e-local.sh "" v16.3.0-canary.97
```

The two pool-topology failures are client-side navigation timing races
(`i18n-support-same-page-hash-change`, `rewrites-manual-href-as`) whose assertions read DOM
state after a client transition with no request reaching the pool; both reproduce at similar
rates against vanilla `next start`.

**Full cluster topology** — the same suite through the production request path: Envoy
Gateway → ext_proc routing service → pool, with a shared Valkey incremental cache, deployed
to a local k3d cluster per suite. This is the configuration the pool-only harness
structurally cannot see, and it now runs the entire suite:

```text
Next.js:        v16.3.0-canary.97 (367e5215)
run date:       2026-08-04
result:         ~4,438 passed / 27 failed / 1,082 suites
reproduce:      bash scripts/e2e-lanes.sh 6 24   — ~3-4.5h, 6 concurrent lanes
```

The pass count is approximate because intermittent client-navigation timing races shift a
handful of results between runs (see the "Timing races" group below); the failure set above
is from the recorded run.

**The 27 failures:**

| Group                                                                                                                                          | Count | Status                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server-action suites (`app-action` 5, `app-action-node-middleware` 5, `action-forward-loop` 1)                                                 | 11    | The action machinery itself is verified live (browser and curl); these failures are tied to deploy-harness conditions and remain under investigation |
| Timing races (`cached-navigations` 2, `prerender` 2, `vary-params-base-dynamic`, `catch-error`, `catch-error-react-compiler`, `client-params`) | 8     | Client-navigation waits that reproduce intermittently; rates and membership vary with host load                                                      |
| PPR resume-data consistency (`resume-data-cache`)                                                                                              | 1     | After a tag revalidation, a regenerated page can retain the previous fetch-cache value in its resume data; under investigation                       |
| `cache-components-prerender-matrix`                                                                                                            | 3     | The `partialFallback` on-demand shell-specialization contract, which this adapter deliberately does not yet implement                                |
| Singletons (`metadata-navigation`, `no-duplicate-headers-middleware`, `non-ascii-cache-tags`, `cache-components-allow-otel-spans`)             | 4     | One test each; `no-duplicate-headers-middleware` is a documented, deliberate divergence                                                              |

**Cannot see:** the real load balancer, CEL match-condition evaluation as GCP performs it,
Cloud CDN interaction, or behaviour under load—both topologies are functional suites, not
load tests.

### 3. `adapter-k8s emulate`—the ext_proc path locally

Envoy → routing service → pool server, wired the way GKE wires it, on one machine. Verified by hand against the e2e fixture: all routes serve, `x-mw-executed` confirms middleware ran at the edge, RSC negotiation returns a flight payload, and the internal dispatch headers do not leak to the client.

`emulate` is the quick local way to inspect this path by hand; for automated coverage of
the same topology, the full upstream suite runs against a real cluster (layer 2, cluster
topology).

**Cannot see:** the real load balancer, CEL match-condition evaluation as GCP performs it, Cloud CDN interaction, or NetworkPolicy enforcement.

### 4. Live deployments

The layer that finds what the others structurally cannot.

- **GKE**: a live deployment exercises deploy → rollback → roll-forward under a 26-check suite covering the full request path, CDN behavior, and cutover mechanics. Illustrative of why this layer exists: a recent run caught a rollback that named a manifest snapshot after the wrong build—surfaced only because the routing pod refuses to start on a manifest that does not match its own image. No lower layer runs a real rollback against a real routing rollout.
- **Generic provider**: live deploys to k3s (k3d, k3s v1.30.6) and a Scaleway managed cluster—3× **arm64** nodes, **Cilium**, Kubernetes v1.36.1, Envoy Gateway v1.5.4—using the routing-service image unchanged from the GKE build. On both, the public request path returned `200 / 200 / 200 / 404` for `/`, `/ssr`, `/api/hello`, `/nope` with `x-mw-executed` present, proving middleware ran **at the edge** through `EnvoyExtensionPolicy` rather than in the pool. Two properties can only be checked here:
  - **NetworkPolicy is enforced, not merely accepted.** A pool pod attempting `routing-service:8443`—the port whose ext_proc reply carries the internal dispatch secret—was refused on both clusters (`ECONNREFUSED` on k3s, timeout on Cilium). Some CNIs accept policy objects and ignore them, which would make the whole in-cluster h2c posture decorative.
  - **Fail-closed is real.** With the routing service scaled to zero, requests returned 500 rather than being delivered with middleware silently skipped.
- **Cross-platform builds**: the Scaleway nodes are arm64 while the build host is x86, so that deployment also exercises `ADAPTER_K8S_TARGET_PLATFORM`, arm64 native-package staging, and digest pinning of the single-platform image. The adapter does not publish a multi-architecture image index.
- **Container runtimes**: docker, podman, and nerdctl are each validated by deploying the repo's e2e fixture to a live GKE cluster, not just by unit tests. This layer is why the digest resolution is registry-first: podman rewrites manifests on push, so its _local_ digest can differ from what the registry stored, and deploying that value yields `ImagePullBackOff`.

## Semantics verified end-to-end

The specific behaviors the architecture exists to get right, each confirmed against live multi-replica infrastructure:

| Behavior                                                                                           | Verified                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Middleware runs for every non-cached request, at the edge, with no edge compute platform           | GKE (traffic extension) and generic (EnvoyExtensionPolicy)                  |
| `use cache` entries shared across replicas                                                         | Live, multi-pod                                                             |
| `revalidateTag` / `revalidatePath` on one pod seen by all                                          | Live, multi-pod—including regeneration of a baked PPR shell and an ISR page |
| PPR: static shell served, dynamic holes resumed pool-native, tail never CDN-cached                 | Live, behind Cloud CDN                                                      |
| Cross-deploy CDN correctness: a new build never serves the previous build's stale same-URL content | Live, via per-build cache-tag invalidation on cutover                       |
| Blue/green cutover and symmetric rollback, including the routing tier                              | Live, GKE                                                                   |

## Known coverage gaps

- **Full-topology runs are operator-initiated, not per-commit CI.** The cluster-topology
  suite (layer 2) covers the ext_proc path end to end, but it runs on a local k3d cluster
  when a maintainer launches it—hours, not minutes—so individual commits are gated by the
  unit suite and a ~35-minute smoke subset (`scripts/e2e-smoke.sh`), with full runs between
  batches.
- **27 upstream tests fail in the full topology** (0.6% of the suite; see the table in
  layer 2). About a third are intermittent timing races; the substantive remainder are the
  server-action harness conditions, the unimplemented `partialFallback` contract, and one
  remaining PPR resume-data consistency case.
- **Performance is unverified.** No load testing, no throughput tuning, no published benchmarks. This is the "operational hardening" the README's status refers to.
- **The generic provider is younger** than the GKE one and has correspondingly less real-world exposure, though it passes the same unit suite and its live verification covered the full request path.
- **Portable rollout continuity is data-plane tested, not yet cluster-rollout verified.** A
  Docker-gated suite runs real Envoy in front of an old/new pool selector. It differentially
  verifies disabled total route timeouts, an old-build finite stream completing through cutover,
  SSE ending cleanly and resuming from `Last-Event-ID` on the new build, and WebSocket `1001`
  followed by a new-build reconnect. It does not replace a live Kubernetes EndpointSlice,
  controller, or involuntary node-loss test.
- **WebSocket Route Handlers are transport-tested, not yet framework-e2e verified.** The pool has
  real-socket coverage for generated `upgradeHandler` dispatch, trusted and local routing,
  cross-pool tunnelling, repeated handshake headers, bounded shutdown, and the portable rollout
  path above. The public
  `NextResponse.upgrade()` API and its upstream e2e fixture are still experimental/unpublished;
  that suite must pass against the exact Next branch before this support is called framework
  verified.

## Reproducing

- Unit suite: `npm test`
- Upstream Next.js e2e (pool topology): `NEXT_TEST_CONCURRENCY=4 bash scripts/e2e-local.sh "" v16.3.0-canary.97`—expect ~17 minutes
- Upstream Next.js e2e (full cluster topology): `bash scripts/e2e-k3d-bootstrap.sh` once, then `bash scripts/e2e-lanes.sh 6 24`—expect 3–4.5 hours; `bash scripts/e2e-smoke.sh` runs the ~32-suite sensitive subset in ~35 minutes
- ext_proc path locally: `npx adapter-k8s emulate` in `fixtures/main`
- Live suite: `E2E_BASE_URL=https://<host> npm run test:e2e:live` against a deployed release
- Edge tier actually in use: add `E2E_ASSERT_EDGE_DISPATCH=1` to the live suite. It asserts the middleware that produced a response ran in the ext_proc tier — i.e. the pool VERIFIED the per-request dispatch proof rather than failing safe to local re-resolution, which is correct but silent and would otherwise leave the edge tier doing nothing but adding a hop. Requires a deployment built from the current `fixtures/main`

## See also

- [Targets](./targets.md) — the topologies these layers verify
- [Lifecycle](./lifecycle.md) — the cutover and rollback mechanics under test
- [CI/CD](./ci-cd.md) — running deploys from your own pipeline
