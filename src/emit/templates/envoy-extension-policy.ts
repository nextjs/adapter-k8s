// src/emit/templates/envoy-extension-policy.ts
//
// Attaches the ext_proc callout to an in-cluster Envoy, for every provider that is not GKE.
//
// WHY THIS EXISTS: neither AWS ALB nor Azure Application Gateway can call ext_proc, so on
// EKS/AKS/generic the load balancer cannot host the routing tier the way GXLB does. An Envoy
// Gateway data plane owns the callout instead, and this policy is how it learns about it.
//
// PROVEN 2026-07-29 on k3s + Envoy Gateway v1.5.4, driving the UNMODIFIED routing-service image
// this adapter already builds for GKE. The backend received the complete dispatch vocabulary —
// `x-output-id`, `x-internal-secret`, `x-matched-pathname`, and `x-mw-evaluated: ran` (middleware
// executed at the edge) — and with the routing service scaled to zero, requests returned 500
// rather than being delivered with middleware skipped. Both halves of the contract hold.
//
// It also DELETES the privileged registration Job: `route-ext-update-job.ts` exists only to call
// gcloud with a Workload-Identity-bound ServiceAccount, and is the credential-bearing entrypoint
// behind the project-scoped IAM exposure. This is a plain namespaced Kubernetes resource — no
// cloud IAM, no impersonation surface.
import { assertSafeReleaseName } from "./utils.js";

/** Per-request callout budget. Kept under the routing service's own handler budget. */
const DEFAULT_MESSAGE_TIMEOUT_MS = 4000;

export function renderEnvoyExtensionPolicy({
  releaseName,
  routeName,
  failOpen = false,
  messageTimeoutMs = DEFAULT_MESSAGE_TIMEOUT_MS,
}: {
  releaseName: string;
  /** The HTTPRoute carrying app traffic; the policy attaches to it, not to the Gateway. */
  routeName: string;
  /**
   * Fail-CLOSED by default, mirroring the emitted extension-chain default. A request delivered
   * while the routing tier is unreachable has had NO middleware applied, which for an app whose
   * middleware does auth is a bypass rather than a degradation.
   */
  failOpen?: boolean;
  messageTimeoutMs?: number;
}): string {
  assertSafeReleaseName(releaseName);

  // Seconds, because the CRD takes a Gateway API Duration and whole seconds keep the rendered
  // value unambiguous.
  const timeout = `${Math.max(1, Math.round(messageTimeoutMs / 1000))}s`;

  return `apiVersion: gateway.envoyproxy.io/v1alpha1
kind: EnvoyExtensionPolicy
metadata:
  name: ${releaseName}-routing-extproc
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      name: ${routeName}
  extProc:
    - backendRefs:
        - name: ${releaseName}-routing-service
          port: 8443
      # Request HEADERS ONLY. The GXLB traffic extension never buffers bodies and the routing
      # service is built for that contract — body-reading middleware cannot run at the edge on
      # either platform, so the two tiers must not diverge here.
      processingMode:
        request: {}
      failOpen: ${failOpen}
      messageTimeout: ${timeout}
`;
}
