import { sanitizeK8sName } from "./utils.js";
import { renderInternalSecretEnv } from "./internal-secret.js";

export interface RoutingServiceResources {
  cpu?: string;
  memory?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

export function renderRoutingServiceDeployment({
  releaseName,
  buildId,
  imageRegistry,
  resources,
  failOpen,
  requestTimeoutMs,
}: {
  releaseName: string;
  buildId: string;
  imageRegistry: string;
  resources?: RoutingServiceResources;
  /** GCP callout-failure policy mirrored to the server: false = fail-closed (500). */
  failOpen?: boolean;
  requestTimeoutMs?: number;
}): string {
  const safeBuildId = sanitizeK8sName(buildId);
  // Defaults are sized for a CPU-bound, single-threaded service running arbitrary
  // middleware: a full core of burst headroom and enough memory for the middleware
  // module. Override via config for heavier middleware.
  const cpuReq = resources?.cpu ?? "250m";
  const memReq = resources?.memory ?? "256Mi";
  const cpuLim = resources?.cpuLimit ?? "1000m";
  const memLim = resources?.memoryLimit ?? "512Mi";
  const internalSecretEnv = renderInternalSecretEnv(releaseName, "            ");
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
            - containerPort: 8081
              name: health
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: PORT
              value: "8443"
            - name: HEALTH_PORT
              value: "8081"
            - name: ROUTING_FAIL_OPEN
              value: "${failOpen === false ? "false" : "true"}"
            - name: ROUTING_REQUEST_TIMEOUT_MS
              value: "${requestTimeoutMs ?? 4000}"
            - name: CONFIG_DIR
              value: /config
${internalSecretEnv}
          volumeMounts:
            - name: routing-manifest
              mountPath: /config
          # httpGet, not a socket check: a wedged event loop still accepts a TCP
          # connection but fails to *serve* /healthz, so a broken-but-listening pod
          # gets evicted from the NEG instead of silently failing callouts.
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 3
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          resources:
            requests:
              cpu: ${cpuReq}
              memory: ${memReq}
            limits:
              cpu: ${cpuLim}
              memory: ${memLim}
      volumes:
        - name: routing-manifest
          configMap:
            name: ${releaseName}-routing-manifest
`;
}
