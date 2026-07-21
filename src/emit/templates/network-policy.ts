// src/emit/templates/network-policy.ts
import { assertSafeReleaseName } from "./utils.js";

// Default-deny-by-allowlist NetworkPolicies for the two workload tiers, gated on the
// deploy CLI discovering the cluster's pod CIDRs (`--set global.networkPolicy.podCidrs=
// {...}`). The whole file is wrapped in a helm `if` so an empty list renders nothing
// (no policies) rather than a broken document.
//
// Both tiers allow ingress from 0.0.0.0/0 EXCEPT the pod CIDRs: the external LB and
// Google health-check probes arrive with non-pod source IPs, while in-cluster pods are
// blocked from talking to these ports directly. Pool pods additionally allow ingress
// from SIBLING POOL pods only — cross-pool proxy traffic (pool-server/dispatch.ts
// proxyToPool) is pool-to-pool; the routing service never calls pools, so its
// `routing-service` component is deliberately NOT in the podSelector union. Any pool
// may proxy to any other pool of the release, so every pool component is listed.
export function renderNetworkPolicies({
  releaseName,
  poolNames,
}: {
  releaseName: string;
  poolNames: string[];
}): string {
  assertSafeReleaseName(releaseName);

  // The CIDR list is only ever expanded by helm from values the deploy CLI sets; keep
  // the `range` at column 0 so the rendered `- "cidr"` lines indent under `except:`.
  const exceptCidrs = `            except:
{{- range .Values.global.networkPolicy.podCidrs }}
              - {{ . | quote }}
{{- end }}`;

  const routingPolicy = `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: routing-service
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${releaseName}
      app.kubernetes.io/component: routing-service
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: 0.0.0.0/0
${exceptCidrs}
      ports:
        - protocol: TCP
          port: 8443
        - protocol: TCP
          port: 8081`;

  // One podSelector entry per pool component: any sibling pool may proxy to this one
  // (proxyToPool), but the routing service — same release label, different component —
  // never originates pool traffic and stays blocked.
  const siblingPoolSelectors = poolNames
    .map(
      (p) => `        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ${releaseName}
              app.kubernetes.io/component: ${p}`,
    )
    .join("\n");

  const poolPolicies = poolNames.map(
    (poolName) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${releaseName}-${poolName}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ${releaseName}
      app.kubernetes.io/component: ${poolName}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: 0.0.0.0/0
${exceptCidrs}
${siblingPoolSelectors}
      ports:
        - protocol: TCP
          port: 3000`,
  );

  return `{{- if .Values.global.networkPolicy.podCidrs }}
${[routingPolicy, ...poolPolicies].join("\n---\n")}
{{- end }}
`;
}
