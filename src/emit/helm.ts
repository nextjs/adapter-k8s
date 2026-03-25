// src/emit/helm.ts
import type {
  K8sAdapterConfig,
  PoolDefinition,
  RoutingManifest,
} from "../types.js";
import { renderChartYaml } from "./templates/chart-yaml.js";
import { renderValuesYaml } from "./templates/values-yaml.js";
import { renderDeployment } from "./templates/deployment.js";
import { renderService } from "./templates/service.js";
import { renderHPA } from "./templates/hpa.js";
import { renderConfigMap } from "./templates/configmap.js";
import {
  renderGateway,
  renderHTTPRoute,
} from "./templates/gateway.js";
import { sanitizeK8sName } from "./templates/utils.js";

export function generateHelmChart({
  pools,
  buildId,
  nextVersion,
  config,
  imageRegistry,
  routingManifest,
  releaseName = "nextjs",
}: {
  pools: Map<string, PoolDefinition>;
  buildId: string;
  nextVersion: string;
  config: K8sAdapterConfig;
  imageRegistry: string;
  routingManifest: RoutingManifest;
  releaseName?: string;
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
    files[`templates/${poolName}-hpa.yaml`] = renderHPA({
      poolName,
      buildId,
      releaseName,
    });
  }

  return files;
}
