import { createHash } from "node:crypto";
import {
  assertSafeBuildId,
  assertSafeReleaseName,
  assertSafeSecretName,
  escapeHelmActions,
  sanitizeK8sName,
} from "./utils.js";

// A per-BUILD Secret holding the shared value that authenticates the routing extension's
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
// only audit for invariant 5), and a rotated secret is not free. When the Secret was
// STABLE-NAMED it updated while the CURRENTLY-SERVING pods still held the old value, so for
// the whole rollout window they stopped trusting dispatch headers and re-resolved locally —
// middleware then executed TWICE per request, double-counting rate limits and analytics.
// Failing safe is not the same as being neutral.
//
// N87 (SECURITY, phase-7 skew design). The paragraph above reasoned about WARM pods only,
// and that made it incomplete. The Secret used to be stable-named
// (`<release>-internal-header-secret`) and is overwritten by `helm upgrade`, which runs
// BEFORE pool cutover (deploy.ts step 6). It reaches pods via `secretKeyRef`, so the value
// resolves at CONTAINER START:
//
//   * a WARM build-A pod holds A's secret, rejects build B's dispatch headers and
//     re-resolves locally — fail-safe, and the double-middleware cost above;
//   * a build-A pod that RESTARTS inside the deploy window (eviction, OOM, node event, HPA
//     scale-up) reads the NEW Secret and therefore TRUSTS build B's dispatch headers. It can
//     then skip A's middleware on B's `x-mw-evaluated` verdict and serve A's routes under B's
//     middleware decisions. If B changed or removed an auth check, that is A's routes without
//     A's gate — an invariant-2 (middleware is never bypassed) hole, reachable without any
//     attacker, from a single pod restart.
//
// Fix: the Secret NAME carries the build id, so a pod can only ever resolve the secret of
// the build whose pod template named it. Chosen over the design's other candidate — a
// build-scoped VERDICT the receiver re-checks against its own build id — for three reasons:
//
//  1. The trust boundary is all-or-nothing. `applyRequestTrustBoundary` (pool-server/
//     server.ts) uses the secret to decide whether to KEEP or STRIP the whole
//     INTERNAL_DISPATCH_HEADERS set, not just `x-mw-evaluated`. A build-scoped verdict would
//     re-check one header while a restarted A pod still trusted B's `x-output-id`,
//     `x-matched-path` and friends — i.e. B's routing service could still dispatch it
//     straight to a handler. Scoping the SECRET fixes the whole set at once.
//  2. It needs no dataplane protocol change: no new header to stamp in the routing service,
//     nothing new to parse and compare per request in the pool, and no new way for the two
//     tiers to disagree. It is a naming change in the emit layer plus lifecycle handling in
//     deploy/rollback.
//  3. Nothing has to be CHECKED at request time to be correct. The binding
//     pod → secret name → value is immutable once rendered: each name is written only by the
//     chart render of its own build, and `deriveInternalSecret` is deterministic, so no
//     later render can change what an existing name resolves to.
//
// Lifecycle consequences, all handled by the callers:
//   * `helm.sh/resource-policy: keep` below — a build's Secret must OUTLIVE the upgrade that
//     replaces it, or the retained previous build (kept at 0 replicas as the rollback target,
//     invariant 3) could not start a pod at all: `secretKeyRef` to a deleted Secret is
//     CreateContainerConfigError, which would brick both a restart during the window and the
//     rollback itself. Keeping them means deploy must GC them — see the internal-secret sweep
//     in deploy.ts step 7g (unreferenced-by-any-Deployment, the same conservatism as the
//     routing-manifest snapshot prune).
//   * deploy migrates the LEGACY stable-named Secret (see `legacyInternalSecretName`) by
//     annotating it `keep` before `helm upgrade`, so the first deploy under this scheme does
//     not prune the outgoing build's only secret.
//   * rollback moves the routing tier's secretKeyRef WITH the image, for the same reason it
//     moves NEXT_BUILD_ID.
//
// The chart FILENAME is deliberately unchanged (`templates/internal-secret.yaml`), so
// SECRET_CHART_FILES / assertSecretChartFilesComplete (emit/helm.ts) keep working as-is and
// the file still lands on disk mode 0600.

/**
 * The LEGACY, stable Secret name (one per release, overwritten by every `helm upgrade`).
 * Retained because deploy has to recognize and preserve it for one deploy cycle: pods of a
 * build deployed by an older adapter reference this name, and helm would prune it as
 * "removed from the chart" the first time the per-build Secret is rendered.
 */
export const INTERNAL_SECRET_NAME = "internal-header-secret";
export const INTERNAL_SECRET_KEY = "secret";

/** Label marking every internal-dispatch Secret, legacy or per-build (deploy sweeps on it). */
export const INTERNAL_SECRET_COMPONENT = "internal-secret";

/** Annotation carrying the FULL (unsanitized) build id a per-build Secret belongs to. */
export const INTERNAL_SECRET_BUILD_ID_ANNOTATION = "adapter-k8s/build-id";

/** The stable name written by adapter versions before per-build secret names existed. */
export function legacyInternalSecretName(releaseName: string): string {
  return `${releaseName}-${INTERNAL_SECRET_NAME}`;
}

/**
 * The per-build internal-secret name.
 *
 * Naming follows `routingManifestSnapshotName` (utils.ts), the other per-build resource:
 * a short readable infix plus an 8-hex-char SHA-256 digest of the FULL build id, appended
 * as a `sanitizeK8sName` SUFFIX so it is reserved INSIDE the 63-char cap. Truncation can
 * eat the readable build-id portion but never the digest, so two distinct build ids can
 * never collide on one name — which is the whole point here: a collision would put two
 * builds' pods back on one mutable value, exactly the case this scheme exists to remove.
 */
export function internalSecretName(releaseName: string, buildId: string): string {
  const digest = createHash("sha256").update(buildId).digest("hex").slice(0, 8);
  return sanitizeK8sName(`${releaseName}-ihs-${buildId}`, `-${digest}`);
}

export function renderInternalSecret({
  releaseName,
  buildId,
  secret,
}: {
  releaseName: string;
  buildId: string;
  secret: string;
}): string {
  assertSafeReleaseName(releaseName);
  // Sanitized at the point of consumption (AGENTS.md): the build id lands in the resource
  // NAME and in a double-quoted annotation value below.
  assertSafeBuildId(buildId);
  // stringData lets Kubernetes base64-encode for us; the value is an opaque token.
  return `apiVersion: v1
kind: Secret
metadata:
  name: ${internalSecretName(releaseName, buildId)}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${INTERNAL_SECRET_COMPONENT}
  annotations:
    # N87: a build's dispatch secret must outlive the upgrade that renders the NEXT build's
    # one — the retained previous build's pods reference it by name and cannot start
    # without it (rollback target). deploy.ts step 7g deletes the ones no Deployment
    # references any more.
    helm.sh/resource-policy: keep
    ${INTERNAL_SECRET_BUILD_ID_ANNOTATION}: ${escapeHelmActions(JSON.stringify(buildId))}
type: Opaque
stringData:
  ${INTERNAL_SECRET_KEY}: ${escapeHelmActions(JSON.stringify(secret))}
`;
}

// The env-var snippet (YAML list item) that injects the secret into a container as
// INTERNAL_HEADER_SECRET. Indented to sit under a container's `env:` list.
//
// N87: the referenced NAME is build-scoped, so this pod template can only ever resolve the
// secret of ITS OWN build — including on a restart inside another build's deploy window.
// `secretName` overrides the derived name with a validated LITERAL one. Deploy never uses this
// to reconstruct an outgoing build: that live Deployment is kept without touching its template.
export function renderInternalSecretEnv(
  releaseName: string,
  buildId: string,
  indent: string,
  secretName?: string,
): string {
  assertSafeBuildId(buildId);
  if (secretName !== undefined) assertSafeSecretName(secretName);
  return `${indent}- name: INTERNAL_HEADER_SECRET
${indent}  valueFrom:
${indent}    secretKeyRef:
${indent}      name: ${secretName ?? internalSecretName(releaseName, buildId)}
${indent}      key: ${INTERNAL_SECRET_KEY}`;
}

// assertSafeSecretName moved to utils.ts when imagePullSecrets grew a second consumer of
// the same charset — one validator, one error message, for every Secret-name sink.
export { assertSafeSecretName } from "./utils.js";
