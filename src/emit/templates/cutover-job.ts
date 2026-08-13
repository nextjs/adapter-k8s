// src/emit/templates/cutover-job.ts
//
// GitOps PR2 (design §4.2 + real-cluster gap #4): the in-cluster cutover Job's chart
// templates, rendered by `adapter-k8s emit --cutover job` INTO THE BUNDLE CHART, each
// gated on `{{- if eq .Values.cutover.mode "job" }}` so a bundle flipped back to
// `mode: none` renders none of them.
//
// The Job is a PLAIN, per-build-named batch/v1 Job — Flux-native by construction (gap #4:
// the population is 94/6 Flux/Argo, and Flux has no sync-hook machinery, so correctness
// cannot depend on one). It is applied WITH the bundle like any other resource and runs
// once when the sync creates it; per-build naming (same digest-suffix idiom as
// routeExtJobName) means a no-op re-sync of the same bundle does NOT re-run a completed
// cutover — Kubernetes Jobs are immutable, so the completed object just sits there. Argo
// PostSync hook annotations are OPTIONAL sugar for the PR3 recipes, never required for
// correctness, and are deliberately absent here.
import { createHash } from "node:crypto";
import {
  assertSafeBuildId,
  assertSafeReleaseName,
  escapeHelmActions,
  keepAtBirthAnnotationEntries,
  renderImagePullSecrets,
  sanitizeK8sName,
} from "./utils.js";

/** Component label on the Job (and the pane the operator greps for). */
export const CUTOVER_JOB_COMPONENT = "cutover-job";

/** Component label on the per-build emit-metadata ConfigMap — the GC sweep keys on it. */
export const EMIT_METADATA_COMPONENT = "emit-metadata";

/**
 * Per-build cutover Job name: `<release>-cutover-<12 hex>` — the same 48-bit digest
 * suffix idiom as routeExtJobName, for the same two reasons: Jobs are immutable (each
 * build needs a fresh name) and the digest survives any truncation, so two build ids can
 * never collide on one Job name (a collision would make the second build's promotion a
 * silent no-op — the completed first Job "is" the cutover).
 */
export function cutoverJobName(releaseName: string, buildId: string): string {
  const buildDigest = createHash("sha256").update(buildId).digest("hex").slice(0, 12);
  return `${releaseName}-cutover-${buildDigest}`;
}

/** Stable ServiceAccount/Role/RoleBinding names — replaced in place by every sync. */
export function cutoverServiceAccountName(releaseName: string): string {
  return sanitizeK8sName(`${releaseName}-cutover-sa`);
}
export function cutoverRoleName(releaseName: string): string {
  return sanitizeK8sName(`${releaseName}-cutover`);
}

/**
 * Per-build emit-metadata ConfigMap name. Per-build (not stable) for the same reason the
 * routing-manifest snapshot CM is: kubelet propagates UPDATES to watched ConfigMaps
 * asynchronously (minutes, degraded clusters — five consecutive deploys died on this,
 * 2026-07-30), while a never-seen NAME is a fresh GET with no propagation window. The
 * Job of bundle N mounts the CM of bundle N atomically from the same manifest.
 */
export function emitMetadataConfigMapName(releaseName: string, buildId: string): string {
  const digest = createHash("sha256").update(buildId).digest("hex").slice(0, 8);
  return sanitizeK8sName(`${releaseName}-emit-meta-${buildId}`, `-${digest}`);
}

/** Path the Job's entrypoint reads the mounted emit-metadata.json from. */
export const EMIT_METADATA_MOUNT_DIR = "/etc/adapter-k8s";
export const EMIT_METADATA_MOUNT_PATH = `${EMIT_METADATA_MOUNT_DIR}/emit-metadata.json`;

export function renderCutoverJob({
  releaseName,
  buildId,
  pullSecrets,
}: {
  releaseName: string;
  buildId: string;
  /** config `imagePullSecrets` — the Job pod pulls the cutover image too (gap #2). */
  pullSecrets?: string[];
}): string {
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  const pullSecretsBlock = renderImagePullSecrets(pullSecrets, "      ");
  return `{{- if eq .Values.cutover.mode "job" }}
# The in-cluster cutover Job (design §4.2, PLAIN by design — real-cluster gap #4):
# applied with the bundle like any other resource, no Argo hook/sync-wave semantics
# required for correctness. It runs the same gate battery as imperative deploy (exact-
# version rollout waits, route-ext Job completion, generation-guarded policy Accepted,
# HPA warm-up, per-pool /readyz capacity), then patches the stable Service selectors to
# this build, commits the state ConfigMap (cluster-only mode), invalidates CDN, and
# parks the previous build — exiting nonzero (after restoring the edge) on any gate
# failure, which the reconciler surfaces as a failed Job.
apiVersion: batch/v1
kind: Job
metadata:
  name: ${cutoverJobName(releaseName, buildId)}{{ if .Values.cutover.forcePromotion }}-force{{ end }}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}
  annotations:
    # The name carries only a digest of the build id — record the full id for operators
    # (an annotation, not a label: build ids may exceed the 63-char label-value cap).
    adapter-k8s.dev/build-id: ${escapeHelmActions(JSON.stringify(buildId))}
spec:
  # One retry absorbs a transient pod-level failure (node drain, image pull blip); a
  # PERSISTENTLY failing build is handled by the poison pill in the entrypoint (the Job
  # records the failed build id in the state ConfigMap and refuses re-promotion without
  # cutover.forcePromotion), so retries can never flap the HPA warm-up indefinitely.
  backoffLimit: 1
  # NO ttlSecondsAfterFinished: the per-build name is the idempotency key — a re-sync of
  # the same bundle must find the completed Job, not a swept one it would re-create.
  template:
    metadata:
      # The same name/component pair as the Job object, so \`kubectl logs -l
      # app.kubernetes.io/component=${CUTOVER_JOB_COMPONENT}\` reaches the PODS (the batch
      # controller only stamps its own job-name labels). Deliberately NOT matched by any
      # NetworkPolicy podSelector (those pair the name label with routing-service/pool
      # components), so the pod's apiserver egress stays unrestricted.
      labels:
        app.kubernetes.io/name: "${releaseName}"
        app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}
    spec:
      serviceAccountName: ${cutoverServiceAccountName(releaseName)}
      restartPolicy: Never
${pullSecretsBlock}      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: cutover
          image: {{ .Values.cutover.image | quote }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          env:
            - name: RELEASE_NAME
              value: "${releaseName}"
            # The Job promotes in its own namespace — downward API, never a values echo
            # that could disagree with where the bundle was actually applied.
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: EMIT_METADATA_PATH
              value: ${EMIT_METADATA_MOUNT_PATH}
            # Poison-pill override (design §8 risk 4): re-promote a build this release's
            # state ConfigMap records as a FAILED promotion. Off by default.
            - name: FORCE_PROMOTION
              value: {{ .Values.cutover.forcePromotion | quote }}
          volumeMounts:
            - name: emit-metadata
              mountPath: ${EMIT_METADATA_MOUNT_DIR}
              readOnly: true
            - name: tmp
              mountPath: /tmp
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
      volumes:
        - name: emit-metadata
          configMap:
            name: ${emitMetadataConfigMapName(releaseName, buildId)}
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
{{- end }}
`;
}

/**
 * The Job's namespace-scoped RBAC: ServiceAccount + Role + RoleBinding, verbs enumerated
 * from what the cutover module actually executes (each rule names its consumer). No
 * cluster-scoped permissions: the CRD existence probe in gc.ts degrades with a warning
 * when it cannot read CRDs, and GKE HealthCheckPolicy cleanup is a best-effort no-op on
 * the clusters this mode targets.
 */
export function renderCutoverRbac({ releaseName }: { releaseName: string }): string {
  assertSafeReleaseName(releaseName);
  const sa = cutoverServiceAccountName(releaseName);
  const role = cutoverRoleName(releaseName);
  return `{{- if eq .Values.cutover.mode "job" }}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${sa}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: ${role}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}
rules:
  # E1 selector cutover + revert: read the exact live selectors, patch them by NAME.
  # E6 deletes superseded builds' versioned Services.
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "patch", "delete"]
  # D1/D2 rollout waits (get/list/watch), N64 live replica read (get), edge revert
  # patches the routing Deployment (patch), E6 deletes superseded builds' Deployments.
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "patch", "delete"]
  # kubectl scale (D6 pre-cutover capacity match, E5 park-at-zero) hits the scale
  # subresource.
  - apiGroups: ["apps"]
    resources: ["deployments/scale"]
    verbs: ["patch", "update"]
  # D6 warm-up lifts/restores HPA bounds (patch); E5 deletes the outgoing HPA; the
  # revert path recreates one (create).
  - apiGroups: ["autoscaling"]
    resources: ["horizontalpodautoscalers"]
    verbs: ["get", "list", "create", "patch", "delete"]
  # D7 readiness gate lists pods by label and reads their Ready condition; the failure
  # diagnostics run the in-pod /readyz probe (pods/exec) and read pod logs.
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  # D3 waits on the route-ext registration Job; E6 GCs superseded route-ext Jobs.
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "delete"]
  # The state ConfigMap (N20/N21/N23/S19: read + create/replace under resourceVersion
  # precondition), routing-manifest snapshot retention (get/create/patch via apply +
  # annotate/label), and E6's snapshot/plan CM pruning (delete).
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "create", "update", "patch", "delete"]
  # Edge revert probes the target build's per-build dispatch Secret BY NAME before
  # moving the secretKeyRef (N87); E6 prunes unreferenced dispatch Secrets.
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get", "list", "delete"]
  # E6's retained stable-resource sweep lists PodDisruptionBudgets by label, reads each
  # to confirm it selects the pool it claims to, and deletes the obsolete ones. Without
  # this rule the sweep is forbidden — non-fatal (it runs after the state commit and is
  # best-effort), but every Job logs the failure and removed pools' PDBs are never GC'd.
  # HealthCheckPolicies need no rule: the cluster-scoped CRD probe fails first under the
  # Job's namespaced Role and drops that kind from the sweep entirely.
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "delete"]
  # D4/D5 generation-guarded Accepted gate — read-only.
  - apiGroups: ["gateway.envoyproxy.io"]
    resources: ["envoyextensionpolicies"]
    verbs: ["get"]
  # Composition-plan readiness (waitForCompositionPlanReadiness): HTTPRoute
  # Accepted/ResolvedRefs, Gateway address, Ingress, cert-manager Certificate Ready,
  # and EndpointSlice capacity. Read-only — the Job refuses promotion until they are
  # ready; it never repairs them. Cross-namespace parent Gateways are not readable
  # from this namespaced Role; HTTPRoute status in this namespace is the gate.
  - apiGroups: ["gateway.networking.k8s.io"]
    resources: ["httproutes", "gateways"]
    verbs: ["get", "list"]
  - apiGroups: ["cert-manager.io"]
    resources: ["certificates"]
    verbs: ["get", "list"]
  - apiGroups: ["discovery.k8s.io"]
    resources: ["endpointslices"]
    verbs: ["get", "list"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: ${role}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${CUTOVER_JOB_COMPONENT}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: ${role}
subjects:
  - kind: ServiceAccount
    name: ${sa}
{{- end }}
`;
}

/**
 * The per-build emit-metadata ConfigMap the Job mounts (§4.2: "emit-metadata.json,
 * mounted via the bundle's per-build ConfigMap — it is small and non-secret"). Written
 * by emit with the SAME JSON it writes to the bundle root, minus nothing the Job needs.
 */
export function renderEmitMetadataConfigMap({
  releaseName,
  buildId,
  emitMetadataJson,
}: {
  releaseName: string;
  buildId: string;
  emitMetadataJson: string;
}): string {
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  const indented = escapeHelmActions(emitMetadataJson)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `{{- if eq .Values.cutover.mode "job" }}
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${emitMetadataConfigMapName(releaseName, buildId)}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: ${EMIT_METADATA_COMPONENT}
    app.kubernetes.io/version: "${sanitizeK8sName(buildId)}"
  annotations:
${keepAtBirthAnnotationEntries("    ")}data:
  emit-metadata.json: |-
${indented}
{{- end }}
`;
}
