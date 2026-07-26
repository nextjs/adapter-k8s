import { assertSafeReleaseName, escapeHelmActions } from "./utils.js";

// A per-release Secret holding the shared value that authenticates the routing extension's
// internal dispatch headers to the pool servers (see routing-common.ts / pool-server/server.ts).
// Both the routing-service Deployment and every pool Deployment mount it via secretKeyRef, so
// they always agree on the value. The value is produced at BUILD time and passed in — NOT at
// deploy time in deploy.ts, which is what this comment claimed for a long time.
//
// N50 (review #20): it is no longer `internalSecret ?? randomBytes(32)` in emit/helm.ts, and
// the old "regenerating on each render is acceptable because it fails safe" rationale was
// wrong. The caller (adapter.ts `deriveInternalSecret`) now derives it DETERMINISTICALLY per
// build — HMAC-SHA256(operator key, "<releaseName>\0<buildId>"), the key coming from
// ADAPTER_K8S_INTERNAL_SECRET_KEY or .k8s-adapter/internal-secret.key (mode 0600) — and
// generateHelmChart REQUIRES the argument, so no render can invent one. Two reasons:
// re-emitting the chart for an unchanged build must be a byte-identical no-op (it is the
// only audit for invariant 5), and a rotated secret is not free. The Secret updates while
// the CURRENTLY-SERVING pods still hold the old value, so for the whole rollout window they
// stop trusting dispatch headers and re-resolve locally — middleware then executes TWICE per
// request, double-counting rate limits and analytics. Failing safe is not the same as being
// neutral.
export const INTERNAL_SECRET_NAME = "internal-header-secret";
export const INTERNAL_SECRET_KEY = "secret";

export function renderInternalSecret({
  releaseName,
  secret,
}: {
  releaseName: string;
  secret: string;
}): string {
  assertSafeReleaseName(releaseName);
  // stringData lets Kubernetes base64-encode for us; the value is an opaque token.
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${releaseName}-${INTERNAL_SECRET_NAME}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: internal-secret
type: Opaque
stringData:
  ${INTERNAL_SECRET_KEY}: ${escapeHelmActions(JSON.stringify(secret))}
`;
}

// The env-var snippet (YAML list item) that injects the secret into a container as
// INTERNAL_HEADER_SECRET. Indented to sit under a container's `env:` list.
export function renderInternalSecretEnv(releaseName: string, indent: string): string {
  return `${indent}- name: INTERNAL_HEADER_SECRET
${indent}  valueFrom:
${indent}    secretKeyRef:
${indent}      name: ${releaseName}-${INTERNAL_SECRET_NAME}
${indent}      key: ${INTERNAL_SECRET_KEY}`;
}
