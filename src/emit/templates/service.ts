// src/emit/templates/service.ts
import { sanitizeK8sName } from "./utils.js";

export function renderService({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
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
