export function renderRouteExtUpdateJob({ releaseName, projectId, region }: { releaseName: string; projectId: string; region: string }): string {
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${releaseName}-update-route-ext
  annotations:
    "helm.sh/hook": post-upgrade,post-install
    "helm.sh/hook-delete-policy": before-hook-creation
spec:
  template:
    spec:
      serviceAccountName: ${releaseName}-deploy-sa
      containers:
        - name: update-ext
          image: gcr.io/google.com/cloudsdktool/cloud-sdk:slim
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -e
              # Discover the forwarding rule created by the GKE Gateway controller
              FR=$(gcloud compute forwarding-rules list \
                --project=${projectId} \
                --filter="name~${releaseName}" \
                --format="value(selfLink)" \
                --limit=1 2>/dev/null)
              if [ -z "$FR" ]; then
                echo "WARNING: No forwarding rule found matching '${releaseName}'. Skipping route extension update."
                exit 0
              fi
              echo "Found forwarding rule: $FR"
              # Copy config (read-only mount) to /tmp and patch with actual forwarding rule
              cp /config/route-extension.yaml /tmp/route-extension.yaml
              sed -i "s|FORWARDING_RULE_PLACEHOLDER|$FR|g" /tmp/route-extension.yaml
              cat /tmp/route-extension.yaml
              gcloud service-extensions lb-route-extensions import \
                ${releaseName}-route-ext \
                --project=${projectId} \
                --location=${region} \
                --source=/tmp/route-extension.yaml \
                --quiet
          env:
            - name: CLOUDSDK_CORE_PROJECT
              value: "${projectId}"
          volumeMounts:
            - name: config
              mountPath: /config
      volumes:
        - name: config
          configMap:
            name: ${releaseName}-route-ext-config
      restartPolicy: Never
  backoffLimit: 3
`;
}
