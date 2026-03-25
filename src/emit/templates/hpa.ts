// src/emit/templates/hpa.ts
export function renderHPA({
  poolName,
  buildId,
  releaseName,
  scaling,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
  scaling: { min: number; max: number; targetCPU: number };
}): string {
  const deploymentName = `${releaseName}-${poolName}-${buildId}`;
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${deploymentName}-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${deploymentName}
  minReplicas: ${scaling.min}
  maxReplicas: ${scaling.max}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: ${scaling.targetCPU}
`;
}
