# Configuration reference

Everything `createK8sAdapter` accepts, and the environment variables that shape a build or deploy. Target composition (`target: defineTarget(...)`) has its own page: [docs/targets.md](./targets.md).

## Pool decomposition

Split routes across independently scaling groups:

```js
pools: {
  ssr:   { routes: ["appPages"], scaling: { min: 2, max: 20, targetCPU: 70 } },
  api:   { routes: ["appRoutes", "pagesApi"], scaling: { min: 2, max: 10, targetCPU: 60 } },
  heavy: { routes: ["/api/generate-report", "/api/export/*"], scaling: { min: 1, max: 5, targetCPU: 50 } },
},
```

Routes match by output type (`appPages`, `appRoutes`, `pages`, `pagesApi`) or a glob over the build-time route template pathname, first-match-wins in config order. Next.js dynamic segments are literal: `/blog/[slug]` selects that template and `/[locale]/lab/**` selects templates below it. Dynamic segments glued to interception markers are literal too, including `(.)[user]`, `(..)[...slug]`, `(...)[[...slug]]`, and `(..)(..)[slug]`. Ordinary glob syntax remains available outside these Next-specific segment forms, such as `/api/v[12]/**`.

Per-pool options beyond `routes` and `scaling`:

- `resources` — container requests/limits (`cpu`, `memory`, `cpuLimit`, `memoryLimit`).
- `timeout` — pool time-to-response-headers budget in seconds. Streaming is unbounded after headers.
- `env` / `envFrom` — merged over/appended after the top-level maps (see below).

`defaultPool` names the pool that hosts the stable portable origin; it defaults to the first declared pool.

## Environment variables

`.env` files are never staged into an image — they routinely hold secrets, and an image layer is a poor place for one. Runtime environment is supplied to the containers instead:

```js
export default createK8sAdapter({
  env: {
    API_URL: "https://api.example.com", // literal
    API_KEY: { secret: "app-secrets", key: "api-key" }, // -> secretKeyRef
    FLAGS: { configMap: "app-config", key: "flags" }, // -> configMapKeyRef
  },
  envFrom: [{ secret: "app-secrets" }, { configMap: "app-config", prefix: "CFG_" }],

  pools: {
    // Merged OVER the top-level map, so a pool can override a shared default.
    worker: { routes: ["pagesApi"], env: { TIER: "worker" } },
  },
});
```

You manage the referenced Secret/ConfigMap; the adapter only points at them. That is the preferred shape for two reasons: `adapter.config.mjs` is committed, so a literal is the wrong home for a credential — and the chart is emitted during `next build`, so changing a _literal_ needs a rebuild while changing a referenced Secret only needs a pod restart.

Precedence matches Next: the pool server calls `loadEnvConfig`, which does not overwrite an already-set variable, so anything set here wins over a `.env` file the app loads itself. Individual `env` entries win over `envFrom` sources; a pool's `envFrom` is appended after the top-level one, and later sources win, per Kubernetes.

**Not for `NEXT_PUBLIC_*`.** Those are inlined into client bundles at _build_ time; setting one as container environment produces a value the browser never sees. The build fails rather than let that pass silently — put them in `.env.production` or the build environment.

Names the adapter emits itself (`NODE_ENV`, `NEXT_BUILD_ID`, `POOL_NAME`, `RELEASE_NAME`, `ADAPTER_K8S_PROVIDER_NAME`, `ADAPTER_K8S_LISTEN_HOST`, `INTERNAL_HEADER_SECRET`, `VALKEY_URL`, `VALKEY_AUTH`, `VALKEY_CA_CERT`, `PORT`, `CONFIG_DIR`) are reserved and rejected — shadowing `NEXT_BUILD_ID` in particular would cross-wire two builds' cache namespaces. `ADAPTER_K8S_PROVIDER_NAME` is the compiler-selected, bounded provider dimension on adapter-owned OpenTelemetry signals. `ADAPTER_K8S_LISTEN_HOST` keeps local emulation on loopback without changing the Kubernetes bind address.

## Distributed cache (cache components & PPR)

Next's default `use cache` store is per-process, which diverges the moment you run more than one replica: pods cache different values, and `revalidateTag` on one pod is invisible to the others. Enable a shared cache so cache components, PPR, and ISR behave correctly across replicas.

Set `cacheComponents: true` in `next.config`, then:

```js
cache: {
  enabled: true,
  provider: 'valkey',                 // 'valkey' | 'redis' (wire-compatible)
  memorystore: {                      // managed (GKE): provisioned on deploy
    region: 'us-central1',
    sizeGb: 1,
    tier: 'BASIC',
  },
  // or bring your own:
  // url: 'redis://my-valkey.internal:6379',
  // password: process.env.VALKEY_PASSWORD,
},
```

- Managed Memorystore instances are created with AUTH + TLS by default; pods connect over `rediss://` with credentials injected from a cluster Secret. Treat one instance as one tenant—the per-build key namespace is not a security boundary. See [SECURITY.md](../SECURITY.md#cache-security) for the `auth` tri-state and why the default is what it is.
- Never put a literal `cache.password` in `adapter.config.mjs` (it's typically committed); inject it from the environment.
- Cross-replica PPR-shell and ISR revalidation requires Node middleware (`proxy.ts`, Next 16.2's replacement for edge `middleware.ts`). Apps still on edge middleware keep cross-replica `use cache` but fall back to per-replica shell/ISR revalidation.
- Cache reads degrade to a miss on store failure—a cache outage slows the site; it does not take it down.

Managed provisioning is currently supplied only by `gkeCluster()` (including the legacy `provider.gke` preset that `init` scaffolds). With an explicit `target: defineTarget(...)`, enabling the cache without `cache.url` asks the target for a managed-cache provisioning operation. `gkeCluster()` records a verified Memorystore operation in the composition plan; `kubernetesCluster()` and other targets fail the build with guidance to set `cache.url`, disable the cache, or add a component that contributes managed provisioning. Every non-managed target uses `cache.url` against an operator-managed Valkey/Redis endpoint. Disabling the cache makes ISR/PPR revalidation per-replica.

Switching from managed cache to `cache.url` or disabling the cache deletes the old Memorystore only after the new build passes readiness, cuts over, and commits deploy state. The CLI verifies the outgoing build's retained composition-plan digest and requires its project/region to match the local provisioning record before spending cloud credentials. If either proof is unavailable, deployment leaves the instance in place and warns that it may still be billed. Legacy builds without an authenticated composition plan must first be rebuilt and deployed with managed cache still enabled; the following deployment can then change cache mode safely. That bridge build must declare the existing instance's actual settings, including `auth: false` when migrating an instance created before secure-by-default provisioning.

An existing instance is reused only when its size, tier, canonical VPC project/name, connect mode, and AUTH/TLS posture match the plan. Before the create call, deploy atomically claims the intended project/region in the release's `<release>-cache-identity` ConfigMap, then records the same coordinates with a local pending marker. The cluster claim serializes concurrent CI hosts; the local marker keeps destroy recoverable if the cloud operation times out or later credential retrieval fails. A successful retry clears the pending marker. Never edit only one cache coordinate in `infrastructure.json`: deploy and destroy reject incomplete identities instead of guessing which project owns paid state.

Changing the managed-cache project or region in place is rejected because the current lifecycle records one paid instance and cannot yet replace it without orphaning the old one. Destroy and recreate intentionally for those coordinate changes.

### Dragonfly (verified)

[Dragonfly](https://www.dragonflydb.io/) works as the `valkey`/`redis` provider endpoint: **fully compatible, verified live on v1.40.1** across the handler's entire wire surface — GET/SET EX/SET NX EX (the revalidation lock), hashes, MULTI/EXEC transactional entry writes, binary payloads up to the handlers' 16 MiB cap, the tag-manifest Lua script (including its server-`TIME` clock rebasing and `cjson`), 1-year TTLs, and AUTH via `requirepass`. Cross-pod ISR, `revalidatePath`, and `revalidateTag` all behaved identically to Valkey in a live multi-pod app.

Operational caveats:

- **Memory sizing is thread-coupled.** Dragonfly refuses to start unless `--maxmemory >= 256MiB × proactor_threads` (measured: 2 threads with `--maxmemory=256mb` crashloops with "There are 2 threads, so 512.00MiB are required. Exiting"). Pin both flags in the pod spec — e.g. `--proactor_threads=2 --maxmemory=512mb` with a 768Mi container limit.
- **A restart is a cold cache.** The stock container has no persistence volume, so a Dragonfly pod restart returns an empty keyspace. The adapter degrades gracefully — cache reads degrade to a miss on store failure (the pods log `read failed; treating it as a miss`, then open a circuit breaker and fail fast; no pod restarts), pages re-render and re-populate the store — but on large sites that warm-up is a thundering re-render. Use the Dragonfly operator's snapshotting if that matters.
- **Do not enable `--cluster_mode`.** The adapter's client is single-endpoint by design (no MOVED/ASK redirection). Dragonfly's emulated cluster mode is off by default, which is exactly what the client needs.
- **Password via Secret, not config.** `redis://:pass@…` in `cache.url` works, but `adapter.config.mjs` is typically committed — keep the URL secret-free and deliver the password through the generated Valkey `Secret` / `VALKEY_AUTH` env path instead (see the note on `cache.password` above).

## Container strategy

```js
containerStrategy: 'traced-assets',  // default: per-pool minimal images
// containerStrategy: 'shared-image', // one image for all pools—simpler CI/CD
```

## Container runtimes and platforms

`deploy` probes for `docker`, `podman`, then `nerdctl` (force one with `ADAPTER_K8S_CONTAINER_CLI`). Each build publishes one platform, `linux/amd64` by default; set `ADAPTER_K8S_TARGET_PLATFORM=linux/arm64` while running `next build`/`adapter-k8s deploy` for ARM nodes. The platform is recorded in the build artifact, used for native Sharp packages and Docker builds, and enforced with a pod node selector. Changing it after a skipped build is rejected—rebuild instead.

Sharp is the only native dependency the adapter retargets itself; staged foreign ELF, Mach-O, PE, Prisma engines, and `.node` addons fail the build. Prisma `linux-musl` engines are also rejected because the emitted runtime is Debian/glibc, even when their CPU architecture matches. Apps with other native dependencies must install and build them on a matching Linux runner/container. This does not publish a multi-architecture image index.

Runtime-specific requirements (nerdctl's buildkit socket, podman's digest rewriting) are in [docs/ci-cd.md](./ci-cd.md#container-runtimes).

## Build-time kill-switches

Two Next features the adapter turns on by default are still experimental upstream. Both have an environment escape so an app can A/B them, or turn one off during an incident, without a `next.config` edit and a review cycle. Set them in the environment that runs `next build` (or `adapter-k8s deploy`), and read them as "off for this build only" — the next build without the variable is back on the default.

| Variable                                    | Effect when set to `1`                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADAPTER_K8S_DISABLE_IMMUTABLE_ASSETS`      | Forces `supportsImmutableAssets: false` — asset URLs stay off `/_next/static/immutable/`. For checking whether the immutable-asset split regressed client bootstrap.                                                                                                    |
| `ADAPTER_K8S_DISABLE_TURBOPACK_BUILD_CACHE` | Forces `experimental.turbopackFileSystemCacheForBuild: false` — a fully cold compile, ignoring `<distDir>/cache`. For a suspected upstream cache-invalidation bug (see [docs/ci-cd.md](./ci-cd.md)).                                                                    |
| `ADAPTER_K8S_KEEP_RUNTIME_SOURCE_MAPS`      | Keeps generated server and Next runtime `.map` files in image contexts. By default they are omitted because emitted containers do not enable Node source maps. Set to `1` together with source-map-aware diagnostics when stack traces must resolve through those maps. |

Each one wins over an explicit `true` in `next.config`, not just over the adapter's default: an app that has pinned the flag on is exactly the app that could not otherwise disable it without changing code.

## Registry pull auth

**Node-level credentials.** On clusters where the nodes themselves can authenticate to the registry—GKE nodes pulling from Artifact Registry in the same project, EKS with an ECR instance role, or any cluster whose kubelets carry a machine-level `config.json`—no adapter config is needed: the kubelet authenticates every pull and the chart's image references just work. This is the default assumption, and it is why the emitted pod specs carried no `imagePullSecrets` at all before this key existed.

**`imagePullSecrets`.** Everywhere else—a private ghcr.io image on stock Talos or k3s nodes, any registry the kubelet has no ambient credentials for—every pod is `ImagePullBackOff` without a pull secret. Set `imagePullSecrets: ['docker-regcred']` (top-level; names must be K8s-name-safe) and the adapter renders `imagePullSecrets` into **every** pod-creating template: each pool Deployment, the routing-service Deployment, and the GKE traffic-extension registration Job. The named `kubernetes.io/dockerconfigjson` Secret(s) must already exist in the app namespace (`kubectl create secret docker-registry docker-regcred --docker-server=… --docker-username=… --docker-password=…`, or your ExternalSecrets/SealedSecrets flow)—the adapter never creates or carries them, and `adapter-k8s emit` lists them in the bundle README as an operator prerequisite.

```js
imagePullSecrets: ['docker-regcred'],
```

## Routing service tuning

Applies when the target hosts a routing tier (`envoyNativeRouting`, `gkeNativeRouting`):

```js
routingService: {
  scaling: { min: 2, max: 10, targetCPU: 70 },
  resources: { cpu: '500m', memory: '512Mi', cpuLimit: '1000m', memoryLimit: '512Mi' },
  requestTimeoutMs: 4000,
  failureMode: 'auto',   // fails closed when the app has middleware (never bypass auth),
                         // fails open otherwise; 'open'/'closed' force it
},
```

`requestTimeoutMs` is the per-request handler budget in milliseconds; it must stay under the 5s ext_proc deadline.

## Multiple hosts & wildcards

```js
gateway: {
  hosts: [
    { hostname: 'app.example.com', tls: { enabled: true, managedCert: true } },
    { hostname: '*.example.com',   tls: { enabled: true, managedCert: true } },
  ],
}
```

(Shown in the legacy `provider.gke.gateway` shape; `hosts` takes the same form on `gatewayApiExposure`/`ingressExposure`, where `managedCert` is replaced by the exposure's TLS options.)

## Cloud CDN (GKE)

```js
provider: {
  gke: {
    cdn: { enabled: true, bucket: 'my-project-nextjs-static' },
    gateway: { /* ... */ },
  },
},
```

The adapter attaches a Cloud CDN filter to the HTTPRoute with a Next.js-aware cache key (RSC/prefetch `Vary` headers partition App Router HTML and RSC payloads correctly). Mutable cacheable responses carry a per-build `Cache-Tag`, and `deploy`/`rollback` purge the outgoing build's tag on cutover—so a new build never serves the previous build's stale content from the edge. Content-hashed `/_next/static/*` assets are shared across builds and never purged.

## Static NetworkPolicy ranges (`adapter-k8s emit`)

```js
networkPolicy: {
  nodeCidrs: ['10.0.0.0/16'],  // node/subnet range(s) the strict posture admits for kubelet probes
  podCidrs: ['10.8.0.0/14'],   // cluster pod range(s) for the broad posture (optional)
},
```

`deploy` discovers these ranges from the cluster at deploy time and never needs this block. `adapter-k8s emit` cannot—it renders the GitOps bundle with **no cluster contact at all**—so the ranges must come from config. With `strict: true` (the default posture) and no `nodeCidrs` configured, `emit` refuses to render; `--allow-no-network-policy` is the explicit opt-out and emits the bundle without network isolation. The legacy `provider.generic.nodeCidrs` key still maps in when `networkPolicy.nodeCidrs` is absent.

Static ranges do not follow node autoscale: give the enclosing subnet range, not per-node addresses, and prefer letting `deploy` discover them when you are not using `emit`.

## Config variants

`ADAPTER_K8S_CONFIG=scaleway npx adapter-k8s deploy` selects a complete target: `adapter.config.scaleway.mjs`, `.k8s-adapter/infrastructure.scaleway.json`, its own build output, and its own deploy state. One project can therefore target several clusters without editing files between deploys.

A requested variant must provide its own `infrastructure.<variant>.json`—there is deliberately no fallback to the default infrastructure file. Falling back would build one cluster's config against another's registry, which is silent until pods try to pull images they have no credentials for. Note the config file does fall back: when `adapter.config.<variant>.mjs` is absent, the default `adapter.config.mjs` is loaded, so provide the variant config file too if the targets differ.

## Image optimization

Each pool serves `/_next/image` using the application's installed Next.js optimizer. Configure
images through `next.config`, including allowed sources, sizes, qualities, formats, loaders,
and `unoptimized`. A custom loader or `unoptimized: true` disables this endpoint.

Middleware and rewrites run before image handling. Local source requests also pass through
middleware when it covers the source path. Remote sources must match `images.remotePatterns`
or `images.domains` at every redirect. Private addresses are denied unless
`images.dangerouslyAllowLocalIP` is explicitly enabled.

`images.maximumRedirects` and `images.maximumResponseBody` apply to source fetching. The
adapter's `ADAPTER_K8S_MAX_IMAGE_BYTES` remains an upper bound even if the application asks
for a larger response. Concurrency, memory admission, and fetch deadlines still apply.

Optimized images are cached per pod in `<distDir>/cache/images`. The default payload budget
is 256 MiB; set `images.maximumDiskCacheSize` to change it, or `0` to disable disk caching.
Eviction is asynchronous, and filesystem overhead is additional. The generated chart's 1 GiB
cache volume also holds other Next caches, so leave room for those when raising the budget.
Exceeding the volume limit can cause Kubernetes to evict the pod.
Entries are scoped to the build ID. Responses report `MISS`, `HIT`, or `STALE` in
`x-nextjs-cache`; stale entries refresh in the background under the same admission limits.
Source paths covered by middleware bypass persistent image caching and return `Cache-Control: no-store`.

To share images across replicas, enable the adapter's Valkey cache in `adapter.config` and
opt images into the application's cache handler in `next.config`:

```ts
export default {
  images: { customCacheHandler: true },
};
```

With the adapter's handler and `VALKEY_URL` configured, optimized images use Valkey. Without
that runtime connection, the adapter uses its image disk cache. An application-provided
`cacheHandler` is also supported and must implement Next's `IMAGE` entries, including binary
buffers and revalidation metadata. This is the extension point for an object-store backend;
the adapter does not currently ship an S3 image handler. Custom-handler failures degrade to
cache misses. The disk budget does not limit a shared store; size Valkey and its eviction
policy for the combined image and application cache workload. The adapter also caps each
serialized Valkey entry at 16 MiB by default (`ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES`). Image buffers
are base64-encoded in that entry, so the stored size exceeds the image byte count. Oversized
entries are served without caching.

For an external image optimization service, use Next's `images.loader: "custom"` and
`images.loaderFile` to generate that service's URLs.

## Middle cache for build assets

Set `middleCache: { enabled: true }` in your adapter config to serve build assets through
a Go sidecar. It works with every target and both container strategies. Middleware and
proxy routing still run for every request, including cache hits, HEAD and conditional
requests. The sidecar serves the resolved file and preserves the current request's
response headers and cookies. Responses covered by middleware retain `Cache-Control:
no-cache`, so an upstream CDN cannot skip middleware.

The cache holds file bytes from `public/` and build-emitted static assets. It excludes
prerenders, ISR/PPR, image optimization, dynamic responses and external proxy responses.
Each pod caches at most 64 MiB and 4,096 files, with a 1 MiB limit per cached file. Larger
files stream from disk. The sidecar admits at most 64 concurrent file responses and
answers excess requests with an uncacheable 503. Cache entries belong to the pod's build;
deploy and rollback switch the sidecar and app together through the existing Service.

This option adds a Go process with a 128 MiB memory request and 256 MiB limit to each pool
pod. It uses the same image as the pool, with a static Go binary compiled during the
Docker build. The host does not need Go. Port 3000 remains the public pod port; the Node
server listens on loopback port 3001. With compression enabled, Envoy owns port 3000
and the middle cache listens on loopback port 3002. Readiness checks pass through both
proxies to Node.
Disable the option and rebuild to return to Node file serving. Local `emulate` continues
to serve files through Node.

## Response compression

The deployment adapter overrides Next's `compress` setting to `false`, including when
the app sets it to `true`. Generated pool pods run a separate Envoy process for response
compression by default, on every target including GKE. Set `compression: { enabled: false }`
in the adapter config to omit this proxy when your own ingress handles compression.
Next compression remains disabled.

Envoy negotiates Brotli, Zstandard and gzip from `Accept-Encoding`, honors client quality
values, and prefers Brotli for ties. It compresses HTML, RSC, JSON, JavaScript, CSS, XML,
SVG and WebAssembly. Responses with a known length below 1 KiB remain uncompressed.
SSE, partial-range responses, already encoded bodies and responses with `Cache-Control:
no-transform` pass through unchanged. Compression adds `Vary: Accept-Encoding`, preserves
cookies and weak ETags, and removes strong ETags when transforming the body.

Brotli and gzip flush incremental HTML/RSC chunks. Envoy 1.38.3's Zstandard compressor
does not flush intermediate chunks, so the adapter skips Zstandard on responses without
`Content-Length`. If negotiation selects Zstandard for such a response, Envoy sends it
uncompressed. It never buffers a response to determine its length.

The proxy preserves the request target, authority, forwarded headers and `Accept-Encoding`
so middleware dispatch proofs remain valid. With the middle cache enabled, the response
passes from Node through the asset cache and then through Envoy. The cache keeps original
file bytes; compression does not cache response headers or skip middleware.

Each pool pod gains a digest-pinned Envoy 1.38.3 container with two worker threads, a
100m CPU and 64 MiB memory request, and limits of 1 CPU and 128 MiB. Port 3000 stays the
public port and readiness checks traverse the proxy. Its shutdown hook waits for load
balancer draining before draining active connections. Local `emulate` uses the same codecs
in its existing front proxy.

## Previous-build retention

```js
retention: { enabled: true, gracePeriodSeconds: 300 }
```

Retention is disabled by default. Enable it in two successive builds to keep an open
tab's previously unrequested immutable chunks and pending Server Actions usable across
promotion and rollback. The adapter supplies a unique Next deployment ID when the app
does not configure one. Ordinary navigation still follows Next's recovery onto the
current build.

Only the immediately previous build is retained. Each of its pools keeps one replica,
including its configured sidecars, with its HPA removed. After the serving deadline,
a cluster CronJob scales those pools to zero and preserves their rollback resources.
It checks once per minute; scheduling delays and the normal pod termination grace period
can extend the time until the pods disappear. Rollback restores capacity and verifies
readiness before moving traffic. Leave retention disabled to park the rollback target
at zero immediately after cutover.

The cleanup job uses the deployed default-pool image and a separate service account.
Its namespace Role can read the release's deploy state, list Deployments, Services, and
HPAs, and patch Deployment scale subresources. It cannot read Secrets or edit pod
templates. The worker checks the release, build, serving selectors, deadline, and HPA
ownership. Each scale-down requires the Deployment's observed UID and resource version
to still match. Promotion and rollback renew that build's expiry marker before readiness,
so cleanup cannot act on an older observation after the build is prepared to serve.

Expiry markers have a one-hour recovery deadline during preparation. If the CLI exits
after committing traffic but before finalizing retention, the job can still retire the
standby later. It leaves capacity untouched when state or selectors disagree, API reads
fail, or an HPA still controls the target. Recover an interrupted cutover or remove the
outgoing HPA through a successful deploy/rollback before expecting cleanup in those cases.

`gracePeriodSeconds` accepts integers from 1 to 3600 and defaults to 300. After successful
cutover, the CLI publishes a signed serving deadline with an additional 120-second
ConfigMap propagation allowance. A preparation record has a one-hour expiry so an
interrupted promotion cannot leave public forwarding enabled indefinitely. A subsequent
deployment can evict the older build before its deadline. After eviction or expiry,
missing chunks and stale action IDs use the current build's normal error behavior;
mutations are never automatically retried.

The adapter matches only build-inventoried `/_next/static/immutable/` paths and Server
Action IDs. It forwards the original request to the retained build without a trusted
middleware verdict, so that build runs its own middleware and routing. Retained responses
use `Cache-Control: no-store` to prevent them from populating the current build's CDN
cache. Mutable public files, image optimization, ordinary API POSTs, and WebSocket
connections are outside this policy. Non-hydrated form submissions without a
`Next-Action` header are also outside it.

Serialize deployments and rollbacks for a release. Both builds must have retention
enabled and the same pool names. A topology change
disables retention for that cutover and parks the previous build at zero replicas;
retaining renamed pools requires additional NetworkPolicy support. Inventories are
limited to 200 KB per build and the signed index to 800 KB. Deploy and rollback verify
inventory signatures and wait for the index to reach ready pods before switching
selectors. The old build must remain compatible with your shared data and services for
the entire serving window.

## Not yet implemented

The old `imageOptimizer`, `skewProtection`, and top-level `routeExtension` keys were placeholders. They never changed emitted workloads and are no longer part of `K8sAdapterConfig`. Validation rejects them with a removal message instead of silently ignoring stale configuration. The implemented GKE routing timeout remains at `provider.gke.serviceExtensions.routeExtension.timeout` during the legacy migration window.

## See also

- [Targets](./targets.md) — cluster/exposure/routing composition
- [Lifecycle](./lifecycle.md) — what deploy/rollback/destroy do with this config
- [CI/CD](./ci-cd.md) — replicating the pipeline without the CLI
