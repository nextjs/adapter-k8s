// src/config.ts
import type { K8sAdapterConfig } from "./types.js";

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
    if (hostConfig.hostname.includes('*') && hostConfig.tls?.managedCert) {
      throw new Error(
        `wildcard hostname "${hostConfig.hostname}" cannot use managedCert. ` +
        `GKE ManagedCertificate does not support wildcards. ` +
        `Use Certificate Manager with DNS authorization instead.`
      );
    }
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
          ...config.provider.gke.cdn,
        },
      },
    },
  };
}
