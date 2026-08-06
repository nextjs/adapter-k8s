import type { CompositionPlan } from "../../composition-plan/types.js";
import {
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
} from "../../composition-plan/fingerprint.js";
import {
  ADAPTER_RELEASE_LABEL,
  assertSafeBuildId,
  assertSafeReleaseName,
  escapeHelmActions,
  sanitizeK8sName,
} from "./utils.js";

export function compositionPlanConfigMapName(releaseName: string, buildId: string): string {
  return sanitizeK8sName(`${releaseName}-composition-${buildId}`);
}

export function renderCompositionPlanConfigMap(plan: CompositionPlan): string {
  const { releaseName, buildId } = plan.metadata;
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  const planJson = canonicalCompositionPlanJson(plan);
  const indented = escapeHelmActions(planJson)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  return `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${compositionPlanConfigMapName(releaseName, buildId)}
  annotations:
    helm.sh/resource-policy: keep
    adapter-k8s.dev/composition-digest: "${fingerprintCompositionPlan(plan)}"
  labels:
    ${ADAPTER_RELEASE_LABEL}: "${releaseName}"
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: composition-plan
    app.kubernetes.io/version: "${sanitizeK8sName(buildId)}"
immutable: true
data:
  plan.json: |-
${indented}
`;
}
