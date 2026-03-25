// src/config.ts
import type { K8sAdapterConfig } from "./types.js";

export function validateConfig(config: K8sAdapterConfig): void {
  if (!config.pools) {
    throw new Error("pools is required in adapter config");
  }

  if (!config.provider) {
    throw new Error("provider is required in adapter config");
  }

  for (const [name, pool] of Object.entries(config.pools)) {
    if (!pool.routes || pool.routes.length === 0) {
      throw new Error(`pool "${name}" must have at least one route`);
    }
  }

  if (!config.provider.gke?.gateway?.host) {
    throw new Error('provider.gke.gateway.host is required');
  }
}

export function applyDefaults(config: K8sAdapterConfig): K8sAdapterConfig {
  return {
    ...config,
    containerStrategy: config.containerStrategy ?? "traced-assets",
    provider: {
      ...config.provider,
      gke: {
        ...config.provider.gke,
        cdn: {
          enabled: false,
          bucket: "",
          ...config.provider.gke.cdn,
        },
      },
    },
  };
}
