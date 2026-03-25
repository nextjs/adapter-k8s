// src/emit/templates/deployment.ts
export function renderDeployment({
  poolName,
  buildId,
  releaseName,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
}): string {
  const name = `${releaseName}-${poolName}-${buildId}`;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${buildId}"
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${releaseName}
      app.kubernetes.io/component: ${poolName}
      app.kubernetes.io/version: "${buildId}"
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${releaseName}
        app.kubernetes.io/component: ${poolName}
        app.kubernetes.io/version: "${buildId}"
    spec:
      containers:
        - name: pool-server
          image: "{{ .Values.global.image.registry }}/{{ (index .Values.pools \"${poolName}\").image.repository }}:{{ .Values.global.image.tag }}"
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: POOL_NAME
              value: "${poolName}"
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
              cpu: "{{ (index .Values.pools \"${poolName}\").resources.requests.cpu }}"
              memory: "{{ (index .Values.pools \"${poolName}\").resources.requests.memory }}"
            limits:
              cpu: "{{ (index .Values.pools \"${poolName}\").resources.limits.cpu }}"
              memory: "{{ (index .Values.pools \"${poolName}\").resources.limits.memory }}"
`;
}
