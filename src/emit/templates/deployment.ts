// src/emit/templates/deployment.ts
import { sanitizeK8sName } from "./utils.js";
import { renderInternalSecretEnv } from "./internal-secret.js";

export function renderDeployment({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  const safeBuildId = sanitizeK8sName(buildId);
  const internalSecretEnv = renderInternalSecretEnv(releaseName, "            ");
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${safeBuildId}"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${releaseName}
      app.kubernetes.io/component: ${poolName}
      app.kubernetes.io/version: "${safeBuildId}"
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${releaseName}
        app.kubernetes.io/component: ${poolName}
        app.kubernetes.io/version: "${safeBuildId}"
    spec:
      containers:
        - name: pool-server
          image: "{{ .Values.global.image.registry }}/{{ (index .Values.pools "${poolName}").image.repository }}:{{ .Values.global.image.tag }}"
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: POOL_NAME
              value: "${poolName}"
            - name: TRUST_INTERNAL_HEADERS
              value: "1"
${internalSecretEnv}
          readinessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 10
          resources:
            requests:
              cpu: "{{ (index .Values.pools "${poolName}").resources.requests.cpu }}"
              memory: "{{ (index .Values.pools "${poolName}").resources.requests.memory }}"
            limits:
              cpu: "{{ (index .Values.pools "${poolName}").resources.limits.cpu }}"
              memory: "{{ (index .Values.pools "${poolName}").resources.limits.memory }}"
`;
}
