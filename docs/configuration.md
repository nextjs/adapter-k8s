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

Names the adapter emits itself (`NODE_ENV`, `NEXT_BUILD_ID`, `POOL_NAME`, `RELEASE_NAME`, `INTERNAL_HEADER_SECRET`, `VALKEY_URL`, `VALKEY_AUTH`, `VALKEY_CA_CERT`, `PORT`, `CONFIG_DIR`) are reserved and rejected — shadowing `NEXT_BUILD_ID` in particular would cross-wire two builds' cache namespaces.

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

Managed provisioning is currently supplied only by the GKE preset, and only through the legacy `provider.gke` config shape (which is what `init` scaffolds). An explicit `target: defineTarget(...)` composition—including one built on `gkeCluster()`—must set `cache.url` when the cache is enabled; the build fails otherwise. Every other target uses `cache.url` against an operator-managed Valkey/Redis endpoint. Disabling the cache makes ISR/PPR revalidation per-replica.

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
  resources: { cpu: '250m', memory: '256Mi', cpuLimit: '1000m', memoryLimit: '512Mi' },
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

## Not yet implemented

`imageOptimizer` and `skewProtection` validate but throw at build time when enabled; skew protection is on the [roadmap](../README.md#roadmap).

## See also

- [Targets](./targets.md) — cluster/exposure/routing composition
- [Lifecycle](./lifecycle.md) — what deploy/rollback/destroy do with this config
- [CI/CD](./ci-cd.md) — replicating the pipeline without the CLI
