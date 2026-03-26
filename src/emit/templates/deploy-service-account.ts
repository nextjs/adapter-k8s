export function renderDeployServiceAccount({
  releaseName,
  projectId,
}: {
  releaseName: string;
  projectId: string;
}): string {
  return `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${releaseName}-deploy-sa
  annotations:
    iam.gke.io/gcp-service-account: ${releaseName}-deploy@${projectId}.iam.gserviceaccount.com
`;
}
