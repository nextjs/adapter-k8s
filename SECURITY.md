# Security

This document describes the security model of the infrastructure the adapter generates: what is hardened by default, what the trust boundaries actually are, and where the known limits sit. The short version lives in the README; this is the full reasoning.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository rather than opening a public issue. We'll acknowledge within a few days. The project is experimental and pre-1.0; there is no bug bounty.

## Threat model in one paragraph

The sensitive asset is the **internal dispatch secret**. The routing service resolves each request (runs middleware, classifies the route) and communicates its verdict to the pool servers via headers authenticated with this secret. Anything that holds the secret can hand a pool a forged, pre-trusted verdict — including "middleware already ran" — and have middleware skipped for arbitrary requests. The design therefore reduces to two questions: *who can reach the routing service*, and *who can obtain the secret at rest*. Everything below serves one of those two.

## Workload hardening

Pool and routing-service containers run as `USER node` with:

- `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`
- all capabilities dropped, seccomp `RuntimeDefault`
- no service-account token mounted (the traffic-extension registration Job keeps its Workload Identity token — it needs it — but runs with the same hardening otherwise)
- writable scratch only via per-pod `emptyDir` mounts at `/tmp` and `/app/.next/cache`

## Network isolation

### Why reachability is the boundary

The ext_proc listener authenticates only the server (TLS with no client-certificate verification), and an ordinary `request_headers` call is answered with the dispatch secret in its header mutation — that is how the secret reaches the pools. So **anything that can reach the routing service on `:8443` can read the secret**, then replay a trusted verdict directly to a pool. Reachability to the routing service is equivalent to holding the credential. Network policy is therefore not defense-in-depth here; it is the primary control until caller authentication lands (see [Known limits](#known-limits-and-planned-work)).

### GKE: strict ingress allowlist

The chart emits default-deny ingress NetworkPolicies with a positive allowlist:

| source | reaches | why |
| --- | --- | --- |
| `35.191.0.0/16`, `130.211.0.0/22`, `2600:2d00:1:1::/64` | pools `:3000`, routing `:8443` | GFE proxy ranges for a global external Application Load Balancer with zonal `GCE_VM_IP_PORT` NEG backends — the topology this chart emits. The ext_proc callout arrives from the same ranges. |
| `35.191.0.0/16`, `2600:2d00:1:b029::/64` | same | Health-check probers for GFE-based load balancers (the Gateway's pool checks and the routing tier's TCP check on `:8443`). |
| node CIDRs (auto-discovered) | pools `:3000`, routing `:8081` | kubelet liveness/readiness probes originate from the **node** IP, which no Google range covers. The template fails at render time if the range is unknown, rather than leaving every pod unready at rollout. |
| sibling pool pods (label selector) | pools `:3000` | cross-pool proxying. The routing service cannot originate pool traffic. |

Both CIDR sets are discovered at deploy time (cluster subnetwork plus any node-pool subnets on Standard clusters); nothing needs setting by hand. To pin them, or to fall back to a pod-CIDR denylist:

```yaml
# .k8s-adapter/helm/values.override.yaml
global:
  networkPolicy:
    strict: true                  # default; false = 0.0.0.0/0-except-pod-CIDR denylist
    nodeCidrs: ["10.128.0.0/20"]  # normally discovered
```

The denylist exists for compatibility but is **not** a boundary for the dispatch secret: its edge is the pod CIDR, and VMs on the VPC, `hostNetwork` pods using node IPs, and pods in peered clusters all sit outside it while still being routable to `:8443`. The allowlist is the default because it is what actually closes that.

What you accept in exchange:

1. Google publishes these ranges but guarantees nothing — new probers can appear without notification, and a future range addition would surface as unhealthy backends, not a warning.
2. IPv6 ranges are included unconditionally (inert on single-stack clusters).
3. The discovered node range is usually the whole cluster subnet, so any VM sharing that subnet keeps its reach — give the cluster its own subnet if that matters.
4. The allowlist trusts the Google LB ranges wholesale; a network-level control cannot distinguish *your* load balancer's traffic from anything else sourced from those ranges.

Neither posture governs **egress** (`policyTypes: [Ingress]`), so pool → Valkey/GCS/Artifact Registry/DNS traffic is unaffected. Standard clusters are created with `--enable-network-policy`; Autopilot always enforces it. `deploy` discovers the pod and node ranges and **aborts** if it can't — `--allow-no-network-policy` deploys without isolation, which disables everything in this section.

### Generic clusters: Envoy Gateway

On GKE the ext_proc callout arrives over TLS from Google's frontend. In-cluster it is plain h2c, and what bounds it is the emitted NetworkPolicy: `:8443` admits only pods carrying **both** `gateway.envoyproxy.io/owning-gateway-name` (this release's Gateway) and `owning-gateway-namespace`, from the gateway's proxy namespace.

That is a tighter admission rule than IP ranges, but it rests on three preconditions:

- **Your CNI must enforce NetworkPolicy.** Some accept the objects and ignore them, which makes the policy decorative. Verified enforcing on Cilium; check yours.
- **`hostNetwork` pods bypass NetworkPolicy** in every implementation. A tenant permitted `hostNetwork` anywhere in the cluster can reach `:8443`.
- **The proxy namespace should be locked down**, since anything running there with matching labels is admitted.

If those do not hold for your cluster, treat the dispatch secret as reachable.

## The internal dispatch secret

- Delivered to pods only via a Kubernetes Secret (`INTERNAL_HEADER_SECRET`), compared in constant time; dispatch headers from any other source are stripped.
- Derived deterministically per build — `HMAC-SHA256(key, "<release>\0<buildId>")` — where the key comes from `ADAPTER_K8S_INTERNAL_SECRET_KEY` or a 32-byte `.k8s-adapter/internal-secret.key` created on first build (mode `0600`). Re-emitting a build is byte-identical, and a deploy never rotates the secret out from under pods currently serving.
- Rotation (changing the key) is safe but not free: during the rollout window, old pods stop trusting dispatch headers and re-resolve locally, which runs middleware twice per request.

## Image provenance

`deploy` resolves every image to its immutable `@sha256:` digest **from the registry** and deploys that, with `imagePullPolicy: IfNotPresent`. A mutable tag would let a retag change what a pool runs on its next restart or scale-up — and these pods hold the dispatch secret and cache credentials. If a digest cannot be resolved, the deploy aborts unless `--allow-mutable-tags` is passed.

The **base** image is tracked by tag (`node:24-slim`) so upstream security patches keep flowing. For reproducible builds, pin it with `ADAPTER_K8S_NODE_BASE_DIGEST=sha256:…` — which you then own updating.

One asymmetry worth knowing: a **rolled-back** routing tier is pinned by tag rather than digest, because the revert reconstructs the reference from the target build id. A rolled-back edge is one step less immutable than a freshly deployed one.

## Cache security

Memorystore's own defaults are AUTH off and transit encryption off, and the chart's NetworkPolicies govern ingress to *pods* only — so a plaintext instance is readable **and writable** by any workload with VPC reachability. Writable matters: overwriting cached HTML/RSC is content injection into the site.

The adapter therefore creates instances **with AUTH + TLS** (`SERVER_AUTHENTICATION`); pods connect over `rediss://` with the AUTH string and server CA injected from the connection Secret. Because AUTH is creation-only on Memorystore, there are three config states:

- `auth` unset (recommended): new instances get AUTH; a pre-existing plaintext instance is reused with a per-deploy warning rather than a forced cache wipe.
- `auth: true`: require it; refuse to reuse an instance that lacks it.
- `auth: false`: opt out; warns on every deploy. To secure an existing plaintext instance, destroy and recreate it.

Two rules regardless of provider:

- **Never commit a cache password.** `adapter.config.mjs` is typically in git; a literal `cache.password` leaks the AUTH string into repo history. Use the managed path or `password: process.env.VALKEY_PASSWORD`. Generated secrets under `.k8s-adapter/` are git-ignored and written `0600`; the config file itself is the exposure.
- **One instance, one tenant.** Cache keys are namespaced by build id, but that namespace is not a security boundary. Don't point two unrelated applications at the same instance.

## Cloud IAM: two identities, split by pod-assumability

- **`<release>-deploy`** — assumable by anyone who can create a Pod in the namespace, because the extension registration Job runs as it. It holds a release-scoped custom IAM role for traffic-extension registration and nothing else: no project-wide LB admin, no project-wide `compute.viewer`.
- **`<release>-cli`** — bucket `objectAdmin` and repository-scoped Artifact Registry **writer**, with **no Workload Identity binding**, so no pod can assume it. Pushing images is a CLI operation; the in-cluster Job never pushes. It is deliberately not `repoAdmin`: retag rights on an already-deployed repository would turn pod-creation into dispatch-secret theft on the next restart.

`init` is idempotent and grants the CLI identity before revoking the deploy identity, so a failed run can never leave the release with neither identity holding a permission.

**If your CI impersonates a service account, point it at `<release>-cli`.** A pipeline authenticated as `<release>-deploy` loses push permissions the next time `init` runs.

**Residual risk:** releases deploy into the shared `default` namespace, so pod-creation there means assuming the deploy identity and reading the namespace's Secrets. The identity split shrinks what that is worth; it does not close it.

## Other defaults

- **HTTPS redirect**: with TLS enabled, the chart emits an HTTP→HTTPS `RequestRedirect` route so plaintext is never served.
- **Input validation at every boundary**: release name, hostnames, registry, namespace, and build id are charset-validated before reaching Helm values, YAML, or the privileged registration Job. A custom `generateBuildId()` outside `[A-Za-z0-9._-]` fails the build.
- **Secrets never touch command lines, logs, or git** (`init` scaffolds `.k8s-adapter/` into `.gitignore`).
- **Reserved probe paths**: a route or static file at `/healthz` or `/readyz` fails the build, because those paths are read as the pod's own verdict — a static 200 at `/readyz` would promote a pod whose instrumentation failed.

## Known limits and planned work

- **No caller authentication on the ext_proc callout.** mTLS on the callout (via `BackendAuthenticationConfig` on GKE) would remove the dependency on network controls entirely and is the strongest planned fix. Until then, network reachability is the boundary.
- **Rollback's routing tier is tag-pinned.** A rolled-back routing tier reconstructs its image reference by tag (see [Image provenance](#image-provenance)); digest-pinned rollback is on the roadmap. This matters because the routing tier holds the dispatch secret.
- **`hostNetwork` pods bypass NetworkPolicy** in both postures and on every CNI.
- **Escape hatches disable guarantees.** `--allow-no-network-policy` and `--allow-mutable-tags` exist for constrained environments and turn off the controls described above; they are opt-in and loud.
- **Namespace isolation.** Moving the registration Job's work into the CLI — removing the in-cluster identity altogether — is the preferred fix for the shared-namespace residual, ahead of per-release namespaces plus an admission policy.
