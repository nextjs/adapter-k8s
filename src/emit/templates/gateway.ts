// src/emit/templates/gateway.ts
import type { PoolDefinition } from "../../types.js";

export function renderHTTPRoute({
  releaseName,
  host,
  pools,
  buildId,
}: {
  releaseName: string;
  host: string;
  pools: Map<string, PoolDefinition>;
  buildId: string;
}): string {
  // Phase 1: simple path-prefix-based routing.
  // Each pool gets rules for the path prefixes it covers.
  const rules = [...pools.values()]
    .map((pool) => {
      // Find prefixes for this pool.
      const prefixes = new Set<string>();
      for (const output of pool.outputs) {
        if (output.pathname === "/") {
          prefixes.add("/");
        } else {
          const firstSegment = output.pathname.split("/")[1];
          if (firstSegment) {
            prefixes.add(`/${firstSegment}`);
          }
        }
      }

      // If no paths match, skip this pool's rule.
      if (prefixes.size === 0) return "";

      const matchBlocks = [...prefixes]
        .sort((a, b) => b.length - a.length) // Longer prefixes first
        .map((p) => `        - path: { type: PathPrefix, value: "${p}" }`)
        .join("\n");

      return `    - matches:
${matchBlocks}
      backendRefs:
        - name: ${releaseName}-${pool.name}-${buildId}
          port: 3000`;
    })
    .filter(Boolean)
    .join("\n");

  return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${releaseName}-routes
spec:
  parentRefs:
    - name: ${releaseName}-gateway
  hostnames:
    - ${host}
  rules:
${rules}
`;
}
