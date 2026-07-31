// src/emit/templates/deployment.ts
import {
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafeImageReference,
  assertSafePoolName,
  assertSafeProbePath,
  assertSafeQuantity,
  assertSafeReleaseName,
  assertSafeReplicaCount,
  escapeHelmActions,
  renderUserEnvBlocks,
} from "./utils.js";
import type { EnvValue, EnvFromSource } from "../../types.js";
import { renderInternalSecretEnv } from "./internal-secret.js";
import { renderValkeyEnv } from "./valkey-secret.js";

/**
 * N63. Pod-termination timings for a NEG-backed pod, from Google's own guidance —
 * "Troubleshoot load balancing in GKE"
 * (https://docs.cloud.google.com/kubernetes-engine/docs/troubleshooting/load-balancing):
 * "502 errors occur when Pods are terminated before existing connections close, while the
 * 503 errors occur when traffic is directed to deleted Pods… Apply a `preStop` hook that
 * will ensure the Pod is alive for 120 seconds longer while the Pod's endpoint is drained
 * in the load balancer… Set the `terminationGracePeriodSeconds` on the Pod to 3.5
 * minutes." Same page: "ensure your `preStop` hook execution time is greater than or equal
 * to the sum of the Backend Service Drain Timeout and drain latency", and the hook must be
 * on EVERY container because "Containers without the hook will exit as soon as the Pod is
 * deleted".
 *
 * Before this, pool pods had NEITHER: the pool server closes its listener the instant
 * SIGTERM arrives (pool-server/index.ts shutdown), so every HPA scale-down, every node
 * auto-upgrade, and deploy's own `kubectl scale --replicas=0` dropped in-flight requests
 * while the GFE was still sending them to the endpoint. The routing tier had the shape but
 * slept 25 s against its own comment measuring a ~90 s NEG drain.
 */
export const PRESTOP_DRAIN_SECONDS = 120;
export const TERMINATION_GRACE_SECONDS = 210;

/**
 * Ephemeral-storage sizing. `/app/.next/cache` is Next's FILESYSTEM incremental cache —
 * the fallback whenever the shared Valkey handler isn't wired — and it grows without
 * bound. An `emptyDir` with no `sizeLimit` is charged against the pod's ephemeral-storage
 * allowance, so on Autopilot the pod is evicted once the (defaulted) request is exceeded,
 * with nothing in the container log to explain it. Bound both volumes and request the
 * storage explicitly so the limit is the operator's number, not a platform default.
 * `TMP_SIZE_LIMIT + NEXT_CACHE_SIZE_LIMIT` must stay under `EPHEMERAL_STORAGE_REQUEST`.
 */
export const TMP_SIZE_LIMIT = "256Mi";
export const NEXT_CACHE_SIZE_LIMIT = "1Gi";
export const EPHEMERAL_STORAGE_REQUEST = "2Gi";

/**
 * N71. The pool server's readiness endpoint. Must stay byte-identical to
 * `READINESS_PATH` in `src/pool-server/server.ts` — pinned by a test that imports both.
 * Duplicated rather than imported so this template module stays dependency-free of the
 * pool-server runtime (the emit layer never pulls in the server bundle).
 *
 * `/healthz` returns a hardcoded 200 before any routing, handler load, or manifest check,
 * so it proves only that a socket is listening; `/readyz` answers 503 until instrumentation
 * registration has not failed AND at least one route module imported. LIVENESS stays on
 * `/healthz`: an endpoint that can legitimately 503 must never restart a pod.
 */
export const POOL_READINESS_PATH = "/readyz";

export interface DeploymentResourceLiterals {
  cpu?: string;
  memory?: string;
  cpuLimit?: string;
  memoryLimit?: string;
  ephemeralStorage?: string;
}

export function renderDeployment({
  poolName,
  buildId,
  releaseName,
  imageTag = "{{ .Values.global.image.tag }}",
  imageDigest,
  image,
  resources,
  replicas,
  readinessPath = POOL_READINESS_PATH,
  internalSecretRef,
  env,
  envFrom,
}: {
  poolName: string;
  buildId: string;
  releaseName: string;
  imageTag?: string;
  /**
   * N72. Immutable image digest (`sha256:…`). App images are otherwise pinned by a
   * MUTABLE tag while the deploy SA holds `artifactregistry.repoAdmin`, so a retag
   * changes what a pool runs on its next scale-up while existing nodes keep the cached
   * layer — a rollout and a scale-up can then run different code under one build id (the
   * cloud-sdk image in route-ext-update-job.ts got digest-pinned for exactly this
   * reason). When supplied the digest replaces the tag and `imagePullPolicy` becomes
   * IfNotPresent (the reference is already immutable); without it the policy is Always,
   * so a cached layer can never silently outlive a retag.
   */
  imageDigest?: string;
  /**
   * N66. A COMPLETE literal image reference, overriding registry/repository/tag. Used for
   * a RETAINED previous-build render: see `resources` below.
   */
  image?: string;
  /**
   * N66. Literal resource quantities, overriding the `.Values`-derived defaults per field.
   *
   * The retained previous Deployment is re-rendered by cli/deploy.ts through this same
   * function, and everything resolved from `.Values` resolves against the NEW build's
   * values. So changing `resources` in `next.config` between deploys mutated the pod
   * template of the build still serving 100% of traffic → default RollingUpdate rolled it
   * (previously with no preStop at all, see N63); flipping `containerStrategy` repointed
   * the retained manifest at `nextjs-app-<pool>:<previousBuildId>`, a tag never pushed, so
   * the serving build rolled into ImagePullBackOff BEFORE cutover. Passing literals
   * snapshotted from what is actually running makes a retained render a byte-for-byte
   * reproduction. (An earlier fix addressed the OMISSION of `resources` here; it did not
   * address the SKEW.)
   */
  resources?: DeploymentResourceLiterals;
  replicas?: number | undefined;
  /**
   * Readiness endpoint. `/healthz` returns a hardcoded 200 before any routing or handler
   * load, so it proves only that a socket is listening; the pool server's `/readyz`
   * (503 until it can actually serve) is the correct readiness target. Liveness stays on
   * `/healthz` — a readiness endpoint that can legitimately 503 must never restart a pod.
   */
  readinessPath?: string;
  /**
   * N87. The internal dispatch Secret this pod template resolves INTERNAL_HEADER_SECRET from,
   * as a LITERAL. Same rationale as `resources`/`readinessPath` above: for a RETAINED
   * previous-build render, deploy mirrors what the live pod template actually references. A
   * build deployed before per-build Secret names references the legacy stable name, and
   * stamping the derived per-build name onto it would point the SERVING build's pods at a
   * Secret nobody rendered (CreateContainerConfigError on every new pod, before cutover).
   * Omitted ⇒ the name derived from this render's own build id, which is what a normal build
   * wants.
   */
  internalSecretRef?: string;
  /** User-supplied runtime environment, already merged (top-level config + this pool). */
  env?: Record<string, EnvValue>;
  envFrom?: EnvFromSource[];
}): string {
  // Sanitize at the point of consumption (AGENTS.md). These three land in resource names,
  // label values, label SELECTORS, and `value: "…"` env scalars; none of them was checked
  // here before — `buildId` went raw into `value: "${buildId}"`.
  assertSafeReleaseName(releaseName);
  assertSafePoolName(poolName);
  assertSafeBuildId(buildId);
  if (image !== undefined) assertSafeImageReference(image);
  if (imageDigest !== undefined) assertSafeImageDigest(imageDigest);
  if (replicas !== undefined) assertSafeReplicaCount(replicas, "replicas");

  const name = sanitizeK8sName(`${releaseName}-${poolName}-${buildId}`);
  const safeBuildId = sanitizeK8sName(buildId);
  // N87: the dispatch secret is referenced by a BUILD-SCOPED name, so this pod template
  // resolves its own build's secret even when it restarts inside another build's deploy
  // window (a stable name let a restarted old pod pick up the NEW build's secret and trust
  // its middleware verdict — see internal-secret.ts).
  const internalSecretEnv = renderInternalSecretEnv(
    releaseName,
    buildId,
    "            ",
    internalSecretRef,
  );
  // Always emit the Valkey env — the secret refs are `optional: true`, so this is inert when no
  // cache is configured (the pool only registers the handler when VALKEY_URL is actually set).
  // Emitting it unconditionally keeps the pod template identical whether or not the cache is on,
  // so toggling `cache.enabled` between deploys never rolls the retained previous deployment.
  const valkeyEnv = "\n" + renderValkeyEnv(releaseName, "            ");

  // User-supplied runtime environment. Rendered AFTER the adapter's own entries: Kubernetes
  // takes the last occurrence of a duplicated name, so this ordering makes "user config can
  // never shadow a built-in" a property of the output rather than of validation alone
  // (validateConfig rejects the collision too — belt and braces, cheap).
  //
  // Every interpolated string is JSON.stringify'd (env values must be YAML strings, and a
  // bare `1.20` or `yes` would parse as a float/bool and be rejected at apply time) and then
  // escapeHelmActions'd, because chart templates are Go-template-evaluated before the YAML is
  // parsed — see the S5 note in utils.ts.
  const { userEnv, userEnvFrom } = renderUserEnvBlocks(env, envFrom);

  // N60. Literal quantities are validated here too: a `.Values`-sourced quantity is
  // already checked in values-yaml.ts, but a literal from deploy's per-build snapshot
  // reaches the pod spec through this template and nowhere else.
  const valuesRef = (field: string) =>
    `{{ (index .Values.pools "${poolName}").resources.${field} }}`;
  const quantity = (literal: string | undefined, field: string, valuesPath: string): string => {
    if (literal === undefined) return valuesRef(valuesPath);
    assertSafeQuantity(literal, `pool "${poolName}" ${field}`);
    return literal;
  };
  const cpuRequest = quantity(resources?.cpu, "resources.cpu", "requests.cpu");
  const memoryRequest = quantity(resources?.memory, "resources.memory", "requests.memory");
  const cpuLimit = quantity(resources?.cpuLimit, "resources.cpuLimit", "limits.cpu");
  const memoryLimit = quantity(resources?.memoryLimit, "resources.memoryLimit", "limits.memory");
  const ephemeralStorage = resources?.ephemeralStorage ?? EPHEMERAL_STORAGE_REQUEST;
  assertSafeQuantity(ephemeralStorage, `pool "${poolName}" resources.ephemeralStorage`);
  // N85: same sink class as the quantities above. This value is no longer always a constant —
  // deploy snapshots the LIVE pod template's probe path for a retained build (N66), so a
  // cluster-sourced string reaches this bare YAML scalar. Validate at the consumption point.
  assertSafeProbePath(readinessPath, `pool "${poolName}" readinessPath`);

  // S7 (SECURITY). The digest can arrive two ways, and BOTH must be honored:
  //  - `imageDigest` at render time (a caller that already knows it), or
  //  - `pools.<pool>.image.digest` in VALUES, which is how the deploy CLI supplies it: the
  //    chart is generated by `next build`, which runs BEFORE `docker push`, so the digest
  //    simply does not exist at render time. Without this seam every pool shipped a MUTABLE
  //    tag with the deploy identity holding registry write access — and since that identity
  //    is assumable by anyone who can create a Pod in the namespace, and these pods carry
  //    INTERNAL_HEADER_SECRET in env, a retag turned pod-creation into dispatch-secret theft
  //    on the next restart or scale-up.
  const valuesDigest = `(index .Values.pools "${poolName}").image.digest`;
  const registryAndRepo = `{{ .Values.global.image.registry }}/{{ (index .Values.pools "${poolName}").image.repository }}`;
  const imageRef =
    image ??
    (imageDigest !== undefined
      ? `${registryAndRepo}@${imageDigest}`
      : `${registryAndRepo}{{ with ${valuesDigest} }}@{{ . }}{{ else }}:${imageTag}{{ end }}`);
  // An immutable reference can be cached forever; a mutable tag must be re-resolved on
  // every pod start or a scale-up silently serves a stale cached layer (N72). When the digest
  // comes from values the policy has to be decided by helm, for the same reason.
  const imagePullPolicy =
    imageDigest !== undefined || /@sha256:/.test(image ?? "")
      ? "IfNotPresent"
      : image !== undefined
        ? "Always"
        : `{{ with ${valuesDigest} }}IfNotPresent{{ else }}Always{{ end }}`;

  // N64. A new build used to omit `replicas` entirely, so the API server defaulted it to
  // 1 — while deploy goes to real trouble to render the PREVIOUS build at its live count.
  // A previous build sitting at 6 replicas under load therefore cut over to a single pod
  // with the HPA climbing from behind. Seed from the pool's HPA floor
  // (`.replicas.min`, the same value hpa.ts uses for `minReplicas`) so the new build
  // starts no smaller than the autoscaler's own minimum. NOTE: because the field is now
  // present, a `helm upgrade` that re-applies an UNCHANGED build id resets that
  // Deployment to the floor instead of leaving the HPA's current count alone — bounded to
  // "scaled down to minReplicas, then the HPA climbs back", which is strictly better than
  // the previous "every new build starts at 1".
  const replicaLine =
    replicas !== undefined
      ? `  replicas: ${replicas}\n`
      : `  replicas: {{ (index .Values.pools "${poolName}").replicas.min }}\n`;

  const podLabels = `        app.kubernetes.io/name: "${releaseName}"
        app.kubernetes.io/component: "${poolName}"
        app.kubernetes.io/version: "${safeBuildId}"`;

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    app.kubernetes.io/name: "${releaseName}"
    # N61: QUOTED. A pool named "on"/"no"/"y"/"off"/"true"/"123" renders a YAML boolean or
    # int here; \`helm template\` accepts it (exit 0) and the apiserver then rejects the
    # whole chart — "json: cannot unmarshal bool into Go struct field
    # ObjectMeta.metadata.labels of type string" (sigs.k8s.io/yaml -> go-yaml v2, which
    # implements YAML 1.1 booleans). buildId was already quoted in this block; the pool
    # name was the one value that wasn't.
    app.kubernetes.io/component: "${poolName}"
    app.kubernetes.io/version: "${safeBuildId}"
spec:
${replicaLine}  # N63. The other half of the 502/503 fix: a pool Deployment DOES get rolled — by an
  # image/pod-template change, and (because deploy.ts re-renders the retained previous
  # build through this same template) by any change to this file. With the default
  # RollingUpdate 25%/25% the pool can dip BELOW its live replica count while the active
  # Service still selects it. maxUnavailable: 0 + maxSurge: 1 never dips, and
  # minReadySeconds gives the GFE time to health-check each new pod into the NEG before the
  # next one is replaced — the same shape the routing tier already used.
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  minReadySeconds: 30
  selector:
    matchLabels:
      app.kubernetes.io/name: "${releaseName}"
      app.kubernetes.io/component: "${poolName}"
      app.kubernetes.io/version: "${safeBuildId}"
  template:
    metadata:
      labels:
${podLabels}
    spec:
      # The pool server never calls the Kubernetes API — don't mount a SA token.
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      # N63: keep the pod alive while the GFE reprograms the NEG to stop sending it
      # traffic (preStop below), then allow the drain to finish before SIGKILL.
      terminationGracePeriodSeconds: ${TERMINATION_GRACE_SECONDS}
      # N65: spread a build's replicas across nodes. ScheduleAnyway (not DoNotSchedule):
      # a soft constraint never blocks a scale-up on a small/single-node pool, which would
      # turn a capacity event into an outage; it only stops the scheduler from stacking
      # every replica on one node, where a single drain takes the whole pool out.
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: ScheduleAnyway
          labelSelector:
            matchLabels:
              app.kubernetes.io/name: "${releaseName}"
              app.kubernetes.io/component: "${poolName}"
              app.kubernetes.io/version: "${safeBuildId}"
      containers:
        - name: pool-server
          image: "${imageRef}"
          imagePullPolicy: ${imagePullPolicy}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          lifecycle:
            preStop:
              # N63. Google, "Troubleshoot load balancing in GKE": "Apply a preStop hook
              # that will ensure the Pod is alive for 120 seconds longer while the Pod's
              # endpoint is drained in the load balancer." Without it the pool closes its
              # listener the moment SIGTERM lands and in-flight requests the GFE is still
              # routing here become 502s (and requests to the deleted endpoint, 503s).
              exec:
                command: ["/bin/sh", "-c", "sleep ${PRESTOP_DRAIN_SECONDS}"]
          ports:
            - containerPort: 3000
          env:
            - name: NODE_ENV
              value: production
            - name: NEXT_BUILD_ID
              value: "${buildId}"
            - name: POOL_NAME
              value: "${poolName}"
            # The pool server derives cross-pool proxy target names from
            # RELEASE_NAME; without it proxyToPool defaults to "nextjs" and
            # can't reach sibling pools in any release not named that.
            - name: RELEASE_NAME
              value: "${releaseName}"
${internalSecretEnv}${valkeyEnv}${userEnv}${userEnvFrom}
          volumeMounts:
            # readOnlyRootFilesystem makes / read-only; Next still needs a writable
            # scratch dir, so /tmp is an emptyDir. NOT in-memory: a bare \`emptyDir: {}\`
            # is backed by the NODE's disk (an in-memory one needs \`medium: Memory\`,
            # which would charge the pages to the container's memory limit) — the comment
            # here claimed otherwise for a long time. Both volumes carry a sizeLimit so
            # unbounded growth is an eviction with a reason, not a mystery.
            - name: tmp
              mountPath: /tmp
            # Without the shared Valkey incremental handler wired (cache disabled, or an
            # edge-middleware app), Next falls back to its FILESYSTEM incremental cache at
            # .next/cache — which must exist writable or renders fail with EROFS. Per-pod
            # and ephemeral: correct (if unshared) degradation, never durable state. It
            # grows without bound in that fallback, hence the sizeLimit below.
            - name: next-cache
              mountPath: /app/.next/cache
          # N71. Probe timings are explicit, not inherited. The HTTP listener only comes up
          # at the END of startPoolServer (after .env loading and awaited instrumentation
          # registration), so everything before listen() is connection-refused: with the
          # old \`initialDelaySeconds: 10\` + default period 10 + default failureThreshold 3,
          # a slow-booting pool was restarted at ~30 s, forever. A startupProbe suspends
          # liveness until the pod answers once (30 * 5 s = 150 s of boot budget), and
          # timeoutSeconds is raised off the default 1 s, which failed any probe issued
          # while the event loop was blocked by module loading or a heavy render.
          startupProbe:
            httpGet:
              path: /healthz
              port: 3000
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 30
          readinessProbe:
            httpGet:
              path: ${readinessPath}
              port: 3000
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 3
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3
          resources:
            requests:
              cpu: "${cpuRequest}"
              memory: "${memoryRequest}"
              # Explicit so the emptyDir sizeLimits above are charged against a number the
              # operator chose rather than a platform default (Autopilot otherwise applies
              # its own and evicts silently once it is exceeded).
              ephemeral-storage: "${ephemeralStorage}"
            limits:
              cpu: "${cpuLimit}"
              memory: "${memoryLimit}"
      volumes:
        - name: tmp
          emptyDir:
            sizeLimit: ${TMP_SIZE_LIMIT}
        - name: next-cache
          emptyDir:
            sizeLimit: ${NEXT_CACHE_SIZE_LIMIT}
`;
}

// N72. `sha256:` + 64 lowercase hex — the only digest form Kubernetes/OCI accepts here,
// and the only one that can be spliced into an image reference without escaping.
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export function assertSafeImageDigest(digest: string): void {
  if (!IMAGE_DIGEST_RE.test(digest)) {
    throw new Error(
      `Invalid image digest "${digest}": must match ${IMAGE_DIGEST_RE} ` +
        `(e.g. "sha256:" followed by 64 lowercase hex characters).`,
    );
  }
}
