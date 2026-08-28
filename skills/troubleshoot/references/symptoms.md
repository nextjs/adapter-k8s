# Symptom Branches

Each branch assumes `npx adapter-k8s doctor` has already run. Commands use `<release>` and `<ns>` for the release name and namespace from `.k8s-adapter/infrastructure.json`.

## CrashLoopBackOff

Doctor signature: `Pod logs: FAIL — Fatal error in <pod>: …` with `Cannot find module`. FAIL is reserved for fatal signatures (`FATAL`, `Cannot find module`); ordinary error-level lines only WARN as "likely transient app errors".

**Missing adapter runtime bundle.** The Dockerfile `CMD`s a bundle that was never staged — a partial `npm run build` in the adapter package, a renamed esbuild output, or a botched install. The image builds and pushes cleanly, then CrashLoopBackOffs with `Cannot find module`. Current adapter versions throw at build time instead (`Missing adapter runtime bundle: …`); if you see the runtime form, the image predates that guard.

```bash
kubectl logs <pod> -n <ns> --tail=50
# Fix: rebuild the adapter package (or reinstall @next-community/adapter-k8s),
# then a full `npx adapter-k8s deploy` without --skip-build
```

**Routing pod refusing to start** is a different, deliberate crash — see § Routing manifest vs build.

## Image pull and platform

**ImagePullBackOff — digest not in registry.** Digest resolution is registry-first because podman rewrites manifests on push: the local digest can differ from what the registry stored, and deploying the local value yields ImagePullBackOff (observed live: podman said `e04a0a5b…`, the registry held `27fa476b…`). Deploy resolves from the registry; `--allow-mutable-tags` deploys unresolved images by tag instead and is not recommended.

**ImagePullBackOff — 403 against Artifact Registry.** Two known causes:

1. A failed registry-reader IAM grant during `init` (init now warns: "Pods may fail with ImagePullBackOff"). Re-run `npx adapter-k8s init` or grant the node service account Artifact Registry Reader.
2. A chart built for a different target: the registry is baked into the Deployment template at build time, so reusing output across targets pulls the wrong registry (measured: a Scaleway deploy reusing a GKE chart pulled `us-central1-docker.pkg.dev/...` with a 403). Deploy now refuses before helm on a registry/namespace mismatch — obey the error and re-run without `--skip-build`.

**Wrong platform (`Pending`/`FailedScheduling` or `exec format error`).** The build platform defaults to `linux/amd64` on every host — including Apple Silicon. The chart stamps a `kubernetes.io/arch` node selector from that platform, so the usual symptom of a mismatch is pods stuck **Pending** with `node(s) didn't match Pod's node affinity/selector` (an amd64-default build against arm64 nodes: Apple Silicon k3d/kind, Graviton, GKE T2A). `exec format error` only appears when the selector is absent or hand-edited. Sharp's native packages and the node selector are fixed at build time; `ADAPTER_K8S_TARGET_PLATFORM` must match the built artifact, and deploy throws if it does not. Check node arch (`kubectl get nodes -o jsonpath='{.items[*].status.nodeInfo.architecture}'`), then rebuild with the matching `ADAPTER_K8S_TARGET_PLATFORM` (no `--skip-build`). The adapter does not publish a multi-arch index — one platform per build.

## Routing manifest vs build

Signature: routing pods crash with `Routing manifest mismatch: … does not match the manifest this image was built with`, or doctor WARNs `Rollback ready … routing manifest was NOT retained`.

The routing image bakes its own manifest at `BAKED_CONFIG_DIR` and refuses to serve a mounted manifest whose canonical SHA-256 differs — the manifest decides whether the "middleware already evaluated" verdict is stamped, so a mismatched one may not serve. Causes:

- **Rollback that reverted the ConfigMap without the image** (or vice versa). `npx adapter-k8s rollback` does both together; a hand-rolled `kubectl` rollback does not. Fix: run the real rollback, or redeploy.
- **ConfigMap edited out of band.** Redeploy to restore the build's manifest.
- **Unretained manifest.** A deploy run with `--allow-unretained-manifest` could not snapshot the outgoing build's manifest; doctor records it and rollback to that build is image-only (the edge keeps the current build's manifest — expect stale routing for the rolled-back build). Deploy twice to regain a full rollback target.

404s on routes that exist usually mean the edge is serving a different build's manifest than the pool is running — check `Current build` in doctor against the image tag in `kubectl get deploy <release>-routing-service -n <ns> -o jsonpath='{.spec.template.spec.containers[0].image}'`.

## Middleware / ext_proc

Test first: probe for an effect YOUR middleware produces (a header it sets, a rewrite, a redirect) — e.g. `curl -sI https://<host>/ | grep -i <your-middleware-header>`. The repo's e2e fixture stamps `x-mw-executed`; a user app has whatever its own middleware does. Effect present = middleware ran at the edge.

**GKE (traffic extension).** Doctor branches:

- `ext_proc traffic extension: FAIL — not registered`: the edge middleware is not wired at all. `npx adapter-k8s deploy` re-runs the registration Job.
- `covers N/M forwarding rules`: `http://` requests on uncovered rules bypass middleware (auth/rewrites). Same fix — redeploy re-attaches every rule.
- `routing backend scheme: FAIL — <scheme>`: the traffic extension requires `EXTERNAL_MANAGED`. Delete `<release>-routing-service` (backend service) and re-run init + deploy, per the printed fix.
- `routing backend NEG: FAIL — no NEG attached`: the ext_proc callout has no backend; redeploy.
- `routing health check: WARN — <type>`: must be TCP. A gRPC check passes plaintext against the TLS ext_proc server while the callout still fails — the failure mode that hid for months. Delete `<release>-routing-hc` and re-run init.

**Generic provider (EnvoyExtensionPolicy).** Deploy itself gates the cutover: it polls the policy until `Accepted=True` for the current generation and aborts otherwise. If it reported `not Accepted`:

```bash
kubectl describe envoyextensionpolicy <release>-routing-extproc -n <ns>
```

Common causes, verbatim from the deploy error: the GatewayClass controller is not Envoy Gateway (an EnvoyExtensionPolicy only applies to one — a non-Envoy class programs the Gateway and then silently never calls the routing service), or the Gateway it targets does not exist.

**Fail-closed is expected.** With the routing service scaled to zero, requests return 500 rather than serving with middleware skipped (`routingService.failureMode: "auto"` fails closed whenever the app has middleware). A wall of 500s with healthy pools means the routing tier is down, not the app.

**Every request 500s (`ext_proc_error_gRPC_error_14`) with incomplete `ingressSources`.** Observed live on Envoy Gateway 1.8.3: a hand-written podSelector admitted only the `gateway.envoyproxy.io/owning-gatewayclass` label. Non-merged Envoy proxy pods carry the `owning-gateway-name`/`owning-gateway-namespace` pair and **not** the class label (identical in Envoy Gateway 1.5.5 and 1.8.3 — the class label is applied only under `mergeGateways`), so strict NetworkPolicy blocked Envoy→ext_proc — fail-closed 500 on every request, plus 503 on Envoy→pool. Legacy `provider.generic` config emits both selector sets by default. A composed `gatewayApiExposure` needs them in its explicit `ingressSources`. Add the per-gateway pair (`owning-gateway-name: <release>-gateway`, `owning-gateway-namespace: <ns>`) alongside the merged GatewayClass selector; legacy-provider users can instead delete their override to restore its default.

```bash
kubectl get pods -n envoy-gateway-system --show-labels | grep owning-gateway
kubectl get networkpolicy -n <ns> -o yaml | grep -A6 podSelector
```

**Envoy Gateway controller CrashLoopBackOff right after a 1.5.x → 1.8.x helm upgrade.** Controller log: `no matches for kind "ListenerSet" in version "gateway.networking.k8s.io/v1"`. Envoy Gateway ≥ 1.8 unconditionally watches ListenerSet, but `helm upgrade` never touches the chart's `crds/` subchart, so an in-place upgrade leaves the old CRDs behind. Doctor surfaces this as the `ListenerSet CRD` line when the controller is ≥ 1.8. Fix (verified live — server-side apply over live CRDs, no data loss, traffic served throughout):

```bash
helm pull oci://docker.io/envoyproxy/gateway-helm --version v1.8.3 --untar
kubectl apply --server-side --force-conflicts -f gateway-helm/charts/crds/crds/gatewayapi-crds.yaml
kubectl apply --server-side --force-conflicts -f gateway-helm/charts/crds/crds/generated/
kubectl delete pod -n envoy-gateway-system -l control-plane=envoy-gateway   # restart the crashlooping controller
```

## Service selector drain (503 while everything looks green)

Doctor signature: `Active Service endpoints: <svc>: FAIL — 0 ready endpoints — selector matches no ready pods (origin will 503)`.

The blue/green cutover flips each active Service's `app.kubernetes.io/version` selector to the new build. If that value does not exactly match the pod label, the Deployment still reports N/N ready but the Service drains to zero endpoints, its NEG empties, and the LB returns 503 `failed_to_connect_to_backend` for every origin request — only CDN cache hits survive.

```bash
kubectl get svc <svc> -n <ns> -o jsonpath='{.spec.selector}'
kubectl get pods -n <ns> -l app.kubernetes.io/name=<release> --show-labels
# The version selector must equal a running pod's app.kubernetes.io/version label.
# Fix: `npx adapter-k8s deploy` (or `rollback`) to re-patch the Service — never edit selectors by hand.
```

## Shared cache

Symptom: `revalidateTag`/`revalidatePath` works on the pod that ran it but other replicas serve stale; PPR shells / ISR pages never regenerate cross-replica; Valkey shows zero writes.

Check in order:

1. **Cache enabled at all?** `adapter.config.mjs` needs `cache: { enabled: true, provider: 'valkey' }`. Without it each pod uses Next's local file-system cache — per-replica by definition.
2. **Custom `cacheHandler` collision.** Build log line: `cache.enabled but next.config already sets cacheHandler — keeping yours`. Your handler owns the incremental cache; the adapter's shared store is skipped. Remove your `cacheHandler` for cross-replica ISR/PPR-shell revalidation.
3. **VALKEY_URL reaching the pods?** The bundled handler falls back to the file-system cache silently when `VALKEY_URL` is absent. `kubectl exec` into a pool pod and check `env | grep VALKEY`. Managed Memorystore provisioning requires `projectId` in `infrastructure.json`; BYO uses `cache.url`.
4. **Old adapter build.** Historical versions silently skipped cache-handler registration for edge-middleware apps and for missing bundles while `build-metadata.json` still claimed `cacheEnabled: true`. Rebuild on a current adapter version — the modern build throws instead of skipping.

Cache AUTH warnings on deploy (`accepts UNAUTHENTICATED connections`) are a security posture issue, not a sharing failure — see `cache.memorystore.auth` in the shipped `dist/types.d.ts`.

## NetworkPolicy

Some CNIs accept NetworkPolicy objects and ignore them, which makes the in-cluster h2c posture decorative. Verify enforcement, not acceptance:

```bash
# From a pool pod, the routing tier's ext_proc port (carries the dispatch secret) must be unreachable:
kubectl exec -n <ns> deploy/<pool-deployment> -- node -e \
  'require("net").connect(8443,"<release>-routing-service").on("error",e=>{console.log(e.code);process.exit(0)}).on("connect",()=>{console.log("REACHABLE — policy NOT enforced");process.exit(1)})'
# Expected: ECONNREFUSED (k3s) or a timeout (Cilium). "REACHABLE" = your CNI does not enforce policy.
```

If unenforced: install/enable a policy-enforcing CNI (Cilium, Calico; GKE Standard needs `--enable-network-policy` — Autopilot enforces by default). `--allow-no-network-policy` is the deploy-time opt-out that can leave the routing service reachable from any in-cluster pod; deploy records and warns about it. On the generic provider, nodes added after deploy are missing from the kubelet allowlist (discovery snapshots node addresses at deploy time) — pods scheduled there never become ready until you set `nodeCidrs` in the generic provider config and redeploy.
