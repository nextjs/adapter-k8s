import { createHash } from "node:crypto";
import {
  assertSafeReleaseName,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeBuildId,
} from "./utils.js";

// Single source of truth for the traffic-ext registration Job name. deploy.ts's
// "delete old jobs" cleanup MUST match this exactly — a mismatch deletes the current job
// mid-run, so the extension never gets registered. Kubernetes Jobs are immutable, so each
// build needs a distinct name. A 12-hex-character SHA-256 suffix preserves 48 bits of the
// complete build ID while always fitting after the 40-character release-name limit.
export function routeExtJobName(releaseName: string, buildId: string): string {
  const buildDigest = createHash("sha256").update(buildId).digest("hex").slice(0, 12);
  return `${releaseName}-route-ext-${buildDigest}`;
}

export function renderRouteExtUpdateJob({
  releaseName,
  projectId,
  region,
  buildId,
  documentDigest,
}: {
  releaseName: string;
  projectId: string;
  region: string;
  buildId: string;
  /**
   * S9. SHA-256 of the route-extension.yaml body this chart rendered
   * (routeExtDocumentDigest()). The Job refuses to import a mounted document that does not
   * hash to this. Optional so a direct caller without the ConfigMap in hand still renders a
   * working Job — the field checks below remain as a floor.
   */
  documentDigest?: string;
}): string {
  // These are spliced unescaped into a `/bin/sh -c` script that runs under a
  // privileged Workload-Identity service account. Validate against a safe charset
  // before interpolation so shell metacharacters can't break out of the script.
  assertSafeReleaseName(releaseName);
  assertSafeProjectId(projectId);
  assertSafeRegion(region);
  assertSafeBuildId(buildId);
  // Include buildId in the Job name so each deploy creates a fresh Job
  // (K8s Jobs are immutable — can't update an existing one)
  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${routeExtJobName(releaseName, buildId)}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: route-ext-job
  annotations:
    # The Job name carries only a digest of the build id — record the full id for
    # operators (an annotation, not a label: build ids may exceed the 63-char label cap).
    adapter-k8s.dev/build-id: "${buildId}"
spec:
  # Sweep finished Jobs so re-registrations don't accumulate in the namespace.
  ttlSecondsAfterFinished: 3600
  template:
    spec:
      serviceAccountName: ${releaseName}-deploy-sa
      # NOTE: the SA token stays automounted — this Job needs Workload Identity to call
      # gcloud. It still runs as an unprivileged user with a locked-down container.
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        fsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: update-ext
          # Pinned by digest: this Job runs under the privileged deploy Workload
          # Identity, so a retagged/compromised mutable tag would execute under
          # those permissions. Pinned 2026-07-21 via
          # "docker manifest inspect -v gcr.io/google.com/cloudsdktool/cloud-sdk:slim"
          # (Descriptor digest). NOTE: :slim publishes a single-arch (amd64)
          # manifest — on arm64 node pools, re-pin to the arm64 digest or use a
          # manifest-list tag. To update: re-resolve the digest, replace, and
          # bump this comment's date; verify a route-ext registration Job run.
          image: gcr.io/google.com/cloudsdktool/cloud-sdk:slim@sha256:4ff69e21bec9a7d0ed54d0134a9b9682fc8008252cb5f173a23ddd70b8e024a4
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
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
              # Attach each zonal NEG SYNCHRONOUSLY. add-backend has no --async flag (passing it
              # errors "unrecognized arguments: --async" and the attach never happens — which only
              # bites on a FRESH backend, since existing attachments survive redeploys), and
              # concurrent attaches to one backend conflict on its resource version, so this is
              # sequential (a few zones take a couple of minutes). The confirm loop below is the
              # source of truth, so a transient/duplicate error here doesn't fail the job outright.
              ZC=0
              for Z in $ZONES; do
                echo "Attaching NEG $NEG ($Z) to backend $BS..."
                if ! gcloud compute backend-services add-backend $BS --global --project=${projectId} \
                  --network-endpoint-group=$NEG --network-endpoint-group-zone=$Z \
                  --balancing-mode=RATE --max-rate-per-endpoint=1000 --quiet; then
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
              # N73 (SECURITY). /config is an operator-mutable ConfigMap, and this Job
              # imports whatever it finds there under a Workload Identity holding
              # networkservices.lbTrafficExtensions.* + compute.backendServices.update.
              # A rewritten \`service\`/\`authority\` would point this LB's callout at a
              # DIFFERENT backend — i.e. insert a middleware tier that sees and rewrites
              # every request. Both values are fully determined by the release name,
              # project, and the Helm release namespace, so verify them against the
              # values this Job was RENDERED with instead of trusting the mount. (The
              # residual IAM exposure — the binding is project-wide, so any principal who
              # can create a pod in this release namespace can set
              # serviceAccountName: ${releaseName}-deploy-sa and inherit it — needs a
              # resource condition on the binding in cli/init.ts; that is tracked
              # separately.)
              # S9 (SECURITY). WHOLE-DOCUMENT verification. The field checks below were the
              # only ones, and they left forwardingRules, celExpression, timeout, failOpen,
              # supportedEvents and loadBalancingScheme unverified — so a
              # ConfigMap carrying a VICTIM load balancer's forwarding rules plus the three
              # expected strings passed, and this Job attached the app's own verified
              # extension to someone else's LB (their traffic through this routing service,
              # its verdicts onto their requests). Pin the mount to the exact bytes the chart
              # rendered instead: everything is then covered, including fields added later.
              #
              # Hashed BEFORE the placeholder expansion, because the forwarding rules are
              # discovered from gcloud in this Job, not read from the mount — which is only
              # true while the placeholder is the sole source of them, so require it.
              EXPECT_DIGEST="${documentDigest ?? ""}"
              if [ -n "$EXPECT_DIGEST" ]; then
                if ! grep -q 'FORWARDING_RULE_PLACEHOLDER' /config/route-extension.yaml; then
                  echo "ERROR: route-extension.yaml carries no FORWARDING_RULE_PLACEHOLDER."
                  echo "Refusing to import: forwarding rules must come from this Job's own"
                  echo "discovery, never from the mounted ConfigMap."
                  exit 1
                fi
                GOT_DIGEST=$(sha256sum /config/route-extension.yaml | cut -d" " -f1)
                if [ "$GOT_DIGEST" != "$EXPECT_DIGEST" ]; then
                  echo "ERROR: route-extension.yaml does not match the rendered chart."
                  echo "  expected sha256: $EXPECT_DIGEST"
                  echo "  found sha256:    $GOT_DIGEST"
                  echo "Refusing to import: the mounted ConfigMap was modified after render."
                  exit 1
                fi
                echo "route-extension.yaml matches the rendered chart (sha256) ✓"
              fi
              EXPECT_SERVICE="projects/${projectId}/global/backendServices/${releaseName}-routing-service"
              EXPECT_AUTHORITY="${releaseName}-routing-service.{{ .Release.Namespace }}.svc.cluster.local"
              GOT_SERVICE=$(sed -n 's/^ *service: *"\\(.*\\)" *$/\\1/p' /tmp/ext.yaml)
              GOT_AUTHORITY=$(sed -n 's/^ *authority: *"\\(.*\\)" *$/\\1/p' /tmp/ext.yaml)
              if [ "$GOT_SERVICE" != "$EXPECT_SERVICE" ]; then
                echo "ERROR: route-extension.yaml service mismatch."
                echo "  expected: $EXPECT_SERVICE"
                echo "  found:    $GOT_SERVICE"
                echo "Refusing to import: the mounted ConfigMap would attach this app's"
                echo "ext_proc callout to a backend service it does not own."
                exit 1
              fi
              if [ "$GOT_AUTHORITY" != "$EXPECT_AUTHORITY" ]; then
                echo "ERROR: route-extension.yaml authority mismatch."
                echo "  expected: $EXPECT_AUTHORITY"
                echo "  found:    $GOT_AUTHORITY"
                exit 1
              fi
              # The extension name is this release's by construction; a mismatch means the
              # mount was replaced wholesale.
              if ! grep -q '^name: "${releaseName}-traffic-ext"$' /tmp/ext.yaml; then
                echo "ERROR: route-extension.yaml is not for ${releaseName}-traffic-ext."
                exit 1
              fi
              echo "route-extension.yaml verified against rendered service/authority ✓"
              gcloud service-extensions lb-traffic-extensions import \
                ${releaseName}-traffic-ext \
                --project=${projectId} \
                --location=global \
                --source=/tmp/ext.yaml \
                --quiet
          env:
            - name: CLOUDSDK_CORE_PROJECT
              value: "${projectId}"
            # gcloud refuses to run when its config home is unwritable; running as
            # non-root with a read-only root FS, point it at the /tmp emptyDir.
            - name: CLOUDSDK_CONFIG
              value: /tmp/.config/gcloud
          volumeMounts:
            - name: config
              mountPath: /config
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: config
          configMap:
            name: ${releaseName}-route-ext-config
        - name: tmp
          emptyDir: {}
      restartPolicy: Never
  backoffLimit: 3
`;
}
