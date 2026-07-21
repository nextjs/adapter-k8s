import { assertSafeReleaseName } from "./utils.js";

// A per-release Secret holding the Valkey connection URL + AUTH string that the pool servers
// use for the shared `use cache` / PPR cache. It is created imperatively at deploy time — from
// the managed Memorystore instance's discovery endpoint after provisioning, or from a
// bring-your-own `cache.url`/`cache.password`. The pool reads VALKEY_URL / VALKEY_AUTH and, when
// present, registers the Valkey cache handler.
export const VALKEY_SECRET_NAME = "valkey";
export const VALKEY_URL_KEY = "url";
export const VALKEY_AUTH_KEY = "auth";
// PEM of the cache server's CA — present when the managed instance uses in-transit
// encryption (AUTH mode). The pool pins TLS verification to this CA.
export const VALKEY_CA_KEY = "ca";

/**
 * Env-var snippet (YAML list items) injecting VALKEY_URL / VALKEY_AUTH into a pool container.
 * `optional: true` is deliberate: the pool registration is gated on VALKEY_URL being present, so
 * a missing secret (cache disabled, or provisioned slightly after the first rollout) just leaves
 * the vars unset and the pool falls back to Next's in-process handler — never a startup failure.
 */
export function renderValkeyEnv(releaseName: string, indent: string): string {
  const secret = `${releaseName}-${VALKEY_SECRET_NAME}`;
  return `${indent}- name: VALKEY_URL
${indent}  valueFrom:
${indent}    secretKeyRef:
${indent}      name: ${secret}
${indent}      key: ${VALKEY_URL_KEY}
${indent}      optional: true
${indent}- name: VALKEY_AUTH
${indent}  valueFrom:
${indent}    secretKeyRef:
${indent}      name: ${secret}
${indent}      key: ${VALKEY_AUTH_KEY}
${indent}      optional: true
${indent}- name: VALKEY_CA_CERT
${indent}  valueFrom:
${indent}    secretKeyRef:
${indent}      name: ${secret}
${indent}      key: ${VALKEY_CA_KEY}
${indent}      optional: true`;
}

/** The Valkey connection Secret, created at deploy time (managed endpoint or BYO). */
export function renderValkeySecret({
  releaseName,
  url,
  password,
  ca,
}: {
  releaseName: string;
  url: string;
  password?: string;
  ca?: string;
}): string {
  assertSafeReleaseName(releaseName);
  const entries: [string, string][] = [[VALKEY_URL_KEY, url]];
  if (password) entries.push([VALKEY_AUTH_KEY, password]);
  if (ca) entries.push([VALKEY_CA_KEY, ca]);
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${releaseName}-${VALKEY_SECRET_NAME}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: valkey-secret
type: Opaque
stringData:
${entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n")}
`;
}
