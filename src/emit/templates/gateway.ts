// src/emit/templates/gateway.ts
import type { HostConfig, PoolDefinition, RoutingManifest } from "../../types.js";
import {
  sanitizeK8sName,
  assertSafeReleaseName,
  assertSafePathname,
  assertSafeHostname,
  assertSafePoolName,
} from "./utils.js";

/**
 * The app HTTPRoute's resource name. Exported because the generic provider's
 * EnvoyExtensionPolicy must target this exact name: Envoy Gateway accepts a policy whose
 * targetRef names a route that does not exist, so a mismatch is SILENT — the Gateway programs,
 * traffic flows, and the ext_proc callout never fires, meaning middleware never runs. Derive it
 * from here rather than restating the string.
 */
// Gateway API restricts HTTPRoute Exact/PathPrefix values to
// ^(?:[-A-Za-z0-9/._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+$ — helm's server-side apply rejects
// the WHOLE route (deploy fails wholesale) for any app whose first path segment carries a
// byte outside that set (full-run v4: non-ASCII slugs, spaces from prerender-encoding — 16
// tests across 3 suites). Percent-encode exactly the disallowed bytes: that is also the
// form clients put on the wire, so the emitted match is the one that actually fires.
// A literal "%" is itself disallowed and becomes %25 — pathnames here are the DECODED form.
const GATEWAY_PATH_SAFE = /[-A-Za-z0-9/._~!$&'()*+,;=:@]/;
export function encodeGatewayPath(path: string): string {
  let out = "";
  for (const ch of path) {
    if (ch.length === 1 && GATEWAY_PATH_SAFE.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

export function httpRouteName(releaseName: string): string {
  return `${releaseName}-routes`;
}

export function renderGateway({
  releaseName,
  hosts,
}: {
  releaseName: string;
  hosts: HostConfig[];
}): string {
  assertSafeReleaseName(releaseName);
  // Sanitize at the point of consumption (AGENTS.md): renderHTTPRoute splices every
  // hostname into a double-quoted YAML scalar and renderGateway's certmap annotation is
  // derived per host upstream. Only config.ts checked them before, which leaves a direct
  // `generateHelmChart`/`renderHTTPRoute` caller unguarded.
  for (const host of hosts) assertSafeHostname(host.hostname);
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

export function renderHTTPRoute({
  releaseName,
  hosts,
  pools,
  routingManifest,
  cdnFilterName,
  disableRequestTimeout = false,
}: {
  releaseName: string;
  hosts: HostConfig[];
  pools: Map<string, PoolDefinition>;
  routingManifest: RoutingManifest;
  /** Name of a GCPHTTPFilter to attach to every rule (enables Cloud CDN). */
  cdnFilterName?: string | undefined;
  /**
   * Disable the Gateway's whole-response deadline on application rules. Envoy's default route
   * timeout is 15 seconds and remains armed until the COMPLETE response arrives, which truncates
   * SSE, RSC and other streamed responses even while bytes are flowing. The pool independently
   * bounds time-to-headers and route maxDuration; Envoy's stream-idle timeout remains the
   * progress/dead-peer bound after this total deadline is disabled.
   *
   * Provider-specific on purpose: the generic Envoy provider opts in, while GKE keeps its
   * provider-owned backend timeout behavior and does not receive an unsupported semantic change.
   */
  disableRequestTimeout?: boolean;
}): string {
  assertSafeReleaseName(releaseName);
  for (const host of hosts) assertSafeHostname(host.hostname);
  for (const poolName of pools.keys()) assertSafePoolName(poolName);

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
  // Gateway API defines 0s as "disabled". Keep this literal provider-owned rather than exposing
  // an arbitrary Duration string that would need a second injection-sensitive config surface.
  const requestTimeoutYaml = disableRequestTimeout
    ? `
      # Envoy defaults a route to a 15s WHOLE-response timeout. Next Route Handlers may return
      # long-lived Response streams (notably text/event-stream), so keep only progress/idle and
      # pool-owned execution bounds instead of truncating a healthy stream at a wall-clock limit.
      timeouts:
        request: 0s`
    : "";

  // Phase 1: simple path-based routing.
  // We MUST stay under 16 rules for Gateway API.
  const prefixToPool = new Map<string, string>();

  for (const [pathname, poolName] of Object.entries(routingManifest.poolAssignments) as [
    string,
    string,
  ][]) {
    if (pathname === "/") continue;

    const firstSegment = pathname.split("/")[1];
    // Skip infrastructure and error-page paths — poolAssignments includes
    // /_next/static/*, /_middleware, /404, /_not-found, and their prefixes would
    // burn slots in the 16-rule budget on paths no app request ever routes by.
    // Next reserves every root segment starting with "_" (_app, _document,
    // _error, _next…), so the underscore rule loses no real app prefix. Root
    // dynamic templates (/[slug], /[...rest]) are likewise skipped: a literal
    // PathPrefix on "/[slug]" can never fire — the catch-all rule owns those.
    // Deliberate rule-budget trade-off: dropping the /_next prefix rule means a
    // CDN-miss /_next/static/* request whose asset belongs to a non-catch-all
    // pool lands on the catch-all pool first and takes one extra cross-pool hop
    // (the pool-server's proxyToPool recovery serves it) — accepted cost to keep
    // scarce HTTPRoute slots for real app prefixes.
    if (!firstSegment || firstSegment.startsWith("_") || firstSegment.startsWith("[")) continue;
    if (pathname === "/404" || pathname === "/500") continue;

    const prefix = `/${firstSegment}`;
    // The prefix is spliced into a quoted YAML scalar below; pathnames are
    // already validated at manifest time, but this template is a consumption
    // point — a hand-rolled/tampered manifest must fail here, not emit junk YAML.
    assertSafePathname(prefix);
    if (!prefixToPool.has(prefix) || poolName !== defaultPoolName) {
      prefixToPool.set(prefix, poolName);
    }
  }

  // N76. Longest prefix first (Gateway API's own precedence), then LEXICOGRAPHIC to make
  // it a total order. Sorting by length alone left equal-length prefixes in
  // `poolAssignments` insertion order, so which prefixes survived the 16-rule budget below
  // depended on manifest KEY ORDER rather than manifest content — the emitted HTTPRoute
  // was not a pure function of the build.
  const sortedPrefixes = [...prefixToPool.keys()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );

  const pathPrefixRulesAll: {
    path: string;
    poolName: string;
    matchType: "Exact" | "PathPrefix";
  }[] = sortedPrefixes.map((prefix) => ({
    path: prefix,
    poolName: prefixToPool.get(prefix)!,
    matchType: "PathPrefix",
  }));

  // N74. The catch-all rule owns every unmatched request, so picking the wrong pool costs a
  // `proxyToPool` cross-pool hop on all of them. This used to take the FIRST
  // `poolAssignments` key matching "root dynamic template OR /_not-found", i.e. whichever
  // of the two classification happened to insert first — and those two frequently live in
  // different pools, so the emitted HTTPRoute was non-deterministic with respect to
  // manifest ORDERING rather than manifest content.
  //
  // Deterministic and priority-ordered instead: the pool owning a ROOT DYNAMIC TEMPLATE
  // (`/[slug]`, `/[...rest]`) wins, because that template is what actually serves arbitrary
  // unmatched paths; `/_not-found` is the fallback, since it only serves the 404. Within
  // each tier the candidate pathnames are sorted, so equal-priority ties resolve the same
  // way on every build regardless of key order.
  const rootDynamic: string[] = [];
  const notFound: string[] = [];
  for (const pathname of Object.keys(routingManifest.poolAssignments)) {
    if (pathname.startsWith("/[")) rootDynamic.push(pathname);
    else if (pathname === "/_not-found") notFound.push(pathname);
  }
  const catchAllSource = [...rootDynamic.sort(), ...notFound][0];
  const catchAllPool =
    catchAllSource !== undefined
      ? (routingManifest.poolAssignments[catchAllSource] as string)
      : defaultPoolName;

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
              # N61: QUOTED. An unquoted pool name like "on"/"no"/"y"/"off"/"true"/"123"
              # renders a YAML boolean/int here; "helm template" accepts it and the
              # apiserver then rejects the chart (HTTPHeaderMatch.value is a string).
              value: "${poolName}"${requestTimeoutYaml}
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
        - path: { type: ${rule.matchType}, value: "${encodeGatewayPath(rule.path)}" }
${requestTimeoutYaml}
      backendRefs:
        - name: ${backendName}
          port: 3000${filtersYaml}`;
  });

  const catchAllRuleYaml = (() => {
    const backendName = sanitizeK8sName(`${releaseName}-${catchAllRule.poolName}`);
    return `    - matches:
        - path: { type: ${catchAllRule.matchType}, value: "${encodeGatewayPath(catchAllRule.path)}" }
${requestTimeoutYaml}
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
  name: ${httpRouteName(releaseName)}
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
  // before any backendRef, so http:// traffic gets a 302 to https:// instead of plaintext
  // service. `port` MUST be omitted: the GKE Gateway controller rejects it (GWCER104) and,
  // with no-error-isolation, one invalid route blocks reconciliation of the ENTIRE Gateway —
  // NEG programming for every later backend change silently stalls (surfaced as LB 503s the
  // first time a deploy actually changed backends). Scheme https already implies 443.
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
            statusCode: 302
`;

  return appRoute + redirectRoute;
}
