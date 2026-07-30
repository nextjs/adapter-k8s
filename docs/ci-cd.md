# CI/CD without the CLI

The `adapter-k8s` CLI is a convenience wrapper: everything `deploy` does can be reproduced with a container runtime, `helm`, and (on GKE) `gcloud`. This page covers the pieces you need to carry over into your own pipeline, and the runtime gotchas we've hit doing it.

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

## Deploy by digest, resolved from the registry

Deploy images by immutable `@sha256:` digest, not by tag—the pods hold the internal dispatch secret, and a mutable tag lets a retag change what runs on the next restart (see [SECURITY.md](../SECURITY.md#image-provenance)).

Resolve the digest **from the registry**, never from the local daemon:

```bash
DIGEST=$(gcloud artifacts docker images describe \
  $REGISTRY/nextjs-app-default:$BUILD_ID \
  --format='value(image_summary.digest)')
# deploy $REGISTRY/nextjs-app-default@$DIGEST
```

This is a correctness requirement, not a preference: **podman converts the manifest on push, so its local `RepoDigest` does not match what the registry stores** (measured with podman 6.0.1 against Artifact Registry). Deploying the local value yields `ImagePullBackOff`, because kubelet pulls from the registry and the registry is the authority.

## The blue/green cutover

The one step the CLI performs outside Helm is the traffic cutover: each pool has a stable **active Service** whose selector the CLI patches to the new build's pod label after verifying the new pods are serving. Replicate it with:

```bash
kubectl patch service <release>-<pool> --type=json \
  -p '[{"op":"replace","path":"/spec/selector/app.kubernetes.io~1version","value":"<sanitized-build-id>"}]'
```

Before patching, verify each new pod answers `/readyz` **directly on the pod** (e.g. `kubectl exec`/port-forward), not via load-balancer backend health—`/readyz` is the pod's own verdict and answers 503 until instrumentation registration has succeeded and at least one route module has imported.

The selector flip is atomic, but the load balancer reprograms the standalone NEG asynchronously; expect a few seconds where the LB catches up to the new endpoints.

To roll back, patch the selector to the previous build's label and scale that Deployment back up (it is kept at 0 replicas). Note that a full rollback also reverts the routing tier to the target build's image and manifest snapshot—the routing pod refuses to start on a manifest that doesn't match its image, so a mismatched pair fails loudly rather than serving another build's route classification. If a routing rollout is stuck after a manual rollback, that mismatch is the usual cause.

## CI service account (GKE)

If your pipeline impersonates a service account, use `<release>-cli`—it holds the Artifact Registry writer and bucket permissions. Do **not** use `<release>-deploy`: `init` revokes push permissions from it on every run, so a pipeline authenticated as it breaks the next time someone runs `init`. See [SECURITY.md](../SECURITY.md#cloud-iam-two-identities-split-by-pod-assumability).

## Container runtimes

All three supported runtimes accept the same verb set (`build`, `push`, `inspect`, `run`, `rm`, `exec`) with identical flags, and all three are validated by deploying the repo's e2e fixture to a live cluster.

| runtime   | requires |
| --------- | -------- |
| `docker`  | a reachable daemon |
| `podman`  | a reachable daemon |
| `nerdctl` | containerd **and** buildkit reachable from your user—containerd alone cannot build |

**Platform pinning.** Always pass `--platform=linux/amd64` (or your node architecture) explicitly. A host-native build on an ARM runner or Apple Silicon produces arm64 images that fail with `exec format error` on x86 nodes—at rollout, not at build time. For ARM node pools (e.g. GCP T2A), build `linux/arm64` instead.

**nerdctl notes.** buildkit is a separate daemon from containerd, and a `buildkitd` running as root is not reachable by rootless `nerdctl`—its socket lives at `/run/buildkit/buildkitd.sock` while nerdctl looks under `$XDG_RUNTIME_DIR`. If `nerdctl build` fails:

```bash
containerd-rootless-setuptool.sh install-buildkit-containerd
# on a host without CNI plugins, add: --containerd-worker-net=host
```

`BUILDKIT_HOST` is honoured if you set it.

**Using the CLI in CI anyway.** If you'd rather script the CLI than replicate it, it is CI-friendly: `--yes` skips the unpinned-kubectl-context confirmation, runtime resolution happens in preflight before anything with side effects, and `ADAPTER_K8S_CONTAINER_CLI` forces a specific runtime. `ADAPTER_K8S_CONFIG=<name>` selects a config variant (`adapter.config.<name>.mjs` + matching state file) so one repo can deploy to several clusters without mutating files between jobs.
