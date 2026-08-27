// src/cutover/traffic.ts
// GitOps PR2: Phase E1 — the selector cutover, moved verbatim from src/cli/deploy.ts step 7c
// and src/cli/rollback.ts step 4 (snapshot-first, full-`/spec/selector` replace where a
// snapshot exists, by-NAME addressing because Helm rewrites the `managed-by` label).
import { execCapture, EXEC_TIMEOUTS } from "../cli/exec.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";
import { routingServiceDeploymentName } from "../emit/templates/routing-manifest-configmap.js";
import { revertRoutingServiceToBuild } from "./edge.js";
import { assertSafeBuildId } from "../emit/templates/utils.js";
import type { AdapterState } from "../cli/state.js";
import { CutoverExitError, type CutoverDeps } from "./inputs.js";

// 7c (E1). Cut traffic over: patch each active Service selector to the new build.
// MUST use the exact same sanitizer that stamped the pod labels (sanitizeK8sName,
// which prepends `b-` when the build id starts with a non-letter). An inline
// transform that omits the `b-` prefix writes a selector that matches no pods:
// the Service drains to zero endpoints, its standalone NEG empties, and the LB
// returns 503 `failed_to_connect_to_backend` for every origin request (only CDN
// cache hits survive). This bit us on build ids beginning with a digit.
// (safeBuildId is computed once in step 7 above and reused here.)
export async function switchTrafficToNewBuild(opts: {
  releaseName: string;
  namespace: string;
  safeBuildId: string;
  expectedCurrentBuildId: string | null;
  pools: string[];
  hasPortableOrigin: boolean;
  defaultPool: string;
  deps: CutoverDeps;
  restoreWarmedHpas: () => Promise<void>;
}): Promise<void> {
  const {
    releaseName,
    namespace,
    safeBuildId,
    expectedCurrentBuildId,
    pools,
    hasPortableOrigin,
    defaultPool,
    deps,
  } = opts;
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
          sanitizeForTerminal(read.stderr.trim()) ||
          `could not read an exact Service selector (kubectl exited ${read.exitCode})`,
      });
      continue;
    }
    originalServiceSelectors.set(activeServiceName, selector as Record<string, string>);
    if (
      expectedCurrentBuildId &&
      (selector as Record<string, string>)["app.kubernetes.io/version"] !==
        sanitizeK8sName(expectedCurrentBuildId)
    ) {
      patchFailures.push({
        pool: servicePool,
        service: activeServiceName,
        stderr:
          `selector changed concurrently: expected version ` +
          `${sanitizeK8sName(expectedCurrentBuildId)}, found ` +
          `${JSON.stringify((selector as Record<string, string>)["app.kubernetes.io/version"])}`,
      });
    }
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
          stderr: sanitizeForTerminal(patchResult.stderr.trim()),
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
    const edge = await deps.restoreEdgeToPreviousBuild();
    // N67: restore the chart's autoscaling bounds on the build we are abandoning.
    await opts.restoreWarmedHpas();
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
      console.error(`  WARNING: failed to restore selector(s) for: ${revertFailures.join(", ")}.`);
      console.error(`  Traffic may be split across builds; repair those Services manually.`);
    } else if (patchedServices.length > 0) {
      console.error(`  Any successful selector patches were restored to their prior values.`);
    }
    console.error(`  Old deployments were left in place.`);
    for (const line of deps.edgeStatusLines(edge)) console.error(line);
    console.error(`  No cleanup was performed. Investigate and re-run the deploy.\n`);
    console.error(`  Diagnose:  npx adapter-k8s doctor`);
    // Do NOT write committed state here: traffic did not switch, so the previously-serving
    // build is still current. Recording the new build as current would strand the real
    // rollback target on the next deploy/rollback.
    throw new CutoverExitError(1);
  }
}

/** The service→pool routing plan a revert flips, plus the exact selectors to restore. */
export interface RevertSelectorPlan {
  serviceDestinations: { servicePool: string; targetPool: string }[];
  originalSelectors: Map<string, Record<string, string>>;
}

// N70 (rollback step 3.5): Helm is not rolled back, so HTTPRoute still carries the
// former-current topology. Every Service selector that will be changed must be captured
// before the edge is reverted. This is required even when pool topology is unchanged: the
// portable origin's component is the build's default pool, not the Service suffix "origin",
// so a guessed partial-failure restore would drain it to zero endpoints.
export async function snapshotRevertSelectors(opts: {
  releaseName: string;
  namespace: string;
  poolNames: string[];
  currentPoolNames: string[];
  previousBuildId: string;
  state: AdapterState;
}): Promise<RevertSelectorPlan> {
  const { releaseName, namespace, poolNames, currentPoolNames, previousBuildId, state } = opts;
  const targetPoolSet = new Set(poolNames);
  const currentOnlyPools = currentPoolNames.filter((pool) => !targetPoolSet.has(pool));
  const topologyChanged =
    currentOnlyPools.length > 0 || poolNames.some((pool) => !currentPoolNames.includes(pool));
  const fallbackTargetPool = poolNames[0]!;
  let hasPortableOrigin = Boolean(state.defaultPools);
  const originLookup = await execCapture(
    "kubectl",
    [
      "get",
      "service",
      sanitizeK8sName(`${releaseName}-origin`),
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "name",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (originLookup.exitCode !== 0) {
    throw new Error(
      `Could not determine whether the portable origin Service exists: ` +
        `${sanitizeForTerminal(originLookup.stderr.trim()) || `kubectl exited ${originLookup.exitCode}`}`,
    );
  }
  hasPortableOrigin =
    originLookup.stdout.trim() === `service/${sanitizeK8sName(`${releaseName}-origin`)}`;
  const serviceDestinations = [
    ...poolNames.map((pool) => ({ servicePool: pool, targetPool: pool })),
    ...currentOnlyPools.map((pool) => ({ servicePool: pool, targetPool: fallbackTargetPool })),
    ...(hasPortableOrigin
      ? [
          {
            servicePool: "origin",
            targetPool: state.defaultPools?.[previousBuildId] ?? fallbackTargetPool,
          },
        ]
      : []),
  ];
  const originalSelectors = new Map<string, Record<string, string>>();
  for (const { servicePool } of serviceDestinations) {
    // Same-topology pool Services can be reconstructed from their own pool suffix and the
    // current build. The origin cannot: its component is whichever pool that build declared
    // as default, so it always needs an exact snapshot.
    if (!topologyChanged && servicePool !== "origin") continue;
    const serviceName = sanitizeK8sName(`${releaseName}-${servicePool}`);
    if (originalSelectors.has(serviceName)) continue;
    const read = await execCapture(
      "kubectl",
      ["get", "service", serviceName, "-n", namespace, "-o", "json"],
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
      throw new Error(
        `Could not read the exact selector for rollback Service ` +
          `${serviceName} (kubectl exited ${read.exitCode}${read.stderr.trim() ? `: ${sanitizeForTerminal(read.stderr.trim())}` : ""}). ` +
          `Traffic was NOT switched; refusing to patch selectors without a reversible snapshot.`,
      );
    }
    originalSelectors.set(serviceName, selector as Record<string, string>);
  }
  return { serviceDestinations, originalSelectors };
}

// Rollback step 4 (E1's mirror). Switch traffic: patch active Service selectors to the
// previous build.
// The selector value MUST use the same sanitizer that stamped the pod label
// (sanitizeK8sName prepends `b-` when the build id starts with a non-letter). A
// divergent value (the old inline sanitizer omitted the `b-` prefix) matches no pods,
// draining the active Service to zero endpoints and 503'ing the site on rollback.
//
// Switch each target Service (`<release>-<pool>`) by NAME, then redirect Services that only
// exist in the still-installed HTTPRoute topology to a real target pool. (The template's
// `managed-by: adapter-k8s-active` label is overwritten by Helm to `managed-by: Helm`,
// so a label selector would match nothing, patch ZERO Services, skip the failure guard,
// and strand the site when the current build is scaled down.)
export async function flipSelectorsToPreviousBuild(opts: {
  releaseName: string;
  namespace: string;
  currentBuildId: string;
  previousBuildId: string;
  safePreviousBuild: string;
  plan: RevertSelectorPlan;
  state: AdapterState;
  registry: string | undefined;
}): Promise<void> {
  const { releaseName, namespace, currentBuildId, previousBuildId, safePreviousBuild, state } =
    opts;
  const { serviceDestinations, originalSelectors } = opts.plan;
  const patchFailures: { service: string; stderr: string }[] = [];
  const patchedServices: { service: string; pool: string }[] = [];
  console.log(`  → Switching traffic to previous build...`);
  for (const { servicePool, targetPool } of serviceDestinations) {
    const svcName = sanitizeK8sName(`${releaseName}-${servicePool}`);
    const patchResult = await execCapture(
      "kubectl",
      [
        "patch",
        "service",
        svcName,
        "-n",
        namespace,
        "--type=json",
        // --force-conflicts is NOT a valid `kubectl patch` flag (only `apply
        // --server-side` accepts it); a JSON patch needs no conflict override.
        "--field-manager=helm",
        "-p",
        JSON.stringify([
          {
            op: "replace",
            path: "/spec/selector/app.kubernetes.io~1component",
            value: targetPool,
          },
          {
            op: "replace",
            path: "/spec/selector/app.kubernetes.io~1version",
            value: safePreviousBuild,
          },
        ]),
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (patchResult.exitCode !== 0) {
      patchFailures.push({
        service: svcName,
        stderr: sanitizeForTerminal(patchResult.stderr.trim()),
      });
    } else {
      patchedServices.push({ service: svcName, pool: servicePool });
    }
  }

  // If any selector patch failed, traffic did not switch to the previous build.
  // Scaling the current deployment to 0 now would strand the still-current Services
  // with zero endpoints. Abort before scale-down, leaving the current build serving.
  if (patchFailures.length > 0) {
    const safeCurrentBuild = sanitizeK8sName(currentBuildId);
    const revertFailures: string[] = [];
    for (const { service: serviceName, pool } of patchedServices) {
      const original = originalSelectors.get(serviceName);
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
          JSON.stringify(
            original
              ? [{ op: "replace", path: "/spec/selector", value: original }]
              : [
                  {
                    op: "replace",
                    path: "/spec/selector/app.kubernetes.io~1component",
                    value: pool,
                  },
                  {
                    op: "replace",
                    path: "/spec/selector/app.kubernetes.io~1version",
                    value: safeCurrentBuild,
                  },
                ],
          ),
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
    }

    // The routing tier (image + manifest) was already reverted to the PREVIOUS build in
    // step 3b, but the pools are staying on the CURRENT one — roll the edge FORWARD
    // again so the abort leaves edge and pools consistent (the current build's manifest
    // snapshot was retained at the start of 3b, so image AND manifest are restorable).
    // Without this, the abort message would claim everything is still on the current
    // build while the edge kept serving the previous build's middleware/manifest.
    let edgeRestored = false;
    let edgeError = "";
    try {
      assertSafeBuildId(currentBuildId);
      await revertRoutingServiceToBuild({
        releaseName,
        namespace,
        targetBuildId: currentBuildId,
        registry: opts.registry,
        targetImageDigest: state.routingImageDigests?.[currentBuildId],
        targetPlatform: state.targetPlatforms?.[currentBuildId],
      });
      edgeRestored = true;
    } catch (err) {
      edgeError = err instanceof Error ? err.message : String(err);
    }

    console.error(`\n  ROLLBACK FAILED: traffic was NOT switched to the previous build.`);
    console.error(`  ${patchFailures.length} Service selector patch(es) failed:`);
    for (const f of patchFailures) {
      console.error(`    - service ${f.service}: ${f.stderr || "unknown error"}`);
    }
    if (revertFailures.length > 0) {
      console.error(`  WARNING: failed to restore selector(s): ${revertFailures.join(", ")}.`);
      console.error(`  Traffic may be split across builds; repair those Services manually.`);
    } else {
      console.error(`  Successful selector patches were restored to the current build.`);
    }
    if (edgeRestored) {
      console.error(`  The routing edge (image + manifest) was restored to the current build.`);
    } else {
      console.error(
        `  WARNING: could not roll the routing edge forward to the current build ` +
          `(${currentBuildId}): ${edgeError || "unknown error"}`,
      );
      console.error(
        `  The edge (ext_proc) is still serving build ${previousBuildId}'s middleware and ` +
          `routing manifest AGAINST pools serving ${currentBuildId}. Mismatched routes fall ` +
          `back to pool-local re-resolution (invariant 1), but edge middleware is the ` +
          `PREVIOUS build's until repaired.`,
      );
      console.error(`  Recover by re-running the rollback, or restore the edge manually:`);
      console.error(
        `    kubectl -n ${namespace} set image deployment/` +
          `${routingServiceDeploymentName(releaseName)} routing-service=` +
          `${opts.registry ?? "<registry>"}/routing-service:${currentBuildId}`,
      );
    }
    console.error(`  Both builds were left scaled up.`);
    console.error(`  State was not changed. Investigate and re-run the rollback.\n`);
    throw new CutoverExitError(1);
  }
}
