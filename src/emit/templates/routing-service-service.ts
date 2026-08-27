import { assertSafeAnnotationName, assertSafeReleaseName, escapeHelmActions } from "./utils.js";

export function renderRoutingServiceService({
  releaseName,
  annotations = {},
}: {
  releaseName: string;
  /**
   * Provider-specific Service annotations. GKE needs `cloud.google.com/neg` so the GXLB can
   * target pod IPs directly through a standalone NEG. An in-cluster gateway routes to the
   * Service normally, and a Google annotation on a cluster with no such controller is inert
   * noise at best.
   */
  annotations?: Record<string, string>;
}): string {
  // Sanitize at the point of consumption (AGENTS.md): releaseName lands in resource names and
  // labels; provider annotations land in a Helm template and then Kubernetes ObjectMeta.
  assertSafeReleaseName(releaseName);
  const annotationLines = Object.entries(annotations).map(([name, value]) => {
    assertSafeAnnotationName(name);
    if (typeof value !== "string") {
      throw new Error(
        `Invalid annotation value for ${JSON.stringify(name)}: expected a string, got ` +
          typeof value,
      );
    }
    return `    ${JSON.stringify(name)}: ${escapeHelmActions(JSON.stringify(value))}`;
  });
  // Standalone NEG (not the default "ingress" NEG): the ext_proc traffic-extension
  // backend service attaches this NEG so the callout can reach the routing-service pods.
  return `apiVersion: v1
kind: Service
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
${
  annotationLines.length > 0 ? `  annotations:\n` + annotationLines.join("\n") : "  annotations: {}"
}
spec:
  selector:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
  ports:
    - port: 8443
      targetPort: 8443
      name: grpc
      appProtocol: grpc
`;
}
