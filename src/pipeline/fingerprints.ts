// src/pipeline/fingerprints.ts
//
// Pipeline-safe build-identity validation (deploy inventory A2 + B2): target/build
// fingerprint checks and build-id collision guards. Extracted from runDeploy for GitOps
// PR1 — `emit` runs identical validation at render time in CI (refusing a mismatched
// target is more valuable there, not less), and imperative deploy calls the same
// functions so the two can never disagree. Nothing here touches a cluster.
import {
  findBuildTopologyNameCollision,
  findEmittedNameCollision,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";
import {
  DEFAULT_TARGET_PLATFORM,
  parseTargetPlatform,
  type TargetPlatform,
} from "../target-platform.js";
import { assertSafePoolName } from "./images.js";

/**
 * Native dependencies are staged during `next build`, so deploy must consume the artifact's
 * platform instead of re-reading a possibly different environment. Older artifacts did not
 * record it and always staged the amd64 Sharp pair, so they are amd64 artifacts regardless
 * of a deploy-time override.
 */
export function resolveBuiltTargetPlatform(metadata: { targetPlatform?: unknown }): TargetPlatform {
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
  return builtTargetPlatform;
}

/**
 * TARGET FINGERPRINT. The routing tier's image registry is baked into its Deployment template
 * at BUILD time, so copied or pre-variant output can still belong to another target. MEASURED:
 * a Scaleway deploy reused a GKE chart and its routing pods went ImagePullBackOff trying to pull
 * `us-central1-docker.pkg.dev/...` with a 403, after helm had already applied.
 *
 * Refuse before helm instead. This compares what the chart was BUILT for against what we are
 * deploying WITH; a mismatch always means the output on disk belongs to a different target.
 */
export function assertTargetFingerprint(opts: {
  /** Where the build output lives, for the error message (`.k8s-adapter/output`). */
  outputDirRelative: string;
  metadata: { containerRegistry?: unknown; namespace?: unknown };
  deployRegistry: string;
  deployNamespace: string;
}): void {
  const { outputDirRelative, metadata, deployRegistry, deployNamespace } = opts;
  const builtRegistry: string | undefined =
    typeof metadata.containerRegistry === "string" ? metadata.containerRegistry : undefined;
  if (builtRegistry !== undefined && builtRegistry !== deployRegistry) {
    throw new Error(
      `The build output in ${outputDirRelative} was emitted for registry ` +
        `"${builtRegistry}", but this deploy targets "${deployRegistry}". The chart bakes ` +
        `image references at build time, so deploying it would pull another target's images ` +
        `(and fail to authenticate against a registry this cluster cannot reach).\n` +
        `${process.env.ADAPTER_K8S_CONFIG ? `You are using ADAPTER_K8S_CONFIG=${process.env.ADAPTER_K8S_CONFIG}; the selected variant output does not match its infrastructure.\n` : ""}` +
        `Re-run without --skip-build so the chart is emitted for this target.`,
    );
  }
  // Build metadata predating namespace support has no field and therefore targets the
  // historical default namespace.
  const builtNamespace = resolveK8sNamespace(metadata.namespace);
  if (builtNamespace !== deployNamespace) {
    throw new Error(
      `The build output in ${outputDirRelative} was emitted for namespace ` +
        `"${builtNamespace}", but this deploy targets "${deployNamespace}". The ext_proc authority ` +
        `is namespace-qualified at build time, so deploying this chart would make routing ` +
        `callouts target the wrong Service. Re-run without --skip-build so the chart is ` +
        `emitted for this target.`,
    );
  }
}

/** Validate the build's pool topology metadata before any name derived from it is used. */
export function assertDeployablePoolTopology(
  pools: string[],
  defaultPool: string | undefined,
): asserts defaultPool is string {
  if (!Array.isArray(pools)) {
    throw new Error(`build-metadata.json is missing a "pools" array. Did next build run?`);
  }
  for (const poolName of pools) assertSafePoolName(poolName);
  if (!defaultPool || !pools.includes(defaultPool)) {
    throw new Error(
      `build-metadata.json defaultPool must name one of its pools; got ${JSON.stringify(defaultPool)}`,
    );
  }
}

/**
 * N14: an IDENTICAL build id is the `deploymentId` (skew-protection) signature — Next pins
 * the build id to a constant when next.config sets it, so every deploy reuses the serving
 * build's names and a cutover would adopt the running Deployment instead of standing up
 * beside it. The composed-name guard (assertNoCrossBuildNameCollision) can't see this case
 * (it requires differing ids), so name the cause here rather than letting helm silently
 * upgrade in place.
 */
export function assertBuildIdChangedSinceServing(
  buildId: string,
  previousBuildId: string | null,
): void {
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
}

/**
 * The build-time collision guard (adapter.ts) can't see deploy-time state: if any of
 * this build's COMPOSED resource names sanitizes to the SAME K8s name as the
 * currently-serving build's, the two builds' resources become indistinguishable —
 * pods carry identical version labels (split-brain cutover), the keep transfer can target
 * the wrong Deployment, and cleanup can delete the serving build.
 * Comparing the bare sanitized build ids is NOT enough: names collide on the COMPOSED
 * truncated form — a long `<release>-<pool>-` prefix can push the differing part of
 * the build id past the 63-char boundary even when the ids differ well inside their
 * own 63 chars. Compare exactly what the templates emit: the pool Deployment/Service
 * name, its suffix-reserving -hpa/-hcp variants (their truncation boundary sits 4
 * chars earlier), and the routing-manifest snapshot name. Refuse to deploy on any
 * collision while the build ids differ.
 *
 * Compare the exact resource pairs that coexist during this rollout. Projecting both
 * build ids over the incoming pool list invents previous-build resources after a rename.
 */
export function assertNoCrossBuildNameCollision(
  releaseName: string,
  current: { buildId: string; pools: string[] },
  previous: { buildId: string; pools: string[] },
): void {
  const collision = findBuildTopologyNameCollision(releaseName, current, previous);
  if (collision) {
    throw new Error(
      `Build id "${current.buildId}" collides with the currently-serving build "${previous.buildId}" ` +
        `after Kubernetes name sanitization: the ${collision.kind} "${collision.name}" would ` +
        `be named identically for BOTH builds (lowercasing/truncation to the 63-char name ` +
        `limit erased the difference), so the cutover could not distinguish them. Choose a ` +
        `build id that still differs within the truncated name (see generateBuildId in ` +
        `next.config), or shorten the release/pool names.`,
    );
  }
}

/**
 * N62: collisions WITHIN a single build — pools `api` + `api-v2` with buildId `v2` both
 * emit a Deployment/Service named `<release>-api-v2` — must be caught on a FIRST deploy
 * too, so this check is unconditional (the previous-build comparison above cannot see it:
 * it needs two build ids). It runs AFTER that comparison deliberately: over the full
 * emitted name set it ALSO fires on the truncation case, and running it first masked the
 * more specific "collides with the currently-serving build" diagnosis.
 */
export function assertNoSelfNameCollision(
  releaseName: string,
  pools: string[],
  buildId: string,
): void {
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
}
