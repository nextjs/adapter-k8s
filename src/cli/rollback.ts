// src/cli/rollback.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import { readState, type AdapterState } from "./state.js";
import { discoverBuildPools, recordedBuildPools } from "./pool-topology.js";
import {
  poolResourceNames,
  sanitizeK8sName,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";
import { routingManifestSnapshotName } from "../emit/templates/routing-manifest-configmap.js";
import {
  assertSafeInfrastructure,
  infrastructurePath,
  outputDirName,
} from "./infrastructure-validation.js";
import { sanitizeForTerminal } from "./terminal.js";
import {
  assertCompositionPlanInvocation,
  compositionPlanNeedsExplicitConfirmation,
  inspectKubernetesRequirements,
  loadDeployedCompositionPlan,
  loadProjectCompositionPlan,
  preflightCompositionPlan,
  type LoadedCompositionPlan,
} from "./composition-plan.js";
// GitOps PR2: the revert-path primitives — the edge functions (readRoutingServingConfig /
// retainLiveRoutingManifest / revertRoutingServiceToBuild), the N26 capacity planning
// (planRollbackCapacity / readLiveCapacity), and the traffic-reversal orchestration itself
// (runRevert) — live in src/cutover/. Rollback stays the CLI CALLER: it validates argv and
// infrastructure (S13), pins the kubectl context, reads and classifies state/topologies,
// resolves the exact Deployment/HPA names, and hands the mutation sequence to runRevert.
import { runRevert } from "../cutover/run.js";
import { CutoverExitError } from "../cutover/inputs.js";

type RollbackCompositionRole = "current" | "target";

/**
 * A checkout may contain either side of a two-way rollback. Bind its plan to the matching
 * committed anchor instead of assuming the local artifact is always the currently served build.
 */
export function classifyLocalRollbackComposition(options: {
  local: LoadedCompositionPlan;
  state: Pick<AdapterState, "buildId" | "previousBuildId" | "compositionPlans">;
  releaseName: string;
  namespace: string;
}): RollbackCompositionRole {
  const { local, state, releaseName, namespace } = options;
  const localBuildId = local.plan.metadata.buildId;
  const role: RollbackCompositionRole =
    localBuildId === state.buildId
      ? "current"
      : localBuildId === state.previousBuildId
        ? "target"
        : (() => {
            throw new Error(
              `The local composition plan belongs to build ${localBuildId}, but rollback only ` +
                `recognizes current build ${state.buildId} and target build ` +
                `${state.previousBuildId ?? "<none>"}. Restore either retained build artifact.`,
            );
          })();

  assertCompositionPlanInvocation(local.plan, {
    releaseName,
    namespace,
    buildId: localBuildId,
  });

  const anchor = state.compositionPlans?.[localBuildId];
  if (role === "target" && !anchor) {
    throw new Error(
      `The local composition plan belongs to rollback target ${localBuildId}, but committed ` +
        `deploy state has no trust anchor for that build. Restore the currently deployed ` +
        `build artifact before rolling back.`,
    );
  }
  if (
    anchor &&
    (local.digest !== anchor.digest || local.plan.target.fingerprint !== anchor.targetFingerprint)
  ) {
    throw new Error(
      `The local composition plan for ${localBuildId} does not match committed deploy state. ` +
        `Restore that build artifact before rolling back.`,
    );
  }
  return role;
}

export async function runRollback(options: {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
  yes?: boolean;
}): Promise<void> {
  const { projectDir, releaseName, dryRun, yes } = options;

  const infraPath = infrastructurePath(projectDir);
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;
  // S13: validate before these reach a gcloud/kubectl argv.
  assertSafeInfrastructure(infra);
  const localComposition = loadProjectCompositionPlan(projectDir);
  if (localComposition && localComposition.plan.metadata.releaseName !== releaseName) {
    throw new Error(
      `Composition-plan release mismatch: plan records ` +
        `${JSON.stringify(localComposition.plan.metadata.releaseName)}, but rollback targets ` +
        `${JSON.stringify(releaseName)}.`,
    );
  }
  const namespace = localComposition
    ? localComposition.plan.metadata.namespace
    : resolveK8sNamespace(infra?.namespace);

  // Pin kubectl at THIS release's cluster BEFORE any cluster read — otherwise the state
  // ConfigMap read below runs against whatever context happens to be current, and a
  // rollback could read (and then act on) another cluster's build state. Dry-run must
  // not mutate the operator's kubeconfig (L13), so it skips this and reads local
  // state only.
  if (!dryRun && localComposition) {
    if (compositionPlanNeedsExplicitConfirmation(localComposition.plan) && !yes) {
      throw new Error(
        `Rollback target access is not independently verifiable. Confirm the current kubectl ` +
          `context, then re-run with --yes. No cluster state was read or changed.`,
      );
    }
    const preflight = await preflightCompositionPlan(localComposition.plan, {
      explicitlyConfirmed: yes === true,
    });
    console.log(
      `  → Composition plan verified: ${preflight.clusterIdentity}; Kubernetes ` +
        `${preflight.serverVersion}`,
    );
  } else if (!dryRun && infra?.projectId && infra?.region) {
    const credResult = await execCapture(
      "gcloud",
      [
        "container",
        "clusters",
        "get-credentials",
        `${releaseName}-cluster`,
        "--region",
        infra.region,
        "--project",
        infra.projectId,
        "--quiet",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (credResult.exitCode !== 0) {
      // L14: gcloud stderr is externally influenced; strip control sequences before printing.
      throw new Error(
        `Failed to connect to cluster "${releaseName}-cluster": ` +
          `${sanitizeForTerminal(credResult.stderr.trim())}`,
      );
    }
  }

  const state = await readState(projectDir, releaseName, {
    ...(dryRun ? { localOnly: true } : {}),
    namespace,
  });
  if (!state?.previousBuildId) {
    // Dry-run deliberately reads the LOCAL state file only (L13 — no cluster access),
    // so "no previous build" may just mean the local file is missing/stale while the
    // cluster's deploy-state ConfigMap records more history. Say so instead of the
    // misleading "only one deploy has been recorded".
    throw new Error(
      dryRun
        ? "No previous build to roll back to in the LOCAL state file. Dry-run deliberately " +
            "reads local state only (no cluster access) — the cluster's deploy-state " +
            "ConfigMap may record more history. Run without --dry-run to consult it."
        : "No previous build to roll back to. Only one deploy has been recorded.",
    );
  }

  const { buildId: currentBuildId, previousBuildId } = state;
  const currentAnchor = state.compositionPlans?.[currentBuildId];
  const targetAnchor = state.compositionPlans?.[previousBuildId];
  const localCompositionRole = localComposition
    ? classifyLocalRollbackComposition({
        local: localComposition,
        state,
        releaseName,
        namespace,
      })
    : null;
  const currentComposition =
    !dryRun && currentAnchor
      ? localCompositionRole === "current"
        ? localComposition
        : await loadDeployedCompositionPlan({
            releaseName,
            namespace,
            buildId: currentBuildId,
            expected: currentAnchor,
          })
      : localCompositionRole === "current"
        ? localComposition
        : null;
  const targetComposition =
    !dryRun && targetAnchor
      ? localCompositionRole === "target"
        ? localComposition
        : await loadDeployedCompositionPlan({
            releaseName,
            namespace,
            buildId: previousBuildId,
            expected: targetAnchor,
          })
      : localCompositionRole === "target"
        ? localComposition
        : null;
  if (!dryRun && currentAnchor && !currentComposition) {
    throw new Error(
      `Committed state requires a composition plan for current build ${currentBuildId}, but its ` +
        `retained ConfigMap is missing. Refusing rollback without a verified target identity.`,
    );
  }
  if (!dryRun && targetAnchor && !targetComposition) {
    throw new Error(
      `Committed state requires a composition plan for rollback build ${previousBuildId}, but ` +
        `its retained ConfigMap is missing.`,
    );
  }
  if (
    currentComposition &&
    targetComposition &&
    currentComposition.plan.target.fingerprint !== targetComposition.plan.target.fingerprint
  ) {
    throw new Error(
      `Rollback crosses incompatible deployment targets (${currentComposition.plan.target.fingerprint} ` +
        `→ ${targetComposition.plan.target.fingerprint}). The current Helm resources cannot ` +
        `represent both targets; deploy the older target definition explicitly instead.`,
    );
  }
  if (!dryRun && targetComposition) {
    await inspectKubernetesRequirements(targetComposition.plan);
  }

  // N70: rollback has TWO independent topologies. Local build-metadata describes whichever
  // build happened to run last in this checkout, not necessarily the rollback target (and a
  // renamed pool makes the two sets differ by definition). Current states record both exact
  // build-scoped sets. Legacy states are migrated from immutable versioned Deployments; dry-run
  // cannot perform that cluster read and fails closed rather than fabricating a plan.
  let poolNames = recordedBuildPools(state, previousBuildId);
  let currentPoolNames = recordedBuildPools(state, currentBuildId);
  if (dryRun && (!poolNames || !currentPoolNames)) {
    throw new Error(
      `Deploy state predates per-build pool topology for ${!poolNames ? `rollback target "${previousBuildId}"` : `current build "${currentBuildId}"`}. ` +
        `Dry-run cannot recover it without cluster access; run rollback without --dry-run to ` +
        `migrate the state, or restore poolTopologies in .k8s-adapter/state.json.`,
    );
  }
  if (!poolNames) {
    poolNames = await discoverBuildPools(releaseName, previousBuildId, namespace);
    console.warn(
      `  ! Recovered legacy pool topology for rollback target "${previousBuildId}" from ` +
        `its versioned Deployments: ${poolNames.join(", ")}.`,
    );
  }
  if (!currentPoolNames) {
    currentPoolNames = await discoverBuildPools(releaseName, currentBuildId, namespace);
    console.warn(
      `  ! Recovered legacy pool topology for current build "${currentBuildId}" from its ` +
        `versioned Deployments: ${currentPoolNames.join(", ")}.`,
    );
  }

  // L13: dry-run must not mutate anything — and get-credentials mutates the operator's
  // kubeconfig, so it is skipped too. Print the planned steps and return.
  if (dryRun) {
    const prevNames = poolNames.map((p) =>
      sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`),
    );
    const currNames = currentPoolNames.map((p) =>
      sanitizeK8sName(`${releaseName}-${p}-${currentBuildId}`),
    );
    console.log(`\n  [dry-run] Rollback plan: ${currentBuildId} → ${previousBuildId}`);
    console.log(
      `  [dry-run] Skipping "gcloud container clusters get-credentials" (it would mutate your kubeconfig).`,
    );
    console.log(`  [dry-run] Reading deploy state from the LOCAL file only (no cluster access).`);
    if (prevNames.length > 0)
      console.log(`  [dry-run] Would scale up previous build: ${prevNames.join(", ")}`);
    console.log(`  [dry-run] Would wait for the previous build's rollout to complete`);
    console.log(`  [dry-run] Would verify the previous build's pods are serving /healthz`);
    console.log(
      `  [dry-run] Would revert the routing service to image routing-service:${previousBuildId} ` +
        `and manifest ConfigMap ${routingManifestSnapshotName(releaseName, previousBuildId)}`,
    );
    console.log(
      `  [dry-run] Would patch active Service selectors to app.kubernetes.io/version=${sanitizeK8sName(previousBuildId)}`,
    );
    if (currNames.length > 0)
      console.log(`  [dry-run] Would scale down current build: ${currNames.join(", ")}`);
    console.log(
      `  [dry-run] Would swap state: buildId=${previousBuildId}, previousBuildId=${currentBuildId}`,
    );
    return;
  }

  console.log(`\nRolling back: ${currentBuildId} → ${previousBuildId}\n`);

  const deploysResult = await execCapture(
    "kubectl",
    [
      "get",
      "deployments",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}|{.status.replicas}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );

  if (deploysResult.exitCode !== 0) {
    throw new Error("Failed to list deployments. Is kubectl connected?");
  }

  // Roll back EVERY pool, not just one. Single previous/current vars kept only the LAST
  // pool that matched during discovery, so a multi-pool rollback scaled up one pool's
  // previous Deployment but then switched ALL active Services to the previous build —
  // every other pool was left at zero replicas with no endpoints. The pool list was read
  // from build metadata above (the same source deploy's cutover uses); resolve each
  // pool's previous and current Deployment by exact name, and verify every previous pool
  // exists BEFORE touching traffic.
  const scalingByPool = new Map<string, { min: number; max: number; targetCPU: number }>();
  const valuesPath = path.join(projectDir, ".k8s-adapter", outputDirName(), "chart", "values.yaml");
  if (existsSync(valuesPath)) {
    try {
      const raw = readFileSync(valuesPath, "utf-8");
      const values = JSON.parse(raw.slice(raw.indexOf("{")));
      for (const pool of poolNames) {
        const replicas = values.pools?.[pool]?.replicas;
        if (replicas) scalingByPool.set(pool, replicas);
      }
    } catch {
      // Defaults below match renderValuesYaml.
    }
  }

  const discovered = new Set(
    deploysResult.stdout
      .trim()
      .split("\n")
      .map((l) => l.split("|")[0])
      .filter(Boolean),
  );
  // Carry the pool and the template-derived HPA name alongside each Deployment name:
  // the HPA truncates its base at 59 chars (suffix reserved INSIDE the 63-char cap,
  // hpa.ts), so it must come from poolResourceNames — appending "-hpa" to the
  // 63-truncated deployment name diverges past that boundary (and can exceed 63
  // chars), making rollback miss the retained HPA and `kubectl autoscale` fail on an
  // invalid name.
  interface PoolDeploy {
    pool: string;
    name: string;
    hpa: string;
  }
  const previousDeploys: PoolDeploy[] = [];
  const currentDeploys: PoolDeploy[] = [];
  const missingPrev: string[] = [];
  for (const pool of poolNames) {
    const prev = poolResourceNames(releaseName, pool, previousBuildId);
    if (discovered.has(prev.deployment)) {
      previousDeploys.push({ pool, name: prev.deployment, hpa: prev.hpa });
    } else missingPrev.push(pool);
  }
  for (const pool of currentPoolNames) {
    const curr = poolResourceNames(releaseName, pool, currentBuildId);
    if (discovered.has(curr.deployment)) {
      currentDeploys.push({ pool, name: curr.deployment, hpa: curr.hpa });
    }
  }

  if (missingPrev.length > 0) {
    throw new Error(
      `Previous deployment missing for pool(s): ${missingPrev.join(", ")} (build ` +
        `${previousBuildId}). Rolling back would strand those pools with zero endpoints. ` +
        `Aborting. Only one previous build is retained after each deploy.`,
    );
  }

  // Steps 1-5 — capacity plan/scale-up (N26), HPA recreate/widen, rollout wait, serving
  // gate, composition readiness, selector snapshot (N70), edge-first revert, selector flip,
  // state swap (N69), CDN invalidation (M13), current-build scale-down — moved verbatim to
  // src/cutover/run.ts (runRevert) with GitOps PR2. CutoverExitError maps back to the CLI
  // exit codes the inline code used.
  const rbOutputDir = path.join(projectDir, ".k8s-adapter", outputDirName());
  try {
    await runRevert({
      projectDir,
      releaseName,
      namespace,
      currentBuildId,
      previousBuildId,
      poolNames,
      currentPoolNames,
      previousDeploys,
      currentDeploys,
      scalingByPool,
      state,
      targetComposition,
      registry: infra?.containerRegistry,
      projectId: infra?.projectId,
      outputDir: rbOutputDir,
      cdnEnabled: existsSync(path.join(rbOutputDir, "chart", "templates", "cdn-http-filter.yaml")),
    });
  } catch (err) {
    if (err instanceof CutoverExitError) process.exit(err.code);
    throw err;
  }

  console.log(`\n✓ Rollback complete. Now serving build: ${previousBuildId}`);
  console.log(`  To roll forward again: npx adapter-k8s rollback`);
  console.log(`  To deploy new code:    npx adapter-k8s deploy\n`);
}
