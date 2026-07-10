export function renderRoutingServiceService({ releaseName }: { releaseName: string }): string {
  // Standalone NEG (not the default "ingress" NEG): the ext_proc traffic-extension
  // backend service attaches this NEG so the callout can reach the routing-service pods.
  return `apiVersion: v1
kind: Service
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: routing-service
  annotations:
    cloud.google.com/neg: '{"exposed_ports":{"8443":{"name":"${releaseName}-routing-neg"}}}'
spec:
  selector:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: routing-service
  ports:
    - port: 8443
      targetPort: 8443
      name: grpc
      appProtocol: grpc
`;
}
