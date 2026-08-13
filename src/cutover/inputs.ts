// src/cutover/inputs.ts
// GitOps PR2: the cutover/promotion inputs boundary. Everything the extracted cutover
// orchestrators (src/cutover/run.ts) used to read from the local checkout — chart-template
// existence probes, infrastructure.json fields, build metadata — arrives here as plain
// values. The CLI populates them from disk (the from-local-checkout implementation);
// the in-cluster cutover Job (next phase) populates the same shape from the emit-metadata
// ConfigMap mounted into its pod, so the orchestrators themselves never touch a filesystem.
import type { AdapterState } from "../cli/state.js";
import type { LoadedCompositionPlan } from "../cli/composition-plan.js";
import type { TargetPlatform } from "../target-platform.js";

/**
 * Cutover/revert failure that the CLI must surface as a process exit code. The
 * orchestrators in run.ts never call `process.exit` themselves (the cutover Job maps a
 * failure to a nonzero container exit instead): every abort path first restores the edge
 * and the warmed HPAs exactly as the inline deploy/rollback code did, prints the same
 * diagnostics, and then throws this. Callers (runDeploy/runRollback) translate it to
 * `process.exit(code)` so the CLI's observable behavior is unchanged.
 */
export class CutoverExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`cutover aborted with exit code ${code}`);
    this.name = "CutoverExitError";
    this.code = code;
  }
}

/** Outcome of an edge-revert attempt (see createEdgeRecovery in edge.ts). */
export interface EdgeRestoreResult {
  attempted: boolean;
  restored: boolean;
  error: string;
}

/**
 * The shared abort machinery every gate depends on: N25 (the ext_proc edge has been on the
 * new build since `helm upgrade` overwrote the stable manifest ConfigMap) means every abort
 * path must put the edge back before claiming the previous build is still serving, and
 * report the edge's ACTUAL state in the abort message.
 */
export interface EdgeRecovery {
  restoreEdgeToPreviousBuild(): Promise<EdgeRestoreResult>;
  edgeStatusLines(r: EdgeRestoreResult): string[];
}

/** Injected collaborators for runCutover — see the note on createEdgeRecovery (edge.ts). */
export interface CutoverDeps {
  restoreEdgeToPreviousBuild: EdgeRecovery["restoreEdgeToPreviousBuild"];
  edgeStatusLines: EdgeRecovery["edgeStatusLines"];
}

/**
 * Everything the Phase D gate battery + Phase E cutover need. Local-disk reads that the
 * inline deploy code performed are parameterized here:
 * - `hasRouteExtJob` / `hasEnvoyExtensionPolicy` / `cdnEnabled` replace the three
 *   `existsSync(<outputDir>/chart/templates/…)` probes (route-ext-update-job.yaml,
 *   envoy-extension-policy.yaml, cdn-http-filter.yaml). The Job supplies them from
 *   emit-metadata instead of a chart directory it does not have.
 * - `outputDir` remains only for invalidateCdnBuildTag's `cdn-invalidation.json` sidecar
 *   read (cdn-invalidate.ts); the Job-side implementation lifts that to a metadata fact.
 * - `projectDir` remains for the dual (local + cluster) state store; the Job runs
 *   cluster-CM-only (state.ts, next phase).
 */
export interface CutoverInputs {
  projectDir: string;
  /**
   * Which store(s) the E2 state commit writes. "dual" (default — the CLI path) keeps
   * today's local-file + cluster-ConfigMap behavior; "cluster-only" is the in-cluster
   * cutover Job's mode (no persistent `.k8s-adapter/`, so writeState skips the local
   * file and INVERTS the recovery semantics — see state.ts).
   */
  stateStore?: "dual" | "cluster-only";
  releaseName: string;
  namespace: string;
  buildId: string;
  previousBuildId: string | null;
  /** Incoming build's pool topology (build-metadata / emit-metadata). */
  pools: string[];
  /** Outgoing build's pool topology (state CM `poolTopologies`, N70). */
  previousPools: string[];
  defaultPool: string;
  hasPortableOrigin: boolean;
  /**
   * N64: the LIVE replica count of the build being replaced, per pool — read from the
   * cluster before `helm upgrade` (the keep-transfer loop's fail-closed `spec.replicas`
   * read). The Job re-hosts that read as its own pre-gate step.
   */
  previousReplicasByPool: Map<string, number>;
  /** Committed deploy state as read at the start of the operation (null = first deploy). */
  state: AdapterState | null;
  compositionSnapshot: LoadedCompositionPlan | null;
  /** Resolved image digests for this build (S7); routingService keys E2's recording. */
  imageDigests: Record<string, string>;
  builtTargetPlatform: TargetPlatform;
  /** N30: set when this deploy proceeded with --allow-unretained-manifest. */
  unretainedManifestBuild: string | null;
  /** infra.projectId — E4's gcloud CDN invalidation identity. */
  projectId: string | undefined;
  /** Local output dir; see the interface doc — cdn-invalidate sidecar read only. */
  outputDir: string;
  /** Chart renders route-ext-update-job.yaml (D3 gate applies). */
  hasRouteExtJob: boolean;
  /** Chart renders envoy-extension-policy.yaml (D4/D5 gate applies). */
  hasEnvoyExtensionPolicy: boolean;
  /** Chart renders cdn-http-filter.yaml (E4 invalidation applies). */
  cdnEnabled: boolean;
}

/**
 * A pool Deployment resolved by exact template-derived names. The HPA name must come from
 * the SAME suffix-reserving helper the template uses (hpa.ts truncates the base at 59, then
 * appends "-hpa") — concatenating "-hpa" onto the 63-truncated deployment name diverges past
 * that boundary (and can exceed 63 chars).
 */
export interface PoolDeploy {
  pool: string;
  name: string;
  hpa: string;
}

/**
 * Everything runRevert (rollback's cutover-reversal sequence) needs. The CLI resolves the
 * Deployment/HPA names and chart scaling config from the local checkout; the Job resolves
 * them from the state CM's topologies + emit-metadata.
 */
export interface RevertInputs {
  projectDir: string;
  releaseName: string;
  namespace: string;
  currentBuildId: string;
  previousBuildId: string;
  /** Rollback target's pool topology. */
  poolNames: string[];
  /** Current build's pool topology. */
  currentPoolNames: string[];
  previousDeploys: PoolDeploy[];
  currentDeploys: PoolDeploy[];
  /** Chart scaling config per pool (values.yaml `pools.<name>.replicas`). */
  scalingByPool: Map<string, { min: number; max: number; targetCPU: number }>;
  state: AdapterState;
  targetComposition: LoadedCompositionPlan | null;
  /** infra.containerRegistry — forms the routing image reference for the edge revert. */
  registry: string | undefined;
  /** infra.projectId — CDN invalidation identity. */
  projectId: string | undefined;
  /** Local output dir; cdn-invalidate sidecar read only (see CutoverInputs.outputDir). */
  outputDir: string;
  /** Chart renders cdn-http-filter.yaml (post-swap invalidation applies). */
  cdnEnabled: boolean;
}
