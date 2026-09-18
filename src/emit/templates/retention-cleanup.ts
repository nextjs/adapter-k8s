import { createHash } from "node:crypto";
import {
  assertSafeBuildId,
  assertSafePoolName,
  assertSafeReleaseName,
  renderImagePullSecrets,
} from "./utils.js";
import { DIGEST_RE } from "../../pipeline/digests.js";
import type { TargetArchitecture } from "../../target-platform.js";

export function renderRetentionCleanup(options: {
  releaseName: string;
  buildId: string;
  poolName: string;
  imageDigest?: string;
  nodeArchitecture: TargetArchitecture;
  pullSecrets?: string[];
}): string {
  const {
    releaseName,
    buildId,
    poolName,
    imageDigest,
    nodeArchitecture,
    pullSecrets = [],
  } = options;
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  assertSafePoolName(poolName);
  if (imageDigest !== undefined && !DIGEST_RE.test(imageDigest))
    throw new Error("Invalid cleanup image digest");
  if (nodeArchitecture !== "amd64" && nodeArchitecture !== "arm64")
    throw new Error("Invalid cleanup architecture");
  const name = `${releaseName.slice(0, 24)}-retire-${createHash("sha256").update(releaseName).digest("hex").slice(0, 8)}`;
  const pool = `(index .Values.pools "${poolName}")`;
  const image =
    `{{ .Values.global.image.registry }}/{{ ${pool}.image.repository }}` +
    (imageDigest
      ? `@${imageDigest}`
      : `{{ with ${pool}.image.digest }}@{{ . }}{{ else }}:${buildId}{{ end }}`);
  const metadata = `  name: ${name}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: retention-cleanup`;
  return `apiVersion: v1
kind: ServiceAccount
metadata:
${metadata}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
${metadata}
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    resourceNames: ["${releaseName}-adapter-state"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["list"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["list"]
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    verbs: ["get", "patch"]
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
${metadata}
subjects:
  - kind: ServiceAccount
    name: ${name}
    namespace: {{ .Release.Namespace }}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${name}
---
apiVersion: batch/v1
kind: CronJob
metadata:
${metadata}
spec:
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 60
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      backoffLimit: 1
      activeDeadlineSeconds: 90
      ttlSecondsAfterFinished: 300
      template:
        metadata:
          labels:
            app.kubernetes.io/name: ${releaseName}
            app.kubernetes.io/component: retention-cleanup
        spec:
          serviceAccountName: ${name}
          restartPolicy: Never
          nodeSelector:
            kubernetes.io/arch: "${nodeArchitecture}"
${renderImagePullSecrets(pullSecrets, "          ")}          securityContext:
            runAsNonRoot: true
            runAsUser: 1000
            runAsGroup: 1000
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: retention-cleanup
              image: "${image}"
              imagePullPolicy: ${imageDigest ? "IfNotPresent" : `{{ if ${pool}.image.digest }}IfNotPresent{{ else }}Always{{ end }}`}
              command: ["node", "/app/retention-cleanup.cjs"]
              env:
                - name: RELEASE_NAME
                  value: "${releaseName}"
                - name: NAMESPACE
                  valueFrom:
                    fieldRef:
                      fieldPath: metadata.namespace
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                  ephemeral-storage: 128Mi
                limits:
                  cpu: 100m
                  memory: 128Mi
                  ephemeral-storage: 128Mi
              securityContext:
                allowPrivilegeEscalation: false
                readOnlyRootFilesystem: true
                capabilities:
                  drop: ["ALL"]
`;
}
