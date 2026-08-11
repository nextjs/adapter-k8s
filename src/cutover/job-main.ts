// src/cutover/job-main.ts
//
// GitOps PR2: the in-cluster cutover Job's entrypoint, bundled to dist/cutover-job.cjs
// and baked into ghcr.io/next-community/adapter-k8s-cutover (same repo, same release
// train). One implementation, two entrypoints (design principle 2): this main wires the
// SAME runCutover the CLI's runDeploy calls — the Job path and the CLI path cannot
// drift — with the three Job-specific differences:
//
//   1. inputs come from the mounted emit-metadata ConfigMap + the state CM + the live
//      cluster (from-cluster.ts), never a local checkout;
//   2. state runs cluster-CM-only (state.ts `clusterOnly` — no persistent
//      `.k8s-adapter/`, inverted recovery semantics);
//   3. a gate failure exits NONZERO after the edge restore (the same restore code —
//      createEdgeRecovery wired straight at revertRoutingServiceToBuild), which the
//      reconciler surfaces as a failed Job; and the failed build id is recorded in the
//      state CM (the poison pill, design §8 risk 4) so a reconciler's retry loop cannot
//      flap the HPA warm-up against a build that will never pass.
//
// PLAIN Job semantics (real-cluster gap #4): nothing here depends on Argo hook ordering.
// The Job races the sync that applied it, and the FIRST gate (D1 exact-version rollout
// wait, 600s budget) is exactly the wait a PostSync hook would have provided.
import { runCutover } from "./run.js";
import { createEdgeRecovery, revertRoutingServiceToBuild } from "./edge.js";
import { CutoverExitError } from "./inputs.js";
import { EXEC_TIMEOUTS, execCapture } from "../cli/exec.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";
import { CUTOVER_ANNOTATION_KEY } from "../emit/templates/service.js";
import { readState, writeState, type AdapterState } from "../cli/state.js";
import {
  buildCutoverInputsFromCluster,
  isAlreadyPromoted,
  readJobEmitMetadata,
  readPreviousReplicas,
} from "./from-cluster.js";
import { loadDeployedCompositionPlan } from "../cli/composition-plan.js";

const DEFAULT_METADATA_PATH = "/etc/adapter-k8s/emit-metadata.json";

/**
 * Record a failed promotion in the state CM (poison pill). Only when prior state EXISTS:
 * the record rides the existing state body unchanged (build pointers still name the
 * serving build — a gate failure never moves them), and on a first deploy there is no
 * serving build to truthfully record, so fabricating a CM would record a never-serving
 * build as current (the exact lie E2's ordering exists to prevent). Best-effort: the
 * poison pill is an optimization against warm-up flapping, and a failed WRITE must never
 * mask the gate failure that is the Job's actual verdict.
 */
async function recordFailedPromotion(opts: {
  state: AdapterState | null;
  buildId: string;
  releaseName: string;
  namespace: string;
}): Promise<void> {
  const { state, buildId, releaseName, namespace } = opts;
  if (!state) {
    console.warn(
      `  ! Not recording the failed promotion of "${buildId}": no prior deploy state ` +
        `exists to carry the record (first-deploy failure). Reconciler retries will ` +
        `re-run the gates.`,
    );
    return;
  }
  if (state.failedPromotions?.includes(buildId)) return; // already poisoned
  try {
    const { generation, updatedAt, ...body } = state;
    void updatedAt;
    await writeState(
      "/tmp",
      {
        ...body,
        failedPromotions: [...(state.failedPromotions ?? []), buildId],
        basedOnGeneration: generation ?? null,
      },
      releaseName,
      namespace,
      { clusterOnly: true },
    );
    console.error(
      `  Recorded failed promotion of build "${buildId}" in the state ConfigMap. ` +
        `Re-syncs will refuse to re-promote it; set cutover.forcePromotion: true (or ` +
        `FORCE_PROMOTION=true) after fixing the build to override.`,
    );
  } catch (err) {
    console.warn(
      `  ! Could not record the failed promotion (${err instanceof Error ? err.message : String(err)}). ` +
        `Reconciler retries will re-run the gates.`,
    );
  }
}

export async function jobMain(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const metadataPath = env.EMIT_METADATA_PATH || DEFAULT_METADATA_PATH;
  const forcePromotion = env.FORCE_PROMOTION === "true" || env.FORCE_PROMOTION === "1";

  const metadata = readJobEmitMetadata(metadataPath);
  // The chart injects RELEASE_NAME/NAMESPACE independently (downward API for the
  // namespace). A mismatch with the mounted metadata means the bundle was applied
  // somewhere it was not emitted for — the cross-wiring class the variant-scoped state
  // file exists to prevent. Refuse before touching anything.
  if (env.RELEASE_NAME && env.RELEASE_NAME !== metadata.releaseName) {
    throw new Error(
      `RELEASE_NAME env ("${env.RELEASE_NAME}") does not match the mounted emit-metadata ` +
        `("${metadata.releaseName}"). Refusing to promote a cross-wired bundle.`,
    );
  }
  if (env.NAMESPACE && env.NAMESPACE !== metadata.namespace) {
    throw new Error(
      `The Job is running in namespace "${env.NAMESPACE}" but the bundle was emitted for ` +
        `"${metadata.namespace}". Refusing to promote a cross-wired bundle.`,
    );
  }
  const { releaseName, namespace, buildId } = metadata;
  console.log(`adapter-k8s cutover Job: release ${releaseName}, build ${buildId}`);

  // ONE cluster-only state read feeds the short-circuit, the poison pill, and the
  // cutover inputs — one read, one consistent view. N20 discipline is inside readState
  // (an unreadable CM throws ClusterStateReadError; only a proven-absent one is null).
  const state = await readState("/tmp", releaseName, { clusterOnly: true, namespace });

  // Cheap-idempotent short-circuit (design §4.3): a re-applied pod for an
  // already-promoted build logs and exits 0 without touching HPAs.
  if (
    await isAlreadyPromoted({
      releaseName,
      namespace,
      buildId,
      pools: metadata.poolTopology,
      state,
    })
  ) {
    console.log(
      `Build "${buildId}" is already promoted (state CM and live selectors agree). ` +
        `Nothing to do.`,
    );
    return 0;
  }

  // Poison pill (design §8 risk 4): this build already failed its gates on this release.
  // Refuse CHEAPLY — before the replica read, before any HPA warm-up — so a reconciler
  // retry loop costs one short-lived pod per interval instead of a capacity wobble on
  // the serving build. Exit nonzero: the Job must keep reading as failed.
  if (!forcePromotion && state?.failedPromotions?.includes(buildId)) {
    console.error(
      `Build "${buildId}" is recorded as a FAILED promotion in the state ConfigMap — a ` +
        `previous cutover Job's gate battery rejected it and restored the edge. Refusing ` +
        `to re-promote it (re-running the HPA warm-up against a build that will not pass ` +
        `is a capacity wobble on the serving build, every sync retry). Fix the build and ` +
        `emit a new one, or override deliberately with cutover.forcePromotion: true ` +
        `(FORCE_PROMOTION=true).`,
    );
    return 3;
  }

  if (state && metadata.previousBuildId && state.buildId !== metadata.previousBuildId) {
    console.warn(
      `  ! emit-metadata says the previous build is "${metadata.previousBuildId}", but the ` +
        `state ConfigMap says "${state.buildId}" is serving. Trusting the cluster (a ` +
        `promotion landed between emit and this sync); gates verify against the live truth.`,
    );
  }

  const compositionSnapshot = await loadDeployedCompositionPlan({
    releaseName,
    namespace,
    buildId,
  });
  if (!compositionSnapshot) {
    throw new Error(
      `Composition plan ConfigMap is missing for build "${buildId}" in namespace ` +
        `"${namespace}". The Job cannot verify HTTPRoute, Certificate, or other ` +
        `target readiness without it; refusing to promote. Rebuild and re-emit so the ` +
        `bundle chart renders the per-build composition-plan ConfigMap.`,
    );
  }

  const inputs = buildCutoverInputsFromCluster({
    metadata,
    state,
    previousReplicasByPool:
      state?.buildId && state.buildId !== buildId
        ? await readPreviousReplicas({
            releaseName,
            namespace,
            previousBuildId: state.buildId,
            previousPools: state.poolTopologies?.[state.buildId] ?? [],
          })
        : new Map(),
    compositionSnapshot,
  });

  // The same restore code as deploy's abort paths, wired DIRECTLY at the module function
  // (the CLI routes it through ./rollback.js only because its orchestration tests mock
  // that boundary). The sync that applied this bundle already overwrote the stable
  // routing-manifest ConfigMap, so the edge MAY be on the new build from the moment this
  // Job starts — arm the recovery immediately (deploy arms it at helm-invocation time;
  // here the reconciler was "helm").
  const edgeRecovery = createEdgeRecovery({
    releaseName,
    namespace,
    buildId,
    previousBuildId: inputs.previousBuildId,
    registry: metadata.registry,
    targetImageDigest: inputs.previousBuildId
      ? state?.routingImageDigests?.[inputs.previousBuildId]
      : undefined,
    targetPlatform: inputs.previousBuildId
      ? state?.targetPlatforms?.[inputs.previousBuildId]
      : undefined,
    revertRoutingService: revertRoutingServiceToBuild,
  });
  edgeRecovery.markHelmMutationAttempted();

  try {
    await runCutover(inputs, {
      restoreEdgeToPreviousBuild: edgeRecovery.restoreEdgeToPreviousBuild,
      edgeStatusLines: edgeRecovery.edgeStatusLines,
    });
  } catch (err) {
    // Every runCutover abort path has already restored the edge and the warmed HPA
    // bounds (N25/N67 — the same code deploy runs). What remains is the Job's verdict:
    // record the poison pill and exit nonzero so the reconciler reports a failed Job.
    if (!(err instanceof CutoverExitError)) {
      console.error(err instanceof Error ? err.message : String(err));
    }
    await recordFailedPromotion({ state, buildId, releaseName, namespace });
    return err instanceof CutoverExitError ? err.code : 1;
  }

  // The bundle stamps every stable active Service `adapter-k8s.io/cutover: pending`
  // ("this selector awaits the Job's promotion"). The promotion is now durable (E2
  // committed), so flip the value to complete — a live object must not read as pending
  // forever, which is indistinguishable from a Job that never ran. The NEXT bundle's
  // sync re-stamps pending, which is again true for that bundle's build. Best-effort:
  // an annotate failure never fails a committed promotion.
  const stableServices = [
    ...metadata.poolTopology.map((pool) => sanitizeK8sName(`${releaseName}-${pool}`)),
    ...(metadata.hasPortableOrigin ? [sanitizeK8sName(`${releaseName}-origin`)] : []),
  ];
  for (const svc of stableServices) {
    const annotated = await execCapture(
      "kubectl",
      [
        "annotate",
        "service",
        svc,
        "-n",
        namespace,
        `${CUTOVER_ANNOTATION_KEY}=complete`,
        "--overwrite",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (annotated.exitCode !== 0) {
      console.warn(
        `  ! Could not mark ${svc} ${CUTOVER_ANNOTATION_KEY}=complete (non-fatal): ` +
          `${sanitizeForTerminal(annotated.stderr.trim()) || `exit ${annotated.exitCode}`}`,
      );
    }
  }

  console.log(`\nPromotion complete: build "${buildId}" is serving.`);
  return 0;
}

// Bundled entrypoint (dist/cutover-job.cjs). Guarded like cli/index.ts so tests can
// import jobMain without triggering a real run.
if (!process.env.VITEST) {
  jobMain().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`\nCutover Job failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
