export function renderRoutingServiceService({ releaseName }: { releaseName: string }): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: routing-service
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
