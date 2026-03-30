export function renderRouteExtUpdateJob({ releaseName, projectId, region, buildId }: { releaseName: string; projectId: string; region: string; buildId: string }): string {
  // Include buildId in the Job name so each deploy creates a fresh Job
  // (K8s Jobs are immutable — can't update an existing one)
  const safeBuildId = buildId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10);
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${releaseName}-route-ext-${safeBuildId}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/component: route-ext-job
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
              # Discover the forwarding rule created by the GKE Gateway controller
              echo "Discovering forwarding rules for ${releaseName}..."
              FR=$(gcloud compute forwarding-rules list \
                --project=${projectId} \
                --filter="name~${releaseName}" \
                --format="value(selfLink)" \
                --limit=1 2>&1) || true
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
                --location=global \
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
