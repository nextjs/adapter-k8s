// src/emit/templates/service.ts
import {
  ADAPTER_RELEASE_LABEL,
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafePoolName,
  assertSafeReleaseName,
  renderKeepAtBirthAnnotations,
  stablePoolResourceNames,
} from "./utils.js";

/**
 * GitOps PR2 (§4.2): the stable Services' version selector. Under `cutover.mode: job`
 * the selector renders at the PREVIOUS build (`.Values.previousBuildId` — sync is not
 * cutover; the Job repoints it after the gates pass); under `mode: none` it stays
 * `.Values.activeBuildId` (imperative deploy's values trick, unchanged). A Helm
 * ternary keeps the template a single line in both modes.
 */
const ACTIVE_SELECTOR_VERSION = `{{ if eq .Values.cutover.mode "job" }}{{ .Values.previousBuildId }}{{ else }}{{ .Values.activeBuildId }}{{ end }}`;
/** Same gate for the origin Service's component (the previous build's default pool). */
const ACTIVE_SELECTOR_DEFAULT_POOL = `{{ if eq .Values.cutover.mode "job" }}{{ .Values.previousDefaultPool }}{{ else }}{{ .Values.activeDefaultPool }}{{ end }}`;
/**
 * §4.2 item 1: stable active Services under mode: job carry `adapter-k8s.io/cutover:
 * pending` — the machine-readable "this selector awaits the Job's promotion" marker.
 * The cutover Job CLEARS it once the promotion is durable (E2 committed), so a live
 * object is unambiguous (absent = promoted); the next bundle's sync re-stamps pending,
 * which is again true for that bundle's build. Clearing, not a "complete" value: SSA
 * ownership is (manager, operation), so any Update-owner value the Job set conflicted
 * with helm's Apply re-stamp on the NEXT sync (measured live; see job-main.ts).
 * Exported so the Job's clear and the template render can never disagree on the key.
 */
export const CUTOVER_ANNOTATION_KEY = "adapter-k8s.io/cutover";
const CUTOVER_PENDING_ANNOTATION = `{{- if eq .Values.cutover.mode "job" }}
    ${CUTOVER_ANNOTATION_KEY}: pending
{{- end }}`;

// Versioned Service — points to a specific build's pods
export function renderService({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  // Sanitize at the point of consumption (AGENTS.md) — none of the three was checked here.
  assertSafeReleaseName(releaseName);
  assertSafePoolName(poolName);
  assertSafeBuildId(buildId);

  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  const safeBuildId = sanitizeK8sName(buildId);
  // N75. NO HealthCheckPolicy here. A HealthCheckPolicy attaches to the BACKEND SERVICE
  // that the Gateway derives from a Service, and nothing in the chart routes to the
  // VERSIONED Service — every HTTPRoute backendRef points at the stable active Service
  // (gateway.ts). So the versioned policy could never attach, while still reporting an
  // `Attached` condition, and every build left two more permanently-orphaned policies in
  // the namespace. The health check that actually governs pool traffic is the one on the
  // active Service below. (deploy/rollback still derive the versioned `-hcp` name via
  // poolResourceNames for cleanup of policies created by older builds — that stays.)
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  # GitOps PR2 keep-at-birth (§4.2): a PER-BUILD resource must protect itself from the
  # sync that applies the NEXT bundle — see renderKeepAtBirthAnnotations.
${renderKeepAtBirthAnnotations("  ")}  labels:
    app.kubernetes.io/name: "${releaseName}"
    # N61: QUOTED — an unquoted pool name like "on"/"no"/"true"/"123" renders a YAML
    # boolean/int that the apiserver refuses to unmarshal into map[string]string.
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "${safeBuildId}"
spec:
  selector:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "${safeBuildId}"
  ports:
    - port: 3000
      targetPort: 3000
`;
}

/** Stable portable entrypoint. Every generic exposure targets this Service. */
export function renderOriginService({
  releaseName,
  poolName,
  emitHealthCheckPolicy = false,
}: {
  releaseName: string;
  poolName: string;
  emitHealthCheckPolicy?: boolean;
}): string {
  assertSafeReleaseName(releaseName);
  assertSafePoolName(poolName);
  const healthCheckName = stablePoolResourceNames(releaseName, "origin").hcp;
  return `apiVersion: v1
kind: Service
metadata:
  name: ${sanitizeK8sName(`${releaseName}-origin`)}
  # GitOps PR2 (§4.2): under cutover.mode: job the selector below renders at the
  # PREVIOUS build/default pool (sync is not cutover — the Job repoints it), and the
  # pending annotation marks the Service as awaiting promotion.
{{- if eq .Values.cutover.mode "job" }}
  annotations:
    ${CUTOVER_ANNOTATION_KEY}: pending
{{- end }}
  labels:
    ${ADAPTER_RELEASE_LABEL}: "${releaseName}"
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: origin
spec:
  selector:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${ACTIVE_SELECTOR_DEFAULT_POOL}"
    app.kubernetes.io/version: "${ACTIVE_SELECTOR_VERSION}"
  ports:
    - port: 3000
      targetPort: 3000
${
  emitHealthCheckPolicy
    ? `---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata:
  name: ${healthCheckName}
  labels:
    ${ADAPTER_RELEASE_LABEL}: "${releaseName}"
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: origin
spec:
  default:
    checkIntervalSec: 15
    timeoutSec: 5
    healthyThreshold: 1
    unhealthyThreshold: 2
    config:
      type: HTTP
      httpHealthCheck:
        port: 3000
        requestPath: {{ .Values.poolHealthCheckPath }}
  targetRef:
    group: ""
    kind: Service
    name: ${sanitizeK8sName(`${releaseName}-origin`)}`
    : ""
}
`;
}

// Stable "active" Service — the HTTPRoute always points here.
// Its selector is patched by deploy/rollback to point to the active build.
export function renderActiveService({
  poolName,
  releaseName,
  emitHealthCheckPolicy = true,
}: {
  poolName: string;
  releaseName: string;
  /**
   * `networking.gke.io/v1 HealthCheckPolicy` is a GKE CRD. It does NOT exist on k3s, EKS or
   * AKS, and a chart containing an unknown API group is rejected WHOLE — one stray document
   * fails the entire install rather than degrading. Providers that are not GKE pass false.
   */
  emitHealthCheckPolicy?: boolean;
}): string {
  assertSafeReleaseName(releaseName);
  assertSafePoolName(poolName);

  const {
    service: stableName,
    hcp: stableHcpName,
    pdb: stablePdbName,
  } = stablePoolResourceNames(releaseName, poolName);
  // N65. The per-pool PodDisruptionBudget lives here, with the other STABLE per-pool
  // objects: this template is rendered exactly once per pool (helm.ts), whereas the
  // versioned Deployment/Service templates are rendered a second time by deploy.ts for
  // the retained previous build — a PDB in one of those would either duplicate a name or
  // need per-build cleanup. Selecting on name+component (no `version`) is also what makes
  // it correct THROUGH a cutover, when both builds' pods exist.
  return `apiVersion: v1
kind: Service
metadata:
  name: ${stableName}
  # Explicit empty policy lets Helm clear a previous rollback-retention keep annotation when a
  # removed pool re-enters the current topology. Omission is not enough under three-way/SSA merge.
  # GitOps PR2 (§4.2): under cutover.mode: job the version selector renders at the
  # PREVIOUS build (sync is not cutover — the Job repoints it after the gates pass) and
  # the pending annotation marks this Service as awaiting the Job's promotion.
  annotations:
    helm.sh/resource-policy: ""${CUTOVER_PENDING_ANNOTATION}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/managed-by: adapter-k8s-active
spec:
  selector:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "${ACTIVE_SELECTOR_VERSION}"
  ports:
    - port: 3000
      targetPort: 3000
${
  emitHealthCheckPolicy
    ? `---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata:
  name: ${stableHcpName}
  annotations:
    helm.sh/resource-policy: ""
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
spec:
  default:
    checkIntervalSec: 15
    timeoutSec: 5
    healthyThreshold: 1
    unhealthyThreshold: 2
    config:
      type: HTTP
      httpHealthCheck:
        port: 3000
        # N32. Readiness, not liveness. /healthz is a hardcoded 200 written before any
        # routing, handler load, or manifest check, so a build whose instrumentation
        # register() threw — or whose Next output cannot be import()ed — passes it while
        # every app route 500s, and this policy is the LOAD BALANCER's own verdict (the
        # last /healthz gate in the cutover path). /readyz answers 503 until the pod can
        # actually serve. Keep in step with pool-server/server.ts READINESS_PATH.
        #
        # Values-driven, not a literal: this policy is helm-owned, so a helm upgrade changes it
        # BEFORE the cutover, while the ACTIVE pods are still the previous build's. A build from
        # an adapter that predates /readyz answers only /healthz, so a hardcoded /readyz could
        # mark every serving endpoint unhealthy mid-rollout — an outage caused by the upgrade
        # itself. deploy sets this to the liveness path for exactly one cycle in that case.
        requestPath: {{ .Values.poolHealthCheckPath }}
  targetRef:
    group: ""
    kind: Service
    name: ${stableName}`
    : ""
}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${stablePdbName}
  annotations:
    helm.sh/resource-policy: ""
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
spec:
  # N65. Without a PDB the eviction API will drain every replica of a pool at once, and
  # GKE node auto-upgrade plus Autopilot bin-packing are routine voluntary-eviction
  # sources. The chart already went to trouble over the ROLLOUT path (maxUnavailable: 0,
  # minReadySeconds, preStop) while leaving the involuntary path unguarded.
  # minAvailable: 1 (not a percentage): with a single-replica pool a percentage rounds up
  # to 1 and blocks node drains forever, which turns an upgrade into a stuck cluster;
  # minAvailable: 1 on a 1-replica pool is the documented "unhealthyPodEvictionPolicy"
  # trade-off we accept — it delays a drain rather than dropping the pool to zero.
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: "${poolName}"
`;
}
