// src/emit/templates/values-yaml.ts
import type { K8sAdapterConfig, PoolDefinition } from "../../types.js";
import {
  sanitizeK8sName,
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafePoolName,
  assertSafeQuantity,
  assertSafeReplicaCount,
  assertSafeTargetCPU,
  UNCONFIGURED_IMAGE_REGISTRY,
} from "./utils.js";
import { POOL_READINESS_PATH } from "./deployment.js";
import {
  DEFAULT_TARGET_PLATFORM,
  targetArchitecture,
  type TargetPlatform,
} from "../../target-platform.js";

/**
 * Pool defaults. Exported so the tests (and deploy's per-build snapshot) can pin the
 * exact strings a chart renders when `next.config` says nothing.
 */
export const DEFAULT_POOL_RESOURCES = {
  cpu: "250m",
  memory: "256Mi",
  cpuLimit: "1",
  memoryLimit: "512Mi",
} as const;

export const DEFAULT_POOL_SCALING = { min: 1, max: 3, targetCPU: 80 } as const;

export function renderValuesYaml({
  pools,
  buildId,
  nextVersion,
  targetPlatform = DEFAULT_TARGET_PLATFORM,
  config,
  imageRegistry,
  defaultPool = pools.keys().next().value,
}: {
  pools: Map<string, PoolDefinition>;
  buildId: string;
  nextVersion: string;
  targetPlatform?: TargetPlatform;
  config: K8sAdapterConfig;
  imageRegistry: string;
  defaultPool?: string;
}): string {
  // Output as JSON (valid YAML) with a comment header.
  const gke = config.provider && "gke" in config.provider ? config.provider.gke : undefined;

  // Sanitize at the point of consumption (AGENTS.md): every value below is read straight
  // out of `next.config`/the build and lands in helm values that the templates splice into
  // rendered YAML with no escaping of their own.
  assertSafeBuildId(buildId);
  // See UNCONFIGURED_IMAGE_REGISTRY: adapter.ts's own "not configured yet" literal, which
  // deploy replaces via `--set`. Exempted by identity so the guard stays strict for every
  // real value.
  if (imageRegistry !== UNCONFIGURED_IMAGE_REGISTRY) assertSafeImageRegistry(imageRegistry);

  const values = {
    global: {
      // The adapter publishes one platform per build, not a multi-arch index. Constrain every
      // adapter-built workload to nodes that can execute that image; otherwise a mixed-arch
      // cluster can schedule it onto the wrong node and fail only at image start.
      targetArchitecture: targetArchitecture(targetPlatform),
      image: {
        registry: imageRegistry,
        repository: "nextjs-app",
        tag: buildId,
      },
      // Empty CIDR lists by default: the deploy CLI passes `--set global.networkPolicy.
      // podCidrs={..}` / `nodeCidrs={..}` from cluster discovery (discoverClusterPodCidr,
      // discoverClusterNodeCidrs), both fail-closed.
      //
      // S22: `strict: true` is the DEFAULT posture — a positive allowlist of the Google
      // load-balancer and health-check ranges plus the cluster's node range, rather than the
      // broad `0.0.0.0/0 except <pod CIDR>` denylist. The broad posture only ever isolated
      // in-cluster PODS: every VPC peer, VM and hostNetwork pod could still reach
      // routing-service:8443, and that service answers an ordinary ext_proc call with the
      // internal dispatch secret in its header mutation — so a VPC-reachable caller could
      // read the secret and replay trusted dispatch headers straight to a pool, skipping
      // middleware. Strict was not the default before only because `nodeCidrs` had to be
      // supplied by hand (kubelet probes come from the node IP, and without that range
      // Calico leaves every pod unready); deploy now discovers it, so the secure posture
      // costs the operator nothing. `--allow-no-network-policy` remains the explicit opt-out.
      networkPolicy: {
        podCidrs: [] as string[],
        nodeCidrs: [] as string[],
        strict: true,
      },
    },
    pools: Object.fromEntries(
      [...pools.entries()].map(([name, pool]) => {
        assertSafePoolName(name);
        // N60 (SECURITY). helm performs NO escaping, so these strings reach the pod spec
        // verbatim through `{{ (index .Values.pools "<p>").resources… }}` in
        // deployment.ts. VERIFIED before this guard existed: a memoryLimit of
        // `512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n  _pad: "`
        // rendered valid YAML with `hostNetwork: true` on the POD, which voids both
        // NetworkPolicy postures (N19 in network-policy.ts). Same story for the scaling
        // numbers, which hpa.ts interpolates as bare `minReplicas: {{ … }}` scalars.
        const resources = {
          cpu: pool.config.resources?.cpu ?? DEFAULT_POOL_RESOURCES.cpu,
          memory: pool.config.resources?.memory ?? DEFAULT_POOL_RESOURCES.memory,
          cpuLimit: pool.config.resources?.cpuLimit ?? DEFAULT_POOL_RESOURCES.cpuLimit,
          memoryLimit: pool.config.resources?.memoryLimit ?? DEFAULT_POOL_RESOURCES.memoryLimit,
        };
        assertSafeQuantity(resources.cpu, `pool "${name}" resources.cpu`);
        assertSafeQuantity(resources.memory, `pool "${name}" resources.memory`);
        assertSafeQuantity(resources.cpuLimit, `pool "${name}" resources.cpuLimit`);
        assertSafeQuantity(resources.memoryLimit, `pool "${name}" resources.memoryLimit`);

        const scaling = {
          min: pool.config.scaling?.min ?? DEFAULT_POOL_SCALING.min,
          max: pool.config.scaling?.max ?? DEFAULT_POOL_SCALING.max,
          targetCPU: pool.config.scaling?.targetCPU ?? DEFAULT_POOL_SCALING.targetCPU,
        };
        assertSafeReplicaCount(scaling.min, `pool "${name}" scaling.min`);
        assertSafeReplicaCount(scaling.max, `pool "${name}" scaling.max`);
        assertSafeTargetCPU(scaling.targetCPU, `pool "${name}" scaling.targetCPU`);

        return [
          name,
          {
            image: {
              repository:
                config.containerStrategy === "shared-image" ? "nextjs-app" : `nextjs-app-${name}`,
              // S7. Empty by default and filled in by `deploy` with `--set
              // pools.<pool>.image.digest=sha256:…` once `docker push` has RESOLVED it — the
              // chart is generated by `next build`, which runs before the push, so the digest
              // cannot be known at render time. Declared here so the key always exists and the
              // template's `{{ with … }}` never indexes a missing map.
              digest: "",
            },
            replicas: scaling,
            resources: {
              requests: { cpu: resources.cpu, memory: resources.memory },
              limits: { cpu: resources.cpuLimit, memory: resources.memoryLimit },
            },
            _meta: { outputCount: pool.outputs.length },
          },
        ];
      }),
    ),
    // S7: the routing image takes its digest the same way (`--set
    // routingService.image.digest=…`).
    routingService: { image: { digest: "" } },
    gateway: gke?.gateway ?? {},
    build: {
      id: buildId,
      nextVersion,
      containerStrategy: config.containerStrategy ?? "traced-assets",
    },
    activeBuildId: sanitizeK8sName(buildId),
    activeDefaultPool: defaultPool,
    // GitOps PR2 (§4.2): the cutover-model values gate. "none" (default) keeps today's
    // semantics — selectors render from activeBuildId, promotion is out-of-band. "job"
    // (set by `emit --cutover job`, never by the build) makes the stable Services render
    // their selector from `previousBuildId` below, stamps keep-at-birth annotations on
    // every per-build resource, and renders the in-cluster cutover Job + RBAC +
    // emit-metadata ConfigMap that emit writes into the bundle chart. Always present so
    // templates can gate on `.Values.cutover.mode` without nil-guarding.
    cutover: {
      mode: "none",
      // The in-cluster cutover Job's image (only consumed under mode: job). Emit pins it;
      // the default names the release train's image so a hand-set `mode: job` on an
      // unmodified chart still points somewhere real.
      image: "ghcr.io/next-community/adapter-k8s-cutover:latest",
      // Poison-pill override (design §8 risk 4): re-promote a build the Job previously
      // recorded as FAILED. Off by default; the Job refuses poisoned builds otherwise.
      forcePromotion: false,
    },
    // §4.2 invariant-3 clause: under cutover.mode: job the stable Services' selector
    // renders from THIS value (the previous build), not activeBuildId. Written by emit
    // through sanitizeK8sName exactly like activeBuildId — an unsanitized value drains
    // the Service to zero endpoints. Defaults to the sanitized new build id so a chart
    // applied without emit's pinning (or a genuine first deploy) selects its own pods.
    previousBuildId: sanitizeK8sName(buildId),
    // The previous build's default pool — the origin Service's component selector under
    // cutover.mode: job (pairing previousBuildId with the NEW build's default pool after
    // a pool rename is a selector pair that matches nothing — the emit-metadata
    // previousDefaultPool incident, same shape). Defaults to this build's default pool.
    previousDefaultPool: defaultPool,
    // The path the LOAD BALANCER's HealthCheckPolicy probes on pool backends. Defaults to
    // readiness; `deploy` overrides it to the liveness path for one cycle when the outgoing
    // build may predate /readyz (see AdapterState.readinessPathSupported).
    poolHealthCheckPath: POOL_READINESS_PATH,
  };

  // N68. NO wall-clock stamp here. The header used to carry
  // `# Generated: ${new Date().toISOString()}`, which made two renders of the SAME build
  // byte-different and defeated the only practical audit of invariant 5 ("clean chart
  // regeneration"): diff a regenerated chart against what was applied. Every other
  // build-time timestamp in the repo goes through manifest.ts's stableBuiltAt()
  // (SOURCE_DATE_EPOCH -> .next/BUILD_ID mtime -> now); this line had no such source and
  // no consumer, so it is simply gone rather than plumbed. Don't reintroduce it.
  const header =
    `# Auto-generated by @next-community/adapter-k8s (provider: gke)\n` +
    `# Build ID: ${buildId}\n` +
    `# Next.js: ${nextVersion}\n`;
  return header + JSON.stringify(values, null, 2);
}
