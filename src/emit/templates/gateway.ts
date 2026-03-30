// src/emit/templates/gateway.ts
import type { HostConfig, PoolDefinition, RoutingManifest } from "../../types.js";
import { sanitizeK8sName } from "./utils.js";

export function renderGateway({
  releaseName,
  hosts,
}: {
  releaseName: string;
  hosts: HostConfig[];
}): string {
  const hasTls = hosts.some(h => h.tls?.enabled);

  const annotations: Record<string, string> = {};

  // GKE Gateway API uses Certificate Manager for TLS, not ManagedCertificate CRD.
  // The certmap is created by `init` via gcloud certificate-manager commands.
  if (hasTls) {
    annotations["networking.gke.io/certmap"] = `${releaseName}-certmap`;
  }

  const annotationLines = Object.entries(annotations)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join("\n");
  const annotationsBlock = Object.keys(annotations).length > 0
    ? `  annotations:\n${annotationLines}\n`
    : "";

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
  const hostnames = hosts.map(h => h.hostname);
  const defaultPoolName = [...pools.keys()][0] ?? "default";

  // Phase 1: simple path-based routing.
  // We MUST stay under 16 rules for Gateway API.
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

  // Separate catch-all (last rule) from path-prefix rules
  const catchAllRule = finalRules[finalRules.length - 1]!;
  const pathPrefixRules = finalRules.slice(0, -1);

  // All HTTPRoute rules point to the stable "active" Service (no buildId).
  // The active Service's selector is patched by deploy/rollback to point to the live build.
  const pathRulesYaml = pathPrefixRules
    .map((rule) => {
      const backendName = sanitizeK8sName(`${releaseName}-${rule.poolName}`);
      return `    - matches:
        - path: { type: ${rule.matchType}, value: "${rule.path}" }
      backendRefs:
        - name: ${backendName}
          port: 3000`;
    });

  // Phase 2+: header-based routing rules for x-upstream-pool (set by route extension)
  const headerRules = [...pools.keys()].map(poolName => {
    const backendName = sanitizeK8sName(`${releaseName}-${poolName}`);
    return `    - matches:
        - headers:
            - name: x-upstream-pool
              value: ${poolName}
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

  const hostnameLines = hostnames.map(h => `    - "${h}"`).join("\n");

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
