// src/cli/deploy.ts
import path from "node:path";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { infrastructurePath, outputDirName } from "./infrastructure-validation.js";
import {
  chmodSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";
import { execOrThrow, execCapture, EXEC_TIMEOUTS } from "./exec.js";
import { readState, writeState, StateUnavailableError, type AdapterState } from "./state.js";
import { discoverBuildPools, recordedBuildPools } from "./pool-topology.js";
import {
  cleanupRetainedStablePoolResources,
  hasHealthCheckPolicyCrd,
  retainRemovedPoolResources,
} from "./stable-pool-resources.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import { cdnTagForBuildId } from "../cdn-tags.js";
import { retainLiveRoutingManifest, revertRoutingServiceToBuild } from "./rollback.js";
import { POOL_READINESS_PATH } from "../emit/templates/deployment.js";

/**
 * The liveness path, used ONLY as the one-cycle fallback for the stable HealthCheckPolicy when
 * the outgoing build may predate /readyz. Deliberately spelled out here rather than imported
 * from pool-server/server.ts so the CLI does not pull the runtime server into its module graph.
 */
const LIVENESS_PATH_FOR_MIGRATION = "/healthz";
import { renderService } from "../emit/templates/service.js";
import { renderValkeySecret, VALKEY_SECRET_NAME } from "../emit/templates/valkey-secret.js";
import { provisionMemorystore, buildDeleteMemorystoreCommand } from "./provision-cache.js";
import { isAlreadyGoneError } from "./destroy.js";
import { MIN_GKE_VERSION_FOR_CDN } from "./gke-version.js";
import { routeExtJobName } from "../emit/templates/route-ext-update-job.js";
import {
  ROUTING_MANIFEST_SNAPSHOT_COMPONENT,
  routingManifestSnapshotName,
  routingServiceDeploymentName,
} from "../emit/templates/routing-manifest-configmap.js";
import {
  COMPOSITION_PLAN_COMPONENT,
  compositionPlanConfigMapName,
} from "../emit/templates/composition-plan-configmap.js";
// N87: internal dispatch Secrets are per BUILD and annotated `helm.sh/resource-policy: keep`,
// so deploy owns both halves of their lifecycle — migrating the legacy stable-named one past
// `helm upgrade`, and pruning the ones nothing references any more.
import {
  INTERNAL_SECRET_COMPONENT,
  internalSecretName,
  legacyInternalSecretName,
} from "../emit/templates/internal-secret.js";
// Import the SAME sanitizer that stamps pod names and version labels (deployment.ts /
// service.ts). The blue/green cutover patches the active Service selector to this exact
// value, so it MUST match the pod label byte-for-byte — a divergent local copy that
// omitted the `b-` prefix drained the Service to zero endpoints and 503'd the site.
import { sanitizeK8sName } from "../emit/templates/utils.js";
import {
  ADAPTER_RELEASE_LABEL,
  assertSafeBuildId,
  assertSafePoolName as assertSafePoolNameCharset,
  findBuildTopologyNameCollision,
  findEmittedNameCollision,
  assertSafeImageRegistry,
  assertSafeProbePath,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
  poolResourceNames,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";
import { sanitizeForTerminal } from "./terminal.js";
import { resolveContainerCli, targetPlatform } from "./container-runtime.js";
import {
  DEFAULT_TARGET_PLATFORM,
  parseTargetPlatform,
  type TargetPlatform,
} from "../target-platform.js";
import type { GcloudCommand } from "./init.js";
import type { RegistryAuthentication, RegistryDigestLookup } from "../composition-plan/index.js";
import {
  parsePoolImageLayout,
  SHARED_POOL_IMAGE_LAYOUT,
  type PoolImageLayout,
} from "../pool-image-layout.js";
import {
  assertCompositionPlanInvocation,
  compositionPlanNeedsExplicitConfirmation,
  currentKubeContext,
  loadLocalCompositionPlan,
  preflightCompositionPlan,
  waitForCompositionPlanReadiness,
} from "./composition-plan.js";

/**
 * How long to wait for a Deployment rollout.
 *
 * 120s was arithmetically impossible against the chart's OWN rollout parameters and only ever
 * passed by luck. The emitted Deployments use `maxUnavailable: 0` with `minReadySeconds: 30` and a
 * `preStop: sleep 120` (N63, for load-balancer connection draining), so a 2-replica rollout is
 * strictly serial: each new pod takes ~10s to become ready, +30s before it counts as available,
 * and the old pod it replaces spends 120s in preStop before the next surge can start. That is
 * ~200-320s for two replicas — MEASURED on a 3-node arm64 cluster, where the routing tier
 * reliably tripped the 120s wait while `kubectl rollout status` reported success moments later.
 * GKE dodged it only because its routing Deployment spec is often unchanged between builds.
 *
 * 600s matches the chart's `progressDeadlineSeconds`: that is Kubernetes' own verdict on a stalled
 * rollout, so waiting less rejects a rollout the cluster still considers healthy, and waiting
 * longer outlives the deadline that would mark it Failed.
 */
const KUBECTL_ROLLOUT_TIMEOUT = "--timeout=600s";

export interface DeployOptions {
  projectDir: string;
  releaseName: string;
  skipBuild?: boolean;
  skipPush?: boolean;
  dryRun?: boolean;
  /**
   * Explicit opt-out of the fail-closed NetworkPolicy posture: allow the deploy to
   * proceed WITHOUT pod-CIDR NetworkPolicies when the cluster CIDR can't be discovered.
   * Without this flag a discovery failure aborts the deploy — silently shipping the
   * chart without its network isolation would re-open the in-cluster secret-extraction
   * path the policies close (H1).
   */
  allowNoNetworkPolicy?: boolean;
  /**
   * S23: explicit opt-out of the fail-closed IMAGE INTEGRITY posture — deploy by mutable tag
   * when neither the local daemon nor the registry can pin an image to a digest. Without it
   * an unpinnable image aborts the deploy, because running by tag lets a registry retag
   * change the code on pods that hold the internal dispatch secret and cache credentials.
   */
  allowMutableTags?: boolean;
  /**
   * N30: explicit opt-out of the fail-closed routing-manifest retention posture. Retention
   * copies the OUTGOING build's routing manifest to a build-named snapshot before
   * `helm upgrade` overwrites the stable ConfigMap; a failure permanently destroys the
   * rollback target's manifest (a rollback to it can then only revert the edge IMAGE).
   * Without this flag a retention failure aborts the deploy — same posture as
   * `--allow-no-network-policy`. When passed, the degradation is recorded in deploy state
   * so doctor can report "rollback would be image-only".
   */
  allowUnretainedManifest?: boolean;
  /**
   * N29: skip the interactive confirmation for an UNPINNED kubectl context (mirrors
   * destroy's `--yes`). Required non-interactively when infrastructure.json has no
   * projectId/region, because the whole mutating deploy then runs against whatever
   * context happens to be current.
   */
  yes?: boolean;
}

// N29: same shape as destroy's confirmation prompt (that file's copy is not exported).
function promptConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * N20: recover the build that is ACTUALLY serving when committed deploy state cannot be
 * determined, so a transient state-read failure can never be mistaken for a first deploy
 * (which skips retained-manifest injection — `helm upgrade` then DELETES the serving
 * Deployment — and points `activeBuildId` at a build with zero ready pods).
 *
 * Ground truth is the stable active Service's `app.kubernetes.io/version` SELECTOR: that
 * is what sends traffic somewhere. Discovery is by NAME, not by the
 * `managed-by: adapter-k8s-active` label the template stamps — Helm rewrites that label
 * to `managed-by: Helm` (which is why deploy/rollback patch Services by name), the same
 * approach doctor's active-Service endpoint check uses. The selector holds the SANITIZED
 * build label, which is lossy, so the raw build id comes from the selected Deployment's
 * image TAG (the same technique rollback uses to read what the routing tier serves) and
 * is cross-checked against the label.
 *
 * Throws (never returns a guess) when the cluster cannot be read, when pools disagree, or
 * when the selected build has no Deployment.
 */
export async function discoverServingBuildId(
  releaseName: string,
  configuredNamespace?: string,
): Promise<string> {
  const namespace = resolveK8sNamespace(configuredNamespace);
  const REPAIR =
    `Repair deploy state before deploying: run \`npx adapter-k8s doctor\`, then either ` +
    `restore .k8s-adapter/state.json or fix access to the ${releaseName}-adapter-state ` +
    `ConfigMap in namespace ${namespace}.`;

  const svcResult = await execCapture(
    "kubectl",
    [
      "get",
      "svc",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      "jsonpath={range .items[*]}{.metadata.name}|{.metadata.labels.app\\.kubernetes\\.io/component}|" +
        '{.spec.selector.app\\.kubernetes\\.io/version}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (svcResult.exitCode !== 0) {
    throw new Error(
      `Deploy state could not be determined AND the active Services could not be listed ` +
        `(kubectl exited ${svcResult.exitCode}${svcResult.stderr.trim() ? `: ${svcResult.stderr.trim()}` : ""}). ` +
        `Refusing to deploy: treating this as a first deploy would make helm delete the ` +
        `Deployment that is currently serving traffic. ${REPAIR}`,
    );
  }

  const labels = new Set<string>();
  for (const line of svcResult.stdout.trim().split("\n")) {
    const [name, component, version] = line.split("|");
    if (!name || !component || component === "routing-service") continue;
    // Keep only the STABLE active Services (`<release>-<pool>`); per-build Services
    // (`<release>-<pool>-<build>`) never receive traffic directly.
    if (name !== sanitizeK8sName(`${releaseName}-${component}`)) continue;
    if (version) labels.add(version);
  }
  if (labels.size === 0) {
    throw new Error(
      `Deploy state could not be determined and no active pool Service in namespace ` +
        `${namespace} carries an app.kubernetes.io/version selector, so the live build ` +
        `is unknown. Refusing to deploy as if this were a first deploy. ${REPAIR}`,
    );
  }
  if (labels.size > 1) {
    throw new Error(
      `Deploy state could not be determined and the active pool Services select DIFFERENT ` +
        `builds (${[...labels].join(", ")}) — traffic is already split across builds. ` +
        `Refusing to deploy on top of that. ${REPAIR}`,
    );
  }
  const label = [...labels][0]!;

  const depResult = await execCapture(
    "kubectl",
    [
      "get",
      "deployments",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${label},` +
        `app.kubernetes.io/component!=routing-service`,
      "-o",
      // The build id comes from the pod's own NEXT_BUILD_ID env, not from the image reference:
      // digest-pinned images (S7) render `<registry>/<repo>@sha256:<hex>`, so slicing after the
      // last colon yields the digest hex — per-pool images then disagree and this recovery
      // aborted on every deployment created by the normal path. The image is still read as the
      // pre-digest fallback.
      "jsonpath={range .items[*]}{.metadata.name}|{.spec.template.spec.containers[0].image}|" +
        '{range .spec.template.spec.containers[0].env[?(@.name=="NEXT_BUILD_ID")]}{.value}{end}' +
        '{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (depResult.exitCode !== 0) {
    throw new Error(
      `Deploy state could not be determined and the Deployments for the serving build ` +
        `label "${label}" could not be listed (kubectl exited ${depResult.exitCode}` +
        `${depResult.stderr.trim() ? `: ${depResult.stderr.trim()}` : ""}). ${REPAIR}`,
    );
  }
  const tags = new Set<string>();
  for (const line of depResult.stdout.trim().split("\n")) {
    const [name, image, envBuildId] = line.split("|");
    if (!name || !image) continue;
    // Pre-digest Deployments carry `:<buildId>` and no `@sha256:`; for those the tag IS the
    // build id. A digest reference never falls back to slicing.
    const taggedBuildId =
      image.includes(":") && !image.includes("@sha256:")
        ? image.slice(image.lastIndexOf(":") + 1)
        : "";
    const buildId = envBuildId?.trim() || taggedBuildId;
    if (buildId) tags.add(buildId);
  }
  if (tags.size === 0) {
    throw new Error(
      `The active pool Service(s) select build label "${label}" but NO Deployment carries ` +
        `it (or none carries a recognizable build id), so nothing is serving from the ` +
        `selected build ` +
        `and deploy state is unreadable. The release is already broken — repair it before ` +
        `deploying. ${REPAIR}`,
    );
  }
  if (tags.size > 1) {
    throw new Error(
      `The Deployments selected by build label "${label}" carry different image tags ` +
        `(${[...tags].join(", ")}), so the live build id is ambiguous. ${REPAIR}`,
    );
  }
  const buildId = [...tags][0]!;
  // Validate at the point of consumption: this value is cluster-sourced and goes into
  // helm --set assignments, image tags, and resource names.
  assertSafeBuildId(buildId);
  if (sanitizeK8sName(buildId) !== label) {
    throw new Error(
      `The serving Deployment's build id "${buildId}" (NEXT_BUILD_ID env, or its image tag ` +
        `for a pre-digest Deployment) does not sanitize to the active ` +
        `Service selector "${label}" — the cluster is in an inconsistent state and the live ` +
        `build id cannot be trusted. ${REPAIR}`,
    );
  }
  return buildId;
}

export interface DockerCommandOptions {
  pools: string[];
  buildId: string;
  registry: string;
  outputDir: string;
  containerStrategy: "traced-assets" | "shared-image";
  poolImageLayout?: PoolImageLayout;
  /**
   * S24: which container CLI to shell out to. Defaults to docker for compatibility; the
   * deploy resolves the real one via resolveContainerCli(). Every verb used here — build,
   * push — is accepted identically by podman and nerdctl.
   */
  containerCli?: string;
  /** Platform recorded by the build artifact; never re-infer it from the deploy host. */
  targetPlatform?: TargetPlatform;
  /** Exact authentication operation declared by a composed target. Omitted for legacy builds. */
  registryAuthentication?: RegistryAuthentication;
  /** Portable routing has no routing-service workload or image. */
  includeRoutingService?: boolean;
}

/**
 * Re-stage the build's fetch-cache (`<distDir>/cache/fetch-cache`) into every image build
 * context, right before `docker build`.
 *
 * WHY HERE and not (only) in onBuildComplete: the fetch-cache entries are written
 * ASYNCHRONOUSLY by the static-export workers, and upstream orders nothing between those
 * writes and handleBuildComplete — the workers are only torn down in `next build`'s
 * `finally`, AFTER the adapter hook. Measured 2026-08-04: a local repro build staged the
 * dir fine (the write landed ~750ms before the staging read) while two consecutive harness
 * builds of the same fixture shipped images WITHOUT it — the write lost the race with
 * onBuildComplete's existsSync. Deploy runs minutes after the build, when the artifact is
 * deterministically on disk. The staged copy is REPLACED wholesale so entries deleted from
 * the build's fetch-cache stop shipping (the #32 context-wipe rule).
 *
 * The files matter because `next start`'s filesystem cache starts WITH them: without them a
 * post-revalidateTag FETCH read is a miss, patch-fetch re-fetches under the prerender's
 * abort signal, and the cache-components background revalidation dies under load
 * (rdc stale-forever — see build-seed-index.ts fetchCacheSeed).
 */
export function refreshFetchCacheStaging(
  projectDir: string,
  outputDir: string,
  metadata: {
    distDir?: unknown;
    pools: string[];
    containerStrategy: string;
    poolImageLayout?: unknown;
  },
): void {
  // Validate at the point of consumption: distDir comes from build-metadata.json, which is
  // build-controlled. The same escape S20 rejects at build time is rejected here — the dest
  // is built as `<context>/<distDir>` and a `../` form would land the recursive rm/cp
  // OUTSIDE the build context. Older metadata predates the field; default to .next.
  const distDirRel = typeof metadata.distDir === "string" ? metadata.distDir : ".next";
  if (path.isAbsolute(distDirRel) || distDirRel.split(path.sep).includes("..")) {
    throw new Error(
      `Invalid distDir ${JSON.stringify(distDirRel)} in build-metadata.json: it must be a ` +
        `project-relative path inside the project (S20). Re-run the build.`,
    );
  }
  const poolImageLayout = parsePoolImageLayout(metadata.poolImageLayout);
  if (poolImageLayout === SHARED_POOL_IMAGE_LAYOUT) {
    // An older CLI does not understand the layout: it refreshes every pool delta, then the
    // sentinel FROM fails. A retry with this CLI must remove those seeds because the child
    // COPY overlays its parent and would otherwise shadow every later base refresh.
    for (const pool of metadata.pools) {
      rmSync(path.join(outputDir, "pools", pool, "context", ".k8s-adapter", "fetch-cache-seed"), {
        recursive: true,
        force: true,
      });
    }
  }
  const src = path.join(projectDir, distDirRel, "cache", "fetch-cache");
  // Observable either way (M1 spirit): the silent-return variant of this function cost a
  // debugging round — an image shipped without the files and nothing said which of the two
  // silent paths (no source vs no re-stage) was taken.
  if (!existsSync(src)) {
    console.log(`    (no build fetch-cache at ${src} — nothing to re-stage)`);
    return;
  }
  const contexts =
    metadata.containerStrategy === "shared-image"
      ? [path.join(outputDir, "shared-context")]
      : poolImageLayout === SHARED_POOL_IMAGE_LAYOUT
        ? [path.join(outputDir, "pool-base", "fetch-cache")]
        : metadata.pools.map((pool) => path.join(outputDir, "pools", pool, "context"));
  for (const context of contexts) {
    // A context can legitimately be absent (ADAPTER_K8S_SKIP_STAGING builds have no
    // contexts, and those deploys never reach the docker step anyway).
    if (!existsSync(context)) continue;
    // NOT the runtime location: the pod mounts a writable emptyDir over /app/.next/cache
    // that shadows image content there; the pool server restores this seed at boot
    // (pool-server/fetch-cache-seed.ts).
    const dest = path.join(context, ".k8s-adapter", "fetch-cache-seed");
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, dereference: true });
    console.log(`    Re-staged build fetch-cache into ${path.relative(projectDir, context)}`);
  }
}

export function buildDockerCommands(options: DockerCommandOptions): GcloudCommand[] {
  const { pools, buildId, registry, outputDir, containerStrategy } = options;
  const cli = options.containerCli ?? "docker";
  // S24: pin the build architecture. Without it a host-native build on Apple Silicon
  // produces arm64 images that fail with `exec format error` on GKE's x86 nodes — and only
  // at rollout, not at build time. Never passed to `push`, which has no such flag.
  const platformArg = `--platform=${parseTargetPlatform(
    options.targetPlatform ?? targetPlatform(),
    "Docker target platform",
  )}`;
  const commands: GcloudCommand[] = [];
  const poolImageLayout = parsePoolImageLayout(
    options.poolImageLayout,
    "Docker command poolImageLayout",
  );

  // 0. Registry authentication — ONLY for Google registries.
  //
  // This used to run `gcloud auth configure-docker` for every registry host unconditionally, so
  // a Harbor/ECR/ACR deploy with perfectly good credentials already configured died before it
  // built anything, on a machine that has no reason to have gcloud installed. Registry auth is
  // the registry's business: for anything non-Google we assume the operator's existing
  // credential setup (docker login, ECR credential helper, az acr login, a pull secret) — the
  // same assumption every other tool makes.
  const registryHost = registry.split("/")[0]!;
  const authentication = options.registryAuthentication;
  const shouldConfigureGcloud = authentication
    ? authentication.kind === "gcloud-docker-helper"
    : registryHost.endsWith("-docker.pkg.dev") || /(^|\.)gcr\.io$/.test(registryHost);
  if (
    authentication?.kind === "gcloud-docker-helper" &&
    authentication.registryHost !== registryHost
  ) {
    throw new Error(
      `Composition plan registry authentication names host ` +
        `${JSON.stringify(authentication.registryHost)}, but the image repository uses ` +
        `${JSON.stringify(registryHost)}. Rebuild the target plan.`,
    );
  }
  if (shouldConfigureGcloud) {
    commands.push({
      description: `Configure Docker authentication for ${registryHost}`,
      command: "gcloud",
      args: ["auth", "configure-docker", registryHost, "--quiet"],
    });
  }

  if (containerStrategy === "shared-image") {
    const tag = `${registry}/nextjs-app:${buildId}`;
    commands.push({
      description: `Build shared image`,
      command: cli,
      args: ["build", platformArg, "-t", tag, `${outputDir}/shared-context`],
    });
    commands.push({
      description: `Push shared image`,
      command: cli,
      args: ["push", tag],
    });
  } else {
    let poolBaseTag: string | undefined;
    if (poolImageLayout === SHARED_POOL_IMAGE_LAYOUT) {
      const localTag = createHash("sha256")
        .update(`${registry}\0${buildId}`)
        .digest("hex")
        .slice(0, 24);
      poolBaseTag = `localhost/adapter-k8s-pool-base:${localTag}`;
      commands.push({
        description: "Build shared pool base",
        command: cli,
        args: ["build", platformArg, "-t", poolBaseTag, `${outputDir}/pool-base`],
      });
      commands.push({
        description: "Verify shared pool base is visible in the container CLI image store",
        command: cli,
        args: ["image", "inspect", poolBaseTag],
      });
    }
    for (const pool of pools) {
      const tag = `${registry}/nextjs-app-${pool}:${buildId}`;
      commands.push({
        description: `Build ${pool} image`,
        command: cli,
        args: [
          "build",
          platformArg,
          ...(poolBaseTag ? ["--build-arg", `POOL_BASE_IMAGE=${poolBaseTag}`] : []),
          "-t",
          tag,
          `${outputDir}/pools/${pool}`,
        ],
      });
      commands.push({
        description: `Push ${pool} image`,
        command: cli,
        args: ["push", tag],
      });
    }
  }

  if (options.includeRoutingService !== false) {
    const routingTag = `${registry}/routing-service:${buildId}`;
    commands.push({
      description: "Build routing service image",
      command: cli,
      args: [
        "build",
        platformArg,
        "-f",
        `${outputDir}/routing-service/Dockerfile`,
        "-t",
        routingTag,
        `${outputDir}/routing-service`,
      ],
    });
    commands.push({
      description: "Push routing service image",
      command: cli,
      args: ["push", routingTag],
    });
  }

  return commands;
}

// L15: pool names are read from build-metadata.json and used in chart file paths and
// docker build contexts — a malicious or corrupt name (e.g. "../x") could otherwise
// escape the chart templates directory.
export function assertSafePoolName(poolName: string): void {
  // N61: delegate the CHARSET to the shared validator the templates use, so deploy and
  // emit can never disagree. The local copy was `/^[a-z0-9-]+$/`, which admitted a
  // leading/trailing hyphen (an invalid K8s label value) and the YAML-1.1 boolean names
  // (`on`/`no`/`y`/`off`/`true`) the templates now reject.
  try {
    assertSafePoolNameCharset(poolName);
  } catch (err) {
    throw new Error(
      `${err instanceof Error ? err.message : String(err)} (from build-metadata.json — ` +
        `refusing to use it in file paths.)`,
    );
  }
  // "routing-service" is the reserved routing-tier Deployment name (<release>-routing-service,
  // updated in place per build, verified/reverted separately from pools). A pool with this
  // name would collide with it: readiness checks, cleanup classification, and rollback's
  // edge revert all key off that exact name.
  if (poolName === "routing-service") {
    throw new Error(
      `Invalid pool name "routing-service" in build-metadata.json: reserved for the routing ` +
        `tier (<release>-routing-service). Rename the pool (check the adapter's route ` +
        `classification config) and rebuild.`,
    );
  }
}

/**
 * S7 (SECURITY). Resolve the immutable digest of an image that was just pushed.
 *
 * Images were deployed by MUTABLE tag while the deploy identity holds registry write access —
 * and that identity is assumable by anyone who can create a Pod in the namespace (Workload
 * Identity), while the pods themselves carry INTERNAL_HEADER_SECRET and the cache credentials
 * in env. So a retag of an already-deployed build id silently changed what the pool runs on its
 * next restart or scale-up, turning pod-creation into dispatch-secret theft — and from there
 * into a cluster-wide middleware bypass. The route-ext Job's own image was digest-pinned for
 * exactly this reason; the images holding the secrets were not.
 *
 * `docker inspect` reports RepoDigests only AFTER a successful push (the digest is assigned by
 * the registry), which is why this runs here and not at chart-generation time. Returns null
 * rather than throwing: a resolvable digest is a hardening win, not a reason to fail a deploy
 * on a daemon that reports RepoDigests differently (podman/buildx shims). The caller says so.
 */
/**
 * S23: pin every deployed image to an immutable digest, or refuse the deploy.
 *
 * Two sources, local first (fast, offline) then the registry (authoritative). If an image
 * still cannot be pinned this THROWS, because the alternative — what this used to do — is
 * deploying the mutable `:${buildId}` tag on pods that receive the internal dispatch secret
 * and the cache credentials. A registry writer who retags that tag then changes the code
 * running on the next pod start or scale-up, which is exactly the escalation the split
 * `<release>-cli` identity exists to prevent (it is deliberately writer, not repoAdmin, for
 * this reason). Degrading to that silently on a `docker inspect` quirk gives the quirk the
 * same effect as the attack.
 *
 * `--allow-mutable-tags` is the explicit opt-out, mirroring `--allow-no-network-policy`:
 * fail-closed by default, and an operator who really wants it has to say so.
 */
export async function resolveDeployImageDigests(opts: {
  refs: Array<[string, string]>;
  projectId: string;
  allowMutableTags?: boolean;
  containerCli?: string;
  targetPlatform?: TargetPlatform;
  digestLookup?: RegistryDigestLookup;
}): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const unresolved: string[] = [];
  const cliLabel = opts.containerCli ?? "docker";
  const platform = parseTargetPlatform(
    opts.targetPlatform ?? targetPlatform(),
    "image digest target platform",
  );
  for (const [key, ref] of opts.refs) {
    // S25: REGISTRY FIRST. kubelet pulls from the registry, so the registry's digest is the
    // only one that can actually be deployed. The local daemon merely usually agrees —
    // MEASURED with podman 6.0.1, it does not: podman converts the manifest on push, so its
    // RepoDigest describes the local copy and pointing a Deployment at it yields
    // ImagePullBackOff (observed live: podman said e04a0a5b…, the registry held 27fa476b…,
    // and the rollout failed). The local probe stays as the offline/unreachable fallback.
    // REGISTRY FIRST, on ANY registry (S25/S28). kubelet pulls from the registry, so only the
    // registry's digest can actually be deployed; the local daemon merely usually agrees, and
    // podman measurably does not. Artifact Registry is asked through gcloud (proven, and works
    // with the credential helper); everything else through crane/skopeo/docker-manifest.
    const cli = opts.containerCli ?? "docker";
    // The local daemon is the LAST resort, and only for docker. MEASURED with podman 6.0.1:
    // its RepoDigest matched the registry for one image and differed for another, because push
    // can rewrite the manifest. An unreliable digest is worse than none — it deploys and then
    // ImagePullBackOffs at rollout, after cutover has started, whereas refusing fails at deploy
    // time with something actionable.
    const artifactRegistryProject =
      opts.digestLookup?.kind === "gcp-artifact-registry"
        ? opts.digestLookup.projectId
        : opts.digestLookup?.kind === "oci-distribution"
          ? null
          : opts.projectId;
    // Single-flight for the crane/skopeo/docker-manifest chain: resolveRegistryDigest ends
    // by running it, and the `??` fallback used to run the IDENTICAL chain a second time
    // whenever the first came back null — doubled subprocess latency on exactly the slow
    // path (no crane/skopeo installed). Memoizing keeps the gcloud-failed case (where the
    // chain has NOT run yet) probing exactly once.
    let anyProbePromise: Promise<string | null> | undefined;
    const probeAny = () => (anyProbePromise ??= resolveRegistryDigestAny(ref, cli, platform));
    const digest =
      (artifactRegistryProject !== null
        ? await resolveRegistryDigest(ref, artifactRegistryProject, platform, cli, probeAny)
        : null) ??
      (await probeAny()) ??
      (cli === "docker" ? await resolveImageDigest(ref, cli, platform) : null);
    if (digest) digests[key] = digest;
    else unresolved.push(ref);
  }
  if (unresolved.length > 0) {
    if (!opts.allowMutableTags) {
      throw new Error(
        `Could not resolve an immutable digest for: ${unresolved.join(", ")}. No registry probe ` +
          `could pin these images, so deploying would run them by TAG — a retag would change ` +
          `what runs on the next pod start, on pods that hold the internal dispatch secret and ` +
          `cache credentials. Refusing to deploy without image integrity.\n` +
          `Fix registry access for a platform-aware client (\`crane\`, \`skopeo\`, or ` +
          `\`docker manifest inspect\`). An Artifact Registry summary digest alone is not ` +
          `enough because it may name an index with no ${platform} child.\n` +
          `Note: the local ${cliLabel} daemon is only trusted as a digest source for docker — ` +
          `podman rewrites manifests on push, so its local digest can differ from the registry's ` +
          `and deploying it fails at rollout. Pass --allow-mutable-tags to deploy anyway.`,
      );
    }
    console.warn(
      `\n  ! Could not resolve an immutable digest for: ${unresolved.join(", ")}.\n` +
        `    Deploying these by TAG (--allow-mutable-tags), so a retag would change what runs ` +
        `on the next pod start.`,
    );
  }
  return digests;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/**
 * S28: resolve an image's digest from ANY registry — ECR, ACR, Harbor, Docker Hub, or a
 * self-hosted one.
 *
 * `resolveRegistryDigest` below speaks only to Artifact Registry via gcloud, so every non-GCP
 * registry fell through to the LOCAL daemon. That is the exact path podman gets wrong: its
 * `RepoDigest` describes the local copy, and podman rewrites the manifest on push, so deploying
 * that value yields ImagePullBackOff (measured: podman said e04a0a5b…, the registry held
 * 27fa476b…). Shipping EKS/AKS on the local-daemon fallback would inherit a known-broken path.
 *
 * Probe order, first platform-validated answer wins:
 *  1. `crane manifest/config/digest` — inspect the index or single-image config before digest.
 *  2. `skopeo inspect --override-*` — require its selected image to report the target platform.
 *  3. `docker manifest inspect -v` — needs NO extra tooling, and VERIFIED against Artifact
 *     Registry to report a digest byte-identical to `gcloud artifacts docker images describe`.
 *     Docker-only: nerdctl has no such subcommand, and podman's `manifest inspect` operates on
 *     manifest lists it manages locally rather than querying a remote registry.
 *
 * Returns null (never throws) so the caller owns the fail-closed decision.
 */
export async function resolveRegistryDigestAny(
  imageRef: string,
  containerCli: string,
  platform: TargetPlatform = targetPlatform(),
): Promise<string | null> {
  const safePlatform = parseTargetPlatform(platform, "registry digest target platform");
  const [targetOs, targetArch, targetVariant] = safePlatform.split("/");
  const matches = (candidate: {
    os?: string | undefined;
    architecture?: string | undefined;
    variant?: string | undefined;
  }) =>
    candidate.os === targetOs &&
    candidate.architecture === targetArch &&
    (candidate.variant ?? undefined) === (targetVariant ?? undefined);

  const craneManifest = await execCapture("crane", ["manifest", imageRef], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (craneManifest?.exitCode === 0) {
    try {
      const manifest = JSON.parse(craneManifest.stdout) as {
        manifests?: Array<{
          digest?: string;
          platform?: { os?: string; architecture?: string; variant?: string };
        }>;
      };
      if (Array.isArray(manifest.manifests)) {
        const child = manifest.manifests.find((entry) => entry.platform && matches(entry.platform));
        return child?.digest && DIGEST_RE.test(child.digest) ? child.digest : null;
      }

      // A single-image manifest has no platform field. Its config is the authoritative OS/arch.
      const config = await execCapture("crane", ["config", imageRef], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
      if (config?.exitCode !== 0) return null;
      const imageConfig = JSON.parse(config.stdout) as {
        os?: string;
        architecture?: string;
        variant?: string;
      };
      if (!matches(imageConfig)) return null;
      const digest = await execCapture("crane", ["digest", imageRef], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
      const value = digest?.stdout.trim() ?? "";
      return digest?.exitCode === 0 && DIGEST_RE.test(value) ? value : null;
    } catch {
      // Malformed output is not proof of a platform; try the next independent probe.
    }
  }

  const skopeoArgs = [
    "inspect",
    "--override-os",
    targetOs!,
    "--override-arch",
    targetArch!,
    ...(targetVariant ? ["--override-variant", targetVariant] : []),
    `docker://${imageRef}`,
  ];
  const skopeo = await execCapture("skopeo", skopeoArgs, {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (skopeo?.exitCode === 0) {
    try {
      const inspected = JSON.parse(skopeo.stdout) as {
        Digest?: string;
        Os?: string;
        Architecture?: string;
        Variant?: string;
      };
      if (
        !matches({
          os: inspected.Os,
          architecture: inspected.Architecture,
          variant: inspected.Variant,
        })
      ) {
        return null;
      }
      return inspected.Digest && DIGEST_RE.test(inspected.Digest) ? inspected.Digest : null;
    } catch {
      // Try docker's registry view when skopeo did not return usable JSON.
    }
  }

  if (containerCli === "docker") {
    const res = await execCapture("docker", ["manifest", "inspect", "-v", imageRef], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    }).catch(() => null);
    if (res?.exitCode === 0) {
      try {
        const parsed: unknown = JSON.parse(res.stdout);
        // A SINGLE manifest comes back as one object carrying Descriptor.digest — that is the
        // digest to deploy, and it is the case verified against Artifact Registry.
        //
        // A manifest LIST (multi-arch) comes back as an ARRAY of per-platform entries. Taking
        // element [0] is WRONG: the order is the registry's, so an ARM-first list would pin the
        // arm64 child and the pods would die with `exec format error` on x86 nodes. The child's
        // digest is also not the digest of the index the tag points at. Since the platform we
        // deploy is fixed (see targetPlatform()), select the matching child explicitly and
        // refuse rather than guess when it is absent.
        if (Array.isArray(parsed)) {
          const match = parsed.find((entry) => {
            const p = (
              entry as {
                Descriptor?: {
                  platform?: { os?: string; architecture?: string; variant?: string };
                };
              }
            ).Descriptor?.platform;
            return !!p && matches(p);
          });
          const d = (match as { Descriptor?: { digest?: string } } | undefined)?.Descriptor?.digest;
          if (typeof d === "string" && DIGEST_RE.test(d)) return d;
          // No child for the platform we deploy: fall through to null so the caller fails
          // closed rather than pinning an image that cannot run.
          return null;
        }
        const descriptor = (
          parsed as {
            Descriptor?: {
              digest?: string;
              platform?: { os?: string; architecture?: string; variant?: string };
            };
          }
        )?.Descriptor;
        if (
          descriptor?.platform &&
          matches(descriptor.platform) &&
          typeof descriptor.digest === "string" &&
          DIGEST_RE.test(descriptor.digest)
        ) {
          return descriptor.digest;
        }
      } catch {
        // Unparseable output is not a digest; fall through to null.
      }
    }
  }

  return null;
}

/**
 * S23: resolve an image's digest from the REGISTRY, which is authoritative.
 *
 * `resolveImageDigest` below asks the local docker daemon, and that only knows a RepoDigest
 * when the push went through it — podman, buildx with certain drivers, or an image pushed by
 * something else all leave it empty. That used to degrade the deploy to a MUTABLE tag on pods
 * holding the internal dispatch secret, i.e. an ordinary tooling quirk quietly removed image
 * integrity. The image was just pushed, so ask the registry instead.
 *
 * VERIFIED live: `gcloud artifacts docker images describe` returned a byte-identical sha256 to
 * `docker inspect` for the same reference.
 *
 * Returns null (never throws) so the caller owns the fail-closed decision.
 */
export async function resolveRegistryDigest(
  imageRef: string,
  projectId: string,
  platform: TargetPlatform = targetPlatform(),
  containerCli: string = "docker",
  // Injectable so a caller that ALSO falls back to resolveRegistryDigestAny can share one
  // memoized probe instead of running the whole crane/skopeo/docker chain twice.
  probeAny: () => Promise<string | null> = () =>
    resolveRegistryDigestAny(imageRef, containerCli, platform),
): Promise<string | null> {
  // Artifact Registry only. Without a GCP project there is nothing to ask. The summary is a
  // useful authoritative existence/digest check, but it is never sufficient by itself because
  // an index digest does not prove that the requested platform is present.
  if (!projectId) return null;
  const res = await execCapture(
    "gcloud",
    [
      "artifacts",
      "docker",
      "images",
      "describe",
      imageRef,
      "--format=value(image_summary.digest)",
      `--project=${projectId}`,
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0) return null;
  const digest = res.stdout.trim();
  // Validated at the point of consumption: this string reaches a helm --set and then the pod
  // spec's image reference.
  if (!DIGEST_RE.test(digest)) return null;
  // Artifact Registry's summary digest can name an OCI INDEX and says nothing about which
  // children it contains. Never return it directly: a requested arm64 deploy previously
  // accepted an amd64-only index here before any platform-aware probe ran.
  return probeAny();
}

export async function resolveImageDigest(
  imageRef: string,
  containerCli: string = "docker",
  platform: TargetPlatform = targetPlatform(),
): Promise<string | null> {
  // ALL RepoDigests, not just index 0: they belong to the image ID, and one local image tagged
  // and pushed to more than one repository carries an entry per repository. Taking the first and
  // pairing its digest with THIS repository could reference a manifest that does not exist
  // there, leaving the new pods in ImagePullBackOff. Select the entry whose repository matches.
  // podman and nerdctl both implement `inspect --format` with the same Go template fields.
  const safePlatform = parseTargetPlatform(platform, "local image target platform");
  const res = await execCapture(
    containerCli,
    [
      "inspect",
      "--format",
      "{{.Os}}/{{.Architecture}}\n{{range .RepoDigests}}{{println .}}{{end}}",
      imageRef,
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (res.exitCode !== 0) return null;
  const [reportedPlatform, ...digestLines] = res.stdout.split("\n");
  if (reportedPlatform?.trim() !== safePlatform) return null;
  // The repository is the reference without its tag — `registry/host/repo:tag` → `…/repo`.
  // (A digest never appears here: this is the tag we just pushed.)
  const colon = imageRef.lastIndexOf(":");
  const slash = imageRef.lastIndexOf("/");
  const repository = colon > slash ? imageRef.slice(0, colon) : imageRef;
  const entries = digestLines.map((l) => l.trim()).filter(Boolean);
  for (const entry of entries) {
    const at = entry.lastIndexOf("@");
    if (at === -1) continue;
    if (entry.slice(0, at) !== repository) continue;
    const digest = entry.slice(at + 1);
    if (/^sha256:[a-f0-9]{64}$/.test(digest)) return digest;
  }
  return null;
}

export type HelmUpgradeMode = "client-side" | "server-side";

function helmHelpHasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Cobra renders options on their own indented rows. Do not accept a flag merely mentioned
  // in a warning or description: a Helm wrapper saying it *does not support* --server-side
  // must never make us construct an argv containing that flag.
  return new RegExp(
    `^[ \\t]*(?:-\\S+,[ \\t]+)?${escaped}(?:(?:[ \\t]+\\S+)?[ \\t]{2,}\\S.*)$`,
    "m",
  ).test(help);
}

/**
 * Select the strongest Helm upgrade mode this installation supports without turning a
 * Helm 3 deployment into an invalid Helm 4 command.
 *
 * Helm 3.2 introduced `--create-namespace`, the oldest Helm capability this deploy argv
 * requires. Helm 4 introduced `--server-side` and `--force-conflicts`; those two are an
 * optional apply implementation, not a reason to reject an otherwise capable installation.
 * Probe Cobra's own option rows rather than parsing a version string so downstream builds
 * remain compatible without treating flags mentioned only in prose as capabilities.
 */
export async function detectHelmUpgradeMode(): Promise<HelmUpgradeMode> {
  let result: Awaited<ReturnType<typeof execCapture>>;
  try {
    result = await execCapture("helm", ["upgrade", "--help"], { timeoutMs: EXEC_TIMEOUTS.kubectl });
  } catch (err) {
    throw new Error(
      `Could not inspect Helm upgrade capabilities: ${err instanceof Error ? err.message : String(err)}. ` +
        `Install Helm 3.2 or newer and re-run deploy.`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = sanitizeForTerminal((result.stderr || result.stdout).trim());
    throw new Error(
      `Could not inspect Helm upgrade capabilities (helm upgrade --help exited ` +
        `${result.exitCode}${detail ? `: ${detail}` : ""}). Install Helm 3.2 or newer and ` +
        `re-run deploy.`,
    );
  }

  const help = `${result.stdout}\n${result.stderr}`;
  if (!helmHelpHasFlag(help, "--create-namespace")) {
    throw new Error(
      `This Helm installation does not support --create-namespace. The adapter requires ` +
        `Helm 3.2 or newer. Upgrade Helm and re-run deploy.`,
    );
  }

  // These flags are a pair: --force-conflicts is valid only with server-side apply. If a
  // downstream Helm build exposes only one, use its portable client-side upgrade instead
  // of constructing an argv that the CLI cannot honor safely.
  const serverSide = helmHelpHasFlag(help, "--server-side");
  const forceConflicts = helmHelpHasFlag(help, "--force-conflicts");
  return serverSide && forceConflicts ? "server-side" : "client-side";
}

export type ValkeySecretOwnership = "absent" | "owned" | "adopted";

/**
 * Migrate only the exact legacy Valkey Secret that adapter versions before Helm ownership
 * created with `kubectl apply`. Helm's `--take-ownership` applies release-wide and can steal any
 * colliding object, so it must never be used for this one-resource migration.
 *
 * The old rendered Secret has a stable identity we can prove without reading its credential
 * data: exact name, type Opaque, and the release/component labels below. Adoption is permitted
 * only when all three Helm ownership fields are absent. Partial or foreign ownership is an
 * abort, not something `--overwrite` may repair. The single merge patch makes the transition
 * atomic; if Helm later fails, a retry sees the complete current-release ownership tuple.
 */
export async function ensureValkeySecretHelmOwnership(
  releaseName: string,
  configuredNamespace?: string,
): Promise<ValkeySecretOwnership> {
  assertSafeReleaseName(releaseName);
  const namespace = resolveK8sNamespace(configuredNamespace);
  const secretName = `${releaseName}-${VALKEY_SECRET_NAME}`;
  const result = await execCapture(
    "kubectl",
    [
      "get",
      "secret",
      secretName,
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "jsonpath={.metadata.name}|{.type}|{.metadata.labels.app\\.kubernetes\\.io/name}|" +
        "{.metadata.labels.app\\.kubernetes\\.io/component}|" +
        "{.metadata.labels.app\\.kubernetes\\.io/managed-by}|" +
        "{.metadata.annotations.meta\\.helm\\.sh/release-name}|" +
        "{.metadata.annotations.meta\\.helm\\.sh/release-namespace}|" +
        "{.metadata.resourceVersion}",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (result.exitCode !== 0) {
    const detail = sanitizeForTerminal(result.stderr.trim());
    throw new Error(
      `Could not inspect cache Secret ${secretName} before Helm upgrade (kubectl exited ` +
        `${result.exitCode}${detail ? `: ${detail}` : ""}). Refusing to guess whether it is ` +
        `safe to adopt.`,
    );
  }

  const line = result.stdout.trim();
  if (!line) return "absent";
  const fields = line.split("|");
  if (fields.length !== 8) {
    throw new Error(
      `Could not validate cache Secret ${secretName}: kubectl returned an unexpected identity ` +
        `shape. Refusing to adopt it.`,
    );
  }
  const [name, type, appName, component, managedBy, ownerRelease, ownerNamespace, resourceVersion] =
    fields;
  const identityMatches =
    name === secretName &&
    type === "Opaque" &&
    appName === releaseName &&
    component === "valkey-secret";
  const ownedByThisRelease =
    managedBy === "Helm" && ownerRelease === releaseName && ownerNamespace === namespace;
  if (ownedByThisRelease) {
    if (!identityMatches) {
      throw new Error(
        `Cache Secret ${secretName} has this release's Helm ownership metadata but does not ` +
          `match the adapter's Valkey Secret identity (expected type Opaque and labels ` +
          `app.kubernetes.io/name=${releaseName}, app.kubernetes.io/component=valkey-secret). ` +
          `Refusing to deploy over it.`,
      );
    }
    return "owned";
  }

  if (managedBy || ownerRelease || ownerNamespace) {
    const ownership = sanitizeForTerminal(
      JSON.stringify({ managedBy, release: ownerRelease, namespace: ownerNamespace }),
    );
    throw new Error(
      `Cache Secret ${secretName} has foreign or incomplete ownership metadata ` +
        `${ownership}. Refusing to adopt it.`,
    );
  }
  if (!identityMatches) {
    throw new Error(
      `An unowned Secret named ${secretName} exists but is not the adapter's legacy Valkey ` +
        `Secret (expected type Opaque and labels app.kubernetes.io/name=${releaseName}, ` +
        `app.kubernetes.io/component=valkey-secret). Refusing to adopt it.`,
    );
  }
  if (!resourceVersion) {
    throw new Error(
      `Could not validate cache Secret ${secretName}: kubectl returned no resourceVersion. ` +
        `Refusing an adoption patch without an optimistic-concurrency precondition.`,
    );
  }

  const ownershipPatch = JSON.stringify({
    metadata: {
      // Prevent a get→patch race from overwriting ownership or identity changed after the
      // validation above. Kubernetes rejects a stale resourceVersion with Conflict.
      resourceVersion,
      labels: { "app.kubernetes.io/managed-by": "Helm" },
      annotations: {
        "meta.helm.sh/release-name": releaseName,
        "meta.helm.sh/release-namespace": namespace,
      },
    },
  });
  const patched = await execCapture(
    "kubectl",
    [
      "patch",
      "secret",
      secretName,
      "-n",
      namespace,
      "--type=merge",
      "--field-manager=adapter-k8s-legacy-adoption",
      "-p",
      ownershipPatch,
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (patched.exitCode !== 0) {
    const detail = sanitizeForTerminal(patched.stderr.trim());
    throw new Error(
      `Could not attach Helm ownership to validated legacy cache Secret ${secretName} ` +
        `(kubectl exited ${patched.exitCode}${detail ? `: ${detail}` : ""}). Aborting before ` +
        `Helm upgrade.`,
    );
  }
  return "adopted";
}

export function buildHelmUpgradeArgs(options: {
  releaseName: string;
  chartPath: string;
  buildId: string;
  registry: string;
  previousBuildId: string | null;
  defaultPool?: string;
  previousDefaultPool?: string;
  namespace?: string;
  overridesFile?: string;
  podCidrs?: string | null;
  /** S22: node/subnet range(s) for the strict posture's kubelet allowance. */
  nodeCidrs?: string | null;
  /** S7: `<pool>` → `sha256:…`, plus the reserved key `routingService`. */
  imageDigests?: Record<string, string>;
  /**
   * Probe path for the pools' stable HealthCheckPolicy. Omitted ⇒ the chart default
   * (readiness). Set to the LIVENESS path for one cycle when the outgoing build may predate
   * /readyz — see AdapterState.readinessPathSupported.
   */
  poolHealthCheckPath?: string;
  /** Determined from `helm upgrade --help`; defaults to the historical Helm 4 behavior. */
  helmUpgradeMode?: HelmUpgradeMode;
}): string[] {
  const {
    releaseName,
    chartPath,
    buildId,
    registry,
    previousBuildId,
    defaultPool,
    previousDefaultPool,
    namespace: configuredNamespace,
    overridesFile,
    podCidrs,
    nodeCidrs,
    imageDigests,
    poolHealthCheckPath,
    helmUpgradeMode = "server-side",
  } = options;
  const namespace = resolveK8sNamespace(configuredNamespace);
  // H2: these values land in `helm --set` assignments — reject helm metacharacters
  // (","  "\"  quotes) before they can split one assignment into several. The buildId
  // comes from generateBuildId()/git refs and the registry from infrastructure.json.
  assertSafeBuildId(buildId);
  assertSafeImageRegistry(registry);
  if (previousBuildId) assertSafeBuildId(previousBuildId);
  if (defaultPool !== undefined) assertSafePoolName(defaultPool);
  if (previousDefaultPool !== undefined) assertSafePoolName(previousDefaultPool);
  const args = [
    "upgrade",
    "--install",
    releaseName,
    chartPath,
    ...(helmUpgradeMode === "server-side" ? ["--server-side=true", "--force-conflicts"] : []),
    // The release lives in the namespace init binds Workload Identity to — pin it rather
    // than installing into whatever namespace the operator's context happens to have.
    "--namespace",
    namespace,
    "--create-namespace",
    "--set",
    `global.image.tag=${buildId}`,
    "--set",
    `global.image.registry=${registry}`,
    "--set",
    `build.id=${buildId}`,
    "--set",
    `activeBuildId=${sanitizeK8sName(previousBuildId ?? buildId)}`,
  ];

  if (defaultPool !== undefined) {
    args.push("--set", `activeDefaultPool=${previousDefaultPool ?? defaultPool}`);
  }

  if (poolHealthCheckPath !== undefined) {
    // Validated at the consumption point like every other --set value; it also lands in a bare
    // YAML scalar inside the rendered HealthCheckPolicy.
    assertSafeProbePath(poolHealthCheckPath, "poolHealthCheckPath");
    args.push("--set", `poolHealthCheckPath=${poolHealthCheckPath}`);
  }

  // S7: pin every image this deploy pushed to its immutable digest. Validated here for the
  // same reason as buildId/registry above — these land in `helm --set` assignments, and the
  // charset check is what keeps one assignment from splitting into several.
  for (const [key, digest] of Object.entries(imageDigests ?? {})) {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
      throw new Error(
        `Invalid image digest for "${key}": ${JSON.stringify(digest)} — expected sha256:<64 hex>.`,
      );
    }
    if (key === "routingService") {
      args.push("--set", `routingService.image.digest=${digest}`);
    } else {
      assertSafePoolName(key);
      args.push("--set", `pools.${key}.image.digest=${digest}`);
    }
  }

  if (previousBuildId) {
    args.push("--set", `previousBuildId=${previousBuildId}`);
  }

  // NetworkPolicy interface with the chart: discovered cluster pod CIDR(s), passed as a
  // helm brace list (CIDRs contain no commas, so no escaping needed).
  if (podCidrs) {
    args.push("--set", `global.networkPolicy.podCidrs={${podCidrs}}`);
  }
  // S22: the strict posture's kubelet allowance. Same brace-list shape.
  if (nodeCidrs) {
    args.push("--set", `global.networkPolicy.nodeCidrs={${nodeCidrs}}`);
  } else {
    // values.yaml defaults `strict: true`, and the chart `fail`s at RENDER time when strict
    // is on without nodeCidrs (VERIFIED against real helm: an empty list is falsy, so
    // `and .strict (not .nodeCidrs)` fires). The only way to get here is the opt-out —
    // discovery returned null under --allow-no-network-policy — and that flag promises a
    // deploy WITHOUT policies, not a hard failure. So turn strict off explicitly, which
    // (with podCidrs also absent) leaves the outer guard rendering nothing at all.
    args.push("--set", "global.networkPolicy.strict=false");
  }

  if (overridesFile && existsSync(overridesFile)) {
    args.push("-f", overridesFile);
  }

  return args;
}

/**
 * Discover the cluster's pod CIDR for the chart-rendered NetworkPolicies. FAIL-CLOSED:
 * the helm `podCidrs` guard renders NO policy when the value is absent, so a failed or
 * malformed lookup throws (the NetworkPolicies are what close in-cluster access to the
 * routing service's dispatch secret, H1) — unless the operator explicitly opts out with
 * `--allow-no-network-policy`, in which case this warns loudly and returns null.
 */
export async function discoverClusterPodCidr({
  clusterName,
  region,
  projectId,
  allowNoNetworkPolicy = false,
}: {
  clusterName: string;
  region: string;
  projectId: string;
  allowNoNetworkPolicy?: boolean;
}): Promise<string | null> {
  const cidrResult = await execCapture(
    "gcloud",
    [
      "container",
      "clusters",
      "describe",
      clusterName,
      "--region",
      region,
      "--project",
      projectId,
      "--format=value(clusterIpv4Cidr)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  const discovered = cidrResult.exitCode === 0 ? cidrResult.stdout.trim() : "";
  if (CIDR_LIST_RE.test(discovered)) return discovered;

  if (allowNoNetworkPolicy) {
    console.warn(
      "  ! Could not discover the cluster pod CIDR — continuing WITHOUT NetworkPolicies " +
        "(--allow-no-network-policy). The routing service is reachable from any in-cluster " +
        "pod; re-run without the flag once the cluster is describable.",
    );
    return null;
  }
  throw new Error(
    `Could not discover the pod CIDR for cluster "${clusterName}" ` +
      `(gcloud exited ${cidrResult.exitCode}${discovered ? `, unexpected value ${JSON.stringify(discovered)}` : ", empty output"}). ` +
      `The chart's NetworkPolicies require it; refusing to deploy without network isolation. ` +
      `Fix cluster access, or pass --allow-no-network-policy to explicitly deploy without them.`,
  );
}

/** One or more comma-separated IPv4 CIDRs — anything else would corrupt the helm list. */
const CIDR_LIST_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}(,(\d{1,3}\.){3}\d{1,3}\/\d{1,2})*$/;

/**
 * S27: node ranges from the KUBERNETES API, for clusters with no cloud to ask.
 *
 * `discoverClusterNodeCidrs` below asks gcloud for the cluster's subnetwork, which a K3s,
 * kind or on-prem cluster does not have — so the strict NetworkPolicy posture was simply
 * unavailable there and the dataplane stayed on the broad `0.0.0.0/0 except pods` denylist.
 * That matters because the routing tier's ext_proc reply carries the internal dispatch secret.
 *
 * Node addresses are exact (`/32`) rather than a subnet: the API reports the addresses the
 * kubelets actually have, which is tighter than the enclosing range and needs no cloud
 * metadata. The trade is that adding a node requires a redeploy to admit it — acceptable, and
 * failing CLOSED (a new node's probes are denied until then) is the right direction for a
 * control whose job is to bound who can reach the dispatch secret.
 *
 * Returns null on any failure so the caller owns the fail-closed decision.
 */
export async function discoverNodeCidrsFromCluster(): Promise<string | null> {
  const res = await execCapture(
    "kubectl",
    [
      "get",
      "nodes",
      "-o",
      "jsonpath={range .items[*]}{.status.addresses[?(@.type=='InternalIP')].address}{'\\n'}{end}",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  ).catch(() => null);
  if (!res || res.exitCode !== 0) return null;

  const seen: string[] = [];
  for (const line of res.stdout.split("\n")) {
    // A node with MORE THAN ONE InternalIP (dual-stack, multi-NIC) puts them all on one
    // jsonpath line separated by spaces. Splitting per-address is required: treating the line
    // as a single value rejected the whole cluster, which silently pushed the deploy onto the
    // broad posture on exactly the clusters most likely to be dual-stack.
    for (const raw of line.trim().split(/\s+/)) {
      const ip = raw.trim();
      if (!ip) continue;
      // Validated at the point of consumption: these reach a helm --set brace list.
      // IPv6 gets /128 — rejecting it outright meant a dual-stack node denied its own kubelet.
      const isV4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
      const isV6 = /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":");
      if (!isV4 && !isV6) return null;
      const cidr = isV4 ? `${ip}/32` : `${ip}/128`;
      if (!seen.includes(cidr)) seen.push(cidr);
    }
  }
  return seen.length > 0 ? seen.join(",") : null;
}

/** Discover the pod CIDRs declared by the Kubernetes Nodes, without assuming a cloud provider. */
export async function discoverPodCidrsFromCluster(): Promise<string | null> {
  const result = await execCapture("kubectl", ["get", "nodes", "-o", "json"], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  let object: { items?: Array<{ spec?: { podCIDR?: unknown; podCIDRs?: unknown } }> };
  try {
    object = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const cidrs: string[] = [];
  for (const node of object.items ?? []) {
    const candidates = Array.isArray(node.spec?.podCIDRs)
      ? node.spec.podCIDRs
      : node.spec?.podCIDR !== undefined
        ? [node.spec.podCIDR]
        : [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") return null;
      const [address, prefix, extra] = candidate.split("/");
      const family = address ? isIP(address) : 0;
      const bits = Number(prefix);
      if (
        extra !== undefined ||
        family === 0 ||
        !Number.isInteger(bits) ||
        bits < 0 ||
        (family === 4 && bits > 32) ||
        (family === 6 && bits > 128)
      ) {
        return null;
      }
      if (!cidrs.includes(candidate)) cidrs.push(candidate);
    }
  }
  return cidrs.length > 0 ? cidrs.join(",") : null;
}

/**
 * S22: discover the range(s) the cluster's NODES draw their IPs from, for the strict
 * NetworkPolicy posture's kubelet allowance. Same fail-closed contract as
 * `discoverClusterPodCidr`.
 *
 * Node IPs come from the cluster subnetwork's PRIMARY range — NOT from `clusterIpv4Cidr`,
 * which is the pods' secondary range. VERIFIED against a live Autopilot cluster: subnetwork
 * `default` → `10.128.0.0/20` with nodes at `10.128.15.211/215/216`, while pods sat at
 * `10.17.0.x` inside `clusterIpv4Cidr` `10.17.0.0/17`. So it takes two lookups: the cluster
 * resource names its subnet but does not carry that subnet's range.
 *
 * Standard clusters may additionally attach node pools to their OWN subnets, so those are
 * unioned in. That enumeration is best-effort on purpose: MEASURED on Autopilot, `gcloud
 * container node-pools list` exits non-zero with "Autopilot node pools cannot be accessed or
 * modified", and Autopilot runs every node in the cluster subnetwork anyway — so a failure
 * there must not be fatal when the cluster subnet already resolved.
 *
 * Getting this WRONG is not silent: under Calico an allowlist missing the kubelet's source
 * range leaves every pod permanently unready, which fails the deploy loudly at rollout. That
 * is the right direction to fail, but it is still a broken deploy — hence fail-closed here
 * rather than a guess.
 */
export async function discoverClusterNodeCidrs({
  clusterName,
  region,
  projectId,
  allowNoNetworkPolicy = false,
}: {
  clusterName: string;
  region: string;
  projectId: string;
  allowNoNetworkPolicy?: boolean;
}): Promise<string | null> {
  const bail = (detail: string): null => {
    if (allowNoNetworkPolicy) {
      console.warn(
        `  ! Could not discover the cluster node range (${detail}) — continuing WITHOUT ` +
          `NetworkPolicies (--allow-no-network-policy). The routing service is reachable ` +
          `from any in-cluster pod AND from any VPC peer, which means the internal dispatch ` +
          `secret can be read out of its ext_proc response and replayed to a pool to bypass ` +
          `middleware; re-run without the flag once the cluster is describable.`,
      );
      return null;
    }
    throw new Error(
      `Could not discover the node range for cluster "${clusterName}" (${detail}). The ` +
        `chart's strict NetworkPolicies require it — kubelet's liveness/readiness probes ` +
        `come from the NODE ip, and an allowlist without it leaves every pod unready — so ` +
        `refusing to deploy without network isolation. Fix cluster access, or pass ` +
        `--allow-no-network-policy to explicitly deploy without them.`,
    );
  };

  const subnetResult = await execCapture(
    "gcloud",
    [
      "container",
      "clusters",
      "describe",
      clusterName,
      "--region",
      region,
      "--project",
      projectId,
      "--format=value(subnetwork)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  const subnet = subnetResult.exitCode === 0 ? subnetResult.stdout.trim() : "";
  // The subnet name reaches gcloud argv; keep it to the GCP resource-name charset.
  if (!/^[a-z][-a-z0-9]{0,62}$/.test(subnet)) {
    return bail(
      subnetResult.exitCode !== 0
        ? `gcloud exited ${subnetResult.exitCode}`
        : subnet
          ? `unexpected value ${JSON.stringify(subnet)}`
          : "empty output",
    );
  }

  // Distinguish "could not read it" from "read something unusable" — the operator fixes
  // those two differently (cluster/IAM access vs. an unexpected gcloud output shape).
  const rangeOf = async (subnetName: string): Promise<{ cidr: string } | { error: string }> => {
    const r = await execCapture(
      "gcloud",
      [
        "compute",
        "networks",
        "subnets",
        "describe",
        subnetName,
        "--region",
        region,
        "--project",
        projectId,
        "--format=value(ipCidrRange)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (r.exitCode !== 0) {
      return { error: `subnet "${subnetName}": gcloud exited ${r.exitCode}` };
    }
    const value = r.stdout.trim();
    if (CIDR_LIST_RE.test(value)) return { cidr: value };
    return {
      error: value
        ? `subnet "${subnetName}": unexpected value ${JSON.stringify(value)}`
        : `subnet "${subnetName}": empty output`,
    };
  };

  const primary = await rangeOf(subnet);
  if ("error" in primary) return bail(primary.error);

  const cidrs = [primary.cidr];
  // Best-effort: Standard clusters can put node pools in other subnets. Blocked on
  // Autopilot, where it is also unnecessary.
  const poolsResult = await execCapture(
    "gcloud",
    [
      "container",
      "node-pools",
      "list",
      "--cluster",
      clusterName,
      "--region",
      region,
      "--project",
      projectId,
      "--format=value(networkConfig.subnetwork)",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (poolsResult.exitCode === 0) {
    const extra = new Set(
      poolsResult.stdout
        .split("\n")
        .map((line) => line.trim().split("/").pop() ?? "")
        .filter((name) => name && name !== subnet && /^[a-z][-a-z0-9]{0,62}$/.test(name)),
    );
    for (const name of extra) {
      const range = await rangeOf(name);
      // A node pool we CAN see but whose subnet we cannot read is a real gap in the
      // allowlist — those nodes' kubelets would be denied. Fail rather than half-cover.
      if ("error" in range) return bail(`node pool ${range.error}`);
      if (!cidrs.includes(range.cidr)) cidrs.push(range.cidr);
    }
  }

  return cidrs.join(",");
}

export async function runDeploy(options: DeployOptions): Promise<void> {
  const {
    projectDir,
    releaseName,
    skipBuild,
    skipPush,
    dryRun,
    allowNoNetworkPolicy,
    allowMutableTags,
    allowUnretainedManifest,
    yes,
  } = options;

  const infraPath = infrastructurePath(projectDir);
  if (!existsSync(infraPath)) {
    throw new Error(
      "infrastructure.json not found. Run `npx adapter-k8s init` first, " +
        "or create .k8s-adapter/infrastructure.json manually.",
    );
  }
  let infra: Record<string, string | undefined>;
  try {
    infra = JSON.parse(readFileSync(infraPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${infraPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the file by hand or regenerate it with \`npx adapter-k8s init\`.`,
    );
  }

  // H2: infrastructure.json values reach the privileged route-ext Job script
  // (projectId/region), extension-chain authority/YAML (namespace), and helm --set
  // assignments / docker tags (containerRegistry) — validate before any use.
  if (infra.projectId) assertSafeProjectId(infra.projectId);
  if (infra.region) assertSafeRegion(infra.region);
  const namespace = resolveK8sNamespace(infra.namespace);
  if (infra.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  // Without a registry, docker tags and the helm --set image registry can't be formed —
  // fail with a pointer to the fix instead of a raw TypeError deep in the deploy.
  if (!infra.containerRegistry) {
    throw new Error(
      "infrastructure.json is missing containerRegistry — image tags cannot be formed. " +
        "Run `npx adapter-k8s init` to regenerate it, or set containerRegistry in " +
        ".k8s-adapter/infrastructure.json.",
    );
  }

  // Probe before `next build`, image pushes, credentials, or any cluster mutation. Helm 3
  // remains a supported deployment client; only Helm 4 receives its SSA-only flags. A dry
  // run performs no subprocess reads by contract and prints both capability-dependent forms.
  const helmUpgradeMode = dryRun ? null : await detectHelmUpgradeMode();

  // 1. Run next build (adapter's onBuildComplete generates artifacts)
  if (!skipBuild) {
    console.log("\n  → Running next build...");
    if (!dryRun) {
      await execOrThrow("npx", ["next", "build"], {
        cwd: projectDir,
        timeoutMs: EXEC_TIMEOUTS.cloudOperation,
      });
    } else {
      console.log("    [dry-run] npx next build");
    }
  }

  // 2. Read build metadata to get buildId and pool names
  const outputDirRelative = path.join(".k8s-adapter", outputDirName());
  const outputDir = path.join(projectDir, outputDirRelative);
  const metadataPath = path.join(outputDir, "build-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Build metadata not found at ${metadataPath}. Did next build run?`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  const buildId: string = metadata.buildId;
  // H2: the buildId comes from generateBuildId()/git refs and is spliced into helm
  // --set assignments and image tags — reject helm/shell metacharacters up front.
  assertSafeBuildId(buildId);
  const compositionSnapshot = loadLocalCompositionPlan(outputDir, metadata);
  if (compositionSnapshot) {
    assertCompositionPlanInvocation(compositionSnapshot.plan, {
      releaseName,
      namespace,
      buildId,
    });
    if (compositionSnapshot.plan.target.registry.repository !== infra.containerRegistry) {
      throw new Error(
        `Composition plan registry ${JSON.stringify(compositionSnapshot.plan.target.registry.repository)} ` +
          `does not match infrastructure registry ${JSON.stringify(infra.containerRegistry)}. ` +
          `Rebuild for the selected target.`,
      );
    }
  }
  const pools: string[] = metadata.pools;
  const defaultPool: string | undefined =
    typeof metadata.defaultPool === "string" ? metadata.defaultPool : pools?.[0];
  const hasPortableOrigin = existsSync(
    path.join(outputDir, "chart", "templates", "origin-service.yaml"),
  );
  // Which provider this build targets. Older metadata predates the field; default to gke,
  // which is what every build before this change was.
  const buildProvider: string = typeof metadata.provider === "string" ? metadata.provider : "gke";
  // Native dependencies are staged during `next build`, so deploy must consume the artifact's
  // platform instead of re-reading a possibly different environment. Older artifacts did not
  // record it and always staged the amd64 Sharp pair, so they are amd64 artifacts regardless
  // of a deploy-time override.
  const builtTargetPlatform =
    metadata.targetPlatform === undefined
      ? DEFAULT_TARGET_PLATFORM
      : parseTargetPlatform(metadata.targetPlatform, "build-metadata.json targetPlatform");
  const requestedTargetPlatform = process.env.ADAPTER_K8S_TARGET_PLATFORM?.trim();
  if (
    requestedTargetPlatform &&
    parseTargetPlatform(requestedTargetPlatform) !== builtTargetPlatform
  ) {
    throw new Error(
      `The build output in .k8s-adapter/output targets "${builtTargetPlatform}", but this ` +
        `deploy requested "${requestedTargetPlatform}" through ADAPTER_K8S_TARGET_PLATFORM. ` +
        `Sharp's native packages and the chart's node selector are fixed at build time. Re-run ` +
        `without --skip-build so every artifact targets the same platform.`,
    );
  }

  // TARGET FINGERPRINT. The routing tier's image registry is baked into its Deployment template
  // at BUILD time, so copied or pre-variant output can still belong to another target. MEASURED:
  // a Scaleway deploy reused a GKE chart and its routing pods went ImagePullBackOff trying to pull
  // `us-central1-docker.pkg.dev/...` with a 403, after helm had already applied.
  //
  // Refuse before helm instead. This compares what the chart was BUILT for against what we are
  // deploying WITH; a mismatch always means the output on disk belongs to a different target.
  const builtRegistry: string | undefined =
    typeof metadata.containerRegistry === "string" ? metadata.containerRegistry : undefined;
  if (builtRegistry !== undefined && builtRegistry !== infra.containerRegistry) {
    throw new Error(
      `The build output in ${outputDirRelative} was emitted for registry ` +
        `"${builtRegistry}", but this deploy targets "${infra.containerRegistry}". The chart bakes ` +
        `image references at build time, so deploying it would pull another target's images ` +
        `(and fail to authenticate against a registry this cluster cannot reach).\n` +
        `${process.env.ADAPTER_K8S_CONFIG ? `You are using ADAPTER_K8S_CONFIG=${process.env.ADAPTER_K8S_CONFIG}; the selected variant output does not match its infrastructure.\n` : ""}` +
        `Re-run without --skip-build so the chart is emitted for this target.`,
    );
  }
  // Build metadata predating namespace support has no field and therefore targets the
  // historical default namespace.
  const builtNamespace = resolveK8sNamespace(metadata.namespace);
  if (builtNamespace !== namespace) {
    throw new Error(
      `The build output in ${outputDirRelative} was emitted for namespace ` +
        `"${builtNamespace}", but this deploy targets "${namespace}". The ext_proc authority ` +
        `is namespace-qualified at build time, so deploying this chart would make routing ` +
        `callouts target the wrong Service. Re-run without --skip-build so the chart is ` +
        `emitted for this target.`,
    );
  }

  if (!Array.isArray(pools)) {
    throw new Error(`build-metadata.json is missing a "pools" array. Did next build run?`);
  }
  for (const poolName of pools) assertSafePoolName(poolName);
  if (!defaultPool || !pools.includes(defaultPool)) {
    throw new Error(
      `build-metadata.json defaultPool must name one of its pools; got ${JSON.stringify(defaultPool)}`,
    );
  }

  // 0. Ensure kubectl is pointing at the right cluster.
  //
  // WHICH cluster is provider-dependent, so this runs AFTER the build metadata is read — the
  // provider recorded by THIS build is the only authoritative answer.
  //
  // Two earlier cuts were both wrong. Choosing on GCP field presence: a generic deployment may
  // legitimately push to Artifact Registry and record projectId/region, and this block would then
  // retarget kubectl at `<release>-cluster` — a different cluster than the one being deployed to.
  // Then peeking at the PREVIOUS build's metadata: it is stale by construction, so switching a
  // project between providers pinned the wrong way round in both directions (generic→gke skipped
  // GKE pinning and helm-upgraded whatever context was current; gke→generic pinned the GKE
  // cluster). Nothing here touches the cluster before this point, so ordering it after the build
  // costs nothing.
  if (compositionSnapshot) {
    if (dryRun) {
      console.log(
        `  [dry-run] verified composition plan ${compositionSnapshot.digest}; a real deploy ` +
          `would verify cluster identity, Kubernetes ` +
          `${compositionSnapshot.plan.requirements.kubernetes.minimumVersion}+, and every ` +
          `required API before mutating the release.`,
      );
    } else {
      let explicitlyConfirmed = yes === true;
      if (
        compositionPlanNeedsExplicitConfirmation(compositionSnapshot.plan) &&
        !explicitlyConfirmed
      ) {
        const context = await currentKubeContext();
        console.warn(
          `\n  !!! WARNING: the composition plan cannot prove that the current kubectl ` +
            `context is the intended cluster:\n      ${context ?? "(no current context / kubectl unavailable)"}\n`,
        );
        if (!process.stdin.isTTY) {
          throw new Error(
            "Refusing to deploy an explicitly-unverified composition plan non-interactively. " +
              "Use a verifiable cluster identity, or re-run with --yes only after confirming " +
              "the context above.",
          );
        }
        const answer = await promptConfirmation(
          `  Type "yes" to confirm this kubectl context is the intended cluster: `,
        );
        if (answer.trim() !== "yes") {
          throw new Error(
            "Deploy aborted: the composition plan's cluster identity was not explicitly " +
              "confirmed. Nothing was changed.",
          );
        }
        explicitlyConfirmed = true;
        console.log("");
      }
      const preflight = await preflightCompositionPlan(compositionSnapshot.plan, {
        explicitlyConfirmed,
      });
      console.log(
        `\n  → Composition plan verified: ${preflight.clusterIdentity}; Kubernetes ` +
          `${preflight.serverVersion}`,
      );
      if (preflight.missingOptional.length > 0) {
        console.warn(
          `  ! Optional Kubernetes APIs unavailable: ${preflight.missingOptional
            .map((entry) => `${entry.apiVersion}/${entry.resource}`)
            .join(", ")}`,
        );
      }
    }
  } else {
    // Compatibility path for artifacts emitted before composition plans. New targets carry an
    // exact access/identity operation above; legacy metadata still uses the historical provider
    // marker until it is rebuilt.
    const targetsGke = buildProvider === "gke";
    const canPinContext = Boolean(targetsGke && infra.projectId && infra.region && releaseName);
    if (!dryRun && canPinContext) {
      const clusterName = `${releaseName}-cluster`;
      console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
      await execOrThrow(
        "gcloud",
        [
          "container",
          "clusters",
          "get-credentials",
          clusterName,
          "--region",
          infra.region!,
          "--project",
          infra.projectId!,
          "--quiet",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
    } else if (!canPinContext) {
      // N29: context pinning is IMPOSSIBLE (no projectId/region in infrastructure.json), so
      // EVERYTHING below — helm upgrade, the Service selector patches, the state ConfigMap
      // write — would run against whatever kubectl context happens to be current. This
      // silently-skipped get-credentials is the same hole destroy's C1 guard closed; deploy
      // had no equivalent (invariant 6). Surface the context and require confirmation.
      if (dryRun) {
        console.log(
          `  [dry-run] infrastructure.json is missing projectId/region — kubectl context ` +
            `pinning is impossible. A real deploy would target whatever kubectl context is ` +
            `current (and ask you to confirm it).`,
        );
      } else {
        const ctx = await execCapture("kubectl", ["config", "current-context"], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        }).catch(() => null);
        // L14: the context name is kubeconfig-sourced — strip terminal control chars.
        const currentContext =
          ctx && ctx.exitCode === 0 ? sanitizeForTerminal(ctx.stdout.trim()) : "";
        console.warn(
          `\n  !!! WARNING: infrastructure.json is missing projectId/region, so kubectl could ` +
            `NOT be pinned to this release's cluster.\n` +
            `      The ENTIRE deploy (helm upgrade, Service selector cutover, deploy-state ` +
            `ConfigMap) will run against your CURRENT kubectl context:\n` +
            `      ${currentContext || "(no current context / kubectl unavailable)"}\n`,
        );
        if (!yes) {
          if (!process.stdin.isTTY) {
            throw new Error(
              "Refusing to deploy against an unpinned kubectl context non-interactively. " +
                "Restore projectId/region in .k8s-adapter/infrastructure.json (re-run " +
                "`npx adapter-k8s init`) so the context can be pinned, or re-run with --yes " +
                "only if the context above is the intended cluster.",
            );
          }
          const answer = await promptConfirmation(
            `  Type "yes" to confirm this kubectl context is the intended cluster: `,
          );
          if (answer.trim() !== "yes") {
            throw new Error(
              "Deploy aborted: the current kubectl context was not confirmed as the intended " +
                "cluster. Nothing was changed.",
            );
          }
          console.log("");
        }
      }
    }
  }

  // S24: resolved in preflight below; the build/push commands and the digest probe all use
  // it. With --skip-push we never probe, and the registry answers for digests (S23), so
  // docker stays as a harmless placeholder.
  let containerCli = "docker";

  // 0c. S24: resolve the container runtime BEFORE anything with side effects. Observed with
  // nerdctl: resolution used to live down in the push branch, so a host whose runtime cannot
  // build still provisioned Memorystore and rewrote the docker credential config before
  // dying on the first `build`. A runtime we cannot build with is a preflight failure.
  if (!dryRun && !skipPush) {
    containerCli = await resolveContainerCli();
    if (containerCli !== "docker") console.log(`\n  Container runtime: ${containerCli}`);
  }

  console.log(`\n  Build ID: ${buildId}`);

  // 2b. Discover the NetworkPolicy source ranges (fail-closed — see discoverClusterPodCidr).
  // Deliberately AFTER build metadata is read: WHICH discovery to run is provider-dependent,
  // and the provider is recorded at build time. Asking gcloud on a K3s cluster cannot work.
  // (was 0b — the cluster pod CIDR for chart-rendered NetworkPolicies —
  // see discoverClusterPodCidr), and the node range the STRICT posture needs for kubelet
  // (S22 — discoverClusterNodeCidrs). Strict is the default, and the only reason it was not
  // is that `nodeCidrs` had to be supplied by hand; discovering it removes that cost
  // entirely, so the secure posture is what an ordinary deploy gets.
  let podCidr: string | null = null;
  let nodeCidr: string | null = null;
  if (!dryRun && compositionSnapshot) {
    const network = compositionSnapshot.plan.operations.network;
    const resolvePlanSource = async (
      source: typeof network.podCidrs,
      purpose: "pod" | "node",
    ): Promise<string | null> => {
      switch (source.kind) {
        case "not-required":
          return null;
        case "static":
          return source.cidrs.join(",");
        case "kubernetes-node-pod-cidrs":
          return discoverPodCidrsFromCluster();
        case "kubernetes-node-addresses":
          return discoverNodeCidrsFromCluster();
        case "gke-pod-range":
          if (source.location.kind !== "region") {
            throw new Error(
              `Composition-plan ${purpose} CIDR discovery uses a zonal GKE location, but ` +
                `the current GKE discovery operation requires a region. Rebuild with a ` +
                `regional target or configure static CIDRs.`,
            );
          }
          return discoverClusterPodCidr({
            clusterName: source.clusterName,
            region: source.location.name,
            projectId: source.projectId,
            allowNoNetworkPolicy: allowNoNetworkPolicy ?? false,
          });
        case "gke-node-subnet":
          if (source.location.kind !== "region") {
            throw new Error(
              `Composition-plan ${purpose} CIDR discovery uses a zonal GKE location, but ` +
                `the current GKE discovery operation requires a region. Rebuild with a ` +
                `regional target or configure static CIDRs.`,
            );
          }
          return discoverClusterNodeCidrs({
            clusterName: source.clusterName,
            region: source.location.name,
            projectId: source.projectId,
            allowNoNetworkPolicy: allowNoNetworkPolicy ?? false,
          });
      }
    };
    podCidr = await resolvePlanSource(network.podCidrs, "pod");
    nodeCidr = await resolvePlanSource(network.nodeCidrs, "node");
    for (const [purpose, source, resolved] of [
      ["pod", network.podCidrs, podCidr],
      ["node", network.nodeCidrs, nodeCidr],
    ] as const) {
      if (source.kind !== "not-required" && !resolved && !allowNoNetworkPolicy) {
        throw new Error(
          `Composition-plan ${purpose} CIDR source ${source.kind} returned no ranges. The ` +
            `plan's missingSourcePolicy is fail, so refusing to deploy without network ` +
            `isolation. Fix cluster access, configure static CIDRs, or explicitly pass ` +
            `--allow-no-network-policy.`,
        );
      }
    }
  } else if (!dryRun && infra.projectId && infra.region && releaseName) {
    // Legacy artifacts predate typed network sources and use the historical GKE convention.
    podCidr = await discoverClusterPodCidr({
      clusterName: `${releaseName}-cluster`,
      region: infra.region,
      projectId: infra.projectId,
      allowNoNetworkPolicy: allowNoNetworkPolicy ?? false,
    });
    nodeCidr = await discoverClusterNodeCidrs({
      clusterName: `${releaseName}-cluster`,
      region: infra.region,
      projectId: infra.projectId,
      allowNoNetworkPolicy: allowNoNetworkPolicy ?? false,
    });
  } else if (!dryRun && buildProvider !== "gke") {
    // An explicit range wins: discovery snapshots the node addresses that exist RIGHT NOW, so on
    // a cluster whose nodes come and go (autoscaling, replacement, rolling upgrade) a node added
    // after this deploy is not in the allowlist and its kubelet cannot reach the pods it hosts —
    // they never become ready. That fails safe rather than open, but it is still an outage on
    // those pods, and no amount of deploy-time discovery can predict a future node.
    const configured: string[] | undefined = Array.isArray(metadata.nodeCidrs)
      ? metadata.nodeCidrs.filter((c: unknown): c is string => typeof c === "string")
      : undefined;
    if (configured && configured.length > 0) {
      // Validated here because it reaches a helm --set brace list.
      const bad = configured.filter((c) => !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(c));
      if (bad.length > 0) {
        throw new Error(
          `provider.generic.nodeCidrs contains invalid CIDR(s): ${bad.join(", ")}. Expected ` +
            `entries like "10.0.0.0/16".`,
        );
      }
      nodeCidr = configured.join(",");
      console.log(`    Node ranges from provider.generic.nodeCidrs: ${nodeCidr}`);
    } else {
      // No cloud to ask. The Kubernetes API knows the node addresses on every conformant
      // cluster, which is what the strict posture needs for kubelet probes.
      nodeCidr = await discoverNodeCidrsFromCluster();
      if (nodeCidr) {
        console.log(
          `    Node ranges discovered from the cluster: ${nodeCidr}\n` +
            `    ! These are the nodes that exist NOW. If nodes are added or replaced (autoscaling,\n` +
            `      node upgrades), their kubelets will not be allowed to probe pods until the next\n` +
            `      deploy — set provider.generic.nodeCidrs to the node subnet to avoid that.`,
        );
      }
    }
    if (!nodeCidr && !allowNoNetworkPolicy) {
      throw new Error(
        `Could not read node addresses from the cluster (kubectl get nodes). The strict ` +
          `NetworkPolicy posture needs them: kubelet liveness/readiness probes come from the ` +
          `node IP, and an allowlist without it leaves every pod unready. Refusing to deploy ` +
          `without network isolation — fix cluster access, or pass --allow-no-network-policy.`,
      );
    }
  } else if (!dryRun && !allowNoNetworkPolicy) {
    // A GKE build whose infrastructure.json is missing projectId/region reached here with BOTH
    // discoveries skipped. buildHelmUpgradeArgs then sets `strict=false` (it has no nodeCidrs),
    // and with no podCidrs either the chart's guard renders NO NetworkPolicies at all — so the
    // deploy silently shipped an unisolated dataplane, reopening the dispatch-secret
    // extraction path, without the operator ever passing --allow-no-network-policy. That flag
    // exists precisely so removing isolation is a decision; make it one.
    const missing = [infra.projectId ? null : "projectId", infra.region ? null : "region"].filter(
      (m): m is string => m !== null,
    );
    throw new Error(
      `Cannot determine the NetworkPolicy source ranges: .k8s-adapter/infrastructure.json is ` +
        `missing ${missing.join(" and ")}. Without ${missing.join(" and ")} neither the pod CIDR ` +
        `nor the node range can be discovered, and the chart would render NO NetworkPolicies — ` +
        `leaving the routing tier's ext_proc port reachable, which is what makes the internal ` +
        `dispatch secret obtainable. Run \`npx adapter-k8s init\` to regenerate ` +
        `infrastructure.json, or pass --allow-no-network-policy to deploy without isolation ` +
        `deliberately.`,
    );
  }

  console.log(`  Pools: ${pools.join(", ")}`);

  // Managed cache: provision Memorystore and inject its discovered endpoint into the Helm chart.
  // This keeps the Valkey Secret Helm-owned in both managed and BYO modes, so switching modes
  // updates one resource instead of crossing the kubectl/Helm ownership boundary.
  //
  // Pre-`cacheManaged` build artifacts (older adapter versions) carry cacheEnabled but no
  // cacheManaged flag at all. A `--skip-build` deploy over such an artifact must treat
  // enabled-with-unknown-mode as MANAGED: falling into the teardown branch below would
  // delete a live managed Memorystore out from under the serving build. (Provisioning is
  // idempotent, so re-running the managed branch against an existing instance is safe.)
  const cacheManaged: boolean = metadata.cacheManaged ?? metadata.cacheEnabled === true;
  if (cacheManaged && !dryRun) {
    // Fail loudly rather than silently shipping without a shared cache: managed provisioning
    // needs the project + region. (BYO cache sets cache.url and never reaches this branch.)
    if (!infra.projectId || !infra.region) {
      throw new Error(
        "cache.enabled with managed Memorystore requires infrastructure.json to have projectId " +
          "and region. Set cache.url for a bring-your-own instance, or re-run `adapter-k8s init`.",
      );
    }
    console.log("\n  → Provisioning managed cache (Memorystore)...");
    const ms = (
      metadata as {
        cacheMemorystore?: { region?: string; sizeGb?: number; tier?: string; auth?: boolean };
      }
    ).cacheMemorystore;
    const cacheRegion = ms?.region ?? infra.region;
    const endpoint = await provisionMemorystore({
      projectId: infra.projectId,
      region: cacheRegion,
      releaseName,
      ...(ms?.sizeGb ? { sizeGb: ms.sizeGb } : {}),
      ...(ms?.tier ? { tier: ms.tier } : {}),
      // S8: AUTH/TLS default ON — only an explicit `false` opts out (provisionMemorystore
      // distinguishes explicit-true from defaulted-true so an existing instance is tolerated).
      ...(ms?.auth === undefined ? {} : { auth: ms.auth }),
      log: (m: string) => console.log(m),
    });
    // Persist the actual region immediately after provisioning. Any later failure (writing the
    // chart, Helm connectivity, rollout) must still leave destroy enough state to find the paid
    // instance, especially when cache.memorystore.region differs from the cluster region.
    if (infra.cacheRegion !== cacheRegion) {
      infra.cacheRegion = cacheRegion;
      writeFileSync(infraPath, JSON.stringify(infra, null, 2));
    }

    // AUTH mode ⇒ TLS endpoint (Memorystore requires in-transit encryption for AUTH).
    const url = `${endpoint.authString ? "rediss" : "redis"}://${endpoint.host}:${endpoint.port}`;
    const secretPath = path.join(outputDir, "chart", "templates", "valkey-secret.yaml");
    // M4a: this file carries the cache connection Secret — owner-read/write only.
    writeFileSync(
      secretPath,
      renderValkeySecret({
        releaseName,
        url,
        ...(endpoint.authString ? { password: endpoint.authString } : {}),
        ...(endpoint.caCert ? { ca: endpoint.caCert } : {}),
      }),
      { mode: 0o600 },
    );
    // writeFileSync's mode only applies when CREATING the file — an existing file keeps
    // its old mode, so a previously world-readable secret file would stay that way.
    chmodSync(secretPath, 0o600);
    console.log(`    Cache Secret ${releaseName}-valkey staged for Helm → ${url}`);
  } else if (!compositionSnapshot && !cacheManaged && !dryRun) {
    // The current build is NOT using the managed cache (disabled entirely, or BYO via
    // cache.url). If a managed Memorystore was previously provisioned for this release
    // (infra.cacheRegion persisted at provision time), tear it down — otherwise the
    // managed→BYO switch silently leaks the paid instance (the teardown used to fire
    // only when the cache was fully disabled). BYO-from-the-start never sets
    // infra.cacheRegion, so this stays a no-op there.
    if (!metadata.cacheEnabled) {
      // Cache fully disabled: also remove the Secret so new pods stop receiving
      // VALKEY_URL (the pod template always mounts the optional Secret). Not done for
      // BYO: the chart then carries its own Helm-owned valkey-secret.yaml instead.
      const secretDelete = await execCapture(
        "kubectl",
        ["delete", "secret", `${releaseName}-valkey`, "-n", namespace, "--ignore-not-found"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (secretDelete.stdout.trim())
        console.log(`\n  → Removed cache Secret ${releaseName}-valkey`);
    }
    if (infra.cacheRegion) {
      console.log(
        `  → Deleting managed cache (Memorystore) — ${metadata.cacheEnabled ? "switched to bring-your-own cache" : "cache is disabled"}...`,
      );
      // projectId is only absent when infrastructure.json is hand-broken; the delete then
      // fails gcloud-side and lands in the warn path below (the instance stays billed).
      const del = buildDeleteMemorystoreCommand(
        releaseName,
        infra.cacheRegion,
        infra.projectId ?? "",
      );
      const res = await execCapture(del.command, del.args, {
        timeoutMs: EXEC_TIMEOUTS.cloudOperation,
      });
      if (res.exitCode === 0 || isAlreadyGoneError(res.stderr)) {
        delete infra.cacheRegion;
        writeFileSync(infraPath, JSON.stringify(infra, null, 2));
        console.log(`    ${del.desc} deleted`);
      } else {
        console.warn(
          `    Warning: could not delete ${del.desc} in ${infra.cacheRegion} — it may still be ` +
            `billed. Delete it manually or run \`adapter-k8s destroy\`.\n    ` +
            // L14: gcloud stderr is externally influenced.
            `${sanitizeForTerminal(res.stderr.trim())}`,
        );
      }
    }
  }

  // 3. Read adapter config to determine container strategy
  // Default to traced-assets if not specified
  const containerStrategy = metadata.containerStrategy ?? "traced-assets";
  const poolImageLayout = parsePoolImageLayout(metadata.poolImageLayout);

  // 4. Docker build + push
  // S7/S23: filled in below by resolveDeployImageDigests, for BOTH the push and --skip-push
  // paths (the registry can pin an image this run did not push).
  const imageDigests: Record<string, string> = {};
  if (!skipPush) {
    // The build's fetch-cache is re-staged HERE because its writes race onBuildComplete's
    // staging inside `next build` (see refreshFetchCacheStaging) — by deploy time the
    // artifact is deterministically on disk.
    if (!dryRun) {
      refreshFetchCacheStaging(projectDir, outputDir, {
        distDir: metadata.distDir,
        pools,
        containerStrategy,
        poolImageLayout,
      });
    }
    const dockerCommands = buildDockerCommands({
      pools,
      buildId,
      registry: infra.containerRegistry,
      outputDir: outputDirRelative,
      containerStrategy,
      ...(poolImageLayout ? { poolImageLayout } : {}),
      containerCli,
      targetPlatform: builtTargetPlatform,
      ...(compositionSnapshot
        ? {
            registryAuthentication: compositionSnapshot.plan.target.registry.authentication,
            includeRoutingService:
              compositionSnapshot.plan.operations.routing.protocol !== "pool-local-v1",
          }
        : {}),
    });

    for (const cmd of dockerCommands) {
      console.log(`\n  → ${cmd.description}`);
      if (!dryRun) {
        await execOrThrow(cmd.command, cmd.args, {
          cwd: projectDir,
          timeoutMs: EXEC_TIMEOUTS.cloudOperation,
        });
      } else {
        console.log(`    [dry-run] ${cmd.command} ${cmd.args.join(" ")}`);
      }
    }
  }

  // S7/S23: pin every image this deploy will run to an immutable digest, and deploy THAT
  // instead of the mutable `:${buildId}` tag. Runs on the --skip-push path too: those images
  // were pushed by some earlier step, and "we did not push them" is no reason to run them
  // unpinned — the registry can still answer for them. Fail-closed inside
  // resolveDeployImageDigests; --allow-mutable-tags is the opt-out.
  // NOT gated on infra.projectId. That is a GCP field, so gating on it meant a generic deploy
  // skipped digest resolution entirely and shipped MUTABLE TAGS — silently bypassing the
  // --allow-mutable-tags gate that exists to make that a decision rather than an accident. The
  // registry PROBE is provider-specific (and no-ops without a project); the REQUIREMENT is not.
  if (!dryRun) {
    const registry = infra.containerRegistry;
    const refs: Array<[string, string]> =
      containerStrategy === "shared-image"
        ? pools.map((p) => [p, `${registry}/nextjs-app:${buildId}`])
        : pools.map((p) => [p, `${registry}/nextjs-app-${p}:${buildId}`]);
    if (
      !compositionSnapshot ||
      compositionSnapshot.plan.operations.routing.protocol !== "pool-local-v1"
    ) {
      refs.push(["routingService", `${registry}/routing-service:${buildId}`]);
    }
    Object.assign(
      imageDigests,
      await resolveDeployImageDigests({
        refs,
        // Empty for a generic build: the AR probe no-ops and the local daemon answers.
        projectId: infra.projectId ?? "",
        allowMutableTags: allowMutableTags ?? false,
        containerCli,
        targetPlatform: builtTargetPlatform,
        ...(compositionSnapshot
          ? { digestLookup: compositionSnapshot.plan.target.registry.digestLookup }
          : {}),
      }),
    );
    const pinned = Object.keys(imageDigests).length;
    if (pinned > 0) console.log(`    Pinned ${pinned} image(s) to immutable digests`);
  }

  // 5. Pre-flight: ensure the exact address named by a GCP traffic-extension plan exists.
  // Legacy artifacts retain their historical infrastructure-derived convention.
  const plannedTrafficExtension = compositionSnapshot
    ? compositionSnapshot.plan.operations.routing.dataplane.readiness.find(
        (entry) => entry.kind === "gcp-traffic-extension",
      )
    : undefined;
  const addressProject =
    plannedTrafficExtension?.projectId ?? (!compositionSnapshot ? infra.projectId : undefined);
  const addressName = plannedTrafficExtension?.addressName ?? `${releaseName}-ip`;
  if (!dryRun && addressProject) {
    const ipName = addressName;
    const ipCheck = await execCapture(
      "gcloud",
      [
        "compute",
        "addresses",
        "describe",
        ipName,
        "--global",
        "--project",
        addressProject,
        "--format=value(address)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (ipCheck.exitCode !== 0) {
      console.log(`\n  → Creating static IP "${ipName}"...`);
      await execOrThrow(
        "gcloud",
        [
          "compute",
          "addresses",
          "create",
          ipName,
          "--global",
          "--project",
          addressProject,
          "--quiet",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
    }
  }

  // 5b. Pre-flight: the chart carries a Cloud CDN filter only when cdn.enabled — the cluster
  // must know the GCPHTTPFilter CRD (GKE >= 1.35.2-gke.1751000) or the apply would fail with
  // an opaque server error. Capability-detect the CRD rather than parsing version strings.
  const chartHasCdn = existsSync(
    path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml"),
  );
  if (!dryRun && chartHasCdn) {
    const crdCheck = await execCapture(
      "kubectl",
      ["get", "crd", "gcphttpfilters.networking.gke.io", "--ignore-not-found", "-o", "name"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (crdCheck.exitCode !== 0) {
      // kubectl itself failed (no context, expired credentials, unreachable API server) —
      // NOT a version problem. `--ignore-not-found` returns exit 0 for a genuinely absent
      // CRD, so a non-zero exit is always a connectivity/auth failure. Don't send the user
      // to upgrade a cluster they can't even reach.
      // L14: kubectl surfaces apiserver/admission text, which is externally influenced.
      const detail = sanitizeForTerminal(crdCheck.stderr.trim());
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but the GCPHTTPFilter CRD check could not ` +
          `reach the cluster (kubectl exited ${crdCheck.exitCode}). Check your kubectl context ` +
          `and credentials.${detail ? `\nkubectl: ${detail}` : ""}`,
      );
    }
    if (!crdCheck.stdout.trim()) {
      // Cluster reachable, CRD genuinely absent → the cluster is too old.
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but this cluster does not have the ` +
          `GCPHTTPFilter CRD. Cloud CDN for GKE Gateway requires GKE >= ${MIN_GKE_VERSION_FOR_CDN}. ` +
          `Upgrade the cluster, or set provider.gke.cdn.enabled: false in adapter config.`,
      );
    }
  }

  // 6. Helm upgrade
  // L13: dry-run must not touch the cluster — skip the cluster ConfigMap read and use
  // local state only (best-effort).
  let state: AdapterState | null = null;
  // N20: "state is unknown" and "there is no state (first deploy)" MUST stay distinct.
  let stateUnavailable: string | null = null;
  if (dryRun) {
    state = await readState(projectDir).catch(() => null);
  } else {
    try {
      state = await readState(projectDir, releaseName, { namespace });
    } catch (err) {
      if (!(err instanceof StateUnavailableError)) throw err;
      stateUnavailable = err.message;
    }
  }
  let previousBuildId = state?.buildId ?? null;
  if (stateUnavailable) {
    // Recover the live build from the cluster instead of proceeding as a first deploy
    // (which skips the retained-manifest injection below, so `helm upgrade` deletes the
    // Deployment currently serving traffic, and sets activeBuildId to a build with zero
    // ready pods). discoverServingBuildId throws with a repair message when the live
    // build can't be established — deploy must never guess here.
    // L14: the message wraps cluster-sourced read errors.
    console.warn(
      `\n  ! Committed deploy state could not be determined:\n    ${sanitizeForTerminal(stateUnavailable)}`,
    );
    previousBuildId = await discoverServingBuildId(releaseName, namespace);
    console.warn(
      `  ! Recovered the currently-serving build "${previousBuildId}" from the active ` +
        `Service selector. Proceeding with it as the previous build — its recorded CDN tag ` +
        `is unknown, so cutover invalidation falls back to a full purge (M13). Fix deploy ` +
        `state after this deploy.`,
    );
  }
  // H2: previousBuildId is spliced into a helm --set assignment below.
  if (previousBuildId) assertSafeBuildId(previousBuildId);
  // The build-time collision guard (adapter.ts) can't see deploy-time state: if any of
  // this build's COMPOSED resource names sanitizes to the SAME K8s name as the
  // currently-serving build's, the two builds' resources become indistinguishable —
  // pods carry identical version labels (split-brain cutover), the keep transfer can target
  // the wrong Deployment, and cleanup can delete the serving build.
  // Comparing the bare sanitized build ids is NOT enough: names collide on the COMPOSED
  // truncated form — a long `<release>-<pool>-` prefix can push the differing part of
  // the build id past the 63-char boundary even when the ids differ well inside their
  // own 63 chars. Compare exactly what the templates emit: the pool Deployment/Service
  // name, its suffix-reserving -hpa/-hcp variants (their truncation boundary sits 4
  // chars earlier), and the routing-manifest snapshot name. Refuse to deploy on any
  // collision while the build ids differ.
  // N14: an IDENTICAL build id is the `deploymentId` (skew-protection) signature — Next pins
  // the build id to a constant when next.config sets it, so every deploy reuses the serving
  // build's names and a cutover would adopt the running Deployment instead of standing up
  // beside it. The composed-name guard below can't see this case (it requires differing ids),
  // so name the cause here rather than letting helm silently upgrade in place.
  if (previousBuildId && previousBuildId === buildId) {
    throw new Error(
      `Build id "${buildId}" is IDENTICAL to the currently-serving build, so blue/green ` +
        `cutover is impossible — the new release would adopt the running Deployment in ` +
        `place, and both builds would share the \`k8s:${buildId}:\` cache namespace. The ` +
        `usual cause is \`deploymentId\` in next.config: Next then pins the build id to a ` +
        `constant for every build. Remove it — skew protection is already active via the ` +
        `per-build build id, and immutable assets already handle asset versioning — or set ` +
        `a \`generateBuildId\` that changes per build.`,
    );
  }

  // N70: the outgoing build owns its own pool topology. The incoming build metadata cannot
  // describe pools that were removed or renamed: iterating `pools` here used to omit those
  // outgoing Deployments/HPAs from retention, so Helm deleted the rollback target before the
  // new build was healthy. Current states record the exact topology per build. Legacy states
  // are migrated from immutable, versioned Deployments; dry-run cannot do that without cluster
  // access and therefore fails closed instead of printing an incomplete plan.
  let previousPools: string[] = [];
  if (previousBuildId && previousBuildId !== buildId) {
    previousPools = state ? (recordedBuildPools(state, previousBuildId) ?? []) : [];
    if (previousPools.length === 0) {
      if (dryRun) {
        throw new Error(
          `Deploy state predates per-build pool topology for build "${previousBuildId}". ` +
            `Dry-run cannot recover it without cluster access; run a real deploy to migrate ` +
            `the state, or restore poolTopologies in .k8s-adapter/state.json.`,
        );
      }
      // `missingBuild: "empty"`: a cluster holding NOTHING of the previous build (rebuilt
      // cluster, externally cleaned namespace) has no rollback target to preserve or to
      // strand — failing closed here bricked every subsequent deploy against unrepairable
      // state. Partial or inconsistent topologies still throw inside discoverBuildPools.
      previousPools = await discoverBuildPools(releaseName, previousBuildId, namespace, {
        missingBuild: "empty",
      });
      if (previousPools.length === 0) {
        console.warn(
          `  ! Deploy state records previous build "${previousBuildId}", but the cluster ` +
            `has NO Deployments for it (rebuilt cluster or externally cleaned namespace). ` +
            `Nothing to preserve for rollback — continuing as a first deploy.`,
        );
      } else {
        console.warn(
          `  ! Recovered legacy pool topology for build "${previousBuildId}" from its ` +
            `versioned Deployments: ${previousPools.join(", ")}. The successful deploy will ` +
            `record it in adapter state.`,
        );
      }
    }
  }
  if (previousBuildId && previousBuildId !== buildId) {
    // Compare the exact resource pairs that coexist during this rollout. Projecting both
    // build ids over the incoming pool list invents previous-build resources after a rename.
    const collision = findBuildTopologyNameCollision(
      releaseName,
      { buildId, pools },
      { buildId: previousBuildId, pools: previousPools },
    );
    if (collision) {
      throw new Error(
        `Build id "${buildId}" collides with the currently-serving build "${previousBuildId}" ` +
          `after Kubernetes name sanitization: the ${collision.kind} "${collision.name}" would ` +
          `be named identically for BOTH builds (lowercasing/truncation to the 63-char name ` +
          `limit erased the difference), so the cutover could not distinguish them. Choose a ` +
          `build id that still differs within the truncated name (see generateBuildId in ` +
          `next.config), or shorten the release/pool names.`,
      );
    }
  }

  // N62: collisions WITHIN a single build — pools `api` + `api-v2` with buildId `v2` both
  // emit a Deployment/Service named `<release>-api-v2` — must be caught on a FIRST deploy
  // too, so this check is unconditional (the previous-build comparison above cannot see it:
  // it needs two build ids). It runs AFTER that comparison deliberately: over the full
  // emitted name set it ALSO fires on the truncation case, and running it first masked the
  // more specific "collides with the currently-serving build" diagnosis.
  const selfCollision = findEmittedNameCollision(releaseName, pools, [buildId]);
  if (selfCollision) {
    throw new Error(
      `Emitted resource names collide within build "${buildId}": the ${selfCollision.kind} ` +
        `"${selfCollision.name}" would be applied TWICE. Either a pool is named ` +
        `"<otherPool>-${buildId}" (making its stable name equal the other pool's versioned ` +
        `name), or two names truncated to the same value at the 63-char limit. helm applies ` +
        `both objects silently, last-writer-wins, so an HTTPRoute backendRef can resolve to ` +
        `the wrong pool's pods and the cutover patches the wrong object's selector. Rename ` +
        `the pool, or shorten the release/pool names.`,
    );
  }

  const overridesFile = path.join(projectDir, ".k8s-adapter", "helm", "values.override.yaml");
  const helmArgsBase = {
    releaseName,
    chartPath: path.join(outputDir, "chart"),
    buildId,
    registry: infra.containerRegistry,
    previousBuildId,
    namespace,
    overridesFile,
    podCidrs: podCidr,
    nodeCidrs: nodeCidr,
    imageDigests,
    defaultPool,
    previousDefaultPool: previousBuildId
      ? (state?.defaultPools?.[previousBuildId] ?? previousPools[0] ?? defaultPool)
      : defaultPool,
    // First-upgrade probe migration. `helm upgrade` rewrites the stable HealthCheckPolicy
    // BEFORE the cutover, while the ACTIVE pods are still the OUTGOING build's — and a build
    // produced by an adapter from before /readyz existed answers only /healthz. Flipping the
    // load balancer to /readyz in that window can mark every serving endpoint unhealthy and
    // take the site down as a direct result of upgrading. So: keep probing /healthz for one
    // cycle whenever the recorded state does not positively say the live build serves
    // /readyz. Fresh installs (no prior state) go straight to readiness — there is no older
    // build to strand.
    ...(previousBuildId && !state?.readinessPathSupported
      ? { poolHealthCheckPath: LIVENESS_PATH_FOR_MIGRATION }
      : {}),
  };
  const helmArgs = buildHelmUpgradeArgs({
    ...helmArgsBase,
    // Dry-run's first printed form is the Helm 3 client-side command. The Helm 4 form is
    // rendered separately at the execution site below.
    helmUpgradeMode: helmUpgradeMode ?? "client-side",
  });

  const chartTemplatesDir = path.join(outputDir, "chart", "templates");

  // N32: wipe any retained-manifest files from an EARLIER deploy before writing this
  // deploy's. Invariant 5 ("clean chart regeneration") only holds when a build ran: the
  // chart dir is wiped by `next build`, and these files are written AFTER it. A
  // `--skip-build` deploy therefore inherited `*-prev-*.yaml` naming a build that has
  // since been reaped, and `helm upgrade` re-applied its Deployment (a build with no
  // images, at replicas > 0).
  if (existsSync(chartTemplatesDir)) {
    let staleFiles: string[] = [];
    try {
      staleFiles = (readdirSync(chartTemplatesDir) as unknown as string[]).filter(
        (f) => typeof f === "string" && /-prev-.*\.yaml$/.test(f),
      );
    } catch {
      staleFiles = []; // unreadable chart dir — helm will fail loudly on its own
    }
    for (const fileName of staleFiles) {
      const target = path.join(chartTemplatesDir, fileName);
      if (dryRun) {
        console.log(`    [dry-run] would delete stale retained manifest ${target}`);
      } else {
        console.log(`  → Removing stale retained manifest from a previous deploy: ${fileName}`);
        try {
          unlinkSync(target);
        } catch (err) {
          throw new Error(
            `Could not delete the stale retained manifest ${target} ` +
              `(${err instanceof Error ? err.message : String(err)}). It names a build that ` +
              `may no longer exist; helm would re-apply that build's Deployment. Delete it ` +
              `by hand or re-run a full build.`,
          );
        }
      }
    }
  }

  // N64: the LIVE replica count of the build being replaced, per pool — the capacity the
  // new build must reach before it takes 100% of traffic (step 7a-ter/7b). Only populated
  // where a live count was actually read: dry-run, a new pool, and the NotFound self-heal
  // have no live capacity to match.
  const previousReplicasByPool = new Map<string, number>();

  // Preserve the previous build's LIVE Deployment without rendering it into the new chart.
  // Re-rendering can never be lossless: a build may carry arbitrary user env/envFrom and a pod
  // template emitted by an older adapter. Every field we failed to copy made Helm see a template
  // change and roll the build still serving 100% of traffic. Instead, annotate the top-level
  // Deployment with Helm's keep policy before omitting it from the next release manifest. Helm
  // then neither patches nor deletes it; in particular `.spec.template` stays byte-for-byte the
  // live object and no ReplicaSet is created. Deploy still owns the post-cutover scale-to-zero and
  // old-build cleanup, both of which address the object by its exact versioned name.
  //
  // The versioned Service remains rendered: unlike a Deployment it has no executable template,
  // and retaining it in the release keeps Helm's ordinary lifecycle for a resource whose shape is
  // fully canonical. The HPA follows the same keep transfer as the Deployment so it remains active
  // throughout warm-up and every pre-cutover abort.
  if (previousBuildId && previousBuildId !== buildId) {
    const incomingPoolSet = new Set(pools);
    // Provider capability, not a cluster-wide CRD permission probe: generic operators need no
    // CRD-list RBAC and legitimately have no GKE HealthCheckPolicy object.
    const healthCheckPolicyCrd = buildProvider === "gke";
    for (const poolName of previousPools) {
      const poolPrevName = sanitizeK8sName(`${releaseName}-${poolName}-${previousBuildId}`);
      if (!dryRun) {
        // Read the complete object rather than selecting pod-template fields. The JSON is never
        // rendered back into YAML: it only supplies the live capacity target. That is the key
        // invariant — unfamiliar fields, every env/valueFrom entry, sidecars, scheduling policy,
        // security context, and volumes survive because this process never serializes the spec.
        const r = await execCapture(
          "kubectl",
          ["get", "deployment", poolPrevName, "-n", namespace, "--ignore-not-found", "-o", "json"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (r.exitCode !== 0) {
          throw new Error(
            `Could not read the currently-serving deployment ` +
              `${poolPrevName} (kubectl exited ${r.exitCode}: ${r.stderr.trim()}). ` +
              `It must be transferred out of Helm's release manifest without changing its ` +
              `pod template; refusing to guess. Fix kubectl access and re-run the deploy.`,
          );
        }
        if (!r.stdout.trim()) {
          throw new Error(
            `The recorded pool topology says build "${previousBuildId}" contains pool ` +
              `"${poolName}", but its versioned Deployment ${poolPrevName} is missing. ` +
              `Refusing to run \`helm upgrade\`: fabricating it from the incoming build would ` +
              `run different code under the rollback build's identity.`,
          );
        } else {
          let live: { metadata?: { name?: unknown }; spec?: { replicas?: unknown } };
          try {
            live = JSON.parse(r.stdout) as typeof live;
          } catch (err) {
            throw new Error(
              `Could not parse the live deployment ${poolPrevName}: ` +
                `${err instanceof Error ? err.message : String(err)}. Refusing to run ` +
                `\`helm upgrade\` without proving which Deployment will be retained.`,
            );
          }
          if (live.metadata?.name !== poolPrevName) {
            throw new Error(
              `The live Deployment probe for ${poolPrevName} returned ` +
                `${JSON.stringify(live.metadata?.name)}. Refusing to retain a different object.`,
            );
          }
          const n = live.spec?.replicas;
          if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
            throw new Error(
              `Could not read the live replica count for the currently-serving deployment ` +
                `${poolPrevName} (replicas=${JSON.stringify(n)}). Refusing to guess. Fix ` +
                `kubectl access and re-run the deploy.`,
            );
          }
          previousReplicasByPool.set(poolName, n);

          const keptDeployment = await execCapture(
            "kubectl",
            [
              "patch",
              "deployment",
              poolPrevName,
              "-n",
              namespace,
              "--type=merge",
              "-p",
              JSON.stringify({
                metadata: {
                  annotations: { "helm.sh/resource-policy": "keep" },
                  labels: { [ADAPTER_RELEASE_LABEL]: releaseName },
                },
              }),
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (keptDeployment.exitCode !== 0) {
            throw new Error(
              `Could not preserve the outgoing Deployment ${poolPrevName} across the Helm ` +
                `upgrade (${keptDeployment.stderr.trim() || `kubectl exited ${keptDeployment.exitCode}`}). ` +
                `Refusing to run \`helm upgrade\`: re-rendering it would change the serving ` +
                `pod template and omitting it without keep would delete it. Fix kubectl access ` +
                `and re-run.`,
            );
          }
          console.log(`  → Preserved outgoing Deployment (${poolPrevName}) without re-rendering`);
        }

        // A pool removed or renamed by the incoming build disappears from the generated chart.
        // Transfer the complete stable resource group (Service, PDB, and the optional GKE HCP)
        // out of Helm's deletion set. Service is required for rollback DNS/backend identity;
        // PDB/HCP are optional only because older adapters/generic providers may not emit them.
        if (!incomingPoolSet.has(poolName)) {
          const retained = await retainRemovedPoolResources({
            releaseName,
            pool: poolName,
            namespace,
            healthCheckPolicyCrd,
          });
          console.log(
            `  → Preserved rollback resources for removed pool "${poolName}": ` +
              retained.join(", "),
          );
        }
      } else {
        console.log(
          `    [dry-run] kubectl patch deployment ${poolPrevName} -n ${namespace} ` +
            `--type=merge (set helm.sh/resource-policy=keep and ${ADAPTER_RELEASE_LABEL}, ` +
            `if it exists)`,
        );
        if (!incomingPoolSet.has(poolName)) {
          console.log(
            `    [dry-run] would retain the stable Service/PDB and provider HCP for removed ` +
              `pool "${poolName}" with exact identity checks`,
          );
        }
      }

      // L13: dry-run must not write into the chart — report the planned Service write instead.
      const retainedService = path.join(chartTemplatesDir, `${poolName}-prev-service.yaml`);
      if (dryRun) {
        console.log(`    [dry-run] would write ${retainedService}`);
      } else {
        writeFileSync(
          retainedService,
          renderService({ poolName, buildId: previousBuildId, releaseName }),
        );
      }

      // Keep the outgoing HPA active and byte-for-byte unchanged while its Deployment still
      // carries traffic, but remove it from Helm's next release manifest. Rendering it here
      // would overwrite a rollback-created HPA's incident-sized min/max with the incoming
      // build's config; merely omitting it would let Helm prune it before the new build is ready.
      // The live keep annotation makes the retention transfer explicit. On every abort before
      // the durable state commit the HPA remains present and active; step 7f deletes it only
      // after traffic and state have moved to the new build.
      const outgoingHpa = poolResourceNames(releaseName, poolName, previousBuildId).hpa;
      const keepAnnotation = "helm.sh/resource-policy=keep";
      if (dryRun) {
        console.log(
          `    [dry-run] kubectl patch hpa ${outgoingHpa} -n ${namespace} --type=merge ` +
            `(set ${keepAnnotation} and release/build ownership labels, if it exists)`,
        );
      } else {
        const foundHpa = await execCapture(
          "kubectl",
          ["get", "hpa", outgoingHpa, "-n", namespace, "--ignore-not-found", "-o", "name"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (foundHpa.exitCode !== 0) {
          throw new Error(
            `Could not determine whether the outgoing HPA ${outgoingHpa} exists (kubectl ` +
              `exited ${foundHpa.exitCode}: ${foundHpa.stderr.trim()}). Refusing to run ` +
              `\`helm upgrade\`: omitting an HPA that Helm still owns could delete the ` +
              `autoscaler for build ${previousBuildId} while it is serving traffic. Fix ` +
              `kubectl access and re-run.`,
          );
        }
        if (foundHpa.stdout.trim()) {
          // Older charts did not stamp pool HPAs with the release/build labels destroy needs
          // for a namespace-safe sweep, and rollback can create one imperatively. Transfer the
          // keep annotation and complete adapter identity in one merge patch, without changing
          // Helm's managed-by label or release annotations: a retry must still pass Helm's
          // ownership validation. If admission rejects the patch, neither half is left behind
          // and Helm is never allowed to prune the serving build's autoscaler.
          const keptHpa = await execCapture(
            "kubectl",
            [
              "patch",
              "hpa",
              outgoingHpa,
              "-n",
              namespace,
              "--type=merge",
              "-p",
              JSON.stringify({
                metadata: {
                  annotations: { "helm.sh/resource-policy": "keep" },
                  labels: {
                    [ADAPTER_RELEASE_LABEL]: releaseName,
                    "app.kubernetes.io/name": releaseName,
                    "app.kubernetes.io/component": poolName,
                    "app.kubernetes.io/version": sanitizeK8sName(previousBuildId),
                  },
                },
              }),
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (keptHpa.exitCode !== 0) {
            throw new Error(
              `Could not preserve the outgoing HPA ${outgoingHpa} across the Helm upgrade ` +
                `(${keptHpa.stderr.trim() || `kubectl exited ${keptHpa.exitCode}`}). Refusing ` +
                `to run \`helm upgrade\`: the serving build must keep autoscaling until ` +
                `cutover. Fix kubectl access and re-run.`,
            );
          }
          console.log(`  → Preserved outgoing autoscaler (${outgoingHpa}) through cutover`);
        }
      }
    }
  }

  // 6-pre. Adopt only the exact legacy Valkey Secret that older adapter versions created
  // imperatively. This must happen before Helm sees the chart resource: without the ownership
  // tuple Helm correctly rejects it, while release-wide --take-ownership would also seize any
  // unrelated colliding resource. A dry-run cannot inspect the cluster, so describe the guarded
  // conditional instead of claiming the Secret is present or adoptable.
  if (metadata.cacheEnabled) {
    if (dryRun) {
      console.log(
        `    [dry-run] if Secret ${releaseName}-${VALKEY_SECRET_NAME} exists without Helm ` +
          `ownership, verify its exact legacy adapter identity and atomically assign it to ` +
          `release ${releaseName}; abort on foreign, partial, or mismatched ownership`,
      );
    } else {
      const ownership = await ensureValkeySecretHelmOwnership(releaseName, namespace);
      if (ownership === "adopted") {
        console.log(
          `  → Adopted validated legacy cache Secret ` +
            `${releaseName}-${VALKEY_SECRET_NAME} into Helm release ${releaseName}`,
        );
      }
    }
  }

  // 6-pre-bis. Retain the OUTGOING build's routing manifest as a build-named snapshot
  // ConfigMap BEFORE helm overwrites the stable `<release>-routing-manifest` one — the
  // routing tier is updated in place per build, and rollback re-points it at the
  // snapshot. The snapshot keys off what the routing Deployment is ACTUALLY serving
  // (image tag + mounted ConfigMap), so it stays correct across intervening rollbacks.
  // Best-effort for transient failures (warns, does not block) — but a snapshot NAME
  // collision with a DIFFERENT build's retained manifest throws (see
  // retainLiveRoutingManifest) rather than silently clobbering the rollback target.
  // N30: a retention FAILURE is fatal by default. It used to print one warning and
  // proceed, permanently destroying the rollback target's routing manifest (helm then
  // overwrites the stable ConfigMap), so a rollback to the outgoing build could only
  // revert the edge IMAGE — silently, with the degradation recorded nowhere.
  let unretainedManifestBuild: string | null = null;
  if (!dryRun) {
    const retention = await retainLiveRoutingManifest(releaseName, namespace);
    if (retention.status === "failed") {
      if (!allowUnretainedManifest) {
        throw new Error(
          `Could not retain the outgoing build's routing manifest: ${retention.reason}\n` +
            `Aborting BEFORE helm upgrade — helm overwrites the stable ` +
            `<release>-routing-manifest ConfigMap, so proceeding would permanently destroy ` +
            `the rollback target's manifest and a rollback could only revert the edge image. ` +
            `Nothing was changed. Fix cluster access and re-run, or pass ` +
            `--allow-unretained-manifest to deploy with an image-only rollback path.`,
        );
      }
      unretainedManifestBuild = previousBuildId;
      console.warn(
        `  ! Proceeding WITHOUT a retained routing manifest for the outgoing build ` +
          `(--allow-unretained-manifest): ${retention.reason}. A rollback to ` +
          `${previousBuildId ?? "the previous build"} will revert the routing IMAGE only; ` +
          `the edge keeps this build's routing manifest and mismatched routes fall back to ` +
          `pool-local re-resolution (invariant 1).`,
      );
    }
  }

  // 6-pre-ter (N87). Preserve the LEGACY stable-named internal dispatch Secret across this
  // upgrade. Internal secrets are now per-BUILD (`<release>-ihs-<build>-<digest>`,
  // emit/templates/internal-secret.ts), so the first upgrade under that scheme removes
  // `<release>-internal-header-secret` from the chart — and helm prunes what the chart no
  // longer renders. The build being REPLACED still references that name in its pod template:
  // pruning it would leave the rollback target unable to start a single pod
  // (CreateContainerConfigError on a missing secretKeyRef), and would do the same to any
  // outgoing pod that restarts inside this deploy window — while it is still carrying 100% of
  // traffic. `helm.sh/resource-policy: keep` on the LIVE object is what helm checks, so
  // annotating it here is enough; the sweep in step 7g deletes it once no Deployment
  // references it. A READ failure is not "absent" (the N68 lesson): nothing has been changed
  // yet at this point, so abort cleanly rather than upgrade over an unknown.
  {
    const legacySecret = legacyInternalSecretName(releaseName);
    const keepAnnotation = "helm.sh/resource-policy=keep";
    if (dryRun) {
      console.log(
        `    [dry-run] kubectl annotate secret ${legacySecret} -n ${namespace} ` +
          `${keepAnnotation} --overwrite (if it exists)`,
      );
    } else {
      const found = await execCapture(
        "kubectl",
        ["get", "secret", legacySecret, "-n", namespace, "--ignore-not-found", "-o", "name"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (found.exitCode !== 0) {
        throw new Error(
          `Could not determine whether the legacy internal dispatch Secret ${legacySecret} ` +
            `exists (kubectl exited ${found.exitCode}: ${found.stderr.trim()}). ` +
            `--ignore-not-found makes a genuinely absent Secret exit 0, so this is a ` +
            `connectivity/RBAC failure. Refusing to run \`helm upgrade\`: if that Secret DOES ` +
            `exist, helm would prune it and the build it belongs to could no longer start a ` +
            `pod — bricking the rollback target. Nothing was changed; fix kubectl access and ` +
            `re-run.`,
        );
      }
      if (found.stdout.trim()) {
        const annotated = await execCapture(
          "kubectl",
          ["annotate", "secret", legacySecret, "-n", namespace, keepAnnotation, "--overwrite"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (annotated.exitCode !== 0) {
          throw new Error(
            `Could not annotate the legacy internal dispatch Secret ${legacySecret} with ` +
              `helm.sh/resource-policy=keep (kubectl exited ${annotated.exitCode}: ` +
              `${annotated.stderr.trim()}). \`helm upgrade\` would prune it, leaving the ` +
              `outgoing build unable to start a pod (its pod template references that Secret ` +
              `by name) — so both a restart inside this deploy window and a rollback to it ` +
              `would fail. Nothing was changed; fix kubectl access and re-run.`,
          );
        }
        // Says "legacy", not "the outgoing build's": this step runs on EVERY deploy while that
        // Secret exists, and after the first migration the outgoing build is already on a
        // per-build name — so the Secret being annotated here belongs to some OLDER build still
        // retained. Nothing is leaked by re-annotating; step 7g deletes it once no Deployment
        // references it, and that is the line to look for.
        console.log(`  → Preserved the legacy internal dispatch Secret (${legacySecret})`);
      }
    }
  }

  /**
   * Re-point the routing tier (image + retained manifest snapshot) at the previous build after
   * Helm was invoked. A non-zero Helm exit is not proof that nothing changed: client-side Helm
   * can fail after applying earlier resources, and server-side apply can return an error after
   * admission or transport uncertainty. Recovery therefore starts when mutation is attempted,
   * not only after the command reports success.
   */
  let helmMutationAttempted = false;
  const restoreEdgeToPreviousBuild = async (): Promise<{
    attempted: boolean;
    restored: boolean;
    error: string;
  }> => {
    if (!helmMutationAttempted || !previousBuildId || previousBuildId === buildId) {
      return { attempted: false, restored: false, error: "" };
    }
    try {
      await revertRoutingServiceToBuild({
        releaseName,
        namespace,
        targetBuildId: previousBuildId,
        registry: infra.containerRegistry,
        targetImageDigest: state?.routingImageDigests?.[previousBuildId],
        targetPlatform: state?.targetPlatforms?.[previousBuildId],
        // The outgoing manifest was snapshotted before Helm. Do not retain the uncertain
        // image/manifest pair left by a failed or aborted deploy under either build's name.
        retainCurrentManifest: false,
      });
      return { attempted: true, restored: true, error: "" };
    } catch (err) {
      return {
        attempted: true,
        restored: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  // Human-readable tail for an abort message, describing the edge's ACTUAL state.
  const edgeStatusLines = (r: {
    attempted: boolean;
    restored: boolean;
    error: string;
  }): string[] => {
    if (!r.attempted) return [];
    if (r.restored) {
      return [
        `  The routing edge (ext_proc: image + routing manifest) was reverted to build ` +
          `${previousBuildId}, so edge and pools are consistent.`,
      ];
    }
    return [
      `  WARNING: could not revert the routing edge to build ${previousBuildId}: ` +
        `${r.error || "unknown error"}`,
      `  The edge (ext_proc) is running build ${buildId}'s middleware and routing manifest ` +
        `while the pools serve ${previousBuildId}. Mismatched routes fall back to pool-local ` +
        `re-resolution (invariant 1), but edge middleware is the NEW build's until repaired:`,
      `    kubectl -n ${namespace} set image deployment/` +
        `${routingServiceDeploymentName(releaseName)} routing-service=` +
        `${infra.containerRegistry}/routing-service:${previousBuildId}`,
    ];
  };

  console.log("\n  → Running helm upgrade...");
  // From this point the edge MAY run the new build. Helm overwrites the stable routing-manifest
  // ConfigMap, and a non-zero exit can still mean that write reached the API server. Every later
  // abort, including the Helm call itself, must put the edge back and report the actual result.
  if (!dryRun) {
    helmMutationAttempted = true;
    try {
      await execOrThrow("helm", helmArgs, { timeoutMs: EXEC_TIMEOUTS.cloudOperation });
    } catch (err) {
      const edge = await restoreEdgeToPreviousBuild();
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        [
          `Helm upgrade failed and may have partially applied the new release: ${detail}`,
          ...edgeStatusLines(edge),
        ].join("\n"),
      );
    }
  } else {
    const helm4Args = buildHelmUpgradeArgs({ ...helmArgsBase, helmUpgradeMode: "server-side" });
    console.log(`    [dry-run] helm ${helmArgs.join(" ")}  # Helm 3.2–3.x, client-side upgrade`);
    console.log(`    [dry-run] helm ${helm4Args.join(" ")}  # Helm 4+, server-side upgrade`);
  }

  // 6b. Best-effort CDN verification: confirm the applied HTTPRoute carries the CDN filter.
  // The chart is the source of truth; this is confirmation only, never fatal.
  if (!dryRun && chartHasCdn) {
    const routeCheck = await execCapture(
      "kubectl",
      [
        "get",
        "httproute",
        `${releaseName}-routes`,
        "-n",
        namespace,
        "-o",
        "jsonpath={.spec.rules[*].filters[*].extensionRef.kind}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (routeCheck.exitCode === 0 && routeCheck.stdout.includes("GCPHTTPFilter")) {
      console.log("  → Cloud CDN filter attached to HTTPRoute rules ✓");
    } else {
      console.warn(
        "  ! Could not confirm the Cloud CDN filter on the HTTPRoute (non-fatal). " +
          `Inspect with: kubectl get httproute ${releaseName}-routes -n ${namespace} -o yaml`,
      );
    }
  }

  // NOTE: committed deploy state is NOT written here. Persisting { buildId, previousBuildId }
  // before the new build actually serves would record a never-serving build as "current" —
  // a failed deploy (bad image, stuck rollout, failed cutover) would then leave state
  // pointing at a build that never took traffic, and the next deploy/rollback could delete
  // the real rollback target. State is committed only after a successful cutover (step 7d).

  // 7. Zero-downtime cutover: wait for new pods, then clean up old build
  if (!dryRun) {
    // Match the new build's pods/deployments by their EXACT version label — the same value the
    // cutover patches Services to (`sanitizeK8sName(buildId)`, which stamps `app.kubernetes.io/
    // version` on every pod). The prior match used a 12-char normalized-prefix substring, so an OLD
    // build whose id shared that prefix could satisfy this readiness check; the cutover would then
    // patch Services to the full new label, match zero pods, drain the NEG, and 503 the origin.
    const safeBuildId = sanitizeK8sName(buildId);

    // 7a. Wait for new deployment to be ready
    console.log(`\n  → Waiting for new pods to be ready...`);
    const newDeployResult = await execCapture(
      "kubectl",
      [
        "get",
        "deployments",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    // The routing service carries the same version label but is a stable in-place Deployment,
    // verified separately below — exclude it here by EXACT name (a substring match would
    // also exclude a pool deployment that merely contains "routing-service" in its name).
    const routingDeploy = routingServiceDeploymentName(releaseName);
    const newDeploys = (newDeployResult.stdout?.trim().split("\n") ?? []).filter(
      (n) => n && n !== routingDeploy,
    );

    for (const deployName of newDeploys) {
      console.log(`    Waiting for ${deployName}...`);
      const rollout = await execCapture(
        "kubectl",
        ["rollout", "status", `deployment/${deployName}`, "-n", namespace, KUBECTL_ROLLOUT_TIMEOUT],
        { timeoutMs: EXEC_TIMEOUTS.rollout },
      );
      // The pod-health gate below is the real readiness gate, but don't walk into it on
      // an already-failed rollout — the exit code was previously discarded, so a stuck
      // deployment burned the whole 2-minute health budget before failing.
      if (rollout.exitCode !== 0) {
        // N25: the edge already runs the new build (helm overwrote the stable manifest
        // ConfigMap) — put it back before claiming the previous build is still serving.
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `Deployment ${deployName} did not finish rolling out within 120s. Traffic was ` +
              `NOT switched — the previous build's pools are still serving.`,
            // L14: kubectl rollout output carries controller/admission messages.
            `${sanitizeForTerminal((rollout.stderr || rollout.stdout).trim())}`,
            `Inspect: kubectl logs deployment/${deployName} -n ${namespace} --tail=40`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
    }

    // 7a-bis. The routing service (ext_proc edge) is a stable Deployment updated in place
    // per build, and was historically excluded from readiness. That let a broken image
    // (e.g. a missing @next/routing) crashloop undetected for months while Kubernetes kept
    // the old ReplicaSet serving stale edge code and the deploy reported success. Verify it
    // actually rolls out; a stuck rollout is fatal.
    const rsExists = await execCapture(
      "kubectl",
      ["get", "deployment", routingDeploy, "-n", namespace, "--ignore-not-found", "-o", "name"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (rsExists.exitCode === 0 && rsExists.stdout.trim()) {
      console.log(`    Waiting for ${routingDeploy}...`);
      const rsRollout = await execCapture(
        "kubectl",
        [
          "rollout",
          "status",
          `deployment/${routingDeploy}`,
          "-n",
          namespace,
          KUBECTL_ROLLOUT_TIMEOUT,
        ],
        { timeoutMs: EXEC_TIMEOUTS.rollout },
      );
      if (rsRollout.exitCode !== 0) {
        // The new routing pods can't roll — but the OLD routing pods already picked up the
        // new build's manifest from the (helm-overwritten) stable ConfigMap via kubelet
        // volume sync, so the edge is on the new build regardless. Revert it (N25).
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `Routing service (${routingDeploy}) did not become healthy. Traffic was NOT ` +
              `switched — the previous build's pools are still serving.`,
            `${(rsRollout.stderr || rsRollout.stdout).trim()}`,
            `Inspect: kubectl logs -l app.kubernetes.io/component=routing-service -n ${namespace} --tail=40`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
    }

    // The traffic extension is part of the middleware security boundary. Reconcile and verify
    // it while the active Services still select the previous build; never cut traffic and call
    // the deploy successful with a missing/incomplete ext_proc backend.
    const currentRouteExtJob = routeExtJobName(releaseName, buildId);
    const routeExtJobYaml = path.join(outputDir, "chart", "templates", "route-ext-update-job.yaml");
    if (existsSync(routeExtJobYaml)) {
      const wait = await execCapture(
        "kubectl",
        [
          "wait",
          "--for=condition=complete",
          `job/${currentRouteExtJob}`,
          "-n",
          namespace,
          "--timeout=600s",
        ],
        { timeoutMs: EXEC_TIMEOUTS.rollout },
      );
      if (wait.exitCode !== 0) {
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `ext_proc registration job (${currentRouteExtJob}) did not complete; refusing ` +
              `traffic cutover because middleware may not be wired.`,
            // L14: kubectl wait output carries controller/admission messages.
            `${sanitizeForTerminal((wait.stderr || wait.stdout).trim())}`,
            `Inspect: kubectl logs job/${currentRouteExtJob} -n ${namespace}`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
      console.log("  → ext_proc traffic extension registration job completed ✓");
    }

    // The SAME boundary, for providers that register ext_proc in-cluster. There is no Job to
    // wait on, so before this the generic path verified NOTHING: an EnvoyExtensionPolicy with
    // Accepted=False, a GatewayClass whose controller is not Envoy, or label drift on the proxy
    // selector would all leave traffic 500ing (fail-closed) or silently routed without the edge
    // tier — while the deploy printed success. Middleware not running is the exact class of
    // failure this gate exists for, so it must cover both registration mechanisms.
    const policyYaml = path.join(outputDir, "chart", "templates", "envoy-extension-policy.yaml");
    if (existsSync(policyYaml)) {
      const policyName = `${releaseName}-routing-extproc`;
      // POLL, and require the condition to be CURRENT for the object's generation.
      //
      // A single immediate read was wrong twice over: a freshly reconciled policy may have no
      // status yet (false abort), and an UPDATED policy retains the previous
      // `Accepted=True` until the controller catches up (false pass — the dangerous direction,
      // since it green-lights a cutover whose edge may not be wired). `observedGeneration`
      // vs `metadata.generation` is what distinguishes "accepted" from "accepted, previously".
      //
      // Ancestors are a map-like list, not an ordered one, so `[0]` is not necessarily this
      // release's Gateway/route — select by the Envoy Gateway controller instead.
      let status = "";
      let detail = "";
      for (let attempt = 0; attempt < 30; attempt++) {
        const read = await execCapture(
          "kubectl",
          ["get", "envoyextensionpolicy", policyName, "-n", namespace, "-o", "json"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        detail = (read.stderr || "").trim();
        if (read.exitCode === 0) {
          try {
            const obj = JSON.parse(read.stdout) as {
              metadata?: { generation?: number };
              status?: {
                ancestors?: Array<{
                  controllerName?: string;
                  conditions?: Array<{
                    type?: string;
                    status?: string;
                    observedGeneration?: number;
                  }>;
                }>;
              };
            };
            const generation = obj.metadata?.generation;
            const ancestors = obj.status?.ancestors ?? [];
            const mine =
              ancestors.find((a) => a.controllerName?.includes("gateway.envoyproxy.io")) ??
              ancestors[0];
            const cond = mine?.conditions?.find((c) => c.type === "Accepted");
            const current =
              cond !== undefined &&
              (generation === undefined ||
                cond.observedGeneration === undefined ||
                cond.observedGeneration >= generation);
            if (cond && current) {
              status = cond.status ?? "";
              if (status === "True") break;
              // A definitive False is final — waiting will not fix a rejected policy.
              if (status === "False") break;
            }
          } catch {
            // Unparseable status: keep polling rather than treating it as a verdict.
          }
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (status !== "True") {
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `ext_proc EnvoyExtensionPolicy (${policyName}) is not Accepted (status ` +
              `${status || "unknown"}); refusing traffic cutover because middleware would not ` +
              `run at the edge.`,
            sanitizeForTerminal(detail),
            `Inspect: kubectl describe envoyextensionpolicy ${policyName} -n ${namespace}`,
            `Common causes: the GatewayClass controller is not Envoy Gateway (an ` +
              `EnvoyExtensionPolicy only applies to one), or the Gateway it targets does not exist.`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
      console.log("  → ext_proc EnvoyExtensionPolicy accepted ✓");
    }

    if (compositionSnapshot) {
      console.log("  → Verifying composition-plan readiness...");
      try {
        await waitForCompositionPlanReadiness(compositionSnapshot.plan);
      } catch (error) {
        const edge = await restoreEdgeToPreviousBuild();
        throw new Error(
          [
            `Composition-plan readiness failed; refusing traffic cutover: ` +
              `${error instanceof Error ? error.message : String(error)}`,
            ...edgeStatusLines(edge),
          ].join("\n"),
        );
      }
      console.log("  → Composition-plan resources are ready ✓");
    }

    // 7a-ter. N64: match the outgoing build's CAPACITY before the gate below can pass.
    // The chart renders a new build at its HPA floor (`replicas.min`), while the build
    // being replaced may be sitting far above that after autoscaling under load. Cutting
    // over then hands 100% of traffic to `min` pods with the HPA climbing from behind —
    // and the gate cannot simply WAIT for the higher count, because with no traffic yet
    // nothing would ever scale the new build up. So ask for the capacity explicitly here;
    // the HPA takes over from real load once traffic arrives, and the next helm upgrade
    // re-renders the floor.
    //
    // N67: `helm upgrade` above ALSO installed the new build's own HPA
    // (`<release>-<pool>-<build>-hpa`) with the chart's `replicas.min`/`replicas.max`. When
    // the outgoing build sits ABOVE the new chart's `max` — it autoscaled under load, or a
    // rollback widened it (N26), or the operator lowered the ceiling — the autoscaler
    // reconciles the manual scale below straight back down within one control loop, and the
    // gate at 7b then waits for a count that can NEVER be reached: the deploy burned the
    // whole health budget and aborted BEFORE cutover, i.e. the capacity gate blocked every
    // such deploy. Raising only maxReplicas is not enough: an idle new build has no load,
    // so the HPA's desired count remains its configured minReplicas and it can reconcile a
    // manual `kubectl scale` straight back to that floor. Do not assume a scale-down
    // stabilization window protects the warm-up — that behavior is configurable and is not
    // part of the generated HPA. Temporarily lift BOTH bounds around the capacity gate,
    // remember their exact chart-rendered values, and put both back on EVERY exit path
    // (success AND abort). After cutover, real load under the chart's own bounds decides the
    // count again.
    const warmedHpas: { name: string; min: number; max: number }[] = [];
    const restoredWarmedHpas = new Set<string>();
    const restoreWarmedHpas = async (): Promise<void> => {
      for (const { name, min, max } of warmedHpas) {
        if (restoredWarmedHpas.has(name)) continue;
        let lastFailure = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
          const restore = await execCapture(
            "kubectl",
            [
              "patch",
              "hpa",
              name,
              "-n",
              namespace,
              "--type=merge",
              // Same field-manager rationale as the Service/Deployment patches: helm owns the
              // chart-rendered HPA, so the next `helm upgrade` must not conflict here.
              "--field-manager=helm",
              "-p",
              JSON.stringify({ spec: { minReplicas: min, maxReplicas: max } }),
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (restore.exitCode === 0) {
            restoredWarmedHpas.add(name);
            console.log(
              `  → Restored ${name} to the chart's minReplicas=${min}, maxReplicas=${max}`,
            );
            break;
          }
          lastFailure = restore.stderr.trim() || `exit ${restore.exitCode}`;
        }
        if (!restoredWarmedHpas.has(name)) {
          console.warn(
            `  ! Could not restore ${name} to the chart's minReplicas=${min}, ` +
              `maxReplicas=${max} after 3 attempts (${lastFailure}) — ` +
              `it still has the temporary pre-cutover bounds, so this pool may retain warm-up ` +
              `capacity until the next \`helm upgrade\` re-renders it. Fix it with: kubectl -n ` +
              `${namespace} patch hpa ${name} --type=merge -p ` +
              `'{"spec":{"minReplicas":${min},"maxReplicas":${max}}}'`,
          );
        }
      }
    };

    // A partial warm-up setup cannot safely continue. If the HPA cannot be read, its
    // original bounds cannot be restored; if the temporary patch is rejected, it may
    // immediately lower the idle Deployment again. Restore every pool already prepared and
    // put ext_proc back on the serving build before failing, without waiting out the health
    // budget for a capacity target that is not stable.
    const abortWarmupSetup = async (message: string): Promise<never> => {
      const edge = await restoreEdgeToPreviousBuild();
      await restoreWarmedHpas();
      throw new Error([message, ...edgeStatusLines(edge)].join("\n"));
    };

    // S18: seeded from EVERY configured pool at a floor of one, not only from pools with a
    // live predecessor. previousReplicasByPool has no entry for a pool that is new in this
    // build, nor for any pool on a first deploy, so those pools used to contribute no
    // expectation at all: a sibling's ready pods satisfied `checkedCount > 0`, the gate
    // passed, and cutover then patched EVERY active Service to the new build — leaving the
    // new pool's Service with zero endpoints and serving 503s. One ready pod is the weakest
    // claim worth making ("something in this pool is actually serving"), and for pools that
    // DO have a predecessor the real count below overwrites it immediately.
    const capacityTargets = new Map<string, number>(pools.map((poolName) => [poolName, 1]));
    for (const [poolName, replicas] of previousReplicasByPool) {
      // A removed/renamed pool has no incoming Deployment to warm. It remains in
      // previousReplicasByPool because deploy must preserve and later park it, but adding it
      // here creates an impossible health target and makes every topology-changing deploy time
      // out before cutover. Only common pools inherit outgoing capacity; newly-added pools keep
      // the one-ready-pod floor above.
      if (capacityTargets.has(poolName)) capacityTargets.set(poolName, replicas);
    }

    const shortfalls: string[] = [];
    for (const poolName of pools) {
      const outgoing = previousReplicasByPool.get(poolName);
      const { hpa: newHpaName } = poolResourceNames(releaseName, poolName, buildId);

      // The chart always renders one HPA per pool. A missing HPA after Helm means the release
      // was only partially applied; accepting it would cut traffic to an unautoscaled pool.
      // Probe every pool, including first-deploy and newly added pools, before scaling any of
      // them. `--ignore-not-found` keeps absence machine-readable without hiding read errors.
      const hpaRead = await execCapture(
        "kubectl",
        [
          "get",
          "hpa",
          newHpaName,
          "-n",
          namespace,
          "--ignore-not-found",
          "-o",
          "jsonpath={.metadata.name}|{.spec.minReplicas}|{.spec.maxReplicas}",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (hpaRead.exitCode !== 0) {
        await abortWarmupSetup(
          `Could not read the new build's HPA ${newHpaName} (kubectl exited ` +
            `${hpaRead.exitCode}${hpaRead.stderr.trim() ? `: ${hpaRead.stderr.trim()}` : ""}). ` +
            `Refusing to warm pool "${poolName}" because its original bounds cannot be ` +
            `preserved or its capacity kept stable. Nothing was cut over.`,
        );
      }

      const [hpaFound, hpaMinField, hpaMaxField] = hpaRead.stdout.trim().split("|");
      if (!hpaFound) {
        await abortWarmupSetup(
          `The new build's expected HPA ${newHpaName} was not found after Helm applied the ` +
            `release. Refusing to cut over pool "${poolName}" to a partially applied build. ` +
            `Nothing was cut over.`,
        );
      }
      const hpaMin = Number(hpaMinField);
      const hpaMax = Number(hpaMaxField);
      if (!Number.isInteger(hpaMin) || hpaMin < 1 || !Number.isInteger(hpaMax) || hpaMax < hpaMin) {
        await abortWarmupSetup(
          `Could not parse the new build's HPA ${newHpaName} bounds ` +
            `(minReplicas=${JSON.stringify(hpaMinField ?? "")}, ` +
            `maxReplicas=${JSON.stringify(hpaMaxField ?? "")}). Refusing to warm pool ` +
            `"${poolName}" because its original bounds cannot be restored safely. ` +
            `Nothing was cut over.`,
        );
      }

      if (outgoing !== undefined && hpaMin < outgoing) {
        const warmMin = outgoing;
        const warmMax = Math.max(hpaMax, warmMin);
        console.log(
          `  → Warming ${newHpaName} at minReplicas=${warmMin}, ` +
            `maxReplicas=${warmMax} so the idle new pool keeps the outgoing build's ` +
            `${outgoing} replicas (restored to minReplicas=${hpaMin}, ` +
            `maxReplicas=${hpaMax} after cutover)`,
        );
        const warm = await execCapture(
          "kubectl",
          [
            "patch",
            "hpa",
            newHpaName,
            "-n",
            namespace,
            "--type=merge",
            "--field-manager=helm",
            "-p",
            JSON.stringify({ spec: { minReplicas: warmMin, maxReplicas: warmMax } }),
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (warm.exitCode !== 0) {
          await abortWarmupSetup(
            `Could not set temporary warm-up bounds on ${newHpaName} ` +
              `(minReplicas=${warmMin}, maxReplicas=${warmMax}; ` +
              `${warm.stderr.trim() || `kubectl exited ${warm.exitCode}`}). Refusing to ` +
              `scale or cut over pool "${poolName}" because its HPA could immediately ` +
              `remove the required capacity. Nothing was cut over.`,
          );
        }
        warmedHpas.push({ name: newHpaName, min: hpaMin, max: hpaMax });
      }
    }

    // Prepare every autoscaler before scaling any Deployment. A read or admission failure
    // on a later pool then restores the earlier HPA patches without leaving part of the new
    // build manually scaled above its chart state.
    for (const [poolName, outgoing] of previousReplicasByPool) {
      const { deployment: newDeployName } = poolResourceNames(releaseName, poolName, buildId);
      const expected = capacityTargets.get(poolName) ?? outgoing;
      const cur = await execCapture(
        "kubectl",
        [
          "get",
          "deployment",
          newDeployName,
          "-n",
          namespace,
          "--ignore-not-found",
          "-o",
          "jsonpath={.metadata.name}|{.spec.replicas}",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      const [foundName, replicasField] = cur.stdout.trim().split("|");
      const current = parseInt(replicasField ?? "", 10);
      if (cur.exitCode !== 0 || !foundName || !Number.isFinite(current)) {
        // Don't abort here — the readiness gate below is the authority and will fail
        // closed if the capacity never materializes. Say why we could not pre-scale.
        console.warn(
          `  ! Could not read the new build's replica count for ${newDeployName} ` +
            `(kubectl exited ${cur.exitCode}${cur.stderr.trim() ? `: ${cur.stderr.trim()}` : ""}) ` +
            `— skipping the pre-cutover scale-up to the outgoing build's ${expected} replicas.`,
        );
        continue;
      }
      if (current >= expected) continue;
      console.log(
        `  → Matching outgoing capacity for pool "${poolName}": scaling ${newDeployName} ` +
          `${current} → ${expected} replicas before cutover`,
      );
      const scaleUp = await execCapture(
        "kubectl",
        ["scale", `deployment/${newDeployName}`, "-n", namespace, `--replicas=${expected}`],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (scaleUp.exitCode !== 0) {
        shortfalls.push(
          `${newDeployName}: could not scale to ${expected} ` +
            `(${scaleUp.stderr.trim() || `exit ${scaleUp.exitCode}`})`,
        );
      }
    }
    if (shortfalls.length > 0) {
      // Not fatal on its own: the gate below requires readyReplicas >= the outgoing count
      // per pool, so an unfulfilled scale-up aborts the cutover there with full context.
      for (const s of shortfalls) console.warn(`  ! ${s}`);
    }

    // 7b. Wait for the new build's pods to be READY from inside the cluster.
    // This reads each pod's `Ready` condition — which the kubelet drives from the
    // readinessProbe, and that probe now targets `/readyz` (N32), a 503-until-serving
    // endpoint (instrumentation registered, at least one route module loaded) rather than
    // the hardcoded-200 `/healthz` that could not fail. GCP LB backend health is
    // deliberately NOT waited on here: backend propagation can take 5+ minutes for a new
    // backend, and the NEG health checks gate the endpoints independently after the flip.
    //
    // N64: readiness of SOME pods is not enough — the gate requires at least as many ready
    // pods per pool as the build being replaced is running (previousReplicasByPool). It
    // used to pass on `checkedCount > 0`, i.e. ONE ready pod, so a previous build serving 6
    // cut over to a single pod.
    console.log(`  → Verifying new pods are serving...`);
    let newBuildHealthy = false;
    let lastShortfall = "";
    const maxHealthAttempts = 24; // 2 minutes (5s intervals)
    for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
      let allHealthy = true;
      let checkedCount = 0;
      const readyByPool = new Map<string, number>();
      const podsResult = await execCapture(
        "kubectl",
        [
          "get",
          "pods",
          "-n",
          namespace,
          "-l",
          // The routing service shares the version label; exclude it by its component label
          // (exact — a name substring match would also drop pool pods named similarly).
          `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
          "-o",
          // The component label IS the pool name (deployment.ts stamps it), which is what
          // makes the per-pool count below exact without parsing pod names.
          'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}|{.metadata.labels.app\\.kubernetes\\.io/component}{"\\n"}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (podsResult.exitCode === 0) {
        for (const line of podsResult.stdout.trim().split("\n")) {
          const [podName, ready, component] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          checkedCount++;
          if (ready !== "True") {
            allHealthy = false;
            continue;
          }
          if (component) readyByPool.set(component, (readyByPool.get(component) ?? 0) + 1);
        }
      }
      // Per-pool capacity check against the build being replaced.
      const missing: string[] = [];
      for (const [poolName, expected] of capacityTargets) {
        const ready = readyByPool.get(poolName) ?? 0;
        if (ready < expected) missing.push(`${poolName}: ${ready}/${expected} ready`);
      }
      lastShortfall = missing.join(", ");
      if (allHealthy && checkedCount > 0 && missing.length === 0) {
        console.log(`    All ${checkedCount} new pods ready and serving`);
        newBuildHealthy = true;
        break;
      }
      if (attempt < maxHealthAttempts - 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!newBuildHealthy) {
      // N25 before anything else: the ext_proc edge has been on the new build since
      // `helm upgrade` (stable manifest ConfigMap + in-place routing Deployment), so
      // "no cutover performed" was only ever true of the POOLS.
      const edge = await restoreEdgeToPreviousBuild();
      // N67: and both temporary warm-up bounds go back before we leave — this build is
      // being abandoned, so it must not keep the raised replica floor.
      await restoreWarmedHpas();
      console.error(`\n  DEPLOY FAILED: New build did not become healthy within 2 minutes.`);
      console.error(
        `  The previous build's pools are still serving traffic. No pool cutover was performed.`,
      );
      for (const line of edgeStatusLines(edge)) console.error(line);
      if (lastShortfall) {
        // N64: distinguish "pods aren't ready" from "not ENOUGH pods are ready" — the
        // latter is a capacity gate, and the numbers say which pool fell short of the
        // outgoing build's live count.
        console.error(
          `  Capacity gate: the new build must match the outgoing build's live replica ` +
            `count per pool before cutover — ${lastShortfall}.`,
        );
      }
      console.error("");

      // Try to get more diagnostic info
      const newPods = await execCapture(
        "kubectl",
        [
          "get",
          "pods",
          "-n",
          namespace,
          "-l",
          `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}|{.status.phase}{"\\n"}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (newPods.exitCode === 0 && newPods.stdout.trim()) {
        const podLines = newPods.stdout.trim().split("\n");
        for (const line of podLines) {
          const [podName, phase] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          console.error(`  Pod ${podName}: ${phase}`);
          // N32: probe the READINESS endpoint, not `/healthz`. `/healthz` returns a
          // hardcoded 200 before any routing or handler load — it cannot fail, so asking it
          // here told the operator nothing at exactly the moment they need something.
          // `/readyz` 503s until the pod can actually serve and its body carries a `reason`
          // ("instrumentation register() failed", "route module /x failed to load"), which
          // is the answer to "why is this pod not Ready?" — so print the body too.
          const readyzResult = await execCapture(
            "kubectl",
            [
              "exec",
              podName,
              "-n",
              namespace,
              "--",
              "node",
              "-e",
              `const http=require("http");http.get("http://localhost:3000${POOL_READINESS_PATH}",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (readyzResult.exitCode === 0 && readyzResult.stdout.trim()) {
            // L14: the body is pod-sourced text — strip terminal control characters.
            console.error(
              `  Readiness (${POOL_READINESS_PATH}): ` +
                `${sanitizeForTerminal(readyzResult.stdout.trim()).slice(0, 300)}`,
            );
          } else if (readyzResult.exitCode !== 0) {
            console.error(
              `  Readiness (${POOL_READINESS_PATH}): probe could not run ` +
                `(kubectl exec exited ${readyzResult.exitCode}) — the container may not be ` +
                `running yet; see the pod logs below.`,
            );
          }
          // Get last error from logs
          const logsResult = await execCapture(
            "kubectl",
            ["logs", podName, "-n", namespace, "--tail=20"],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (logsResult.exitCode === 0) {
            const errorLines = logsResult.stdout
              .split("\n")
              .filter(
                (l) =>
                  l.includes("Error") ||
                  l.includes("error") ||
                  l.includes("FATAL") ||
                  l.includes("Cannot find"),
              );
            if (errorLines.length > 0) {
              console.error(`  Errors:`);
              for (const err of errorLines.slice(0, 5)) {
                // L14: pod log lines are cluster-sourced — strip terminal control
                // characters before printing.
                console.error(`    ${sanitizeForTerminal(err.trim()).slice(0, 150)}`);
              }
            } else {
              console.error(
                `  No errors in pod logs. The issue may be GCP health check configuration.`,
              );
            }
          }
        }
      }

      console.error(`\n  Diagnose:  npx adapter-k8s doctor`);
      console.error(`  Tail logs: npx adapter-k8s tail`);
      process.exit(1);
    }

    // 7c. Cut traffic over: patch each active Service selector to the new build.
    // MUST use the exact same sanitizer that stamped the pod labels (sanitizeK8sName,
    // which prepends `b-` when the build id starts with a non-letter). An inline
    // transform that omits the `b-` prefix writes a selector that matches no pods:
    // the Service drains to zero endpoints, its standalone NEG empties, and the LB
    // returns 503 `failed_to_connect_to_backend` for every origin request (only CDN
    // cache hits survive). This bit us on build ids beginning with a digit.
    // (safeBuildId is computed once in step 7 above and reused here.)
    console.log(`  → Switching traffic to new build...`);
    const patchFailures: { pool: string; service: string; stderr: string }[] = [];
    const patchedServices: string[] = [];
    const originalServiceSelectors = new Map<string, Record<string, string>>();

    // A topology-changing rollback may have redirected a stable Service to a fallback pool.
    // Read every selector before changing any of them so cutover restores both component and
    // version, and a partial failure can put the exact live selectors back.
    const serviceDestinations = [
      ...pools.map((pool) => ({ servicePool: pool, targetPool: pool })),
      ...(hasPortableOrigin ? [{ servicePool: "origin", targetPool: defaultPool }] : []),
    ];
    for (const { servicePool } of serviceDestinations) {
      const activeServiceName = sanitizeK8sName(`${releaseName}-${servicePool}`);
      const read = await execCapture(
        "kubectl",
        ["get", "service", activeServiceName, "-n", namespace, "-o", "json"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      let selector: unknown;
      if (read.exitCode === 0) {
        try {
          selector = JSON.parse(read.stdout)?.spec?.selector;
        } catch {
          selector = undefined;
        }
      }
      if (
        !selector ||
        typeof selector !== "object" ||
        Array.isArray(selector) ||
        Object.values(selector).some((value) => typeof value !== "string")
      ) {
        patchFailures.push({
          pool: servicePool,
          service: activeServiceName,
          stderr:
            read.stderr.trim() ||
            `could not read an exact Service selector (kubectl exited ${read.exitCode})`,
        });
        continue;
      }
      originalServiceSelectors.set(activeServiceName, selector as Record<string, string>);
    }

    if (patchFailures.length === 0) {
      for (const { servicePool, targetPool } of serviceDestinations) {
        const activeServiceName = sanitizeK8sName(`${releaseName}-${servicePool}`);
        const originalSelector = originalServiceSelectors.get(activeServiceName)!;
        const patchResult = await execCapture(
          "kubectl",
          [
            "patch",
            "service",
            activeServiceName,
            "-n",
            namespace,
            "--type=json",
            // Keep this imperative cutover under helm's field manager. On Helm 4's server-side
            // path that prevents the next upgrade conflicting on the selector we flip here;
            // Helm 3's client-side merge does not enforce managed-field conflicts.
            // NOTE: --force-conflicts is NOT a valid `kubectl patch` flag (it only exists on
            // `kubectl apply --server-side`); a JSON patch is not server-side apply and needs
            // no conflict override.
            "--field-manager=helm",
            "-p",
            JSON.stringify([
              {
                op: "replace",
                path: "/spec/selector",
                value: {
                  ...originalSelector,
                  "app.kubernetes.io/component": targetPool,
                  "app.kubernetes.io/version": safeBuildId,
                },
              },
            ]),
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (patchResult.exitCode !== 0) {
          patchFailures.push({
            pool: servicePool,
            service: activeServiceName,
            stderr: patchResult.stderr.trim(),
          });
        } else {
          patchedServices.push(activeServiceName);
        }
      }
    }

    // If ANY pool's selector patch failed, some/all Services still point at the old
    // build. Deleting old deployments now would strand those Services with zero healthy
    // endpoints. Abort the cutover, leave the previous build in place, and fail loudly
    // rather than proceeding to the cleanup below and printing "Deploy complete".
    if (patchFailures.length > 0) {
      const revertFailures: string[] = [];
      for (const serviceName of patchedServices) {
        const originalSelector = originalServiceSelectors.get(serviceName)!;
        const revertResult = await execCapture(
          "kubectl",
          [
            "patch",
            "service",
            serviceName,
            "-n",
            namespace,
            "--type=json",
            "--field-manager=helm",
            "-p",
            JSON.stringify([
              {
                op: "replace",
                path: "/spec/selector",
                value: originalSelector,
              },
            ]),
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
      }
      // N25: the pools stay on the previous build, so the edge must too.
      const edge = await restoreEdgeToPreviousBuild();
      // N67: restore the chart's autoscaling bounds on the build we are abandoning.
      await restoreWarmedHpas();
      console.error(`\n  DEPLOY FAILED: traffic was NOT switched to the new build.`);
      console.error(
        `  ${patchFailures.length} of ${serviceDestinations.length} Service selector patch(es) failed:`,
      );
      for (const f of patchFailures) {
        console.error(
          // L14: the patch stderr is apiserver-sourced.
          `    - pool "${f.pool}" (service ${f.service}): ` +
            `${sanitizeForTerminal(f.stderr) || "unknown error"}`,
        );
      }
      if (revertFailures.length > 0) {
        console.error(
          `  WARNING: failed to restore selector(s) for: ${revertFailures.join(", ")}.`,
        );
        console.error(`  Traffic may be split across builds; repair those Services manually.`);
      } else if (patchedServices.length > 0) {
        console.error(`  Any successful selector patches were restored to their prior values.`);
      }
      console.error(`  Old deployments were left in place.`);
      for (const line of edgeStatusLines(edge)) console.error(line);
      console.error(`  No cleanup was performed. Investigate and re-run the deploy.\n`);
      console.error(`  Diagnose:  npx adapter-k8s doctor`);
      // Do NOT write committed state here: traffic did not switch, so the previously-serving
      // build is still current. Recording the new build as current would strand the real
      // rollback target on the next deploy/rollback.
      process.exit(1);
    }

    // 7d. Commit deploy state IMMEDIATELY after the confirmed cutover — before anything
    // else post-switch. Every extra step between the selector patch and this write is a
    // Ctrl-C window in which traffic serves the new build while state still names the old
    // one (the next deploy/rollback would then target the wrong build). Committing ONLY
    // after a confirmed cutover still holds: a failed deploy never records a never-serving
    // build as current. Traffic has already switched; if the cluster ConfigMap write fails
    // we surface it loudly (local was updated) rather than silently diverging.
    try {
      // M13: record the exact Cache-Tag THIS build's pool-server stamps (derived HERE,
      // at its deploy — the only moment code and pods agree), and carry the outgoing
      // build's recorded tag verbatim (it stays the rollback target; re-deriving its tag
      // under newer code is exactly the M13 failure). Pruned to the two builds in play.
      const cdnTags: Record<string, string> = {};
      const recordedPrevTag = previousBuildId ? state?.cdnTags?.[previousBuildId] : undefined;
      if (previousBuildId && recordedPrevTag) {
        cdnTags[previousBuildId] = recordedPrevTag;
      }
      cdnTags[buildId] = cdnTagForBuildId(buildId);
      // Same shape and pruning as cdnTags: keep the two builds still in play, so a rollback
      // to either can pin the routing image by digest instead of reconstructing a tag.
      const routingImageDigests: Record<string, string> = {};
      const recordedPrevDigest = previousBuildId
        ? state?.routingImageDigests?.[previousBuildId]
        : undefined;
      if (previousBuildId && recordedPrevDigest) {
        routingImageDigests[previousBuildId] = recordedPrevDigest;
      }
      if (imageDigests.routingService) {
        routingImageDigests[buildId] = imageDigests.routingService;
      }
      // The stable routing Deployment is updated in place, so rollback must move its
      // architecture selector with the target image. Record this build's exact platform and
      // carry only the outgoing rollback target when its provenance is known.
      const targetPlatforms: Record<string, TargetPlatform> = {};
      const recordedPrevPlatform = previousBuildId
        ? state?.targetPlatforms?.[previousBuildId]
        : undefined;
      if (previousBuildId && recordedPrevPlatform) {
        targetPlatforms[previousBuildId] = recordedPrevPlatform;
      }
      targetPlatforms[buildId] = builtTargetPlatform;
      // N30: carry (and prune to the builds in play) the record of which builds have NO
      // retained routing manifest, so doctor can qualify "rollback ready" honestly.
      const unretainedManifestBuilds = [
        ...(state?.unretainedManifestBuilds ?? []).filter((b) => b === previousBuildId),
        ...(unretainedManifestBuild ? [unretainedManifestBuild] : []),
      ].filter((b, i, all) => all.indexOf(b) === i);
      const compositionPlans: NonNullable<AdapterState["compositionPlans"]> = {};
      const previousCompositionPlan = previousBuildId
        ? state?.compositionPlans?.[previousBuildId]
        : undefined;
      if (previousBuildId && previousCompositionPlan) {
        compositionPlans[previousBuildId] = previousCompositionPlan;
      }
      if (compositionSnapshot) {
        compositionPlans[buildId] = {
          digest: compositionSnapshot.digest,
          targetFingerprint: compositionSnapshot.plan.target.fingerprint,
        };
      }
      // A previous build with no surviving Deployments (previousPools === []) is recorded
      // as ABSENT, not as an empty topology: recordedBuildPools rejects [] as malformed on
      // the next read, and there is nothing for rollback to target anyway.
      const recordablePreviousBuildId = previousPools.length > 0 ? previousBuildId : undefined;
      await writeState(
        projectDir,
        {
          buildId,
          previousBuildId,
          cdnTags,
          ...(Object.keys(routingImageDigests).length > 0 ? { routingImageDigests } : {}),
          poolTopologies: {
            ...(recordablePreviousBuildId
              ? { [recordablePreviousBuildId]: [...previousPools] }
              : {}),
            [buildId]: [...pools],
          },
          ...(hasPortableOrigin || state?.defaultPools
            ? {
                defaultPools: {
                  ...(recordablePreviousBuildId
                    ? {
                        [recordablePreviousBuildId]:
                          state?.defaultPools?.[recordablePreviousBuildId] ?? previousPools[0]!,
                      }
                    : {}),
                  [buildId]: defaultPool,
                },
              }
            : {}),
          targetPlatforms,
          ...(Object.keys(compositionPlans).length > 0 ? { compositionPlans } : {}),
          // The build this deploy just installed serves /readyz, so the NEXT deploy can flip
          // the load balancer's HealthCheckPolicy to readiness without stranding it.
          readinessPathSupported: true,
          ...(unretainedManifestBuilds.length > 0 ? { unretainedManifestBuilds } : {}),
          // N21/N69: the generation this write is based on — writeState treats it as a floor
          // so the stamped value stays above the cluster's even if the pre-write cluster read
          // fails (in CI there is no local state.json to carry it forward). Required by the
          // StateWrite type: rollback used to omit the same value silently.
          basedOnGeneration: state?.generation ?? null,
        },
        releaseName,
        namespace,
      );
    } catch (err) {
      // N67: the temporary warm-up bounds are scoped to the warm-up on this path too — traffic HAS
      // switched, so the chart's own bounds are the right ones to autoscale under, and a
      // deploy that exits here must not leave a raised replica floor for the operator to find.
      await restoreWarmedHpas();
      console.error(`\n  Cutover succeeded, but persisting deploy state failed:`);
      // L14: the error wraps cluster-sourced write/read failures.
      console.error(`  ${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}`);
      console.error(
        `  The new build IS serving, but the cluster ConfigMap was not updated. Restore`,
      );
      console.error(
        `  connectivity and re-run so cluster/local state agree before the next deploy.\n`,
      );
      process.exit(1);
    }

    // 7d-bis. N67: the cutover is durable and the new build is taking 100% of traffic at
    // the outgoing build's capacity — the warm-up is over, so hand the pool back to the
    // chart's autoscaling bounds. Deliberately AFTER the state commit (a failure here must
    // never be able to lose a confirmed cutover) and BEFORE the best-effort steps below, so
    // the HPA is chart-intended on every path out of this function. Scaling DOWN from here
    // is the autoscaler's decision under real load, bounded by the operator's config.
    await restoreWarmedHpas();

    // 7e. State is durable. Now invalidate the PREVIOUS build's Cloud CDN entries
    // (best-effort, non-fatal; TTL self-heals) so its stale content stops serving.
    // Deliberately post-cutover — the new origin must be live before the old entries
    // are dropped — but after the state commit (7d) so a failure here can't leave
    // cluster state pointing at the outgoing build.
    const cdnFilterPath = path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml");
    if (!compositionSnapshot && existsSync(cdnFilterPath) && infra.projectId) {
      try {
        await invalidateCdnBuildTag({
          projectId: infra.projectId,
          releaseName,
          outputDir,
          buildId: previousBuildId ?? undefined,
          // M13: the tag recorded when the OUTGOING build deployed — never re-derived
          // here. Absent (pre-recording state) → cdn-invalidate purges --path=/*.
          recordedTag: previousBuildId ? state?.cdnTags?.[previousBuildId] : undefined,
          run: execCapture,
          log: (m) => console.log(m),
        });
      } catch (err) {
        console.log(
          `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 7f. State is durable and traffic has switched, so it is now safe to scale the previous
    // build down to 0. It served through the rollout and remains as the rollback target.
    // Best-effort: success is already durable (7d) — a failure here warns instead of
    // failing the whole deploy (the previous build just keeps burning replicas until the
    // next deploy or a manual scale-down). The outgoing HPA was transferred out of Helm
    // release-manifest lifecycle before the upgrade so it could remain active while this build
    // served. Delete it
    // now and wait for that deletion to finish BEFORE setting replicas=0; if deletion fails,
    // leave the Deployment alone rather than asking a still-live HPA to fight the scale command.
    if (previousBuildId && previousBuildId !== buildId) {
      let scaleDownFailed = false;
      for (const poolName of previousPools) {
        // The HPA name must come from the SAME suffix-reserving helper the template
        // uses (hpa.ts truncates the base at 59, then appends "-hpa") — concatenating
        // "-hpa" onto the 63-truncated deployment name diverges past that boundary
        // (and can exceed 63 chars), so this delete silently missed the real HPA and
        // the autoscaler rescaled the parked previous build right back up.
        const { deployment: poolPrevName, hpa: poolPrevHpa } = poolResourceNames(
          releaseName,
          poolName,
          previousBuildId,
        );
        const hpaDelete = await execCapture(
          "kubectl",
          ["delete", "hpa", poolPrevHpa, "-n", namespace, "--ignore-not-found"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (hpaDelete.exitCode !== 0) {
          scaleDownFailed = true;
          console.warn(
            `  ! Could not remove outgoing autoscaler ${poolPrevHpa}; leaving ` +
              `${poolPrevName} at its current replica count because that HPA could immediately ` +
              `undo a scale to zero: ${hpaDelete.stderr.trim() || "unknown error"}`,
          );
          continue;
        }
        const scaleDown = await execCapture(
          "kubectl",
          ["scale", `deployment/${poolPrevName}`, "-n", namespace, "--replicas=0"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (scaleDown.exitCode !== 0) {
          scaleDownFailed = true;
          console.warn(
            `  ! Could not scale down ${poolPrevName}: ` +
              `${scaleDown.stderr.trim() || "unknown error"}`,
          );
        }
      }
      if (scaleDownFailed) {
        console.warn(
          `  ! Previous build ${previousBuildId} was NOT fully scaled to 0 — it keeps its ` +
            `replicas until the next deploy. Scale it down manually when convenient.`,
        );
      } else {
        console.log(`  → Previous build scaled to 0 (kept for rollback)`);
      }
    }

    // 7g. Clean up old deployments.
    // The previous build was scaled to 0 in step 7f above (kept as the rollback target).
    // Delete anything that isn't the current or previous build. Classify by EXACT deployment name
    // (reconstructed with the same sanitizer the template uses) rather than a 12-char normalized
    // substring — a shared prefix between two build ids could otherwise delete the wrong build.
    const currentDeployNames = new Set(
      pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${buildId}`)),
    );
    const previousDeployNames = previousBuildId
      ? new Set(previousPools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`)))
      : undefined;

    const allDeploys = await execCapture(
      "kubectl",
      [
        "get",
        "deployments",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (allDeploys.exitCode === 0) {
      for (const name of allDeploys.stdout.trim().split("\n")) {
        // The routing tier is a stable in-place Deployment — never a cleanup candidate.
        // EXACT name match: a substring match would also spare (or, elsewhere, drop) a
        // pool deployment that merely contains "routing-service" in its name.
        if (!name || name === routingDeploy) continue;
        // Keep current build
        if (currentDeployNames.has(name)) continue;
        // Keep previous build (rollback target)
        if (previousDeployNames?.has(name)) {
          console.log(`  → Previous build kept for rollback: ${name}`);
          continue;
        }
        // If we don't know the previous build, we cannot classify this non-current
        // deployment as safe to delete. Be conservative and keep it as a potential
        // rollback target rather than blanket-deleting every non-current build.
        if (!previousBuildId) {
          console.log(
            `  → Conservative cleanup: keeping non-current build "${name}" ` +
              `(previous-build state unknown, cannot classify as safe to delete)`,
          );
          continue;
        }
        // Delete everything else
        console.log(`  → Deleting old build: ${name}`);
        await execCapture("kubectl", ["delete", "deployment", name, "-n", namespace], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        });
        await execCapture("kubectl", ["delete", "service", name, "-n", namespace], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        }).catch(() => {});
        // This build's raw release/pool/buildId parts are unknowable here (`name` is a
        // cluster-listed deployment of a build state no longer tracks), so the HCP name
        // can't go through poolResourceNames. Re-sanitizing the deployment name with the
        // "-hcp" suffix reproduces the template's name exactly: for a base past the
        // 59-char boundary, re-truncating the 63-char deployment name to 59 yields the
        // same prefix the template truncated to (any trailing hyphens the template's
        // strip removed beyond 59 are re-stripped here). Bare `${name}-hcp` diverged
        // there — and could exceed 63 chars, an invalid name kubectl rejects.
        await execCapture(
          "kubectl",
          ["delete", "healthcheckpolicy", sanitizeK8sName(name, "-hcp"), "-n", namespace],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        ).catch(() => {});
      }
    }

    // Stable resources transferred out of Helm's deletion set deliberately survive without
    // rewriting their managed-by label while their pool belongs to either build in play. Once a
    // later successful cutover removes that pool from BOTH topologies, delete the exact
    // adapter-retained Service/PDB/HCP group. This is post-state
    // commit and best-effort: cleanup failure leaks bounded objects but cannot invalidate the
    // serving cutover. The helper validates ownership, labels, names, and selectors before any
    // deletion and keeps the Service as a retry anchor when a companion delete fails.
    try {
      let healthCheckPolicyCrd = false;
      try {
        healthCheckPolicyCrd = await hasHealthCheckPolicyCrd();
      } catch (err) {
        // Post-commit cleanup can still safely classify Service/PDB without cluster-wide CRD
        // permission. Preserve a truthful warning that HCP cleanup was skipped.
        console.warn(
          `  ! Could not classify retained HealthCheckPolicy objects: ` +
            `${err instanceof Error ? err.message : String(err)}. Service/PDB cleanup will ` +
            `continue; any retained HCP was left in place.`,
        );
      }
      const stableCleanup = await cleanupRetainedStablePoolResources({
        releaseName,
        namespace,
        keepPools: new Set([...pools, ...previousPools]),
        healthCheckPolicyCrd,
      });
      for (const deleted of stableCleanup.deleted) {
        console.log(`  → Deleted obsolete retained stable resource: ${deleted}`);
      }
      for (const failure of stableCleanup.failures) {
        console.warn(`  ! Retained stable-resource cleanup incomplete: ${failure}`);
      }
    } catch (err) {
      console.warn(
        `  ! Retained stable-resource cleanup could not run: ` +
          `${err instanceof Error ? err.message : String(err)}. The deploy is committed; ` +
          `the retained objects were left in place for a later retry.`,
      );
    }

    // Clean up OLD route-ext Jobs (K8s Jobs are immutable; each deploy creates a fresh
    // one). Skip the CURRENT job by EXACT name — a fuzzy build-id substring match here
    // (12-char slice vs the name's 10-char slice) previously deleted the running job
    // before it could register the extension, so the traffic ext never got reconciled.
    const oldJobs = await execCapture(
      "kubectl",
      [
        "get",
        "jobs",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=route-ext-job`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (oldJobs.exitCode === 0) {
      for (const jobName of oldJobs.stdout.trim().split("\n")) {
        if (!jobName || jobName === currentRouteExtJob) continue;
        await execCapture("kubectl", ["delete", "job", jobName, "-n", namespace], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        });
      }
    }

    // Prune retained routing-manifest snapshot ConfigMaps that belong to neither the
    // current nor the previous build. Deploy and rollback each retain one (up to ~1 MiB
    // of etcd apiece) and nothing else ever deleted them, so they accumulated
    // unboundedly. Classify by EXACT snapshot name (the same helper that named them);
    // mirror the deployment cleanup's conservatism above — with no known previous
    // build, non-current snapshots can't be classified as safe to delete, so keep them.
    // Best-effort: state is already committed (7d), a failure here only leaks storage.
    if (previousBuildId) {
      const keepSnapshots = new Set([
        routingManifestSnapshotName(releaseName, buildId),
        routingManifestSnapshotName(releaseName, previousBuildId),
      ]);
      const snapshots = await execCapture(
        "kubectl",
        [
          "get",
          "configmaps",
          "-n",
          namespace,
          "-l",
          `app.kubernetes.io/name=${releaseName},` +
            `app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (snapshots.exitCode === 0) {
        for (const cmName of snapshots.stdout.trim().split("\n")) {
          if (!cmName || keepSnapshots.has(cmName)) continue;
          console.log(`  → Deleting old routing-manifest snapshot: ${cmName}`);
          await execCapture("kubectl", ["delete", "configmap", cmName, "-n", namespace], {
            timeoutMs: EXEC_TIMEOUTS.kubectl,
          });
        }
      }

      if (hasPortableOrigin) {
        const keepPlans = new Set([
          compositionPlanConfigMapName(releaseName, buildId),
          compositionPlanConfigMapName(releaseName, previousBuildId),
        ]);
        const plans = await execCapture(
          "kubectl",
          [
            "get",
            "configmaps",
            "-n",
            namespace,
            "-l",
            `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${COMPOSITION_PLAN_COMPONENT}`,
            "-o",
            'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (plans.exitCode === 0) {
          for (const cmName of plans.stdout.trim().split("\n")) {
            if (!cmName || keepPlans.has(cmName)) continue;
            console.log(`  → Deleting old composition plan: ${cmName}`);
            await execCapture("kubectl", ["delete", "configmap", cmName, "-n", namespace], {
              timeoutMs: EXEC_TIMEOUTS.kubectl,
            });
          }
        }
      }
    }

    // N87. Prune internal dispatch Secrets that no Deployment references any more. Each
    // build renders its OWN Secret (`<release>-ihs-<build>-<digest>`) annotated
    // `helm.sh/resource-policy: keep`, so helm never prunes them — deliberately: the
    // retained previous build's pods reference theirs BY NAME and a missing secretKeyRef is
    // CreateContainerConfigError, so pruning on upgrade would brick both a restart in the
    // deploy window and the rollback. Keeping them makes GC this step's job (the
    // routing-manifest snapshots accumulated unboundedly for exactly the same reason).
    //
    // Classify by what is actually REFERENCED, not by build id: that covers the current
    // build, the retained previous build, the LEGACY stable-named Secret still needed by a
    // pre-N87 rollback target, the builds whose Deployments were just deleted above, and
    // leftovers from an earlier incarnation of this release name — with no assumption about
    // which builds exist. Conservative on every failure: an unreadable or unparseable
    // reference set skips the sweep entirely, because deleting a Secret a live pod template
    // needs would brick that build's restarts. Best-effort — state is already committed
    // (7d), so a failure here only leaks a handful of 64-byte Secrets.
    const deploySpecs = await execCapture(
      "kubectl",
      [
        "get",
        "deployments",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName}`,
        "-o",
        "json",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    let referencedSecrets: Set<string> | null = null;
    if (deploySpecs.exitCode === 0 && deploySpecs.stdout.trim()) {
      try {
        const parsed = JSON.parse(deploySpecs.stdout) as {
          items?: {
            spec?: {
              template?: {
                spec?: {
                  containers?: { env?: { valueFrom?: { secretKeyRef?: { name?: string } } }[] }[];
                };
              };
            };
          }[];
        };
        // Every secretKeyRef, not only the internal one — a superset is harmless here
        // because only Secrets carrying the internal-secret component label are candidates.
        referencedSecrets = new Set(
          (parsed.items ?? []).flatMap((d) =>
            (d.spec?.template?.spec?.containers ?? []).flatMap((c) =>
              (c.env ?? [])
                .map((e) => e.valueFrom?.secretKeyRef?.name)
                .filter((n): n is string => typeof n === "string" && n.length > 0),
            ),
          ),
        );
        // Belt and braces: this deploy's own Secret is referenced by definition, and the
        // pod templates it belongs to may not be listed yet on a slow API read.
        referencedSecrets.add(internalSecretName(releaseName, buildId));
        if (previousBuildId) {
          referencedSecrets.add(internalSecretName(releaseName, previousBuildId));
        }
      } catch {
        referencedSecrets = null;
      }
    }
    if (referencedSecrets === null) {
      console.warn(
        `  ! Could not read which Secrets the release's Deployments reference ` +
          `(kubectl exit ${deploySpecs.exitCode}) — skipping the internal-secret prune. ` +
          `Old per-build dispatch Secrets stay until the next successful deploy.`,
      );
    } else {
      const internalSecrets = await execCapture(
        "kubectl",
        [
          "get",
          "secrets",
          "-n",
          namespace,
          "-l",
          `app.kubernetes.io/name=${releaseName},` +
            `app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (internalSecrets.exitCode === 0) {
        for (const secretName of internalSecrets.stdout.trim().split("\n")) {
          if (!secretName || referencedSecrets.has(secretName)) continue;
          console.log(`  → Deleting unreferenced internal dispatch Secret: ${secretName}`);
          await execCapture("kubectl", ["delete", "secret", secretName, "-n", namespace], {
            timeoutMs: EXEC_TIMEOUTS.kubectl,
          });
        }
      }
    }
  }

  // 8. Run domain health checks BEFORE the completion banner (N33). "✓ Deploy complete"
  // used to print first, so a FAIL row underneath it read as cosmetic and the exit code
  // stayed 0 — a release unreachable at its own hostname reported success.
  let domainFailures = 0;
  if (!dryRun) {
    const { runDomainChecks } = await import("./doctor.js");
    // runDomainChecks prints its own rows; the return value (when it reports one) counts
    // the FAIL rows so the exit code can reflect them.
    const domainResult = (await runDomainChecks({ projectDir, releaseName })) as unknown as
      | { failures?: number }
      | undefined;
    if (domainResult && typeof domainResult.failures === "number") {
      domainFailures = domainResult.failures;
    }
  }

  if (domainFailures > 0) {
    console.error(
      `\n  ! Deploy finished (build: ${buildId}) but ${domainFailures} domain check(s) ` +
        `FAILED — the release may not be reachable at its configured host(s). ` +
        `Diagnose: npx adapter-k8s doctor`,
    );
    console.error("");
    process.exit(1);
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  console.log("");
}
