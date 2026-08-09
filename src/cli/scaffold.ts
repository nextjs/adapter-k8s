// src/cli/scaffold.ts
import { K8S_NAMESPACE } from "../emit/templates/utils.js";

export interface ScaffoldOptions {
  projectId: string;
  region: string;
  hosts: string[];
  bucket: string;
  registry: string;
}

export function generateAdapterConfig(options: ScaffoldOptions): string {
  const hostEntries = options.hosts
    .map((h) => `      { hostname: '${h}', tls: { enabled: true, managedCert: true } },`)
    .join("\n");

  return `import { createK8sAdapter } from '@next-community/adapter-k8s';

export default createK8sAdapter({
  pools: {
    default: {
      routes: ['appPages', 'appRoutes', 'pagesApi'],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },

  containerStrategy: 'traced-assets',
  // Shared cross-replica cache (ISR/PPR revalidation, fetch cache). Requires a Valkey
  // instance — provisioned automatically on GKE, or bring your own via cache.endpoint:
  //   cache: { enabled: true, provider: 'valkey' },
  // Not yet implemented (validates but throws at build time):
  //   skewProtection: { enabled: true, duration: '5m' },

  provider: {
    gke: {
      cdn: {
        enabled: true,
        bucket: '${options.bucket}',
      },
      gateway: {
        type: 'gateway-api',
        className: 'gke-l7-global-external-managed',
        hosts: [
${hostEntries}
        ],
      },
    },
  },
});
`;
}

export interface InfrastructureConfig {
  projectId: string;
  region: string;
  hosts: string[];
  gcsBucket: string;
  containerRegistry: string;
  gatewayName: string;
  routeExtensionName: string;
  releaseName: string;
  namespace?: string;
}

export function generateInfrastructureJson(config: InfrastructureConfig): string {
  return JSON.stringify(
    {
      projectId: config.projectId,
      region: config.region,
      hosts: config.hosts,
      gcsBucket: config.gcsBucket,
      containerRegistry: config.containerRegistry,
      gatewayName: config.gatewayName,
      routeExtensionName: config.routeExtensionName,
      releaseName: config.releaseName,
      namespace: config.namespace ?? K8S_NAMESPACE,
    },
    null,
    2,
  );
}
