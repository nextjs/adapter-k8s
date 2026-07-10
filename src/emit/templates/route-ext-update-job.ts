import { assertSafeReleaseName, assertSafeProjectId, assertSafeRegion } from "./utils.js";

// Single source of truth for the traffic-ext registration Job name. deploy.ts's
// "delete old jobs" cleanup MUST match this exactly — a mismatch (it previously used a
// 12-char build-id slice while the name uses 10) deletes the current job mid-run, so the
// extension never gets registered.
export function routeExtJobName(releaseName: string, buildId: string): string {
  const safeBuildId = buildId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  return `${releaseName}-route-ext-${safeBuildId}`;
}

export function renderRouteExtUpdateJob({
  releaseName,
  projectId,
  region,
  buildId,
}: {
  releaseName: string;
  projectId: string;
  region: string;
  buildId: string;
}): string {
  // These are spliced unescaped into a `/bin/sh -c` script that runs under a
  // privileged Workload-Identity service account. Validate against a safe charset
  // before interpolation so shell metacharacters can't break out of the script.
  assertSafeReleaseName(releaseName);
  assertSafeProjectId(projectId);
  assertSafeRegion(region);
  // Include buildId in the Job name so each deploy creates a fresh Job
  // (K8s Jobs are immutable — can't update an existing one)
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${routeExtJobName(releaseName, buildId)}
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
              set -e
              NEG="${releaseName}-routing-neg"
              BS="${releaseName}-routing-service"
              # 1. Discover ALL forwarding rules for this gateway (HTTP *and* HTTPS). Attaching
              #    only HTTPS leaves http:// traffic bypassing ext_proc, so middleware auth /
              #    rewrites can be bypassed over http://. Wait for the GKE Gateway controller to
              #    provision them; fail loudly if absent (never silently "succeed" unregistered).
              # Discover forwarding rules by the gateway's OWN frontend IP, never by a
              # name~releaseName substring: a short or shared release name (e.g. "app") would
              # regex-match another application's forwarding rules and attach this middleware
              # to their load balancer. The reserved static IP "${releaseName}-ip" is this
              # gateway's frontend, so filtering on IPAddress selects exactly this LB's rules.
              echo "Resolving gateway frontend IP (${releaseName}-ip)..."
              GWIP=$(gcloud compute addresses describe ${releaseName}-ip --global \
                --project=${projectId} --format="value(address)" 2>/dev/null)
              if [ -z "$GWIP" ]; then
                echo "ERROR: could not resolve gateway IP '${releaseName}-ip'. Refusing to fall"
                echo "back to name matching (could attach middleware to another app's LB)."
                exit 1
              fi
              echo "Gateway IP: $GWIP — discovering only forwarding rules on this IP..."
              FRS=""
              for i in $(seq 1 40); do
                FRS=$(gcloud compute forwarding-rules list --project=${projectId} \
                  --filter="IPAddress=$GWIP" --format="value(selfLink)" 2>/dev/null)
                [ -n "$FRS" ] && break
                sleep 5
              done
              if [ -z "$FRS" ]; then
                echo "ERROR: no forwarding rules on IP $GWIP after waiting (gateway not provisioned?)."
                exit 1
              fi
              echo "Forwarding rules:"; echo "$FRS"
              # 2. Attach the standalone routing-service NEG to the ext_proc backend service.
              #    The GKE NEG controller creates the NEG asynchronously after the Service is
              #    applied, so wait for it; fail loudly if it never appears.
              echo "Waiting for NEG $NEG..."
              ZONES=""
              for i in $(seq 1 40); do
                ZONES=$(gcloud compute network-endpoint-groups list --project=${projectId} \
                  --filter="name=$NEG" --format="value(zone.basename())" 2>/dev/null | sort -u)
                [ -n "$ZONES" ] && break
                sleep 5
              done
              if [ -z "$ZONES" ]; then
                echo "ERROR: NEG $NEG not found after waiting."
                exit 1
              fi
              # Fire the per-zone attaches asynchronously (each sync add-backend is ~30-60s;
              # a fresh backend across many zones otherwise takes minutes), then confirm all
              # zonal NEGs are attached so we don't proceed with an incomplete backend.
              ZC=0
              for Z in $ZONES; do
                echo "Attaching NEG $NEG ($Z) to backend $BS..."
                if ! gcloud compute backend-services add-backend $BS --global --project=${projectId} \
                  --network-endpoint-group=$NEG --network-endpoint-group-zone=$Z \
                  --balancing-mode=RATE --max-rate-per-endpoint=1000 --async --quiet; then
                  echo "Attach request for $NEG ($Z) failed; verifying final backend state..."
                fi
                ZC=$((ZC + 1))
              done
              echo "Confirming $ZC zonal NEG(s) attached..."
              for i in $(seq 1 40); do
                ATTACHED=$(gcloud compute backend-services describe $BS --global --project=${projectId} \
                  --format="value(backends[].group)" 2>/dev/null | tr ';,' '\\n\\n' | grep -c "$NEG" || true)
                [ "$ATTACHED" -ge "$ZC" ] && break
                sleep 3
              done
              if [ "\${ATTACHED:-0}" -lt "$ZC" ]; then
                echo "ERROR: only \${ATTACHED:-0}/$ZC zonal NEG(s) attached to $BS after waiting."
                exit 1
              fi
              # 3. Register the ext_proc TRAFFIC extension attached to EVERY forwarding rule
              #    (route extensions are unsupported on the global external ALB; traffic
              #    extensions run post-cache on origin traffic). Expand the placeholder line
              #    into one entry per forwarding rule.
              echo "$FRS" | sed 's/^/  - "/; s/$/"/' > /tmp/fr_list.yaml
              awk '/FORWARDING_RULE_PLACEHOLDER/{while((getline l < "/tmp/fr_list.yaml")>0) print l; next} {print}' \
                /config/route-extension.yaml > /tmp/ext.yaml
              cat /tmp/ext.yaml
              gcloud service-extensions lb-traffic-extensions import \
                ${releaseName}-traffic-ext \
                --project=${projectId} \
                --location=global \
                --source=/tmp/ext.yaml \
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
