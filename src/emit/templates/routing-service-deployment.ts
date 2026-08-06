import {
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeQuantity,
  assertSafeReleaseName,
  UNCONFIGURED_IMAGE_REGISTRY,
  routingManifestSnapshotName as routingManifestSnapshotNameFor,
  renderUserEnvBlocks,
  escapeHelmActions,
} from "./utils.js";
import type { EnvValue, EnvFromSource } from "../../types.js";
import {
  assertSafeImageDigest,
  PRESTOP_DRAIN_SECONDS,
  TERMINATION_GRACE_SECONDS,
} from "./deployment.js";
import { renderInternalSecretEnv } from "./internal-secret.js";
import type { TargetArchitecture } from "../../target-platform.js";

export interface RoutingServiceResources {
  cpu?: string;
  memory?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

/**
 * N70. Routing-tier defaults, sized for the cluster type this adapter actually creates.
 *
 * The old comment claimed "a full core of burst headroom" (250m request / 1000m limit).
 * That is false on the default cluster type: `init` defaults `autopilot = true`, and per
 * "Resource requests in Autopilot"
 * (https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)
 * on a cluster that does not support bursting "GKE sets the `limits` equal to the
 * `requests`" — so the REQUEST is the ceiling and the headroom does not exist. A
 * CPU-bound, single-threaded ext_proc server pinned at 250m under load blows past its 4 s
 * handler budget / the 5 s GCP callout deadline, and the callout policy is fail-CLOSED
 * whenever the app has middleware, i.e. 500s rather than degradation.
 *
 * Same page: the minimum memory request on a general-purpose Autopilot cluster without
 * bursting is 512 MiB, so the old 256Mi was silently rewritten and the HPA's 70% CPU
 * target was computed against a request the operator never chose. The memory:CPU ratio
 * must also stay between 1:1 and 1:6.5 (GiB per vCPU): 500m + 512Mi sits exactly at 1:1.
 *
 * Requests are therefore EQUAL to limits by default, which makes the emitted spec mean
 * the same thing on Autopilot and on Standard. An operator who wants burst on a Standard
 * cluster sets `routingService.resources.cpuLimit` explicitly.
 */
export const DEFAULT_ROUTING_RESOURCES = {
  cpu: "500m",
  memory: "512Mi",
} as const;

export function renderRoutingServiceDeployment({
  releaseName,
  buildId,
  imageRegistry,
  resources,
  failOpen,
  requestTimeoutMs,
  imageDigest,
  transport = "tls",
  env,
  envFrom,
  deploymentId,
  nodeArchitecture = "amd64",
}: {
  releaseName: string;
  buildId: string;
  imageRegistry: string;
  resources?: RoutingServiceResources;
  /**
   * S26. ext_proc listener transport. GKE's callout arrives from Google's frontend over TLS;
   * an in-cluster Envoy Gateway dials plain h2c unless a BackendTLSPolicy says otherwise.
   * Stated explicitly because the image BAKES TLS_CERT_FILE/TLS_KEY_FILE, so a Deployment can
   * override those values but never unset them — and a mismatch is invisible: the health
   * server stays green on :8081 while every callout fails.
   */
  transport?: "tls" | "h2c";
  /** GCP callout-failure policy mirrored to the server: false = fail-closed (500). */
  failOpen?: boolean;
  requestTimeoutMs?: number;
  /** N72. Immutable digest for the routing image; see renderDeployment's `imageDigest`. */
  imageDigest?: string;
  /** User-supplied runtime environment (top-level config; NODE middleware reads it here). */
  env?: Record<string, EnvValue>;
  envFrom?: EnvFromSource[];
  /** next.config `deploymentId` — see renderDeployment; node middleware runs here. */
  deploymentId?: string;
  nodeArchitecture?: TargetArchitecture;
}): string {
  // Sanitize at the point of consumption (AGENTS.md) — this template splices all three
  // into resource names, a quoted image reference, and `value: "…"` env scalars.
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  // See UNCONFIGURED_IMAGE_REGISTRY — adapter.ts's own "not configured yet" literal, which
  // deploy replaces via `--set`; exempted by identity so the guard stays strict otherwise.
  if (imageRegistry !== UNCONFIGURED_IMAGE_REGISTRY) assertSafeImageRegistry(imageRegistry);
  if (imageDigest !== undefined) assertSafeImageDigest(imageDigest);

  const safeBuildId = sanitizeK8sName(buildId);
  const cpuReq = resources?.cpu ?? DEFAULT_ROUTING_RESOURCES.cpu;
  const memReq = resources?.memory ?? DEFAULT_ROUTING_RESOURCES.memory;
  // Default the limits to the requests (see DEFAULT_ROUTING_RESOURCES): an operator who
  // overrides only `cpu` still gets a spec whose meaning does not change with the cluster's
  // bursting support.
  const cpuLim = resources?.cpuLimit ?? cpuReq;
  const memLim = resources?.memoryLimit ?? memReq;
  // N60 (SECURITY). These four are interpolated UNQUOTED below, so they needed no
  // quote-escaping to break out at all: `cpu: "250m\n              INJECTED: yes"`
  // injected a sibling key into the container's `resources` on the first try, and the
  // values.yaml sink next door reached `hostNetwork: true` on the pod. Nothing validated
  // them — not validateConfig, not this template.
  assertSafeQuantity(cpuReq, "routingService.resources.cpu");
  assertSafeQuantity(memReq, "routingService.resources.memory");
  assertSafeQuantity(cpuLim, "routingService.resources.cpuLimit");
  assertSafeQuantity(memLim, "routingService.resources.memoryLimit");
  if (requestTimeoutMs !== undefined && !Number.isInteger(requestTimeoutMs)) {
    throw new Error(
      `Invalid routingService.requestTimeoutMs ${JSON.stringify(requestTimeoutMs)}: expected ` +
        `an integer number of milliseconds (it is interpolated into a pod env value).`,
    );
  }

  // S7: same values seam as the pool Deployment — the digest is only knowable after push.
  const imageRef =
    imageDigest !== undefined
      ? `${imageRegistry}/routing-service@${imageDigest}`
      : `${imageRegistry}/routing-service{{ with .Values.routingService.image.digest }}@{{ . }}{{ else }}:${buildId}{{ end }}`;
  const imagePullPolicy =
    imageDigest !== undefined
      ? "IfNotPresent"
      : `{{ with .Values.routingService.image.digest }}IfNotPresent{{ else }}Always{{ end }}`;

  // N87: build-scoped secret name (see internal-secret.ts). The routing tier is a single
  // in-place Deployment, so this moves with the image on every deploy — and rollback patches
  // it back alongside NEXT_BUILD_ID, or the reverted edge would present the rolled-away-from
  // build's secret to the rolled-back pools.
  const internalSecretEnv = renderInternalSecretEnv(releaseName, buildId, "            ");
  // Same env blocks as the pool template (see renderUserEnvBlocks): NODE-runtime middleware
  // executes in THIS container and reads process.env at request time.
  const { userEnv, userEnvFrom } = renderUserEnvBlocks(env, envFrom);
  const deploymentIdEnv = deploymentId
    ? `\n            - name: NEXT_DEPLOYMENT_ID\n              value: ${escapeHelmActions(JSON.stringify(deploymentId))}`
    : "";
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${releaseName}-routing-service
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
spec:
  # Zero-downtime rollout behind a standalone NEG. The routing service is the ext_proc
  # backend; when it rolls to a new build image, old pods must not drain from the NEG
  # before new pods are health-checked into it by the GCP load balancer — otherwise the
  # fail-closed callout 500s for the sync window (observed ~90s on a redeploy). Never drop
  # below desired replicas, and count a new pod as "available" only after it has been Ready
  # long enough for the LB backend health check to pass.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  minReadySeconds: 30
  selector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: routing-service
  template:
    metadata:
      labels:
        app.kubernetes.io/name: "${releaseName}"
        app.kubernetes.io/component: routing-service
        app.kubernetes.io/version: "${safeBuildId}"
    spec:
      # The routing service never calls the Kubernetes API — don't mount a SA token.
      automountServiceAccountToken: false
      nodeSelector:
        kubernetes.io/arch: "${nodeArchitecture}"
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      # N63. Give a terminating pod time to keep serving in-flight callouts while the LB
      # stops routing to it (preStop below), before SIGTERM/kill. Was 25s/40s while the
      # comment above measured a ~90s NEG sync — the value contradicted the measurement.
      # Now matched to Google's guidance for NEG-backed pods ("Troubleshoot load balancing
      # in GKE": preStop sleep 120, terminationGracePeriodSeconds 3.5 minutes), which is
      # also comfortably above the observed drain.
      terminationGracePeriodSeconds: ${TERMINATION_GRACE_SECONDS}
      # N65. The tier defaults to 2 replicas that the scheduler is free to co-locate, and
      # the callout is fail-CLOSED whenever the app has middleware — losing both replicas
      # is a total 500, not degraded service. Soft (ScheduleAnyway) so a small cluster
      # never fails to schedule the second replica.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: "${releaseName}"
              app.kubernetes.io/component: routing-service
      containers:
        - name: routing-service
          image: "${imageRef}"
          imagePullPolicy: ${imagePullPolicy}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          lifecycle:
            preStop:
              # Keep serving while GCP reprograms the NEG to drain this terminating pod.
              # Without this, in-flight ext_proc callouts land on a pod that's already gone.
              exec:
                command: ["/bin/sh", "-c", "sleep ${PRESTOP_DRAIN_SECONDS}"]
          ports:
            - containerPort: 8443
              name: grpc
            - containerPort: 8081
              name: health
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: PORT
              value: "8443"
            - name: HEALTH_PORT
              value: "8081"
            - name: ROUTING_TRANSPORT
              value: "${transport}"
            - name: ROUTING_FAIL_OPEN
              value: "${failOpen === false ? "false" : "true"}"
            - name: ROUTING_REQUEST_TIMEOUT_MS
              value: "${requestTimeoutMs ?? 4000}"
            - name: CONFIG_DIR
              value: /config
            # The per-replica TLS cert generated at container start needs the release
            # name + namespace to build its CN/SAN (cert lands in /tmp/tls).
            - name: RELEASE_NAME
              value: "${releaseName}"
            - name: NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
${internalSecretEnv}${deploymentIdEnv}${userEnv}${userEnvFrom}
          volumeMounts:
            - name: routing-manifest
              mountPath: /config
            # readOnlyRootFilesystem makes / read-only; the runtime TLS cert
            # generation writes under /tmp/tls, backed by this emptyDir. NOT in-memory
            # (that needs \`medium: Memory\`) — node disk, bounded by the sizeLimit below.
            - name: tmp
              mountPath: /tmp
          # httpGet, not a socket check: a wedged event loop still accepts a TCP
          # connection but fails to *serve* /healthz, so a broken-but-listening pod
          # gets evicted from the NEG instead of silently failing callouts.
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 3
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 10
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: "${cpuReq}"
              memory: "${memReq}"
            limits:
              cpu: "${cpuLim}"
              memory: "${memLim}"
      volumes:
        - name: routing-manifest
          configMap:
            # PER-BUILD, deliberately (2026-07-30): mounting the stable mutable CM raced
            # kubelet's ConfigMap-update propagation on every deploy — a new pod could mount
            # the pre-upgrade manifest and the match guard crashed it. A per-build name is a
            # fresh GET with no propagation window. Rollback re-points to the previous
            # build's snapshot, which its retained render names automatically.
            name: ${routingManifestSnapshotNameFor(releaseName, buildId)}
        - name: tmp
          emptyDir:
            sizeLimit: 64Mi
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${releaseName}-routing-service-pdb
  labels:
    app.kubernetes.io/name: "${releaseName}"
    app.kubernetes.io/component: routing-service
spec:
  # N65. A single node drain could otherwise evict every routing-service replica through
  # the eviction API at once. With middleware present the callout is fail-closed, so that
  # is a total 500 for the release — the one tier where "degraded" is not an option.
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: routing-service
`;
}
