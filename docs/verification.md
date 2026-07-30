# What is verified, and how

The README's status claim—framework compatibility strongly validated, hardening pending—rests on the verification described here. It is organized by layer, and for each layer we state not just what it covers but what it structurally *cannot*—the gaps are as load-bearing as the coverage.

<!-- TODO: link upstream-published conformance results here once Next.js publishes them. -->

## The layers

### 1. Unit suite—2,168 tests

Covers the adapter, both runtime tiers (pool server and routing service), the CLI, and the emitted templates. Several template tests render through **real `helm`**, because the question being asked is what helm does with the file, not what the file contains.

**Cannot see:** anything about a live cluster, load balancer, or CDN. Template tests prove the chart renders and carries the intended values; they cannot prove GKE programs it.

### 2. Upstream Next.js e2e suite—3,439 passing / 2 failing

The upstream suite runs against the pool server. This is the strongest evidence that handler
invocation via `import()` is faithful to `next start` semantics across the framework's surface
area—1,082 suites, run in the adapter deploy mode upstream uses for conformance.

```text
Next.js:        v16.3.0-canary.97 (367e5215)
adapter-k8s:    db4bd0c
run date:       2026-07-29
result:         3,439 passed / 2 failed / 1,082 suites
reproduce:      NEXT_TEST_CONCURRENCY=4 bash scripts/e2e-local.sh "" v16.3.0-canary.97
```

**The two failures**, named rather than waved at as "known flakes":

| Suite | Test | Symptom |
| --- | --- | --- |
| `i18n-support-same-page-hash-change` | should update props on locale change with same hash | expected `"en"`, received `"fr"` |
| `rewrites-manual-href-as` | should allow manual href/as on index page | `toBeTruthy()` received `false` |

Both are client-side navigation timing races that reproduce intermittently and are unaffected by
adapter code paths—the assertions read DOM state after a client transition, with no request
reaching the pool server. Neither has been root-caused upstream, so treat them as *unexplained
but consistently isolated to these two suites* rather than as proven-external. If either ever
fails differently, that is a signal worth chasing.

**Cannot see:** the edge. The harness starts the **pool only**—no Envoy, no ext_proc—so it
validates local route resolution (the fail-safe tier that runs when dispatch headers are absent),
not the routing service that classifies requests in production. It also says nothing about
behaviour under load: it is a functional suite run at concurrency 4.

### 3. `adapter-k8s emulate`—the ext_proc path locally

Envoy → routing service → pool server, wired the way GKE wires it, on one machine. Verified by hand against the e2e fixture: all routes serve, `x-mw-executed` confirms middleware ran at the edge, RSC negotiation returns a flight payload, and the internal dispatch headers do not leak to the client.

There is also a **full upstream suite against this topology** (`test-e2e-integration.yml`, which starts Envoy + routing service + pool and points the harness at Envoy rather than the pool). It does **not currently complete**: its deploy script had drifted behind the pool-only one and, after repair, the stack does not survive between deploy and test. So the honest position is that `emulate` is the only ext_proc coverage that presently works, and it is manual.

**Cannot see:** the real load balancer, CEL match-condition evaluation as GCP performs it, Cloud CDN interaction, or NetworkPolicy enforcement.

### 4. Live deployments

The layer that finds what the others structurally cannot.

- **GKE**: a live deployment exercises deploy → rollback → roll-forward under a 26-check suite covering the full request path, CDN behavior, and cutover mechanics. Illustrative of why this layer exists: a recent run caught a rollback that named a manifest snapshot after the wrong build—surfaced only because the routing pod refuses to start on a manifest that does not match its own image. No lower layer runs a real rollback against a real routing rollout.
- **Generic provider**: live deploys to k3s (k3d, k3s v1.30.6) and a Scaleway managed cluster—3× **arm64** nodes, **Cilium**, Kubernetes v1.36.1, Envoy Gateway v1.5.4—using the routing-service image unchanged from the GKE build. On both, the public request path returned `200 / 200 / 200 / 404` for `/`, `/ssr`, `/api/hello`, `/nope` with `x-mw-executed` present, proving middleware ran **at the edge** through `EnvoyExtensionPolicy` rather than in the pool. Two properties can only be checked here:
  - **NetworkPolicy is enforced, not merely accepted.** A pool pod attempting `routing-service:8443`—the port whose ext_proc reply carries the internal dispatch secret—was refused on both clusters (`ECONNREFUSED` on k3s, timeout on Cilium). Some CNIs accept policy objects and ignore them, which would make the whole in-cluster h2c posture decorative.
  - **Fail-closed is real.** With the routing service scaled to zero, requests returned 500 rather than being delivered with middleware silently skipped.
- **Cross-platform builds**: the Scaleway nodes are arm64 while the build host is x86, so that deployment also exercises `ADAPTER_K8S_TARGET_PLATFORM` and the multi-arch digest selection. The default (`linux/amd64`) would have produced images that CrashLoop with `exec format error`.
- **Container runtimes**: docker, podman, and nerdctl are each validated by deploying the repo's e2e fixture to a live GKE cluster, not just by unit tests. This layer is why the digest resolution is registry-first: podman rewrites manifests on push, so its *local* digest can differ from what the registry stored, and deploying that value yields `ImagePullBackOff`.

## Semantics verified end-to-end

The specific behaviors the architecture exists to get right, each confirmed against live multi-replica infrastructure:

| Behavior | Verified |
| --- | --- |
| Middleware runs for every non-cached request, at the edge, with no edge compute platform | GKE (traffic extension) and generic (EnvoyExtensionPolicy) |
| `use cache` entries shared across replicas | Live, multi-pod |
| `revalidateTag` / `revalidatePath` on one pod seen by all | Live, multi-pod—including regeneration of a baked PPR shell and an ISR page |
| PPR: static shell served, dynamic holes resumed pool-native, tail never CDN-cached | Live, behind Cloud CDN |
| Cross-deploy CDN correctness: a new build never serves the previous build's stale same-URL content | Live, via per-build cache-tag invalidation on cutover |
| Blue/green cutover and symmetric rollback, including the routing tier | Live, GKE |

## Known coverage gaps

Stated plainly, because a reviewer will find them anyway:

- **The ext_proc path has no *working* automated coverage.** `emulate` covers it but is run by hand; the upstream-suite-through-Envoy workflow exists and does not currently pass (see layer 3). The live suites exercise the real edge, but against real infrastructure rather than in CI on every commit.
- **Performance is unverified.** No load testing, no throughput tuning, no published benchmarks. This is the "operational hardening" the README's status refers to—the claim here is correctness, not capacity.
- **The generic provider is younger** than the GKE one and has correspondingly less real-world exposure, though it passes the same unit suite and its live verification covered the full request path.

## Reproducing

- Unit suite: `npm test`
- Upstream Next.js e2e (pool topology): `NEXT_TEST_CONCURRENCY=4 bash scripts/e2e-local.sh "" v16.3.0-canary.97`—expect ~17 minutes
- ext_proc path locally: `npx adapter-k8s emulate` in `fixtures/main`
- Live suite: `E2E_BASE_URL=https://<host> npm run test:e2e:live` against a deployed release
