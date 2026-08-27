# Failure Playbook

Every deploy gate aborts BEFORE the pool cutover. On failure the CLI restores the ext_proc edge (routing manifest + routing image) to the previous build and prints edge status lines — read them: they say whether the edge revert itself succeeded. The previous build's pools never stopped serving, so the recovery move is almost always diagnose + re-run `npx adapter-k8s deploy`, not `rollback`.

## Gate-by-Gate Diagnosis

| Failure message                                                    | What it means                                                                                                                                                                                                                                                                                                                                                                         | Do this                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment <name> did not finish rolling out within <n>s`         | New pool pods never became Ready (image pull, crash loop, scheduling). `<n>` is 600s: pool Deployments are created fresh per build, so their pods come up in parallel and the budget is one pathological pod boot (150s startupProbe + readiness window + `minReadySeconds`) with headroom for the kubelet's serialized image pulls                                                   | `kubectl logs deployment/<name> -n <ns> --tail=40`; `kubectl describe pod` for pull/scheduling events; fix, re-run deploy. Pods **Pending** with `didn't match Pod's node affinity/selector` on every node = platform mismatch — the chart stamps `kubernetes.io/arch` from the build's target platform (default `linux/amd64`); rebuild with `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` for arm64 nodes |
| `Routing service (...) did not become healthy within <n>s`         | The ext_proc edge image cannot roll out — a broken routing image would otherwise serve stale edge code silently. `<n>` is DERIVED from the routing tier's own live replica count x 285s (ready + `minReadySeconds` + the kubelet's 210s termination grace), floored at 600s and capped at 1800s: this is the one Deployment helm patches in place, so it surges one replica at a time | `kubectl logs -l app.kubernetes.io/component=routing-service -n <ns> --tail=40`                                                                                                                                                                                                                                                                                                                         |
| `ext_proc registration job (...) did not complete` (GKE)           | The load-balancer traffic-extension Job failed; middleware may not be wired                                                                                                                                                                                                                                                                                                           | `kubectl logs job/<release>-route-ext-<digest> -n <ns>` (the exact job name is printed in the error)                                                                                                                                                                                                                                                                                                    |
| `EnvoyExtensionPolicy (...) is not Accepted` (generic)             | Envoy Gateway rejected or never observed the policy                                                                                                                                                                                                                                                                                                                                   | `kubectl describe envoyextensionpolicy <release>-routing-extproc -n <ns>`. Common causes: the GatewayClass controller is not Envoy Gateway, or the target Gateway does not exist                                                                                                                                                                                                                        |
| `Composition-plan readiness failed`                                | A target-contributed resource never reached its readiness condition                                                                                                                                                                                                                                                                                                                   | Run `npx adapter-k8s doctor` — it evaluates the same plan readiness checks with per-resource detail                                                                                                                                                                                                                                                                                                     |
| `DEPLOY FAILED: New build did not become healthy within 2 minutes` | Pods exist but `/readyz` never went 200, or the capacity gate fell short                                                                                                                                                                                                                                                                                                              | See below                                                                                                                                                                                                                                                                                                                                                                                               |

## The 2-Minute Health Gate

The gate requires, per pool, at least as many Ready pods as the OUTGOING build was live-serving (floor of 1 for new pools). On failure the CLI prints:

- Per-pod phase, and the `/readyz` body — the body's `reason` field is the answer ("instrumentation register() failed", "route module /x failed to load").
- `Capacity gate: ... <pool>: 2/6 ready` — this is not "pods are broken", it is "not ENOUGH pods yet". Usually cluster capacity or slow image pulls; check `kubectl get events -n <ns>` for scheduling pressure.
- Error lines grepped from pod logs.

Then: `npx adapter-k8s doctor` and `npx adapter-k8s tail`.

Generic-target special case: pods that never become Ready on a node that joined the cluster AFTER the last deploy usually mean the strict NetworkPolicy's kubelet allowlist snapshot is stale — set `nodeCidrs` (the node subnet, e.g. `["10.0.0.0/16"]`) in the generic provider config and redeploy.

## When to Rollback

Rollback is for a build that PASSED every gate, cut over, and then turned out bad under real traffic (wrong behavior, runtime errors, bad release content).

```bash
npx adapter-k8s rollback        # scales the previous build up, reverts the routing
                                # tier's image and manifest, patches selectors back
```

- It is symmetric: running it again rolls forward. The CLI prints `✓ Rollback complete. Now serving build: <id>`.
- Do NOT rollback after a failed deploy — nothing was cut over; the previous build is already serving.
- The routing tier's rollback image is reconstructed from the build tag (not digest-pinned yet); `deploy` records digests so later rollbacks can pin.
- If deploy warned `--allow-unretained-manifest` was used, rollback to that build is image-only (its routing manifest snapshot was not retained).

## Why Never `helm rollback`

Helm revisions are snapshots of what `helm upgrade` applied — captured BEFORE the adapter's verified Service-selector cutover and before deploy state was committed. A raw `helm rollback`:

- Does not restore adapter deploy state, the routing manifest ConfigMap lineage, pool capacity, or CDN invalidation state.
- Can restore a PRE-cutover stable Service selector, pointing traffic at a build that never took traffic (or at zero pods).
- On Helm 4 can conflict with HPA-owned Deployment replicas; `--force-conflicts` silences the conflict without making the result safe.

The routing pod refuses to start on a manifest that does not match its own image — a mismatched Helm-level revert can therefore crash-loop the edge. `npx adapter-k8s rollback` is the only path that reverts image, manifest, capacity, and selectors together.

## Escape-Hatch Flags

Each trades a safety property for deployability. Use deliberately, never as a default.

| Flag                          | Skips                                                               | Cost                                                                                       |
| ----------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `--allow-no-network-policy`   | Abort when the cluster pod CIDR cannot be discovered                | Ships without the strict ingress NetworkPolicy posture                                     |
| `--allow-mutable-tags`        | Abort when no registry digest can be resolved                       | Deploys by tag; NetworkPolicies skipped — routing service reachable from in-cluster pods   |
| `--allow-unretained-manifest` | Abort when the outgoing build's routing manifest cannot be retained | Rollback to the outgoing build becomes image-only (recorded in state; `doctor` reports it) |
| `--yes` / `-y`                | The unpinned-kubectl-context confirmation                           | You own verifying the context targets the intended cluster (CI)                            |

## Local Reproduction

`npx adapter-k8s emulate` runs the production request path (Envoy → routing service → pool server) on one machine — use it to separate "my app/middleware is broken" from "my cluster is broken" before burning deploy cycles. It runs `next build` itself (pass `--skip-build` to reuse a prior adapter-wired build); `--port` changes the local Envoy listener (default 8080).
