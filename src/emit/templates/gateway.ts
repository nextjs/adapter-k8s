// src/emit/templates/gateway.ts
import type { PoolDefinition, RoutingManifest } from "../../types.js";
import { sanitizeK8sName } from "./utils.js";

export function renderHTTPRoute({
  releaseName,
  host,
  pools,
  buildId,
  routingManifest,
}: {
  releaseName: string;
  host: string;
  pools: Map<string, PoolDefinition>;
  buildId: string;
  routingManifest: RoutingManifest;
}): string {
  const defaultPoolName = [...pools.keys()][0] ?? "default";

  // Phase 1: simple path-based routing.
  // We MUST stay under 16 rules for Gateway API.
  // We achieve this by collapsing paths into coarse prefixes (first path segment).
  const prefixToPool = new Map<string, string>();

  for (const [pathname, poolName] of Object.entries(
    routingManifest.poolAssignments,
  ) as [string, string][]) {
    if (pathname === "/") continue;

    const firstSegment = pathname.split("/")[1];
    if (firstSegment) {
      const prefix = `/${firstSegment}`;
      if (!prefixToPool.has(prefix) || poolName !== defaultPoolName) {
        prefixToPool.set(prefix, poolName);
      }
    }
  }

  const sortedPrefixes = [...prefixToPool.keys()].sort(
    (a, b) => b.length - a.length,
  );

  const rulesList: {
    path: string;
    poolName: string;
    matchType: "Exact" | "PathPrefix";
  }[] = [];

  for (const prefix of sortedPrefixes) {
    rulesList.push({
      path: prefix,
      poolName: prefixToPool.get(prefix)!,
      matchType: "PathPrefix",
    });
  }

  let catchAllPool = defaultPoolName;
  for (const [pathname, poolName] of Object.entries(
    routingManifest.poolAssignments,
  ) as [string, string][]) {
    if (
      pathname.startsWith("/[") ||
      pathname.startsWith("/[[") ||
      pathname === "/_not-found"
    ) {
      catchAllPool = poolName;
      break;
    }
  }

  rulesList.push({ path: "/", poolName: catchAllPool, matchType: "PathPrefix" });

  const finalRules = rulesList.slice(0, 15);
  if (rulesList.length > 15) {
    finalRules[14] = rulesList[rulesList.length - 1]!;
  }

  const rules = finalRules
    .map((rule) => {
      const backendName = sanitizeK8sName(`${releaseName}-${rule.poolName}-${buildId}`);
      return `    - matches:
        - path: { type: ${rule.matchType}, value: "${rule.path}" }
      backendRefs:
        - name: ${backendName}
          port: 3000`;
    })
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
