// src/emit/templates/hpa.ts
import {
  ADAPTER_RELEASE_LABEL,
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafePoolName,
  assertSafeReleaseName,
} from "./utils.js";

export function renderHPA({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  // Sanitize at the point of consumption (AGENTS.md). The three `.Values` lookups below
  // are `minReplicas: {{ … }}` style BARE scalars, so the numbers behind them must be
  // integers — that check lives at their source (values-yaml.ts, N60), since helm resolves
  // them long after this template is written.
  assertSafeReleaseName(releaseName);
  assertSafePoolName(poolName);
  assertSafeBuildId(buildId);

  const deploymentName = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  // The HPA's own name appends "-hpa" — reserve room for it inside the 63-char
  // limit (a 63-char deployment name would otherwise yield a 67-char HPA name
  // the API server rejects). scaleTargetRef still uses the exact Deployment name.
  const hpaName = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`, "-hpa");
  const safeBuildId = sanitizeK8sName(buildId);
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${hpaName}
  labels:
    ${ADAPTER_RELEASE_LABEL}: "${releaseName}"
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "${safeBuildId}"
    app.kubernetes.io/managed-by: Helm
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${deploymentName}
  minReplicas: {{ (index .Values.pools "${poolName}").replicas.min }}
  maxReplicas: {{ (index .Values.pools "${poolName}").replicas.max }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ (index .Values.pools "${poolName}").replicas.targetCPU }}
`;
}
