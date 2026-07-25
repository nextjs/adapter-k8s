// src/emit/templates/hpa.ts
import { sanitizeK8sName } from "./utils.js";

export function renderHPA({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  const deploymentName = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  // The HPA's own name appends "-hpa" — reserve room for it inside the 63-char
  // limit (a 63-char deployment name would otherwise yield a 67-char HPA name
  // the API server rejects). scaleTargetRef still uses the exact Deployment name.
  const hpaName = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`, "-hpa");
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${hpaName}
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
