// src/config.ts
import type { K8sAdapterConfig } from "./types.js";
import { DEFAULT_CDN_CACHE_KEY_HEADERS } from "./emit/templates/gcp-http-filter.js";
import { assertSafeHostname } from "./emit/templates/utils.js";

// Minimum build-id characters that must survive truncation inside a composed
// `${releaseName}-${poolName}-${buildId}` resource name. 8 chars of Next's
// 21-char base36 default build id (or a git short-SHA) is the shortest prefix
// that still distinguishes builds in practice; fewer and date-style or
// prefix-sharing build ids collide after truncation, which the blue/green
// cutover cannot tolerate (see the collision guard in adapter.ts).
const MIN_SURVIVING_BUILD_ID_CHARS = 8;

export function validateConfig(input: unknown, releaseName?: string): void {
  const config = input as K8sAdapterConfig;
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

  const poolNameRegex = /^[a-z0-9-]+$/;
  for (const [name, pool] of Object.entries(config.pools)) {
    if (!poolNameRegex.test(name)) {
      throw new Error(
        `pool name "${name}" is invalid: must be lowercase alphanumeric and hyphens only`,
      );
    }
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
  }

  if (!config.provider) {
    throw new Error("provider is required in adapter config");
  }

  if (!config.provider.gke?.gateway?.hosts || config.provider.gke.gateway.hosts.length === 0) {
    throw new Error("provider.gke.gateway.hosts is required and must contain at least one host");
  }

  for (const hostConfig of config.provider.gke.gateway.hosts) {
    if (!hostConfig.hostname) {
      throw new Error("each host in provider.gke.gateway.hosts must have a hostname");
    }
    // The hostname is interpolated into quoted YAML scalars (gateway.ts) and helm
    // values — a `"`+newline would break out of the scalar and inject chart YAML.
    // Wildcards ("*.example.com") are supported via Certificate Manager with DNS
    // authorization; init provisions the DNS auth + cert automatically.
    assertSafeHostname(hostConfig.hostname);
  }

  if (config.cache?.enabled) {
    const url = config.cache.url;
    if (url && !/^rediss?:\/\//.test(url)) {
      throw new Error(
        "cache.url must be a redis:// or rediss:// connection string (or omit it to provision managed Memorystore)",
      );
    }
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
    provider: {
      ...config.provider,
      gke: {
        ...config.provider.gke,
        cdn: {
          enabled: false,
          bucket: "",
          cacheMode: "USE_ORIGIN_HEADERS",
          cacheKeyHeaders: DEFAULT_CDN_CACHE_KEY_HEADERS,
          invalidateOnDeploy: true,
          ...config.provider.gke.cdn,
        },
      },
    },
  };
}
