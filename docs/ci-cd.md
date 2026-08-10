# CI/CD without the CLI

The `adapter-k8s` CLI is a convenience wrapper: everything `deploy` does can be reproduced with a container runtime, `helm`, and (on GKE) `gcloud`. This page covers the pieces to carry over into your own pipeline, and the known runtime requirements.

## The pipeline shape

```yaml
# GitHub Actions example
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4

      # 1. Build—the adapter generates .k8s-adapter/output/
      - run: NEXT_ADAPTER_PATH=@next-community/adapter-k8s npx next build

      # 2. Build + push images (any of docker/podman/nerdctl)
      - run: |
          docker build --platform=linux/amd64 -t $REGISTRY/nextjs-app-default:$BUILD_ID \
            .k8s-adapter/output/pools/default
          docker push $REGISTRY/nextjs-app-default:$BUILD_ID
          docker build --platform=linux/amd64 -f .k8s-adapter/output/routing-service/Dockerfile \
            -t $REGISTRY/routing-service:$BUILD_ID \
            .k8s-adapter/output/routing-service
          docker push $REGISTRY/routing-service:$BUILD_ID

      # 3. Deploy
      - run: |
          helm upgrade --install my-app .k8s-adapter/output/chart/ \
            --set global.image.tag=$BUILD_ID \
            --set global.image.registry=$REGISTRY

      # 4. Cut traffic over (see below)
```

The Helm chart is self-contained: it includes the traffic-extension registration Job that attaches the routing-service NEG and registers the ext_proc extension, so `helm upgrade` wires the load balancer for you.

> Rendering the chart in CI instead of hand-assembling this pipeline? `adapter-k8s emit` produces a committable bundle with the digests, CIDRs, and traffic pointer already pinned — see [GitOps](./gitops.md). The cutover and retention steps below still apply to it verbatim (`cutover.mode: none`).

## The NetworkPolicy CIDR guard

A bare `helm template chart/` (or `helm upgrade` without the CLI) exits 1 on the chart's defaults: `global.networkPolicy.strict: true` requires `global.networkPolicy.nodeCidrs`, and the template `{{- fail }}`s without it. This is deliberate — kubelet liveness/readiness probes come from the **node** IP, and a strict allowlist without the node range leaves every pod permanently unready (with Calico, silently). The CLI discovers the ranges from the cluster at deploy time; a manual pipeline must supply them:

```bash
# Escape hatch 1: pass the cluster subnet range(s) explicitly
helm upgrade --install my-app chart/ \
  --set 'global.networkPolicy.nodeCidrs={10.128.0.0/20}'
# (gcloud compute networks subnets describe SUBNET --region REGION --format='value(ipCidrRange)')

# Escape hatch 2: disable the strict posture — deliberately, understanding that the
# routing service then stays reachable from other in-cluster pods
helm upgrade --install my-app chart/ --set global.networkPolicy.strict=false
```

Or set `networkPolicy.nodeCidrs` in adapter config so the ranges are baked into the chart's values at build time — see [static NetworkPolicy ranges](./configuration.md#static-networkpolicy-ranges-adapter-k8s-emit).

## Deploy by digest, resolved from the registry

Deploy images by immutable `@sha256:` digest, not by tag—the pods hold the internal dispatch secret, and a mutable tag lets a retag change what runs on the next restart (see [SECURITY.md](../SECURITY.md#image-provenance)).

Resolve the digest from the registry, never from the local daemon:

```bash
DIGEST=$(gcloud artifacts docker images describe \
  $REGISTRY/nextjs-app-default:$BUILD_ID \
  --format='value(image_summary.digest)')
# deploy $REGISTRY/nextjs-app-default@$DIGEST
```

This is a correctness requirement: podman converts the manifest on push, so its local `RepoDigest` does not match what the registry stores (measured with podman 6.0.1 against Artifact Registry). Deploying the local value yields `ImagePullBackOff`, because kubelet pulls from the registry and the registry is the authority.

## The blue/green cutover

The one step the CLI performs outside Helm is the traffic cutover: each pool has a stable **active Service** whose selector the CLI patches to the new build's pod label after verifying the new pods are serving. Replicate it with:

```bash
kubectl patch service <release>-<pool> --type=json \
  -p '[{"op":"replace","path":"/spec/selector/app.kubernetes.io~1version","value":"<sanitized-build-id>"}]'
```

Before patching, verify each new pod answers `/readyz` directly on the pod (e.g. `kubectl exec`/port-forward), not via load-balancer backend health—`/readyz` is the pod's own verdict and answers 503 until instrumentation registration has succeeded and at least one route module has imported.

The selector flip is atomic, but the load balancer reprograms the standalone NEG asynchronously; expect a few seconds where the LB catches up to the new endpoints.

### Retention: `helm upgrade` deletes your rollback target unless you keep it

The rollback story below assumes the previous build's Deployment still exists at 0 replicas — and a plain `helm upgrade` breaks that assumption. The new build's chart does not contain the previous build's Deployment or HPA, so Helm prunes both during the upgrade unless the **live** objects carry `helm.sh/resource-policy: keep`. The CLI patches that annotation onto the outgoing Deployment and HPA immediately before every upgrade (and later scales the outgoing build to zero instead of deleting it). A manual pipeline must do the same:

```bash
# BEFORE helm upgrade: keep the serving build's workload out of Helm's prune
kubectl annotate deployment <release>-<pool>-<old-build-id> \
  helm.sh/resource-policy=keep --overwrite
kubectl annotate hpa <release>-<pool>-<old-build-id>-hpa \
  helm.sh/resource-policy=keep --overwrite   # repeat per pool

# AFTER the cutover verifies: park the old build instead of deleting it
kubectl scale deployment <release>-<pool>-<old-build-id> --replicas=0
```

Skipping this is a valid choice — it means **single-build rollback semantics**: the only rollback is a full redeploy of the previous build, not a seconds-fast selector flip. Choose it knowingly; do not let `helm upgrade` choose it for you. (The per-build dispatch Secret and routing-manifest snapshot ConfigMap are already rendered with `keep` by the chart itself and survive the upgrade either way. Note `keep` is a Helm semantic — Argo CD's prune does not honor it; see [GitOps](./gitops.md) before pointing a reconciler at the chart.)

To roll back, patch the selector to the previous build's label and scale that Deployment back up (it is kept at 0 replicas). Note that a full rollback also reverts the routing tier to the target build's image and manifest snapshot—the routing pod refuses to start on a manifest that doesn't match its image, so a mismatched pair fails loudly rather than serving another build's route classification. If a routing rollout is stuck after a manual rollback, that mismatch is the usual cause.

## CI service account (GKE)

If your pipeline impersonates a service account, use `<release>-cli`—it holds the Artifact Registry writer and bucket permissions. Do **not** use `<release>-deploy`: `init` revokes push permissions from it on every run, so a pipeline authenticated as it breaks the next time someone runs `init`. See [SECURITY.md](../SECURITY.md#cloud-iam-two-identities-split-by-pod-assumability).

## Container runtimes

All three supported runtimes accept the same verb set (`build`, `push`, `inspect`, `run`, `rm`, `exec`) with identical flags, and all three are validated by deploying the repo's e2e fixture to a live cluster.

| Runtime   | Requires                                                                           |
| --------- | ---------------------------------------------------------------------------------- |
| `docker`  | a reachable daemon                                                                 |
| `podman`  | a reachable daemon                                                                 |
| `nerdctl` | containerd **and** buildkit reachable from your user—containerd alone cannot build |

**Platform pinning.** Always pass `--platform=linux/amd64` or `--platform=linux/arm64` explicitly in a manual image pipeline. With the adapter CLI, set `ADAPTER_K8S_TARGET_PLATFORM` before `next build`; the emitted artifact records it and deploy rejects a different override. Each build publishes one platform, not a multi-architecture index, and its pods are scheduled only on matching nodes. Docker cannot convert native files already produced by `next build`: Sharp is retargeted explicitly, while detectable foreign Prisma engines, ELF/Mach-O/PE binaries, and `.node` addons abort artifact generation. Run dependency installation and `next build` on a matching Linux runner/container when the app has other native dependencies.

**nerdctl notes.** buildkit is a separate daemon from containerd, and a `buildkitd` running as root is not reachable by rootless `nerdctl`—its socket lives at `/run/buildkit/buildkitd.sock` while nerdctl looks under `$XDG_RUNTIME_DIR`. If `nerdctl build` fails:

```bash
containerd-rootless-setuptool.sh install-buildkit-containerd
# on a host without CNI plugins, add: --containerd-worker-net=host
```

`BUILDKIT_HOST` is honoured if you set it.

**Using the CLI in CI anyway.** If you'd rather script the CLI than replicate it, it is CI-friendly: `--yes` skips the unpinned-kubectl-context confirmation, the container runtime is resolved before anything with mutating side effects, and `ADAPTER_K8S_CONTAINER_CLI` forces a specific runtime. `ADAPTER_K8S_CONFIG=<name>` selects a config variant (`adapter.config.<name>.mjs` + matching state file) so one repo can deploy to several clusters without mutating files between jobs. See [config variants](./configuration.md#config-variants).

## See also

- [GitOps](./gitops.md) — `adapter-k8s emit`: rendered, committable bundles for this pipeline's inputs
- [Lifecycle](./lifecycle.md) — what the CLI's deploy/rollback do, in full
- [Configuration](./configuration.md) — container strategy, platforms, variants
- [Targets](./targets.md) — what the chart contains per target
