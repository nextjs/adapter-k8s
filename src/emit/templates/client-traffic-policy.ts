// src/emit/templates/client-traffic-policy.ts
import { assertSafeReleaseName, sanitizeK8sName } from "./utils.js";

/**
 * Envoy Gateway ClientTrafficPolicy for the generic provider's Gateway.
 *
 * ONE job today: escaped-slash parity with `next start`. Envoy's default for a path like
 * `/a%2Fb` is UnescapeAndRedirect — a 307 to `/a/b` BEFORE the app is consulted, measured
 * live on k3d (`location: /probe/path`). Next preserves `%2F` (a route param may legally
 * contain an encoded slash: upstream's next-after-app-deploy keys per-path data that way,
 * and segment-cache/encoded-slash-params exists to pin exactly this), so the default
 * silently reroutes those requests to a DIFFERENT route. KeepUnchanged forwards the raw
 * path; route matching and decoding stay Next's job, same as `next start`.
 *
 * GKE parity note: the GXLB topology does not use this CRD; whether GXLB preserves `%2F`
 * is a Phase-3 question for the targeted GKE subset.
 *
 * MERGED-GATEWAY caveat (measured on k3d): when the GatewayClass sets
 * `mergeGateways: true`, EG rejects this policy — "ClientTrafficPolicy is being applied
 * to multiple http (non https) listeners on the same port, which is not allowed" — and
 * the 307 behavior silently remains. The policy is still emitted (it is correct and
 * Accepted for every standalone Gateway, the normal production shape); merged topologies
 * must carry a class-level EnvoyPatchPolicy instead, as the e2e k3d bootstrap does
 * (scripts/e2e-k3d-bootstrap.sh).
 */
export function renderClientTrafficPolicy({ releaseName }: { releaseName: string }): string {
  assertSafeReleaseName(releaseName);
  const gatewayName = sanitizeK8sName(`${releaseName}-gateway`);
  return `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: ClientTrafficPolicy
metadata:
  name: ${sanitizeK8sName(`${releaseName}-client-traffic`)}
  labels:
    app.kubernetes.io/managed-by: adapter-k8s
    app.kubernetes.io/instance: ${releaseName}
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: ${gatewayName}
  http1: {}
  path:
    escapedSlashesAction: KeepUnchanged
`;
}
