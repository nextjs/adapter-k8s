// src/emit/templates/gateway.ts
import type { PoolDefinition, RoutingManifest } from "../../types.js";

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
  // Phase 1: simple path-based routing.
  const rulesList: { path: string; poolName: string; matchType: "Exact" | "PathPrefix" }[] = [];
  const defaultPoolName = [...pools.keys()][0] ?? 'default';

  for (const [pathname, poolName] of Object.entries(routingManifest.poolAssignments)) {
    if (pathname === "/") {
      rulesList.push({ path: "/", poolName, matchType: "Exact" });
      continue;
    }

    if (pathname.startsWith("/_next/static/") || pathname.startsWith("/api/")) {
      rulesList.push({ path: pathname, poolName, matchType: "PathPrefix" });
      continue;
    }

    if (pathname.includes("[") || pathname.includes("]")) {
      // Dynamic route. We use PathPrefix up to the first dynamic segment.
      const staticPart = pathname.split("[")[0];
      if (staticPart && staticPart !== "/") {
        rulesList.push({ path: staticPart, poolName, matchType: "PathPrefix" });
      }
      // We do NOT add a PathPrefix: "/" rule here for root dynamic routes.
      // Root dynamic routes will be caught by the fallback catch-all rule at the end.
      continue;
    }

    rulesList.push({ path: pathname, poolName, matchType: "Exact" });
  }

  // Deduplicate rules (staticPart might add duplicates)
  const uniqueRules = new Map<string, typeof rulesList[0]>();
  for (const rule of rulesList) {
    const key = `${rule.matchType}:${rule.path}`;
    if (!uniqueRules.has(key) || rule.path.length > uniqueRules.get(key)!.path.length) {
      uniqueRules.set(key, rule);
    }
  }

  // Sort by specificity (longest path first) to ensure correct precedence in Gateway API.
  const sortedRules = [...uniqueRules.values()].sort((a, b) => {
    // Exact matches always beat PathPrefix of the same length
    if (a.path === b.path && a.matchType !== b.matchType) {
      return a.matchType === "Exact" ? -1 : 1;
    }
    return b.path.length - a.path.length;
  });

  // Determine which pool should handle the catch-all PathPrefix: "/" rule.
  // Prefer a pool that actually has a root-level dynamic route assigned.
  let catchAllPool = defaultPoolName;
  for (const [pathname, poolName] of Object.entries(routingManifest.poolAssignments)) {
    if (pathname.startsWith("/[") || pathname.startsWith("/[[") || pathname === "/_not-found") {
      catchAllPool = poolName;
      break;
    }
  }

  // Always add a fallback catch-all rule pointing to the identified catch-all pool.
  // This handles root dynamic routes (/[slug]), unmapped paths, and 404s.
  sortedRules.push({ path: "/", poolName: catchAllPool, matchType: "PathPrefix" });

  const rules = sortedRules
    .map((rule) => {
      return `    - matches:
        - path: { type: ${rule.matchType}, value: "${rule.path}" }
      backendRefs:
        - name: ${releaseName}-${rule.poolName}-${buildId}
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
