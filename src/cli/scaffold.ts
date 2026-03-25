// src/cli/scaffold.ts

export interface ScaffoldOptions {
  projectId: string;
  region: string;
  host: string;
  bucket: string;
  registry: string;
}

export function generateAdapterConfig(options: ScaffoldOptions): string {
  return `import { createK8sAdapter } from '@next-community/adapter-k8s';

export default createK8sAdapter({
  pools: {
    default: {
      routes: ['appPages', 'appRoutes', 'pagesApi'],
      scaling: { min: 2, max: 10, targetCPU: 70 },
    },
  },

  cache: { enabled: true, provider: 'valkey' },
  containerStrategy: 'traced-assets',
  skewProtection: { enabled: true, duration: '5m' },

  provider: {
    gke: {
      cdn: {
        enabled: true,
        bucket: '${options.bucket}',
      },
      gateway: {
        type: 'gateway-api',
        className: 'gke-l7-global-external-managed',
        host: '${options.host}',
        tls: { enabled: true, managedCert: true },
      },
    },
  },
});
`;
}

export interface InfrastructureConfig {
  projectId: string;
  region: string;
  host: string;
  gcsBucket: string;
  containerRegistry: string;
  gatewayName: string;
  routeExtensionName: string;
}

export function generateInfrastructureJson(config: InfrastructureConfig): string {
  return JSON.stringify({
    projectId: config.projectId,
    region: config.region,
    host: config.host,
    gcsBucket: config.gcsBucket,
    containerRegistry: config.containerRegistry,
    gatewayName: config.gatewayName,
    routeExtensionName: config.routeExtensionName,
  }, null, 2);
}
