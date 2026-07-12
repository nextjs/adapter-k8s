// src/config.ts
import type { K8sAdapterConfig } from "./types.js";
import { DEFAULT_CDN_CACHE_KEY_HEADERS } from "./emit/templates/gcp-http-filter.js";

export function validateConfig(input: unknown): void {
  const config = input as K8sAdapterConfig;
  if (!config.pools) {
    throw new Error("pools is required in adapter config");
  }

  if (Object.keys(config.pools).length === 0) {
    throw new Error("at least one pool must be defined in adapter config");
  }

  const poolNameRegex = /^[a-z0-9-]+$/;
  for (const [name, pool] of Object.entries(config.pools)) {
    if (!poolNameRegex.test(name)) {
      throw new Error(
        `pool name "${name}" is invalid: must be lowercase alphanumeric and hyphens only`,
      );
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
    // Wildcards are supported via Certificate Manager with DNS authorization.
    // No restriction needed — init provisions the DNS auth + cert automatically.
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
          ...config.provider.gke.cdn,
        },
      },
    },
  };
}
