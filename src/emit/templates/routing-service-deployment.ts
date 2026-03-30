import { sanitizeK8sName } from "./utils.js";

export function renderRoutingServiceDeployment({
  releaseName,
  buildId,
  imageRegistry,
}: {
  releaseName: string;
  buildId: string;
  imageRegistry: string;
}): string {
  const safeBuildId = sanitizeK8sName(buildId);
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: routing-service
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: ${releaseName}
      app.kubernetes.io/component: routing-service
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${releaseName}
        app.kubernetes.io/component: routing-service
        app.kubernetes.io/version: "${safeBuildId}"
    spec:
      containers:
        - name: routing-service
          image: "${imageRegistry}/routing-service:${buildId}"
          ports:
            - containerPort: 8443
              name: grpc
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: PORT
              value: "8443"
            - name: CONFIG_DIR
              value: /config
          volumeMounts:
            - name: routing-manifest
              mountPath: /config
          readinessProbe:
            tcpSocket:
              port: 8443
            initialDelaySeconds: 5
          livenessProbe:
            tcpSocket:
              port: 8443
            initialDelaySeconds: 10
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 250m
              memory: 256Mi
      volumes:
        - name: routing-manifest
          configMap:
            name: ${releaseName}-routing-manifest
`;
}
