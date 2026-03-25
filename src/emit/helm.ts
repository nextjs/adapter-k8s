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
import { renderHTTPRoute } from "./templates/gateway.js";

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

  files["Chart.yaml"] = renderChartYaml({
    name: releaseName,
    version: `0.1.0+${buildId}`,
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
  if (gke.gateway?.host) {
    files["templates/http-route.yaml"] = renderHTTPRoute({
      releaseName,
      host: gke.gateway.host,
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
