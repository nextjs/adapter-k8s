// src/types.ts
import type { NextAdapter, AdapterOutput } from "next";
import type { ResolveRoutesParams } from "@next/routing";
import type { MiddlewareMatcher } from "./routing-common.js";

// Use AdapterOutputs from the stable adapter API
// Re-exported from the BuildCompleteContext parameter type
export type AdapterOutputs = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0]["outputs"];

// Re-export Next.js types we use throughout
export type { NextAdapter, AdapterOutput };
export type BuildCompleteContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

// --- Adapter Config ---

export interface PoolConfig {
  routes: string[]; // OutputType name ('appPages', 'appRoutes', 'pages', 'pagesApi') or glob pattern
  scaling?: { min: number; max: number; targetCPU: number };
  resources?: { cpu?: string; memory?: string; cpuLimit?: string; memoryLimit?: string };
  timeout?: number;
}

export interface HostConfig {
  hostname: string;
  tls: {
    enabled: boolean;
    managedCert?: boolean;
  };
}

export interface GKEProviderConfig {
  cdn?: {
    enabled: boolean;
    bucket: string;
    origin?: string;
    cacheMode?: "USE_ORIGIN_HEADERS";
    /** Override for the CDN cache-key header set; defaults to the Next.js Vary + dispatch headers. */
    cacheKeyHeaders?: string[];
    /** Invalidate the outgoing build's Cloud CDN entries after a successful cutover/rollback. Default true. */
    invalidateOnDeploy?: boolean;
  };
  gateway?: {
    type: "gateway-api" | "ingress";
    className: string;
    hosts: HostConfig[];
  };
  serviceExtensions?: {
    routeExtension?: { timeout?: number };
  };
}

export interface K8sAdapterConfig {
  pools: Record<string, PoolConfig>;
  cache?: {
    enabled: boolean;
    provider?: "valkey" | "redis";
    /**
     * Bring-your-own connection URL (`redis://` or `rediss://`). When set, the adapter
     * provisions no managed cache and injects this URL into the pods.
     */
    url?: string;
    /** AUTH string for the connection (typically sourced from a secret at deploy time). */
    password?: string;
    /**
     * Managed Memorystore-for-Valkey provisioning, used when `url` is absent (GKE default).
     * The instance's discovery endpoint + AUTH are injected into the pods as `VALKEY_URL` /
     * `VALKEY_AUTH`. This shape firms up alongside the provisioning step.
     */
    memorystore?: {
      region?: string;
      sizeGb?: number;
      tier?: "BASIC" | "STANDARD_HA";
      /**
       * Enable Redis AUTH + in-transit encryption (SERVER_AUTHENTICATION) on the managed
       * instance. The pods then connect over `rediss://` with the instance AUTH string and
       * server CA injected as `VALKEY_AUTH` / `VALKEY_CA_CERT`. Recommended — without it any
       * workload that can reach the VPC endpoint can read/write the shared cache. NOTE: AUTH
       * can only be set at instance creation; an existing non-AUTH instance must be recreated
       * (`destroy` removes it) before enabling.
       */
      auth?: boolean;
    };
  };
  containerStrategy?: "traced-assets" | "shared-image";
  imageOptimizer?: { enabled: boolean; mode: "sidecar" };
  skewProtection?: { enabled: boolean; duration: string };
  routeExtension?: { mode: "auto" | "wasm" | "extproc" };
  /** ext_proc routing service (the middleware tier) tuning. */
  routingService?: {
    resources?: { cpu?: string; memory?: string; cpuLimit?: string; memoryLimit?: string };
    scaling?: { min?: number; max?: number; targetCPU?: number };
    /** Per-request handler budget in ms (< the 5s ext_proc deadline). Default 4000. */
    requestTimeoutMs?: number;
    /**
     * Callout-failure policy. "auto" (default) = fail-closed when the app has
     * middleware (never bypass auth), fail-open otherwise. "open"/"closed" force it.
     */
    failureMode?: "auto" | "open" | "closed";
  };
  provider: { gke: GKEProviderConfig };
}

// --- Internal Types ---

export interface PoolDefinition {
  name: string;
  outputs: Array<
    | AdapterOutput["APP_PAGE"]
    | AdapterOutput["APP_ROUTE"]
    | AdapterOutput["PAGES"]
    | AdapterOutput["PAGES_API"]
  >;
  config: PoolConfig;
}

// The route graph shape passed to resolveRoutes — matches ctx.routing from onBuildComplete
export type RouteGraph = ResolveRoutesParams["routes"] & {
  shouldNormalizeNextData: boolean;
  rsc: BuildCompleteContext["routing"]["rsc"];
};

export interface RoutingManifest {
  routeGraph: RouteGraph;
  pathnames: string[];
  i18n: BuildCompleteContext["config"]["i18n"] | null;
  buildId: string;
  /** ISO timestamp of when this manifest was generated (build time). */
  builtAt: string;
  basePath: string;
  trailingSlash?: boolean;
  middleware: {
    filePath: string;
    runtime?: string;
    /** Compiled `config.matcher` — middleware only runs on matching requests. */
    matchers?: MiddlewareMatcher[];
  } | null;
  poolAssignments: Record<string, string>;
  pprRoutes: Record<
    string,
    {
      postponedState: string;
      fallbackFilePath: string;
      /** Headers Next requires on the internal resume invocation (currently `next-resume: 1`). */
      chainHeaders?: Record<string, string>;
      /** Headers/status generated with the shell and sent on the combined client response. */
      initialHeaders?: Record<string, string | string[]>;
      initialStatus?: number;
      /**
       * Cache tags baked into the prerendered shell (from the build's
       * `fallback.initialHeaders['x-next-cache-tags']`). The pool checks these against the
       * shared Valkey tag manifest: if any has been revalidated since this build deployed, it
       * does a fresh blocking render instead of resuming the stale shell.
       */
      tags?: string[];
      /** Shell revalidate/expire (seconds) from the build; reserved for shell seeding. */
      revalidate?: number;
      expire?: number;
    }
  >;
  /**
   * PPR-capable route TEMPLATES (`renderingMode: PARTIALLY_STATIC`) whose build emitted NO
   * fallback shell (`fallback: null`), keyed by template pathname. Disjoint from `pprRoutes`,
   * which carries only the shell-BEARING templates.
   *
   * `rootParams` is the prerender manifest's `fallbackRootParams` — the ROOT params still
   * unresolved when the build declined to emit the shell. The two flavours must be handled
   * OPPOSITELY (see dispatch.ts minimalMode):
   *   - non-empty (`/[lang]/posts/[id]`): upstream keeps unknown root branches blocking and
   *     renders a runtime shell per root-param value, so the pool must run the route NON-minimal
   *     and let Next own that shell lifecycle.
   *   - empty (`/without-io/[slug]` with no Suspense boundary above the params access): the
   *     shell was unemittable for a reason that makes upstream do a plain dynamic render, so the
   *     pool must keep the route MINIMAL. Running it non-minimal makes Next resume a fallback
   *     shell that upstream deliberately does not resume (app-dir/fallback-shells).
   * Membership of EITHER flavour also marks the route as PPR, which keeps it out of the
   * emulated-SSG non-minimal flip (dispatch.ts N13).
   */
  pprCapableRoutes?: Record<string, { rootParams: string[] }>;
  nextVersion: string;
}

export interface PoolManifest {
  buildId: string;
  poolName: string;
  outputs: Record<
    string,
    {
      id: string;
      filePath: string;
      pathname: string;
      type: string;
      runtime?: string;
    }
  >;
}

export interface StaticAssetEntry {
  pathname: string;
  filePath: string;
  cacheControl: string;
  headers?: Record<string, string | string[]>;
  status?: number;
  ppr?: boolean;
  /** Seconds until the prerender is stale (ISR). false/absent = static forever. */
  revalidate?: number | false;
  /**
   * True for prerender outputs (pages/route payloads seeded at build). These are
   * never served from the manifest file: Next's incremental cache owns staleness,
   * draft mode, and revalidatePath/Tag — including for revalidate:false entries.
   */
  prerender?: boolean;
}
