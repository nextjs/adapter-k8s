export function renderRoutingServiceHPA({ releaseName, minReplicas = 2, maxReplicas = 10, targetCPU = 70 }: { releaseName: string; minReplicas?: number; maxReplicas?: number; targetCPU?: number }): string {
  return `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${releaseName}-routing-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${releaseName}-routing-service
  minReplicas: ${minReplicas}
  maxReplicas: ${maxReplicas}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: ${targetCPU}
`;
}
