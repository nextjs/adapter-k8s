// src/cutover/run.ts
// GitOps PR2: the cutover/promotion orchestrators, extracted from src/cli/deploy.ts step 7
// (runCutover) and src/cli/rollback.ts steps 1-5 (runRevert). No TTY, no readline, no
// process.exit: a failure that used to exit the CLI throws CutoverExitError after the edge
// and warmed HPAs are restored, and the callers (runDeploy/runRollback today, the in-cluster
// cutover Job's main next phase) map it to an exit code.
import { execCapture, execOrThrow, EXEC_TIMEOUTS } from "../cli/exec.js";
import { writeState, type AdapterState } from "../cli/state.js";
import { invalidateCdnBuildTag } from "../cli/cdn-invalidate.js";
import { cdnTagForBuildId } from "../cdn-tags.js";
import { waitForCompositionPlanReadiness } from "../cli/composition-plan.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import { routeExtJobName } from "../emit/templates/route-ext-update-job.js";
import type { TargetPlatform } from "../target-platform.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import {
  poolRolloutWaitBudget,
  waitPoolRollouts,
  waitRoutingRollout,
  waitRouteExtJob,
  waitPolicyAccepted,
  waitPreviousBuildServing,
  waitReadyCapacity,
  warmUpHpas,
  type GateContext,
} from "./gates.js";
import {
  switchTrafficToNewBuild,
  snapshotRevertSelectors,
  flipSelectorsToPreviousBuild,
} from "./traffic.js";
import {
  scaleDownPreviousBuild,
  gcSupersededResources,
  scaleDownCurrentBuild,
  planRollbackCapacity,
  readLiveCapacity,
  ROLLBACK_MIN_REPLICAS,
} from "./gc.js";
import { revertRoutingServiceToBuild } from "./edge.js";
import {
  CutoverExitError,
  type CutoverDeps,
  type CutoverInputs,
  type RevertInputs,
} from "./inputs.js";

/**
 * The zero-downtime cutover (deploy step 7): Phase D gate battery, then Phase E promotion.
 * Every abort path restores the edge (N25) and the warmed HPA bounds (N67) before failing.
 * Assumes `helm upgrade` already applied the new release and the caller's Phase-B live
 * replica read populated `inputs.previousReplicasByPool` (N64).
 */
export async function runCutover(inputs: CutoverInputs, deps: CutoverDeps): Promise<void> {
  const {
    projectDir,
    stateStore,
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
  } = inputs;

  // Match the new build's pods/deployments by their EXACT version label — the same value the
  // cutover patches Services to (`sanitizeK8sName(buildId)`, which stamps `app.kubernetes.io/
  // version` on every pod). The prior match used a 12-char normalized-prefix substring, so an OLD
  // build whose id shared that prefix could satisfy this readiness check; the cutover would then
  // patch Services to the full new label, match zero pods, drain the NEG, and 503 the origin.
  const safeBuildId = sanitizeK8sName(buildId);
  // A2: the POOL gate's budget (D1), computed once here so the CLI and the in-cluster cutover
  // Job — which both enter through this function — cannot wait different budgets. It is a
  // constant, not a derivation: the Deployments D1 awaits are created fresh per build (a build
  // id identical to the serving one is refused outright by assertBuildIdChangedSinceServing),
  // so their pods come up in parallel with no preStop on the critical path. The serial
  // per-replica derivation belongs to D2 alone, which reads the routing tier's own replica
  // count — see poolRolloutWaitBudget / deriveRolloutWaitBudget.
  const ctx: GateContext = {
    releaseName,
    namespace,
    buildId,
    safeBuildId,
    previousBuildId,
    poolRolloutWait: poolRolloutWaitBudget(),
    deps,
  };

  // D1. Wait for the new build's pool Deployments to be ready (7a).
  await waitPoolRollouts(ctx);

  // D2. Verify the routing service (ext_proc edge) actually rolls out (7a-bis).
  await waitRoutingRollout(ctx);

  // D3. The traffic extension is part of the middleware security boundary. Reconcile and
  // verify it while the active Services still select the previous build; never cut traffic
  // and call the deploy successful with a missing/incomplete ext_proc backend.
  if (inputs.hasRouteExtJob) {
    await waitRouteExtJob(ctx, routeExtJobName(releaseName, buildId));
  }

  // D4-D5. The SAME boundary, for providers that register ext_proc in-cluster.
  if (inputs.hasEnvoyExtensionPolicy) {
    await waitPolicyAccepted(ctx);
  }

  if (compositionSnapshot) {
    console.log("  → Verifying composition-plan readiness...");
    try {
      await waitForCompositionPlanReadiness(compositionSnapshot.plan);
    } catch (error) {
      const edge = await deps.restoreEdgeToPreviousBuild();
      throw new Error(
        [
          `Composition-plan readiness failed; refusing traffic cutover: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          ...deps.edgeStatusLines(edge),
        ].join("\n"),
      );
    }
    console.log("  → Composition-plan resources are ready ✓");
  }

  // D6 (7a-ter). N64/N67/S18: match the outgoing build's capacity under temporarily lifted
  // HPA bounds; restoreWarmedHpas puts the chart's bounds back on EVERY exit path.
  const { capacityTargets, restoreWarmedHpas } = await warmUpHpas(
    ctx,
    pools,
    previousReplicasByPool,
  );

  // D7 (7b). Per-pool /readyz capacity gate with failure diagnostics.
  await waitReadyCapacity(ctx, capacityTargets, restoreWarmedHpas);

  // E1 (7c). Cut traffic over: patch each active Service selector to the new build.
  await switchTrafficToNewBuild({
    releaseName,
    namespace,
    safeBuildId,
    pools,
    hasPortableOrigin,
    defaultPool,
    deps,
    restoreWarmedHpas,
  });

  // E2 (7d). Commit deploy state IMMEDIATELY after the confirmed cutover — before anything
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
          ...(recordablePreviousBuildId ? { [recordablePreviousBuildId]: [...previousPools] } : {}),
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
      { clusterOnly: stateStore === "cluster-only" },
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
      stateStore === "cluster-only"
        ? `  The new build IS serving, but the cluster ConfigMap was not updated. Re-run the\n` +
            `  cutover Job (it re-reads the cluster) so state agrees before the next promotion.\n`
        : `  The new build IS serving, but the cluster ConfigMap was not updated. Restore\n` +
            `  connectivity and re-run so cluster/local state agree before the next deploy.\n`,
    );
    throw new CutoverExitError(1);
  }

  // E3 (7d-bis). N67: the cutover is durable and the new build is taking 100% of traffic at
  // the outgoing build's capacity — the warm-up is over, so hand the pool back to the
  // chart's autoscaling bounds. Deliberately AFTER the state commit (a failure here must
  // never be able to lose a confirmed cutover) and BEFORE the best-effort steps below, so
  // the HPA is chart-intended on every path out of this function. Scaling DOWN from here
  // is the autoscaler's decision under real load, bounded by the operator's config.
  await restoreWarmedHpas();

  // E4 (7e). State is durable. Now invalidate the PREVIOUS build's Cloud CDN entries
  // (best-effort, non-fatal; TTL self-heals) so its stale content stops serving.
  // Deliberately post-cutover — the new origin must be live before the old entries
  // are dropped — but after the state commit (7d) so a failure here can't leave
  // cluster state pointing at the outgoing build.
  if (!compositionSnapshot && inputs.cdnEnabled && inputs.projectId) {
    try {
      await invalidateCdnBuildTag({
        projectId: inputs.projectId,
        releaseName,
        outputDir: inputs.outputDir,
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

  // E5 (7f). Scale the previous build down to 0 (kept as the rollback target).
  await scaleDownPreviousBuild({ releaseName, namespace, buildId, previousBuildId, previousPools });

  // E6 (7g). GC superseded builds, retained stable groups, old route-ext Jobs,
  // snapshot/plan ConfigMaps, and unreferenced dispatch Secrets (N87).
  await gcSupersededResources({
    releaseName,
    namespace,
    buildId,
    previousBuildId,
    pools,
    previousPools,
    hasPortableOrigin,
  });
}

/**
 * The rollback traffic reversal (rollback steps 1-5): capacity plan → scale-up → HPA
 * recreate/widen → rollout wait → serving gate → composition readiness → selector snapshot →
 * edge revert → selector flip → state swap → CDN invalidation → current-build scale-down.
 * The caller (runRollback today, the cutover Job's `--rollback` mode next phase) resolves
 * topologies, Deployment names, and chart scaling config before calling.
 */
export async function runRevert(inputs: RevertInputs): Promise<void> {
  const {
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
    registry,
  } = inputs;

  // 1. Scale up every pool's previous deployment — to at least the capacity the CURRENT
  // build is running (N26), never the old hardcoded 2. Done BEFORE any selector flip so
  // the target is already at size when traffic arrives.
  const capacityByPool = new Map<string, { replicas: number; min: number; max: number }>();
  for (const previousDeploy of previousDeploys) {
    const scaling = scalingByPool.get(previousDeploy.pool) ?? { min: 1, max: 3, targetCPU: 80 };
    const { observed, unreadable } = await readLiveCapacity(
      releaseName,
      previousDeploy.pool,
      currentBuildId,
      namespace,
    );
    if (unreadable.length > 0) {
      console.warn(
        `  ! Could not read the current build's live capacity (${unreadable.join(", ")}) — ` +
          `scaling ${previousDeploy.name} to the configured floor instead. If the current ` +
          `build was serving more than that, scale the rollback target up manually.`,
      );
    }
    const plan = planRollbackCapacity(observed, scaling);
    capacityByPool.set(previousDeploy.pool, plan);
    const observedNote =
      observed.specReplicas !== null || observed.hpaDesired !== null
        ? ` (current build: spec=${observed.specReplicas ?? "?"}, ready=${
            observed.readyReplicas ?? "?"
          }, hpaDesired=${observed.hpaDesired ?? "?"})`
        : "";
    console.log(
      `  → Scaling up previous build: ${previousDeploy.name} → ${plan.replicas} replicas${observedNote}`,
    );
    await execOrThrow(
      "kubectl",
      [
        "scale",
        `deployment/${previousDeploy.name}`,
        "-n",
        namespace,
        `--replicas=${plan.replicas}`,
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
  }

  // Recreate the rollback build's HPA. Deploy removes it before parking that build at zero,
  // otherwise the autoscaler would immediately raise it back to minReplicas. The name comes
  // from poolResourceNames so the existence probe finds the HPA the template actually
  // rendered (see the divergence note at the discovery loop above).
  // N26: min/max come from planRollbackCapacity, not the chart defaults — an HPA capped at
  // the default max 3 would drag a 20-replica workload back down mid-incident. An HPA that
  // already exists is WIDENED (its min/max could be the parked build's stale values).
  for (const previousDeploy of previousDeploys) {
    const hpaName = previousDeploy.hpa;
    const scaling = scalingByPool.get(previousDeploy.pool) ?? { min: 1, max: 3, targetCPU: 80 };
    const plan = capacityByPool.get(previousDeploy.pool) ?? {
      replicas: ROLLBACK_MIN_REPLICAS,
      min: scaling.min,
      max: scaling.max,
    };
    const hpa = await execCapture(
      "kubectl",
      ["get", "hpa", hpaName, "-n", namespace, "--ignore-not-found", "-o", "name"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (!hpa.stdout.trim()) {
      await execOrThrow(
        "kubectl",
        [
          "autoscale",
          "deployment",
          previousDeploy.name,
          "-n",
          namespace,
          `--name=${hpaName}`,
          `--min=${plan.min}`,
          `--max=${plan.max}`,
          `--cpu=${scaling.targetCPU}%`,
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
    } else {
      const widen = await execCapture(
        "kubectl",
        [
          "patch",
          "hpa",
          hpaName,
          "-n",
          namespace,
          "--type=merge",
          // Same field-manager rationale as the Service/Deployment patches: helm owns the
          // chart-rendered HPA, so the next `helm upgrade` must not conflict here.
          "--field-manager=helm",
          "-p",
          JSON.stringify({ spec: { minReplicas: plan.min, maxReplicas: plan.max } }),
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (widen.exitCode !== 0) {
        console.warn(
          `  ! Could not raise ${hpaName} to min=${plan.min}/max=${plan.max}: ` +
            `${sanitizeForTerminal(widen.stderr.trim()) || `exit ${widen.exitCode}`} — the rollback target may ` +
            `autoscale back below the capacity the current build was serving.`,
        );
      }
    }
  }

  // 2. Wait for every previous pool's pods to be ready
  console.log(`  → Waiting for previous build pods to be ready...`);
  for (const previousDeploy of previousDeploys) {
    await execOrThrow(
      "kubectl",
      ["rollout", "status", `deployment/${previousDeploy.name}`, "-n", namespace, "--timeout=120s"],
      { timeoutMs: EXEC_TIMEOUTS.rollout },
    );
  }

  // 3. Prove the previous build is actually SERVING before cutting traffic (gates.ts).
  const safePreviousBuild = sanitizeK8sName(previousBuildId);
  await waitPreviousBuildServing({
    releaseName,
    namespace,
    previousBuildId,
    safePreviousBuild,
    previousDeploys,
  });
  if (targetComposition) {
    console.log("  → Verifying rollback target composition readiness...");
    await waitForCompositionPlanReadiness(targetComposition.plan);
  }

  // 3.5 (N70). Snapshot every selector that will change, before the edge is reverted.
  const plan = await snapshotRevertSelectors({
    releaseName,
    namespace,
    poolNames,
    currentPoolNames,
    previousBuildId,
    state,
  });

  // 3b. Revert the routing tier (image + manifest) to the previous build BEFORE flipping
  // pool traffic — the same order deploy applies (edge first, selectors second), so the
  // middleware/manifest never trails the pools by more than one step.
  assertSafeBuildId(previousBuildId);
  if (registry) assertSafeImageRegistry(registry);
  await revertRoutingServiceToBuild({
    releaseName,
    namespace,
    targetBuildId: previousBuildId,
    registry,
    targetImageDigest: state.routingImageDigests?.[previousBuildId],
    targetPlatform: state.targetPlatforms?.[previousBuildId],
  });

  // 4. Switch traffic: patch active Service selectors to the previous build (traffic.ts).
  await flipSelectorsToPreviousBuild({
    releaseName,
    namespace,
    currentBuildId,
    previousBuildId,
    safePreviousBuild,
    plan,
    state,
    registry,
  });

  // 4b. Swap state immediately after the traffic switch, while both builds are still healthy.
  // Committing BEFORE the (potentially minutes-long) CDN invalidation shrinks the window where
  // an interrupt leaves traffic on the previous build with state still claiming the current one
  // — mirrors deploy's patch → writeState → invalidate ordering. If persistence fails, traffic
  // already points at the previous build but either version remains safe to select during
  // recovery.
  try {
    // A rollback swaps the two build pointers; it does not create a new build. Preserve every
    // other durable state field by default so per-build provenance remains available in BOTH
    // directions. Keeping an allowlist here already lost routingImageDigests and
    // unretainedManifestBuilds in production, which made the next rollback downgrade the edge
    // from an immutable digest to a mutable tag and hid the retained-manifest warning.
    //
    // generation/updatedAt belong to writeState, and readinessPathSupported is the one
    // deliberate exception: it describes the build that is NOW serving, so rolling back to an
    // older build must conservatively clear it (see below).
    const { generation, updatedAt, readinessPathSupported, ...durableState } = state;
    void updatedAt;
    void readinessPathSupported;
    await writeState(
      projectDir,
      {
        ...durableState,
        buildId: previousBuildId,
        previousBuildId: currentBuildId,
        poolTopologies: {
          [previousBuildId]: [...poolNames],
          [currentBuildId]: [...currentPoolNames],
        },
        ...(state.defaultPools
          ? {
              defaultPools: Object.fromEntries(
                Object.entries(state.defaultPools).filter(([build]) =>
                  [currentBuildId, previousBuildId].includes(build),
                ),
              ),
            }
          : {}),
        // The pointer swap keeps these same two build artifacts in play. Prune any stale
        // provenance while preserving the exact platform recorded for both directions.
        ...(state.targetPlatforms
          ? {
              targetPlatforms: Object.fromEntries(
                Object.entries(state.targetPlatforms).filter(([build]) =>
                  [currentBuildId, previousBuildId].includes(build),
                ),
              ),
            }
          : {}),
        // `readinessPathSupported` is deliberately NOT carried forward. It means "the build
        // now serving answers /readyz", and after a rollback the serving build is an OLDER
        // one that may predate it — so dropping it is the conservative answer, and the next
        // deploy keeps the load balancer on /healthz for one cycle before flipping. OBSERVED
        // on the live cluster: deploy set it, a rollback cleared it, and the following deploy
        // therefore probed /healthz again — correct, and self-healing one cycle later. Do not
        // "fix" this by preserving it: that would point the load balancer at /readyz on a
        // build that may not serve it, which is the outage this migration exists to avoid.
        // N69: the generation this write is based on — writeState treats it as a floor, so
        // the local file stays provably newer than the cluster ConfigMap even when the
        // pre-write cluster read fails. Rollback used to omit it (deploy did not): in a
        // fresh CI checkout there is no local state.json to carry the generation forward,
        // so a post-cutover cluster outage stamped local generation 1 while the stale
        // cluster record sat at N — and readState prefers the higher generation, so the
        // next operation re-drained the build this rollback had just switched TO.
        basedOnGeneration: generation ?? null,
      },
      releaseName,
      namespace,
    );
  } catch (err) {
    console.error(`\n  Rollback traffic switch succeeded, but persisting state failed:`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      `  The local state file was updated but the cluster ConfigMap was not. Restore cluster`,
    );
    console.error(
      `  connectivity and re-run so cluster/local state agree before the next deploy or rollback.\n`,
    );
    throw new CutoverExitError(1);
  }

  // 4c. Traffic now points at the previous build and state is committed. Invalidate the CDN
  // entries tagged for the build we rolled AWAY from (currentBuildId) so its stale content
  // stops serving. Best-effort and non-fatal — a failure just lets the TTL self-heal.
  if (inputs.cdnEnabled) {
    try {
      if (inputs.projectId) {
        await invalidateCdnBuildTag({
          projectId: inputs.projectId,
          releaseName,
          outputDir: inputs.outputDir,
          buildId: currentBuildId,
          // M13: the tag recorded when the rolled-away-from build deployed — never
          // re-derived here. Absent (pre-recording state) → full --path=/* purge.
          recordedTag: state.cdnTags?.[currentBuildId],
          run: (cmd, args, o) =>
            execCapture(cmd, args, { timeoutMs: EXEC_TIMEOUTS.cloudOperation, ...o }),
          log: (m) => console.log(m),
        });
      }
    } catch (err) {
      console.log(
        `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. State is durable; scale down every former-current Deployment (gc.ts).
  await scaleDownCurrentBuild({ namespace, currentDeploys });
}
