import { assertSafeReleaseName, assertSafeReplicaCount, assertSafeTargetCPU } from "./utils.js";

export function renderRoutingServiceHPA({
  releaseName,
  minReplicas = 2,
  maxReplicas = 10,
  targetCPU = 70,
}: {
  releaseName: string;
  minReplicas?: number;
  maxReplicas?: number;
  targetCPU?: number;
}): string {
  // Sanitize at the point of consumption (AGENTS.md). N60: all three numbers below are
  // interpolated as BARE YAML scalars straight from `next.config`
  // (`routingService.scaling`), so a string carrying a newline injects a sibling key into
  // the HPA spec — the same class as the resource-quantity sinks.
  assertSafeReleaseName(releaseName);
  assertSafeReplicaCount(minReplicas, "routingService.scaling.min");
  assertSafeReplicaCount(maxReplicas, "routingService.scaling.max");
  assertSafeTargetCPU(targetCPU, "routingService.scaling.targetCPU");
  if (minReplicas > maxReplicas) {
    throw new Error(
      `routingService.scaling.min (${minReplicas}) is greater than ` +
        `routingService.scaling.max (${maxReplicas}): the API server rejects such an HPA.`,
    );
  }
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
