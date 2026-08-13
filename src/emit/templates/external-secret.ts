// src/emit/templates/external-secret.ts
//
// GitOps PR1 (`adapter-k8s emit --secrets external`, the default): the bundle chart omits
// the two credential-bearing templates (internal-secret.yaml, valkey-secret.yaml — §3 item
// 3 of plans/gitops-deployment-strategies.md: committing `chart/` to a repo commits
// secrets, and the 0600 file mode does not survive Git). The pods still reference those
// Secret NAMES via secretKeyRef, so the operator must make same-named Secrets exist by
// other means. This template is the ExternalSecret-shaped placeholder for that: it renders
// external-secrets.io ExternalSecrets targeting the exact names/keys the pods mount, gated
// behind `externalSecrets.storeName` so a bundle whose operator uses a different mechanism
// (SealedSecrets, SOPS, kubectl) renders nothing and loses nothing.
//
// Only the NAMES and KEYS here are load-bearing — they come from the same single sources
// of truth the pod templates use (internalSecretName/INTERNAL_SECRET_KEY,
// VALKEY_SECRET_NAME/VALKEY_*_KEY), so the bundle cannot drift from what the pods
// reference. The remoteRef keys are a documented convention the operator may re-map.
import { internalSecretName, INTERNAL_SECRET_KEY } from "./internal-secret.js";
import {
  VALKEY_SECRET_NAME,
  VALKEY_URL_KEY,
  VALKEY_AUTH_KEY,
  VALKEY_CA_KEY,
} from "./valkey-secret.js";
import { assertSafeBuildId, assertSafeReleaseName } from "./utils.js";

/**
 * The store-relative key convention the placeholder reads each secret from. Kept as a
 * plain `<release>/<secretName>` path so it works verbatim on path-shaped stores (Vault
 * KV, GCP Secret Manager with `/` replaced per that store's rules) and is trivially
 * re-mappable on the rest.
 */
export function externalSecretRemoteKey(releaseName: string, secretName: string): string {
  return `${releaseName}/${secretName}`;
}

export function renderExternalSecrets({
  releaseName,
  buildId,
  includeValkey,
}: {
  releaseName: string;
  buildId: string;
  /** True when the build's chart carried a Valkey connection Secret (cache enabled, BYO/managed). */
  includeValkey: boolean;
}): string {
  assertSafeReleaseName(releaseName);
  // Sanitized at the point of consumption (AGENTS.md): the build id lands in resource names.
  assertSafeBuildId(buildId);
  const dispatchName = internalSecretName(releaseName, buildId);
  const valkeyName = `${releaseName}-${VALKEY_SECRET_NAME}`;
  // The `and` guard is deliberate: `.Values.externalSecrets.storeName` alone nil-pointers
  // under `helm template` when the externalSecrets block is absent entirely (a hand-rolled
  // values file), and a render error in the SECRETS placeholder would block rendering the
  // rest of the bundle.
  const header = `{{- if and .Values.externalSecrets .Values.externalSecrets.storeName }}`;
  const storeRef = `  secretStoreRef:
    name: {{ .Values.externalSecrets.storeName }}
    kind: {{ .Values.externalSecrets.storeKind | default "ClusterSecretStore" }}`;

  const dispatch = `apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${dispatchName}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: external-secret
  annotations:
    # N87: the per-build dispatch Secret must OUTLIVE the sync that applies the NEXT
    # build's bundle — the retained previous build's pods reference it by name and cannot
    # start without it (rollback target). Same keep-at-birth posture as the inline Secret.
    helm.sh/resource-policy: keep
spec:
  refreshInterval: 1h
${storeRef}
  target:
    name: ${dispatchName}
    creationPolicy: Owner
  data:
    # The pool servers and the routing tier read this key via secretKeyRef; the VALUE must
    # be the deterministic per-build dispatch secret (deriveInternalSecret: HMAC-SHA256 of
    # "<release>\\0<buildId>" under the operator key). Load it into the store from the
    # build pipeline; see the bundle README for the exact name/key table.
    - secretKey: ${INTERNAL_SECRET_KEY}
      remoteRef:
        key: ${externalSecretRemoteKey(releaseName, dispatchName)}`;

  const valkey = `apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: ${valkeyName}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: external-secret
spec:
  refreshInterval: 1h
${storeRef}
  target:
    name: ${valkeyName}
    creationPolicy: Owner
  data:
    - secretKey: ${VALKEY_URL_KEY}
      remoteRef:
        key: ${externalSecretRemoteKey(releaseName, valkeyName)}-${VALKEY_URL_KEY}
    # ${VALKEY_AUTH_KEY} and ${VALKEY_CA_KEY} are optional on the pod side (secretKeyRef
    # optional: true) — add data entries for them when the cache uses AUTH/TLS.`;

  return [
    header,
    dispatch,
    ...(includeValkey ? ["---", valkey] : []),
    "{{- end }}",
    "", // trailing newline
  ].join("\n");
}
