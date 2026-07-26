import { assertSafeProjectId, assertSafeReleaseName } from "./utils.js";

export function renderDeployServiceAccount({
  releaseName,
  projectId,
}: {
  releaseName: string;
  projectId: string;
}): string {
  // Sanitize at the point of consumption (AGENTS.md). Neither was checked here, and the
  // annotation value below is the IAM binding that grants this KSA the deploy Google
  // service account's permissions — a malformed/attacker-chosen projectId points Workload
  // Identity at a different project's service account.
  assertSafeReleaseName(releaseName);
  assertSafeProjectId(projectId);
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${releaseName}-deploy-sa
  annotations:
    iam.gke.io/gcp-service-account: ${releaseName}-deploy@${projectId}.iam.gserviceaccount.com
`;
}
