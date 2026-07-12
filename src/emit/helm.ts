// src/emit/helm.ts
import { randomBytes } from "node:crypto";
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../types.js";
import { renderChartYaml } from "./templates/chart-yaml.js";
import { renderInternalSecret } from "./templates/internal-secret.js";
import { renderValkeySecret } from "./templates/valkey-secret.js";
import { renderValuesYaml } from "./templates/values-yaml.js";
import { renderDeployment } from "./templates/deployment.js";
import { renderService, renderActiveService } from "./templates/service.js";
import { renderHPA } from "./templates/hpa.js";
import { renderConfigMap } from "./templates/configmap.js";
import { renderGateway, renderHTTPRoute } from "./templates/gateway.js";
import { renderCdnFilter } from "./templates/gcp-http-filter.js";
import { sanitizeK8sName } from "./templates/utils.js";
import { renderRoutingServiceDeployment } from "./templates/routing-service-deployment.js";
import { renderRoutingServiceService } from "./templates/routing-service-service.js";
import { renderRoutingServiceHPA } from "./templates/routing-service-hpa.js";
import { renderRouteExtUpdateJob } from "./templates/route-ext-update-job.js";
import { renderRouteExtConfigMap } from "./templates/route-ext-configmap.js";
import { renderDeployServiceAccount } from "./templates/deploy-service-account.js";

export function generateHelmChart({
  pools,
  buildId,
  nextVersion,
  config,
  imageRegistry,
  routingManifest,
  releaseName = "nextjs",
  extensionChainJson,
  routingFailOpen,
  infrastructure,
  internalSecret,
}: {
  pools: Map<string, PoolDefinition>;
  buildId: string;
  nextVersion: string;
  config: K8sAdapterConfig;
  imageRegistry: string;
  routingManifest: RoutingManifest;
  releaseName?: string;
  extensionChainJson?: string;
  /** Mirrors the GCP callout failOpen to the server (ROUTING_FAIL_OPEN) for a consistent policy. */
  routingFailOpen?: boolean;
  infrastructure?: { projectId?: string; region?: string };
  /**
   * Shared secret authenticating internal dispatch headers between the routing service and the
   * pools. Generated here if not supplied. Both deployments read it from the rendered Secret,
   * so they always agree; regenerating per build fails safe (mismatch → pool re-resolves).
   */
  internalSecret?: string;
}): Record<string, string> {
  const files: Record<string, string> = {};
  const secret = internalSecret ?? randomBytes(32).toString("hex");
  files["templates/internal-secret.yaml"] = renderInternalSecret({ releaseName, secret });
  // BYO cache: emit the Valkey connection Secret from config. Managed Memorystore instead
  // creates this Secret imperatively at deploy time (URL known only after provisioning).
  if (config.cache?.enabled && config.cache.url) {
    files["templates/valkey-secret.yaml"] = renderValkeySecret({
      releaseName,
      url: config.cache.url,
      ...(config.cache.password ? { password: config.cache.password } : {}),
    });
  }
  // Helm versions must be SemVer. We use a safe version of the buildId as the suffix.
  // We MUST remove leading underscores/dots and replace invalid chars.
  const safeVersionSuffix = buildId
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9.-]/g, "-")
    .slice(0, 32);

  files["Chart.yaml"] = renderChartYaml({
    name: releaseName,
    version: `0.1.0-${safeVersionSuffix || "build"}`,
  });
  files["values.yaml"] = renderValuesYaml({
    pools,
    buildId,
    nextVersion,
    config,
    imageRegistry,
  });

  // Routing and Config
  const routingManifestJson = JSON.stringify(routingManifest, null, 2);
  // A ConfigMap (like any K8s object) must fit under the ~1 MiB etcd object limit.
  // Fail fast at generation time with an actionable error rather than letting `helm
  // install`/`kubectl apply` reject it with an opaque server-side error.
  const MAX_CONFIGMAP_BYTES = 950 * 1024; // ~950 KiB, leaves headroom under the ~1 MiB limit
  const routingManifestBytes = Buffer.byteLength(routingManifestJson, "utf8");
  if (routingManifestBytes > MAX_CONFIGMAP_BYTES) {
    throw new Error(
      `Routing manifest is too large to embed in a ConfigMap: ${routingManifestBytes} bytes ` +
        `exceeds the ${MAX_CONFIGMAP_BYTES}-byte limit (~950 KiB, under the ~1 MiB ` +
        `Kubernetes/etcd object size limit). Reduce the number of routes per manifest ` +
        `or split the app across multiple releases.`,
    );
  }
  files["templates/routing-manifest-configmap.yaml"] = renderConfigMap({
    name: "routing-manifest",
    releaseName,
    data: { "routing-manifest.json": routingManifestJson },
  });

  const gke = config.provider.gke;
  if (gke.gateway?.hosts?.length) {
    files["templates/gateway.yaml"] = renderGateway({
      releaseName,
      hosts: gke.gateway.hosts,
    });

    // Cloud CDN rides the HTTPRoute (GCPHTTPFilter via ExtensionRef), so it only exists
    // when a gateway does. validateConfig guarantees hosts for adapter-built configs;
    // the double condition covers direct generateHelmChart callers.
    let cdnFilterName: string | undefined;
    if (gke.cdn?.enabled) {
      cdnFilterName = sanitizeK8sName(`${releaseName}-cdn`);
      files["templates/cdn-http-filter.yaml"] = renderCdnFilter({
        releaseName,
        cacheMode: gke.cdn.cacheMode,
        cacheKeyHeaders: gke.cdn.cacheKeyHeaders,
      });
    }

    files["templates/http-route.yaml"] = renderHTTPRoute({
      releaseName,
      hosts: gke.gateway.hosts,
      pools,
      buildId,
      routingManifest,
      cdnFilterName,
    });
  }

  for (const poolName of pools.keys()) {
    files[`templates/${poolName}-deployment.yaml`] = renderDeployment({
      poolName,
      buildId,
      releaseName,
      cacheEnabled: config.cache?.enabled ?? false,
    });
    files[`templates/${poolName}-service.yaml`] = renderService({
      poolName,
      buildId,
      releaseName,
    });
    // Stable "active" Service — HTTPRoute points here, selector patched on cutover
    files[`templates/${poolName}-active-service.yaml`] = renderActiveService({
      poolName,
      releaseName,
    });
    files[`templates/${poolName}-hpa.yaml`] = renderHPA({
      poolName,
      buildId,
      releaseName,
    });
  }

  // Phase 2: Routing service templates (only when extension chain is provided)
  if (extensionChainJson) {
    const rs = config.routingService;
    files["templates/routing-service-deployment.yaml"] = renderRoutingServiceDeployment({
      releaseName,
      buildId,
      imageRegistry,
      ...(rs?.resources ? { resources: rs.resources } : {}),
      ...(routingFailOpen !== undefined ? { failOpen: routingFailOpen } : {}),
      ...(rs?.requestTimeoutMs !== undefined ? { requestTimeoutMs: rs.requestTimeoutMs } : {}),
    });
    files["templates/routing-service-service.yaml"] = renderRoutingServiceService({
      releaseName,
    });
    files["templates/routing-service-hpa.yaml"] = renderRoutingServiceHPA({
      releaseName,
      ...(rs?.scaling?.min !== undefined ? { minReplicas: rs.scaling.min } : {}),
      ...(rs?.scaling?.max !== undefined ? { maxReplicas: rs.scaling.max } : {}),
      ...(rs?.scaling?.targetCPU !== undefined ? { targetCPU: rs.scaling.targetCPU } : {}),
    });
    files["templates/route-ext-config.yaml"] = renderRouteExtConfigMap({
      releaseName,
      extensionChainJson,
      projectId: infrastructure?.projectId ?? "",
      region: infrastructure?.region ?? "",
    });

    if (infrastructure?.projectId && infrastructure?.region) {
      files["templates/route-ext-update-job.yaml"] = renderRouteExtUpdateJob({
        releaseName,
        projectId: infrastructure.projectId,
        region: infrastructure.region,
        buildId,
      });
      files["templates/deploy-service-account.yaml"] = renderDeployServiceAccount({
        releaseName,
        projectId: infrastructure.projectId,
      });
    }
  }

  return files;
}
