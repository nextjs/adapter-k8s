// src/emit/helm.ts
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../types.js";
import { renderChartYaml } from "./templates/chart-yaml.js";
import { renderValuesYaml } from "./templates/values-yaml.js";
import { renderDeployment } from "./templates/deployment.js";
import { renderService, renderActiveService } from "./templates/service.js";
import { renderHPA } from "./templates/hpa.js";
import { renderConfigMap } from "./templates/configmap.js";
import { renderGateway, renderHTTPRoute } from "./templates/gateway.js";
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
  infrastructure,
}: {
  pools: Map<string, PoolDefinition>;
  buildId: string;
  nextVersion: string;
  config: K8sAdapterConfig;
  imageRegistry: string;
  routingManifest: RoutingManifest;
  releaseName?: string;
  extensionChainJson?: string;
  infrastructure?: { projectId?: string; region?: string };
}): Record<string, string> {
  const files: Record<string, string> = {};
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
  files["templates/routing-manifest-configmap.yaml"] = renderConfigMap({
    name: "routing-manifest",
    releaseName,
    data: { "routing-manifest.json": JSON.stringify(routingManifest, null, 2) },
  });

  const gke = config.provider.gke;
  if (gke.gateway?.hosts?.length) {
    files["templates/gateway.yaml"] = renderGateway({
      releaseName,
      hosts: gke.gateway.hosts,
    });

    files["templates/http-route.yaml"] = renderHTTPRoute({
      releaseName,
      hosts: gke.gateway.hosts,
      pools,
      buildId,
      routingManifest,
    });
  }

  for (const poolName of pools.keys()) {
    files[`templates/${poolName}-deployment.yaml`] = renderDeployment({
      poolName,
      buildId,
      releaseName,
    });
    files[`templates/${poolName}-service.yaml`] = renderService({
      poolName,
      buildId,
      releaseName,
    });
    // Stable "active" Service — HTTPRoute points here, selector patched on cutover
    files[`templates/${poolName}-active-service.yaml`] = renderActiveService({
      poolName,
      buildId,
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
    files["templates/routing-service-deployment.yaml"] = renderRoutingServiceDeployment({
      releaseName,
      buildId,
      imageRegistry,
    });
    files["templates/routing-service-service.yaml"] = renderRoutingServiceService({
      releaseName,
    });
    files["templates/routing-service-hpa.yaml"] = renderRoutingServiceHPA({
      releaseName,
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
