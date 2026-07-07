// src/emit/templates/gateway.ts
import type { HostConfig, PoolDefinition, RoutingManifest } from "../../types.js";
import { sanitizeK8sName, assertSafeReleaseName } from "./utils.js";

export function renderGateway({
  releaseName,
  hosts,
}: {
  releaseName: string;
  hosts: HostConfig[];
}): string {
  assertSafeReleaseName(releaseName);
  const hasTls = hosts.some((h) => h.tls?.enabled);

  const annotations: Record<string, string> = {};

  // GKE Gateway API uses Certificate Manager for TLS, not ManagedCertificate CRD.
  // The certmap is created by `init` via gcloud certificate-manager commands.
  if (hasTls) {
    annotations["networking.gke.io/certmap"] = `${releaseName}-certmap`;
  }

  const annotationLines = Object.entries(annotations)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join("\n");
  const annotationsBlock =
    Object.keys(annotations).length > 0 ? `  annotations:\n${annotationLines}\n` : "";

  let listeners = `    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same`;

  if (hasTls) {
    // Single HTTPS listener — Certificate Manager certmap handles all hostnames
    listeners += `
    - name: https
      protocol: HTTPS
      port: 443
      allowedRoutes:
        namespaces:
          from: Same`;
  }

  return `apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: ${releaseName}-gateway
${annotationsBlock}spec:
  gatewayClassName: gke-l7-global-external-managed
  addresses:
    - type: NamedAddress
      value: ${releaseName}-ip
  listeners:
${listeners}
`;
}

// ManagedCertificate is no longer used — Certificate Manager replaces it.
// Keeping this as a no-op for backward compat during transition.
export function renderManagedCertificate({
  releaseName,
  hosts,
}: {
  releaseName: string;
  hosts: HostConfig[];
}): string {
  return "";
}

export function renderHTTPRoute({
  releaseName,
  hosts,
  pools,
  buildId,
  routingManifest,
}: {
  releaseName: string;
  hosts: HostConfig[];
  pools: Map<string, PoolDefinition>;
  buildId: string;
  routingManifest: RoutingManifest;
}): string {
  assertSafeReleaseName(releaseName);
  const hostnames = hosts.map((h) => h.hostname);
  const defaultPoolName = [...pools.keys()][0] ?? "default";

  // Phase 1: simple path-based routing.
  // We MUST stay under 16 rules for Gateway API.
  const prefixToPool = new Map<string, string>();

  for (const [pathname, poolName] of Object.entries(routingManifest.poolAssignments) as [
    string,
    string,
  ][]) {
    if (pathname === "/") continue;

    const firstSegment = pathname.split("/")[1];
    if (firstSegment) {
      const prefix = `/${firstSegment}`;
      if (!prefixToPool.has(prefix) || poolName !== defaultPoolName) {
        prefixToPool.set(prefix, poolName);
      }
    }
  }

  const sortedPrefixes = [...prefixToPool.keys()].sort((a, b) => b.length - a.length);

  const pathPrefixRulesAll: {
    path: string;
    poolName: string;
    matchType: "Exact" | "PathPrefix";
  }[] = sortedPrefixes.map((prefix) => ({
    path: prefix,
    poolName: prefixToPool.get(prefix)!,
    matchType: "PathPrefix",
  }));

  let catchAllPool = defaultPoolName;
  for (const [pathname, poolName] of Object.entries(routingManifest.poolAssignments) as [
    string,
    string,
  ][]) {
    if (pathname.startsWith("/[") || pathname.startsWith("/[[") || pathname === "/_not-found") {
      catchAllPool = poolName;
      break;
    }
  }

  const catchAllRule = {
    path: "/",
    poolName: catchAllPool,
    matchType: "PathPrefix" as const,
  };

  // Phase 2+: header-based routing rules for x-upstream-pool (set by route extension).
  // One rule per pool. NOTE: per Gateway API precedence (exact > longest path-prefix >
  // headers) a path-prefix rule can still shadow these, so they are a best-effort fast path,
  // not a correctness guarantee — the pool's proxyToPool (dispatch.ts) recovers a wrong-pool
  // landing at the cost of one extra hop. They still get reserved slots before path-prefix
  // rules so the fast path works whenever precedence allows.
  const headerRules = [...pools.keys()].map((poolName) => {
    const backendName = sanitizeK8sName(`${releaseName}-${poolName}`);
    return `    - matches:
        - headers:
            - name: x-upstream-pool
              value: ${poolName}
      backendRefs:
        - name: ${backendName}
          port: 3000`;
  });

  // Gateway API caps an HTTPRoute at 16 rules TOTAL (path-prefix + header + catch-all).
  // Reserve slots for the required per-pool header rules and the catch-all first, then
  // fill the remaining slots with the highest-priority path-prefix rules (longest prefix
  // first — already sorted). Lower-priority prefixes are dropped; they fall through to the
  // catch-all / header routing, so correctness is preserved.
  const MAX_RULES = 16;
  const availableForPathPrefix = Math.max(0, MAX_RULES - headerRules.length - 1);
  const pathPrefixRules = pathPrefixRulesAll.slice(0, availableForPathPrefix);

  // All HTTPRoute rules point to the stable "active" Service (no buildId).
  // The active Service's selector is patched by deploy/rollback to point to the live build.
  const pathRulesYaml = pathPrefixRules.map((rule) => {
    const backendName = sanitizeK8sName(`${releaseName}-${rule.poolName}`);
    return `    - matches:
        - path: { type: ${rule.matchType}, value: "${rule.path}" }
      backendRefs:
        - name: ${backendName}
          port: 3000`;
  });

  const catchAllRuleYaml = (() => {
    const backendName = sanitizeK8sName(`${releaseName}-${catchAllRule.poolName}`);
    return `    - matches:
        - path: { type: ${catchAllRule.matchType}, value: "${catchAllRule.path}" }
      backendRefs:
        - name: ${backendName}
          port: 3000`;
  })();

  const rules = [...pathRulesYaml, ...headerRules, catchAllRuleYaml].join("\n");

  const hostnameLines = hostnames.map((h) => `    - "${h}"`).join("\n");

  return `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${releaseName}-routes
spec:
  parentRefs:
    - name: ${releaseName}-gateway
  hostnames:
${hostnameLines}
  rules:
${rules}
`;
}
