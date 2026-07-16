// src/cli/rollback.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execCapture, execOrThrow } from "./exec.js";
import { readState, writeState } from "./state.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
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
  // Used only by the best-effort LB-health filter below; deployment discovery matches by
  // exact per-pool name, not by this slice.
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

  // Roll back EVERY pool, not just one. Single previous/current vars kept only the LAST
  // pool that matched during discovery, so a multi-pool rollback scaled up one pool's
  // previous Deployment but then switched ALL active Services to the previous build —
  // every other pool was left at zero replicas with no endpoints. Read the pool list from
  // build metadata (the same source deploy's cutover uses), resolve each pool's previous
  // and current Deployment by exact name, and verify every previous pool exists BEFORE
  // touching traffic.
  let poolNames: string[] = [];
  const metaPath = path.join(projectDir, ".k8s-adapter", "output", "build-metadata.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      if (Array.isArray(meta.pools)) {
        poolNames = meta.pools.filter((p: unknown): p is string => typeof p === "string");
      }
    } catch {
      // fall through to the empty guard
    }
  }
  if (poolNames.length === 0) {
    throw new Error(
      "Could not determine pool names from .k8s-adapter/output/build-metadata.json; " +
        "cannot safely roll back. Aborting before touching traffic.",
    );
  }

  const scalingByPool = new Map<string, { min: number; max: number; targetCPU: number }>();
  const valuesPath = path.join(projectDir, ".k8s-adapter", "output", "chart", "values.yaml");
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
  const previousDeploys: string[] = [];
  const currentDeploys: string[] = [];
  const missingPrev: string[] = [];
  for (const pool of poolNames) {
    const prevName = sanitizeK8sName(`${releaseName}-${pool}-${previousBuildId}`);
    const currName = sanitizeK8sName(`${releaseName}-${pool}-${currentBuildId}`);
    if (discovered.has(prevName)) previousDeploys.push(prevName);
    else missingPrev.push(pool);
    if (discovered.has(currName)) currentDeploys.push(currName);
  }

  if (missingPrev.length > 0) {
    throw new Error(
      `Previous deployment missing for pool(s): ${missingPrev.join(", ")} (build ` +
        `${previousBuildId}). Rolling back would strand those pools with zero endpoints. ` +
        `Aborting. Only one previous build is retained after each deploy.`,
    );
  }

  if (dryRun) {
    console.log(`  [dry-run] Would scale up: ${previousDeploys.join(", ")}`);
    if (currentDeploys.length)
      console.log(`  [dry-run] Would scale down: ${currentDeploys.join(", ")}`);
    console.log(
      `  [dry-run] Would swap state: buildId=${previousBuildId}, previousBuildId=${currentBuildId}`,
    );
    return;
  }

  // 1. Scale up every pool's previous deployment
  for (const previousDeploy of previousDeploys) {
    console.log(`  → Scaling up previous build: ${previousDeploy}`);
    await execOrThrow("kubectl", ["scale", `deployment/${previousDeploy}`, "--replicas=2"]);
  }

  // Recreate the rollback build's HPA. Deploy removes it before parking that build at zero,
  // otherwise the autoscaler would immediately raise it back to minReplicas.
  for (let i = 0; i < previousDeploys.length; i++) {
    const previousDeploy = previousDeploys[i]!;
    const pool = poolNames[i]!;
    const hpaName = `${previousDeploy}-hpa`;
    const hpa = await execCapture("kubectl", [
      "get",
      "hpa",
      hpaName,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (!hpa.stdout.trim()) {
      const scaling = scalingByPool.get(pool) ?? { min: 1, max: 3, targetCPU: 80 };
      await execOrThrow("kubectl", [
        "autoscale",
        "deployment",
        previousDeploy,
        `--name=${hpaName}`,
        `--min=${scaling.min}`,
        `--max=${scaling.max}`,
        `--cpu=${scaling.targetCPU}%`,
      ]);
    }
  }

  // 2. Wait for every previous pool's pods to be ready
  console.log(`  → Waiting for previous build pods to be ready...`);
  for (const previousDeploy of previousDeploys) {
    await execOrThrow("kubectl", [
      "rollout",
      "status",
      `deployment/${previousDeploy}`,
      "--timeout=120s",
    ]);
  }

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

  // Switch each active Service (`<release>-<pool>`) by NAME, exactly as deploy's cutover
  // does — reusing the pool list resolved above. (The active-service template's
  // `managed-by: adapter-k8s-active` label is overwritten by Helm to `managed-by: Helm`,
  // so a label selector would match nothing, patch ZERO Services, skip the failure guard,
  // and strand the site when the current build is scaled down.)
  const patchFailures: { service: string; stderr: string }[] = [];
  const patchedServices: string[] = [];
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
    } else {
      patchedServices.push(svcName);
    }
  }

  // If any selector patch failed, traffic did not switch to the previous build.
  // Scaling the current deployment to 0 now would strand the still-current Services
  // with zero endpoints. Abort before scale-down, leaving the current build serving.
  if (patchFailures.length > 0) {
    const safeCurrentBuild = sanitizeK8sName(currentBuildId);
    const revertFailures: string[] = [];
    for (const serviceName of patchedServices) {
      const revertResult = await execCapture("kubectl", [
        "patch",
        "service",
        serviceName,
        "--type=json",
        "--field-manager=helm",
        "-p",
        JSON.stringify([
          {
            op: "replace",
            path: "/spec/selector/app.kubernetes.io~1version",
            value: safeCurrentBuild,
          },
        ]),
      ]);
      if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
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
    console.error(`  Both builds were left scaled up.`);
    console.error(`  State was not changed. Investigate and re-run the rollback.\n`);
    process.exit(1);
  }

  // 4b. Traffic now points at the previous build. Invalidate the CDN entries tagged for the
  // build we rolled AWAY from (currentBuildId) so its stale content stops serving. Best-effort,
  // non-fatal, before the state swap (origin is already switched). Mirrors deploy's cutover.
  const rbOutputDir = path.join(projectDir, ".k8s-adapter", "output");
  if (existsSync(path.join(rbOutputDir, "chart", "templates", "cdn-http-filter.yaml"))) {
    try {
      const rbInfra = JSON.parse(readFileSync(infraPath, "utf-8"));
      if (rbInfra.projectId) {
        await invalidateCdnBuildTag({
          projectId: rbInfra.projectId,
          releaseName,
          outputDir: rbOutputDir,
          buildId: currentBuildId,
          run: execCapture,
          log: (m) => console.log(m),
        });
      }
    } catch (err) {
      console.log(
        `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 5. Swap state while both builds are still healthy. If persistence fails, traffic already
  // points at the previous build but either version remains safe to select during recovery.
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

  // 6. State is durable; scale down every former-current Deployment.
  for (const currentDeploy of currentDeploys) {
    console.log(`  → Scaling down current build: ${currentDeploy}`);
    await execOrThrow("kubectl", ["delete", "hpa", `${currentDeploy}-hpa`, "--ignore-not-found"]);
    await execOrThrow("kubectl", ["scale", `deployment/${currentDeploy}`, "--replicas=0"]);
  }

  console.log(`\n✓ Rollback complete. Now serving build: ${previousBuildId}`);
  console.log(`  To roll forward again: npx adapter-k8s rollback`);
  console.log(`  To deploy new code:    npx adapter-k8s deploy\n`);
}
