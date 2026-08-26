// src/cutover/from-cluster.ts
//
// GitOps PR2: the CutoverInputs FROM-CLUSTER implementation — everything the Phase D gate
// battery and Phase E promotion need, assembled from the three sources the in-cluster
// cutover Job actually has (design §4.2 "The cutover Job"):
//
//   1. the emit-metadata ConfigMap the chart mounts into the Job pod (the per-build facts
//      emit recorded: topology, digests, cdnTag, platforms, the three template-existence
//      booleans that replace deploy's chart-directory probes);
//   2. the state ConfigMap `<release>-adapter-state` (cluster-CM-only mode, state.ts) for
//      the previous build's facts — topology (N70), digests, platforms, the generation
//      the E2 commit is based on (N69), and the poison-pill record;
//   3. the live cluster for the two facts Git cannot know: the outgoing build's live
//      replica count (D6/N64) and what the edge/selectors are actually serving.
//
// No filesystem beyond the mounted metadata file, no TTY, no process.exit — the Job's
// main (job-main.ts) maps thrown errors to exit codes.
import { readFileSync } from "node:fs";
import { EXEC_TIMEOUTS, execCapture } from "../cli/exec.js";
import { type AdapterState } from "../cli/state.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafePoolName,
  assertSafeProjectId,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import { DIGEST_RE } from "../pipeline/digests.js";
import { parseTargetPlatform, type TargetPlatform } from "../target-platform.js";
import type { EmitMetadata } from "../cli/emit.js";
import type { CutoverInputs } from "./inputs.js";
import type { LoadedCompositionPlan } from "../cli/composition-plan.js";

/** The subset of EmitMetadata the Job consumes, after validation. */
export interface JobEmitMetadata {
  buildId: string;
  previousBuildId: string | null;
  releaseName: string;
  namespace: string;
  registry: string;
  digests: Record<string, string>;
  poolTopology: string[];
  defaultPool: string;
  builtTargetPlatform: TargetPlatform;
  hasRouteExtJob: boolean;
  hasEnvoyExtensionPolicy: boolean;
  cdnEnabled: boolean;
  hasPortableOrigin: boolean;
  projectId: string | undefined;
}

/**
 * Read and validate the mounted emit-metadata.json. Fail-closed like every other
 * metadata read in this repo: a missing, unparseable, or wrong-shaped file throws with
 * the field named — the Job must never promote on guessed facts. Every value that later
 * lands in a kubectl argv or label selector passes the assertSafe* battery here, at the
 * point of consumption (AGENTS.md), even though emit validated it at write time — the
 * ConfigMap is operator-mutable.
 */
export function readJobEmitMetadata(metadataPath: string): JobEmitMetadata {
  let raw: string;
  try {
    raw = readFileSync(metadataPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read the mounted emit-metadata at ${metadataPath}: ` +
        `${err instanceof Error ? err.message : String(err)}. The chart renders it under ` +
        `cutover.mode: job — is the Job running from an adapter-k8s bundle?`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `The mounted emit-metadata at ${metadataPath} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}.`,
    );
  }
  const meta = parsed as Partial<EmitMetadata>;
  if (typeof meta.buildId !== "string" || !meta.buildId) {
    throw new Error(`emit-metadata.json has no buildId — refusing to promote.`);
  }
  assertSafeBuildId(meta.buildId);
  if (meta.previousBuildId != null) assertSafeBuildId(meta.previousBuildId);
  if (typeof meta.releaseName !== "string" || !meta.releaseName) {
    throw new Error(`emit-metadata.json has no releaseName — refusing to promote.`);
  }
  assertSafeReleaseName(meta.releaseName);
  assertSafeNamespace(meta.namespace);
  if (typeof meta.registry !== "string" || !meta.registry) {
    throw new Error(`emit-metadata.json has no registry — the edge revert could not run.`);
  }
  // The registry joins a digest below to form the routing image a `kubectl patch` puts on
  // the routing Deployment — an unvalidated value is an arbitrary-image injection into the
  // pod that holds the release's dispatch secret. Same for every other value that lands in
  // a kubectl/gcloud argv or a label selector: the battery runs HERE, on the
  // operator-mutable ConfigMap read, even though emit validated at write time.
  assertSafeImageRegistry(meta.registry);
  const digests = meta.digests ?? {};
  for (const [key, digest] of Object.entries(digests)) {
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      throw new Error(
        `emit-metadata.json digest for "${key}" is not sha256:<64 hex> — refusing to ` +
          `promote on an image reference emit did not produce.`,
      );
    }
  }
  if (!Array.isArray(meta.poolTopology) || meta.poolTopology.length === 0) {
    throw new Error(`emit-metadata.json has no poolTopology — refusing to promote.`);
  }
  for (const pool of meta.poolTopology) assertSafePoolName(pool);
  if (typeof meta.defaultPool !== "string" || !meta.defaultPool) {
    throw new Error(`emit-metadata.json has no defaultPool — refusing to promote.`);
  }
  assertSafePoolName(meta.defaultPool);
  if (!meta.poolTopology.includes(meta.defaultPool)) {
    throw new Error(
      `emit-metadata.json defaultPool must name one of its poolTopology entries; got ` +
        `${JSON.stringify(meta.defaultPool)} — refusing to promote.`,
    );
  }
  if (meta.projectId != null) assertSafeProjectId(meta.projectId);
  const platformRaw = meta.targetPlatforms?.[meta.buildId];
  if (typeof platformRaw !== "string") {
    throw new Error(
      `emit-metadata.json records no target platform for build "${meta.buildId}" — ` +
        `a failed rollout could not restore the edge's architecture selector.`,
    );
  }
  return {
    buildId: meta.buildId,
    previousBuildId: meta.previousBuildId ?? null,
    releaseName: meta.releaseName,
    namespace: meta.namespace,
    registry: meta.registry,
    digests,
    poolTopology: meta.poolTopology,
    defaultPool: meta.defaultPool,
    builtTargetPlatform: parseTargetPlatform(platformRaw, "emit-metadata targetPlatforms"),
    hasRouteExtJob: meta.hasRouteExtJob === true,
    hasEnvoyExtensionPolicy: meta.hasEnvoyExtensionPolicy === true,
    cdnEnabled: meta.cdnEnabled === true,
    hasPortableOrigin: meta.hasPortableOrigin === true,
    projectId: typeof meta.projectId === "string" && meta.projectId ? meta.projectId : undefined,
  };
}

/**
 * The cheap-idempotent short-circuit (design §4.3): when the state CM AND the live
 * selectors already agree with this bundle's build, the cutover already happened —
 * a re-applied Job pod (reconciler retry of an unrelated resource, `spec.force`, a
 * hand-run `kubectl create job --from`) must log "already promoted" and exit 0 without
 * touching HPAs or re-running the warm-up (re-running the full gate battery on a Tuesday
 * config tweak is noise; re-running the HPA warm-up is a capacity wobble).
 *
 * BOTH sources must agree: state alone can be stale-ahead (E2 committed, selector patch
 * of a crashed half-run — impossible in program order, but this check is cheap), and
 * selectors alone without the state commit mean the promotion is NOT durable and must
 * re-run. Selector read failures return false — the gate battery is the authority.
 */
export async function isAlreadyPromoted(opts: {
  releaseName: string;
  namespace: string;
  buildId: string;
  pools: string[];
  state: AdapterState | null;
}): Promise<boolean> {
  const { releaseName, namespace, buildId, pools, state } = opts;
  if (!state || state.buildId !== buildId) return false;
  const safeBuildId = sanitizeK8sName(buildId);
  for (const pool of pools) {
    const svcName = sanitizeK8sName(`${releaseName}-${pool}`);
    const read = await execCapture(
      "kubectl",
      [
        "get",
        "service",
        svcName,
        "-n",
        namespace,
        "--ignore-not-found",
        "-o",
        "jsonpath={.spec.selector.app\\.kubernetes\\.io/version}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (read.exitCode !== 0) return false;
    if (read.stdout.trim() !== safeBuildId) return false;
  }
  return true;
}

/**
 * N64, re-hosted (see CutoverInputs.previousReplicasByPool): the LIVE replica count of
 * the build being replaced, per pool — read from the cluster before the gates run, with
 * deploy's exact fail-closed posture: an unreadable Deployment or a non-positive count
 * REFUSES the promotion (guessing the capacity target hands 100% of traffic to too few
 * pods). A genuinely ABSENT Deployment (`--ignore-not-found` exit 0 + empty stdout) is
 * skipped: keep-at-birth/migrate should have preserved it, but a pool the operator
 * hand-deleted must not brick every future promotion — the S18 one-ready-pod floor
 * covers that pool instead.
 */
export async function readPreviousReplicas(opts: {
  releaseName: string;
  namespace: string;
  previousBuildId: string;
  previousPools: string[];
}): Promise<Map<string, number>> {
  const { releaseName, namespace, previousBuildId, previousPools } = opts;
  const out = new Map<string, number>();
  for (const pool of previousPools) {
    const name = sanitizeK8sName(`${releaseName}-${pool}-${previousBuildId}`);
    const r = await execCapture(
      "kubectl",
      ["get", "deployment", name, "-n", namespace, "--ignore-not-found", "-o", "json"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (r.exitCode !== 0) {
      throw new Error(
        `Could not read the currently-serving deployment ${name} (kubectl exited ` +
          `${r.exitCode}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}). The capacity ` +
          `gate needs its live replica count (N64); refusing to guess. Nothing was cut over.`,
      );
    }
    if (!r.stdout.trim()) continue; // genuinely absent — S18 floor covers this pool
    let live: { spec?: { replicas?: unknown } };
    try {
      live = JSON.parse(r.stdout) as typeof live;
    } catch (err) {
      throw new Error(
        `Could not parse the live deployment ${name}: ` +
          `${err instanceof Error ? err.message : String(err)}. Nothing was cut over.`,
      );
    }
    const n = live.spec?.replicas;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `Could not read the live replica count for ${name} ` +
          `(replicas=${JSON.stringify(n)}). Refusing to guess the capacity target. ` +
          `Nothing was cut over.`,
      );
    }
    out.set(pool, n);
  }
  return out;
}

/**
 * Assemble CutoverInputs from the Job's three sources. `state` is the cluster-CM-only
 * read the caller already performed (job-main reads it once for the short-circuit, the
 * poison pill, and this — one read, one view).
 */
export function buildCutoverInputsFromCluster(opts: {
  metadata: JobEmitMetadata;
  state: AdapterState | null;
  previousReplicasByPool: Map<string, number>;
  compositionSnapshot?: LoadedCompositionPlan | null;
}): CutoverInputs {
  const { metadata, state, previousReplicasByPool, compositionSnapshot = null } = opts;
  // The previous build the gates verify against is what the CLUSTER says is serving
  // (state CM), not what emit assumed when the bundle was cut — the two agree in the
  // normal flow, and when they do not (a promotion landed between emit and this sync)
  // the live truth wins: reverting the edge to a build that is not serving would be the
  // N25 failure re-created. The caller warns on disagreement.
  const previousBuildId = state?.buildId ?? metadata.previousBuildId;
  const previousPools =
    previousBuildId && state?.poolTopologies?.[previousBuildId]
      ? state.poolTopologies[previousBuildId]!
      : [];
  return {
    // No persistent checkout in the pod: state runs cluster-CM-only, and the only
    // filesystem read left (the cdn-invalidation.json sidecar) is a documented no-op
    // against this path (absent file ⇒ invalidation defaults ON).
    projectDir: "/tmp",
    stateStore: "cluster-only",
    releaseName: metadata.releaseName,
    namespace: metadata.namespace,
    buildId: metadata.buildId,
    previousBuildId: previousBuildId === metadata.buildId ? null : previousBuildId,
    pools: metadata.poolTopology,
    previousPools,
    defaultPool: metadata.defaultPool,
    hasPortableOrigin: metadata.hasPortableOrigin,
    previousReplicasByPool,
    state,
    compositionSnapshot,
    imageDigests: metadata.digests,
    builtTargetPlatform: metadata.builtTargetPlatform,
    unretainedManifestBuild: null,
    projectId: metadata.projectId,
    outputDir: "/tmp",
    hasRouteExtJob: metadata.hasRouteExtJob,
    hasEnvoyExtensionPolicy: metadata.hasEnvoyExtensionPolicy,
    cdnEnabled: metadata.cdnEnabled,
  };
}
