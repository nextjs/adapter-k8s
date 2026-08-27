// src/cli/deploy.ts
import path from "node:path";
import { isIP } from "node:net";
import { infrastructurePath, outputDirName } from "./infrastructure-validation.js";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import readline from "node:readline";
import { execOrThrow, execCapture, EXEC_TIMEOUTS } from "./exec.js";
import { readState, StateUnavailableError, type AdapterState } from "./state.js";
import { discoverBuildPools, recordedBuildPools } from "./pool-topology.js";
import { retainRemovedPoolResources } from "./stable-pool-resources.js";
// GitOps PR2: the zero-downtime cutover (step 7's Phase D gates + Phase E promotion) lives
// in src/cutover/. Deploy stays the orchestrating CALLER: it performs the pre-helm keep
// transfers and the Phase-B live replica read, then hands the cutover sequence to runCutover.
// The edge-recovery revert function is injected from ./rollback.js (below) so the module
// boundary the orchestration tests mock stays authoritative for "revert the edge".
import { runCutover } from "../cutover/run.js";
import { createEdgeRecovery } from "../cutover/edge.js";
import { CutoverExitError } from "../cutover/inputs.js";
import { retainLiveRoutingManifest, revertRoutingServiceToBuild } from "./rollback.js";

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
// N87: internal dispatch Secrets are per BUILD and annotated `helm.sh/resource-policy: keep`.
// Deploy owns the keep-at-upgrade half of their lifecycle (migrating the legacy stable-named
// one past `helm upgrade`); the pruning half moved to src/cutover/gc.ts with step 7g.
import { legacyInternalSecretName } from "../emit/templates/internal-secret.js";
// Import the SAME sanitizer that stamps pod names and version labels (deployment.ts /
// service.ts). The blue/green cutover patches the active Service selector to this exact
// value, so it MUST match the pod label byte-for-byte — a divergent local copy that
// omitted the `b-` prefix drained the Service to zero endpoints and 503'd the site.
import { sanitizeK8sName } from "../emit/templates/utils.js";
import {
  ADAPTER_RELEASE_LABEL,
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeProbePath,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
  poolResourceNames,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";
import { sanitizeForTerminal } from "./terminal.js";
import { resolveContainerCli } from "./container-runtime.js";
import { parsePoolImageLayout } from "../pool-image-layout.js";
// GitOps PR1: the pipeline-safe steps (A2 fingerprints, A6/A7 image build/push, A8 digest
// resolution, B2 collision guards) live in src/pipeline/ so `emit` can run them in CI.
// Deploy re-exports the moved functions below so existing importers keep working.
import {
  assertSafePoolName,
  buildDockerCommands,
  refreshFetchCacheStaging,
} from "../pipeline/images.js";
import { DIGEST_RE, resolveDeployImageDigests } from "../pipeline/digests.js";
import {
  assertBuildIdChangedSinceServing,
  assertDeployablePoolTopology,
  assertNoCrossBuildNameCollision,
  assertNoSelfNameCollision,
  assertTargetFingerprint,
  resolveBuiltTargetPlatform,
} from "../pipeline/fingerprints.js";

// Moved to src/pipeline/ (GitOps PR1); re-exported here so the import surface of the CLI
// module is unchanged for existing consumers and tests-through-runDeploy.
export {
  assertSafePoolName,
  buildDockerCommands,
  refreshFetchCacheStaging,
  type DockerCommandOptions,
} from "../pipeline/images.js";
export {
  resolveDeployImageDigests,
  resolveImageDigest,
  resolveRegistryDigest,
  resolveRegistryDigestAny,
} from "../pipeline/digests.js";
import {
  assertCompositionPlanInvocation,
  compositionPlanNeedsExplicitConfirmation,
  currentKubeContext,
  loadLocalCompositionPlan,
  preflightCompositionPlan,
} from "./composition-plan.js";
import { evaluateEnvoyGatewayPreflight } from "./envoy-gateway-preflight.js";

// The rollout wait and its measured-on-a-real-cluster rationale moved to src/cutover/gates.ts
// with the Phase D gate battery (GitOps PR2). A2: there are now TWO waits, because the two
// gates await different shapes. D1's pool Deployments are created fresh per build, so their
// pods come up in parallel and 600s stays a constant. D2's routing Deployment is patched in
// place, so it walks one serial surge step per replica (ready + minReadySeconds + the
// kubelet's termination grace) and its budget is derived per deploy from its OWN live replica
// count, floored at 600s and capped at 1800s. See deriveRolloutWaitBudget.

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
        `(kubectl exited ${svcResult.exitCode}${svcResult.stderr.trim() ? `: ${sanitizeForTerminal(svcResult.stderr.trim())}` : ""}). ` +
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
        `${depResult.stderr.trim() ? `: ${sanitizeForTerminal(depResult.stderr.trim())}` : ""}). ${REPAIR}`,
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
    if (!DIGEST_RE.test(digest)) {
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
        timeoutMs: EXEC_TIMEOUTS.build,
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
  // A2 (pipeline/fingerprints.ts): artifact platform, target fingerprint (registry +
  // namespace), and pool-topology validation — identical in emit and deploy by construction.
  const builtTargetPlatform = resolveBuiltTargetPlatform(metadata);
  assertTargetFingerprint({
    outputDirRelative,
    metadata,
    deployRegistry: infra.containerRegistry,
    deployNamespace: namespace,
  });
  assertDeployablePoolTopology(pools, defaultPool);

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
      // Soft Envoy Gateway compat information (live-verified controller range +
      // the 1.8 ListenerSet CRD install-order trap). WARN-only by design: an
      // out-of-range controller is unverified, not known-broken, so it must never
      // block a deploy. Silent when the target doesn't use Envoy Gateway or the
      // controller image is not detectable.
      for (const check of await evaluateEnvoyGatewayPreflight(compositionSnapshot.plan)) {
        if (check.status === "warn") {
          console.warn(`  ! ${check.name}: ${check.message}`);
          if (check.fix) console.warn(`    Fix: ${check.fix}`);
        }
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
          timeoutMs: EXEC_TIMEOUTS.build,
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
  // B2 (pipeline/fingerprints.ts): the deploy-time collision guards. N14 first — an
  // IDENTICAL build id is the `deploymentId` (skew-protection) signature and the composed-
  // name guard below can't see it (it requires differing ids).
  assertBuildIdChangedSinceServing(buildId, previousBuildId);

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
    assertNoCrossBuildNameCollision(
      releaseName,
      { buildId, pools },
      { buildId: previousBuildId, pools: previousPools },
    );
  }

  // N62: self-collisions must be caught on a FIRST deploy too, so this check is
  // unconditional. It runs AFTER the cross-build comparison deliberately: over the full
  // emitted name set it ALSO fires on the truncation case, and running it first masked the
  // more specific "collides with the currently-serving build" diagnosis.
  assertNoSelfNameCollision(releaseName, pools, buildId);

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
              `${poolPrevName} (kubectl exited ${r.exitCode}: ${sanitizeForTerminal(r.stderr.trim())}). ` +
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
                `upgrade (${sanitizeForTerminal(keptDeployment.stderr.trim()) || `kubectl exited ${keptDeployment.exitCode}`}). ` +
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
              `exited ${foundHpa.exitCode}: ${sanitizeForTerminal(foundHpa.stderr.trim())}). Refusing to run ` +
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
                `(${sanitizeForTerminal(keptHpa.stderr.trim()) || `kubectl exited ${keptHpa.exitCode}`}). Refusing ` +
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
            `exists (kubectl exited ${found.exitCode}: ${sanitizeForTerminal(found.stderr.trim())}). ` +
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
              `${sanitizeForTerminal(annotated.stderr.trim())}). \`helm upgrade\` would prune it, leaving the ` +
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

  // GitOps PR2: the edge-recovery pair (restoreEdgeToPreviousBuild / edgeStatusLines) moved
  // verbatim into src/cutover/edge.ts (createEdgeRecovery). The revert function is injected
  // from ./rollback.js so this module boundary — the one the orchestration tests mock —
  // remains the single authority for "revert the edge".
  const edgeRecovery = createEdgeRecovery({
    releaseName,
    namespace,
    buildId,
    previousBuildId,
    registry: infra.containerRegistry,
    targetImageDigest: previousBuildId ? state?.routingImageDigests?.[previousBuildId] : undefined,
    targetPlatform: previousBuildId ? state?.targetPlatforms?.[previousBuildId] : undefined,
    revertRoutingService: revertRoutingServiceToBuild,
  });
  const { restoreEdgeToPreviousBuild, edgeStatusLines } = edgeRecovery;

  console.log("\n  → Running helm upgrade...");
  // From this point the edge MAY run the new build. Helm overwrites the stable routing-manifest
  // ConfigMap, and a non-zero exit can still mean that write reached the API server. Every later
  // abort, including the Helm call itself, must put the edge back and report the actual result.
  if (!dryRun) {
    edgeRecovery.markHelmMutationAttempted();
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

  // 7. Zero-downtime cutover: wait for new pods, then clean up old build.
  // GitOps PR2: the whole sequence — Phase D gates (7a/7a-bis/route-ext/policy/composition/
  // 7a-ter warm-up/7b readiness) and Phase E promotion (7c selector cutover, 7d state commit,
  // 7d-bis warm-up restore, 7e CDN invalidation, 7f scale-down, 7g GC) — lives in
  // src/cutover/run.ts, moved verbatim. Deploy supplies the inputs it used to read inline:
  // the three chart-template existence probes become booleans (the cutover Job supplies them
  // from emit-metadata instead), and previousReplicasByPool carries the Phase-B live replica
  // read (N64). CutoverExitError maps back to the CLI exit codes the inline code used.
  if (!dryRun) {
    try {
      await runCutover(
        {
          projectDir,
          releaseName,
          namespace,
          buildId,
          previousBuildId,
          pools,
          previousPools,
          defaultPool,
          hasPortableOrigin,
          previousReplicasByPool,
          state,
          compositionSnapshot,
          imageDigests,
          builtTargetPlatform,
          unretainedManifestBuild,
          projectId: infra.projectId,
          outputDir,
          hasRouteExtJob: existsSync(
            path.join(outputDir, "chart", "templates", "route-ext-update-job.yaml"),
          ),
          hasEnvoyExtensionPolicy: existsSync(
            path.join(outputDir, "chart", "templates", "envoy-extension-policy.yaml"),
          ),
          cdnEnabled: chartHasCdn,
        },
        { restoreEdgeToPreviousBuild, edgeStatusLines },
      );
    } catch (err) {
      if (err instanceof CutoverExitError) process.exit(err.code);
      throw err;
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

  if (dryRun) {
    console.log(`\n[dry-run] Deploy plan complete (build: ${buildId}) — no cluster mutations.`);
  } else {
    console.log(`\n✓ Deploy complete (build: ${buildId})`);
  }

  console.log("");
}
