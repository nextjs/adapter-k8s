import { assertSafeReleaseName } from "./utils.js";

// A per-release Secret holding the shared value that authenticates the routing extension's
// internal dispatch headers to the pool servers (see routing-common.ts / pool-server/server.ts).
// Both the routing-service Deployment and every pool Deployment mount it via secretKeyRef, so
// they always agree on the value. The value is generated at emit time (deploy.ts) and passed in.
//
// Regenerating on each deploy is acceptable: the chart updates both sides together, and the
// brief rolling-update window where old pods hold the previous secret fails SAFE — a mismatch
// just makes the pool re-resolve locally (Phase 1) instead of trusting the dispatch headers.
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
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: internal-secret
type: Opaque
stringData:
  ${INTERNAL_SECRET_KEY}: ${JSON.stringify(secret)}
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
