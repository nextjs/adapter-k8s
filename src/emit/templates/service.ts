// src/emit/templates/service.ts
export function renderService({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  return `apiVersion: v1
kind: Service
metadata:
  name: ${releaseName}-${poolName}-${buildId}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
spec:
  selector:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${buildId}"
  ports:
    - port: 3000
      targetPort: 3000
`;
}
