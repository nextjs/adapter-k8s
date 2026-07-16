// src/cli/deploy.ts
import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execOrThrow, execCapture } from "./exec.js";
import { readState, writeState } from "./state.js";
import { invalidateCdnBuildTag } from "./cdn-invalidate.js";
import { renderDeployment } from "../emit/templates/deployment.js";
import { renderService } from "../emit/templates/service.js";
import { renderHPA } from "../emit/templates/hpa.js";
import { renderValkeySecret } from "../emit/templates/valkey-secret.js";
import { provisionMemorystore, buildDeleteMemorystoreCommand } from "./provision-cache.js";
import { isAlreadyGoneError } from "./destroy.js";
import { MIN_GKE_VERSION_FOR_CDN } from "./gke-version.js";
import { routeExtJobName } from "../emit/templates/route-ext-update-job.js";
// Import the SAME sanitizer that stamps pod names and version labels (deployment.ts /
// service.ts). The blue/green cutover patches the active Service selector to this exact
// value, so it MUST match the pod label byte-for-byte — a divergent local copy that
// omitted the `b-` prefix drained the Service to zero endpoints and 503'd the site.
import { sanitizeK8sName } from "../emit/templates/utils.js";
import type { GcloudCommand } from "./init.js";

export interface DeployOptions {
  projectDir: string;
  releaseName: string;
  skipBuild?: boolean;
  skipPush?: boolean;
  dryRun?: boolean;
}

export interface DockerCommandOptions {
  pools: string[];
  buildId: string;
  registry: string;
  outputDir: string;
  containerStrategy: "traced-assets" | "shared-image";
}

export function buildDockerCommands(options: DockerCommandOptions): GcloudCommand[] {
  const { pools, buildId, registry, outputDir, containerStrategy } = options;
  const commands: GcloudCommand[] = [];

  // 0. Configure docker authentication for the registry host
  const registryHost = registry.split("/")[0];
  if (registryHost) {
    commands.push({
      description: `Configure Docker authentication for ${registryHost}`,
      command: "gcloud",
      args: ["auth", "configure-docker", registryHost, "--quiet"],
    });
  }

  if (containerStrategy === "shared-image") {
    const tag = `${registry}/nextjs-app:${buildId}`;
    commands.push({
      description: `Build shared image`,
      command: "docker",
      args: ["build", "-t", tag, `${outputDir}/shared-context`],
    });
    commands.push({
      description: `Push shared image`,
      command: "docker",
      args: ["push", tag],
    });
  } else {
    for (const pool of pools) {
      const tag = `${registry}/nextjs-app-${pool}:${buildId}`;
      commands.push({
        description: `Build ${pool} image`,
        command: "docker",
        args: ["build", "-t", tag, `${outputDir}/pools/${pool}`],
      });
      commands.push({
        description: `Push ${pool} image`,
        command: "docker",
        args: ["push", tag],
      });
    }
  }

  // Always build routing service image
  const routingTag = `${registry}/routing-service:${buildId}`;
  commands.push({
    description: "Build routing service image",
    command: "docker",
    args: [
      "build",
      "-f",
      `${outputDir}/routing-service/Dockerfile`,
      "-t",
      routingTag,
      `${outputDir}/routing-service`,
    ],
  });
  commands.push({
    description: "Push routing service image",
    command: "docker",
    args: ["push", routingTag],
  });

  return commands;
}

export function buildHelmUpgradeArgs(options: {
  releaseName: string;
  chartPath: string;
  buildId: string;
  registry: string;
  previousBuildId: string | null;
  overridesFile?: string;
}): string[] {
  const { releaseName, chartPath, buildId, registry, previousBuildId, overridesFile } = options;
  const args = [
    "upgrade",
    "--install",
    releaseName,
    chartPath,
    "--server-side=true",
    "--force-conflicts",
    // Cache Secrets are Helm-owned in every enabled mode. This adopts Secrets created by older
    // adapter versions that provisioned managed-cache credentials imperatively with kubectl.
    "--take-ownership",
    "--set",
    `global.image.tag=${buildId}`,
    "--set",
    `global.image.registry=${registry}`,
    "--set",
    `build.id=${buildId}`,
    "--set",
    `activeBuildId=${sanitizeK8sName(previousBuildId ?? buildId)}`,
  ];

  if (previousBuildId) {
    args.push("--set", `previousBuildId=${previousBuildId}`);
  }

  if (overridesFile && existsSync(overridesFile)) {
    args.push("-f", overridesFile);
  }

  return args;
}

export async function runDeploy(options: DeployOptions): Promise<void> {
  const { projectDir, releaseName, skipBuild, skipPush, dryRun } = options;

  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (!existsSync(infraPath)) {
    throw new Error(
      "infrastructure.json not found. Run `npx adapter-k8s init` first, " +
        "or create .k8s-adapter/infrastructure.json manually.",
    );
  }
  const infra = JSON.parse(readFileSync(infraPath, "utf-8"));

  // 0. Ensure kubectl is pointing at the right cluster
  if (!dryRun && infra.projectId && infra.region && releaseName) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
    await execOrThrow("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      clusterName,
      "--region",
      infra.region,
      "--project",
      infra.projectId,
      "--quiet",
    ]);
  }

  // 1. Run next build (adapter's onBuildComplete generates artifacts)
  if (!skipBuild) {
    console.log("\n  → Running next build...");
    if (!dryRun) {
      await execOrThrow("npx", ["next", "build"], { cwd: projectDir });
    } else {
      console.log("    [dry-run] npx next build");
    }
  }

  // 2. Read build metadata to get buildId and pool names
  const outputDir = path.join(projectDir, ".k8s-adapter", "output");
  const metadataPath = path.join(outputDir, "build-metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error(`Build metadata not found at ${metadataPath}. Did next build run?`);
  }
  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8"));
  const buildId: string = metadata.buildId;
  const pools: string[] = metadata.pools;

  console.log(`\n  Build ID: ${buildId}`);
  console.log(`  Pools: ${pools.join(", ")}`);

  // Managed cache: provision Memorystore and inject its discovered endpoint into the Helm chart.
  // This keeps the Valkey Secret Helm-owned in both managed and BYO modes, so switching modes
  // updates one resource instead of crossing the kubectl/Helm ownership boundary.
  if (metadata.cacheManaged && !dryRun) {
    // Fail loudly rather than silently shipping without a shared cache: managed provisioning
    // needs the project + region. (BYO cache sets cache.url and never reaches this branch.)
    if (!infra.projectId || !infra.region) {
      throw new Error(
        "cache.enabled with managed Memorystore requires infrastructure.json to have projectId " +
          "and region. Set cache.url for a bring-your-own instance, or re-run `adapter-k8s init`.",
      );
    }
    console.log("\n  → Provisioning managed cache (Memorystore)...");
    const ms = (
      metadata as { cacheMemorystore?: { region?: string; sizeGb?: number; tier?: string } }
    ).cacheMemorystore;
    const cacheRegion = ms?.region ?? infra.region;
    const endpoint = await provisionMemorystore({
      projectId: infra.projectId,
      region: cacheRegion,
      releaseName,
      ...(ms?.sizeGb ? { sizeGb: ms.sizeGb } : {}),
      ...(ms?.tier ? { tier: ms.tier } : {}),
      log: (m: string) => console.log(m),
    });
    // Persist the actual region immediately after provisioning. Any later failure (writing the
    // chart, Helm connectivity, rollout) must still leave destroy enough state to find the paid
    // instance, especially when cache.memorystore.region differs from the cluster region.
    if (infra.cacheRegion !== cacheRegion) {
      infra.cacheRegion = cacheRegion;
      writeFileSync(infraPath, JSON.stringify(infra, null, 2));
    }

    const url = `redis://${endpoint.host}:${endpoint.port}`;
    const secretPath = path.join(outputDir, "chart", "templates", "valkey-secret.yaml");
    writeFileSync(secretPath, renderValkeySecret({ releaseName, url }));
    console.log(`    Cache Secret ${releaseName}-valkey staged for Helm → ${url}`);
  } else if (!metadata.cacheEnabled && !dryRun) {
    // Cache disabled (not just BYO — cacheEnabled distinguishes them). Tear down a previously
    // provisioned managed instance and its Secret, so new pods stop receiving VALKEY_URL (the pod
    // template always mounts the optional Secret) and the paid Memorystore isn't left running.
    // Idempotent: no-ops when nothing was ever provisioned.
    const secretDelete = await execCapture("kubectl", [
      "delete",
      "secret",
      `${releaseName}-valkey`,
      "--ignore-not-found",
    ]);
    if (secretDelete.stdout.trim()) console.log(`\n  → Removed cache Secret ${releaseName}-valkey`);
    if (infra.cacheRegion) {
      console.log("  → Deleting managed cache (Memorystore) — cache is disabled...");
      const del = buildDeleteMemorystoreCommand(releaseName, infra.cacheRegion, infra.projectId);
      const res = await execCapture(del.command, del.args);
      if (res.exitCode === 0 || isAlreadyGoneError(res.stderr)) {
        delete infra.cacheRegion;
        writeFileSync(infraPath, JSON.stringify(infra, null, 2));
        console.log(`    ${del.desc} deleted`);
      } else {
        console.warn(
          `    Warning: could not delete ${del.desc} in ${infra.cacheRegion} — it may still be ` +
            `billed. Delete it manually or run \`adapter-k8s destroy\`.\n    ${res.stderr.trim()}`,
        );
      }
    }
  }

  // 3. Read adapter config to determine container strategy
  // Default to traced-assets if not specified
  const containerStrategy = metadata.containerStrategy ?? "traced-assets";

  // 4. Docker build + push
  if (!skipPush) {
    const dockerCommands = buildDockerCommands({
      pools,
      buildId,
      registry: infra.containerRegistry,
      outputDir: ".k8s-adapter/output",
      containerStrategy,
    });

    for (const cmd of dockerCommands) {
      console.log(`\n  → ${cmd.description}`);
      if (!dryRun) {
        await execOrThrow(cmd.command, cmd.args, { cwd: projectDir });
      } else {
        console.log(`    [dry-run] ${cmd.command} ${cmd.args.join(" ")}`);
      }
    }
  }

  // 5. Pre-flight: ensure static IP exists (Gateway needs it)
  if (!dryRun && infra.projectId) {
    const ipName = `${releaseName}-ip`;
    const ipCheck = await execCapture("gcloud", [
      "compute",
      "addresses",
      "describe",
      ipName,
      "--global",
      "--project",
      infra.projectId,
      "--format=value(address)",
    ]);
    if (ipCheck.exitCode !== 0) {
      console.log(`\n  → Creating static IP "${ipName}"...`);
      await execOrThrow("gcloud", [
        "compute",
        "addresses",
        "create",
        ipName,
        "--global",
        "--project",
        infra.projectId,
        "--quiet",
      ]);
    }
  }

  // 5b. Pre-flight: the chart carries a Cloud CDN filter only when cdn.enabled — the cluster
  // must know the GCPHTTPFilter CRD (GKE >= 1.35.2-gke.1751000) or the apply would fail with
  // an opaque server error. Capability-detect the CRD rather than parsing version strings.
  const chartHasCdn = existsSync(
    path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml"),
  );
  if (!dryRun && chartHasCdn) {
    const crdCheck = await execCapture("kubectl", [
      "get",
      "crd",
      "gcphttpfilters.networking.gke.io",
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (crdCheck.exitCode !== 0) {
      // kubectl itself failed (no context, expired credentials, unreachable API server) —
      // NOT a version problem. `--ignore-not-found` returns exit 0 for a genuinely absent
      // CRD, so a non-zero exit is always a connectivity/auth failure. Don't send the user
      // to upgrade a cluster they can't even reach.
      const detail = crdCheck.stderr.trim();
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but the GCPHTTPFilter CRD check could not ` +
          `reach the cluster (kubectl exited ${crdCheck.exitCode}). Check your kubectl context ` +
          `and credentials.${detail ? `\nkubectl: ${detail}` : ""}`,
      );
    }
    if (!crdCheck.stdout.trim()) {
      // Cluster reachable, CRD genuinely absent → the cluster is too old.
      throw new Error(
        `Cloud CDN is enabled (cdn.enabled: true) but this cluster does not have the ` +
          `GCPHTTPFilter CRD. Cloud CDN for GKE Gateway requires GKE >= ${MIN_GKE_VERSION_FOR_CDN}. ` +
          `Upgrade the cluster, or set provider.gke.cdn.enabled: false in adapter config.`,
      );
    }
  }

  // 6. Helm upgrade
  const state = await readState(projectDir, releaseName);
  const previousBuildId = state?.buildId ?? null;

  const overridesFile = path.join(projectDir, ".k8s-adapter", "helm", "values.override.yaml");
  const helmArgs = buildHelmUpgradeArgs({
    releaseName,
    chartPath: path.join(outputDir, "chart"),
    buildId,
    registry: infra.containerRegistry,
    previousBuildId,
    overridesFile,
  });

  // Inject previous build's deployment+service into the chart so Helm doesn't delete it.
  // Without this, helm upgrade only sees the current build's templates and deletes the previous.
  if (previousBuildId && previousBuildId !== buildId) {
    const chartTemplatesDir = path.join(outputDir, "chart", "templates");
    for (const poolName of pools) {
      const poolPrevName = sanitizeK8sName(`${releaseName}-${poolName}-${previousBuildId}`);

      // The "previous" build is the one CURRENTLY SERVING traffic. Render its Deployment at
      // its current replica count — NOT 0 — so `helm upgrade` doesn't scale it to zero while
      // the active Service still selects it, which would black-hole the origin on every
      // deploy until the new pods are ready and the selector switches. It keeps serving
      // through the rollout; it is scaled to 0 only after state is committed (step 7e).
      let prevReplicas = 2;
      if (!dryRun) {
        const r = await execCapture("kubectl", [
          "get",
          "deployment",
          poolPrevName,
          "-o",
          "jsonpath={.spec.replicas}",
        ]);
        const n = parseInt(r.stdout?.trim() ?? "", 10);
        if (r.exitCode === 0 && Number.isFinite(n) && n > 0) prevReplicas = n;
      }

      // Render retained resources through the same canonical templates as a normal build.
      // Hand-copying this Deployment previously omitted resources, changing the serving pod
      // template and rolling the old build during every upgrade.
      writeFileSync(
        path.join(chartTemplatesDir, `${poolName}-prev-deployment.yaml`),
        renderDeployment({
          poolName,
          buildId: previousBuildId,
          releaseName,
          imageTag: previousBuildId,
          replicas: prevReplicas,
        }),
      );

      writeFileSync(
        path.join(chartTemplatesDir, `${poolName}-prev-service.yaml`),
        renderService({ poolName, buildId: previousBuildId, releaseName }),
      );
      writeFileSync(
        path.join(chartTemplatesDir, `${poolName}-prev-hpa.yaml`),
        renderHPA({ poolName, buildId: previousBuildId, releaseName }),
      );
    }
  }

  console.log("\n  → Running helm upgrade...");
  if (!dryRun) {
    await execOrThrow("helm", helmArgs);
  } else {
    console.log(`    [dry-run] helm ${helmArgs.join(" ")}`);
  }

  // 6b. Best-effort CDN verification: confirm the applied HTTPRoute carries the CDN filter.
  // The chart is the source of truth; this is confirmation only, never fatal.
  if (!dryRun && chartHasCdn) {
    const routeCheck = await execCapture("kubectl", [
      "get",
      "httproute",
      `${releaseName}-routes`,
      "-o",
      "jsonpath={.spec.rules[*].filters[*].extensionRef.kind}",
    ]);
    if (routeCheck.exitCode === 0 && routeCheck.stdout.includes("GCPHTTPFilter")) {
      console.log("  → Cloud CDN filter attached to HTTPRoute rules ✓");
    } else {
      console.warn(
        "  ! Could not confirm the Cloud CDN filter on the HTTPRoute (non-fatal). " +
          `Inspect with: kubectl get httproute ${releaseName}-routes -o yaml`,
      );
    }
  }

  // NOTE: committed deploy state is NOT written here. Persisting { buildId, previousBuildId }
  // before the new build actually serves would record a never-serving build as "current" —
  // a failed deploy (bad image, stuck rollout, failed cutover) would then leave state
  // pointing at a build that never took traffic, and the next deploy/rollback could delete
  // the real rollback target. State is committed only after a successful cutover (step 7d).

  // 7. Zero-downtime cutover: wait for new pods, then clean up old build
  if (!dryRun) {
    // Match the new build's pods/deployments by their EXACT version label — the same value the
    // cutover patches Services to (`sanitizeK8sName(buildId)`, which stamps `app.kubernetes.io/
    // version` on every pod). The prior match used a 12-char normalized-prefix substring, so an OLD
    // build whose id shared that prefix could satisfy this readiness check; the cutover would then
    // patch Services to the full new label, match zero pods, drain the NEG, and 503 the origin.
    const safeBuildId = sanitizeK8sName(buildId);

    // 7a. Wait for new deployment to be ready
    console.log(`\n  → Waiting for new pods to be ready...`);
    const newDeployResult = await execCapture("kubectl", [
      "get",
      "deployments",
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    // The routing service carries the same version label but is a stable in-place Deployment,
    // verified separately below — exclude it here.
    const newDeploys = (newDeployResult.stdout?.trim().split("\n") ?? []).filter(
      (n) => n && !n.includes("routing-service"),
    );

    for (const deployName of newDeploys) {
      console.log(`    Waiting for ${deployName}...`);
      await execCapture("kubectl", [
        "rollout",
        "status",
        `deployment/${deployName}`,
        "--timeout=120s",
      ]);
    }

    // 7a-bis. The routing service (ext_proc edge) is a stable Deployment updated in place
    // per build, and was historically excluded from readiness. That let a broken image
    // (e.g. a missing @next/routing) crashloop undetected for months while Kubernetes kept
    // the old ReplicaSet serving stale edge code and the deploy reported success. Verify it
    // actually rolls out; a stuck rollout is fatal.
    const routingDeploy = sanitizeK8sName(`${releaseName}-routing-service`);
    const rsExists = await execCapture("kubectl", [
      "get",
      "deployment",
      routingDeploy,
      "--ignore-not-found",
      "-o",
      "name",
    ]);
    if (rsExists.exitCode === 0 && rsExists.stdout.trim()) {
      console.log(`    Waiting for ${routingDeploy}...`);
      const rsRollout = await execCapture("kubectl", [
        "rollout",
        "status",
        `deployment/${routingDeploy}`,
        "--timeout=120s",
      ]);
      if (rsRollout.exitCode !== 0) {
        throw new Error(
          `Routing service (${routingDeploy}) did not become healthy — the ext_proc edge would ` +
            `keep serving the previous build.\n${(rsRollout.stderr || rsRollout.stdout).trim()}\n` +
            `Inspect: kubectl logs -l app.kubernetes.io/component=routing-service --tail=40`,
        );
      }
    }

    // The traffic extension is part of the middleware security boundary. Reconcile and verify
    // it while the active Services still select the previous build; never cut traffic and call
    // the deploy successful with a missing/incomplete ext_proc backend.
    const currentRouteExtJob = routeExtJobName(releaseName, buildId);
    const routeExtJobYaml = path.join(outputDir, "chart", "templates", "route-ext-update-job.yaml");
    if (existsSync(routeExtJobYaml)) {
      const wait = await execCapture("kubectl", [
        "wait",
        "--for=condition=complete",
        `job/${currentRouteExtJob}`,
        "--timeout=600s",
      ]);
      if (wait.exitCode !== 0) {
        throw new Error(
          `ext_proc registration job (${currentRouteExtJob}) did not complete; refusing traffic ` +
            `cutover because middleware may not be wired.\n${(wait.stderr || wait.stdout).trim()}\n` +
            `Inspect: kubectl logs job/${currentRouteExtJob}`,
        );
      }
      console.log("  → ext_proc traffic extension registration job completed ✓");
    }

    // 7b. Wait for new pods to be healthy from inside the cluster
    // We check healthz directly on each new pod rather than waiting for GCP LB health
    // (GCP backend health propagation can take 5+ minutes for new backends)
    console.log(`  → Verifying new pods are serving...`);
    let newBuildHealthy = false;
    const maxHealthAttempts = 24; // 2 minutes (5s intervals)
    for (let attempt = 0; attempt < maxHealthAttempts; attempt++) {
      let allHealthy = true;
      let checkedCount = 0;
      const podsResult = await execCapture("kubectl", [
        "get",
        "pods",
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=="Ready")].status}{"\\n"}{end}',
      ]);
      if (podsResult.exitCode === 0) {
        for (const line of podsResult.stdout.trim().split("\n")) {
          const [podName, ready] = line.split("|");
          // Only new-build pods carry this version label; exclude the routing service (shares it).
          if (!podName || podName.includes("routing-service")) continue;
          checkedCount++;
          if (ready !== "True") allHealthy = false;
        }
      }
      if (allHealthy && checkedCount > 0) {
        console.log(`    All ${checkedCount} new pods ready and serving`);
        newBuildHealthy = true;
        break;
      }
      if (attempt < maxHealthAttempts - 1) {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!newBuildHealthy) {
      console.error(`\n  DEPLOY FAILED: New build did not become healthy within 3 minutes.`);
      console.error(`  The previous build is still serving traffic. No cutover performed.\n`);

      // Try to get more diagnostic info
      const newPods = await execCapture("kubectl", [
        "get",
        "pods",
        "-l",
        `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${safeBuildId},app.kubernetes.io/component!=routing-service`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.status.phase}{"\\n"}{end}',
      ]);
      if (newPods.exitCode === 0 && newPods.stdout.trim()) {
        const podLines = newPods.stdout.trim().split("\n");
        for (const line of podLines) {
          const [podName, phase] = line.split("|");
          if (!podName) continue; // selector already scoped to this build's pool pods
          console.error(`  Pod ${podName}: ${phase}`);
          // Try hitting healthz directly
          const healthzResult = await execCapture("kubectl", [
            "exec",
            podName,
            "--",
            "node",
            "-e",
            `const http=require("http");http.get("http://localhost:3000/healthz",r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(r.statusCode,d))}).on("error",e=>console.log("ERR",e.message))`,
          ]);
          if (healthzResult.exitCode === 0) {
            console.error(`  Healthz: ${healthzResult.stdout.trim()}`);
          }
          // Get last error from logs
          const logsResult = await execCapture("kubectl", ["logs", podName, "--tail=20"]);
          if (logsResult.exitCode === 0) {
            const errorLines = logsResult.stdout
              .split("\n")
              .filter(
                (l) =>
                  l.includes("Error") ||
                  l.includes("error") ||
                  l.includes("FATAL") ||
                  l.includes("Cannot find"),
              );
            if (errorLines.length > 0) {
              console.error(`  Errors:`);
              for (const err of errorLines.slice(0, 5)) {
                console.error(`    ${err.trim().slice(0, 150)}`);
              }
            } else {
              console.error(
                `  No errors in pod logs. The issue may be GCP health check configuration.`,
              );
            }
          }
        }
      }

      console.error(`\n  Diagnose:  npx adapter-k8s doctor`);
      console.error(`  Tail logs: npx adapter-k8s tail`);
      process.exit(1);
    }

    // 7c. Cut traffic over: patch each active Service selector to the new build.
    // MUST use the exact same sanitizer that stamped the pod labels (sanitizeK8sName,
    // which prepends `b-` when the build id starts with a non-letter). An inline
    // transform that omits the `b-` prefix writes a selector that matches no pods:
    // the Service drains to zero endpoints, its standalone NEG empties, and the LB
    // returns 503 `failed_to_connect_to_backend` for every origin request (only CDN
    // cache hits survive). This bit us on build ids beginning with a digit.
    // (safeBuildId is computed once in step 7 above and reused here.)
    console.log(`  → Switching traffic to new build...`);
    const patchFailures: { pool: string; service: string; stderr: string }[] = [];
    const patchedServices: string[] = [];
    for (const pool of pools) {
      const activeServiceName = sanitizeK8sName(`${releaseName}-${pool}`);
      const patchResult = await execCapture("kubectl", [
        "patch",
        "service",
        activeServiceName,
        "--type=json",
        // Impersonate helm as the field manager so the next helm upgrade (server-side
        // apply, manager "helm") does not conflict on the selector field we flip here.
        // NOTE: --force-conflicts is NOT a valid `kubectl patch` flag (it only exists on
        // `kubectl apply --server-side`); a JSON patch is not server-side apply and needs
        // no conflict override.
        "--field-manager=helm",
        "-p",
        JSON.stringify([
          {
            op: "replace",
            path: "/spec/selector/app.kubernetes.io~1version",
            value: safeBuildId,
          },
        ]),
      ]);
      if (patchResult.exitCode !== 0) {
        patchFailures.push({
          pool,
          service: activeServiceName,
          stderr: patchResult.stderr.trim(),
        });
      } else {
        patchedServices.push(activeServiceName);
      }
    }

    // If ANY pool's selector patch failed, some/all Services still point at the old
    // build. Deleting old deployments now would strand those Services with zero healthy
    // endpoints. Abort the cutover, leave the previous build in place, and fail loudly
    // rather than proceeding to the cleanup below and printing "Deploy complete".
    if (patchFailures.length > 0) {
      const revertFailures: string[] = [];
      if (previousBuildId) {
        const safePreviousBuildId = sanitizeK8sName(previousBuildId);
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
                value: safePreviousBuildId,
              },
            ]),
          ]);
          if (revertResult.exitCode !== 0) revertFailures.push(serviceName);
        }
      }
      console.error(`\n  DEPLOY FAILED: traffic was NOT switched to the new build.`);
      console.error(
        `  ${patchFailures.length} of ${pools.length} pool Service selector patch(es) failed:`,
      );
      for (const f of patchFailures) {
        console.error(
          `    - pool "${f.pool}" (service ${f.service}): ${f.stderr || "unknown error"}`,
        );
      }
      if (revertFailures.length > 0) {
        console.error(
          `  WARNING: failed to restore selector(s) for: ${revertFailures.join(", ")}.`,
        );
        console.error(`  Traffic may be split across builds; repair those Services manually.`);
      } else if (previousBuildId) {
        console.error(`  Any successful selector patches were reverted to the previous build.`);
      }
      console.error(`  Old deployments were left in place.`);
      console.error(`  No cleanup was performed. Investigate and re-run the deploy.\n`);
      console.error(`  Diagnose:  npx adapter-k8s doctor`);
      // Do NOT write committed state here: traffic did not switch, so the previously-serving
      // build is still current. Recording the new build as current would strand the real
      // rollback target on the next deploy/rollback.
      process.exit(1);
    }

    // 7d. Traffic switched. Invalidate the PREVIOUS build's Cloud CDN entries (best-effort,
    // non-fatal) BEFORE persisting state, so the writeState-failure recovery path — where the
    // new origin is already live — still clears the outgoing build's stale CDN content.
    const cdnFilterPath = path.join(outputDir, "chart", "templates", "cdn-http-filter.yaml");
    if (existsSync(cdnFilterPath) && infra.projectId) {
      try {
        await invalidateCdnBuildTag({
          projectId: infra.projectId,
          releaseName,
          outputDir,
          buildId: previousBuildId ?? undefined,
          run: execCapture,
          log: (m) => console.log(m),
        });
      } catch (err) {
        console.log(
          `  ! CDN invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 7e. Commit deploy state — ONLY now, after a confirmed cutover, so a failed deploy
    // never records a never-serving build as current. Traffic has already switched; if the
    // cluster ConfigMap write fails we surface it loudly (local was updated) rather than
    // silently diverging for the next deploy/rollback.
    try {
      await writeState(projectDir, { buildId, previousBuildId }, releaseName);
    } catch (err) {
      console.error(`\n  Cutover succeeded, but persisting deploy state failed:`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      console.error(
        `  The new build IS serving, but the cluster ConfigMap was not updated. Restore`,
      );
      console.error(
        `  connectivity and re-run so cluster/local state agree before the next deploy.\n`,
      );
      process.exit(1);
    }

    // 7e. State is durable and traffic has switched, so it is now safe to scale the previous
    // build down to 0. It served through the rollout and remains as the rollback target.
    if (previousBuildId && previousBuildId !== buildId) {
      for (const poolName of pools) {
        const poolPrevName = sanitizeK8sName(`${releaseName}-${poolName}-${previousBuildId}`);
        await execOrThrow("kubectl", [
          "delete",
          "hpa",
          `${poolPrevName}-hpa`,
          "--ignore-not-found",
        ]);
        await execOrThrow("kubectl", ["scale", `deployment/${poolPrevName}`, "--replicas=0"]);
      }
      console.log(`  → Previous build scaled to 0 (kept for rollback)`);
    }

    // 7f. Clean up old deployments.
    // The previous build was scaled to 0 in step 7e above (kept as the rollback target).
    // Delete anything that isn't the current or previous build. Classify by EXACT deployment name
    // (reconstructed with the same sanitizer the template uses) rather than a 12-char normalized
    // substring — a shared prefix between two build ids could otherwise delete the wrong build.
    const currentDeployNames = new Set(
      pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${buildId}`)),
    );
    const previousDeployNames = previousBuildId
      ? new Set(pools.map((p) => sanitizeK8sName(`${releaseName}-${p}-${previousBuildId}`)))
      : undefined;

    const allDeploys = await execCapture("kubectl", [
      "get",
      "deployments",
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (allDeploys.exitCode === 0) {
      for (const name of allDeploys.stdout.trim().split("\n")) {
        if (!name || name.includes("routing-service")) continue;
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
        await execCapture("kubectl", ["delete", "deployment", name]);
        await execCapture("kubectl", ["delete", "service", name]).catch(() => {});
        await execCapture("kubectl", ["delete", "healthcheckpolicy", `${name}-hcp`]).catch(
          () => {},
        );
      }
    }

    // Clean up OLD route-ext Jobs (K8s Jobs are immutable; each deploy creates a fresh
    // one). Skip the CURRENT job by EXACT name — a fuzzy build-id substring match here
    // (12-char slice vs the name's 10-char slice) previously deleted the running job
    // before it could register the extension, so the traffic ext never got reconciled.
    const oldJobs = await execCapture("kubectl", [
      "get",
      "jobs",
      "-l",
      `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=route-ext-job`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (oldJobs.exitCode === 0) {
      for (const jobName of oldJobs.stdout.trim().split("\n")) {
        if (!jobName || jobName === currentRouteExtJob) continue;
        await execCapture("kubectl", ["delete", "job", jobName]);
      }
    }
  }

  console.log(`\n✓ Deploy complete (build: ${buildId})`);

  // 8. Run domain health checks
  if (!dryRun) {
    const { runDomainChecks } = await import("./doctor.js");
    await runDomainChecks({ projectDir, releaseName });
  }

  console.log("");
}
