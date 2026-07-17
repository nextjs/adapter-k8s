// src/emit/templates/deployment.ts
import { sanitizeK8sName } from "./utils.js";
import { renderInternalSecretEnv } from "./internal-secret.js";
import { renderValkeyEnv } from "./valkey-secret.js";

// Seconds the preStop hook sleeps before SIGTERM, so the GXLB deprograms this pod's NEG endpoint
// (async, typically a few seconds) before the app starts draining — new connections stop landing
// here first, then we drain what's established.
const PRE_STOP_SECONDS = 10;

export function renderDeployment({
  poolName,
  buildId,
  releaseName,
  imageTag = "{{ .Values.global.image.tag }}",
  replicas,
  drainSeconds = 25,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
  imageTag?: string;
  replicas?: number | undefined;
  /** WebSocket drain window (seconds) on pod termination. See PoolConfig.drainSeconds. */
  drainSeconds?: number | undefined;
}): string {
  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  // Total grace = NEG-deprogram sleep + WS drain + a small buffer for the process to exit.
  const gracePeriodSeconds = PRE_STOP_SECONDS + Math.max(0, drainSeconds) + 5;
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
      # Blue/green cutover, rollback, and HPA scale-down all terminate pods via SIGTERM. Give the
      # pod server time to drain established WebSocket connections (DRAIN_SECONDS) after the preStop
      # NEG-deprogram window, before the kubelet SIGKILLs it.
      terminationGracePeriodSeconds: ${gracePeriodSeconds}
      containers:
        - name: pool-server
          image: "{{ .Values.global.image.registry }}/{{ (index .Values.pools "${poolName}").image.repository }}:${imageTag}"
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
            - name: TRUST_INTERNAL_HEADERS
              value: "1"
            - name: DRAIN_SECONDS
              value: "${Math.max(0, drainSeconds)}"
${internalSecretEnv}${valkeyEnv}
          lifecycle:
            preStop:
              # Sleep before SIGTERM so the load balancer stops routing new connections to this pod
              # (NEG endpoint deprogramming is async) before the app begins draining.
              exec:
                command: ["/bin/sh", "-c", "sleep ${PRE_STOP_SECONDS}"]
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
