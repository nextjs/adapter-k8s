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
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${deploymentName}-hpa
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
