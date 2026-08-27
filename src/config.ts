// src/config.ts
import type { K8sAdapterConfig, PoolConfig } from "./types.js";
import { DEFAULT_CDN_CACHE_KEY_HEADERS } from "./emit/templates/gcp-http-filter.js";
import { targetForConfig } from "./target/legacy.js";
import {
  assertSafeHostname,
  assertSafePoolName,
  assertSafeQuantity,
  assertSafeReplicaCount,
  assertSafeSecretName,
  assertSafeTargetCPU,
} from "./emit/templates/utils.js";

// N60 (SECURITY). Resource quantities and scaling numbers from `next.config` reach the
// rendered pod spec / HPA spec with no escaping at either sink (values.yaml -> helm, and
// the routing tier's direct interpolation). Nothing validated them: `validateConfig`
// checked only pool names, hosts, and the cache URL. A memoryLimit of
// `512Mi"\n      hostNetwork: true\n      …` rendered VALID YAML with `hostNetwork: true`
// on the pod, which voids both NetworkPolicy postures (N19). Validate here AND at each
// consumption point (values-yaml.ts, deployment.ts, routing-service-deployment.ts,
// routing-service-hpa.ts) — sanitize-at-consumption is the project convention, and this
// function is not on the path of a direct `generateHelmChart` caller.
function validateResources(
  resources: { cpu?: string; memory?: string; cpuLimit?: string; memoryLimit?: string } | undefined,
  where: string,
): void {
  if (!resources) return;
  const fields = ["cpu", "memory", "cpuLimit", "memoryLimit"] as const;
  for (const field of fields) {
    const value = resources[field];
    if (value !== undefined) assertSafeQuantity(value, `${where}.resources.${field}`);
  }
}

function validateScaling(
  scaling: { min?: number; max?: number; targetCPU?: number } | undefined,
  where: string,
): void {
  if (!scaling) return;
  if (scaling.min !== undefined) assertSafeReplicaCount(scaling.min, `${where}.scaling.min`);
  if (scaling.max !== undefined) assertSafeReplicaCount(scaling.max, `${where}.scaling.max`);
  if (scaling.targetCPU !== undefined) {
    assertSafeTargetCPU(scaling.targetCPU, `${where}.scaling.targetCPU`);
  }
  if (scaling.min !== undefined && scaling.max !== undefined && scaling.min > scaling.max) {
    throw new Error(
      `${where}.scaling.min (${scaling.min}) is greater than ${where}.scaling.max ` +
        `(${scaling.max}): the HorizontalPodAutoscaler would be rejected by the API server.`,
    );
  }
}

// Minimum build-id characters that must survive truncation inside a composed
// `${releaseName}-${poolName}-${buildId}` resource name. 8 chars of Next's
// 21-char base36 default build id (or a git short-SHA) is the shortest prefix
// that still distinguishes builds in practice; fewer and date-style or
// prefix-sharing build ids collide after truncation, which the blue/green
// cutover cannot tolerate (see the collision guard in adapter.ts).
const MIN_SURVIVING_BUILD_ID_CHARS = 8;

// Names the pod template already emits, or that the runtime derives identity from. Letting
// user config shadow one is never what the author meant: NEXT_BUILD_ID in particular is what
// the pool reports as its build and what namespaces its Valkey entries (`k8s:<buildId>:`), so
// overriding it would silently cross-wire two builds' caches.
const RESERVED_ENV_NAMES = new Set([
  "NODE_ENV",
  "NEXT_BUILD_ID",
  "POOL_NAME",
  "RELEASE_NAME",
  "ADAPTER_K8S_PROVIDER_NAME",
  "ADAPTER_K8S_LISTEN_HOST",
  "INTERNAL_HEADER_SECRET",
  "VALKEY_URL",
  "VALKEY_AUTH",
  "VALKEY_CA_CERT",
  "PORT",
  "CONFIG_DIR",
]);

// POSIX-ish, and the subset Kubernetes accepts for an env var name. Deliberately excludes
// lowercase: a lowercase name is almost always a typo for the uppercase one, and admitting
// both invites a pair that differs only by case.
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Validate one `env` map. `where` names the location for the error message — an error that
 * says only "invalid env" sends the reader hunting through pools.
 */
function validateEnvMap(env: unknown, where: string): void {
  if (env === undefined) return;
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new Error(`${where} env must be an object mapping variable names to values`);
  }
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(
        `${where} env has an invalid environment variable name ${JSON.stringify(name)}. ` +
          `Names must match ${ENV_NAME_RE.source} (uppercase letters, digits and underscores, ` +
          `not starting with a digit).`,
      );
    }
    if (name.startsWith("NEXT_PUBLIC_")) {
      throw new Error(
        `${where} env sets ${name}, but NEXT_PUBLIC_* variables are inlined into client ` +
          `bundles at BUILD time — setting one as container environment produces a value the ` +
          `browser never sees, and nothing would report the mistake. Put it in .env.production ` +
          `or the build environment instead.`,
      );
    }
    if (RESERVED_ENV_NAMES.has(name)) {
      throw new Error(
        `${where} env sets ${name}, which is reserved: the adapter emits it into every pool ` +
          `container and the runtime derives behaviour from it. Choose a different name.`,
      );
    }
    if (typeof value === "string") continue;
    if (typeof value !== "object" || value === null) {
      throw new Error(
        `${where} env value for ${name} must be a string, or a ` +
          `{ secret, key } / { configMap, key } reference. Numbers and booleans are rejected ` +
          `because Kubernetes requires env values to be strings.`,
      );
    }
    const ref = value as { secret?: unknown; configMap?: unknown; key?: unknown };
    const hasSecret = typeof ref.secret === "string" && ref.secret.length > 0;
    const hasConfigMap = typeof ref.configMap === "string" && ref.configMap.length > 0;
    if (hasSecret === hasConfigMap) {
      throw new Error(
        `${where} env value for ${name} must reference exactly one of "secret" or "configMap".`,
      );
    }
    if (typeof ref.key !== "string" || ref.key.length === 0) {
      throw new Error(
        `${where} env value for ${name} references a ${hasSecret ? "secret" : "configMap"} ` +
          `but has no "key" — Kubernetes needs the key WITHIN that object to read.`,
      );
    }
  }
}

function validateEnvFrom(envFrom: unknown, where: string): void {
  if (envFrom === undefined) return;
  if (!Array.isArray(envFrom)) {
    throw new Error(`${where} envFrom must be an array of { secret } / { configMap } sources`);
  }
  for (const source of envFrom as Array<Record<string, unknown>>) {
    const hasSecret = typeof source?.secret === "string" && source.secret.length > 0;
    const hasConfigMap = typeof source?.configMap === "string" && source.configMap.length > 0;
    if (hasSecret === hasConfigMap) {
      throw new Error(
        `${where} envFrom entries must reference exactly one of "secret" or "configMap".`,
      );
    }
    if (source.prefix !== undefined && typeof source.prefix !== "string") {
      throw new Error(`${where} envFrom prefix must be a string`);
    }
  }
}

/**
 * One IPv4 or IPv6 CIDR. Deliberately the same charset shape deploy.ts accepts for
 * `provider.generic.nodeCidrs` (`/^[0-9a-fA-F:.]+\/\d{1,3}$/`) — these values reach a helm
 * `--set` brace list on the deploy path and a JSON values array on the emit path, so the
 * charset is what keeps one list entry from splitting into several. Exported for the emit
 * verb, which consumes `networkPolicy.podCidrs`/`nodeCidrs` at values-write time
 * (sanitize-at-consumption, AGENTS.md).
 */
export const CIDR_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

export function assertSafeCidrList(cidrs: unknown, where: string): asserts cidrs is string[] {
  if (!Array.isArray(cidrs)) {
    throw new Error(`${where} must be an array of CIDR strings (e.g. ["10.0.0.0/16"])`);
  }
  const bad = cidrs.filter((c) => typeof c !== "string" || !CIDR_RE.test(c));
  if (bad.length > 0) {
    throw new Error(
      `${where} contains invalid CIDR(s): ${bad.map((c) => JSON.stringify(c)).join(", ")}. ` +
        `Expected entries like "10.0.0.0/16" (matching ${CIDR_RE}).`,
    );
  }
}

export function validateConfig(input: unknown, releaseName?: string): void {
  const config = input as K8sAdapterConfig;
  validateEnvMap(config.env, "adapter config");
  validateEnvFrom(config.envFrom, "adapter config");
  // Registry pull auth for private registries. Each name lands in `imagePullSecrets` on
  // every rendered pod spec — validated here AND at the consumption point
  // (renderImagePullSecrets in emit/templates/utils.ts), per AGENTS.md.
  if (config.imagePullSecrets !== undefined) {
    if (!Array.isArray(config.imagePullSecrets)) {
      throw new Error(
        `imagePullSecrets must be an array of Kubernetes Secret names (e.g. ` +
          `["docker-regcred"]), got ${JSON.stringify(config.imagePullSecrets)}`,
      );
    }
    for (const name of config.imagePullSecrets) assertSafeSecretName(name);
  }
  // GitOps PR1: static NetworkPolicy ranges for `emit`, which renders with no cluster to
  // discover them from. Validated at config time AND at the emit-time consumption point.
  if (config.networkPolicy !== undefined) {
    if (
      typeof config.networkPolicy !== "object" ||
      config.networkPolicy === null ||
      Array.isArray(config.networkPolicy)
    ) {
      throw new Error("networkPolicy must be an object with podCidrs/nodeCidrs arrays");
    }
    if (config.networkPolicy.podCidrs !== undefined) {
      assertSafeCidrList(config.networkPolicy.podCidrs, "networkPolicy.podCidrs");
    }
    if (config.networkPolicy.nodeCidrs !== undefined) {
      assertSafeCidrList(config.networkPolicy.nodeCidrs, "networkPolicy.nodeCidrs");
    }
  }
  if (!config.pools) {
    throw new Error("pools is required in adapter config");
  }

  if (Object.keys(config.pools).length === 0) {
    throw new Error("at least one pool must be defined in adapter config");
  }

  // Gateway API caps an HTTPRoute at 16 rules; the generated route reserves one
  // header rule per pool plus the catch-all (gateway.ts). More pools than that
  // can't be routed at all — reject at config time, not at `kubectl apply`.
  const poolCount = Object.keys(config.pools).length;
  if (poolCount > 15) {
    throw new Error(
      `adapter config defines ${poolCount} pools, but the maximum is 15: the generated ` +
        `HTTPRoute reserves one header rule per pool plus a catch-all, and Gateway API ` +
        `caps an HTTPRoute at 16 rules. Consolidate your pools.`,
    );
  }

  for (const [name, pool] of Object.entries(config.pools) as [string, PoolConfig][]) {
    // N61. Was /^[a-z0-9-]+$/, which admitted a leading/trailing hyphen (an invalid K8s
    // label value and DNS-1123 name component). assertSafePoolName is the same validator
    // the templates now call at each consumption point.
    assertSafePoolName(name);
    validateEnvMap(pool.env, `pool "${name}"`);
    validateEnvFrom(pool.envFrom, `pool "${name}"`);
    // "routing-service" is the reserved routing-tier name: the chart renders the
    // routing tier's Service as `${releaseName}-routing-service`, which is exactly
    // the ACTIVE Service name a pool called "routing-service" would get — two
    // same-named Services in one chart. Readiness checks, cleanup classification,
    // and rollback's edge revert also key off that exact name. Mirrors the
    // deploy-time reservation (assertSafePoolName in cli/deploy.ts).
    if (name === "routing-service") {
      throw new Error(
        `pool name "routing-service" is reserved for the routing tier ` +
          `(<release>-routing-service): the pool's active Service would collide with the ` +
          `routing tier's Service, and readiness checks, cleanup classification, and ` +
          `rollback's edge revert all key off that exact name. Rename the pool.`,
      );
    }
    if (name === "origin") {
      throw new Error(
        `pool name "origin" is reserved for the portable entrypoint ` +
          `(<release>-origin): the pool's active Service would collide with the origin ` +
          `Service. Rename the pool.`,
      );
    }
    // Pool names are spliced into `${releaseName}-${poolName}-${buildId}` K8s
    // resource names (63-char cap, DNS-1123; the `-hpa`/`-hcp` suffix variants
    // truncate 4 chars earlier, at 59). releaseName is itself capped at 40, so
    // 40 does NOT leave headroom on its own — a 40-char release + 40-char pool
    // consumes the entire budget and truncates the build id away completely.
    // The 40 cap here is only the coarse per-field bound; the combined check
    // below (when releaseName is known) is what actually protects the build id.
    if (name.length > 40) {
      throw new Error(
        `pool name "${name}" is too long (${name.length} chars, max 40): it is embedded ` +
          `in K8s resource names that must fit 63 chars alongside the release name and build id.`,
      );
    }
    // Combined budget: sanitizeK8sName truncates `${releaseName}-${poolName}-${buildId}`
    // to 63 chars, and the `-hpa`/`-hcp` variants to 59 — so at least
    // MIN_SURVIVING_BUILD_ID_CHARS of the build id must fit within 59:
    //   releaseName.length + 1 + poolName.length + 1 + 8 <= 59.
    // Without this, a long release+pool prefix truncates the build id away ENTIRELY
    // and every deploy collides with the previous one (guard in adapter.ts fires,
    // but the config is unusable — reject it here with the arithmetic spelled out).
    if (releaseName !== undefined) {
      const surviving = 59 - releaseName.length - 1 - name.length - 1;
      if (surviving < MIN_SURVIVING_BUILD_ID_CHARS) {
        throw new Error(
          `release name "${releaseName}" (${releaseName.length} chars) + pool name ` +
            `"${name}" (${name.length} chars) leave too little room for the build id: ` +
            `${releaseName.length} + 1 + ${name.length} + 1 = ` +
            `${releaseName.length + 1 + name.length + 1} of the 59-char budget ` +
            `(63-char K8s name limit minus the 4-char "-hpa"/"-hcp" suffixes), leaving ` +
            `${Math.max(surviving, 0)} build-id chars — at least ` +
            `${MIN_SURVIVING_BUILD_ID_CHARS} must survive truncation or consecutive ` +
            `deploys collide on the same K8s resource names. Shorten the release name ` +
            `or the pool name.`,
        );
      }
    }
    if (!pool.routes || pool.routes.length === 0) {
      throw new Error(`pool "${name}" must have at least one route`);
    }
    // N60: pod-spec / HPA-spec injection sinks.
    validateResources(pool.resources, `pool "${name}"`);
    validateScaling(pool.scaling, `pool "${name}"`);
    if (
      pool.timeout !== undefined &&
      (!Number.isInteger(pool.timeout) || pool.timeout < 1 || pool.timeout > 86_400)
    ) {
      throw new Error(`pool "${name}" timeout must be an integer from 1 to 86400 seconds`);
    }
  }

  if (config.defaultPool !== undefined) {
    assertSafePoolName(config.defaultPool);
    if (!(config.defaultPool in config.pools)) {
      throw new Error(
        `defaultPool ${JSON.stringify(config.defaultPool)} does not name a configured pool`,
      );
    }
  }

  // N60: the routing tier's quantities are interpolated UNQUOTED
  // (routing-service-deployment.ts) and its scaling numbers as bare scalars
  // (routing-service-hpa.ts) — the least-escaped sinks in the chart.
  validateResources(config.routingService?.resources, "routingService");
  validateScaling(config.routingService?.scaling, "routingService");

  const target = targetForConfig(config);
  const gatewayHosts = [...target.exposure.hosts];
  if (gatewayHosts.length === 0) {
    throw new Error("target exposure must contain at least one host");
  }

  if (config.target && config.cache?.enabled && !config.cache.url) {
    throw new Error(
      "target compositions require cache.url when cache.enabled is true; managed cache provisioning must be declared explicitly by a future target resource",
    );
  }

  for (const hostConfig of gatewayHosts) {
    if (!hostConfig.hostname) {
      throw new Error("each host in provider.gke.gateway.hosts must have a hostname");
    }
    // The hostname is interpolated into quoted YAML scalars (gateway.ts) and helm
    // values — a `"`+newline would break out of the scalar and inject chart YAML.
    // Wildcards ("*.example.com") are supported via Certificate Manager with DNS
    // authorization; init provisions the DNS auth + cert automatically.
    assertSafeHostname(hostConfig.hostname);
  }

  // A generic provider terminates TLS from a Kubernetes Secret (cert-manager, or one you
  // create) — there is no Certificate Manager to resolve it implicitly the way GKE has. Asking
  // for TLS without naming that Secret used to DEGRADE to an HTTP-only listener, which is the
  // worst outcome available: the deploy succeeds, every resource reports healthy, and the app
  // serves credentials over plaintext. Someone who wrote `tls: { enabled: true }` has stated
  // their intent; refuse rather than quietly serve something less safe than they asked for.
  if (config.provider && "generic" in config.provider) {
    // Managed cache provisioning is Memorystore, i.e. GCP-only. `cacheManaged` is derived from
    // "enabled with no url", so a generic config that just says `cache: { enabled: true }` would
    // either fail late in the deploy or actually provision a Google resource for a cluster that
    // has nothing to do with Google. Require the BYO url instead.
    if (config.cache?.enabled && !config.cache.url) {
      throw new Error(
        `cache.url is required when cache.enabled is true on provider.generic. Managed cache ` +
          `provisioning is Memorystore (GCP-only), so there is nothing to provision here — ` +
          `point cache.url at a Valkey/Redis you run (redis:// or rediss://), or set ` +
          `cache.enabled: false to run without a shared cache (ISR/PPR-shell revalidation then ` +
          `becomes per-replica).`,
      );
    }
    const g = config.provider.generic;
    const wantsTls = (g?.gateway?.hosts ?? []).some((h) => h.tls?.enabled);
    if (wantsTls && !g?.gateway?.tlsSecretName) {
      throw new Error(
        `provider.generic.gateway.tlsSecretName is required when any host sets ` +
          `tls.enabled: true. A Gateway listener with no certificateRef never programs, so the ` +
          `alternative is serving plaintext HTTP while reporting success. Create the TLS Secret ` +
          `(cert-manager, or \`kubectl create secret tls\`) and name it here, or set ` +
          `tls.enabled: false to serve HTTP deliberately.`,
      );
    }
  }

  if (config.cache?.enabled) {
    const url = config.cache.url;
    if (url && !/^rediss?:\/\//.test(url)) {
      throw new Error(
        "cache.url must be a redis:// or rediss:// connection string (or omit it to provision managed Memorystore)",
      );
    }
    // This function receives the evaluated config object, so a literal and
    // `process.env.VALKEY_AUTH` are both plain strings here. Do not claim to know which source
    // the operator used. The scaffold documents the environment-variable form instead.
  }
  if (config.imageOptimizer?.enabled) {
    throw new Error("imageOptimizer.enabled is not implemented yet");
  }
  if (config.skewProtection?.enabled) {
    throw new Error("skewProtection.enabled is not implemented yet");
  }
  if (config.routeExtension?.mode === "wasm") {
    throw new Error('routeExtension.mode "wasm" is not implemented; use "auto" or "extproc"');
  }
}

export function applyDefaults(config: K8sAdapterConfig): K8sAdapterConfig {
  return {
    ...config,
    cache: {
      enabled: false,
      provider: "valkey",
      ...config.cache,
    },
    skewProtection: {
      enabled: false,
      duration: "1m",
      ...config.skewProtection,
    },
    routeExtension: {
      mode: "auto",
      ...config.routeExtension,
    },
    containerStrategy: config.containerStrategy ?? "traced-assets",
    // CDN defaults are a GKE concept (Cloud CDN via GCPHTTPFilter). A target composition or
    // generic legacy config passes through without growing a cloud block.
    ...(config.provider && "gke" in config.provider
      ? {
          provider: {
            ...config.provider,
            gke: {
              ...config.provider.gke,
              cdn: {
                enabled: false,
                bucket: "",
                cacheMode: "USE_ORIGIN_HEADERS" as const,
                cacheKeyHeaders: DEFAULT_CDN_CACHE_KEY_HEADERS,
                invalidateOnDeploy: true,
                ...config.provider.gke.cdn,
              },
            },
          },
        }
      : {}),
  };
}
