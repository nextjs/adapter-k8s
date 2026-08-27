import type { AdapterOutputs } from "./types.js";
import {
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeReleaseName,
} from "./emit/templates/utils.js";

export interface ExtensionChainOptions {
  celExpression: string;
  releaseName: string;
  namespace: string;
  projectId: string;
  timeout: string;
  failureModeAllow: boolean;
}

export function determineFailureMode(
  outputs: AdapterOutputs,
  mode?: "auto" | "open" | "closed",
): boolean {
  if (mode === "open") return true;
  if (mode === "closed") return false;
  // "auto": fail-closed when middleware exists (a routing outage must not silently
  // bypass auth); fail-open otherwise (bypassing pure routing is safe).
  return !outputs.middleware;
}

export function generateExtensionChain(options: ExtensionChainOptions): string {
  const { celExpression, releaseName, namespace, projectId, timeout, failureModeAllow } = options;
  assertSafeReleaseName(releaseName);
  assertSafeNamespace(namespace);
  assertSafeProjectId(projectId);

  const chain = [
    {
      name: "nextjs-routing",
      matchCondition: { celExpression },
      extensions: [
        {
          name: "routing-service",
          authority: `${releaseName}-routing-service.${namespace}.svc.cluster.local`,
          service: `projects/${projectId}/global/backendServices/${releaseName}-routing-service`,
          timeout,
          supportedEvents: ["REQUEST_HEADERS"],
          failOpen: failureModeAllow,
        },
      ],
    },
  ];

  return JSON.stringify(chain, null, 2);
}
