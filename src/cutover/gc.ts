// src/cutover/gc.ts
// GitOps PR2: Phase E5/E6 — previous-build scale-down and superseded-resource GC, moved
// verbatim from src/cli/deploy.ts steps 7f/7g; plus rollback's capacity planning
// (planRollbackCapacity / readLiveCapacity, the N26 "incident-sized capacity" facts Git
// cannot know) and its post-swap scale-down.
import { execCapture, execOrThrow, EXEC_TIMEOUTS } from "../cli/exec.js";
import { sanitizeForTerminal } from "../cli/terminal.js";
import { poolResourceNames, sanitizeK8sName } from "../emit/templates/utils.js";
import { routeExtJobName } from "../emit/templates/route-ext-update-job.js";
import {
  ROUTING_MANIFEST_SNAPSHOT_COMPONENT,
  routingManifestSnapshotName,
  routingServiceDeploymentName,
} from "../emit/templates/routing-manifest-configmap.js";
import {
  COMPOSITION_PLAN_COMPONENT,
  compositionPlanConfigMapName,
} from "../emit/templates/composition-plan-configmap.js";
// N87: internal dispatch Secrets are per BUILD and annotated `helm.sh/resource-policy: keep`,
// so the cutover owns the pruning half of their lifecycle (deploy owns the keep-at-upgrade
// half): delete the ones nothing references any more.
import {
  INTERNAL_SECRET_COMPONENT,
  internalSecretName,
} from "../emit/templates/internal-secret.js";
import {
  cleanupRetainedStablePoolResources,
  hasHealthCheckPolicyCrd,
} from "../cli/stable-pool-resources.js";
import type { PoolDeploy } from "./inputs.js";

// 7f (E5). State is durable and traffic has switched, so it is now safe to scale the previous
// build down to 0. It served through the rollout and remains as the rollback target.
// Best-effort: success is already durable (7d) — a failure here warns instead of
// failing the whole deploy (the previous build just keeps burning replicas until the
// next deploy or a manual scale-down). The outgoing HPA was transferred out of Helm
// release-manifest lifecycle before the upgrade so it could remain active while this build
// served. Delete it now and wait for that deletion to finish BEFORE setting replicas=0;
// if deletion fails, leave the Deployment alone rather than asking a still-live HPA to
// fight the scale command.
export async function scaleDownPreviousBuild(opts: {
  releaseName: string;
  namespace: string;
  buildId: string;
  previousBuildId: string | null;
  previousPools: string[];
}): Promise<void> {
  const { releaseName, namespace, buildId, previousBuildId, previousPools } = opts;
  if (previousBuildId && previousBuildId !== buildId) {
    let scaleDownFailed = false;
    for (const poolName of previousPools) {
      // The HPA name must come from the SAME suffix-reserving helper the template
      // uses (hpa.ts truncates the base at 59, then appends "-hpa") — concatenating
      // "-hpa" onto the 63-truncated deployment name diverges past that boundary
      // (and can exceed 63 chars), so this delete silently missed the real HPA and
      // the autoscaler rescaled the parked previous build right back up.
      const { deployment: poolPrevName, hpa: poolPrevHpa } = poolResourceNames(
        releaseName,
        poolName,
        previousBuildId,
      );
      const hpaDelete = await execCapture(
        "kubectl",
        ["delete", "hpa", poolPrevHpa, "-n", namespace, "--ignore-not-found"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (hpaDelete.exitCode !== 0) {
        scaleDownFailed = true;
        console.warn(
          `  ! Could not remove outgoing autoscaler ${poolPrevHpa}; leaving ` +
            `${poolPrevName} at its current replica count because that HPA could immediately ` +
            `undo a scale to zero: ${sanitizeForTerminal(hpaDelete.stderr.trim()) || "unknown error"}`,
        );
        continue;
      }
      const scaleDown = await execCapture(
        "kubectl",
        ["scale", `deployment/${poolPrevName}`, "-n", namespace, "--replicas=0"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (scaleDown.exitCode !== 0) {
        scaleDownFailed = true;
        console.warn(
          `  ! Could not scale down ${poolPrevName}: ` +
            `${sanitizeForTerminal(scaleDown.stderr.trim()) || "unknown error"}`,
        );
      }
    }
    if (scaleDownFailed) {
      console.warn(
        `  ! Previous build ${previousBuildId} was NOT fully scaled to 0 — it keeps its ` +
          `replicas until the next deploy. Scale it down manually when convenient.`,
      );
    } else {
      console.log(`  → Previous build scaled to 0 (kept for rollback)`);
    }
  }
}

// 7g (E6). Clean up old deployments and the retained/versioned objects nothing needs.
// The previous build was scaled to 0 in step 7f above (kept as the rollback target).
// Delete anything that isn't the current or previous build. Classify by EXACT deployment name
// (reconstructed with the same sanitizer the template uses) rather than a 12-char normalized
// substring — a shared prefix between two build ids could otherwise delete the wrong build.
export async function gcSupersededResources(opts: {
  releaseName: string;
  namespace: string;
  buildId: string;
  previousBuildId: string | null;
  pools: string[];
  previousPools: string[];
  hasPortableOrigin: boolean;
}): Promise<void> {
  const { releaseName, namespace, buildId, previousBuildId, pools, previousPools } = opts;
  const routingDeploy = routingServiceDeploymentName(releaseName);
  const currentRouteExtJob = routeExtJobName(releaseName, buildId);
  const currentDeployNames = new Set(
    pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${buildId}`)),
  );
  const previousDeployNames = previousBuildId
    ? new Set(previousPools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`)))
    : undefined;

  const allDeploys = await execCapture(
    "kubectl",
    [
      "get",
      "deployments",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (allDeploys.exitCode === 0) {
    for (const name of allDeploys.stdout.trim().split("\n")) {
      // The routing tier is a stable in-place Deployment — never a cleanup candidate.
      // EXACT name match: a substring match would also spare (or, elsewhere, drop) a
      // pool deployment that merely contains "routing-service" in its name.
      if (!name || name === routingDeploy) continue;
      // Keep current build
      if (currentDeployNames.has(name)) continue;
      // Keep previous build (rollback target)
      if (previousDeployNames?.has(name)) {
        console.log(`  → Previous build kept for rollback: ${name}`);
        continue;
      }
      // If we don't know the previous build, we cannot classify this non-current
      // deployment as safe to delete. Be conservative and keep it as a potential
      // rollback target rather than blanket-deleting every non-current build.
      if (!previousBuildId) {
        console.log(
          `  → Conservative cleanup: keeping non-current build "${name}" ` +
            `(previous-build state unknown, cannot classify as safe to delete)`,
        );
        continue;
      }
      // Delete everything else
      console.log(`  → Deleting old build: ${name}`);
      await execCapture("kubectl", ["delete", "deployment", name, "-n", namespace], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      });
      await execCapture("kubectl", ["delete", "service", name, "-n", namespace], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => {});
      // This build's raw release/pool/buildId parts are unknowable here (`name` is a
      // cluster-listed deployment of a build state no longer tracks), so the HCP name
      // can't go through poolResourceNames. Re-sanitizing the deployment name with the
      // "-hcp" suffix reproduces the template's name exactly: for a base past the
      // 59-char boundary, re-truncating the 63-char deployment name to 59 yields the
      // same prefix the template truncated to (any trailing hyphens the template's
      // strip removed beyond 59 are re-stripped here). Bare `${name}-hcp` diverged
      // there — and could exceed 63 chars, an invalid name kubectl rejects.
      await execCapture(
        "kubectl",
        ["delete", "healthcheckpolicy", sanitizeK8sName(name, "-hcp"), "-n", namespace],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      ).catch(() => {});
    }
  }

  // Stable resources transferred out of Helm's deletion set deliberately survive without
  // rewriting their managed-by label while their pool belongs to either build in play. Once a
  // later successful cutover removes that pool from BOTH topologies, delete the exact
  // adapter-retained Service/PDB/HCP group. This is post-state
  // commit and best-effort: cleanup failure leaks bounded objects but cannot invalidate the
  // serving cutover. The helper validates ownership, labels, names, and selectors before any
  // deletion and keeps the Service as a retry anchor when a companion delete fails.
  try {
    let healthCheckPolicyCrd = false;
    try {
      healthCheckPolicyCrd = await hasHealthCheckPolicyCrd();
    } catch (err) {
      // Post-commit cleanup can still safely classify Service/PDB without cluster-wide CRD
      // permission. Preserve a truthful warning that HCP cleanup was skipped.
      console.warn(
        `  ! Could not classify retained HealthCheckPolicy objects: ` +
          `${err instanceof Error ? err.message : String(err)}. Service/PDB cleanup will ` +
          `continue; any retained HCP was left in place.`,
      );
    }
    const stableCleanup = await cleanupRetainedStablePoolResources({
      releaseName,
      namespace,
      keepPools: new Set([...pools, ...previousPools]),
      healthCheckPolicyCrd,
    });
    for (const deleted of stableCleanup.deleted) {
      console.log(`  → Deleted obsolete retained stable resource: ${deleted}`);
    }
    for (const failure of stableCleanup.failures) {
      console.warn(`  ! Retained stable-resource cleanup incomplete: ${failure}`);
    }
  } catch (err) {
    console.warn(
      `  ! Retained stable-resource cleanup could not run: ` +
        `${err instanceof Error ? err.message : String(err)}. The deploy is committed; ` +
        `the retained objects were left in place for a later retry.`,
    );
  }

  // Clean up OLD route-ext Jobs (K8s Jobs are immutable; each deploy creates a fresh
  // one). Skip the CURRENT job by EXACT name — a fuzzy build-id substring match here
  // (12-char slice vs the name's 10-char slice) previously deleted the running job
  // before it could register the extension, so the traffic ext never got reconciled.
  const oldJobs = await execCapture(
    "kubectl",
    [
      "get",
      "jobs",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=route-ext-job`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (oldJobs.exitCode === 0) {
    for (const jobName of oldJobs.stdout.trim().split("\n")) {
      if (!jobName || jobName === currentRouteExtJob) continue;
      await execCapture("kubectl", ["delete", "job", jobName, "-n", namespace], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      });
    }
  }

  // Prune retained routing-manifest snapshot ConfigMaps that belong to neither the
  // current nor the previous build. Deploy and rollback each retain one (up to ~1 MiB
  // of etcd apiece) and nothing else ever deleted them, so they accumulated
  // unboundedly. Classify by EXACT snapshot name (the same helper that named them);
  // mirror the deployment cleanup's conservatism above — with no known previous
  // build, non-current snapshots can't be classified as safe to delete, so keep them.
  // Best-effort: state is already committed (7d), a failure here only leaks storage.
  if (previousBuildId) {
    const keepSnapshots = new Set([
      routingManifestSnapshotName(releaseName, buildId),
      routingManifestSnapshotName(releaseName, previousBuildId),
    ]);
    const snapshots = await execCapture(
      "kubectl",
      [
        "get",
        "configmaps",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (snapshots.exitCode === 0) {
      for (const cmName of snapshots.stdout.trim().split("\n")) {
        if (!cmName || keepSnapshots.has(cmName)) continue;
        console.log(`  → Deleting old routing-manifest snapshot: ${cmName}`);
        await execCapture("kubectl", ["delete", "configmap", cmName, "-n", namespace], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        });
      }
    }

    if (opts.hasPortableOrigin) {
      const keepPlans = new Set([
        compositionPlanConfigMapName(releaseName, buildId),
        compositionPlanConfigMapName(releaseName, previousBuildId),
      ]);
      const plans = await execCapture(
        "kubectl",
        [
          "get",
          "configmaps",
          "-n",
          namespace,
          "-l",
          `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${COMPOSITION_PLAN_COMPONENT}`,
          "-o",
          'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (plans.exitCode === 0) {
        for (const cmName of plans.stdout.trim().split("\n")) {
          if (!cmName || keepPlans.has(cmName)) continue;
          console.log(`  → Deleting old composition plan: ${cmName}`);
          await execCapture("kubectl", ["delete", "configmap", cmName, "-n", namespace], {
            timeoutMs: EXEC_TIMEOUTS.kubectl,
          });
        }
      }
    }
  }

  // N87. Prune internal dispatch Secrets that no Deployment references any more. Each
  // build renders its OWN Secret (`<release>-ihs-<build>-<digest>`) annotated
  // `helm.sh/resource-policy: keep`, so helm never prunes them — deliberately: the
  // retained previous build's pods reference theirs BY NAME and a missing secretKeyRef is
  // CreateContainerConfigError, so pruning on upgrade would brick both a restart in the
  // deploy window and the rollback. Keeping them makes GC this step's job (the
  // routing-manifest snapshots accumulated unboundedly for exactly the same reason).
  //
  // Classify by what is actually REFERENCED, not by build id: that covers the current
  // build, the retained previous build, the LEGACY stable-named Secret still needed by a
  // pre-N87 rollback target, the builds whose Deployments were just deleted above, and
  // leftovers from an earlier incarnation of this release name — with no assumption about
  // which builds exist. Conservative on every failure: an unreadable or unparseable
  // reference set skips the sweep entirely, because deleting a Secret a live pod template
  // needs would brick that build's restarts. Best-effort — state is already committed
  // (7d), so a failure here only leaks a handful of 64-byte Secrets.
  const deploySpecs = await execCapture(
    "kubectl",
    [
      "get",
      "deployments",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      "json",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  let referencedSecrets: Set<string> | null = null;
  if (deploySpecs.exitCode === 0 && deploySpecs.stdout.trim()) {
    try {
      const parsed = JSON.parse(deploySpecs.stdout) as {
        items?: {
          spec?: {
            template?: {
              spec?: {
                containers?: { env?: { valueFrom?: { secretKeyRef?: { name?: string } } }[] }[];
              };
            };
          };
        }[];
      };
      // Every secretKeyRef, not only the internal one — a superset is harmless here
      // because only Secrets carrying the internal-secret component label are candidates.
      referencedSecrets = new Set(
        (parsed.items ?? []).flatMap((d) =>
          (d.spec?.template?.spec?.containers ?? []).flatMap((c) =>
            (c.env ?? [])
              .map((e) => e.valueFrom?.secretKeyRef?.name)
              .filter((n): n is string => typeof n === "string" && n.length > 0),
          ),
        ),
      );
      // Belt and braces: this deploy's own Secret is referenced by definition, and the
      // pod templates it belongs to may not be listed yet on a slow API read.
      referencedSecrets.add(internalSecretName(releaseName, buildId));
      if (previousBuildId) {
        referencedSecrets.add(internalSecretName(releaseName, previousBuildId));
      }
    } catch {
      referencedSecrets = null;
    }
  }
  if (referencedSecrets === null) {
    console.warn(
      `  ! Could not read which Secrets the release's Deployments reference ` +
        `(kubectl exit ${deploySpecs.exitCode}) — skipping the internal-secret prune. ` +
        `Old per-build dispatch Secrets stay until the next successful deploy.`,
    );
  } else {
    const internalSecrets = await execCapture(
      "kubectl",
      [
        "get",
        "secrets",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (internalSecrets.exitCode === 0) {
      for (const secretName of internalSecrets.stdout.trim().split("\n")) {
        if (!secretName || referencedSecrets.has(secretName)) continue;
        console.log(`  → Deleting unreferenced internal dispatch Secret: ${secretName}`);
        await execCapture("kubectl", ["delete", "secret", secretName, "-n", namespace], {
          timeoutMs: EXEC_TIMEOUTS.kubectl,
        });
      }
    }
  }
}

/**
 * N26: the capacity a rolled-back build must come back at. Rollback used to scale the
 * target to a hardcoded 2 replicas and (re)create its HPA from the chart defaults
 * (min 1 / max 3): roll back a build that was serving 20 under load and the site returns
 * on 2 pods that can autoscale to 3 — a self-inflicted overload during an incident.
 * Deploy's mirror of this decision (the retained-manifest replica probe) refuses to guess
 * at all; here the guess is bounded by what the CURRENT build is actually running.
 *
 * Pure so the arithmetic is unit-testable without a cluster.
 */
export const ROLLBACK_MIN_REPLICAS = 2;

export interface LiveCapacity {
  /** `.spec.replicas` of the current build's Deployment (null = unreadable/absent). */
  specReplicas: number | null;
  /** `.status.readyReplicas` — pods actually serving right now. */
  readyReplicas: number | null;
  /** HPA `.status.desiredReplicas` — what the autoscaler had decided under load. */
  hpaDesired: number | null;
  /** HPA `.spec.maxReplicas` — the ceiling the current build was allowed to reach. */
  hpaMax: number | null;
}

export function planRollbackCapacity(
  observed: LiveCapacity,
  scaling: { min: number; max: number; targetCPU: number },
): { replicas: number; min: number; max: number } {
  const live = Math.max(
    observed.specReplicas ?? 0,
    observed.readyReplicas ?? 0,
    observed.hpaDesired ?? 0,
  );
  const replicas = Math.max(ROLLBACK_MIN_REPLICAS, scaling.min, live);
  // The HPA must not immediately undo the scale-up (min) and must be able to grow past
  // where the current build already was (max). The next deploy omits this HPA when it parks
  // the build again, so this widening is scoped to the incident.
  return { replicas, min: replicas, max: Math.max(scaling.max, observed.hpaMax ?? 0, replicas) };
}

/**
 * Read what the CURRENT build is running, machine-readably: `--ignore-not-found` makes a
 * genuinely absent Deployment/HPA exit 0 with empty stdout, so a non-zero exit is a real
 * read failure. A read failure does NOT abort the rollback (the current build may be the
 * broken thing we are escaping) — it degrades to the configured floor and says so.
 */
export async function readLiveCapacity(
  releaseName: string,
  pool: string,
  currentBuildId: string,
  namespace: string,
): Promise<{ observed: LiveCapacity; unreadable: string[] }> {
  const { deployment, hpa } = poolResourceNames(releaseName, pool, currentBuildId);
  const unreadable: string[] = [];
  const observed: LiveCapacity = {
    specReplicas: null,
    readyReplicas: null,
    hpaDesired: null,
    hpaMax: null,
  };

  const dep = await execCapture(
    "kubectl",
    [
      "get",
      "deployment",
      deployment,
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "jsonpath={.metadata.name}|{.spec.replicas}|{.status.readyReplicas}",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (dep.exitCode !== 0) unreadable.push(`deployment ${deployment}`);
  else {
    const [name, spec, ready] = dep.stdout.trim().split("|");
    if (name) {
      const s = parseInt(spec ?? "", 10);
      const r = parseInt(ready ?? "", 10);
      if (Number.isFinite(s)) observed.specReplicas = s;
      if (Number.isFinite(r)) observed.readyReplicas = r;
    }
  }

  const hpaRes = await execCapture(
    "kubectl",
    [
      "get",
      "hpa",
      hpa,
      "-n",
      namespace,
      "--ignore-not-found",
      "-o",
      "jsonpath={.metadata.name}|{.status.desiredReplicas}|{.spec.maxReplicas}",
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (hpaRes.exitCode !== 0) unreadable.push(`hpa ${hpa}`);
  else {
    const [name, desired, max] = hpaRes.stdout.trim().split("|");
    if (name) {
      const d = parseInt(desired ?? "", 10);
      const m = parseInt(max ?? "", 10);
      if (Number.isFinite(d)) observed.hpaDesired = d;
      if (Number.isFinite(m)) observed.hpaMax = m;
    }
  }

  return { observed, unreadable };
}

// Rollback step 5 (E5's mirror). State is durable; scale down every former-current
// Deployment. The HPA must be deleted first (by its template-derived name — see the
// discovery-loop note in rollback.ts) or the autoscaler immediately rescales the parked
// build back to minReplicas.
export async function scaleDownCurrentBuild(opts: {
  namespace: string;
  currentDeploys: PoolDeploy[];
}): Promise<void> {
  const { namespace, currentDeploys } = opts;
  for (const currentDeploy of currentDeploys) {
    console.log(`  → Scaling down current build: ${currentDeploy.name}`);
    await execOrThrow(
      "kubectl",
      ["delete", "hpa", currentDeploy.hpa, "-n", namespace, "--ignore-not-found"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    await execOrThrow(
      "kubectl",
      ["scale", `deployment/${currentDeploy.name}`, "-n", namespace, "--replicas=0"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
  }
}
