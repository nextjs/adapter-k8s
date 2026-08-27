// src/cli/state.ts
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { stateFileName } from "./infrastructure-validation.js";
import { execCapture, execCaptureStdin } from "./exec.js";
import { BUILD_ID_RE, resolveK8sNamespace } from "../emit/templates/utils.js";
import { DIGEST_RE } from "../pipeline/digests.js";
import type { TargetPlatform } from "../target-platform.js";

const STATE_DIR = ".k8s-adapter";
// Variant-scoped: see stateFileName(). Sharing one state file across deploy targets lets a
// higher generation from one cluster supply another cluster's activeBuildId — repointing that
// cluster's Services at a build that only ever existed on the other one.
const STATE_FILE = (): string => stateFileName();
const CONFIGMAP_NAME_SUFFIX = "-adapter-state";
// N22: every shell-out goes through exec.ts (AGENTS.md) — this file used to call
// `spawn("kubectl", …)` directly, which meant no `stdin.on("error")` handler (the
// ERR_STREAM_DESTROYED crash exec.ts:231-236 documents, hit immediately AFTER cutover,
// where the operator needs the ClusterStateWriteError message instead of a stack), no
// timeout, and no Windows `.cmd` shim handling. Every kubectl call here is bounded: the
// state write is the deploy's commit point, and a wedged kubectl hung it forever.
const KUBECTL_TIMEOUT_MS = 60_000;

export interface AdapterState {
  buildId: string;
  previousBuildId: string | null;
  /**
   * N21 (stale-ConfigMap-beats-newer-local): monotonic counter, bumped by every
   * successful `writeState`. `readState` takes the NEWER of the cluster ConfigMap and
   * the local file instead of unconditionally preferring the ConfigMap — the old
   * preference turned the documented "the ConfigMap write failed, re-run" recovery into
   * a second outage: the re-run read the stale ConfigMap (build A), and helm patched the
   * active Service selector onto build A, which the previous run had already scaled to
   * ZERO replicas. Absent (state written before generations existed) reads as 0; see
   * chooseNewerState for the legacy tiebreaker.
   */
  generation?: number;
  /**
   * N21: ISO timestamp of the write that produced this state. Diagnostics only — the
   * ordering decision uses `generation` (wall clocks on two machines don't order).
   */
  updatedAt?: string;
  /**
   * True once a deploy has installed pods that answer the READINESS path (`/readyz`).
   *
   * The stable HealthCheckPolicy is helm-owned, so `helm upgrade` changes it BEFORE the
   * cutover — while the currently-serving pods are still the previous build's. Pods built by
   * an adapter from before /readyz existed answer only /healthz, so flipping the policy to
   * /readyz mid-upgrade could mark every ACTIVE endpoint unhealthy and take the site down
   * during the rollout. Absent (or false) means "the live build may predate /readyz", so the
   * deploy keeps the load balancer probing /healthz for one more cycle and sets this; the
   * next deploy — whose outgoing build is one this adapter produced — uses /readyz.
   */
  readinessPathSupported?: boolean;
  /**
   * M13 (2026-07-22 stale-apex incident): the exact Cache-Tag each build's pool-server
   * stamps on CDN-cacheable responses, keyed by buildId and recorded at that build's
   * deploy. Cutover/rollback invalidation uses the RECORDED tag for the outgoing build —
   * never a re-derivation under the current code, which may not match what the (older)
   * outgoing build's pods actually stamped. Absent key (or absent map, for states written
   * before recording existed) means the outgoing build's tag provenance is unknown and
   * invalidation falls back to a full `--path=/*` purge. Pruned by deploy to the two
   * builds still in play.
   */
  cdnTags?: Record<string, string>;
  /**
   * N30: build ids whose routing manifest could NOT be retained at the deploy that
   * rolled away from them (`--allow-unretained-manifest`). A rollback to one of these
   * builds can only revert the routing IMAGE — the edge keeps the newer build's routing
   * manifest — so doctor can report "rollback would be image-only" instead of the
   * unqualified "Rollback ready: PASS". Pruned to the two builds still in play.
   */
  unretainedManifestBuilds?: string[];
  /**
   * Per-build immutable routing-service image digest (`<buildId>` -> `sha256:…`), recorded at
   * the deploy that pushed it.
   *
   * Rollback reconstructs the routing image reference from the target build id, which can only
   * produce a TAG — so a rolled-back edge was one step less immutable than a freshly deployed
   * one, exactly the mutable-tag exposure digest pinning exists to close (the deploy identity
   * can retag, and these pods hold the internal dispatch secret). With the digest recorded here
   * the revert can pin properly. Absent for builds deployed before this existed, and for those
   * the tag remains the only option. Pruned to the two builds still in play, like `cdnTags`.
   */
  routingImageDigests?: Record<string, string>;
  /**
   * Exact pool topology emitted for each retained build (`buildId` -> ordered pool names).
   *
   * Pool sets can change between builds. Deploy and rollback must therefore never derive the
   * outgoing/target topology from the incoming build's `build-metadata.json`: doing so prunes a
   * removed pool before cutover and cannot restore it later. Absent means a state written by an
   * older adapter; callers migrate it from build-scoped Deployments and fail closed when those
   * objects cannot prove the topology. Pruned to the current and previous builds.
   */
  poolTopologies?: Record<string, string[]>;
  /** Default pool selected by the portable origin Service for each retained build. */
  defaultPools?: Record<string, string>;
  /** Independent trust anchors for retained build-scoped composition plans. */
  compositionPlans?: Record<
    string,
    { digest: `sha256:${string}`; targetFingerprint: `sha256:${string}` }
  >;
  /**
   * The container platform each retained build was produced for, keyed by build id.
   *
   * The routing Deployment is updated in place, including its architecture selector. A
   * rollback therefore needs the target build's recorded platform to move the image and
   * `kubernetes.io/arch` selector together. Absent for builds deployed before platform
   * recording existed; callers must leave the live selector unchanged rather than guess.
   * Pruned to the current and previous builds, like `routingImageDigests`.
   */
  targetPlatforms?: Record<string, TargetPlatform>;
  /**
   * GitOps PR2 poison pill (design §8 risk 4): build ids whose in-cluster cutover Job
   * FAILED its gate battery for this release. An auto-syncing reconciler retries the sync
   * per its retry policy, re-running the plain versioned Job's pod — each retry re-runs
   * the HPA warm-up against a build that will never pass (a capacity wobble on the
   * serving build, every interval, forever). The Job records the failed build here and
   * refuses re-promotion of the same build unless FORCE_PROMOTION is set. Cleared by the
   * next successful promotion (the E2 state write does not carry it forward).
   */
  failedPromotions?: string[];
}

// Thrown when the local file was written but the cluster ConfigMap mirror failed.
// Callers must surface this rather than reporting a clean success — a swallowed
// failure leaves local=new / cluster=old, and the next read has to reconcile them.
export class ClusterStateWriteError extends Error {
  /**
   * N23: true when a re-read proved the ConfigMap's resourceVersion moved under us —
   * i.e. a CONCURRENT deploy/rollback committed state while this one was writing. Set
   * from the machine-readable resourceVersion comparison, never from stderr text.
   */
  readonly concurrent: boolean;
  constructor(message: string, opts?: { concurrent?: boolean }) {
    super(message);
    this.name = "ClusterStateWriteError";
    this.concurrent = opts?.concurrent === true;
  }
}

/**
 * N20 (unreadable state ⇒ helm prunes the SERVING Deployment): base class for "the
 * committed deploy state could NOT be determined". This used to be indistinguishable
 * from "there is no state yet": every failure mode (catch-all, non-zero exit, empty
 * stdout, JSON parse error) returned `null`, and `.k8s-adapter/` is gitignored so the
 * local fallback is absent in CI. One transient kubectl/RBAC error therefore produced
 * `previousBuildId = null`, which skipped deploy's retained-manifest injection (so
 * `helm upgrade` DELETED the currently-serving Deployment) and set
 * `activeBuildId=<new build>`, repointing the stable Service at a build with zero ready
 * pods minutes before the health gate ran.
 *
 * Callers must treat this as "unknown", never as "first deploy" (deploy recovers the
 * live build from the active Service selector — see discoverServingBuildId).
 */
export class StateUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** N20: the cluster state ConfigMap exists (or its existence is unknown) but could not be read. */
export class ClusterStateReadError extends StateUnavailableError {}

/** N20: `.k8s-adapter/state.json` exists but is unreadable/unparseable/wrong-shaped. */
export class LocalStateReadError extends StateUnavailableError {}

/**
 * N21: the cluster ConfigMap and the local file name different builds and neither can be
 * proven newer. Refuse to proceed rather than picking one and draining the Service.
 */
export class StateDisagreementError extends StateUnavailableError {}

function stateFilePath(projectDir: string): string {
  return path.join(projectDir, STATE_DIR, STATE_FILE());
}

/** Remove only this target variant's local deploy-state record and interrupted-write temp file. */
export function removeLocalState(projectDir: string): void {
  const target = stateFilePath(projectDir);
  rmSync(target, { force: true });
  rmSync(`${target}.tmp`, { force: true });
}

function isAdapterState(value: unknown): value is AdapterState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.buildId !== "string" || v.buildId === "") return false;
  if (!(v.previousBuildId === null || typeof v.previousBuildId === "string")) return false;
  // The state ConfigMap is operator-mutable (any namespace actor with configmaps/update can
  // rewrite it), and routingImageDigests flows — via revertRoutingServiceToBuild — into the
  // image reference of a `kubectl patch` on the routing Deployment. edge.ts validates at the
  // consumption point; this is the belt-and-braces half: a state blob whose digests are not
  // sha256:<64 hex> (or whose keys are not build ids) reads as "unknown", never as deployable
  // truth (N20: unknown must fail closed, not read as a first deploy).
  if (v.routingImageDigests !== undefined) {
    if (typeof v.routingImageDigests !== "object" || v.routingImageDigests === null) return false;
    if (Array.isArray(v.routingImageDigests)) return false;
    for (const [key, digest] of Object.entries(v.routingImageDigests)) {
      if (!BUILD_ID_RE.test(key)) return false;
      if (typeof digest !== "string" || !DIGEST_RE.test(digest)) return false;
    }
  }
  return true;
}

function generationOf(state: AdapterState): number {
  return typeof state.generation === "number" && Number.isFinite(state.generation)
    ? state.generation
    : 0;
}

// N20: an unparseable/absent-shaped local file is "unknown", not "no deploys yet" — the
// atomic tmp+rename write makes a truncated file unlikely, but a hand-edited or
// half-restored file must not read as a first deploy.
function readLocalState(projectDir: string): AdapterState | null {
  const filePath = stateFilePath(projectDir);
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new LocalStateReadError(
      `Could not read local deploy state ${filePath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LocalStateReadError(
      `Local deploy state ${filePath} is not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}). Fix or delete the file — ` +
        `the cluster ConfigMap <release>${CONFIGMAP_NAME_SUFFIX} carries the same state.`,
    );
  }
  if (!isAdapterState(parsed)) {
    throw new LocalStateReadError(
      `Local deploy state ${filePath} is missing a string "buildId" / "previousBuildId", ` +
        `or carries a malformed "routingImageDigests" — refusing to treat it as "no deploys ` +
        `yet". Fix or delete the file.`,
    );
  }
  return parsed;
}

/** writeState's generation lookup must never fail on a corrupt local file — it is about to overwrite it. */
function readLocalStateQuiet(projectDir: string): AdapterState | null {
  try {
    return readLocalState(projectDir);
  } catch {
    return null;
  }
}

/**
 * N21: pick the state that is provably newer, or refuse. `generation` orders writes; for
 * legacy states that carry none, the build CHAIN is evidence: a state whose
 * `previousBuildId` is the other's `buildId` recorded a later cutover, which is exactly
 * the failed-ConfigMap-write sequence (local={B, prev A}, cluster={A, prev A0}).
 */
function chooseNewerState(local: AdapterState, cluster: AdapterState): AdapterState {
  const localGen = generationOf(local);
  const clusterGen = generationOf(cluster);
  if (clusterGen > localGen) return cluster;
  if (localGen > clusterGen) return local;

  // Same generation: identical build pointers → no disagreement (prefer the cluster copy,
  // the shared source of truth, as before).
  if (local.buildId === cluster.buildId && local.previousBuildId === cluster.previousBuildId) {
    return cluster;
  }
  if (local.previousBuildId && local.previousBuildId === cluster.buildId) return local;
  if (cluster.previousBuildId && cluster.previousBuildId === local.buildId) return cluster;

  throw new StateDisagreementError(
    `Deploy state disagrees between the cluster ConfigMap and the local file, and neither ` +
      `is provably newer:\n` +
      `  cluster: buildId=${cluster.buildId} previousBuildId=${cluster.previousBuildId ?? "null"} ` +
      `generation=${clusterGen}${cluster.updatedAt ? ` updatedAt=${cluster.updatedAt}` : ""}\n` +
      `  local:   buildId=${local.buildId} previousBuildId=${local.previousBuildId ?? "null"} ` +
      `generation=${localGen}${local.updatedAt ? ` updatedAt=${local.updatedAt}` : ""}\n` +
      `Refusing to guess: deploying against the wrong one patches the active Service ` +
      `selector onto a build that may be scaled to zero. Confirm which build is serving ` +
      `(\`npx adapter-k8s doctor\`), then delete the stale copy — ` +
      `\`rm ${path.join(STATE_DIR, STATE_FILE())}\` to accept the cluster's, or re-run the ` +
      `deploy after \`kubectl delete configmap <release>${CONFIGMAP_NAME_SUFFIX} -n <namespace>\` ` +
      `to accept the local one.`,
  );
}

// Read state: reconcile the cluster ConfigMap with the local file (N21 — newest wins),
// throwing StateUnavailableError subclasses rather than reporting "no state" for any
// failure mode (N20).
// `localOnly` skips the cluster read entirely — required for dry-run paths (L13: the
// kubectl context may point anywhere, and pinning it would mutate the kubeconfig).
//
// GitOps PR2: `clusterOnly` is the in-cluster cutover Job's mode. The Job has no
// persistent `.k8s-adapter/` (every pod starts from a fresh filesystem), so the local
// file is not consulted AND not reconciled — N20 is carried by the cluster half alone
// (STATE_GET_ARGS `--ignore-not-found` discipline + ClusterStateReadError on nonzero
// exit), and chooseNewerState's "rm the local file" repair advice is never emitted
// (there is no local file to rm). `projectDir` is ignored in this mode; `releaseName`
// becomes REQUIRED (a cluster-only read with nothing to read from is a caller bug,
// not "no state").
export async function readState(
  projectDir: string,
  releaseName?: string,
  opts?: { localOnly?: boolean; clusterOnly?: boolean; namespace?: string },
): Promise<AdapterState | null> {
  if (opts?.clusterOnly) {
    if (opts.localOnly) {
      throw new Error("readState: localOnly and clusterOnly are mutually exclusive");
    }
    if (!releaseName) {
      throw new Error(
        "readState: clusterOnly requires releaseName — the cluster ConfigMap is the only store",
      );
    }
    const { state } = await readClusterState(releaseName, resolveK8sNamespace(opts.namespace));
    return state;
  }
  const local = readLocalState(projectDir);
  if (!releaseName || opts?.localOnly) return local;

  const { state: cluster } = await readClusterState(
    releaseName,
    resolveK8sNamespace(opts?.namespace),
  );
  if (!cluster) return local;
  if (!local) return cluster;
  return chooseNewerState(local, cluster);
}

/**
 * N69: what a caller may hand to `writeState`. `generation`/`updatedAt` are writeState's to
 * stamp — a caller cannot set them — while `basedOnGeneration` is REQUIRED: the generation
 * of the state this operation READ at its start (null when no prior state was read, i.e. a
 * genuine first deploy). It is the FLOOR for the stamped generation, which is what keeps the
 * local file provably newer than the cluster ConfigMap even when the pre-write cluster read
 * fails.
 *
 * Required, deliberately, rather than the optional `generation` field it used to be: deploy
 * passed it and ROLLBACK silently omitted it, falling back to a floor of 0. In a fresh CI
 * checkout (`.k8s-adapter/` is gitignored, so there is no local file to carry the generation
 * forward) a post-cutover cluster outage then wrote local generation 1 while the stale
 * cluster record sat at generation N — and `readState` takes the HIGHER generation, so the
 * next deploy/rollback read the STALE cluster record and pointed traffic back at a build
 * that had already been switched away from and scaled to zero. A type error at the call site
 * is cheaper than that outage; a silent floor of 0 is what made it reachable.
 */
export type StateWrite = Omit<AdapterState, "generation" | "updatedAt"> & {
  basedOnGeneration: number | null;
};

// Write state: write to both cluster ConfigMap and local file.
// Policy: stamp a fresh monotonic generation (N21), write the local file first so it
// reflects the latest intended state, then mirror to the cluster ConfigMap under an
// optimistic-concurrency precondition (N23). If the cluster write fails we keep the
// freshly-written local file but PROPAGATE the error (ClusterStateWriteError) so the
// caller does not claim a clean success while cluster state is stale — the local file's
// higher generation is what makes the documented "re-run" recovery safe.
//
// `basedOnGeneration` is the FLOOR — the generation this write is based on. Callers pass the
// generation of the state they read at the start of the operation so the stamped value stays
// above the cluster's even when the pre-write cluster read fails (see StateWrite, N69).
//
// GitOps PR2: cluster-CM-only mode (`opts.clusterOnly` — the in-cluster cutover Job). The
// three LOCAL-FILE assumptions of the dual-store path are each answered:
//  (1) the `readLocalStateQuiet` generation lookup contributes nothing (there is no file);
//  (2) the atomic tmp+rename local write is skipped entirely;
//  (3) the recovery semantics INVERT: the dual-store path writes local FIRST and throws a
//      failed cluster read AFTER, so the operator's re-run reads a provably-newer local
//      copy — with one store there is nothing to make newer, so a failed
//      readClusterStateForWrite throws BEFORE any write and recovery is simply "re-run;
//      the Job re-reads the cluster". Nothing is ever half-committed.
// The S19 semantic-generation guard and the N23 resourceVersion precondition are
// store-agnostic and apply identically in both modes.
export async function writeState(
  projectDir: string,
  state: StateWrite,
  releaseName?: string,
  configuredNamespace?: string,
  opts?: { clusterOnly?: boolean },
): Promise<void> {
  const namespace = resolveK8sNamespace(configuredNamespace);
  const clusterOnly = opts?.clusterOnly === true;
  if (clusterOnly && !releaseName) {
    throw new Error(
      "writeState: clusterOnly requires releaseName — the cluster ConfigMap is the only store",
    );
  }
  const { basedOnGeneration, ...body } = state;
  const localExisting = clusterOnly ? null : readLocalStateQuiet(projectDir);

  // N23: read the ConfigMap we are about to overwrite — it supplies both the generation
  // to continue and the resourceVersion precondition. Writing blind is how two
  // concurrent deploys orphaned a build (both read prev=A, deployed B and C, both
  // applied blind → final state {buildId: C, previousBuildId: A} while B's resources
  // existed, were absent from state, were never scaled to 0, and rollback targeted A
  // instead of B). A failed read is fatal — but only AFTER the local file is written,
  // so the operator's re-run reads a local copy that is provably newer.
  let clusterGeneration = 0;
  let resourceVersion: string | null = null;
  let clusterReadError: ClusterStateWriteError | null = null;
  if (releaseName) {
    try {
      const existing = await readClusterStateForWrite(releaseName, namespace);
      clusterGeneration = existing.generation;
      resourceVersion = existing.resourceVersion;
    } catch (err) {
      clusterReadError =
        err instanceof ClusterStateWriteError
          ? err
          : new ClusterStateWriteError(err instanceof Error ? err.message : String(err));
    }
  }

  // Cluster-only: with a single store there is no "write local first so the re-run is
  // provably newer" recovery — an unreadable cluster means NOTHING may be written, and
  // recovery is a plain re-run against the (re-read) cluster.
  if (clusterOnly && clusterReadError) throw clusterReadError;

  // S19: the resourceVersion precondition below closes BLIND writes, but not read-modify-
  // write staleness, which is the same lost update by a slower route. Deploy C reads state
  // at generation 5; deploy B commits generation 6 inside C's rollout window; C reaches this
  // point, re-reads, and picks up B's CURRENT resourceVersion — so the precondition passes
  // and C commits {buildId: C, previousBuildId: A}. B is orphaned precisely as N23 above
  // describes: its resources exist, state never mentions it, nothing scales it to 0, and
  // rollback targets A. Comparing the generation SEMANTICALLY is what closes it: this write
  // is based on `basedOnGeneration`, so a cluster sitting above that is a commit this deploy
  // never saw, and the honest outcome is to lose rather than to overwrite.
  //
  // Deliberately BEFORE the local write: readState takes the newer of cluster and local, so
  // stamping a higher local generation for a write we are about to refuse would let this
  // loser's stale view beat the winner's committed state on the very next read — the exact
  // failure N21 exists to prevent, arriving from the other side.
  //
  // A null basedOnGeneration means the caller observed NO prior state (first deploy, or a
  // legacy record with no generation). There is nothing to compare, so the check does not
  // apply; the resourceVersion precondition is the only guard on that path.
  if (
    !clusterReadError &&
    basedOnGeneration !== null &&
    Number.isFinite(basedOnGeneration) &&
    clusterGeneration > basedOnGeneration
  ) {
    throw new ClusterStateWriteError(
      `Deploy state moved while this operation was running: it started from generation ` +
        `${basedOnGeneration}, but the cluster ConfigMap is now at generation ` +
        `${clusterGeneration}. Another deploy or rollback committed in the meantime, and ` +
        `writing over it would orphan that build — its resources would exist while state ` +
        `never mentions it, so nothing would scale it down and rollback would target the ` +
        `wrong build. Nothing was written. Re-read the current state (\`adapter-k8s ` +
        `describe\`) and re-run once the concurrent operation has settled.`,
      { concurrent: true },
    );
  }

  const generation =
    Math.max(
      localExisting ? generationOf(localExisting) : 0,
      clusterGeneration,
      // N69: a non-finite floor (a hand-edited state.json that carried `generation: "x"`
      // through readState) contributes nothing rather than poisoning the Math.max.
      basedOnGeneration !== null && Number.isFinite(basedOnGeneration) ? basedOnGeneration : 0,
    ) + 1;
  const stamped: AdapterState = { ...body, generation, updatedAt: new Date().toISOString() };

  // Write local file atomically (tmp + rename): a crash mid-write previously could
  // leave a truncated state.json that readState then silently treated as "no deploys".
  // No cross-process deploy lockfile, deliberately: commits are single short writes
  // sequenced after cutover, and a lock abandoned by a killed deploy would brick every
  // later deploy until manually removed. The lost-update race it would close is instead
  // caught cluster-side by the resourceVersion precondition below (N23).
  // Cluster-only mode skips this entirely: the Job pod's filesystem is ephemeral, so a
  // local write would be a write-only decoy that LOOKS like the dual-store recovery
  // semantics while providing none of them.
  if (!clusterOnly) {
    const dir = path.join(projectDir, STATE_DIR);
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, STATE_FILE());
    const tmp = path.join(dir, `${STATE_FILE()}.tmp`);
    writeFileSync(tmp, JSON.stringify(stamped, null, 2));
    renameSync(tmp, target);
  }

  if (clusterReadError) throw clusterReadError;

  // Write to cluster ConfigMap (throws ClusterStateWriteError on failure)
  if (releaseName) {
    await writeClusterState(releaseName, stamped, resourceVersion, namespace);
  }
}

function configMapName(releaseName: string): string {
  return `${releaseName}${CONFIGMAP_NAME_SUFFIX}`;
}

const STATE_GET_ARGS = (cmName: string, namespace: string): string[] => [
  "get",
  "configmap",
  cmName,
  "-n",
  namespace,
  // N20: THE machine-readable absence signal. With --ignore-not-found a genuinely absent
  // ConfigMap is exit 0 + empty stdout, so any non-zero exit is a real failure
  // (connectivity, RBAC, expired credentials) and must never read as "no state yet".
  // Deliberately not a substring match on stderr ("NotFound") — that is the
  // isAlreadyGoneError class of bug, where a 404 anywhere in an auth error text takes
  // the lenient branch.
  "--ignore-not-found",
  "-o",
  "json",
];

interface ClusterStateRead {
  /** null ⇒ the ConfigMap genuinely does not exist (kubectl NotFound). */
  state: AdapterState | null;
  /** resourceVersion of the object read, for the N23 write precondition. */
  resourceVersion: string | null;
}

function parseStateConfigMap(
  cmName: string,
  stdout: string,
): { state: AdapterState | null; resourceVersion: string | null; error?: string } {
  const raw = stdout.trim();
  if (!raw) return { state: null, resourceVersion: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      state: null,
      resourceVersion: null,
      error: `kubectl returned output that is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const obj = parsed as {
    metadata?: { resourceVersion?: unknown };
    data?: Record<string, unknown>;
  };
  const resourceVersion =
    typeof obj?.metadata?.resourceVersion === "string" ? obj.metadata.resourceVersion : null;
  const body = obj?.data?.["state.json"];
  if (typeof body !== "string" || !body.trim()) {
    return {
      state: null,
      resourceVersion,
      error: `ConfigMap ${cmName} exists but carries no "state.json" key`,
    };
  }
  let state: unknown;
  try {
    state = JSON.parse(body);
  } catch (err) {
    return {
      state: null,
      resourceVersion,
      error: `ConfigMap ${cmName}'s state.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!isAdapterState(state)) {
    return {
      state: null,
      resourceVersion,
      error:
        `ConfigMap ${cmName}'s state.json is missing a string "buildId" / "previousBuildId", ` +
        `or carries a malformed "routingImageDigests"`,
    };
  }
  return { state, resourceVersion };
}

async function readClusterState(releaseName: string, namespace: string): Promise<ClusterStateRead> {
  const cmName = configMapName(releaseName);
  const result = await execCapture("kubectl", STATE_GET_ARGS(cmName, namespace), {
    timeoutMs: KUBECTL_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw new ClusterStateReadError(
      `Could not read the deploy-state ConfigMap ${cmName} in namespace ${namespace}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (result.exitCode !== 0) {
    throw new ClusterStateReadError(
      `Could not read the deploy-state ConfigMap ${cmName} in namespace ${namespace} ` +
        `(kubectl exited ${result.exitCode}${result.timedOut ? ", timed out" : ""}). ` +
        `--ignore-not-found makes a genuinely absent ConfigMap exit 0, so this is a ` +
        `connectivity/RBAC failure, NOT "no deploys yet".` +
        `${result.stderr.trim() ? `\nkubectl: ${result.stderr.trim()}` : ""}`,
    );
  }
  const parsed = parseStateConfigMap(cmName, result.stdout);
  if (parsed.error) throw new ClusterStateReadError(`${parsed.error}. Repair or delete it.`);
  return { state: parsed.state, resourceVersion: parsed.resourceVersion };
}

// Same read, but on the write path: a corrupt body is not fatal (we are replacing it),
// while an unreadable cluster IS (see writeState).
async function readClusterStateForWrite(
  releaseName: string,
  namespace: string,
): Promise<{ generation: number; resourceVersion: string | null }> {
  const cmName = configMapName(releaseName);
  const result = await execCapture("kubectl", STATE_GET_ARGS(cmName, namespace), {
    timeoutMs: KUBECTL_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw new ClusterStateWriteError(
      `Could not read the existing deploy-state ConfigMap ${cmName} before writing it: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (result.exitCode !== 0) {
    throw new ClusterStateWriteError(
      `Could not read the existing deploy-state ConfigMap ${cmName} before writing it ` +
        `(kubectl exited ${result.exitCode}${result.timedOut ? ", timed out" : ""}). ` +
        `Refusing to overwrite it blind — a blind write is how two concurrent deploys ` +
        `orphan a build.${result.stderr.trim() ? `\nkubectl: ${result.stderr.trim()}` : ""}`,
    );
  }
  const parsed = parseStateConfigMap(cmName, result.stdout);
  return {
    generation: parsed.state ? generationOf(parsed.state) : 0,
    resourceVersion: parsed.resourceVersion,
  };
}

async function currentResourceVersion(
  releaseName: string,
  namespace: string,
): Promise<string | null> {
  const result = await execCapture(
    "kubectl",
    STATE_GET_ARGS(configMapName(releaseName), namespace),
    {
      timeoutMs: KUBECTL_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) return null;
  return parseStateConfigMap(configMapName(releaseName), result.stdout).resourceVersion;
}

async function writeClusterState(
  releaseName: string,
  state: AdapterState,
  resourceVersion: string | null,
  namespace: string,
): Promise<void> {
  const cmName = configMapName(releaseName);
  // JSON, not hand-built YAML: the old writer embedded the state in a single-quoted YAML
  // scalar with a hand-rolled `''` escape. JSON.stringify is the escape.
  const body = JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: cmName,
      labels: {
        "app.kubernetes.io/name": releaseName,
        // kubectl-created (not helm-owned) — destroy deletes by this label pair.
        "app.kubernetes.io/managed-by": "adapter-k8s",
      },
      // N23: optimistic concurrency. `kubectl replace` issues a PUT, and a PUT carrying
      // resourceVersion is rejected (409) when the object moved since we read it — so the
      // LOSER of two concurrent commits fails loudly instead of silently overwriting the
      // winner's state and orphaning its build.
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    data: { "state.json": JSON.stringify(state) },
  });

  // replace (update, precondition) when it exists; create (fails AlreadyExists if a
  // racing writer got there first) when it does not.
  const args = resourceVersion
    ? ["replace", "-n", namespace, "-f", "-"]
    : ["create", "-n", namespace, "-f", "-"];

  // N22: via execCaptureStdin — the stdin 'error' handler, timeout, and Windows shim
  // handling all live in exec.ts. The payload never goes on argv (size + secrets rule).
  let result;
  try {
    result = await execCaptureStdin("kubectl", args, body, { timeoutMs: KUBECTL_TIMEOUT_MS });
  } catch (err) {
    throw new ClusterStateWriteError(
      `Failed to run kubectl ${args[0]} for cluster state ConfigMap ${cmName}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (result.exitCode === 0) return;

  // N23: classify the failure on the machine-readable signal — did the object move? —
  // never on stderr text. A moved (or newly created) resourceVersion means a concurrent
  // deploy/rollback committed state while we were writing.
  const observed = await currentResourceVersion(releaseName, namespace).catch(() => null);
  const concurrent = observed !== null && observed !== resourceVersion;
  const detail = result.stderr.trim() || `kubectl ${args[0]} exited ${result.exitCode}`;
  throw new ClusterStateWriteError(
    concurrent
      ? `Refusing to overwrite deploy state: ConfigMap ${cmName} was modified by ANOTHER ` +
          `deploy or rollback while this one was committing (resourceVersion ` +
          `${resourceVersion ?? "<created>"} → ${observed}). This run's build is NOT recorded ` +
          `in cluster state — inspect both builds (\`npx adapter-k8s doctor\`) before running ` +
          `anything else; one of them is unreferenced by state and will not be cleaned up or ` +
          `rolled back to.\n${detail}`
      : `Failed to write cluster state ConfigMap ${cmName}: ${detail}`,
    { concurrent },
  );
}
