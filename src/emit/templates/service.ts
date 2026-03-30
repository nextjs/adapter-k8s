// src/emit/templates/service.ts
import { sanitizeK8sName } from "./utils.js";

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
  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  const safeBuildId = sanitizeK8sName(buildId);
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${safeBuildId}"
spec:
  selector:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${safeBuildId}"
  ports:
    - port: 3000
      targetPort: 3000
---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata:
  name: ${name}-hcp
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
        requestPath: /healthz
  targetRef:
    group: ""
    kind: Service
    name: ${name}
`;
}

// Stable "active" Service — the HTTPRoute always points here.
// Its selector is patched by deploy/rollback to point to the active build.
export function renderActiveService({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  const stableName = sanitizeK8sName(`${releaseName}-${poolName}`);
  const safeBuildId = sanitizeK8sName(buildId);
  return `apiVersion: v1
kind: Service
metadata:
  name: ${stableName}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/managed-by: adapter-k8s-active
spec:
  selector:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${safeBuildId}"
  ports:
    - port: 3000
      targetPort: 3000
---
apiVersion: networking.gke.io/v1
kind: HealthCheckPolicy
metadata:
  name: ${stableName}-hcp
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
        requestPath: /healthz
  targetRef:
    group: ""
    kind: Service
    name: ${stableName}
`;
}
