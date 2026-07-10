// src/cli/rollback.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture, execOrThrow } from "./exec.js";
import { readState, writeState } from "./state.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";

export async function runRollback(options: {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
}): Promise<void> {
  const { projectDir, releaseName, dryRun } = options;

  const state = await readState(projectDir, releaseName);
  if (!state?.previousBuildId) {
    throw new Error("No previous build to roll back to. Only one deploy has been recorded.");
  }

  const { buildId: currentBuildId, previousBuildId } = state;
  const currentLower = currentBuildId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  const previousLower = previousBuildId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);

  console.log(`\nRolling back: ${currentBuildId} → ${previousBuildId}\n`);

  // Ensure kubectl is on the right cluster
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (existsSync(infraPath)) {
    const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
    if (infra.projectId && infra.region) {
      const credResult = await execCapture("gcloud", [
        "container",
        "clusters",
        "get-credentials",
        `${releaseName}-cluster`,
        "--region",
        infra.region,
        "--project",
        infra.projectId,
        "--quiet",
      ]);
      if (credResult.exitCode !== 0) {
        throw new Error(`Failed to connect to cluster: ${credResult.stderr.trim()}`);
      }
    }
  }

  // Find the previous deployment
  const deploysResult = await execCapture("kubectl", [
    "get",
    "deployments",
    "-l",
    `app.kubernetes.io/name=${releaseName}`,
    "-o",
    'jsonpath={range .items[*]}{.metadata.name}|{.status.replicas}{"\\n"}{end}',
  ]);

  if (deploysResult.exitCode !== 0) {
    throw new Error("Failed to list deployments. Is kubectl connected?");
  }

  let previousDeploy: string | null = null;
  let currentDeploy: string | null = null;

  for (const line of deploysResult.stdout.trim().split("\n")) {
    const [name] = line.split("|");
    if (!name || name.includes("routing-service")) continue;
    // Normalize the deployment name the SAME way as the build-id slice (strip every
    // non-alphanumeric) before matching. The sanitized deployment name turns `_`/`-` in
    // the build id into hyphens (e.g. `7s_BTPT…` → `…-7s-btpt…`), so comparing the raw
    // name against the stripped build-id slice (`7sbtpt…`) never matches — which made
    // rollback wrongly report "previous deployment not found" for those build ids.
    const nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (nameNorm.includes(previousLower)) previousDeploy = name;
    if (nameNorm.includes(currentLower)) currentDeploy = name;
  }

  if (!previousDeploy) {
    throw new Error(
      `Previous deployment not found. The deployment for build ${previousBuildId} may have been deleted.\n` +
        `Only one previous build is retained after deploy.`,
    );
  }

  if (dryRun) {
    console.log(`  [dry-run] Would scale up: ${previousDeploy}`);
    if (currentDeploy) console.log(`  [dry-run] Would scale down: ${currentDeploy}`);
    console.log(
      `  [dry-run] Would swap state: buildId=${previousBuildId}, previousBuildId=${currentBuildId}`,
    );
    return;
  }

  // 1. Scale up the previous deployment
  console.log(`  → Scaling up previous build: ${previousDeploy}`);
  await execOrThrow("kubectl", ["scale", `deployment/${previousDeploy}`, "--replicas=2"]);

  // 2. Wait for previous pods to be ready
  console.log(`  → Waiting for previous build pods to be ready...`);
  await execCapture("kubectl", [
    "rollout",
    "status",
    `deployment/${previousDeploy}`,
    "--timeout=120s",
  ]);

  // 3. Wait for LB health on previous backend
  if (existsSync(infraPath)) {
    const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
    if (infra.projectId) {
      console.log(`  → Waiting for LB health checks...`);
      for (let i = 0; i < 24; i++) {
        const bsResult = await execCapture("gcloud", [
          "compute",
          "backend-services",
          "list",
          "--project",
          infra.projectId,
          "--global",
          "--filter",
          `name~${releaseName} AND name~${previousLower}`,
          "--format=value(name)",
          "--limit=1",
        ]);
        const bsName = bsResult.stdout?.trim();
        // Pool backend services are build-agnostic (the Gateway-managed backend name
        // carries no build id), so a build-id-filtered lookup finds nothing. Don't burn
        // the full 2-minute timeout polling for a backend that will never appear — the
        // rollout-status wait above already gated the previous pods' readiness.
        if (!bsName) break;
        if (bsName) {
          const healthResult = await execCapture("gcloud", [
            "compute",
            "backend-services",
            "get-health",
            bsName,
            "--project",
            infra.projectId,
            "--global",
            "--format=json",
          ]);
          if (healthResult.exitCode === 0) {
            try {
              const data = JSON.parse(healthResult.stdout);
              const healthyCount = data.reduce(
                (n: number, b: any) =>
                  n +
                  (b.status?.healthStatus ?? []).filter((h: any) => h.healthState === "HEALTHY")
                    .length,
                0,
              );
              if (healthyCount > 0) {
                console.log(`    Previous build healthy (${healthyCount} endpoints)`);
                break;
              }
            } catch {}
          }
        }
        if (i < 23) await new Promise((r) => setTimeout(r, 5000));
        else console.log(`    Timed out waiting for health. Proceeding anyway.`);
      }
    }
  }

  // 4. Switch traffic: patch active Service selectors to the previous build.
  // The selector value MUST use the same sanitizer that stamped the pod label
  // (sanitizeK8sName prepends `b-` when the build id starts with a non-letter). A
  // divergent value (the old inline sanitizer omitted the `b-` prefix) matches no pods,
  // draining the active Service to zero endpoints and 503'ing the site on rollback.
  const safePreviousBuild = sanitizeK8sName(previousBuildId);

  // Discover the active Services by NAME (`<release>-<pool>`), exactly as deploy's
  // cutover does. The active-service template's `managed-by: adapter-k8s-active` label
  // is overwritten by Helm to `managed-by: Helm`, so a label selector matches nothing —
  // which would patch ZERO Services, skip the failure guard below, and strand the site
  // when the current build is scaled down. Read the pool list from build metadata.
  let poolNames: string[] = [];
  const metaPath = path.join(projectDir, ".k8s-adapter", "output", "build-metadata.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (Array.isArray(meta.pools)) {
        poolNames = meta.pools.filter((p: unknown): p is string => typeof p === "string");
      }
    } catch {
      // fall through to the empty-pool guard
    }
  }
  if (poolNames.length === 0) {
    // Never scale down the current build without a known set of Services to switch —
    // that would strand traffic. Fail loudly instead.
    throw new Error(
      "Could not determine pool names from .k8s-adapter/output/build-metadata.json; " +
        "cannot locate the active Services to switch traffic. Aborting before any scale-down.",
    );
  }
  const patchFailures: { service: string; stderr: string }[] = [];
  console.log(`  → Switching traffic to previous build...`);
  for (const pool of poolNames) {
    const svcName = sanitizeK8sName(`${releaseName}-${pool}`);
    const patchResult = await execCapture("kubectl", [
      "patch",
      "service",
      svcName,
      "--type=json",
      // --force-conflicts is NOT a valid `kubectl patch` flag (only `apply
      // --server-side` accepts it); a JSON patch needs no conflict override.
      "--field-manager=helm",
      "-p",
      JSON.stringify([
        {
          op: "replace",
          path: "/spec/selector/app.kubernetes.io~1version",
          value: safePreviousBuild,
        },
      ]),
    ]);
    if (patchResult.exitCode !== 0) {
      patchFailures.push({ service: svcName, stderr: patchResult.stderr.trim() });
    }
  }

  // If any selector patch failed, traffic did not switch to the previous build.
  // Scaling the current deployment to 0 now would strand the still-current Services
  // with zero endpoints. Abort before scale-down, leaving the current build serving.
  if (patchFailures.length > 0) {
    console.error(`\n  ROLLBACK FAILED: traffic was NOT switched to the previous build.`);
    console.error(`  ${patchFailures.length} Service selector patch(es) failed:`);
    for (const f of patchFailures) {
      console.error(`    - service ${f.service}: ${f.stderr || "unknown error"}`);
    }
    console.error(`  The current build is still serving traffic and was left scaled up.`);
    console.error(`  State was not changed. Investigate and re-run the rollback.\n`);
    process.exit(1);
  }

  // 5. Scale down current deployment (only after traffic successfully switched)
  if (currentDeploy) {
    console.log(`  → Scaling down current build: ${currentDeploy}`);
    await execCapture("kubectl", ["scale", `deployment/${currentDeploy}`, "--replicas=0"]);
  }

  // 6. Swap state — previous becomes current, current becomes previous.
  // Traffic has already switched at this point; if the cluster ConfigMap write fails
  // we surface it (local was updated) rather than reporting a clean rollback, so
  // cluster/local state don't silently diverge for the next deploy/rollback.
  try {
    await writeState(
      projectDir,
      {
        buildId: previousBuildId,
        previousBuildId: currentBuildId,
      },
      releaseName,
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
    process.exit(1);
  }

  console.log(`\n✓ Rollback complete. Now serving build: ${previousBuildId}`);
  console.log(`  To roll forward again: npx adapter-k8s rollback`);
  console.log(`  To deploy new code:    npx adapter-k8s deploy\n`);
}
