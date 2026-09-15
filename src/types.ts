// src/types.ts
import type { NextAdapter, AdapterOutput } from "next";
import type { ResolveRoutesParams } from "@next/routing";
import type { MiddlewareMatcher } from "./routing-common.js";
import type { KubernetesTargetDefinition } from "./target/types.js";

// Use AdapterOutputs from the stable adapter API
// Re-exported from the BuildCompleteContext parameter type
export type AdapterOutputs = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0]["outputs"];

// Re-export Next.js types we use throughout
export type { NextAdapter, AdapterOutput };
export type BuildCompleteContext = Parameters<NonNullable<NextAdapter["onBuildComplete"]>>[0];

// --- Adapter Config ---

/**
 * One runtime environment variable for the app containers.
 *
 * A literal string is rendered inline in the pod template. The reference forms render
 * `secretKeyRef`/`configMapKeyRef` against an object you manage, which is the preferred
 * shape for two reasons: `adapter.config.mjs` is committed, so a literal is the wrong home
 * for a credential; and the chart is emitted during `next build`, so changing a LITERAL
 * requires a rebuild while changing a referenced Secret only needs a pod restart.
 */
export type EnvValue =
  | string
  | { secret: string; key: string; optional?: boolean }
  | { configMap: string; key: string; optional?: boolean };

/** Bulk import of every key in a Secret or ConfigMap, rendered as `envFrom`. */
export type EnvFromSource =
  | { secret: string; prefix?: string; optional?: boolean }
  | { configMap: string; prefix?: string; optional?: boolean };

export interface PoolConfig {
  /**
   * Output type name (`appPages`, `appRoutes`, `pages`, `pagesApi`) or a glob over the
   * build-time route template pathname. Full Next.js dynamic segments (`[slug]`,
   * `[...slug]`, `[[...slug]]`) are literal template names, not minimatch character classes.
   * The same is true when an interception marker is glued to the segment, such as
   * `(.)[slug]`, `(..)[...slug]`, or `(...)[[...slug]]`.
   */
  routes: string[];
  scaling?: { min: number; max: number; targetCPU: number };
  resources?: { cpu?: string; memory?: string; cpuLimit?: string; memoryLimit?: string };
  /** Pool time-to-response-headers budget in seconds. Streaming is unbounded after headers. */
  timeout?: number;
  /** Merged OVER the top-level `env`, so a pool can override a shared default. */
  env?: Record<string, EnvValue>;
  /** Appended AFTER the top-level `envFrom`; later sources win, per Kubernetes. */
  envFrom?: EnvFromSource[];
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
  /** Pool that hosts the stable portable origin. Defaults to the first declared pool. */
  defaultPool?: string;
  /**
   * Runtime environment for every app container. `.env` files are deliberately never staged
   * into an image (they can hold secrets and would be baked into pushed layers), so this is
   * the supported way to give a deployed app its environment.
   *
   * Precedence at runtime matches Next: the pool server calls `loadEnvConfig`, which does NOT
   * overwrite an already-set variable, so anything set here wins over a `.env` file.
   *
   * NOT for `NEXT_PUBLIC_*`. Those are inlined into client bundles at BUILD time; setting one
   * here produces a variable the browser never sees. Validation rejects them for that reason.
   */
  env?: Record<string, EnvValue>;
  /** Bulk `envFrom` sources for every app container. Individual `env` entries win over these. */
  envFrom?: EnvFromSource[];
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
       * Redis AUTH + in-transit encryption (SERVER_AUTHENTICATION) on the managed instance.
       * The pods connect over `rediss://` with the instance AUTH string and server CA injected
       * as `VALKEY_AUTH` / `VALKEY_CA_CERT`.
       *
       * S8: DEFAULTS TO ON (leave unset). Memorystore's own defaults are authEnabled=false and
       * transitEncryption=disabled, and the chart's NetworkPolicies govern Ingress only — so a
       * plaintext instance is readable and WRITABLE by any workload with VPC reachability,
       * which means reading every cached page and injecting content into the production site by
       * overwriting cached HTML/RSC.
       *
       * AUTH is CREATION-ONLY, so the three states differ:
       *  - unset (recommended): create new instances with AUTH; a pre-existing instance without
       *    it is reused with a loud per-deploy warning rather than a forced cache wipe.
       *  - `true`: require it — refuse to reuse an instance that lacks it.
       *  - `false`: explicit opt-out, warned about on every deploy.
       */
      auth?: boolean;
    };
  };
  containerStrategy?: "traced-assets" | "shared-image";
  /**
   * Names of `kubernetes.io/dockerconfigjson` Secrets (e.g. `docker-regcred`) in the app
   * namespace, rendered as `imagePullSecrets` on EVERY pod the chart creates — pool
   * Deployments, the routing-service Deployment, and the traffic-extension registration Job.
   * Required when the registry is private and the nodes carry no machine-level credentials
   * (a private ghcr.io image on stock Talos/k3s nodes is ImagePullBackOff on every pod
   * without this). The adapter never creates the Secret — deliver it via your secrets flow
   * (kubectl create secret docker-registry, ExternalSecrets, SealedSecrets) into the target
   * namespace before the first deploy/sync.
   *
   * Top-level rather than under an `image` block because no image config block exists in
   * this surface (image settings are flat keys, like `containerStrategy`); the name matches
   * the Kubernetes pod-spec field verbatim so the rendered YAML is greppable from config.
   */
  imagePullSecrets?: string[];
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
  /**
   * Static NetworkPolicy source ranges, for pipelines with no cluster to ask.
   *
   * Imperative `deploy` DISCOVERS these at deploy time (gcloud on GKE, the Kubernetes API
   * elsewhere) and never needs this block. `adapter-k8s emit` cannot: it renders with no
   * cluster contact at all, so the CIDRs must be config-supplied (GitOps PR1 — see
   * plans/gitops-deployment-strategies.md §4.2, deploy inventory A4 "replaced"). Both keys
   * also flow into build-metadata.json, and deploy prefers them over live discovery the
   * same way `provider.generic.nodeCidrs` already works — which this block supersedes
   * (that key still maps in when this one is absent).
   *
   * The same staleness trade as provider.generic.nodeCidrs applies: a static range does
   * not follow node autoscale. Give the enclosing subnet range(s), not per-node addresses.
   */
  networkPolicy?: {
    /** Cluster pod range(s) for the broad (non-strict) posture's pod-isolation denylist. */
    podCidrs?: string[];
    /** Node/subnet range(s) the strict posture admits for kubelet probes (S22). */
    nodeCidrs?: string[];
  };
  /** Build-time Kubernetes composition. Legacy `provider` blocks are translated into this. */
  target?: KubernetesTargetDefinition;
  /**
   * @deprecated Use `target: defineTarget(...)`. Legacy provider blocks remain readable
   * through the 0.x release line and will be removed in 1.0. New adapters must use target
   * components instead of extending this union.
   */
  provider?: { gke: GKEProviderConfig } | { generic: GenericProviderConfig };
}

/**
 * Any conformant Kubernetes cluster — K3s, kind, on-prem, or a managed cluster whose cloud
 * integrations you would rather not use. The ext_proc callout is hosted by an in-cluster Envoy
 * (Envoy Gateway) rather than a cloud load balancer, which is what makes this portable: no
 * cloud IAM, no managed CDN, no provider CRDs.
 */
export interface GenericProviderConfig {
  gateway?: {
    /**
     * GatewayClass to attach to. Defaults to `eg` (Envoy Gateway). It must be a class whose
     * controller is Envoy-based — the routing tier is an ext_proc server, and
     * `EnvoyExtensionPolicy` is an Envoy Gateway API. A non-Envoy class will program the
     * Gateway and then silently never call the routing service.
     */
    className?: string;
    hosts: HostConfig[];
    /**
     * Secret holding the TLS cert/key for the HTTPS listener (cert-manager, or one you
     * create). Without it only an HTTP listener is emitted — see renderGenericGateway for why
     * a certificate-less HTTPS listener is worse than none.
     */
    tlsSecretName?: string;
  };
  /**
   * Namespace where the Gateway controller runs its PROXY pods — the source the emitted
   * NetworkPolicy admits to the routing tier's ext_proc port. Defaults to Envoy Gateway's
   * `envoy-gateway-system`. Note this is the proxies' namespace, not the app's.
   */
  gatewayNamespace?: string;
  /**
   * Ingress ranges the kubelet probes arrive from, for the strict NetworkPolicy posture.
   *
   * WHEN TO SET THIS: leave it unset on a fixed-size cluster and deploy discovers the node
   * addresses itself. Set it if nodes come and go — autoscaling, replacement, or a rolling node
   * upgrade — because discovery snapshots the addresses that exist AT DEPLOY TIME. A node added
   * afterwards is not in the allowlist, so its kubelet cannot reach the pods it hosts and they
   * never become ready. That fails safe rather than open, but it is still an outage on the pods
   * scheduled there.
   *
   * Give the range your nodes draw addresses from (e.g. `["10.0.0.0/16"]`) — usually the node
   * subnet. Wider than per-node addresses by definition, so anything else in that range can also
   * reach the dataplane ports; scope it as tightly as your node addressing allows.
   */
  nodeCidrs?: string[];
}

/**
 * The GKE block when this config targets GKE, else undefined.
 *
 * `provider` is a one-key union, so every pre-existing site that reached for `.gke`
 * unconditionally is now a place that must decide what a non-GKE config means. Most of them
 * are GKE-only features (Cloud CDN, certmap, traffic extensions) and correctly no-op; making
 * that explicit at each site is the point of the union.
 */
export function gkeConfigOf(config: K8sAdapterConfig): GKEProviderConfig | undefined {
  return config.provider && "gke" in config.provider ? config.provider.gke : undefined;
}

/**
 * Gateway hosts for whichever provider is configured. The hosts are where the app is served,
 * so anything deriving public URLs (Server Action allowed origins, DNS/TLS checks) wants this
 * rather than a provider-specific path.
 */
export function providerGatewayHosts(config: K8sAdapterConfig): HostConfig[] {
  if (config.target) return [...config.target.exposure.hosts];
  if (config.provider && "gke" in config.provider) {
    return config.provider.gke?.gateway?.hosts ?? [];
  }
  return config.provider?.generic?.gateway?.hosts ?? [];
}

/** The generic block when this config targets a plain Kubernetes cluster, else undefined. */
export function genericConfigOf(config: K8sAdapterConfig): GenericProviderConfig | undefined {
  return config.provider && "generic" in config.provider ? config.provider.generic : undefined;
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
  /** Next route execution limits and pool response-head limits, in milliseconds. */
  routeExecutionTimeouts?: Record<string, number>;
  poolResponseHeadTimeouts?: Record<string, number>;
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
      /** Params that PARTITION the platform cache key (build's config.allowQuery);
       * never-enumerable params are excluded. Feeds dispatch's seen-key registry. */
      allowQuery?: string[];
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
   *
   * A route with no unresolved root params stays minimal. If that render postpones, the pool
   * observes the live cache entry through Next's `onCacheEntryV2` callback and completes the
   * response through the generated entrypoint's canonical `POST` resume contract. The runtime
   * result is the discriminator: the build-time `.rsc` sibling state also appears on routes that
   * must not resume, so it cannot select this behavior safely.
   */
  pprCapableRoutes?: Record<string, { rootParams: string[]; allowQuery?: string[] }>;
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
