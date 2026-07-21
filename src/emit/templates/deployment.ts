// src/emit/templates/deployment.ts
import { sanitizeK8sName } from "./utils.js";
import { renderInternalSecretEnv } from "./internal-secret.js";
import { renderValkeyEnv } from "./valkey-secret.js";

export function renderDeployment({
  poolName,
  buildId,
  releaseName,
  imageTag = "{{ .Values.global.image.tag }}",
  replicas,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
  imageTag?: string;
  replicas?: number | undefined;
}): string {
  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  const safeBuildId = sanitizeK8sName(buildId);
  const internalSecretEnv = renderInternalSecretEnv(releaseName, "            ");
  // Always emit the Valkey env — the secret refs are `optional: true`, so this is inert when no
  // cache is configured (the pool only registers the handler when VALKEY_URL is actually set).
  // Emitting it unconditionally keeps the pod template identical whether or not the cache is on,
  // so toggling `cache.enabled` between deploys never rolls the retained previous deployment.
  const valkeyEnv = "\n" + renderValkeyEnv(releaseName, "            ");
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: ${poolName}
    app.kubernetes.io/version: "${safeBuildId}"
spec:
${replicas !== undefined ? `  replicas: ${replicas}\n` : ""}  selector:
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
      # The pool server never calls the Kubernetes API — don't mount a SA token.
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: pool-server
          image: "{{ .Values.global.image.registry }}/{{ (index .Values.pools "${poolName}").image.repository }}:${imageTag}"
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: POOL_NAME
              value: "${poolName}"
            # The pool server derives cross-pool proxy target names from
            # RELEASE_NAME; without it proxyToPool defaults to "nextjs" and
            # can't reach sibling pools in any release not named that.
            - name: RELEASE_NAME
              value: "${releaseName}"
${internalSecretEnv}${valkeyEnv}
          volumeMounts:
            # readOnlyRootFilesystem makes / read-only; Next still needs a writable
            # scratch dir, so /tmp is an in-memory emptyDir.
            - name: tmp
              mountPath: /tmp
            # Without the shared Valkey incremental handler wired (cache disabled, or an
            # edge-middleware app), Next falls back to its FILESYSTEM incremental cache at
            # .next/cache — which must exist writable or renders fail with EROFS. Per-pod
            # and ephemeral: correct (if unshared) degradation, never durable state.
            - name: next-cache
              mountPath: /app/.next/cache
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
      volumes:
        - name: tmp
          emptyDir: {}
        - name: next-cache
          emptyDir: {}
`;
}
