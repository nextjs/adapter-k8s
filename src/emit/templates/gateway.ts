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
  cdnFilterName,
}: {
  releaseName: string;
  hosts: HostConfig[];
  pools: Map<string, PoolDefinition>;
  buildId: string;
  routingManifest: RoutingManifest;
  /** Name of a GCPHTTPFilter to attach to every rule (enables Cloud CDN). */
  cdnFilterName?: string | undefined;
}): string {
  assertSafeReleaseName(releaseName);

  // GKE allows one ExtensionRef filter per rule; attaching the same filter from every
  // rule is fine (the limit is per rule, not per filter). The name is already sanitized
  // by its single owner (helm.ts), so it is interpolated verbatim here.
  //
  // The ResponseHeaderModifier surfaces Cloud CDN diagnostics: the load balancer expands
  // the {cdn_cache_status} / {cdn_cache_id} variables at the edge (hit|miss|revalidated|
  // stale|uncacheable|disabled, plus the serving cache node), so cache behaviour is
  // observable per-response without log-diving.
  const filtersYaml = cdnFilterName
    ? `
      filters:
        - type: ExtensionRef
          extensionRef:
            group: networking.gke.io
            kind: GCPHTTPFilter
            name: ${cdnFilterName}
        - type: ResponseHeaderModifier
          responseHeaderModifier:
            set:
              - name: x-cache-status
                value: "{cdn_cache_status}"
              - name: x-cache-id
                value: "{cdn_cache_id}"`
    : "";
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
          port: 3000${filtersYaml}`;
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
          port: 3000${filtersYaml}`;
  });

  const catchAllRuleYaml = (() => {
    const backendName = sanitizeK8sName(`${releaseName}-${catchAllRule.poolName}`);
    return `    - matches:
        - path: { type: ${catchAllRule.matchType}, value: "${catchAllRule.path}" }
      backendRefs:
        - name: ${backendName}
          port: 3000${filtersYaml}`;
  })();

  const rules = [...pathRulesYaml, ...headerRules, catchAllRuleYaml].join("\n");

  const hostnameLines = hostnames.map((h) => `    - "${h}"`).join("\n");

  // When TLS is enabled the app route must attach ONLY to the https listener —
  // otherwise http:// traffic is served plaintext. Plain HTTP is instead upgraded by
  // the redirect route below (attached to the http listener). Without TLS the gateway
  // has just the http listener, so no sectionName is needed (or valid).
  const hasTls = hosts.some((h) => h.tls?.enabled);
  const appParentRef = hasTls
    ? `    - name: ${releaseName}-gateway
      sectionName: https`
    : `    - name: ${releaseName}-gateway`;

  const appRoute = `apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${releaseName}-routes
spec:
  parentRefs:
${appParentRef}
  hostnames:
${hostnameLines}
  rules:
${rules}
`;

  if (!hasTls) return appRoute;

  // HTTP -> HTTPS redirect: a rule whose only filter is RequestRedirect short-circuits
  // before any backendRef (GKE Gateway API supports RequestRedirect with scheme/port/
  // statusCode), so http:// traffic gets a 302 to https:// instead of plaintext service.
  const redirectRoute = `---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ${releaseName}-http-redirect
spec:
  parentRefs:
    - name: ${releaseName}-gateway
      sectionName: http
  hostnames:
${hostnameLines}
  rules:
    - filters:
        - type: RequestRedirect
          requestRedirect:
            scheme: https
            port: 443
            statusCode: 302
`;

  return appRoute + redirectRoute;
}
