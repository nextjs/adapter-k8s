// src/cli/scaffold.ts

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
  // Not yet implemented — uncomment once the corresponding feature ships, otherwise these
  // validate but do nothing:
  //   cache: { enabled: true, provider: 'valkey' },   // shared middle cache (in progress)
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
    },
    null,
    2,
  );
}
