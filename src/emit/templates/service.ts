// src/emit/templates/service.ts
import {
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafePoolName,
  assertSafeReleaseName,
} from "./utils.js";

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
  labels:
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

  const stableName = sanitizeK8sName(`${releaseName}-${poolName}`);
  // Same "-hcp" suffix reservation as the versioned Service above.
  const stableHcpName = sanitizeK8sName(`${releaseName}-${poolName}`, "-hcp");
  // N65. The per-pool PodDisruptionBudget lives here, with the other STABLE per-pool
  // objects: this template is rendered exactly once per pool (helm.ts), whereas the
  // versioned Deployment/Service/HPA templates are rendered a second time by deploy.ts for
  // the retained previous build — a PDB in one of those would either duplicate a name or
  // need per-build cleanup. Selecting on name+component (no `version`) is also what makes
  // it correct THROUGH a cutover, when both builds' pods exist.
  const stablePdbName = sanitizeK8sName(`${releaseName}-${poolName}`, "-pdb");
  return `apiVersion: v1
kind: Service
metadata:
  name: ${stableName}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/managed-by: adapter-k8s-active
spec:
  selector:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "{{ .Values.activeBuildId }}"
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
