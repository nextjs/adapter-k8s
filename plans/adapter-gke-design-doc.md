# `@next-community/adapter-k8s` — Design Document

**Status:** Draft
**Authors:** James Daniels
**Last Updated:** 2026-03-24
**Next.js Version Target:** 16.2.0+ (stable `adapterPath`)

---

## 1. Problem Statement

Organizations running on GKE need a canonical way to deploy Next.js applications that:

- Uses only public Next.js APIs (the `NextAdapter` interface, `@next/routing`, `onBuildComplete` outputs)
- Supports all Next.js features: SSR, ISR, `use cache`, PPR, middleware, image optimization, API routes
- Produces a Helm chart derived from the build itself — not a hand-maintained template
- Allows the application's deployment topology to evolve with its routes, not its infrastructure config
- Does not require Vercel, private APIs, or reverse-engineering `.next` internals

Today, deploying Next.js to Kubernetes involves hand-writing Dockerfiles, Helm charts, and Envoy/nginx configs that are completely decoupled from the application's actual route structure. When routes change, the infrastructure doesn't know. The adapter API changes this by giving deployment platforms structured, SemVer'd access to the build output.

---

## 2. Goals and Non-Goals

### Goals

1. **Build-time generation of deployment artifacts** — the adapter's `onBuildComplete` emits a complete Helm chart, GCP Service Extensions configuration, and Dockerfiles derived from the build manifest
2. **Configurable service decomposition** — operators can configure which route groups map to which autoscaler pools, from a single monolith pool up to fine-grained per-route-class splits
3. **Pre-CDN routing via GCP Service Extensions** — all Next.js routing logic (rewrites, redirects, middleware, dynamic route matching) runs in a route extension callout using `@next/routing`, before Cloud CDN cache lookup — matching Vercel's model where middleware protects cached routes
4. **Distributed caching** — `cacheHandler` (ISR, route handlers) and `cacheHandlers` (`use cache` directives) backed by Redis/Valkey, enabling shared caching across replicas with CDN-coordinated invalidation
5. **Static assets on Cloud CDN** — `_next/static/*` and pre-rendered pages served from GCS via Cloud CDN
6. **Image optimization sidecar** — Sharp-based service for `next/image`, with a migration path to Cloud CDN's native image optimization when it GAs
7. **PPR support** — partial pre-rendering with cache-first preamble serving from Valkey and in-process resume in the pool server (no traffic extension needed)

### Non-Goals

- Dev-time hooks (adapters are build-only per the spec)
- Multi-cloud in v1 (the adapter has a `provider` config axis for future EKS/generic support, but v1 implements GKE only)
- Cluster provisioning (the Helm chart assumes a GKE cluster exists)
- CI/CD pipeline generation (the CLI provides `init` and `deploy` commands, but does not generate CI/CD pipeline config — operators integrate these into their own workflows)

---

## 3. Architecture Overview

```
                           GCP Application Load Balancer
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  Internet ──► [LbRouteExtension] ──► URL Map ──► [Cloud CDN]         │
│                    │ (ext_proc)          │          │                │
│                    │                     │          │                │
│                    ▼                     │     cache hit → respond   │
│              ┌──────────────┐            │          │                │
│              │   Routing    │            │     cache miss            │
│              │   Service    │            │          │                │
│              │              │            │          │                │
│              │ • @next/     │            │          │                │
│              │   routing    │            │          │                │
│              │ • middleware │            │          │                │
│              └──────────────┘            │          │                │
│                                          │          │                │
│   immediateResponse ◄── redirects        │          │                │
│                                          │          │                │
└──────────────────────────────────────────┼──────────┼────────────────┘
                                           │          │
                                    ┌──────┼──────────┼───────────┐
                                    │      │          │           │
                                    │      ▼          ▼           │
                                    │     GKE Cluster             │
                                    │                             │
                                    │  ┌────────┐  ┌────────┐     │
                                    │  │ Pool A │  │ Pool B │     │
                                    │  │ (SSR)  │  │ (API)  │     │
                                    │  └───┬────┘  └────────┘     │
                                    │      │                      │
                                    │      │ PPR routes:          │
                                    │      │ 1. read preamble     │
                                    │      │    from Valkey       │
                                    │      │ 2. resume in-process │
                                    │      ▼                      │
                                    │  ┌────────┐  ┌───────────┐  │
                                    │  │ Valkey │  │  Image    │  │
                                    │  │(Cache) │  │ Optimizer │  │
                                    │  └────────┘  └───────────┘  │
                                    │                             │
                                    │  ┌───────┐                  │
                                    │  │  GCS  │ (static assets)  │
                                    │  └───────┘                  │
                                    └─────────────────────────────┘
```

### Request Flow

1. **Client request** arrives at the GCP Application Load Balancer.
2. **CEL filter check** — the `LbRouteExtension`'s CEL expression evaluates the request path. Static assets (`/_next/static/*`, known public files) skip ext_proc entirely and go straight to URL map → CDN → GCS. All other requests invoke the Routing Service via ext_proc gRPC. The Routing Service:
   - Resolves the route using `resolveRoutes` from `@next/routing`
   - Executes Next.js middleware via the `invokeMiddleware` callback
   - If middleware short-circuits (redirect, rewrite, direct response) → returns `immediateResponse` to the client. Request processing stops.
   - Otherwise, sets `x-upstream-pool`, `x-output-id`, `x-matched-pathname`, and `x-route-matches` headers for the pool server
   - For PPR routes, sets `x-nextjs-ppr: 1` so the pool server knows to use cache-first PPR flow
3. **URL map evaluation** — the load balancer matches the `x-upstream-pool` header to select the backend service (pool).
4. **Cloud CDN cache lookup** — if the full response is cached (static assets, ISR pages with valid TTL), serve immediately. The pool server is never hit.
5. **Cache miss** → request routes to the selected pool server, image optimizer, or GCS.
6. **Pool server** receives the request and dispatches to the handler identified by `x-output-id` (§6.2). For PPR routes, the pool server reads the cached preamble from Valkey, starts streaming it immediately, and invokes the resume handler in-process in parallel (§6.4). The dynamic content streams after the preamble.

---

## 4. The Adapter

### 4.1 `modifyConfig`

Called before `next build`. The adapter modifies the Next.js configuration to prepare for the Kubernetes deployment model. These modifications are shared across all providers.

```typescript
const adapter: NextAdapter = {
  name: "k8s",

  async modifyConfig(config, { phase, nextVersion }) {
    return {
      ...config,

      // Disable built-in compression — the load balancer and Cloud CDN handle this
      compress: false,

      // ISR, route handler responses, and image optimization cache.
      // This is the "incremental cache" — NOT used by 'use cache' directives.
      cacheHandler: require.resolve("@next-community/adapter-k8s/incremental-cache-handler"),

      // 'use cache' directive handlers — these ARE used by 'use cache' and
      // 'use cache: remote'. Without this, 'use cache' entries are in-memory
      // per-process and not shared across replicas.
      cacheHandlers: {
        default: require.resolve("@next-community/adapter-k8s/cache-handler"),
        remote: require.resolve("@next-community/adapter-k8s/cache-handler-remote"),
      },

      // Set asset prefix to CDN origin (configured via env var at build time)
      assetPrefix: process.env.GKE_CDN_ORIGIN || config.assetPrefix,

      // Image optimization is handled by our sidecar, not the built-in optimizer
      images: {
        ...config.images,
        loader: "custom",
        loaderFile: require.resolve("@next-community/adapter-k8s/image-loader"),
      },
    };
  },
};
```

**Note:** `modifyConfig` does not set `output: 'standalone'`. The adapter uses traced assets from `onBuildComplete` to build minimal containers (§6.1). `standalone` and `MINIMAL_MODE` are on a deprecation path in favor of the adapter API.

### 4.2 `onBuildComplete`

The core of the adapter. Receives the full build manifest and generates all deployment artifacts.

```typescript
async onBuildComplete(ctx) {
  const { routing, outputs, projectDir, distDir, config, buildId, nextVersion } = ctx;

  // 1. Read operator configuration (from adapter config file or env)
  const adapterConfig = loadAdapterConfig(projectDir);

  // 2. Classify outputs into service pools based on operator config
  const pools = classifyIntoPools(outputs, adapterConfig);

  // 3. Collect all output pathnames (needed by resolveRoutes at runtime)
  const pathnames = collectOutputPathnames(outputs);

  // 4. Build the routing manifest — contains everything resolveRoutes needs
  //    plus pool assignments and PPR metadata (follows AWS adapter's pattern)
  const routingManifest = buildRoutingManifest({
    ctx,
    pathnames,
    pools,
  });

  // 5. Generate CEL expression for ext_proc filtering (§13.6)
  const celExpression = generateCelExpression(outputs, config);

  // 6. Generate static asset manifest for GCS sync
  const staticManifest = buildStaticManifest(outputs);

  // 7. Generate Helm chart (includes Service Extensions resources)
  await emitHelmChart({
    pools,
    routingManifest,
    staticManifest,
    config,
    buildId,
    nextVersion,
    adapterConfig,
    distDir,
    projectDir,
  });

  // 8. Generate Dockerfiles (strategy depends on decomposition mode)
  await emitDockerfiles(pools, adapterConfig, distDir, projectDir);

  // 9. Write build metadata
  await emitBuildMetadata({ buildId, nextVersion, pools, routing, outputs });
}
```

The `buildRoutingManifest` function extracts the route graph from `ctx.routing` (the same data the AWS adapter stores as `routeGraph`), collects pathnames and i18n config, and adds GKE-specific pool assignments and PPR metadata. The resulting JSON is mounted as a ConfigMap and consumed by `resolveRoutes` at runtime in the Route Extension Service (see §7.3).

---

## 5. Service Decomposition

### 5.1 The Configuration Axis

The key insight: the level of service decomposition should be a **configuration choice**, not an architectural constant. The adapter supports a spectrum from a single monolith to fine-grained route-class pools, controlled by an `adapter.config.ts` (or equivalent section in `next.config.ts`).

The second insight: **infrastructure provider should be a configuration choice too.** The package is `@next-community/adapter-k8s`, not `adapter-gke`. The pool decomposition, routing manifest, `resolveRoutes` usage, and container strategy are shared across all Kubernetes environments. What differs is the generated infrastructure: how traffic enters the cluster, where static assets live, and how CDN caching works.

This follows the **External Secrets Operator pattern** — a single `provider` field with exactly one provider key, giving type-safe provider-specific config via discriminated unions.

```typescript
// adapter.config.ts
import type { K8sAdapterConfig } from "@next-community/adapter-k8s";

const config: K8sAdapterConfig = {
  // --- Shared across all providers ---

  // Decomposition strategy
  pools: {
    // Option 1: Single pool (simplest — one Deployment, one HPA)
    // default: { routes: ['**'] }

    // Option 2: SSR + API split (recommended starting point)
    ssr: {
      routes: ["appPages"], // All app pages go here
      scaling: { min: 2, max: 20, targetCPU: 70 },
    },
    api: {
      routes: ["appRoutes", "pagesApi"], // All route handlers
      scaling: { min: 2, max: 10, targetCPU: 60 },
    },

    // Option 3: Fine-grained (e.g., isolate expensive routes)
    // heavyApi: {
    //   routes: ['/api/generate-report', '/api/export/*'],
    //   scaling: { min: 1, max: 5, targetCPU: 50 },
    //   resources: { cpu: '2', memory: '4Gi' },
    //   timeout: 300,  // seconds
    // },
  },

  cache: {
    enabled: true,
    provider: "valkey", // or 'redis'
  },

  containerStrategy: "traced-assets", // or 'shared-image'

  imageOptimizer: {
    enabled: true,
    mode: "sidecar", // Sharp container
  },

  skewProtection: {
    enabled: true, // default: true
    duration: "5m", // how long old pools stay alive after new deployment
  },

  routeExtension: {
    mode: "auto", // 'auto' | 'wasm' | 'extproc'
    // auto = Wasm plugin if no middleware, ext_proc otherwise (§20.1)
  },

  // --- Provider-specific (exactly one) ---
  // Follows the External Secrets Operator pattern: a discriminated union
  // where one provider key determines the generated infrastructure artifacts.

  provider: {
    gke: {
      cdn: {
        enabled: true,
        bucket: "my-project-nextjs-static",
        origin: "https://cdn.example.com",
      },
      gateway: {
        type: "gateway-api",
        className: "gke-l7-global-external-managed",
        host: "app.example.com",
        tls: { enabled: true, managedCert: true },
      },
      serviceExtensions: {
        routeExtension: { timeout: 5 },
        // trafficExtension auto-enabled when PPR routes exist
      },
      cache: {
        // GKE-specific override: use Memorystore instead of in-cluster Valkey
        // provider: 'memorystore',
      },
      imageOptimizer: {
        // Future: 'cloud-cdn' when Cloud CDN native image optimization GAs
        // mode: 'cloud-cdn',
      },
    },

    // Future providers:
    //
    // eks: {
    //   cdn: {
    //     distribution: 'E1234567890',
    //     bucket: 'my-nextjs-static',
    //     origin: 'https://d111111abcdef8.cloudfront.net',
    //   },
    //   ingress: {
    //     className: 'alb',
    //     host: 'app.example.com',
    //     annotations: { ... },
    //   },
    //   cache: {
    //     provider: 'elasticache',  // or 'valkey' for in-cluster
    //   },
    // },
    //
    // generic: {
    //   // No cloud-specific resources. Generates standard K8s Ingress +
    //   // in-cluster Envoy for ext_proc (the original design before Service
    //   // Extensions). No pre-CDN middleware — CDN is external or absent.
    //   ingress: {
    //     className: 'nginx',
    //     host: 'app.example.com',
    //   },
    // },
  },
};

export default config;
```

**Type definitions:**

```typescript
// Shared config — identical across providers
interface SharedConfig {
  pools: Record<string, PoolConfig>;
  cache: { enabled: boolean; provider: "valkey" | "redis" };
  containerStrategy: "traced-assets" | "shared-image";
  imageOptimizer: { enabled: boolean; mode: "sidecar" };
  skewProtection: {
    enabled: boolean; // default: true
    duration: string; // e.g. '5m', '10m', '0' to disable
  };
  routeExtension: {
    mode: "auto" | "wasm" | "extproc"; // default: 'auto' (§20.1)
  };
}

// Provider-specific config — discriminated union (exactly one key)
type K8sAdapterConfig = SharedConfig & {
  provider:
    | { gke: GKEProviderConfig }
    | { eks: EKSProviderConfig }
    | { generic: GenericProviderConfig };
};

// Each provider defines its own infrastructure shape
interface GKEProviderConfig {
  cdn: { enabled: boolean; bucket: string; origin?: string };
  gateway: {
    type: "gateway-api" | "ingress";
    className: string;
    host: string;
    tls?: { enabled: boolean; managedCert?: boolean };
  };
  serviceExtensions?: {
    routeExtension?: { timeout?: number };
  };
  cache?: { provider?: "memorystore" };
  imageOptimizer?: { mode?: "cloud-cdn" };
}

// Placeholder — not implemented in v1
interface EKSProviderConfig {
  cdn: { distribution: string; bucket: string; origin?: string };
  ingress: { className: string; host: string; annotations?: Record<string, string> };
  cache?: { provider?: "elasticache" };
}

// Minimal — works on any K8s cluster
interface GenericProviderConfig {
  ingress: { className: string; host: string };
}
```

**What the provider determines:**

| Concern              | GKE                                                              | EKS (future)                       | Generic (future)                                  |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| Pre-CDN middleware   | Route Extension (Service Extensions)                             | Lambda@Edge / CloudFront Functions | Not available (middleware runs post-CDN in Envoy) |
| CDN                  | Cloud CDN                                                        | CloudFront                         | External / none                                   |
| Static assets        | GCS                                                              | S3                                 | Served from pod or external                       |
| Gateway              | GKE Gateway API                                                  | ALB Ingress Controller             | Standard K8s Ingress                              |
| PPR streaming        | Cache-first preamble (Valkey) + in-process resume in pool server | Lambda response streaming          | Envoy ext_proc in-cluster                         |
| Managed certificates | GKE managed certs                                                | ACM                                | cert-manager                                      |
| Helm chart CRDs      | `LbRouteExtension`, `LbTrafficExtension`                         | ALB annotations                    | None                                              |

### 5.2 Pool Classification Logic

The adapter maps outputs to pools using the configuration. Routes can be matched by output type (`appPages`, `appRoutes`, `pagesApi`) or by glob patterns against the route pathname.

```typescript
interface PoolConfig {
  routes: Array<OutputType | string>; // OutputType or glob pattern
  scaling?: { min: number; max: number; targetCPU: number };
  resources?: { cpu: string; memory: string };
  timeout?: number;
}

function classifyIntoPools(
  outputs: AdapterOutputs,
  config: K8sAdapterConfig,
): Map<string, PoolDefinition> {
  const pools = new Map<string, PoolDefinition>();
  // Track which outputs have been assigned to enforce first-match-wins
  const assigned = new Set<string>();

  for (const [poolName, poolConfig] of Object.entries(config.pools)) {
    const matched: AdapterOutput[] = [];

    for (const routeSpec of poolConfig.routes) {
      let candidates: AdapterOutput[];

      // Match by output type
      if (routeSpec === "appPages") candidates = outputs.appPages;
      else if (routeSpec === "appRoutes") candidates = outputs.appRoutes;
      else if (routeSpec === "pagesApi") candidates = outputs.pagesApi;
      // Match by glob against pathname
      else {
        candidates = [...outputs.appPages, ...outputs.appRoutes, ...outputs.pagesApi].filter((o) =>
          minimatch(o.pathname, routeSpec),
        );
      }

      // First-match-wins: pools are evaluated in config order.
      // An output matched by an earlier pool is not re-assigned.
      for (const output of candidates) {
        if (!assigned.has(output.id)) {
          assigned.add(output.id);
          matched.push(output);
        }
      }
    }

    pools.set(poolName, {
      name: poolName,
      outputs: matched,
      config: poolConfig,
    });
  }

  return pools;
}
```

### 5.3 What the Routing Service Needs to Know

The routing manifest (a JSON file mounted as a ConfigMap) contains everything `resolveRoutes` from `@next/routing` needs, plus pool assignments and PPR metadata. This shape is derived from the AWS adapter's `routerManifest` pattern.

```typescript
// Generated at build time by the adapter
interface RoutingManifest {
  // --- Input to resolveRoutes() from @next/routing ---

  // The route graph, passed directly to resolveRoutes({ routes: ... })
  // Mirrors the structure from ctx.routing in onBuildComplete
  routeGraph: {
    beforeMiddleware: Route[];
    beforeFiles: Route[];
    afterFiles: Route[];
    dynamicRoutes: Route[];
    onMatch: Route[];
    fallback: Route[];
    shouldNormalizeNextData: boolean;
    rsc: {
      header: string;
      varyHeader: string;
      prefetchHeader: string;
      suffix: string;
      prefetchSuffix: string;
      prefetchSegmentHeader: string;
      prefetchSegmentSuffix: string;
      prefetchSegmentDirSuffix: string;
      contentTypeHeader: string;
    };
  };

  // All output pathnames, passed to resolveRoutes({ pathnames: ... })
  pathnames: string[];

  // i18n config, passed to resolveRoutes({ i18n: ... })
  i18n: {
    defaultLocale: string;
    locales: string[];
    localeDetection?: boolean;
    domains?: Array<{
      defaultLocale: string;
      domain: string;
      http?: boolean;
      locales?: string[];
    }>;
  } | null;

  buildId: string;
  basePath: string;

  // --- Middleware ---

  middleware: {
    filePath: string; // path to .next/server/middleware.js
  } | null;

  // --- GKE-specific: pool assignments and PPR metadata ---

  // Pool assignments: matched pathname → pool name
  poolAssignments: Record<string, string>;
  // e.g. { '/': 'ssr', '/blog/[slug]': 'ssr', '/api/health': 'api' }

  // PPR metadata for routes that use partial prerendering
  pprRoutes: Record<
    string,
    {
      postponedState: string;
      fallbackFilePath: string;
    }
  >;

  // Build metadata
  nextVersion: string;
}
```

---

## 6. Design Decisions

### 6.1 Container Build Strategy: Traced Assets vs. Full Build Output

**Resolved:** Use traced `assets` from the adapter API to build minimal per-pool containers.

Each output in `onBuildComplete` includes `assets: Record<string, string>` — a map of every file the entry point needs (traced via `@vercel/nft`). The adapter unions the assets across all outputs assigned to a pool and builds a container containing only those files.

This is the right approach because:

- The adapter API's `assets` field exists specifically for this purpose
- Per-pool containers contain only the code needed to serve their assigned routes
- The `standalone` output mode is likely to be deprecated in favor of the adapter API
- The AWS adapter already uses per-function artifact staging (`stageFunctionArtifacts`) that copies only the files each function needs — the same concept applied per-pool

The adapter config controls the granularity:

```typescript
{
  containerStrategy: 'traced-assets',   // default: per-pool minimal containers
  // containerStrategy: 'shared-image', // fallback: single image for all pools
}
```

**`shared-image` fallback:** For operators who prefer a single Docker image across all pools (simpler CI/CD, one image to scan), the adapter can build one container containing all outputs. The pool split is purely at the routing layer — each pool's HPA scales independently, but every replica has the full application. This doesn't require `output: 'standalone'`; the adapter bundles the `.next` output and only the traced dependencies. This is also recommended when many pools are defined (e.g., 10+) to avoid building and pushing 10+ Docker images per deploy — one image serves all pools, with routing handling the decomposition.

### 6.2 SSR Pool Server: How Requests Are Actually Served

**Resolved:** Direct entry point invocation, following the AWS adapter's pattern.

Each pool runs a lightweight Node.js HTTP server that imports handler modules directly from the build output and invokes them per-request. There is no dependency on `next-server`, `next start`, or `MINIMAL_MODE`. The route extension has already resolved the route and selected the pool — the pool server just needs to dispatch to the correct handler.

This matches the AWS adapter's `createNodeFunctionArtifactInvoker` pattern:

1. At startup, the pool server reads a **pool manifest** (generated by the adapter) that maps route pathnames to handler module paths for this pool's outputs.
2. Handler modules are lazily loaded via `import()` on first request and cached.
3. The handler export is resolved by looking for `handler`, `default`, `default.handler`, or `fetch` (same resolution order as the AWS adapter's `resolveRouteHandlerExport`).
4. The handler is invoked with `(req, res, ctx)` where `ctx` includes `requestMeta` with `outputId`, `matchedPathname`, and `routeMatches` from the route extension's headers.

```typescript
// Pool server (simplified)
import { createServer } from "node:http";

const poolManifest = JSON.parse(readFileSync("/config/pool-manifest.json", "utf-8"));
const handlerCache = new Map<string, ArtifactRouteHandler>();

async function loadHandler(outputId: string): Promise<ArtifactRouteHandler> {
  let handler = handlerCache.get(outputId);
  if (handler) return handler;

  const entry = poolManifest.outputs[outputId];
  const module = await import(entry.filePath);
  handler = resolveRouteHandlerExport(module);
  handlerCache.set(outputId, handler);
  return handler;
}

createServer(async (req, res) => {
  // These headers were set by the route extension
  const outputId = req.headers["x-output-id"];
  const matchedPathname = req.headers["x-matched-pathname"];
  const routeMatches = req.headers["x-route-matches"];

  const handler = await loadHandler(outputId);
  await handler(req, res, {
    waitUntil(p: Promise<unknown>) {
      void p.catch(() => {});
    },
    requestMeta: {
      outputId,
      matchedPathname,
      routeMatches: routeMatches ? JSON.parse(routeMatches) : null,
    },
  });
}).listen(3000);
```

**Why not `next start` / minimal mode:**

- `standalone` and `MINIMAL_MODE` are likely to be deprecated in favor of the adapter API's handler invocation pattern
- The AWS adapter already proves direct handler invocation works in production — it handles RSC, streaming, suspense, and `use cache` without `next-server`
- Faster cold starts: only the handlers for this pool's routes are loaded, not the entire framework
- Smaller attack surface: no `next-server` module, no internal routing logic
- The handler interface (`handler(req, res, ctx)`) is the contract the adapter API is designed around — it's what adapters are supposed to use

**What the route extension needs to pass:** The route extension must set headers that identify which handler to invoke. The `resolveRoutes` result includes `invocationTarget` with the output ID and matched pathname. These are forwarded as request headers (`x-output-id`, `x-matched-pathname`, `x-route-matches`) so the pool server can dispatch without re-resolving the route.

### 6.3 Middleware Execution Location

**Resolved:** Middleware runs in the Route Extension Service (pre-CDN).

This is not an open question — the architecture requires it. Middleware must execute before Cloud CDN cache lookup so it can protect cached routes (auth gates, geo-redirects, A/B bucketing). This matches Vercel's model exactly: middleware runs on every request, including those that result in CDN cache hits.

The Route Extension Service is registered as an `LbRouteExtension` callout on the GCP Application Load Balancer. It runs before URL map evaluation and CDN, receives only request headers (no body), and can return `immediate_response` for redirects or set headers that influence CDN cache keys and backend routing.

**Constraint:** Route extensions cannot access the request body. Next.js middleware almost never reads the body, so this is not a practical limitation. For the rare case where middleware needs body access (e.g., CSRF token validation on POST), the middleware should use `NextResponse.next()` and the validation should happen in the API route handler itself.

### 6.4 PPR Resumption Architecture

**Resolved:** PPR is handled by the pool server using cache-first preamble serving.

The key insight: the PPR preamble (static shell with Suspense fallback markers) is **known at build time** — it's in the prerender output (`outputs.prerenders[].fallback.filePath`). The postponed state needed for resumption is also available at build time (`outputs.prerenders[].fallback.postponedState`). There's no reason to hit the SSR pool to generate the shell on every request.

**Cache-first PPR flow:**

1. **At deploy time:** The adapter pre-seeds Valkey with PPR preambles and postponed state from the prerender outputs. Key: route pathname → value: `{ preamble, postponedState }`.
2. **At request time (pool server):**
   - The route extension identifies the PPR route and passes dispatch metadata to the pool server
   - The pool server reads the preamble from Valkey (sub-millisecond, in-cluster)
   - **Immediately** starts streaming the preamble to the client
   - **In parallel**, invokes the resume handler directly (the handler module is already loaded in the pool server — see §6.2) with the postponed state
   - Concatenates the resume output (RSC payload `<script>` tags that replace Suspense fallbacks) onto the response stream after the preamble

```
Client                     Pool Server                    Valkey
  │                            │                            │
  │──GET /dashboard───────────►│                            │
  │                            │──GET preamble──────────────►│
  │                            │◄──preamble HTML────────────│
  │◄──start streaming shell────│                            │
  │   (fallback UI visible)    │──invoke resume handler     │
  │                            │  (in-process, with         │
  │                            │   postponedState)           │
  │                            │  ...rendering...           │
  │◄──stream RSC payload───────│                            │
  │   (fallbacks replaced)     │                            │
  │◄──EOF──────────────────────│                            │
```

**Why this is better than the traffic extension approach:**

- **No extra network hop** — the preamble comes from Valkey (in-cluster cache), not from an SSR pool round-trip that the traffic extension then intercepts
- **No traffic extension needed for PPR** — the pool server handles everything in-process. This eliminates the `GCPTrafficExtension` resource and the separate PPR service Deployment entirely
- **Resume is in-process** — the pool server already has the handler module loaded (§6.2). It invokes the handler directly with the postponed state, same as it would for any other request. No second HTTP request to the SSR pool.
- **Preamble is always fast** — Valkey read is sub-millisecond. The user sees the shell (with fallback UI) almost instantly, then dynamic content streams in as it resolves.

**ISR interaction:** When an ISR PPR page revalidates (via stale-while-revalidate in §9 or on-demand revalidation in §9.5), the new preamble and postponed state are written to Valkey. Subsequent requests pick up the new preamble automatically.

**CDN interaction:** Cloud CDN can cache the **full streamed response** (preamble + resume output) for pages where all dynamic content is also cached (via `'use cache'`). On CDN hit, the client gets the complete page — the pool server is never involved. On CDN miss, the cache-first flow above kicks in. The route extension sets appropriate `Cache-Control` headers based on the route's caching configuration.

### 6.5 Edge Runtime Routes

The stable adapter API surfaces `runtime: 'edge'` on outputs, with `edgeRuntime` metadata containing `{ modulePath, entryKey, handlerExport }`. Edge entrypoints use the `handler(request: Request, ctx)` interface (Web API, not Node.js).

GKE has no native edge runtime.

**Option A: Run as Node.js** — ignore the edge annotation and run everything on Node.js. Edge-compatible code is a strict subset of Node.js, so this always works. For handler invocation, the pool server should detect `runtime: 'edge'` and use the edge invocation pattern: load the module, read from `globalThis._ENTRIES[entryKey]`, and invoke `handlerExport` with a Fetch `Request`.

**Option B: Target Cloud Run** — deploy edge-annotated routes to Cloud Run, which has faster cold starts and auto-scales to zero.

**Recommendation:** Option A for v1. The pool server runs all handlers as Node.js. Edge-specific invocation (via `edgeRuntime` metadata) should be added as a follow-up to properly handle edge entrypoints that use `globalThis._ENTRIES` registration. Document Option B as a future enhancement.

**Monorepo support:** The stable adapter API provides `ctx.repoRoot` alongside `ctx.projectDir`. For monorepo deployments where the Next.js project is nested (e.g., `apps/web/`), adapters should use `repoRoot` for Docker build context and `projectDir` for Next.js-specific paths. The current implementation uses `projectDir` for both, which works for single-project repos but may need adjustment for monorepos.

### 6.6 Skew Protection

During deployments, clients that loaded the old version's HTML/JS may make subsequent requests (RSC navigations, server actions, prefetches) that expect the old version's responses. Without skew protection, these requests hit the new deployment and get mismatched RSC payloads, broken hydration, or forced full-page reloads.

Vercel solves this by routing old-version clients to the matching deployment. Our architecture can do the same — the route extension is the single decision point and already knows the `buildId`.

**How it works:**

1. **Versioned pool Deployments** — the Helm chart deploys pool servers as `{pool}-{buildId}` (e.g., `ssr-a1b2c3d4`). On each deployment, the previous version's pools are kept alive alongside the new ones for a configurable duration.

2. **Route extension compares buildId** — Next.js clients send the deployment's buildId in RSC request headers. The route extension compares this against its current manifest's `buildId`:
   - **Match** → normal routing to current pools
   - **Mismatch** → check if the old buildId's pools are still running. If yes, route to `{pool}-{oldBuildId}`. If no, fall through to current pools (Next.js handles the mismatch, typically a full reload).

3. **Previous routing manifest** — the route extension keeps a short-lived cache of the previous manifest so it can correctly resolve routes for old-version requests. On startup, it loads both the current manifest and the previous one (if it exists in the ConfigMap).

4. **TTL-based cleanup** — a Helm post-deploy hook or CronJob deletes the old pool Deployments and Services after the skew protection window expires.

```
Deployment timeline:

  t=0    New build deployed (buildId: b5c6d7e8)
         ├── ssr-b5c6d7e8 (new) — created
         ├── ssr-a1b2c3d4 (old) — still running
         └── Route extension: routes b5c6d7e8 → new, a1b2c3d4 → old

  t=5m   Skew protection window expires
         ├── ssr-b5c6d7e8 (new) — serving all traffic
         ├── ssr-a1b2c3d4 (old) — deleted
         └── Route extension: routes everything → new
```

**Route extension logic:**

```typescript
function resolvePoolForRequest(
  clientBuildId: string | undefined,
  pool: string,
  manifest: RoutingManifest,
  previousManifest: RoutingManifest | null,
): string {
  // No buildId header → first visit, use current
  if (!clientBuildId) return `${pool}-${manifest.buildId}`;

  // Matches current → use current
  if (clientBuildId === manifest.buildId) return `${pool}-${manifest.buildId}`;

  // Matches previous and previous pools still exist → skew protection
  if (previousManifest && clientBuildId === previousManifest.buildId) {
    return `${pool}-${previousManifest.buildId}`;
  }

  // Unknown buildId (too old, or client error) → use current
  // Next.js will detect the mismatch and trigger a full reload
  return `${pool}-${manifest.buildId}`;
}
```

**Configuration:**

```typescript
// In K8sAdapterConfig (shared config)
{
  skewProtection: {
    enabled: true,          // default: true
    duration: '5m',         // how long old pools stay alive after new deployment
                            // default: '5m'. Set to '0' to disable.
    // Future: maxVersions: 2  // keep N previous versions (for canary/gradual rollouts)
  },
}
```

**Helm chart implications:**

- **Versioned** (include `buildId` in name): Pool Deployments, Pool Services, routing manifest ConfigMap
- **Not versioned** (shared across versions): Image optimizer, Valkey, GCS NEG, external proxy, Gateway, HTTPRoute, routing service Deployment
- The `values.yaml` includes both `buildId` and `previousBuildId` (tracked by `.k8s-adapter/state.json`)
- HTTPRoute includes rules for both current and previous versioned pool names (§13.4)
- Routing service ConfigMap mounts both current and previous routing manifests so the route extension can resolve routes for old-version clients
- A `post-upgrade` Helm hook creates a delayed Job that deletes the previous version's Deployments, Services, and Valkey keys after `skewProtection.duration`

**Valkey key namespacing:**

All Valkey cache keys are namespaced by `buildId` to prevent cross-version contamination:

| Key pattern                               | Example                                  |
| ----------------------------------------- | ---------------------------------------- |
| `next:{buildId}:prerender:{pathname}`     | `next:a1b2c3d4:prerender:/blog/hello`    |
| `next:{buildId}:ppr:{pathname}`           | `next:a1b2c3d4:ppr:/dashboard`           |
| `next:{buildId}:ppr:{pathname}:postponed` | `next:a1b2c3d4:ppr:/dashboard:postponed` |
| `next:{buildId}:cache:{key}`              | `next:a1b2c3d4:cache:getUser-42`         |
| `next:{buildId}:tag:{tag}`                | `next:a1b2c3d4:tag:blog`                 |

Each deployment's pool servers read/write only their own buildId-namespaced keys. Old-version pools read old keys, new-version pools read new keys — no cross-contamination even when both are running simultaneously.

The prerender seed job (§9.6) writes keys under the new `buildId` namespace. The old namespace's keys remain untouched until the cleanup job runs.

**Cleanup:** When the skew protection window expires, the Helm cleanup Job:

1. Deletes the old pool Deployments and Services
2. Scans and deletes all `next:{oldBuildId}:*` keys from Valkey (via `SCAN` + `DEL` to avoid blocking)
3. Optionally invalidates Cloud CDN entries tagged with the old buildId

**CDN cache isolation:**

Cloud CDN needs to serve the correct version's response for each client. Three mechanisms work together:

1. **`Cache-Tag` with buildId** — the pool server includes the `buildId` in every response's `Cache-Tag` header (e.g., `Cache-Tag: build-a1b2c3d4,blog,post-123`). This allows per-version CDN invalidation on deployment.

2. **`Vary` on version header** — the route extension sets an `x-build-id` response header. The pool server includes `Vary: x-build-id` on cacheable responses so CDN stores separate entries per version. Old-version clients (whose requests carry the old buildId via the route extension's header manipulation) get the old cached response.

3. **Static assets are content-addressed** — `/_next/static/` files have content hashes in their filenames, so old and new versions coexist in CDN without conflict. No invalidation needed.

On skew protection window expiry, the cleanup job sends a CDN tag-based invalidation for `build-{oldBuildId}` to purge all old-version entries.

**Cost:** During the skew protection window, both old and new pool pods are running and both buildId namespaces exist in Valkey. For the default 5-minute window, this doubles pool pod count briefly and roughly doubles Valkey memory usage for cached entries. For most deployments this is negligible. Operators can set `duration: '0'` to disable and rely on Next.js's built-in mismatch handling (full page reload).

---

## 7. Service Extensions Architecture

The adapter deploys a single ext_proc service — the Route Extension Service — that plugs into GCP's Application Load Balancer before CDN cache lookup. This mirrors Vercel's model: middleware and routing decisions run on every request before CDN. PPR streaming is handled by the pool servers themselves (§6.4, §7.4), not by a separate traffic extension.

### 7.1 Route Extension Service (Pre-CDN)

A Node.js gRPC service registered as a **route extension callout**. It runs before URL map evaluation and Cloud CDN cache lookup on every inbound request. This is the primary decision-maker.

**Responsibilities:**

- Resolve the route using `@next/routing` with build manifest data
- Execute Next.js middleware (redirects, rewrites, auth gates, A/B bucketing)
- Set `x-upstream-pool` header to direct the URL map to the correct backend
- Set `x-nextjs-ppr: 1` header on PPR routes so the pool server uses cache-first PPR flow
- Return `immediate_response` for middleware short-circuits (redirects, direct responses)

**Dependencies:**

- `@next/routing` — `resolveRoutes()` for route resolution, middleware invocation, i18n, RSC handling (same API the AWS adapter uses)
- `@connectrpc/connect-node` (or `@connectrpc/connect-fastify`) — gRPC ext_proc server
- Compiled middleware module from `.next/server/middleware.js`
- Routing manifest JSON (generated by adapter, mounted as ConfigMap — see §5.3)

**Not a dependency:**

- `next` / `next-server` — the routing service does not render pages
- Application code — it only needs the routing manifest and middleware

**Cold start:** The route extension loads two things at startup: the routing manifest JSON (small, sync `readFileSync`) and the middleware module (async `import()`). Cold start is typically <500ms. With `minReplicas: 2` (the default), at least one replica is always warm. The HPA should never scale to zero — set `minReplicas` to at least 2 in production.

**Constraints (route extension limitations):**

- Headers only — no request body access (not needed for middleware)
- Cannot process responses — response handling is done by the pool server
- Cannot override processing mode

### 7.2 ext_proc Lifecycle — Route Extension

The route extension receives only `REQUEST_HEADERS`. The load balancer sends a `ProcessingRequest`; the service responds with header mutations or an immediate response.

```
GCP ALB                        Route Extension Service
  │                                  │
  │──requestHeaders──────────────────►│
  │                                  │ 1. Resolve route via @next/routing
  │                                  │ 2. Check middleware matchers
  │                                  │ 3. Execute middleware if matched
  │                                  │ 4. Determine upstream pool
  │                                  │
  │  ┌─── middleware short-circuits? ─┤
  │  │                                │
  │  │ YES: redirect/rewrite/response │
  │◄─┤── immediateResponse ──────────│
  │  │                                │
  │  │ NO: continue with mutations    │
  │◄─┤── headerMutation ─────────────│
  │  │    (x-upstream-pool, cookies,  │
  │  │     x-nextjs-ppr, etc.)       │
  │  └────────────────────────────────┤
  │                                  │
  │   ... ALB evaluates URL map ...  │
  │   ... Cloud CDN cache lookup ... │
  │   ... CDN hit → serve from cache │
  │   ... CDN miss → route to pool   │
```

### 7.3 Route Resolution and Middleware (Unified)

Route resolution and middleware execution are handled together by `resolveRoutes` from `@next/routing`. This is the same API the AWS adapter uses at runtime — middleware invocation is a callback within the resolution process, not a separate step.

Because this runs as a route extension, `resolveRoutes` executes on **every request before CDN cache lookup** — matching Vercel's behavior where middleware protects cached routes.

```typescript
import { resolveRoutes } from "@next/routing";

const manifest: RoutingManifest = JSON.parse(
  readFileSync("/config/routing-manifest.json", "utf-8"),
);

// The middleware module, loaded once at startup from the build output
const middlewareModule = manifest.middleware ? await import(manifest.middleware.filePath) : null;

async function handleRequest(requestHeaders: HeaderValue[]): Promise<ExtProcResponse> {
  const path = getHeader(requestHeaders, ":path")!;
  const method = getHeader(requestHeaders, ":method") || "GET";
  const scheme = getHeader(requestHeaders, ":scheme")!;
  const authority = getHeader(requestHeaders, ":authority")!;
  const url = new URL(`${scheme}://${authority}${path}`);

  // Build a Headers object from ext_proc headers (drop HTTP/2 pseudo-headers)
  const headers = new Headers(
    requestHeaders
      .filter((h) => !h.key.startsWith(":"))
      .map((h) => [h.key, decodeHeaderValue(h)] as [string, string]),
  );

  // Track middleware response if middleware short-circuits
  let middlewareResponse: Response | null = null;

  // resolveRoutes handles the full routing pipeline:
  // beforeMiddleware → middleware → beforeFiles → filesystem → afterFiles →
  // dynamicRoutes → fallback
  const resolution = await resolveRoutes({
    url,
    buildId: manifest.buildId,
    basePath: manifest.basePath,
    // Route extensions are headers-only — no request body access.
    // This is fine: Next.js middleware almost never reads the body.
    requestBody: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    headers,
    pathnames: manifest.pathnames,
    i18n: manifest.i18n ?? undefined,
    routes: manifest.routeGraph,
    invokeMiddleware: middlewareModule
      ? async (ctx) => {
          // @next/routing passes the middleware context; we invoke the module
          // following the same pattern as the Firebase ext_proc proof-of-concept
          const result = await middlewareModule.default.default({
            request: ctx.request,
          });
          await result.waitUntil;
          if (result.response) {
            middlewareResponse = result.response;
          }
          // Return the MiddlewareResult (without the Response) back to
          // resolveRoutes so it can apply header mutations and continue
          const { response: _, ...middlewareResult } = result;
          return middlewareResult;
        }
      : undefined,
  });

  // --- Translate resolution to ext_proc response ---

  // 1. Redirect (from routing rules or middleware)
  if (resolution.redirect) {
    return immediateResponse(resolution.redirect.status, {
      location: resolution.redirect.url.toString(),
    });
  }

  // 2. Middleware short-circuited with a full response
  if (resolution.middlewareResponded && middlewareResponse) {
    return immediateResponse(
      middlewareResponse.status,
      Object.fromEntries(middlewareResponse.headers),
      await middlewareResponse.text(),
    );
  }

  // 3. External rewrite (e.g., middleware rewrites to an external URL)
  // Next.js rewrites are transparent proxies (URL stays the same in the
  // browser). Route extensions can't proxy — they can only mutate headers
  // or return immediate responses.
  //
  // v1: External rewrites are not supported. Return an error response
  // with a clear message. Users should use Route Handlers to proxy
  // external APIs instead.
  //
  // v2+: A dedicated external-proxy backend pool (lightweight Node.js
  // service or Envoy sidecar) that reads x-rewrite-target, fetches the
  // external URL with streaming support, and pipes the response back.
  // This needs its own Deployment, scaling profile, timeout config,
  // and body size limits. See §21 Future Work.
  if (resolution.externalRewrite) {
    return immediateResponse(
      502,
      {
        "content-type": "text/plain; charset=utf-8",
      },
      `External rewrites are not supported in adapter-k8s v1. ` +
        `Attempted rewrite to: ${resolution.externalRewrite.toString()}\n` +
        `Use a Route Handler to proxy external APIs instead.`,
    );
  }

  // 4. Normal route — determine the pool and set headers
  const matchedPathname = resolution.invocationTarget?.pathname ?? path;
  const headerMutations: HeaderMutation[] = [];

  // Apply any headers from the resolution (set by routing rules or middleware)
  if (resolution.resolvedHeaders) {
    for (const [key, value] of resolution.resolvedHeaders.entries()) {
      headerMutations.push({ key, value });
    }
  }

  // Static assets → GCS (served via Cloud CDN)
  if (matchedPathname.startsWith("/_next/static/")) {
    headerMutations.push({ key: "x-upstream-pool", value: "gcs-backend" });
    return headerMutationResponse(headerMutations);
  }

  // Image optimization
  if (matchedPathname === "/_next/image") {
    headerMutations.push({ key: "x-upstream-pool", value: "image-optimizer" });
    return headerMutationResponse(headerMutations);
  }

  // Look up pool assignment and output ID for the matched route
  const pool =
    manifest.poolAssignments[matchedPathname] ||
    Object.keys(manifest.poolAssignments)[0] ||
    "default";
  headerMutations.push({ key: "x-upstream-pool", value: pool });

  // Pass dispatch metadata so the pool server can invoke the correct handler
  // directly (no re-routing needed — see §6.2)
  const outputId = resolution.invocationTarget?.id;
  if (outputId) {
    headerMutations.push({ key: "x-output-id", value: outputId });
  }
  headerMutations.push({ key: "x-matched-pathname", value: matchedPathname });
  if (resolution.routeMatches) {
    headerMutations.push({
      key: "x-route-matches",
      value: JSON.stringify(resolution.routeMatches),
    });
  }

  // Flag PPR routes so the pool server uses cache-first PPR flow
  if (matchedPathname in manifest.pprRoutes) {
    headerMutations.push({ key: "x-nextjs-ppr", value: "1" });
  }

  return headerMutationResponse(headerMutations);
}
```

**Why `resolveRoutes` instead of manual middleware execution:**

The original design had separate `createRouteResolver` and `executeMiddleware` steps. The AWS adapter demonstrates a better pattern — `resolveRoutes` from `@next/routing` handles the entire pipeline (rewrites, redirects, middleware, i18n, dynamic routes, RSC resolution) as a single atomic operation. Middleware is invoked via an `invokeMiddleware` callback _within_ route resolution, which ensures middleware sees the correct pre-processed URL and that post-middleware routing rules are applied correctly.

The Firebase App Hosting adapter's manual middleware invocation (constructing a Fetch request and calling `middleware.default.default()`) serves as proof-of-concept for how middleware modules are invoked in an ext_proc context. The `invokeMiddleware` callback inside `resolveRoutes` uses the same underlying mechanism but with `@next/routing` managing the request lifecycle.

### 7.4 PPR Handling in the Pool Server

PPR is handled entirely by the pool server (§6.2), not by a separate traffic extension. This eliminates the need for a `GCPTrafficExtension` resource and a separate PPR service Deployment.

When the pool server receives a request for a PPR route (identified by the `x-nextjs-ppr: 1` header from the route extension):

```typescript
async function handlePPRRequest(
  req: IncomingMessage,
  res: ServerResponse,
  outputId: string,
  matchedPathname: string,
  routeMatches: Record<string, string> | null,
) {
  // 1. Read the cached preamble and postponed state from Valkey
  const cache = await getClient();
  const pprEntry = await cache.get(`next:ppr:${matchedPathname}`);
  if (!pprEntry) {
    // Fallback: no cached preamble, do a full render
    return handleFullRender(req, res, outputId, matchedPathname, routeMatches);
  }

  const { preamble, postponedState } = JSON.parse(pprEntry);

  // 2. Start streaming the preamble immediately
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "transfer-encoding": "chunked",
  });
  res.write(preamble);

  // 3. In parallel, invoke the resume handler (in-process, no network hop)
  const handler = await loadHandler(outputId);
  const resumeReq = createResumeRequest(req, {
    postponedState,
    matchedPathname,
    routeMatches,
  });

  // The resume handler streams RSC payload <script> tags that replace
  // Suspense fallbacks in the client
  const resumeRes = new PassThrough();
  handler(resumeReq, resumeRes, {
    waitUntil(p: Promise<unknown>) {
      void p.catch(() => {});
    },
    requestMeta: {
      outputId,
      matchedPathname,
      routeMatches,
      postponed: postponedState,
    },
  });

  // 4. Pipe the resume output after the preamble
  for await (const chunk of resumeRes) {
    res.write(chunk);
  }
  res.end();
}
```

This approach is simpler and faster than a traffic extension because:

- The preamble comes from Valkey (sub-millisecond) instead of an SSR pool round-trip
- The resume handler is invoked in-process — no second HTTP request
- No `GCPTrafficExtension` to manage, no separate PPR service to scale
- The pool server already has the handler modules loaded (§6.2)

---

## 8. Distributed Cache Handler

### 8.1 Purpose

Next.js's built-in cache is in-memory and per-process. With multiple replicas in a pool, this means:

- ISR revalidation on one replica isn't visible to others
- `use cache` entries are duplicated across replicas
- `revalidateTag()` / `updateTag()` only invalidates the local process

The adapter provides **two** cache handler implementations backed by a shared Redis/Valkey instance:

1. **`cacheHandler`** (singular) — handles ISR, route handler responses, and image optimization. Uses the legacy `get`/`set`/`revalidateTag` API. Set via `next.config.ts` `cacheHandler` field.
2. **`cacheHandlers`** (plural) — handles `'use cache'` and `'use cache: remote'` directives. Uses the newer `CacheHandler` interface with `ReadableStream` values, `refreshTags`, `getExpiration`, and `updateTags`. Set via `next.config.ts` `cacheHandlers` field.

Both connect to the same Valkey instance but use different key prefixes and serialization formats to match their respective Next.js APIs. **All keys are namespaced by `buildId`** for skew protection (§6.6) — each deployment version reads/writes only its own namespace, preventing cross-version contamination during rolling deployments.

**ReadableStream serialization for `cacheHandlers`:**

The `cacheHandlers` API (for `'use cache'`) uses `ReadableStream<Uint8Array>` values in `CacheEntry`, unlike the `cacheHandler` API which uses plain JSON-serializable objects. Storing streams in Valkey requires:

1. **On `set`:** Buffer the entire stream to a `Uint8Array` before storing. The `pendingEntry` is a `Promise<CacheEntry>` — await it, then read the stream via `.getReader()` and concatenate chunks. Store the buffer as a binary Valkey value (not JSON-encoded — use raw bytes to avoid base64 overhead).
2. **On `get`:** Reconstruct a `ReadableStream` from the stored buffer. Create a new `ReadableStream` that enqueues the buffer in a single chunk and closes. This is what the Next.js default handler and the AWS adapter's Redis example both do.
3. **Back-pressure:** Not a concern for Valkey storage — we buffer the full stream before writing. For very large cached values (e.g., large RSC payloads), the buffer fits in memory since Next.js already materialized the stream. Valkey's max value size (512 MiB default) is well above any reasonable cache entry.
4. **Stream errors:** If the stream errors during `set`, discard the partial entry — don't store incomplete cache entries. The `set` method should catch stream read errors and silently skip caching.

```typescript
// Simplified cacheHandlers implementation (set method)
async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
  const entry = await pendingEntry;
  const reader = entry.value.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch {
    return; // Stream errored — discard partial entry
  } finally {
    reader.releaseLock();
  }
  const buffer = Buffer.concat(chunks);
  const metadata = { tags: entry.tags, stale: entry.stale, timestamp: entry.timestamp, expire: entry.expire, revalidate: entry.revalidate };
  const redis = await getClient();
  const pipeline = redis.multi();
  pipeline.set(keyPrefix(cacheKey) + ':meta', JSON.stringify(metadata));
  pipeline.set(keyPrefix(cacheKey) + ':body', buffer); // raw bytes
  if (entry.expire > 0) {
    pipeline.expire(keyPrefix(cacheKey) + ':meta', entry.expire);
    pipeline.expire(keyPrefix(cacheKey) + ':body', entry.expire);
  }
  await pipeline.exec();
}
```

### 8.2 Implementation

```typescript
// incremental-cache-handler.ts (cacheHandler — ISR, route handlers, images)
import { createClient, type RedisClientType } from "redis";

let client: RedisClientType;
// buildId is injected at build time by the adapter or read from env
const buildId = process.env.NEXT_BUILD_ID!;

async function getClient() {
  if (!client) {
    client = createClient({ url: process.env.CACHE_REDIS_URL });
    await client.connect();
  }
  return client;
}

// All keys namespaced by buildId for skew protection (§6.6)
const keyPrefix = (key: string) => `next:${buildId}:cache:${key}`;
const tagPrefix = (tag: string) => `next:${buildId}:tag:${tag}`;

export default class K8sCacheHandler {
  async get(key: string) {
    const redis = await getClient();
    const raw = await redis.get(keyPrefix(key));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (entry.revalidateAfter && Date.now() > entry.revalidateAfter) {
      return null;
    }
    return entry;
  }

  async set(key: string, data: any, ctx: { revalidate?: number | false; tags?: string[] }) {
    const redis = await getClient();
    const entry = {
      ...data,
      revalidateAfter: ctx.revalidate ? Date.now() + ctx.revalidate * 1000 : undefined,
    };

    const pipeline = redis.multi();

    if (ctx.revalidate && ctx.revalidate > 0) {
      pipeline.set(keyPrefix(key), JSON.stringify(entry), { EX: ctx.revalidate });
    } else if (ctx.revalidate === false) {
      pipeline.set(keyPrefix(key), JSON.stringify(entry));
    } else {
      pipeline.set(keyPrefix(key), JSON.stringify(entry), { EX: 3600 });
    }

    if (ctx.tags?.length) {
      for (const tag of ctx.tags) {
        pipeline.sAdd(tagPrefix(tag), key);
      }
    }

    await pipeline.exec();
  }

  async revalidateTag(tags: string | string[]) {
    const redis = await getClient();
    const tagList = Array.isArray(tags) ? tags : [tags];

    for (const tag of tagList) {
      const keys = await redis.sMembers(tagPrefix(tag));
      if (keys.length) {
        await redis.del(keys.map((k) => keyPrefix(k)));
      }
      await redis.del(tagPrefix(tag));
    }

    // Also invalidate Cloud CDN entries with matching tags (§9.7)
    await invalidateCDNByTags(tagList);
  }
}
```

### 8.3 Helm Deployment

The cache is deployed as a Valkey StatefulSet within the Helm chart. Operators can override to use GCP Memorystore or an existing Redis instance via values.

**Production recommendation:** Use **GCP Memorystore** (`mode: external`) rather than the in-cluster Valkey StatefulSet. PPR preambles, `use cache` entries, and ISR cache are all heavily reliant on Valkey (§15.2). An in-cluster StatefulSet has no HA by default — a pod restart means cache loss and a cold ISR/PPR experience until entries are regenerated. Memorystore provides automatic failover, persistence, and monitoring without operational overhead.

```yaml
cache:
  enabled: true
  # 'internal' deploys Valkey in-cluster; 'external' uses a provided URL
  # Production: use 'external' with GCP Memorystore for HA
  mode: internal
  # Only used when mode=external
  # url: redis://memorystore-instance:6379
  replicas: 1
  memory: 512Mi
  persistence:
    enabled: true
    size: 2Gi
```

---

## 9. Pool Server Cache Orchestration

The cache handlers (§8) provide the storage layer. This section describes the **orchestration logic** in the pool server that decides when to serve from cache, when to invoke a handler, and when to trigger background revalidation. This follows the AWS adapter's `createRouterRuntime` pattern.

### 9.1 Request Lifecycle in the Pool Server

When a request reaches the pool server (after the route extension and CDN), the pool server runs the following decision tree:

```
Request arrives (with x-output-id, x-matched-pathname, x-nextjs-ppr headers)
  │
  ├─ Is this a prerender route? (check pool manifest)
  │   │
  │   ├─ YES: Check prerender cache in Valkey
  │   │   │
  │   │   ├─ HIT (fresh): Serve cached response immediately
  │   │   │
  │   │   ├─ STALE: Serve cached response immediately
  │   │   │         + enqueue background revalidation
  │   │   │
  │   │   ├─ MISS (with fallback/PPR preamble):
  │   │   │   Stream fallback/preamble from cache
  │   │   │   + invoke handler in parallel (resume for PPR, full render for ISR)
  │   │   │   + cache the generated response
  │   │   │
  │   │   └─ MISS (no fallback): Invoke handler directly
  │   │                          + cache the generated response
  │   │
  │   └─ Is this an on-demand revalidation request? (x-prerender-revalidate)
  │       Invoke handler, cache result, return 200 with x-nextjs-cache: REVALIDATED
  │
  ├─ Is this a PPR route? (x-nextjs-ppr: 1)
  │   Read preamble from Valkey, stream it,
  │   invoke resume handler in parallel (§6.4)
  │
  └─ Normal route: Invoke handler directly
```

### 9.2 Prerender Cache States

Following the AWS adapter's pattern, the pool server tracks cache state for every prerender response:

| State    | Condition                                                              | Behavior                                                                              |
| -------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `HIT`    | Entry exists, within `revalidate` TTL, tags not expired                | Serve from Valkey immediately                                                         |
| `STALE`  | Entry exists, past `revalidate` TTL but not expired, OR tags are stale | Serve from Valkey immediately, **enqueue background revalidation + CDN invalidation** |
| `MISS`   | No entry, or tags expired, or cache bypassed                           | Invoke parent handler, cache the response                                             |
| `BYPASS` | Draft mode or on-demand revalidation request                           | Skip cache entirely, invoke handler                                                   |

**`Cache-Tag` response header:** Every cacheable response served by the pool server includes a `Cache-Tag` header with the entry's Next.js cache tags. Cloud CDN stores these tags as metadata, enabling tag-based CDN invalidation later (see §9.7). This is set by the pool server on both fresh renders and cache hits.

```typescript
async function handlePrerenderRoute(
  req: IncomingMessage,
  res: ServerResponse,
  seed: PrerenderSeed,
  outputId: string,
  matchedPathname: string,
  routeMatches: Record<string, string> | null,
): Promise<void> {
  const cache = await getClient();
  // All cache keys namespaced by buildId for skew protection (§6.6)
  const cacheKey = `next:${buildId}:prerender:${matchedPathname}`;

  // 1. Check for on-demand revalidation (revalidatePath / revalidateTag)
  const revalidateToken = req.headers["x-prerender-revalidate"];
  if (revalidateToken && isValidRevalidateToken(revalidateToken, seed)) {
    const response = await invokeHandler(req, outputId, matchedPathname, routeMatches);
    await cacheResponse(cache, cacheKey, response, seed);
    // Invalidate Cloud CDN so the stale version is purged
    await invalidateCDNPath(matchedPathname);
    res.setHeader("x-nextjs-cache", "REVALIDATED");
    return pipeResponse(response, res);
  }

  // 2. Check prerender cache
  const cachedEntry = await cache.get(cacheKey);
  const now = Date.now();

  if (cachedEntry) {
    const evaluation = evaluateEntry(cachedEntry, now, seed);

    if (evaluation === "fresh") {
      // HIT: serve directly from cache
      res.setHeader("x-nextjs-cache", "HIT");
      setCacheTagHeader(res, cachedEntry.tags);
      return serveCachedEntry(cachedEntry, res);
    }

    if (evaluation === "stale") {
      // STALE: serve from cache, revalidate in background (includes CDN invalidation)
      res.setHeader("x-nextjs-cache", "STALE");
      setCacheTagHeader(res, cachedEntry.tags);
      enqueueBackgroundRevalidation(outputId, matchedPathname, routeMatches, seed);
      return serveCachedEntry(cachedEntry, res);
    }
  }

  // 3. MISS: check for fallback/PPR preamble
  if (seed.preamble) {
    // PPR: stream preamble + resume in parallel (§6.4)
    return handlePPRRequest(req, res, outputId, matchedPathname, routeMatches);
  }

  if (seed.fallback) {
    // ISR with fallback: serve fallback, invoke handler in background, cache result
    const handlerPromise = invokeHandler(req, outputId, matchedPathname, routeMatches);
    handlerPromise.then((response) => cacheResponse(cache, cacheKey, response, seed));
    return serveFallback(seed.fallback, res);
  }

  // 4. No fallback: invoke handler directly, cache result
  const response = await invokeHandler(req, outputId, matchedPathname, routeMatches);
  await cacheResponse(cache, cacheKey, response, seed);
  res.setHeader("x-nextjs-cache", "MISS");
  setCacheTagHeader(res, seed.tags);
  return pipeResponse(response, res);
}

function setCacheTagHeader(res: ServerResponse, tags: string[]): void {
  // Cloud CDN uses Cache-Tag header for tag-based invalidation
  // Always include buildId tag for per-version CDN invalidation on deployment (§6.6)
  // Limit: 50 tags per object, 120 bytes per tag, 4 KiB total
  const allTags = [`build-${buildId}`, ...tags];
  res.setHeader("Cache-Tag", allTags.join(","));
}
```

### 9.3 Background Revalidation

When a stale entry is served, the pool server enqueues a background revalidation task. On AWS, this goes to SQS. On GKE, we have two options:

**Option A: In-process revalidation** — the pool server fires off the handler invocation in the background (via `waitUntil` or a detached promise) and updates the cache when it completes. Simple, but the revalidation happens on the same replica that served the stale response, consuming its resources.

**Option B: Pub/Sub revalidation queue** — the pool server publishes a revalidation message to GCP Pub/Sub (or a Valkey list). A dedicated revalidation worker (or any pool server replica) picks it up and invokes the handler. This decouples serving from revalidation and allows revalidation to happen on a different replica.

**Recommendation:** Option A for v1 (simpler). Option B as a future enhancement for high-traffic ISR routes where revalidation load is significant.

```typescript
function enqueueBackgroundRevalidation(
  outputId: string,
  matchedPathname: string,
  routeMatches: Record<string, string> | null,
  seed: PrerenderSeed,
): void {
  // v1: in-process background revalidation
  // The handler is invoked in the background; the response is cached when ready.
  // This runs on the same replica but doesn't block the stale response.
  void (async () => {
    try {
      const cache = await getClient();
      const cacheKey = `next:${buildId}:prerender:${matchedPathname}`;
      const response = await invokeHandler(null, outputId, matchedPathname, routeMatches);
      await cacheResponse(cache, cacheKey, response, seed);

      // Invalidate Cloud CDN so the next request picks up the fresh version.
      // This propagates in ~10 seconds. During that window, CDN may still
      // serve the stale version — acceptable for stale-while-revalidate.
      await invalidateCDNPath(matchedPathname);
    } catch (err) {
      console.error(`Background revalidation failed for ${matchedPathname}:`, err);
    }
  })();
}
```

### 9.4 Tag-Based Invalidation

Next.js supports `revalidateTag()` and `updateTag()` for invalidating cache entries by tag. The cache handler (§8) stores tag→key associations in Valkey. When tags are invalidated:

1. **`cacheHandler.revalidateTag(tags)`** — called by Next.js runtime when `revalidateTag()` is used in a Server Action or Route Handler. Deletes all Valkey cache entries associated with the given tags.
2. **`cacheHandlers.updateTags(tags)`** — called for `'use cache'` entries. Updates tag expiration timestamps in Valkey.
3. **Cloud CDN tag invalidation** — after invalidating in Valkey, the cache handler also sends a tag-based invalidation request to Cloud CDN. Because the pool server sets the `Cache-Tag` response header (§9.2) on all cacheable responses, Cloud CDN can purge all cached responses with matching tags. Cloud CDN supports up to 10 tags per invalidation request and propagates within ~10 seconds.

This two-layer invalidation (Valkey + CDN) ensures consistency: Valkey is the source of truth (sub-millisecond invalidation), and CDN is invalidated asynchronously (seconds). During the CDN propagation window, a CDN hit may serve stale content, but the next CDN miss will hit the pool server which serves the fresh version from Valkey.

The pool server also checks tag freshness at read time (following the AWS adapter's `evaluatePrerenderTagManifestState` pattern): even if a cache entry's TTL hasn't expired, if its tags have been invalidated since the entry was created, the entry is treated as stale or expired.

```typescript
function evaluateEntry(
  entry: CachedPrerenderEntry,
  now: number,
  seed: PrerenderSeed,
): "fresh" | "stale" | "miss" {
  // Check TTL-based freshness
  const revalidateMs = (seed.revalidate ?? 0) * 1000;
  if (revalidateMs > 0 && now > entry.createdAt + revalidateMs) {
    // Past revalidate window but entry still exists — stale
    return "stale";
  }

  // Check tag-based freshness
  // If any of the entry's tags have been invalidated after the entry was created,
  // the entry is stale (tag was soft-invalidated) or expired (tag was hard-invalidated)
  if (entry.tags.length > 0) {
    const tagState = checkTagFreshness(entry.tags, entry.createdAt);
    if (tagState === "expired") return "miss";
    if (tagState === "stale") return "stale";
  }

  return "fresh";
}
```

### 9.5 On-Demand Revalidation Endpoint

Next.js's `revalidatePath()` and `revalidateTag()` can be called from Server Actions and Route Handlers, which are handled by the pool server directly. But external systems (CMS webhooks, CI/CD) need an HTTP endpoint to trigger revalidation.

The pool server exposes a `/_next/revalidate` endpoint (or configurable path) that accepts:

```json
POST /_next/revalidate
{
  "paths": ["/blog/post-1", "/blog/post-2"],
  "tags": ["blog"],
  "token": "<revalidation-auth-token>"
}
```

This follows the same pattern as the AWS adapter's on-demand revalidation handling: validate the token against a configured secret, then:

1. **Invalidate Valkey** — delete matching cache entries (by path) and/or invalidate tags
2. **Invalidate Cloud CDN** — send path-based invalidation for specified paths, and/or tag-based invalidation for specified tags
3. **Optionally regenerate** — invoke the parent handler in the background to pre-warm the cache with fresh content. The revalidation endpoint returns `200` immediately after invalidation (steps 1-2); regeneration is fire-and-forget. The next user request for the invalidated path will either get the pre-warmed content (if regeneration completed) or trigger a synchronous render on MISS.

Cloud CDN invalidation limits (500 requests/minute, ~10s propagation) are well within typical on-demand revalidation volumes. For bulk invalidation (e.g., CMS publishes affecting hundreds of pages), tag-based invalidation is preferred — a single tag invalidation request purges all matching CDN entries regardless of count.

### 9.6 Prerender Seed Staging

At deploy time, the adapter pre-seeds Valkey with data from `outputs.prerenders`:

All keys are namespaced by `buildId` for skew protection (§6.6):

| Data                                 | Valkey Key                                     | Source                                                                                                   |
| ------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Prerender cache entry (initial HTML) | `next:{buildId}:prerender:{pathname}`          | `prerender.fallback.filePath` + `prerender.fallback.initialHeaders` + `prerender.fallback.initialStatus` |
| PPR preamble                         | `next:{buildId}:ppr:{pathname}`                | `prerender.fallback.filePath` (shell HTML)                                                               |
| PPR postponed state                  | `next:{buildId}:ppr:{pathname}:postponed`      | `prerender.fallback.postponedState`                                                                      |
| Tag associations                     | `next:{buildId}:tag:{tag}` → set of cache keys | `prerender.config.tags` + `x-next-cache-tags` header                                                     |
| Revalidation metadata                | `next:{buildId}:prerender:{pathname}:meta`     | `prerender.config.revalidate`, `prerender.groupId`, `prerender.parentOutputId`                           |

This is done by a Helm hook job (`ppr-cache-seed-job.yaml`) that runs after deployment. The Bun adapter's `seedPrerenderCache` function serves as a reference — it does the same thing with SQLite.

### 9.7 Cloud CDN Cache Integration

The pool server and Cloud CDN form a **two-layer cache**. Valkey is the authoritative source of truth (in-cluster, sub-millisecond). Cloud CDN is the edge layer (global, serves CDN hits without reaching the cluster). Keeping them in sync requires coordinated invalidation.

**Setting cache metadata on responses:**

The pool server sets two headers on every cacheable response that Cloud CDN uses:

| Header          | Purpose                     | Example                                           |
| --------------- | --------------------------- | ------------------------------------------------- |
| `Cache-Control` | Tells CDN how long to cache | `public, s-maxage=60, stale-while-revalidate=300` |
| `Cache-Tag`     | Tags for CDN invalidation   | `blog,post-123,author-jane`                       |

The `s-maxage` is derived from the prerender seed's `revalidate` value. The `Cache-Tag` values come from the entry's Next.js cache tags (`x-next-cache-tags` header).

**Invalidation flows:**

| Trigger                                   | Valkey                     | Cloud CDN                                                | Method      |
| ----------------------------------------- | -------------------------- | -------------------------------------------------------- | ----------- |
| Stale-while-revalidate (§9.3)             | Write fresh entry          | `invalidateCDNPath(pathname)`                            | Path-based  |
| `revalidateTag()` in Server Action (§9.4) | Delete entries by tag      | `invalidateCDNByTags(tags)`                              | Tag-based   |
| On-demand `/_next/revalidate` (§9.5)      | Delete entries by path/tag | `invalidateCDNPath()` or `invalidateCDNByTags()`         | Path or tag |
| New deployment                            | Pre-seed all entries       | Implicit (new `buildId` changes URLs for `_next/static`) | N/A         |

**CDN invalidation implementation:**

```typescript
import { compute } from "@google-cloud/compute";

const urlMapsClient = new compute.UrlMapsClient();

async function invalidateCDNPath(pathname: string): Promise<void> {
  await urlMapsClient.invalidateCache({
    project: process.env.GCP_PROJECT_ID!,
    urlMap: process.env.CDN_URL_MAP!,
    cacheInvalidationRule: {
      path: pathname,
      // Also invalidate RSC variants
      // TODO: invalidate .rsc suffix and segment prefetch paths
    },
  });
}

async function invalidateCDNByTags(tags: string[]): Promise<void> {
  // Cloud CDN supports up to 10 tags per invalidation request
  // Batch into groups of 10 if needed
  for (let i = 0; i < tags.length; i += 10) {
    const batch = tags.slice(i, i + 10);
    await urlMapsClient.invalidateCache({
      project: process.env.GCP_PROJECT_ID!,
      urlMap: process.env.CDN_URL_MAP!,
      cacheInvalidationRule: {
        cacheTags: batch,
      },
    });
  }
}
```

**Limits and constraints:**

- **500 invalidation requests per minute** — sufficient for typical ISR workloads. High-frequency revalidation should use tag-based invalidation (one request purges many entries) rather than per-path invalidation.
- **~10 second propagation** — during this window, CDN may serve stale content. This is acceptable for stale-while-revalidate semantics. For hard invalidation (`revalidateTag`), the route extension's pre-CDN position ensures middleware can gate access during the propagation window if needed.
- **50 tags per cached object, 120 bytes per tag, 4 KiB total** — Next.js cache tags are typically short (e.g., `_N_T_/blog/[slug]`). The 50-tag limit is unlikely to be hit in practice.
- **10 tags per invalidation request** — the `invalidateCDNByTags` function batches automatically.

---

## 10. Static Assets and CDN

### 10.1 Build-Time Asset Sync

The adapter generates a manifest of all files that should be synced to GCS:

| Source                                   | GCS Path      | Cache-Control                                           |
| ---------------------------------------- | ------------- | ------------------------------------------------------- |
| `outputs.staticFiles` (`_next/static/*`) | `/{pathname}` | `public, max-age=31536000, immutable`                   |
| `outputs.prerenders[].fallback.filePath` | `/{pathname}` | `public, s-maxage={revalidate}, stale-while-revalidate` |
| Public directory files                   | `/{pathname}` | `public, max-age=3600`                                  |

The adapter emits this as a `static-assets.json` manifest. A Helm Job or CI step runs `gcloud storage rsync` against this manifest.

### 10.2 Routing to GCS

The Route Extension Service detects static asset requests (via `@next/routing` resolution — static files have a distinct output type) and sets `x-upstream-pool: gcs-backend`. The URL map routes this to a GCS backend NEG configured to proxy to `storage.googleapis.com` with path rewriting to the bucket. Cloud CDN caches these responses with `immutable` cache headers, so subsequent requests for the same asset are served from CDN without invoking the backend or the route extension again — though the route extension still runs (it's pre-CDN), its overhead is minimal (<1ms).

### 10.3 Cloud CDN Configuration

The Helm chart emits a GKE `BackendConfig` that enables Cloud CDN on the GKE Ingress/Gateway:

```yaml
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: {{ .Release.Name }}-cdn
spec:
  cdn:
    enabled: true
    cachePolicy:
      includeHost: true
      includeProtocol: false
      includeQueryString: true
```

---

## 11. Image Optimization

### 11.1 Sidecar Mode (Default)

A lightweight container running a Sharp-based HTTP server. Deployed as a separate Deployment (not a literal sidecar container — it has its own scaling).

Request flow: Route Extension resolves `/_next/image` → sets `x-upstream-pool: image-optimizer` → URL map routes to image optimizer backend → Sharp container fetches original from GCS or SSR pool → transforms → responds with optimized image.

The optimizer respects the `width`, `quality`, and `format` parameters from Next.js's image component.

### 11.2 Cloud CDN Mode (Future)

When Cloud CDN's native image optimization GAs, the adapter can be configured to skip the sidecar entirely. The ext_proc would set appropriate response headers (e.g., `x-goog-image-optimization`) and let Cloud CDN handle transformation at the edge.

```typescript
{
  imageOptimizer: {
    mode: 'cloud-cdn',  // future
  },
}
```

This is a values.yaml toggle — no adapter code change needed, just a different URL map route for `/_next/image`.

---

## 12. Generated Artifacts

### 12.1 Helm Chart Structure

```
.k8s-adapter/output/
├── chart/
│   ├── Chart.yaml
│   ├── values.yaml                      ← defaults derived from build metadata
│   ├── templates/
│   │   ├── _helpers.tpl
│   │   ├── routing-service.yaml         ← Deployment for route extension callout
│   │   ├── routing-configmap.yaml       ← routing manifest from build
│   │   ├── ppr-cache-seed-job.yaml       ← Helm hook: pre-seeds Valkey with PPR preambles
│   │   ├── pool-deployment.yaml         ← templated per pool ({{ range .Values.pools }})
│   │   ├── image-optimizer.yaml
│   │   ├── valkey-statefulset.yaml
│   │   ├── services.yaml
│   │   ├── gateway.yaml                 ← GKE Gateway + HTTPRoute
│   │   ├── route-ext-update-job.yaml    ← Helm hook: updates LbRouteExtension via gcloud
│   │   ├── # (no traffic extension needed — PPR handled by pool server)
│   │   ├── hpa.yaml                     ← per pool
│   │   ├── backend-config.yaml          ← Cloud CDN config
│   │   ├── pdb.yaml                     ← PodDisruptionBudgets
│   │   └── gcs-sync-job.yaml            ← optional: sync static assets
│   └── manifests/
│       ├── routing-manifest.json
│       └── static-assets.json
├── Dockerfile                           ← for application pools
├── Dockerfile.routing-service           ← lightweight route extension service
├── Dockerfile.image-optimizer           ← Sharp-based optimizer
├── extension-chains.json               ← CEL expression + chain config for Helm hook
└── build-metadata.json
```

### 12.2 Generated `values.yaml` (Example)

```yaml
# ============================================================
# Auto-generated by @next-community/adapter-k8s (provider: gke)
# Build ID: a1b2c3d4
# Next.js: 16.2.0
# Generated: 2026-03-24T15:30:00Z
# ============================================================

global:
  image:
    registry: gcr.io/my-project
    tag: a1b2c3d4
    pullPolicy: IfNotPresent

# --- Service Pools ---
# Generated from adapter.config.ts pool definitions
# and build output metadata
pools:
  ssr:
    replicas:
      min: 2
      max: 20
    resources:
      requests: { cpu: 250m, memory: 512Mi }
      limits: { cpu: "1", memory: 1Gi }
    targetCPU: 70
    # Build metadata (informational)
    _meta:
      outputCount: 47
      hasPPR: true
      hasMiddleware: false # middleware runs in routing service

  api:
    replicas:
      min: 2
      max: 10
    resources:
      requests: { cpu: 250m, memory: 256Mi }
      limits: { cpu: 500m, memory: 512Mi }
    targetCPU: 60
    _meta:
      outputCount: 12
      maxDuration: 30

# --- Routing Service ---
routingService:
  replicas: 2
  resources:
    requests: { cpu: 100m, memory: 128Mi }
    limits: { cpu: 250m, memory: 256Mi }

# --- Cache ---
cache:
  enabled: true
  mode: internal
  replicas: 1
  memory: 512Mi
  persistence:
    enabled: true
    size: 2Gi

# --- CDN ---
cdn:
  enabled: true
  bucket: my-project-nextjs-static
  origin: https://cdn.example.com

# --- Image Optimizer ---
imageOptimizer:
  enabled: true
  mode: sidecar
  replicas: 1
  resources:
    requests: { cpu: 250m, memory: 256Mi }
    limits: { cpu: "1", memory: 512Mi }

# --- Gateway ---
gateway:
  type: gateway-api
  className: gke-l7-global-external-managed
  host: app.example.com
  tls:
    enabled: true
    managedCert: true

# --- Build Metadata (read-only) ---
build:
  id: a1b2c3d4
  nextVersion: "16.2.0"
  containerStrategy: traced-assets
  routes:
    appPages: 47
    appRoutes: 8
    pagesApi: 4
    prerenders: 23
    staticFiles: 156
    hasMiddleware: true
    hasPPR: true
    pprRoutes: 5
```

---

## 13. GCP Service Extensions Configuration

The adapter uses the **GCP Service Extensions API** (`networkservices.googleapis.com`) to attach ext_proc callout services to the global external Application Load Balancer. This is a critical architectural choice — see §13.5 for why.

### 13.1 Extension Points

```
Request
  │
  ├─ /_next/static/* ──► [no ext_proc] ──► URL Map ──► Cloud CDN ──► GCS
  │
  └─ everything else ──► [LbRouteExtension] ──► URL Map ──► Cloud CDN ──► Pool Server
                              (pre-CDN)                                       │
                                                                       PPR? → Valkey
                                                                              + resume
```

- **`LbRouteExtension` (pre-CDN):** Runs before URL map evaluation and CDN cache lookup. Executes middleware, resolves routes via `@next/routing`, and sets headers that drive URL map routing and CDN cache behavior. Can return `immediate_response` for middleware redirects.
- **Static assets bypass ext_proc entirely** — the CEL match condition on the extension chain excludes paths that never need routing or middleware. This avoids a Node.js gRPC round-trip on every immutable asset request.
- **PPR:** Handled by the pool server (§6.4, §7.4), not by a traffic extension.

### 13.2 Route Extension — `LbRouteExtension` (Service Extensions API)

The route extension is created via the **Service Extensions API directly**, not via GKE Gateway CRDs. This is necessary because the GKE Gateway controller's `GCPRoutingExtension` only supports regional gateways, while we need a global external ALB for Cloud CDN.

The Service Extensions API supports `LbRouteExtension` callouts on global external ALBs (confirmed in the [support matrix](https://docs.cloud.google.com/service-extensions/docs/lb-extensions-overview)). Route extensions run before URL map evaluation on all supported ALB types.

The `LbRouteExtension` is provisioned by the CLI's `init` command (§18.2) and **updated on each deploy via a Helm hook Job** that runs a single `gcloud` command. No Terraform required — the Helm chart is the single deployment tool.

The `init` command creates the `LbRouteExtension` with a placeholder CEL expression. Each `helm upgrade` updates it with the build-specific CEL expression and extension chain config:

```yaml
# Helm post-upgrade hook: updates LbRouteExtension with new CEL expression
apiVersion: batch/v1
kind: Job
metadata:
  name: {{ .Release.Name }}-update-route-ext
  annotations:
    "helm.sh/hook": post-upgrade,post-install
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  template:
    spec:
      serviceAccountName: {{ .Release.Name }}-gcp-sa
      containers:
        - name: update-ext
          image: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
          command: ["/bin/sh", "-c"]
          args:
            - |
              gcloud service-extensions lb-route-extensions update \
                {{ .Release.Name }}-route-ext \
                --project={{ .Values.infrastructure.projectId }} \
                --location={{ .Values.infrastructure.region }} \
                --extension-chains-from-file=/config/extension-chains.json \
                --quiet
          volumeMounts:
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: {{ .Release.Name }}-route-ext-config
      restartPolicy: Never
```

Extension chain configuration (generated at build time, mounted as ConfigMap):

```json
[
  {
    "name": "nextjs-routing",
    "matchCondition": {
      "celExpression": "!(request.path.startsWith('/_next/static/')) && !(request.path.startsWith('/favicon.ico'))"
    },
    "extensions": [
      {
        "name": "routing-service",
        "authority": "routing-service.{{ .Release.Namespace }}.svc.cluster.local",
        "service": "projects/{{ .Values.projectId }}/locations/{{ .Values.provider.gke.region }}/backendServices/{{ .Release.Name }}-routing-service",
        "timeout": "5s",
        "supportedEvents": ["REQUEST_HEADERS"]
      }
    ]
  }
]
```

The `celExpression` is **generated at build time** by the adapter based on the build output. See §13.6 for the full generation strategy.

**Note:** The routing service's backend service must be in the same project as the forwarding rule. The backend service itself cannot have Cloud CDN enabled (it's a gRPC service — CDN makes no sense for it). The application backends behind the URL map can and should use Cloud CDN.

### 13.3 Traffic Extension (Not Required)

PPR streaming is handled by the pool servers themselves (§6.4, §7.4) using cache-first preamble serving from Valkey. This eliminates the need for a `GCPTrafficExtension` resource. The pool server reads the preamble from cache, starts streaming it immediately, and invokes the resume handler in-process — no load balancer-level response interception needed.

A `GCPTrafficExtension` could be added in the future for use cases that require response-level processing at the load balancer (e.g., response header injection for observability). `GCPTrafficExtension` is supported on global gateways via the GKE Gateway controller, so no direct API workaround would be needed.

### 13.4 URL Map / Backend Routing

The route extension sets an `x-upstream-pool` header on each request. With skew protection (§6.6), pool names are **versioned with the buildId** (e.g., `ssr-a1b2c3d4`). The HTTPRoute must include rules for both the current and previous version's pools during the skew protection window.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: {{ .Release.Name }}-routes
spec:
  parentRefs:
    - name: {{ .Release.Name }}-gateway
  hostnames:
    - {{ .Values.gateway.host }}
  rules:
    # --- Static assets (no ext_proc, no versioning needed) ---
    - matches:
        - path:
            type: PathPrefix
            value: /_next/static
      backendRefs:
        - name: {{ .Release.Name }}-gcs-neg
          port: 443

    # --- Current version pools (buildId: {{ .Values.buildId }}) ---
    {{- range $name, $_ := .Values.pools }}
    - matches:
        - headers:
            - name: x-upstream-pool
              value: {{ $name }}-{{ $.Values.buildId }}
      backendRefs:
        - name: {{ $.Release.Name }}-{{ $name }}-{{ $.Values.buildId }}
          port: 3000
    {{- end }}

    # --- Previous version pools (skew protection) ---
    {{- if .Values.previousBuildId }}
    {{- range $name, $_ := .Values.pools }}
    - matches:
        - headers:
            - name: x-upstream-pool
              value: {{ $name }}-{{ $.Values.previousBuildId }}
      backendRefs:
        - name: {{ $.Release.Name }}-{{ $name }}-{{ $.Values.previousBuildId }}
          port: 3000
    {{- end }}
    {{- end }}

    # --- Shared services (not versioned) ---
    - matches:
        - headers:
            - name: x-upstream-pool
              value: image-optimizer
      backendRefs:
        - name: {{ .Release.Name }}-image-optimizer
          port: 3002

    - matches:
        - headers:
            - name: x-upstream-pool
              value: gcs-backend
      backendRefs:
        - name: {{ .Release.Name }}-gcs-neg
          port: 443

    - matches:
        - headers:
            - name: x-upstream-pool
              value: external-proxy
      backendRefs:
        - name: {{ .Release.Name }}-external-proxy
          port: 3003

    # --- Fallback (ext_proc bypassed or unknown pool) ---
    - backendRefs:
        - name: {{ .Release.Name }}-{{ (keys .Values.pools | first) }}-{{ .Values.buildId }}
          port: 3000
```

**How this interacts with skew protection:**

1. The route extension resolves the pool name via `resolvePoolForRequest` (§6.6), which appends the appropriate buildId: `ssr-b5c6d7e8` for current clients, `ssr-a1b2c3d4` for old clients.
2. The HTTPRoute has matching rules for both versioned pool names.
3. Each versioned pool is a separate K8s Deployment + Service (e.g., `my-app-ssr-b5c6d7e8`, `my-app-ssr-a1b2c3d4`).
4. When the skew protection window expires, the cleanup job deletes the old Deployments/Services, and the next `helm upgrade` removes the `previousBuildId` rules from the HTTPRoute.

**Routing Service ConfigMap** also mounts both manifests so the route extension can resolve routes for old-version clients:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-routing-manifests
data:
  current.json: {{ .Values.routingManifest | toJson | quote }}
  {{- if .Values.previousRoutingManifest }}
  previous.json: {{ .Values.previousRoutingManifest | toJson | quote }}
  {{- end }}
```

The route extension loads both at startup:

```typescript
const manifest = JSON.parse(readFileSync("/config/current.json", "utf-8"));
const previousManifest = existsSync("/config/previous.json")
  ? JSON.parse(readFileSync("/config/previous.json", "utf-8"))
  : null;
```

### 13.5 Why Two Different APIs?

The adapter uses a hybrid approach: direct Service Extensions API for the route extension, GKE Gateway CRDs for everything else. This is driven by a gap in the GKE Gateway controller:

| Resource                                    | Global External ALB                                                                                                         | How we create it                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `LbRouteExtension` (Service Extensions API) | **Supported** (confirmed in [support matrix](https://docs.cloud.google.com/service-extensions/docs/lb-extensions-overview)) | `init` creates via `gcloud`; Helm hook updates per-deploy |
| `GCPRoutingExtension` (GKE Gateway CRD)     | **Not supported** — regional gateways only                                                                                  | N/A — we don't use this                                   |
| `GCPTrafficExtension` (GKE Gateway CRD)     | **Supported** (not used in v1 — PPR handled by pool server)                                                                 | N/A                                                       |
| Gateway, HTTPRoute, BackendConfig           | **Supported**                                                                                                               | Native Kubernetes CRDs                                    |

The GKE Gateway controller's `GCPRoutingExtension` only supports regional gateways (`gke-l7-regional-external-managed`). But Cloud CDN requires a global external ALB. The underlying Service Extensions API supports `LbRouteExtension` callouts on global ALBs — the GKE Gateway controller simply hasn't exposed this yet.

By using `LbRouteExtension` directly, we get:

- **Pre-CDN middleware on a global ALB** — matching Vercel's model
- **Cloud CDN** — on the application backends (not the callout service)
- **Same ext_proc protocol** — the routing service code is identical regardless of how the extension is provisioned

The tradeoff: the route extension is managed via a `gcloud` Helm hook rather than a native Kubernetes CRD. The `init` command creates it, the Helm hook updates it — operators never run `gcloud` manually. If/when the GKE Gateway controller adds `GCPRoutingExtension` support for global gateways, the adapter can switch to the CRD — no application code changes needed, just a Helm chart update.

### 13.6 CEL Expression Generation — Skipping ext_proc for Static Routes

The ext_proc callout adds a Node.js gRPC round-trip to every matched request. For static assets (`/_next/static/*`) this is pure overhead — they're immutable, hashed, always CDN-cacheable, and never need middleware or routing decisions. The adapter generates the CEL `matchCondition` at build time to exclude these paths.

**Route classification at build time:**

| Route class                                              | Needs ext_proc? | Reason                                                                                      |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| `/_next/static/*`                                        | **No**          | Immutable hashed assets. Content-addressed, no routing decisions, middleware never matches. |
| Known public files (`/favicon.ico`, `/robots.txt`, etc.) | **No**          | Static files, no routing. Unless middleware matchers explicitly include them.               |
| Middleware-matched paths                                 | **Yes**         | Middleware must execute pre-CDN for auth, redirects, A/B.                                   |
| Dynamic routes                                           | **Yes**         | Need `resolveRoutes` to determine the output and pool.                                      |
| Prerender/ISR routes                                     | **Yes**         | Need dispatch metadata (`x-output-id`, etc.) for the pool server.                           |
| PPR routes                                               | **Yes**         | Need `x-nextjs-ppr` flag for cache-first PPR flow.                                          |
| Image optimization (`/_next/image`)                      | **Yes**         | Needs routing to the image optimizer pool.                                                  |

**Generation strategy:**

The adapter's `onBuildComplete` generates the CEL expression by building an exclusion list:

```typescript
function generateCelExpression(outputs: AdapterOutputs, config: NextConfig): string {
  const exclusions: string[] = [];

  // 1. Always exclude immutable static assets
  exclusions.push("request.path.startsWith('/_next/static/')");

  // 2. Exclude known public files UNLESS middleware matchers could match them
  const middlewareMatchers = outputs.middleware?.config.matchers ?? [];
  const publicFiles = outputs.staticFiles
    .filter((f) => !f.pathname.startsWith("/_next/"))
    .map((f) => f.pathname);

  for (const publicPath of publicFiles) {
    const matchedByMiddleware = middlewareMatchers.some((m) =>
      new RegExp(m.sourceRegex).test(publicPath),
    );
    if (!matchedByMiddleware) {
      exclusions.push(`request.path == '${publicPath}'`);
    }
  }

  // 3. No middleware — flip to inclusion list (much more aggressive)
  if (!outputs.middleware) {
    const inclusions: string[] = [];

    // Only invoke ext_proc for paths that actually need dispatch metadata
    // Dynamic routes (need resolveRoutes to determine the output)
    for (const route of routing.dynamicRoutes) {
      // Dynamic routes have regex patterns — use startsWith on the static prefix
      const staticPrefix = extractStaticPrefix(route.sourceRegex);
      if (staticPrefix) {
        inclusions.push(`request.path.startsWith('${staticPrefix}')`);
      }
    }

    // ISR prerender routes (need cache orchestration in pool server)
    for (const prerender of outputs.prerenders) {
      if (prerender.fallback?.initialRevalidate) {
        inclusions.push(`request.path == '${prerender.pathname}'`);
      }
    }

    // Image optimization
    inclusions.push("request.path.startsWith('/_next/image')");

    if (inclusions.length > 0) {
      return inclusions.join(" || ");
    }

    // No dynamic routes, no ISR, no image optimization — nothing needs ext_proc
    return "false";
  }

  if (exclusions.length === 0) {
    return "true"; // Middleware exists but no exclusions possible
  }

  // CEL: invoke ext_proc when NONE of the exclusions match
  return `!(${exclusions.join(" || ")})`;
}

// Extract the static prefix from a route sourceRegex for CEL startsWith matching.
// e.g. "^/blog/([^/]+?)(?:/)?$" → "/blog/"
function extractStaticPrefix(sourceRegex: string): string | null {
  // Strip leading ^ and extract literal characters before the first regex metacharacter
  const withoutAnchor = sourceRegex.replace(/^\^/, "");
  const match = withoutAnchor.match(/^(\/[a-zA-Z0-9_\-/]*)/);
  return match?.[1] ?? null;
}
```

**Example generated CEL expressions:**

App with middleware (exclusion list — conservative):

```
!(request.path.startsWith('/_next/static/') || request.path == '/favicon.ico' || request.path == '/robots.txt')
```

App without middleware (inclusion list — aggressive):

```
request.path.startsWith('/blog/') || request.path.startsWith('/api/') || request.path.startsWith('/_next/image') || request.path == '/dashboard'
```

The no-middleware inclusion list is safe because:

- A false positive (calling ext_proc for a route that doesn't need it) costs a gRPC round-trip — acceptable
- A false negative (skipping ext_proc for a real route) means the pool server handles it via local fallback resolution (§15.1) — no security concern since there's no middleware to bypass
- Unknown paths (404s) skip ext_proc entirely — the URL map fallback routes them to the pool server which returns 404

**Impact:** For a typical Next.js app, `/_next/static/*` accounts for the majority of CDN-served requests (JS chunks, CSS, fonts, images). Excluding these from ext_proc eliminates the gRPC round-trip on the highest-volume path prefix. The URL map still routes these to the GCS backend via a default rule (no `x-upstream-pool` header needed — the HTTPRoute fallback handles it).

**CEL expression limits:** Service Extensions supports one CEL expression per extension chain, with one regular expression maximum per expression. The adapter uses prefix matching (`startsWith`) and exact matching (`==`) rather than regexes, which is both faster and avoids the regex limit.

**URL Map fallback for skipped requests:** When ext_proc is skipped, the request has no `x-upstream-pool` header. The HTTPRoute (§13.4) must have rules that handle this — static asset paths should match before the header-based pool routing rules:

```yaml
  rules:
    # Static assets — matched by path prefix, no ext_proc header needed
    - matches:
        - path:
            type: PathPrefix
            value: /_next/static
      backendRefs:
        - name: {{ .Release.Name }}-gcs-neg
          port: 443

    # Versioned pool routing (header set by route extension, see §13.4)
    # Includes both current and previous buildId pools for skew protection
    {{- range $name, $_ := .Values.pools }}
    - matches:
        - headers:
            - name: x-upstream-pool
              value: {{ $name }}-{{ $.Values.buildId }}
      backendRefs:
        - name: {{ $.Release.Name }}-{{ $name }}-{{ $.Values.buildId }}
          port: 3000
    {{- end }}

    # ... previous version rules, shared services (see §13.4) ...

    # Fallback — requests that bypassed ext_proc without matching
    - backendRefs:
        - name: {{ .Release.Name }}-{{ (keys .Values.pools | first) }}-{{ .Values.buildId }}
          port: 3000
```

---

## 14. Risk Assessment

| Risk                                                                                  | Severity | Likelihood | Mitigation                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@next/routing` is experimental, API may change                                       | High     | Medium     | Fallback to raw `sourceRegex` matching from the routing manifest. Pin `@next/routing` version.                                                                                                                                                                                                                                                                    |
| Route extension callout adds latency to every request (pre-CDN)                       | Medium   | Low        | Routing service is CPU-light (<1ms typical). This is the same model Vercel uses — middleware runs on every request before CDN. GCP routes callouts to the nearest available backend.                                                                                                                                                                              |
| Route extension is headers-only (no request body)                                     | Low      | Low        | Next.js middleware almost never reads the request body. For the rare POST-with-middleware case, the middleware passes through (`NextResponse.next()`) and body-dependent validation happens in the route handler itself.                                                                                                                                          |
| `LbRouteExtension` on global ALB requires direct API management (not GKE Gateway CRD) | Medium   | High       | The GKE Gateway controller's `GCPRoutingExtension` only supports regional gateways. We use the Service Extensions API directly (`LbRouteExtension`), which is GA on global ALBs per the support matrix. This adds operational complexity (Helm hook job vs. native CRD). If GKE Gateway adds global routing extension support, the adapter can switch to the CRD. |
| PPR resumption relies on cached preambles and in-process resume handlers              | Medium   | Medium     | Preambles are pre-seeded in Valkey at deploy time from build output. Resume handlers use the same invocation pattern as non-PPR routes (§6.2). Fallback: if no cached preamble, do a full render. PPR is opt-in.                                                                                                                                                  |
| External rewrites not supported in v1                                                 | Medium   | Medium     | Next.js rewrites to external URLs are transparent proxies but route extensions can't proxy. v1 returns a 502 with a clear error message directing users to Route Handlers. v2+ will add a dedicated external-proxy backend pool with streaming, timeouts, and body limits.                                                                                        |
| Traced `assets` maps may miss runtime dependencies                                    | Medium   | Medium     | The `assets` field is provided by the adapter API and traced via `@vercel/nft`. The AWS adapter uses a similar per-function bundling approach. Provide `shared-image` as a fallback container strategy for operators who hit edge cases.                                                                                                                          |
| Next.js adapter API is newly stable (16.2.0)                                          | Medium   | Medium     | Run the official Next.js e2e test harness for adapters. Pin `peerDependencies`.                                                                                                                                                                                                                                                                                   |
| `NEXT_PUBLIC_*` env vars are build-time only                                          | Low      | High       | Well-documented Next.js constraint. Document clearly. Suggest per-environment CI builds.                                                                                                                                                                                                                                                                          |
| GCP Service Extensions is a newer GCP feature                                         | Medium   | Medium     | Service Extensions is GA for global external ALB. `LbRouteExtension` and `LbTrafficExtension` are v1 stable API resources. The ext_proc protocol itself is a stable Envoy standard.                                                                                                                                                                               |
| Skew protection doubles pod count during window                                       | Medium   | High       | With `skewProtection.enabled: true` (default), both old and new pool Deployments run simultaneously. A cluster with 20 SSR replicas will briefly run 40 pods + doubled Valkey memory. Set `duration: '0'` to disable. Operators should factor this into cluster capacity planning.                                                                                |
| Tight coupling to GCP load balancer                                                   | Medium   | Low        | This is a GKE-specific provider. The ext_proc protocol is portable — the routing service itself could run behind any ext_proc-capable proxy. The `generic` provider (future) would use in-cluster Envoy.                                                                                                                                                          |

---

## 15. Resilience & Failure Modes

### 15.1 Route Extension Failure

The `LbRouteExtension` is on the critical path for every non-static request. Its `failure_mode_allow` setting determines what happens when the ext_proc service is unhealthy:

**The adapter sets this at build time based on whether middleware exists:**

| Middleware? | `failure_mode_allow`  | Behavior on route extension failure                                                                                                                                                           |
| ----------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Yes**     | `false` (fail closed) | Requests return 500. Safe: middleware is a security boundary (auth gates, geo-restrictions). Bypassing it could expose protected content.                                                     |
| **No**      | `true` (fail open)    | Requests bypass ext_proc and hit the URL map fallback rule. The site degrades but stays up — pool servers receive requests without dispatch metadata and fall back to local route resolution. |

This is set in the `extension-chains.json` generated by `onBuildComplete` and applied by the Helm hook Job:

```json
{
  "failureModeAllow": false
}
```

**Fail-open fallback in pool servers:** When `failure_mode_allow: true` and the route extension is down, requests arrive at the pool server without `x-output-id` or `x-matched-pathname` headers. The pool server detects this and falls back to local route resolution using the pool manifest:

```typescript
if (!req.headers["x-output-id"]) {
  // Route extension was bypassed (fail-open mode)
  // Resolve the route locally from the pool manifest
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const localMatch = poolManifest.resolveLocal(url.pathname);
  if (!localMatch) {
    res.writeHead(503);
    res.end("Route extension unavailable");
    return;
  }
  outputId = localMatch.outputId;
  matchedPathname = localMatch.pathname;
}
```

**Mitigation for both modes:**

- Route extension runs multiple replicas (default: 2) with a PodDisruptionBudget
- Health check endpoint on the gRPC service — GCP removes unhealthy backends automatically
- Fast startup: the route extension is stateless, loads only the routing manifest and middleware module
- The CEL expression already excludes `/_next/static/*`, so static assets are unaffected regardless

### 15.2 Valkey Failure

The pool server degrades gracefully when Valkey is unreachable:

| Feature                 | Behavior without Valkey                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| ISR/prerender cache     | Every request is a MISS — handler is invoked directly. Higher latency, more compute, but correct. |
| PPR preamble            | Fall back to full render (no cached preamble). Slower first byte, but the page still works.       |
| `use cache`             | Falls back to in-memory per-process cache (Next.js default). Entries not shared across replicas.  |
| Tag invalidation        | No-op. Entries will expire via TTL.                                                               |
| CDN invalidation        | Still works (doesn't depend on Valkey).                                                           |
| Background revalidation | Fails silently. Next request re-triggers.                                                         |

The cache handler wraps all Valkey operations in try/catch and logs failures without throwing. The pool server monitors Valkey connectivity and exposes it via health check (degraded, not unhealthy — the server can still serve requests).

### 15.3 Pool Server Failure

Standard Kubernetes resilience: multiple replicas per pool, HPAs, readiness probes (HTTP health check on `/healthz`), liveness probes. Rolling updates with `maxUnavailable: 0` ensure zero-downtime deploys.

If all replicas of a pool are unhealthy, the GKE backend service returns 503. The route extension is unaware — it still sets `x-upstream-pool` headers. This is correct: the route extension shouldn't try to compensate for backend failures.

---

## 16. Observability

### 16.1 Structured Logging

All components emit structured JSON logs to stdout (GKE's standard log collection picks them up via Cloud Logging):

**Route Extension Service:**

- Every ext_proc request: `{ path, method, resolved_pool, output_id, middleware_executed, middleware_result, duration_ms }`
- Middleware errors: `{ path, error, stack }`
- `immediate_response` events: `{ path, status, reason }` (redirect, middleware response)

**Pool Server:**

- Every request: `{ path, method, output_id, cache_state, duration_ms, status }`
- Cache operations: `{ operation, key, hit, duration_ms }`
- PPR: `{ path, preamble_source, resume_duration_ms }`
- Background revalidation: `{ path, trigger, success, duration_ms }`
- Handler load: `{ output_id, load_duration_ms }` (cold start tracking)

### 16.2 Metrics (OpenTelemetry)

The route extension and pool servers export OpenTelemetry metrics. On GKE, these flow to Cloud Monitoring via the OpenTelemetry Collector (deployed as a DaemonSet or sidecar).

**Route Extension metrics:**

- `routing.request.duration` (histogram) — ext_proc processing time, labeled by `pool`, `has_middleware`, `result` (routed / redirect / immediate_response)
- `routing.request.count` (counter) — request count by pool and result
- `routing.middleware.duration` (histogram) — middleware execution time
- `routing.cel.skip_rate` — not directly observable from the service, but can be calculated in Cloud Monitoring by correlating ALB request count (all requests) vs. route extension request count (ext_proc invocations). The difference is the CEL skip volume. Create a dashboard widget: `1 - (route_extension_requests / alb_total_requests)`.

**Pool Server metrics:**

- `pool.request.duration` (histogram) — total request handling time, labeled by `output_id`, `cache_state`
- `pool.cache.operation` (counter) — Valkey operations by type (get/set/revalidate) and result (hit/miss/error)
- `pool.handler.cold_start` (counter) — handler module loads (first request per output)
- `pool.handler.duration` (histogram) — handler invocation time, labeled by `output_id`
- `pool.ppr.preamble_duration` (histogram) — time to read preamble from Valkey
- `pool.ppr.resume_duration` (histogram) — time for resume handler to complete
- `pool.revalidation.background` (counter) — background revalidation triggers and outcomes

**Cache metrics:**

- `cache.valkey.latency` (histogram) — Valkey operation latency
- `cache.valkey.connection_errors` (counter) — connection failures
- `cache.cdn.invalidation` (counter) — CDN invalidation requests by type (path/tag) and outcome

### 16.3 Distributed Tracing

Requests carry trace context through the full lifecycle:

```
Client → LB → Route Extension → LB → CDN → Pool Server → Handler
  │              │                              │           │
  └── trace_id ──┴── span: routing ─────────────┴── span: ──┴── span:
                     (middleware, resolveRoutes)    dispatch    handler
                                                   (cache,     (render,
                                                    PPR)        RSC)
```

The route extension propagates `traceparent` / `tracestate` headers. The pool server creates child spans for cache lookups, PPR preamble reads, handler invocations, and background revalidation. On GKE, traces flow to Cloud Trace via the OpenTelemetry Collector.

---

## 17. Implementation Phases

The CLI (`init` + `deploy`) is built in Phase 1 and maintained throughout all phases. Each phase adds capabilities to the same workflow — operators never have to learn manual Helm/gcloud commands and then migrate to the CLI later.

### Implementation Learnings

The following decisions were validated or changed during Phase 1-2 implementation:

**Build-time:**

- **K8s-friendly build IDs** — Next.js default buildIds contain uppercase, underscores, and leading special chars that break K8s labels, Docker tags, and service names. The adapter overrides `generateBuildId` to produce lowercase alphanumeric IDs (`b{timestamp}{random}`). If the user sets their own `generateBuildId`, they own the responsibility.
- **Turbopack externals** — `.next/node_modules/` contains symlinked external modules with hashed names (e.g., `@opentelemetry/api-6ec0324a2d0bd38c`). These are absolute symlinks that don't survive Docker COPY. The adapter resolves each symlink to its real target and copies the content. This must be done fresh on each build (no caching).
- **`next/setup-node-env`** — must be imported before any handler module. Without it, AsyncLocalStorage globals aren't set up and handlers crash. The pool server calls this at startup before loading manifests.
- **`.env` files** — `.env`, `.env.production`, `.env.local`, `.env.production.local` are staged into pool server and routing service containers so server-side env vars work without K8s env var configuration.
- **Config file format** — `adapter.config.mjs` preferred over `.ts` to avoid Node.js `MODULE_TYPELESS_PACKAGE_JSON` warnings. The adapter loads `.mjs` first, then `.ts`, then `.js`.

**Gateway & TLS:**

- **Certificate Manager, not ManagedCertificate CRD** — GKE Gateway API does not support `ManagedCertificate` CRD or `certificateRefs` with `kind: ManagedCertificate`. TLS is handled via Certificate Manager with DNS authorization + certmap annotation (`networking.gke.io/certmap`). Wildcard domains (`*.example.com`) require DNS auth on the base domain.
- **HealthCheckPolicy CRD** — GKE Gateway auto-generates health checks that probe `/` (root). This fails when the app has middleware or returns errors. A `HealthCheckPolicy` CRD overrides this to probe `/healthz` on port 3000, which the pool server always answers with 200.
- **Static IP via `addresses` field** — Gateway API uses `spec.addresses[{type: NamedAddress}]`, not the Ingress annotation `networking.gke.io/static-ip`.
- **Multi-host support** — `gateway.hosts` is an array of `{ hostname, tls }` objects. Wildcard hostnames are quoted in YAML to prevent YAML alias interpretation.

**Deployment (blue/green):**

- **Stable "active" Service** — HTTPRoute always points to a stable Service (`{releaseName}-{poolName}`, no buildId). The Service's selector is patched by deploy/rollback to point to the active build. This prevents the gap where HTTPRoute references a new backend that isn't healthy yet.
- **Zero-downtime cutover sequence:** (1) Helm creates new Deployment + versioned Service, (2) wait for K8s readiness probes, (3) verify pod health via kubectl, (4) patch active Service selector, (5) scale previous to 0 (keep for rollback), (6) delete anything older.
- **Deploy fails if unhealthy** — if new pods don't become ready within 3 minutes, deploy exits with code 1 and does NOT cut over traffic. The previous build continues serving.
- **Helm server-side apply conflicts** — `kubectl patch` and Helm fight over field ownership. All patches use `--field-manager=helm --force-conflicts`, and Helm upgrade uses `--server-side=true --force-conflicts`.
- **Rollback is symmetric** — `rollback` scales up previous, waits for health, patches selectors, scales down current. Running it twice rolls forward. Both builds' Deployments are kept at 0 replicas.
- **Cluster state** — deploy state (`buildId`, `previousBuildId`) is stored in a K8s ConfigMap (`{releaseName}-adapter-state`) in addition to the local `state.json`. This allows `doctor`/`describe`/`rollback` to work from any machine with kubectl access (CI/CD + local dev).

**Route Extension (ext_proc):**

- **`gcloud service-extensions lb-route-extensions import`** — uses `import` not `create`. The import command takes a YAML spec file with `loadBalancingScheme`, `forwardingRules`, and `extensionChains`.
- **Global location** — `--location=global` for global external ALBs, not regional.
- **Forwarding rule discovery** — GKE Gateway auto-generates forwarding rule names. The route-ext Job discovers them via `gcloud compute forwarding-rules list --filter`.
- **Backend service path** — `projects/{projectId}/global/backendServices/...` not `locations/{region}/...` for global ALBs.
- **Job naming** — K8s Jobs are immutable. Each deploy creates a new Job with `{releaseName}-route-ext-{buildId}` and old ones are cleaned up.
- **Not a Helm hook** — the route-ext Job is a regular Job (not `helm.sh/hook`) so it doesn't block deploys if it fails.
- **Workload Identity** — the Job's ServiceAccount needs `networkservices.admin` and `compute.viewer` roles via Workload Identity binding.

**GCP IAM:**

- **`--condition=None`** on all `add-iam-policy-binding` commands (required when policies have conditional bindings).
- **Artifact Registry reader** — GKE Autopilot nodes use the `container-engine-robot` service agent for image pulls. Must grant `artifactregistry.reader` on the repo to `service-{projectNumber}@container-engine-robot.iam.gserviceaccount.com`.

**Adapter API conformance (stable Next.js 16.2):**

- **`modifyConfig` context** — stable API `ctx` has `{ phase, nextVersion }`, NOT `projectDir`. Use `process.cwd()` instead.
- **`requestMeta`** — pass `relativeProjectDir: '.'` and `hostname` in handler invocation context.
- **`AdapterOutputs`** — now derived from `NextAdapter["onBuildComplete"]` parameter type, not locally defined.
- **Middleware `request.url`** — standard `Request.url` is read-only. Next.js middleware mutates it. Pool server wraps with a Proxy to allow mutation.
- **`@next/routing` `invokeMiddleware`** — MUST always be a function, never `undefined`. `resolveRoutes` calls it unconditionally.

**Testing:**

- **Two-tier e2e test suite** — Tier 1 (pool server only, like Bun adapter) validates functional fidelity. Tier 2 (Envoy + routing service + pool server) validates correctness of the split architecture: CEL filtering, ext_proc header mutations, middleware pre-CDN, rewrite chains.
- **`emulate` command** — `npx adapter-k8s emulate` spins up the full stack locally (Envoy + routing service + pool server) for development and testing.

---

### Phase 1: Core Adapter + Pool Server + CLI (DONE)

**Goal:** `npx adapter-k8s init && npx adapter-k8s deploy` produces a working Next.js app on GKE with pool decomposition.

**Scope (delivered):**

- **CLI:** `init`, `deploy`, `destroy`, `doctor`, `describe`, `rollback`, `tail`/`logs`, `emulate`
- `NextAdapter` implementation (`modifyConfig`, `onBuildComplete`) conforming to stable API
- Pool classification (`classifyIntoPools` with first-match-wins)
- Routing manifest generation
- Pool server with handler invocation, local route resolution, middleware execution
- Dockerfile generation (traced assets + shared-image)
- Helm chart with blue/green Deployments, stable active Services, HealthCheckPolicies, Gateway, HTTPRoute, Certificate Manager
- Multi-host support with wildcard domains
- Blue/green zero-downtime deploys with rollback
- Cluster state via ConfigMap
- K8s-friendly buildId generation
- `next/setup-node-env` initialization
- Turbopack externals resolution
- `.env` file staging
- GKE Autopilot IAM + Workload Identity setup
- Next.js e2e test suite integration (Tier 1 + Tier 2)

### Phase 2: Route Extension + Service Extensions (DONE)

**Goal:** Pre-CDN middleware and routing via ext_proc.

**Scope (delivered):**

- Route Extension Service (ext_proc gRPC server with `resolveRoutes`, `@grpc/grpc-js` bundled)
- CEL expression generation (exclusion list with middleware, inclusion list without)
- Extension chain JSON generation with `failure_mode_allow`
- Middleware execution via `invokeMiddleware` callback (with Proxy-wrapped Request for mutable `url`)
- `x-output-id`, `x-upstream-pool`, `x-matched-pathname`, `x-route-matches` header mutations
- Pool server consumes dispatch headers (bypasses local resolution when `x-output-id` present)
- Routing service Dockerfile + context staging (including `@next/routing`, `.next/node_modules/`, `.next/server/chunks/`)
- Route-ext update Job (`lb-route-extensions import`, `--location=global`, forwarding rule discovery)
- Envoy-based integration testing (`integration/envoy.yaml`)
- `emulate` command for local full-stack development

### Phase 3: Caching Layer

**Goal:** Distributed ISR/`use cache` across replicas.

**Scope:**

- Valkey deployment (Helm chart in-cluster, or `init` provisions Memorystore)
- `cacheHandler` (ISR, route handlers, images) — buildId-namespaced keys
- `cacheHandlers` (use cache directives) — buildId-namespaced keys
- **`requestMeta.onCacheEntryV2`** — implement the stable adapter callback for observing all cache operations. When a cache entry is generated or looked up, persist to Valkey. This is the official contract for cache coordination — replaces custom cache orchestration. See [adapterPath docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath#runtime-integration).
- **`requestMeta.revalidate`** — implement the internal revalidate function to avoid revalidating over the network in multi-instance deployments
- Background revalidation (in-process, v1)
- Tag-based invalidation + tag coordination across instances
- On-demand revalidation endpoint (`/_next/revalidate`)
- Prerender seed staging (Valkey seeding from `outputs.prerenders[].fallback`)

**CLI impact:** `init` gains optional Memorystore provisioning. `deploy` seeds Valkey with prerender data.

**Depends on:** Phase 1. Independent of Phase 2 (works without ext_proc).

### Phase 4: CDN Integration

**Goal:** Cloud CDN caching with proper invalidation.

**Scope:**

- `init` updated: provisions Cloud CDN config, CDN-enabled backend services
- GCS static asset sync (from `outputs.staticFiles` with `immutableHash` for cache headers)
- `Cache-Tag` response headers (with buildId) via pool server
- CDN cache invalidation (path-based and tag-based) via `@google-cloud/compute`
- `Cache-Control` / `s-maxage` from prerender `fallback.initialRevalidate`
- Static asset routing via HealthCheckPolicy + GCS NEG (content-addressed, no ext_proc needed)
- CLI `invalidate` command
- **CEL expression correctness is critical here** — a wrong CEL rule that lets a personalized page bypass ext_proc means CDN caches and serves it to everyone. Integration tests (Tier 2) must validate CEL for every route classification.

**CLI impact:** `init` provisions CDN. `deploy` syncs static assets to GCS. `invalidate` command available.

**Depends on:** Phase 2 (route extension sets headers that CDN uses), Phase 3 (cache invalidation coordinates with Valkey).

### Phase 5: PPR

**Goal:** Cache-first partial prerendering.

**Scope:**

- PPR preamble and postponed state seeding in Valkey from `outputs.prerenders[].fallback.filePath` and `fallback.postponedState`
- **PPR resume protocol (per stable adapter docs):**
  - Read `pprChain.headers` from prerender output (contains `next-resume: 1`)
  - Set those headers on the internal request to the handler
  - Send as **POST** with `postponedState` as the request body
  - Handler renders only deferred Suspense boundaries and streams the result
  - See [PPR Platform Guide](https://nextjs.org/docs/app/guides/ppr-platform-guide)
- Pool server PPR handling: read preamble from Valkey, start streaming shell, invoke resume handler in parallel, concatenate streams
- `x-nextjs-ppr` header flow from route extension to pool server
- Fallback to full render when preamble not cached
- **`requestMeta.onCacheEntryV2`** for persisting updated shell/postponed data after resume. When `cacheEntry.value.kind === 'APP_PAGE'`, extract `html` (via `toUnchunkedString()`) and `postponed` and write to Valkey.

**Depends on:** Phase 3 (Valkey), Phase 2 (route extension flags PPR routes).

### Phase 6: Skew Protection

**Goal:** Version isolation during rolling deployments.

**Note:** Blue/green deploy with rollback was implemented in Phase 1. This phase adds _version-aware routing_ for RSC navigations — clients that loaded build A's JavaScript get routed to build A's server, even after build B is deployed.

**Scope:**

- Route extension buildId comparison (client sends buildId in RSC request headers)
- Version-aware pool routing — old clients → old build (if still running within skew window)
- BuildId-namespaced Valkey keys (done in Phase 3)
- CDN cache isolation (`Vary` on build-version header, `Cache-Tag` with buildId)
- Configurable skew duration (`skewProtection.duration`)
- Cleanup of old Valkey keys + CDN entries after window expires

**CLI impact:** `deploy` already manages `previousBuildId` state and keeps previous build at 0 replicas. This phase adds the routing intelligence.

**Depends on:** Phase 2, Phase 3, Phase 4.

### Phase 7: Observability

**Goal:** Production visibility.

**Scope:**

- Structured JSON logging in route extension and pool servers
- OpenTelemetry metrics (§16.2)
- Distributed tracing with trace context propagation
- Grafana dashboard templates (or Cloud Monitoring dashboard JSON)
- Alert rules (route extension latency, cache error rate, pool health)
- CLI `status` command (beyond what `doctor` provides — deployment history, traffic metrics)

**Note:** `tail`/`logs` command was implemented in Phase 1.

**Can be incrementally added** to any phase — not gated by other phases.

### Future Work

- **Edge runtime support** — outputs with `runtime: 'edge'` have `edgeRuntime` metadata (`modulePath`, `entryKey`, `handlerExport`). Invoke via `globalThis._ENTRIES[entryKey][handlerExport]`. Option A: run as Node.js (current). Option B: Cloud Run for scale-to-zero edge routes.
- **Monorepo support** — use `ctx.repoRoot` for Docker build context, `ctx.projectDir` for Next.js paths.
- **Developer-provided e2e tests** — allow operators to define a smoke test that runs between health confirmation and traffic cutover during deploy.
- **Wasm route extension** — for apps without middleware, compile routing logic to Proxy-Wasm plugin that runs inside the load balancer (§20.1).

### Phase Summary

| Phase | What you get                                                        | Status  |
| ----- | ------------------------------------------------------------------- | ------- |
| 1     | Full CLI, pool server, blue/green deploy, rollback, doctor, emulate | Done    |
| 2     | Pre-CDN middleware, ext_proc routing, CEL generation                | Done    |
| 3     | Distributed ISR, `use cache`, `onCacheEntryV2`                      | Planned |
| 4     | Cloud CDN with invalidation                                         | Planned |
| 5     | PPR with resume protocol                                            | Planned |
| 6     | Skew protection (version-aware routing)                             | Planned |
| 7     | Observability (metrics, tracing, alerts)                            | Planned |

---

## 18. Operator Experience & CLI

### 18.1 Overview

The adapter ships as two things:

1. **A Next.js adapter** (`@next-community/adapter-k8s`) — the `NextAdapter` implementation that plugs into `next build` via `adapterPath` or the `NEXT_ADAPTER_PATH` environment variable
2. **A CLI** (`npx @next-community/adapter-k8s`) — wraps the full lifecycle: infrastructure provisioning, build, deploy

The key design principle: **`init` once, `deploy` forever.** The `init` command provisions GCP infrastructure via `gcloud`. Every subsequent `deploy` is just `helm upgrade` — Helm is the single deployment tool, with a hook Job that updates the `LbRouteExtension` via `gcloud` (§13.2).

No Terraform required. Operators who manage infrastructure with Terraform, Pulumi, or other tools can skip `init` and provide an `infrastructure.json` file with the resource references.

### 18.2 First-Time Setup

```bash
# 1. Install the adapter
npm install @next-community/adapter-k8s

# 2. Initialize — provisions GCP infrastructure + scaffolds config
npx @next-community/adapter-k8s init
```

The `init` command:

- Detects existing GKE cluster configuration (via `gcloud` or `KUBECONFIG`)
- Prompts for required values: GCP project, region, domain, container registry
- **Provisions GCP infrastructure** via idempotent `gcloud` calls (safe to re-run)
- Scaffolds `adapter.config.ts` with sensible defaults
- Writes `.k8s-adapter/infrastructure.json` with resource references
- Creates `.k8s-adapter/helm/values.override.yaml` for operator overrides

**What `init` provisions:**

```
gcloud creates/verifies (idempotent):
  ├── Global external Gateway (if not exists)
  ├── GCS bucket for static assets
  ├── Cloud CDN backend config
  ├── LbRouteExtension (with placeholder CEL — updated per-deploy by Helm hook)
  ├── IAM service accounts:
  │     routing-service-sa (Service Extensions API)
  │     deploy-sa (CDN invalidation, GCS write, route extension update)
  └── Optional: Memorystore instance (if cache.provider = 'memorystore')
```

**Output: `.k8s-adapter/infrastructure.json`**

```json
{
  "projectId": "my-project",
  "region": "us-central1",
  "forwardingRule": "projects/my-project/global/forwardingRules/nextjs-fr",
  "gcsBucket": "my-project-nextjs-static",
  "cdnUrlMap": "projects/my-project/global/urlMaps/nextjs-cdn",
  "routeExtensionName": "my-app-route-ext",
  "routingServiceBackend": "projects/my-project/global/backendServices/nextjs-routing",
  "containerRegistry": "us-central1-docker.pkg.dev/my-project/nextjs"
}
```

This file is committed to the repo. It contains only resource names (no secrets). Helm reads it to configure the hook Job, CDN invalidation, and GCS sync.

**Prerequisites:**

- GKE cluster (the adapter doesn't provision clusters)
- `gcloud` CLI authenticated with sufficient permissions
- Domain configured (for TLS/managed certs)

**For operators managing infrastructure themselves:** Skip `init`. Create the GCP resources via Terraform/Pulumi/Console and provide `infrastructure.json` manually.

### 18.3 Build & Deploy

```bash
# CLI handles everything
npx @next-community/adapter-k8s deploy

# Or with env var — no next.config.ts change needed
NEXT_ADAPTER_PATH=@next-community/adapter-k8s npx @next-community/adapter-k8s deploy
```

The `deploy` command:

```
deploy
  │
  ├─ 1. next build
  │     Adapter's onBuildComplete emits:
  │     .k8s-adapter/output/
  │       chart/              (Helm chart with values derived from build)
  │       Dockerfile.*        (per-pool, routing service, image optimizer)
  │       routing-manifest.json
  │       static-assets.json
  │       extension-chains.json  (CEL expression + chain config for Helm hook)
  │       build-metadata.json
  │
  ├─ 2. docker build + push
  │     Builds images for each pool, routing service, image optimizer
  │     Tags with buildId, pushes to configured registry
  │
  ├─ 3. helm upgrade --install
  │     Deploys/updates K8s workloads:
  │       Pool Deployments (versioned with buildId for skew protection)
  │       Routing Service Deployment + ConfigMap
  │       Valkey StatefulSet (if in-cluster)
  │       Image Optimizer Deployment
  │       Services, HPAs, PDBs
  │     Helm post-upgrade hook:
  │       Updates LbRouteExtension CEL expression via gcloud (§13.2)
  │       Syncs static assets to GCS
  │       Pre-seeds Valkey with prerender entries
  │       Schedules cleanup of old pools (skew protection)
  │
  └─ 4. Health check
        Verify new pools are healthy
        Verify route extension is responding
        Print deployment URL
```

### 18.4 Update Cycle

Subsequent deploys are the same command:

```bash
npx @next-community/adapter-k8s deploy
```

The adapter tracks the previous `buildId` in `.k8s-adapter/state.json` (or reads it from the cluster). On each deploy:

- `helm upgrade` creates new versioned pool Deployments alongside old ones (skew protection)
- The Helm hook updates the `LbRouteExtension` CEL expression and extension chain
- Valkey is seeded with new buildId-namespaced keys
- Static assets are synced to GCS (content-addressed, so old assets persist)
- After `skewProtection.duration`, the cleanup job deletes old pools and old Valkey keys

### 18.5 CLI Commands

```
npx @next-community/adapter-k8s <command>

Commands:
  init                 Provision GCP infrastructure, scaffold adapter config
  deploy               Build, push images, helm upgrade (single deployment tool)
  destroy              Tear down all resources (helm uninstall + gcloud cleanup)
  status               Show current deployment status (build ID, pool health, cache stats)
  logs                 Tail logs from routing service or pool servers
  invalidate           Manually invalidate CDN/Valkey cache by path or tag
  config validate      Validate adapter.config.ts against the current build output

Options:
  --skip-build         Use existing build output (skip next build)
  --skip-push          Use existing images (skip docker build + push)
  --dry-run            Show what would be deployed without applying
  --previous-build-id  Override previous buildId for skew protection
```

### 18.6 Environment Variable Setup (Zero-Config Start)

For the simplest possible onboarding, the adapter can be activated via environment variable without modifying `next.config.ts`:

```bash
# In .env or CI/CD:
NEXT_ADAPTER_PATH=@next-community/adapter-k8s
```

Next.js reads `NEXT_ADAPTER_PATH` and loads the adapter module. The adapter uses default configuration (single pool, no CDN, in-cluster Valkey) if no `adapter.config.ts` exists. This lets developers try the adapter with zero config changes, then progressively configure pools, CDN, and provider settings.

### 18.7 CI/CD Integration

For operators who prefer their own CI/CD rather than the CLI, the adapter's artifacts are designed to be consumed independently:

```yaml
# Example GitHub Actions workflow
jobs:
  deploy:
    steps:
      - uses: actions/checkout@v4

      - name: Build Next.js
        run: NEXT_ADAPTER_PATH=@next-community/adapter-k8s next build

      - name: Build & Push Images
        run: |
          docker build -f .k8s-adapter/output/Dockerfile -t $REGISTRY/app:$BUILD_ID .
          docker build -f .k8s-adapter/output/Dockerfile.routing-service -t $REGISTRY/routing:$BUILD_ID .
          docker push $REGISTRY/app:$BUILD_ID
          docker push $REGISTRY/routing:$BUILD_ID

      - name: Helm Upgrade
        run: |
          helm upgrade --install my-app .k8s-adapter/output/chart/ \
            --set global.image.tag=$BUILD_ID \
            --set global.image.registry=$REGISTRY \
            -f .k8s-adapter/helm/values.override.yaml

      # Helm hooks handle: LbRouteExtension update, GCS sync, Valkey seeding
```

The Helm chart is self-contained — all GCP resource updates happen via hook Jobs. CI/CD pipelines only need `docker` and `helm`. The `infrastructure.json` file (from `init`) provides the GCP resource references.

### 18.8 Separation of Concerns

| Layer                      | Tool                   | What it manages                                                            | When it changes                                        |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------ |
| **GCP infrastructure**     | `init` (`gcloud`)      | Gateway, LbRouteExtension, GCS bucket, CDN, IAM                            | First setup. Re-run `init` if provider config changes. |
| **GCP per-deploy updates** | Helm hook (`gcloud`)   | LbRouteExtension CEL expression, GCS static assets                         | Every deploy (automated by Helm hook)                  |
| **K8s workloads**          | Helm                   | Pool Deployments, Routing Service, Valkey, Image Optimizer, Services, HPAs | Every deploy (new buildId → new versioned Deployments) |
| **Build artifacts**        | `next build` + adapter | Routing manifest, Dockerfiles, static assets, extension chain config       | Every build                                            |
| **Runtime state**          | Pool server + Valkey   | Prerender cache, PPR preambles, tag manifests                              | At runtime (ISR revalidation, on-demand invalidation)  |

**For Terraform/Pulumi users:** The `init` command is optional. Operators can provision GCP resources themselves using any IaC tool and provide the resource references in `infrastructure.json`. The adapter doesn't generate or depend on Terraform files. The Helm chart consumes `infrastructure.json` values regardless of how the resources were created.

---

## 19. Testing Strategy

### 19.1 Next.js Adapter E2E Test Harness

Next.js provides an official test harness for validating adapters. The adapter must implement three scripts:

- **Deploy script** (`NEXT_TEST_DEPLOY_SCRIPT_PATH`): builds the app, runs the adapter, deploys to a test GKE cluster (or local Kind cluster), prints the deployment URL to stdout
- **Logs script** (`NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`): returns build and runtime logs
- **Cleanup script** (`NEXT_TEST_CLEANUP_SCRIPT_PATH`): tears down the test deployment

### 19.2 Unit Tests

- Pool classification logic (given adapter config + mock outputs → correct pool assignments, first-match-wins dedup)
- Routing manifest generation (given mock `onBuildComplete` context → correct manifest with routeGraph, pathnames, i18n)
- ext_proc routing decisions (given path + manifest → correct `x-upstream-pool`, `x-output-id`, `x-matched-pathname`)
- Middleware execution via `resolveRoutes` (given mock middleware module + headers → correct ext_proc response)
- Prerender cache evaluation (HIT/STALE/MISS states, tag-based invalidation, TTL handling)
- PPR preamble serving (given cached preamble + postponed state → correct concatenated streaming response)
- Background revalidation (stale entry triggers async handler invocation and cache update)
- On-demand revalidation endpoint (valid token → cache invalidation, invalid token → 403)

### 19.3 Integration Tests

- Full build → Helm chart generation → `helm template` validates generated YAML
- Full build → `extension-chains.json` validated against GCP API schema
- Build → Docker image build → container starts and responds on expected port
- ext_proc + local load balancer simulation via Docker Compose
- CLI `init` → `deploy --dry-run` → validates full artifact pipeline
- CEL expression generation → validated against CEL spec for correctness

---

## 20. Performance Optimizations

Node.js on GCP has meaningful overhead — startup time, memory footprint, and GC pauses. The architecture is designed so that the most performance-sensitive component (the route extension) can be progressively replaced with faster runtimes without changing the pool server or the overall architecture.

### 20.1 Wasm Plugin for Route Extension (No Middleware)

**Impact: Eliminates the routing service Deployment entirely for apps without middleware.**

GCP Service Extensions supports Proxy-Wasm plugins as route extensions. Route resolution is pure regex matching against a static manifest — no network calls, no async, deterministic. This fits within Wasm plugin constraints (1ms CPU, 16 KiB memory per stream, no outbound calls).

The adapter would compile the routing logic to a Proxy-Wasm plugin (Rust → Wasm) at build time. The plugin runs _inside the load balancer process_ — zero network hop, sub-millisecond, no Deployment to manage, no cold starts, no scaling to worry about.

What the Wasm plugin does:

- Read request path from headers
- Match against regexes from the routing manifest (compiled into the Wasm binary at build time)
- Set `x-upstream-pool`, `x-output-id`, `x-matched-pathname`, `x-route-matches` headers
- For PPR routes, set `x-nextjs-ppr: 1`
- Return `immediate_response` for routing-level redirects

What it does **not** do:

- Execute middleware (Wasm plugins can't run arbitrary JS)
- Access request body
- Make outbound network calls

This is the default when `mode: 'auto'` and no middleware exists. The adapter detects `outputs.middleware === null` and generates a Wasm plugin instead of deploying an ext_proc service.

```typescript
// In adapter.config.ts
{
  routeExtension: {
    // 'auto' = Wasm plugin if no middleware, ext_proc if middleware exists (default)
    // 'wasm' = force Wasm plugin (middleware not supported — build error if middleware exists)
    // 'extproc' = force ext_proc Node.js service
    mode: 'auto',
  },
}
```

**Build-time Wasm compilation:** The adapter's `onBuildComplete` compiles the routing manifest into a Rust Proxy-Wasm plugin:

- Route regexes are compiled into the binary (no runtime JSON parsing)
- Pool assignments and PPR route set are embedded as lookup tables
- The compiled `.wasm` binary is emitted alongside the Helm chart
- The Helm hook uploads it to the `LbRouteExtension` as a plugin instead of a callout

**Why this is safe:** The Wasm plugin does exactly the same header mutations as the ext_proc service. PPR, ISR, cache orchestration — all of that happens in the pool server, which the Wasm plugin never touches. The plugin is a pure request-header preprocessor.

**Constraint validation:** The 1ms CPU and 16 KiB memory limits are tight. For a large app with hundreds of routes, all regexes are compiled into the Wasm binary at build time (not interpreted at runtime), so matching is fast. However, the adapter should benchmark the compiled plugin during build and warn if the manifest size exceeds safe thresholds. The `auto` mode default handles this gracefully: if the Wasm plugin can't be compiled within constraints (too many routes, binary too large), the adapter falls back to ext_proc and logs a warning.

### 20.2 Compiled Binary for Route Extension (With Middleware)

**Impact: ~10x faster startup, ~5x lower memory than Node.js ext_proc service.**

When middleware exists, we need a JS runtime to execute the middleware module. But the gRPC server and route resolution don't need Node.js. A compiled binary approach:

- **Go or Rust binary** for the gRPC ext_proc server and route resolution (native regex, no V8 overhead)
- **Embedded V8** (via `v8go` for Go or `deno_core` for Rust) only for middleware execution
- Startup: <50ms (vs ~500ms for Node.js)
- Memory: ~20-30 MiB (vs ~100-150 MiB for Node.js)
- No GC pauses from the gRPC/routing path — V8 GC only affects middleware execution

The route resolution is the hot path (<1ms). Middleware execution is the slow path but runs infrequently (only when middleware matchers match). Keeping them in different runtimes means the hot path never pays for V8 overhead.

**Implementation path:** Start with Node.js (Phase 2), validate correctness against the Next.js e2e harness, then rewrite the ext_proc server in Go/Rust as an optimization pass. The ext_proc protocol and header mutations are identical — the pool server can't tell the difference.

### 20.3 Bun Runtime for Pool Servers

**Impact: Faster cold starts and I/O for handler invocation.**

The pool server invokes compiled Next.js handler modules. These are JavaScript, but Bun is Node-compatible and significantly faster for:

- Module loading (`import()` of handler modules — critical for cold starts)
- HTTP server performance
- File I/O (reading preambles, cache entries)

The Bun adapter already proves handler invocation works under Bun. The pool server Dockerfile could use `oven/bun` as the base image instead of `node`. This requires validation that all Next.js handler modules work correctly under Bun, which the e2e test harness would verify.

### 20.4 Optimization Summary

| Component                            | v1 (Node.js)             | Optimization                 | When to apply                      |
| ------------------------------------ | ------------------------ | ---------------------------- | ---------------------------------- |
| Route extension (no middleware)      | ext_proc Node.js service | Proxy-Wasm plugin (Rust)     | Phase 2+ — eliminates a Deployment |
| Route extension (with middleware)    | ext_proc Node.js service | Go/Rust binary + embedded V8 | After v1 — correctness first       |
| Pool server                          | Node.js                  | Bun runtime                  | After v1 — validate handler compat |
| Route resolution (in either runtime) | `@next/routing` (JS)     | Compiled regex (Rust/Go)     | After v1 — perf tuning             |

The key principle: **the architecture doesn't change.** All optimizations replace the _runtime_ of existing components. The ext_proc protocol, header conventions, Helm chart structure, cache keys, and pool server dispatch logic are all identical regardless of whether the route extension is a Wasm plugin, a Go binary, or a Node.js process.

---

## 21. Future Work

- **EKS provider** — implement `provider: { eks: { ... } }` with CloudFront CDN, ALB Ingress, S3 static assets, and Lambda@Edge or CloudFront Functions for pre-CDN middleware
- **Generic provider** — implement `provider: { generic: { ... } }` with in-cluster Envoy ext_proc for clusters without cloud-specific load balancer extensions
- **Cloud CDN Image Optimization** — switch from Sharp sidecar to native Cloud primitives if/when available (GKE provider)
- **Multi-cluster / Multi-region** — generate Helm charts for multi-cluster GKE with MCS (Multi Cluster Services)
- **Cloud Run hybrid** — deploy edge-runtime routes or low-traffic pools to Cloud Run for scale-to-zero (GKE provider)
- **Adapter dev mode** — if the adapter API gains dev-time hooks, provide local proxy for development that simulates the route extension → CDN → pool server lifecycle
- **Trace-based autoscaling** — use OpenTelemetry metrics from the routing service to inform HPA decisions
- **`@next/routing` stabilization** — migrate from experimental to stable when available
- **Pub/Sub revalidation queue** — decouple ISR background revalidation from pool servers for high-traffic routes (§9.3 Option B)
- **External rewrite proxy** — dedicated reverse-proxy backend pool for transparent proxying of external URLs (Next.js `rewrites` to external APIs). Needs streaming response support, configurable timeouts, body size limits, and its own scaling profile. v1 returns 502 with a clear error directing users to Route Handlers.

---

## Appendix A: Comparison with Existing Approaches

| Approach                        | Routing                                             | Caching                             | Static Assets   | PPR                                                  | Image Optimization        |
| ------------------------------- | --------------------------------------------------- | ----------------------------------- | --------------- | ---------------------------------------------------- | ------------------------- |
| **This adapter (GKE provider)** | Route extension callout (pre-CDN) + `@next/routing` | Valkey cacheHandler + cacheHandlers | GCS + Cloud CDN | Cache-first preamble from Valkey + in-process resume | Sharp sidecar → Cloud CDN |
| **Firebase App Hosting**        | ext_proc (monolith)                                 | Internal                            | Cloud CDN       | ext_proc full-duplex streaming                       | Cloud CDN                 |
| **Vercel**                      | Internal routing layer (pre-CDN)                    | Global edge cache                   | Vercel CDN      | Native                                               | Vercel Image CDN          |
| **OpenNext (AWS)**              | CloudFront + Lambda@Edge                            | DynamoDB/S3                         | S3 + CloudFront | Not yet supported                                    | Lambda                    |
| **Manual K8s**                  | nginx/Ingress rules                                 | In-memory (per-pod)                 | Served from pod | Not supported                                        | Built-in Sharp            |

## Appendix B: Reference Implementations

- **AWS adapter** — `../adapter-aws/` — **primary reference** for `@next/routing` usage (`resolveRoutes` API), deployment manifest structure, router runtime, ISR/revalidation with DynamoDB+SQS, CDK infrastructure generation, and per-function artifact staging
- **Bun adapter** — `../adapter-bun/` — reference for SQLite-backed cache, `modifyConfig` patterns (`cacheHandler` injection), and simple single-server deployment manifests
- **Vercel adapter** — `../adapter-vercel/` — reference for `onBuildComplete` output consumption and Vercel-specific route config generation (proprietary format, not directly reusable)
- **Firebase App Hosting adapter (serve.ts)** — `../../apphosting-adapters/packages/@apphosting/adapter-nextjs/src/bin/serve.ts` — **proof-of-concept for ext_proc**: demonstrates middleware invocation in ext_proc context, PPR resumption via full-duplex streaming, and `modeOverride` usage. Predates `@next/routing` (uses raw `sourceRegex` matching). Not a pattern to follow for routing, but validates the ext_proc mechanism.
- **Next.js adapter docs** — https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath — canonical API reference
- **Adapters RFC** — https://github.com/vercel/next.js/discussions/77740 — design rationale and working group discussion
