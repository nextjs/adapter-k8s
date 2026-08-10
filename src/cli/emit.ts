// src/cli/emit.ts
//
// `adapter-k8s emit` (alias: `deploy --render-only`) — GitOps PR1, Mode 1 of
// plans/gitops-deployment-strategies.md §4.2, shipping `cutover.mode: none` ONLY.
//
// Runs the PIPELINE-SAFE subset of deploy — A2 fingerprints, B2 collision guards, A6/A7
// image build/push (opt-out --skip-push), A8 digest resolution — and writes a hydrated,
// committable bundle to `.k8s-adapter/gitops/`. NO CLUSTER CONTACT WHATSOEVER: no kubectl,
// no get-credentials, no helm upgrade. The only subprocesses are the container CLI + the
// registry probes (CI is exactly where those belong) and an optional LOCAL `helm template`
// for `manifests/all.yaml`.
//
// Under `cutover.mode: none` the bundle's values pin `activeBuildId` to the PREVIOUS build
// — the deploy.ts buildHelmUpgradeArgs trick (`activeBuildId=${sanitize(previous ?? new)}`),
// performed at VALUES-WRITE time instead of `--set` time, so applying the bundle never
// repoints traffic. The operator cuts over per docs/ci-cd.md (Mode 0 with rendered inputs).
import path from "node:path";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { gitopsDirName, infrastructurePath, outputDirName } from "./infrastructure-validation.js";
import { execCapture, execOrThrow, EXEC_TIMEOUTS } from "./exec.js";
import { resolveContainerCli } from "./container-runtime.js";
import { sanitizeForTerminal } from "./terminal.js";
import { assertCompositionPlanInvocation, loadLocalCompositionPlan } from "./composition-plan.js";
import { cdnTagForBuildId } from "../cdn-tags.js";
import { assertSafeCidrList } from "../config.js";
import { SECRET_CHART_FILES } from "../emit/helm.js";
import { renderExternalSecrets } from "../emit/templates/external-secret.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeSecretName,
  resolveK8sNamespace,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import {
  assertSafePoolName,
  buildDockerCommands,
  refreshFetchCacheStaging,
} from "../pipeline/images.js";
import { resolveDeployImageDigests } from "../pipeline/digests.js";
import {
  assertBuildIdChangedSinceServing,
  assertDeployablePoolTopology,
  assertNoCrossBuildNameCollision,
  assertNoSelfNameCollision,
  assertTargetFingerprint,
  resolveBuiltTargetPlatform,
} from "../pipeline/fingerprints.js";
import { parsePoolImageLayout } from "../pool-image-layout.js";

/** Bump when the bundle layout changes shape; consumers refuse versions they don't know. */
export const EMIT_VERSION = 1;

export type EmitSecretsMode = "inline" | "external";

export interface EmitOptions {
  projectDir: string;
  releaseName: string;
  skipBuild?: boolean;
  skipPush?: boolean;
  /** S23: same fail-closed image-integrity posture (and opt-out) as deploy. */
  allowMutableTags?: boolean;
  /**
   * Same fail-closed NetworkPolicy posture as deploy: without it, `strict: true` (the
   * values default) with no configured nodeCidrs REFUSES to render. With it, the bundle
   * renders `strict: false` and (with no podCidrs either) NO NetworkPolicies at all.
   */
  allowNoNetworkPolicy?: boolean;
  /**
   * The build the bundle's stable Service selectors stay pinned to (`cutover.mode: none`).
   * Explicit flag wins over the prior bundle's emit-metadata.json. Validated with
   * assertSafeBuildId at the point of consumption.
   */
  previousBuild?: string | undefined;
  /**
   * Assert a GENUINE first deploy: selectors render at the NEW build. Never inferred —
   * see resolvePreviousBuildId below (N20's new front door).
   */
  firstDeploy?: boolean;
  /** Default: external — the bundle chart carries no secret material (§3 item 3). */
  secrets?: EmitSecretsMode;
}

/** The per-bundle facts file — the emit-side analogue of what state.json records per build. */
export interface EmitMetadata {
  emitVersion: number;
  buildId: string;
  previousBuildId: string | null;
  /**
   * The default pool the bundle's `activeDefaultPool` was pinned to (null on first
   * deploy). Recorded so a RE-EMIT of the same build reproduces the same pin: the
   * previous build's default pool exists nowhere else once the prior bundle has been
   * replaced wholesale — `defaultPool` below describes THIS build, and without this
   * field a re-emit after a pool rename silently flipped `activeDefaultPool` to the new
   * build's pool, pairing it with the still-previous `activeBuildId` in the origin
   * Service selector (a pair that matches nothing — zero endpoints at sync time).
   */
  previousDefaultPool?: string | null;
  releaseName: string;
  namespace: string;
  registry: string;
  digests: Record<string, string>;
  cdnTag: string;
  poolTopology: string[];
  defaultPool: string;
  targetPlatforms: Record<string, string>;
  secretsMode: EmitSecretsMode;
  /**
   * config `imagePullSecrets` baked into every rendered pod spec (from build metadata).
   * Recorded so the bundle README can state the operator prerequisite: these Secrets must
   * exist in the target namespace, delivered by the user's own secrets flow — the bundle
   * never carries them.
   */
  imagePullSecrets?: string[];
  manifests?: { skipped: true; note: string };
}

/**
 * Read and validate the PRIOR bundle's emit-metadata.json.
 *
 * Fail-closed discipline (N20's front door, review-critical): "the file is unreadable or
 * invalid" and "there is no prior bundle" MUST stay distinct. A present-but-corrupt file
 * throws — treating it as absent would let a truncated checkout render first-deploy
 * semantics against a serving cluster. Returns null only when the file genuinely does not
 * exist.
 */
export function readPriorBundleMetadata(
  bundleDir: string,
  expected: { releaseName: string; namespace: string },
): EmitMetadata | null {
  const metadataPath = path.join(bundleDir, "emit-metadata.json");
  if (!existsSync(metadataPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `The prior bundle's ${metadataPath} exists but is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}). Refusing to emit: an ` +
        `unreadable prior bundle is NOT a first deploy. Restore the file (it is committed ` +
        `with the bundle), or delete the whole bundle directory and re-run with an explicit ` +
        `--previous-build <id> / --first-deploy.`,
    );
  }
  const meta = parsed as Partial<EmitMetadata>;
  if (typeof meta.emitVersion !== "number" || meta.emitVersion > EMIT_VERSION) {
    throw new Error(
      `The prior bundle at ${metadataPath} records emitVersion ` +
        `${JSON.stringify(meta.emitVersion)}, which this CLI does not understand (max ` +
        `${EMIT_VERSION}). Upgrade @next-community/adapter-k8s, or pass --previous-build ` +
        `explicitly.`,
    );
  }
  if (typeof meta.buildId !== "string" || !meta.buildId) {
    throw new Error(
      `The prior bundle at ${metadataPath} has no buildId. Refusing to emit: an invalid ` +
        `prior bundle is NOT a first deploy. Fix or remove the bundle, or pass ` +
        `--previous-build <id> explicitly.`,
    );
  }
  // Validated at the point of consumption: this value lands in values.yaml selectors and
  // resource-name comparisons.
  assertSafeBuildId(meta.buildId);
  if (meta.previousBuildId != null) assertSafeBuildId(meta.previousBuildId);
  // Same rule for the pool names this file can feed into values.activeDefaultPool (the
  // origin Service selector) and the cross-build name comparisons.
  if (meta.defaultPool !== undefined) assertSafePoolName(meta.defaultPool);
  if (meta.previousDefaultPool != null) assertSafePoolName(meta.previousDefaultPool);
  // A bundle emitted for another release/namespace must never supply THIS release's
  // previous build — same cross-wiring hazard the variant-scoped state file closes.
  if (meta.releaseName !== undefined && meta.releaseName !== expected.releaseName) {
    throw new Error(
      `The prior bundle at ${metadataPath} was emitted for release ` +
        `${JSON.stringify(meta.releaseName)}, but this emit targets ` +
        `${JSON.stringify(expected.releaseName)}. Refusing to use its previous-build ` +
        `pointer. Remove the stale bundle or pass --previous-build explicitly.`,
    );
  }
  if (meta.namespace !== undefined) {
    assertSafeNamespace(meta.namespace);
    if (meta.namespace !== expected.namespace) {
      throw new Error(
        `The prior bundle at ${metadataPath} was emitted for namespace ` +
          `${JSON.stringify(meta.namespace)}, but this emit targets ` +
          `${JSON.stringify(expected.namespace)}. Refusing to use its previous-build ` +
          `pointer. Remove the stale bundle or pass --previous-build explicitly.`,
      );
    }
  }
  return meta as EmitMetadata;
}

/**
 * Resolve the previous build id for `cutover.mode: none` selector pinning. Precedence:
 *
 *   1. `--previous-build <id>` — explicit, validated;
 *   2. the prior bundle's emit-metadata.json in the output directory (the normal CI flow:
 *      read the last committed bundle). A RE-EMIT of the same build reuses the prior
 *      bundle's OWN previousBuildId, so re-emitting is byte-idempotent (the N50 re-emit
 *      audit) instead of tripping the N14 identical-build guard on its own output;
 *   3. `--first-deploy` — the operator ASSERTS a genuine first deploy; selectors render at
 *      the new build.
 *
 * "No prior bundle found" is NOT "first deploy" — that inference is the N20 incident class
 * arriving through a new door (a shallow/sparse/wrong-directory checkout would render
 * first-deploy semantics against a serving cluster: selectors pinned to the unverified new
 * build, no retained previous build). With none of the three sources this REFUSES.
 */
export function resolvePreviousBuildId(opts: {
  buildId: string;
  previousBuildFlag: string | undefined;
  firstDeploy: boolean;
  priorBundle: EmitMetadata | null;
  bundleDir: string;
}): { previousBuildId: string | null; previousDefaultPool?: string; previousPools?: string[] } {
  const { buildId, previousBuildFlag, firstDeploy, priorBundle, bundleDir } = opts;
  if (previousBuildFlag !== undefined && firstDeploy) {
    throw new Error(
      `--previous-build and --first-deploy contradict each other: one names the serving ` +
        `build, the other asserts nothing is serving. Pass exactly one.`,
    );
  }
  if (previousBuildFlag !== undefined) {
    // H2-equivalent: the value lands in values.yaml selectors and composed-name checks.
    assertSafeBuildId(previousBuildFlag);
    return {
      previousBuildId: previousBuildFlag,
      ...(priorBundle && priorBundle.buildId === previousBuildFlag
        ? {
            previousDefaultPool: priorBundle.defaultPool,
            previousPools: priorBundle.poolTopology,
          }
        : {}),
    };
  }
  if (priorBundle) {
    if (firstDeploy) {
      throw new Error(
        `--first-deploy was passed, but a prior bundle exists at ` +
          `${path.join(bundleDir, "emit-metadata.json")} (build "${priorBundle.buildId}"). ` +
          `A first deploy and an existing bundle contradict each other — if the release ` +
          `really is gone, delete the bundle directory first; otherwise drop --first-deploy.`,
      );
    }
    if (priorBundle.buildId === buildId) {
      // Re-emit of the same build: reproduce the same bundle, byte-identical. The
      // previous build's default pool comes from the prior bundle's OWN recorded pin
      // (previousDefaultPool) — its `defaultPool` describes THIS build, and falling back
      // to it after a pool rename would flip activeDefaultPool to the new build's pool
      // while activeBuildId stays at the previous build: an origin-Service selector pair
      // that matches nothing. The poolTopology likewise describes THIS build, so the
      // cross-build collision check has nothing new to compare.
      return {
        previousBuildId: priorBundle.previousBuildId,
        ...(priorBundle.previousDefaultPool != null
          ? { previousDefaultPool: priorBundle.previousDefaultPool }
          : {}),
      };
    }
    return {
      previousBuildId: priorBundle.buildId,
      previousDefaultPool: priorBundle.defaultPool,
      previousPools: priorBundle.poolTopology,
    };
  }
  if (firstDeploy) return { previousBuildId: null };
  throw new Error(
    `Cannot determine the previous build: no --previous-build flag was given and no prior ` +
      `bundle exists at ${path.join(bundleDir, "emit-metadata.json")}. Refusing to infer a ` +
      `first deploy — a shallow or wrong-directory checkout looks exactly like this, and ` +
      `rendering first-deploy semantics against a serving cluster pins the Service ` +
      `selectors to the unverified new build (the N20 incident class). If this genuinely ` +
      `is the first deploy of this release, assert it with --first-deploy; otherwise pass ` +
      `--previous-build <id> or run emit where the prior bundle is checked out.`,
  );
}

/** Recursively list files under `dir` as sorted relative paths (deterministic order). */
function listFilesRecursive(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

/**
 * Parse the chart's values.yaml (a comment header + a JSON body — see renderValuesYaml)
 * into { header, values } so emit can pin digests/CIDRs/activeBuildId and re-serialize in
 * the identical format.
 */
export function parseChartValues(content: string): {
  header: string;
  values: Record<string, unknown>;
} {
  const jsonStart = content.indexOf("{");
  if (jsonStart === -1) {
    throw new Error(
      `The chart's values.yaml has no JSON body — it was not generated by this adapter's ` +
        `renderValuesYaml. Re-run the build (adapter-k8s emits values as JSON-with-header).`,
    );
  }
  return {
    header: content.slice(0, jsonStart),
    values: JSON.parse(content.slice(jsonStart)) as Record<string, unknown>,
  };
}

export async function runEmit(options: EmitOptions): Promise<void> {
  const {
    projectDir,
    releaseName,
    skipBuild,
    skipPush,
    allowMutableTags,
    allowNoNetworkPolicy,
    previousBuild,
    firstDeploy,
  } = options;
  const secretsMode: EmitSecretsMode = options.secrets ?? "external";
  if (secretsMode !== "external" && secretsMode !== "inline") {
    throw new Error(
      `Invalid --secrets mode ${JSON.stringify(secretsMode as string)}: expected "external" ` +
        `(default — the bundle chart carries no secret material) or "inline" (verbatim ` +
        `chart, for private repos, loudly warned about).`,
    );
  }

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
  const namespace = resolveK8sNamespace(infra.namespace);
  if (infra.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  if (!infra.containerRegistry) {
    throw new Error(
      "infrastructure.json is missing containerRegistry — image tags cannot be formed. " +
        "Run `npx adapter-k8s init` to regenerate it, or set containerRegistry in " +
        ".k8s-adapter/infrastructure.json.",
    );
  }
  const registry = infra.containerRegistry;

  // 1. next build (same opt-out as deploy).
  if (!skipBuild) {
    console.log("\n  → Running next build...");
    await execOrThrow("npx", ["next", "build"], {
      cwd: projectDir,
      timeoutMs: EXEC_TIMEOUTS.cloudOperation,
    });
  }

  // 2. Build metadata + A2 fingerprints + topology (identical to deploy by construction).
  const outputDirRelative = path.join(".k8s-adapter", outputDirName());
  const outputDir = path.join(projectDir, outputDirRelative);
  const metadataPath = path.join(outputDir, "build-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Build metadata not found at ${metadataPath}. Did next build run?`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  const buildId: string = metadata.buildId;
  assertSafeBuildId(buildId);
  const compositionSnapshot = loadLocalCompositionPlan(outputDir, metadata);
  if (compositionSnapshot) {
    assertCompositionPlanInvocation(compositionSnapshot.plan, {
      releaseName,
      namespace,
      buildId,
    });
    if (compositionSnapshot.plan.target.registry.repository !== registry) {
      throw new Error(
        `Composition plan registry ${JSON.stringify(compositionSnapshot.plan.target.registry.repository)} ` +
          `does not match infrastructure registry ${JSON.stringify(registry)}. ` +
          `Rebuild for the selected target.`,
      );
    }
  }
  const pools: string[] = metadata.pools;
  const defaultPool: string | undefined =
    typeof metadata.defaultPool === "string" ? metadata.defaultPool : pools?.[0];
  // config imagePullSecrets, via build metadata — validated at the point of consumption
  // (the names land in the bundle README and emit-metadata.json).
  const imagePullSecrets: string[] = Array.isArray(metadata.imagePullSecrets)
    ? metadata.imagePullSecrets.filter((s: unknown): s is string => typeof s === "string")
    : [];
  for (const name of imagePullSecrets) assertSafeSecretName(name);
  const builtTargetPlatform = resolveBuiltTargetPlatform(metadata);
  assertTargetFingerprint({
    outputDirRelative,
    metadata,
    deployRegistry: registry,
    deployNamespace: namespace,
  });
  assertDeployablePoolTopology(pools, defaultPool);

  const chartSrcDir = path.join(outputDir, "chart");
  if (!existsSync(path.join(chartSrcDir, "values.yaml"))) {
    throw new Error(`No chart at ${chartSrcDir}. Did next build run with the adapter configured?`);
  }

  console.log(`\n  Build ID: ${buildId}`);
  console.log(`  Pools: ${pools.join(", ")}`);

  // 3. Previous-build semantics — BEFORE any push, so a refusal costs nothing.
  const bundleDirRelative = path.join(".k8s-adapter", gitopsDirName());
  const bundleDir = path.join(projectDir, bundleDirRelative);
  const priorBundle = readPriorBundleMetadata(bundleDir, { releaseName, namespace });
  const { previousBuildId, previousDefaultPool, previousPools } = resolvePreviousBuildId({
    buildId,
    previousBuildFlag: previousBuild,
    firstDeploy: firstDeploy === true,
    priorBundle,
    bundleDir,
  });
  if (previousBuildId) {
    console.log(`  Previous build (selectors stay pinned here): ${previousBuildId}`);
  } else {
    console.log(`  First deploy asserted (--first-deploy): selectors render at ${buildId}`);
  }

  // B2 collision guards (pipeline/fingerprints.ts — identical to deploy). N14 first.
  assertBuildIdChangedSinceServing(buildId, previousBuildId);
  if (previousBuildId && previousPools && previousPools.length > 0) {
    for (const p of previousPools) assertSafePoolName(p);
    assertNoCrossBuildNameCollision(
      releaseName,
      { buildId, pools },
      { buildId: previousBuildId, pools: previousPools },
    );
  } else if (previousBuildId) {
    // --previous-build without a prior bundle: the previous topology is unknowable without
    // a cluster (which emit never contacts). The self-collision check below still runs;
    // deploy re-runs the full cross-build check with cluster knowledge at cutover time.
    console.warn(
      `  ! Previous build "${previousBuildId}" has no prior bundle recording its pool ` +
        `topology — the cross-build name-collision check is skipped (emit has no cluster ` +
        `to ask). The imperative cutover path re-checks it.`,
    );
  }
  assertNoSelfNameCollision(releaseName, pools, buildId);

  // 4. CIDRs — from CONFIG, never discovery (deploy inventory A4 "replaced"). Fail-closed:
  // the values default is `strict: true`, and the chart {{- fail }}s at render time when
  // strict has no nodeCidrs — surface that here, at emit time, with the fix spelled out.
  const nodeCidrs: string[] = Array.isArray(metadata.nodeCidrs)
    ? metadata.nodeCidrs.filter((c: unknown): c is string => typeof c === "string")
    : [];
  const podCidrs: string[] = Array.isArray(metadata.podCidrs)
    ? metadata.podCidrs.filter((c: unknown): c is string => typeof c === "string")
    : [];
  // Validated at the point of consumption: these land in the bundle's values arrays that
  // the NetworkPolicy template splices into rendered YAML.
  assertSafeCidrList(nodeCidrs, "networkPolicy.nodeCidrs (via build metadata)");
  assertSafeCidrList(podCidrs, "networkPolicy.podCidrs (via build metadata)");
  let strict = true;
  if (nodeCidrs.length === 0) {
    if (!allowNoNetworkPolicy) {
      throw new Error(
        `emit cannot render the strict NetworkPolicy posture: no node CIDRs are configured. ` +
          `emit performs NO cluster discovery (that is the point — see ` +
          `plans/gitops-deployment-strategies.md §4.2), so the ranges must come from config: ` +
          `set networkPolicy.nodeCidrs (and optionally networkPolicy.podCidrs) in ` +
          `adapter.config — docs/configuration.md — and rebuild. provider.generic.nodeCidrs ` +
          `also still maps in. Or pass --allow-no-network-policy to emit a bundle WITHOUT ` +
          `network isolation, deliberately.`,
      );
    }
    strict = false;
    console.warn(
      "  ! No node CIDRs configured — emitting with strict NetworkPolicies OFF " +
        "(--allow-no-network-policy). " +
        (podCidrs.length > 0
          ? "The broad pod-isolation posture still renders from networkPolicy.podCidrs."
          : "With no podCidrs either, the bundle renders NO NetworkPolicies at all: the " +
            "routing service stays reachable from in-cluster pods."),
    );
  }

  // 5. A6/A7 — image build/push (CI is exactly where these belong). --skip-push opts out.
  const containerStrategy = metadata.containerStrategy ?? "traced-assets";
  const poolImageLayout = parsePoolImageLayout(metadata.poolImageLayout);
  let containerCli = "docker";
  if (!skipPush) {
    containerCli = await resolveContainerCli();
    if (containerCli !== "docker") console.log(`\n  Container runtime: ${containerCli}`);
    refreshFetchCacheStaging(projectDir, outputDir, {
      distDir: metadata.distDir,
      pools,
      containerStrategy,
      poolImageLayout,
    });
    const dockerCommands = buildDockerCommands({
      pools,
      buildId,
      registry,
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
      await execOrThrow(cmd.command, cmd.args, {
        cwd: projectDir,
        timeoutMs: EXEC_TIMEOUTS.cloudOperation,
      });
    }
  }

  // 6. A8 — digest resolution, same fail-closed posture and same refs as deploy.
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
  const imageDigests = await resolveDeployImageDigests({
    refs,
    projectId: infra.projectId ?? "",
    allowMutableTags: allowMutableTags ?? false,
    containerCli,
    targetPlatform: builtTargetPlatform,
    ...(compositionSnapshot
      ? { digestLookup: compositionSnapshot.plan.target.registry.digestLookup }
      : {}),
  });
  const pinned = Object.keys(imageDigests).length;
  if (pinned > 0) console.log(`    Pinned ${pinned} image(s) to immutable digests`);

  // 7. Assemble the bundle. Replaced WHOLESALE (the repo flow commits it that way), so a
  // stale file from a removed pool can never linger.
  console.log(`\n  → Writing GitOps bundle to ${bundleDirRelative}/`);
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(path.join(bundleDir, "chart"), { recursive: true });
  mkdirSync(path.join(bundleDir, "values"), { recursive: true });

  // 7a. chart/ — verbatim, minus the secret templates under --secrets external (§3 item 3:
  // committing chart/ commits credentials, and the 0600 mode does not survive Git).
  const chartFiles = listFilesRecursive(chartSrcDir);
  const excluded: string[] = [];
  for (const rel of chartFiles) {
    if (secretsMode === "external" && SECRET_CHART_FILES.has(rel)) {
      excluded.push(rel);
      continue;
    }
    const dest = path.join(bundleDir, "chart", rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    // cpSync preserves the source mode — the 0600 secret files stay 0600 under inline.
    cpSync(path.join(chartSrcDir, rel), dest);
  }
  if (secretsMode === "external") {
    const includeValkey = chartFiles.includes("templates/valkey-secret.yaml");
    writeFileSync(
      path.join(bundleDir, "chart", "templates", "external-secret.yaml"),
      renderExternalSecrets({ releaseName, buildId, includeValkey }),
    );
    console.log(
      `    Secrets: external — omitted ${excluded.join(", ") || "(none present)"}; ` +
        `emitted templates/external-secret.yaml (gated on externalSecrets.storeName). ` +
        `See the bundle README for the required Secret names/keys.`,
    );
  } else {
    console.warn(
      `\n  !!! WARNING: --secrets inline — the bundle chart contains REAL credentials ` +
        `(templates/internal-secret.yaml${chartFiles.includes("templates/valkey-secret.yaml") ? ", templates/valkey-secret.yaml" : ""}).\n` +
        `      Committing this bundle commits those secrets, and Git does not preserve the ` +
        `0600 file mode. Only do this for a private repo whose readership you would trust ` +
        `with the dispatch secret itself. Prefer --secrets external.\n`,
    );
  }

  // 7b. values/values.yaml — the chart's own values with the per-release facts pinned:
  // registry/tag, resolved digests, config CIDRs, and — the load-bearing line —
  // activeBuildId at the PREVIOUS build (deploy.ts's buildHelmUpgradeArgs trick, done at
  // values-write time), so applying the bundle never repoints traffic.
  const { header, values } = parseChartValues(
    readFileSync(path.join(chartSrcDir, "values.yaml"), "utf-8"),
  );
  const global = values.global as {
    image: Record<string, string>;
    networkPolicy: Record<string, unknown>;
  };
  global.image.registry = registry;
  global.image.tag = buildId;
  global.networkPolicy.podCidrs = podCidrs;
  global.networkPolicy.nodeCidrs = nodeCidrs;
  global.networkPolicy.strict = strict;
  const valuePools = values.pools as Record<string, { image: Record<string, string> }>;
  for (const [key, digest] of Object.entries(imageDigests)) {
    if (key === "routingService") {
      (values.routingService as { image: Record<string, string> }).image.digest = digest;
    } else if (valuePools[key]) {
      valuePools[key].image.digest = digest;
    }
  }
  values.activeBuildId = sanitizeK8sName(previousBuildId ?? buildId);
  // The pin actually written (recorded in emit-metadata.json as previousDefaultPool so a
  // re-emit of the same build reproduces it byte-identically — see EmitMetadata).
  let pinnedDefaultPool: string | null = null;
  if (values.activeDefaultPool !== undefined) {
    values.activeDefaultPool = previousBuildId
      ? (previousDefaultPool ?? (values.activeDefaultPool as string))
      : (defaultPool as string);
    if (previousBuildId) pinnedDefaultPool = values.activeDefaultPool as string;
  }
  const valuesPath = path.join(bundleDir, "values", "values.yaml");
  writeFileSync(valuesPath, header + JSON.stringify(values, null, 2));

  // 7c. manifests/all.yaml — `helm template` of chart+values, for raw-YAML appliers. Helm
  // is optional at emit time: absent ⇒ skip with a note in emit-metadata.json; present but
  // FAILING ⇒ hard error (a bundle whose chart cannot render should never be committed).
  let manifestsNote: { skipped: true; note: string } | undefined;
  const helmProbe = await execCapture("helm", ["version", "--short"], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (!helmProbe || helmProbe.exitCode !== 0) {
    manifestsNote = {
      skipped: true,
      note:
        "helm was not available at emit time, so manifests/all.yaml was not rendered. " +
        "The chart/ + values/ pair is complete; re-run emit with helm on PATH to add the " +
        "pre-rendered manifests.",
    };
    console.warn(`    ! ${manifestsNote.note}`);
  } else {
    const rendered = await execCapture(
      "helm",
      [
        "template",
        releaseName,
        path.join(bundleDir, "chart"),
        "--namespace",
        namespace,
        "-f",
        valuesPath,
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (rendered.exitCode !== 0) {
      throw new Error(
        `helm template failed on the emitted bundle (exit ${rendered.exitCode}): ` +
          `${sanitizeForTerminal(rendered.stderr.trim())}. The bundle is incomplete — fix ` +
          `the render error before committing anything.`,
      );
    }
    mkdirSync(path.join(bundleDir, "manifests"), { recursive: true });
    writeFileSync(path.join(bundleDir, "manifests", "all.yaml"), rendered.stdout);
    console.log(`    Rendered manifests/all.yaml (helm template)`);
  }

  // 7d. emit-metadata.json — the per-bundle facts (and the NEXT emit's previous-build
  // source). Keys are written in a fixed order and digests sorted, so a re-emit of the
  // same inputs is byte-identical (no timestamps anywhere in the bundle — the same N68
  // determinism rule values.yaml follows).
  const emitMetadata: EmitMetadata = {
    emitVersion: EMIT_VERSION,
    buildId,
    previousBuildId,
    ...(pinnedDefaultPool !== null ? { previousDefaultPool: pinnedDefaultPool } : {}),
    releaseName,
    namespace,
    registry,
    digests: Object.fromEntries(
      Object.keys(imageDigests)
        .sort()
        .map((k) => [k, imageDigests[k]!]),
    ),
    cdnTag: cdnTagForBuildId(buildId),
    poolTopology: pools,
    defaultPool: defaultPool as string,
    targetPlatforms: { [buildId]: builtTargetPlatform },
    secretsMode,
    ...(imagePullSecrets.length > 0 ? { imagePullSecrets } : {}),
    ...(manifestsNote ? { manifests: manifestsNote } : {}),
  };
  writeFileSync(
    path.join(bundleDir, "emit-metadata.json"),
    JSON.stringify(emitMetadata, null, 2) + "\n",
  );

  // 7e. README.md — what a reviewer of the bundle PR needs, including (under external
  // secrets) the exact Secret names/keys the operator must make exist.
  writeFileSync(path.join(bundleDir, "README.md"), renderBundleReadme(emitMetadata));

  console.log(
    `\n  ✓ Bundle written. Commit ${bundleDirRelative}/ and apply it per docs/ci-cd.md ` +
      `(cutover.mode: none — the sync never repoints traffic; the documented cutover does).`,
  );
}

/** The bundle's own README — deterministic (per-build facts only, no timestamps). */
export function renderBundleReadme(meta: EmitMetadata): string {
  const pullSecretsSection =
    meta.imagePullSecrets && meta.imagePullSecrets.length > 0
      ? `## Image pull secrets (operator prerequisite)

Every pod spec in this bundle references \`imagePullSecrets\`: ${meta.imagePullSecrets
          .map((s) => `\`${s}\``)
          .join(", ")}.
The named \`kubernetes.io/dockerconfigjson\` Secret(s) must EXIST in namespace
\`${meta.namespace}\` before this bundle is applied — deliver them via your secrets flow
(\`kubectl create secret docker-registry\`, ExternalSecrets, SealedSecrets). The bundle
never carries them, and a missing one is ImagePullBackOff on every pod that references it.

`
      : "";
  const secretSection =
    meta.secretsMode === "external"
      ? `## Secrets (externalized)

This bundle's chart deliberately carries NO secret material. The pods reference these
Secrets by name via \`secretKeyRef\`; make them exist by any mechanism you trust
(ExternalSecrets via \`templates/external-secret.yaml\` — set \`externalSecrets.storeName\`
in values — SealedSecrets, SOPS, or \`kubectl create secret\`):

| Secret name | Key | Value |
| --- | --- | --- |
| \`${meta.releaseName}\`-scoped per-build dispatch secret (see \`emit-metadata.json\` buildId; name rendered in \`templates/external-secret.yaml\`) | \`secret\` | the deterministic per-build dispatch secret: HMAC-SHA256 of \`"<release>\\0<buildId>"\` under the operator key (\`ADAPTER_K8S_INTERNAL_SECRET_KEY\` / \`.k8s-adapter/internal-secret.key\`). The build output's \`chart/templates/internal-secret.yaml\` (gitignored, mode 0600) holds the rendered value for one-time loading into your store. |
| \`${meta.releaseName}-valkey\` (only when the cache is enabled) | \`url\` (required), \`auth\`, \`ca\` (optional) | the Valkey/Redis connection URL, AUTH string, and server CA. |

A build's dispatch Secret must OUTLIVE the sync that applies the next build's bundle —
the retained previous build's pods reference it by name (rollback target). Keep
superseded build-scoped entries in your store until their build is garbage-collected.
`
      : `## Secrets (INLINE — read this)

This bundle was emitted with \`--secrets inline\`: \`chart/templates/internal-secret.yaml\`
(and the Valkey Secret, when present) contain REAL credentials. Committing this bundle
commits those secrets. Rotate them if this repo's readership ever widens.
`;

  return `# GitOps bundle — ${meta.releaseName} @ ${meta.buildId}

Generated by \`adapter-k8s emit\` (cutover.mode: none). Replace this directory WHOLESALE
per release; never hand-edit individual files (the routing tier refuses a manifest that
does not match its build, by design).

- **Build:** \`${meta.buildId}\`
- **Selectors pinned to:** \`${meta.previousBuildId ?? `${meta.buildId} (first deploy)`}\`
- **Namespace:** \`${meta.namespace}\`
- **Registry:** \`${meta.registry}\`
- **Pools:** ${meta.poolTopology.map((p) => `\`${p}\``).join(", ")} (default \`${meta.defaultPool}\`)

## Cutover model (mode: none)

\`values/values.yaml\` pins \`activeBuildId\` to the PREVIOUS build, so applying this
bundle stands the new build up WITHOUT repointing traffic. Cut over per docs/ci-cd.md
(verify \`/readyz\` per pod, then patch the stable Service selectors), or use
\`adapter-k8s deploy\` from a credentialed machine. Do NOT point an auto-syncing
reconciler at this bundle without the ignore rules described in
plans/gitops-deployment-strategies.md — drift correction of the selector after a manual
cutover is an outage.

${pullSecretsSection}${secretSection}`;
}
