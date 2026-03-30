import type { AdapterOutputs } from './types.js';

export interface ExtensionChainOptions {
  celExpression: string;
  releaseName: string;
  namespace: string;
  projectId: string;
  region: string;
  timeout: string;
  failureModeAllow: boolean;
}

export function determineFailureMode(outputs: AdapterOutputs): boolean {
  return !outputs.middleware;
}

export function generateExtensionChain(options: ExtensionChainOptions): string {
  const { celExpression, releaseName, namespace, projectId, region, timeout, failureModeAllow } = options;

  const chain = [{
    name: 'nextjs-routing',
    matchCondition: { celExpression },
    extensions: [{
      name: 'routing-service',
      authority: `${releaseName}-routing-service.${namespace}.svc.cluster.local`,
      service: `projects/${projectId}/global/backendServices/${releaseName}-routing-service`,
      timeout,
      supportedEvents: ['REQUEST_HEADERS'],
      failOpen: failureModeAllow,
    }],
  }];

  return JSON.stringify(chain, null, 2);
}
