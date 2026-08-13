// src/cli/doctor.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve4, resolveCname } from "node:dns/promises";
import path from "node:path";
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import { sanitizeForTerminal } from "./terminal.js";
import { checkContainerRuntime } from "./container-runtime.js";
import { resolveK8sNamespace, sanitizeK8sName } from "../emit/templates/utils.js";
import {
  assertSafeInfrastructure,
  infrastructurePath,
  outputDirName,
} from "./infrastructure-validation.js";
import {
  describeCompositionPlan,
  evaluateCompositionPlanDiagnostics,
  evaluateCompositionPlanReadiness,
  inspectKubernetesRequirements,
  loadDeployedCompositionPlan,
  loadProjectCompositionPlan,
  preflightCompositionPlan,
} from "./composition-plan.js";

// Name the file in parse errors — a bare SyntaxError from JSON.parse gives no clue
// WHICH file is corrupt.
function readJsonFile<T = Record<string, unknown>>(filePath: string): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
}

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

function printCheckResults(results: CheckResult[]): void {
  console.log("");
  let fails = 0;
  let warns = 0;
  let checkCount = 0;
  for (const result of results) {
    if (result.name.startsWith("---")) {
      console.log(`\n  \x1b[1m${result.name.replace(/^-+\s*/, "").replace(/\s*-+$/, "")}\x1b[0m`);
      continue;
    }
    checkCount++;
    const icon =
      result.status === "pass"
        ? "\x1b[32mPASS\x1b[0m"
        : result.status === "warn"
          ? "\x1b[33mWARN\x1b[0m"
          : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${icon}  ${result.name}: ${result.message}`);
    if (result.fix && result.status !== "pass") console.log(`         Fix: ${result.fix}`);
    if (result.status === "fail") fails++;
    if (result.status === "warn") warns++;
  }
  console.log(
    `\n  ${checkCount} checks: ${checkCount - fails - warns} passed, ${warns} warnings, ${fails} failures\n`,
  );
  if (fails > 0) process.exit(1);
}

async function checkTool(name: string, args: string[]): Promise<CheckResult> {
  const result = await execCapture(name, args, { timeoutMs: EXEC_TIMEOUTS.kubectl }).catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null; // command not found
      return { exitCode: 1, stdout: "", stderr: err.message }; // other error
    },
  );
  if (!result) {
    return {
      name: `${name} installed`,
      status: "fail",
      message: `${name} not found in PATH`,
      fix: `Install ${name}`,
    };
  }
  // Command exists but may have failed — still "installed"
  const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  return { name: `${name} installed`, status: "pass", message: version };
}

// Per-host DNS/TLS checks shared by runDoctor and runDomainChecks.
// gatewayIp/certStatus are resolved once by the caller; certStatus === null with a
// projectId set means "certificate not found".
async function checkDomainForHost(opts: {
  host: string;
  releaseName: string;
  projectId: string;
  gatewayIp: string | null;
  certStatus: string | null;
}): Promise<CheckResult[]> {
  const { host, releaseName, projectId, gatewayIp, certStatus } = opts;
  const results: CheckResult[] = [];
  // Wildcard domains: skip the DNS A record check (can't resolve *.example.com)
  // but still check CNAME auth and cert status.
  const isWildcard = host.includes("*");
  const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");

  results.push({ name: `--- ${host}`, status: "pass", message: "---" });

  // A record (skip for wildcards — can't resolve *.example.com directly)
  if (!isWildcard) {
    const resolvedIp = await resolve4(host)
      .then((ips) => ips[0] ?? null)
      .catch(() => null);
    if (!resolvedIp) {
      results.push({
        name: `  A record`,
        status: "fail",
        message: "Does not resolve",
        fix: gatewayIp
          ? `Add DNS: ${host} A ${gatewayIp}`
          : "Add A record after Gateway IP is assigned",
      });
    } else if (gatewayIp && resolvedIp !== gatewayIp) {
      results.push({
        name: `  A record`,
        status: "warn",
        message: `${resolvedIp} (expected ${gatewayIp})`,
        fix: `Update DNS: ${host} A ${gatewayIp}`,
      });
    } else {
      results.push({
        name: `  A record`,
        status: "pass",
        message: `${host} -> ${resolvedIp}`,
      });
    }
  } else {
    results.push({
      name: `  A record`,
      status: "warn",
      message: "Wildcard — configure A record for base domain or subdomains individually",
      ...(gatewayIp
        ? { fix: `Add DNS: ${host} A ${gatewayIp} (or use individual subdomain A records)` }
        : {}),
    });
  }

  // CNAME for DNS authorization (Certificate Manager)
  if (projectId) {
    const authName = `${releaseName}-dns-auth-${safeName}`;
    const authResult = await execCapture(
      "gcloud",
      [
        "certificate-manager",
        "dns-authorizations",
        "describe",
        authName,
        "--project",
        projectId,
        "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (authResult.exitCode === 0 && authResult.stdout.trim()) {
      const parts = authResult.stdout.trim().split(/\s+/);
      const cnameHost = parts[0] ?? "";
      const cnameTarget = parts[2] ?? parts[1] ?? "";

      const cnameResolved = await resolveCname(cnameHost)
        .then((r) => r[0] ?? null)
        .catch(() => null);

      if (cnameResolved) {
        results.push({
          name: `  CNAME (cert auth)`,
          status: "pass",
          message: `${cnameHost} -> ${cnameResolved}`,
        });
      } else {
        results.push({
          name: `  CNAME (cert auth)`,
          status: "fail",
          message: "Not configured",
          fix: `Add DNS: ${cnameHost} CNAME ${cnameTarget}`,
        });
      }
    } else {
      results.push({
        name: `  CNAME (cert auth)`,
        status: "warn",
        message: "DNS authorization not found",
        fix: `Run \`npx adapter-k8s init\` to create DNS authorizations`,
      });
    }

    // Certificate status
    if (certStatus) {
      if (certStatus === "ACTIVE") {
        results.push({ name: `  TLS certificate`, status: "pass", message: "Active" });
      } else {
        results.push({
          name: `  TLS certificate`,
          status: certStatus === "PROVISIONING" ? "warn" : "fail",
          message: certStatus,
          fix:
            certStatus === "PROVISIONING"
              ? "Requires CNAME + A records. Provisioning can take up to 60 min."
              : `gcloud certificate-manager certificates describe ${releaseName}-cert --project ${projectId}`,
        });
      }
    } else {
      results.push({
        name: `  TLS certificate`,
        status: "warn",
        message: "Not found",
        fix: `Run \`npx adapter-k8s init\` to create certificates`,
      });
    }
  }

  return results;
}

export async function runDoctor(options: {
  projectDir: string;
  releaseName: string;
}): Promise<void> {
  const { projectDir, releaseName } = options;
  const results: CheckResult[] = [];
  let namespace = resolveK8sNamespace();
  const localComposition = loadProjectCompositionPlan(projectDir);

  // Ensure kubectl is pointing at the right cluster
  const infraPathForCtx = infrastructurePath(projectDir);
  if (localComposition) {
    namespace = localComposition.plan.metadata.namespace;
    try {
      const preflight = await preflightCompositionPlan(localComposition.plan, {
        // doctor is read-only; an unverified identity is reported as the current context rather
        // than turning the diagnostic command into an interactive workflow.
        explicitlyConfirmed: true,
      });
      results.push({
        name: "Composition target",
        status: "pass",
        message: `${preflight.clusterIdentity}; Kubernetes ${preflight.serverVersion}`,
      });
    } catch (error) {
      results.push({
        name: "Composition target",
        status: "fail",
        message: sanitizeForTerminal(error instanceof Error ? error.message : String(error)),
        fix: "Restore target cluster access or rebuild for the intended cluster",
      });
    }
  } else if (existsSync(infraPathForCtx)) {
    const infraCtx = readJsonFile<{ projectId?: string; region?: string; namespace?: string }>(
      infraPathForCtx,
    );
    // S13: validate before these reach a gcloud/kubectl argv.
    assertSafeInfrastructure(infraCtx);
    namespace = resolveK8sNamespace(infraCtx.namespace);
    if (infraCtx.projectId && infraCtx.region) {
      const clusterName = `${releaseName}-cluster`;
      const credResult = await execCapture(
        "gcloud",
        [
          "container",
          "clusters",
          "get-credentials",
          clusterName,
          "--region",
          infraCtx.region,
          "--project",
          infraCtx.projectId,
          "--quiet",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (credResult.exitCode !== 0) {
        // L14: gcloud stderr is externally influenced; strip control sequences before printing.
        console.error(
          `Failed to connect to cluster "${clusterName}": ${sanitizeForTerminal(credResult.stderr.trim())}`,
        );
        console.error(
          `Verify: gcloud container clusters get-credentials ${clusterName} --region ${infraCtx.region} --project ${infraCtx.projectId}`,
        );
        process.exit(1);
      }
    }
  }

  console.log("\nRunning health checks...\n");

  // --- Prerequisites ---
  if (!localComposition) results.push(await checkTool("gcloud", ["--version"]));
  results.push(await checkTool("kubectl", ["version", "--client", "-o", "yaml"]));
  results.push(await checkTool("helm", ["version", "--short"]));
  // S24: any of docker/podman/nerdctl works, so check for a usable runtime rather than
  // failing a podman-only host over a missing `docker` binary.
  results.push(await checkContainerRuntime());

  // --- Local config ---
  const infraPath = infrastructurePath(projectDir);
  if (existsSync(infraPath)) {
    results.push({ name: "infrastructure.json", status: "pass", message: infraPath });
  } else {
    results.push({
      name: "infrastructure.json",
      status: "fail",
      message: "Not found",
      fix: "Run `npx adapter-k8s init`",
    });
  }

  const configExists =
    existsSync(path.join(projectDir, "adapter.config.mjs")) ||
    existsSync(path.join(projectDir, "adapter.config.ts")) ||
    existsSync(path.join(projectDir, "adapter.config.js"));
  results.push(
    configExists
      ? { name: "adapter.config", status: "pass", message: "Found" }
      : {
          name: "adapter.config",
          status: "warn",
          message: "Not found (will use defaults)",
          fix: "Run `npx adapter-k8s init` to scaffold",
        },
  );

  // Read state from cluster ConfigMap (works for CI/CD + local), fall back to local file
  const { readState, StateUnavailableError } = await import("./state.js");
  // N20: readState now THROWS when state cannot be determined (rather than silently
  // reporting "no deploys", which made a transient read failure look like a first deploy).
  // doctor is the tool those errors tell operators to run, so it must REPORT that as a
  // failed check rather than crashing.
  let state: Awaited<ReturnType<typeof readState>> = null;
  let stateError: string | null = null;
  try {
    state = await readState(projectDir, releaseName, { namespace });
  } catch (err) {
    if (!(err instanceof StateUnavailableError)) throw err;
    stateError = err.message;
  }
  if (stateError) {
    results.push({
      name: "Deploy state",
      status: "fail",
      message: stateError.split("\n")[0]!,
      fix: "deploy refuses to run until this is repaired (it would otherwise look like a first deploy)",
    });
  }
  if (state) {
    // L14: both build ids come from the cluster-backed deploy state, whose validation
    // requires only a nonempty string, and the central result printer emits messages
    // verbatim — so a namespace actor able to edit the ConfigMap could forge health output.
    results.push({
      name: "Current build",
      status: "pass",
      message: sanitizeForTerminal(state.buildId),
    });
    if (state.previousBuildId) {
      results.push({
        name: "Previous build",
        status: "pass",
        message: `${sanitizeForTerminal(state.previousBuildId)} (rollback target)`,
      });
    }
  } else {
    results.push({ name: "Deploy state", status: "warn", message: "No deploys yet" });
  }

  // --- GCP resources (only if infrastructure.json exists) ---
  let projectId = "";
  if (!localComposition && existsSync(infraPath)) {
    const infra = readJsonFile<{
      projectId?: string;
      region?: string;
      gcsBucket?: string;
      containerRegistry?: string;
    }>(infraPath);
    projectId = infra.projectId ?? "";

    // gcloud auth
    const authResult = await execCapture("gcloud", ["auth", "print-access-token", "--quiet"], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    results.push(
      authResult.exitCode === 0
        ? { name: "gcloud auth", status: "pass", message: "Authenticated" }
        : {
            name: "gcloud auth",
            status: "fail",
            message: "Not authenticated",
            fix: "Run `gcloud auth login`",
          },
    );

    // Static IP
    const ipName = `${releaseName}-ip`;
    const ipResult = await execCapture(
      "gcloud",
      [
        "compute",
        "addresses",
        "describe",
        ipName,
        "--global",
        "--project",
        projectId,
        "--format=value(address)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (ipResult.exitCode === 0) {
      results.push({
        name: "Static IP",
        status: "pass",
        message: `${ipName} = ${ipResult.stdout.trim()}`,
      });
    } else {
      results.push({
        name: "Static IP",
        status: "fail",
        message: `${ipName} not found`,
        fix: `gcloud compute addresses create ${ipName} --global --project ${projectId}`,
      });
    }

    // GCS bucket
    if (infra.gcsBucket) {
      const bucketResult = await execCapture(
        "gcloud",
        [
          "storage",
          "buckets",
          "describe",
          `gs://${infra.gcsBucket}`,
          "--project",
          projectId,
          "--format=value(name)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      results.push(
        bucketResult.exitCode === 0
          ? { name: "GCS bucket", status: "pass", message: infra.gcsBucket }
          : {
              name: "GCS bucket",
              status: "fail",
              message: `${infra.gcsBucket} not found`,
              fix: `gcloud storage buckets create gs://${infra.gcsBucket} --project ${projectId} --location ${infra.region}`,
            },
      );
    }

    // Artifact Registry
    if (infra.containerRegistry) {
      const repoName = infra.containerRegistry.split("/").pop() ?? "nextjs";
      const arResult = await execCapture(
        "gcloud",
        [
          "artifacts",
          "repositories",
          "describe",
          repoName,
          "--location",
          // init always writes region; ?? "" keeps a malformed file from putting
          // `undefined` on gcloud's argv (spawn throws) — the describe just fails.
          infra.region ?? "",
          "--project",
          projectId,
          "--format=value(name)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      results.push(
        arResult.exitCode === 0
          ? { name: "Artifact Registry", status: "pass", message: infra.containerRegistry }
          : {
              name: "Artifact Registry",
              status: "fail",
              message: `Repository not found`,
              fix: `gcloud artifacts repositories create ${repoName} --repository-format docker --location ${infra.region} --project ${projectId}`,
            },
      );
    }
  }

  // --- Kubernetes resources ---
  const kubectlOk = await execCapture("kubectl", ["cluster-info"], {
    timeoutMs: EXEC_TIMEOUTS.kubectl,
  }).catch(() => null);
  if (kubectlOk && kubectlOk.exitCode === 0) {
    results.push({ name: "K8s cluster", status: "pass", message: "Connected" });

    if (state?.buildId) {
      try {
        const snapshot = await loadDeployedCompositionPlan({
          releaseName,
          namespace,
          buildId: state.buildId,
          ...(state.compositionPlans?.[state.buildId]
            ? { expected: state.compositionPlans[state.buildId] }
            : {}),
        });
        if (snapshot) {
          const description = describeCompositionPlan(snapshot.plan);
          results.push({
            name: "Composition plan",
            status: "pass",
            message:
              `${snapshot.digest} (${description.resources.length} contributed resources, ` +
              `${description.cleanup.kubernetes.length + description.cleanup.external.length} cleanup operations)`,
          });
          try {
            const compatibility = await inspectKubernetesRequirements(snapshot.plan);
            results.push({
              name: "Composition plan APIs",
              status: compatibility.missingOptional.length > 0 ? "warn" : "pass",
              message:
                compatibility.missingOptional.length > 0
                  ? `Kubernetes ${compatibility.serverVersion}; optional APIs missing: ` +
                    compatibility.missingOptional
                      .map((entry) => `${entry.apiVersion}/${entry.resource}`)
                      .join(", ")
                  : `Kubernetes ${compatibility.serverVersion}; all required APIs discovered`,
            });
          } catch (error) {
            results.push({
              name: "Composition plan APIs",
              status: "fail",
              message: sanitizeForTerminal(error instanceof Error ? error.message : String(error)),
              fix: "Install the missing API/controller or rebuild for this cluster",
            });
          }
          results.push(...(await evaluateCompositionPlanReadiness(snapshot.plan)));
          results.push(...(await evaluateCompositionPlanDiagnostics(snapshot.plan)));
        }
      } catch (error) {
        results.push({
          name: "Composition plan",
          status: "fail",
          message: sanitizeForTerminal(error instanceof Error ? error.message : String(error)),
          fix: "Rebuild and redeploy to replace the invalid retained plan snapshot",
        });
      }
    }
    if (localComposition) {
      printCheckResults(results);
      return;
    }

    // Gateway
    const gwResult = await execCapture(
      "kubectl",
      [
        "get",
        "gateway",
        `${releaseName}-gateway`,
        "-n",
        namespace,
        "-o",
        "jsonpath={.status.conditions[?(@.type=='Accepted')].status}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (gwResult.exitCode === 0) {
      const accepted = gwResult.stdout.trim();
      if (accepted === "True") {
        results.push({ name: "Gateway", status: "pass", message: "Accepted" });
      } else {
        const reasonResult = await execCapture(
          "kubectl",
          [
            "get",
            "gateway",
            `${releaseName}-gateway`,
            "-n",
            namespace,
            "-o",
            "jsonpath={.status.conditions[?(@.type=='Accepted')].message}",
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        results.push({
          name: "Gateway",
          status: "fail",
          // L14: condition messages are cluster-sourced — strip terminal control chars.
          message:
            sanitizeForTerminal(reasonResult.stdout.trim()) || `Status: ${accepted || "Unknown"}`,
          fix: `kubectl describe gateway ${releaseName}-gateway -n ${namespace}`,
        });
      }
    } else {
      results.push({
        name: "Gateway",
        status: "warn",
        message: "Not found (created on first deploy)",
      });
    }

    // Gateway IP — check both Gateway status and the static IP from gcloud
    let gatewayIp: string | null = null;
    const gwIpResult = await execCapture(
      "kubectl",
      [
        "get",
        "gateway",
        `${releaseName}-gateway`,
        "-n",
        namespace,
        "-o",
        "jsonpath={.status.addresses[0].value}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (gwIpResult.exitCode === 0 && gwIpResult.stdout.trim()) {
      gatewayIp = gwIpResult.stdout.trim();
    }
    // Fallback: if Gateway status doesn't have it, use the reserved static IP
    if (!gatewayIp && projectId) {
      const staticIpResult = await execCapture(
        "gcloud",
        [
          "compute",
          "addresses",
          "describe",
          `${releaseName}-ip`,
          "--global",
          "--project",
          projectId,
          "--format=value(address)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (staticIpResult.exitCode === 0 && staticIpResult.stdout.trim()) {
        gatewayIp = staticIpResult.stdout.trim();
      }
    }
    if (gatewayIp) {
      results.push({ name: "Gateway IP", status: "pass", message: gatewayIp });
    } else if (gwResult.exitCode === 0) {
      results.push({
        name: "Gateway IP",
        status: "warn",
        message: "Not yet assigned (LB provisioning takes 5-10 min)",
      });
    }

    // HTTPRoute
    const routeResult = await execCapture(
      "kubectl",
      [
        "get",
        "httproute",
        `${releaseName}-routes`,
        "-n",
        namespace,
        "-o",
        "jsonpath={.status.parents[0].conditions[?(@.type=='Accepted')].status}",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (routeResult.exitCode === 0) {
      const accepted = routeResult.stdout.trim();
      results.push(
        accepted === "True"
          ? { name: "HTTPRoute", status: "pass", message: "Accepted" }
          : {
              name: "HTTPRoute",
              status: "fail",
              message: `Status: ${accepted || "Unknown"}`,
              fix: `kubectl describe httproute ${releaseName}-routes -n ${namespace}`,
            },
      );
    } else {
      results.push({ name: "HTTPRoute", status: "warn", message: "Not found" });
    }

    // Per-deployment health with rollout awareness
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
        'jsonpath={range .items[*]}{.metadata.name}|{.status.readyReplicas}/{.status.replicas}|{.metadata.labels.app\\.kubernetes\\.io/version}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    // Classify by the EXACT `app.kubernetes.io/version` label — the same
    // sanitizeK8sName value the chart stamps and the cutover patches Services to. The
    // old 12-char normalized-prefix substring match misclassified two builds sharing
    // that prefix; deploy's comments record that technique draining a Service to zero
    // endpoints and 503'ing production. Deployments with no version label can't be
    // classified — say "unknown" rather than guessing.
    const currentBuildLabel = state?.buildId ? sanitizeK8sName(state.buildId) : null;
    const previousBuildLabel = state?.previousBuildId
      ? sanitizeK8sName(state.previousBuildId)
      : null;

    let foundCurrentPool = false;

    if (deploysResult.exitCode === 0 && deploysResult.stdout.trim()) {
      for (const line of deploysResult.stdout.trim().split("\n")) {
        const [name, statusStr, versionLabel] = line.split("|");
        if (!name) continue;
        const shortName = name.replace(`${releaseName}-`, "");
        const isRouting = shortName === "routing-service";

        let role: "current" | "previous" | "old" | "unknown" = versionLabel ? "old" : "unknown";
        if (isRouting) role = "current";
        else if (currentBuildLabel && versionLabel === currentBuildLabel) role = "current";
        else if (previousBuildLabel && versionLabel === previousBuildLabel) role = "previous";

        if (role === "current" && !isRouting) foundCurrentPool = true;

        const roleTag =
          role === "current"
            ? ""
            : role === "previous"
              ? " [previous]"
              : role === "old"
                ? " [old]"
                : " [unknown]";
        const [readyStr, totalStr] = (statusStr ?? "0/0").split("/");
        const ready = parseInt(readyStr || "0", 10);
        const total = parseInt(totalStr || "0", 10);
        const label = isRouting ? "Routing service" : `Pool: ${shortName}`;

        if (role === "previous" && total === 0) {
          results.push({
            name: `${label}${roleTag}`,
            status: "pass",
            message: `0/0 scaled down (rollback ready)`,
          });
        } else if (role === "old" && total === 0) {
          results.push({
            name: `${label}${roleTag}`,
            status: "pass",
            message: `0/0 (pending cleanup)`,
          });
        } else if (ready === total && total > 0) {
          results.push({
            name: `${label}${roleTag}`,
            status: "pass",
            message: `${ready}/${total} ready`,
          });
        } else if (ready === 0 && total > 0) {
          results.push({
            name: `${label}${roleTag}`,
            status: "fail",
            message: `${ready}/${total} ready`,
            fix: `kubectl describe deployment/${name} -n ${namespace}`,
          });
        } else if (ready < total) {
          results.push({
            name: `${label}${roleTag}`,
            status: "warn",
            message: `${ready}/${total} ready`,
          });
        } else {
          results.push({
            name: `${label}${roleTag}`,
            status: "fail",
            message: `${ready}/${total} ready`,
            fix: `kubectl describe deployment/${name} -n ${namespace}`,
          });
        }
      }
    } else {
      results.push({ name: "Deployments", status: "warn", message: "No deployments found" });
    }

    // Check if current build has a pool Deployment
    if (state?.buildId && !foundCurrentPool) {
      results.push({
        name: "Current build",
        status: "fail",
        message: `No pool Deployment found for build ${state.buildId}`,
        fix: `Run \`npx adapter-k8s deploy\` to redeploy`,
      });
    }

    // Active Service endpoints: pods being "ready" is NOT enough — the blue/green
    // cutover flips each active Service's `app.kubernetes.io/version` selector to the
    // new build, and if that selector value doesn't EXACTLY match the pod label the
    // Service selects zero pods. The Deployment still reports N/N ready, but the
    // Service drains to zero endpoints, its standalone NEG empties, and the LB returns
    // 503 `failed_to_connect_to_backend` for every origin request (only CDN cache hits
    // survive). Verify each active pool Service actually has ready endpoints so this
    // class of outage can never pass as "all green" again.
    //
    // Discover the active Services from the CLUSTER — local build-metadata.json
    // reflects the last LOCAL build, which may not be the deployed release at all.
    // Discovery is by NAME, not by the `managed-by: adapter-k8s-active` label the
    // template stamps: rollback.ts records (from live debugging) that Helm rewrites
    // that label to `managed-by: Helm`, so a label selector matches nothing (which is
    // why rollback patches Services by name). The active Service for a pool is the
    // stable `sanitizeK8sName(<release>-<pool>)` — the exact name deploy/rollback
    // patch — so reconstruct it from each Service's pool (`app.kubernetes.io/
    // component`) label and keep only exact name matches; per-build Services
    // (`<release>-<pool>-<build>`) and the routing tier drop out. Fall back to local
    // metadata only when cluster discovery finds nothing, and say so in the output.
    let svcNames: string[] = [];
    let svcSource: "cluster" | "local" | null = null;
    const svcResult = await execCapture(
      "kubectl",
      [
        "get",
        "svc",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}|{.metadata.labels.app\\.kubernetes\\.io/component}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (svcResult.exitCode === 0 && svcResult.stdout.trim()) {
      svcNames = svcResult.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [name, component] = line.split("|");
          if (!name || !component || component === "routing-service") return null;
          return name === sanitizeK8sName(`${releaseName}-${component}`) ? name : null;
        })
        .filter((n): n is string => n !== null);
      if (svcNames.length > 0) svcSource = "cluster";
    }
    if (svcSource !== "cluster") {
      const metaPath = path.join(
        projectDir,
        ".k8s-adapter",
        outputDirName(),
        "build-metadata.json",
      );
      if (existsSync(metaPath)) {
        try {
          const meta = readJsonFile<{ pools?: unknown }>(metaPath);
          if (Array.isArray(meta.pools)) {
            svcNames = meta.pools
              .filter((p): p is string => typeof p === "string")
              .map((p) => `${releaseName}-${p}`);
            svcSource = "local";
          }
        } catch {
          // Malformed metadata — skip the endpoint check rather than crash.
        }
      }
    }
    if (svcSource === "local") {
      results.push({
        name: "Active Service endpoints",
        status: "warn",
        message:
          "no active pool Services found in the cluster — pool list taken from " +
          "LOCAL build-metadata.json, which may not match the deployed release",
      });
    }
    for (const svc of svcNames) {
      const epResult = await execCapture(
        "kubectl",
        [
          "get",
          "endpointslice",
          "-n",
          namespace,
          "-l",
          `kubernetes.io/service-name=${svc}`,
          "-o",
          'jsonpath={range .items[*]}{range .endpoints[*]}{.conditions.ready}{"\\n"}{end}{end}',
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      const readyEndpoints =
        epResult.exitCode === 0
          ? epResult.stdout
              .trim()
              .split("\n")
              .filter((v) => v.trim() === "true").length
          : -1;
      if (readyEndpoints > 0) {
        results.push({
          name: `Active Service endpoints: ${svc}`,
          status: "pass",
          message: `${readyEndpoints} ready`,
        });
      } else if (readyEndpoints === 0) {
        results.push({
          name: `Active Service endpoints: ${svc}`,
          status: "fail",
          message: "0 ready endpoints — selector matches no ready pods (origin will 503)",
          fix: `kubectl get svc ${svc} -n ${namespace} -o jsonpath='{.spec.selector}' — verify app.kubernetes.io/version matches a running pod's label`,
        });
      }
      // readyEndpoints === -1 (kubectl error) is left unreported — cluster-connectivity
      // problems are already surfaced by the "K8s cluster" check above.
    }

    // Check if previous build exists (needed for rollback)
    if (state?.previousBuildId) {
      const foundPrevious =
        deploysResult.exitCode === 0 &&
        deploysResult.stdout
          .trim()
          .split("\n")
          .some((line) => {
            const [name, , versionLabel] = line.split("|");
            return (
              name &&
              !name.includes("routing-service") &&
              previousBuildLabel !== null &&
              versionLabel === previousBuildLabel
            );
          });
      if (foundPrevious) {
        results.push({
          name: "Rollback ready",
          // N30: a deploy run with --allow-unretained-manifest records the outgoing build
          // here; a rollback to it can only revert the routing IMAGE, not the manifest.
          status: state.unretainedManifestBuilds?.includes(state.previousBuildId) ? "warn" : "pass",
          message: state.unretainedManifestBuilds?.includes(state.previousBuildId)
            ? `Previous build ${state.previousBuildId} available, but its routing manifest was NOT retained — rollback would be image-only (the edge keeps the current build's manifest)`
            : `Previous build ${state.previousBuildId} available`,
        });
      } else {
        results.push({
          name: "Rollback ready",
          status: "fail",
          message: `Previous build ${state.previousBuildId} not found — rollback unavailable`,
          fix: "Deploy twice to have a rollback target",
        });
      }
    }

    // Pod errors — check recent logs across ALL pods (bounded: checking only the first
    // pod used to miss a crash-looping sibling entirely). Transient app-level "error"
    // lines (a failed request, a retried fetch) are a WARNING — hard FAIL is reserved
    // for fatal signatures that mean the workload can't serve at all.
    const podsResult = await execCapture(
      "kubectl",
      [
        "get",
        "pods",
        "-n",
        namespace,
        "-l",
        `app.kubernetes.io/name=${releaseName}`,
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (podsResult.exitCode === 0 && podsResult.stdout.trim()) {
      const isFatal = (l: string) => l.includes("FATAL") || l.includes("Cannot find module");
      const isError = (l: string) => l.includes("Error") || l.includes("error");
      const podsToCheck = podsResult.stdout.trim().split("\n").filter(Boolean).slice(0, 5);
      let fatalHit: { pod: string; line: string } | null = null;
      const errorPods: string[] = [];
      for (const pod of podsToCheck) {
        const logsResult = await execCapture(
          "kubectl",
          ["logs", pod, "-n", namespace, "--tail=50"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (logsResult.exitCode !== 0) continue;
        const lines = logsResult.stdout.split("\n");
        const fatalLine = lines.find(isFatal);
        if (fatalLine && !fatalHit) fatalHit = { pod, line: fatalLine };
        else if (!fatalLine && lines.some(isError)) errorPods.push(pod);
      }
      if (fatalHit) {
        // L14: pod log lines are cluster-sourced — strip terminal control chars.
        const firstFatal = sanitizeForTerminal(fatalHit.line.trim()).slice(0, 120);
        results.push({
          name: "Pod logs",
          status: "fail",
          message: `Fatal error in ${fatalHit.pod}: ${firstFatal}`,
          fix: `kubectl logs ${fatalHit.pod} -n ${namespace} --tail=50`,
        });
      } else if (errorPods.length > 0) {
        results.push({
          name: "Pod logs",
          status: "warn",
          message: `error-level lines in ${errorPods.length}/${podsToCheck.length} pod(s) — likely transient app errors`,
          fix: `kubectl logs ${errorPods[0]} -n ${namespace} --tail=50`,
        });
      } else if (podsToCheck.length > 0) {
        results.push({
          name: "Pod logs",
          status: "pass",
          message: `No errors in recent logs (${podsToCheck.length} pod(s) checked)`,
        });
      }
    }

    // GCP backend health checks — query actual LB health status
    if (projectId) {
      // List backend services associated with this release
      const bsResult = await execCapture(
        "gcloud",
        [
          "compute",
          "backend-services",
          "list",
          "--project",
          projectId,
          "--global",
          "--filter",
          `name~${releaseName}`,
          "--format=value(name)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (bsResult.exitCode === 0 && bsResult.stdout.trim()) {
        for (const bsName of bsResult.stdout.trim().split("\n")) {
          if (!bsName) continue;
          // `name~${releaseName}` is a substring REGEX — a short release name also
          // matches other releases' backends ("app" matches "myapp2"), and a
          // neighbour's unhealthy backend then false-FAILs this check. Require the
          // release name as a hyphen-bounded token (GKE-generated names embed the
          // Service name as `-defau<lt>-<svc>-`; ours all start with `${releaseName}-`).
          if (!bsName.startsWith(`${releaseName}-`) && !bsName.includes(`-${releaseName}-`))
            continue;
          const healthResult = await execCapture(
            "gcloud",
            [
              "compute",
              "backend-services",
              "get-health",
              bsName,
              "--project",
              projectId,
              "--global",
              "--format=json",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (healthResult.exitCode === 0) {
            try {
              const data = JSON.parse(healthResult.stdout);
              let healthy = 0;
              let total = 0;
              for (const backend of data) {
                for (const hs of backend.status?.healthStatus ?? []) {
                  total++;
                  if (hs.healthState === "HEALTHY") healthy++;
                }
              }
              const shortName = bsName
                .replace(/^gkegw1-[a-z0-9]+-defau-/, "")
                .replace(/^k8s1-[a-z0-9]+-defaul-/, "");
              // Attribute the backend to a build by EXACT hyphen-bounded token on the
              // sanitized build id (a 12-char normalized-prefix substring previously
              // misclassified builds sharing a prefix — the technique deploy's comments
              // record causing a production 503). IMPORTANT caveat: Gateway-managed
              // POOL backends are named after the stable active Service and NEVER
              // embed a build id, so for them neither token can match. Fail closed:
              // only a backend positively attributed to the PREVIOUS build gets the
              // lenient "pending cleanup" treatment; everything else — including
              // build-agnostic names — is treated as current, so an unhealthy backend
              // is never waved through as an "old build" it may not be.
              const embedsCurrent = currentBuildLabel
                ? bsName.includes(`-${currentBuildLabel}-`)
                : false;
              const embedsPrevious = previousBuildLabel
                ? bsName.includes(`-${previousBuildLabel}-`)
                : false;
              const isCurrentBuild = embedsCurrent || !embedsPrevious;

              if (total === 0) {
                results.push({
                  name: `LB health: ${shortName}`,
                  status: isCurrentBuild ? "warn" : "pass",
                  message: isCurrentBuild
                    ? "No backends registered yet"
                    : "Previous build (pending cleanup)",
                });
              } else if (healthy === total) {
                results.push({
                  name: `LB health: ${shortName}`,
                  status: "pass",
                  message: `${healthy}/${total} healthy`,
                });
              } else if (!isCurrentBuild) {
                // Previous-build backends being unhealthy is expected — don't fail
                results.push({
                  name: `LB health: ${shortName}`,
                  status: "warn",
                  message: `${healthy}/${total} healthy (previous build, pending cleanup)`,
                });
              } else {
                results.push({
                  name: `LB health: ${shortName}`,
                  status: "fail",
                  message: `${healthy}/${total} healthy`,
                  fix: `gcloud compute backend-services get-health ${bsName} --project ${projectId} --global`,
                });
              }
            } catch {
              // JSON parse failed — skip
            }
          }
        }
      }

      // Also check NEG status from K8s side. Find the condition BY TYPE ("Initialized"
      // is what the GKE NEG controller reports) — conditions[0] is whichever condition
      // happens to sort first, so the old positional read could report a healthy NEG
      // as not-ready (or vice versa).
      const negResult = await execCapture(
        "kubectl",
        [
          "get",
          "svcneg",
          "-n",
          namespace,
          "-o",
          "jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=='Initialized')].status}{\"\\n\"}{end}",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (negResult.exitCode === 0 && negResult.stdout.trim()) {
        for (const line of negResult.stdout.trim().split("\n")) {
          const [negName, negStatus] = line.split("|");
          // svcneg is named after its Service; ours start with `${releaseName}-`
          // (substring matching would pull in other releases' NEGs).
          if (!negName || !negName.startsWith(`${releaseName}-`)) continue;
          // L14: NEG names are cluster-sourced — strip terminal control chars.
          const cleanName = sanitizeForTerminal(negName);
          results.push(
            negStatus === "True"
              ? {
                  name: "Backend NEG",
                  status: "pass",
                  message: cleanName,
                }
              : {
                  name: "Backend NEG",
                  status: "warn",
                  message: `${cleanName} (Initialized=${negStatus || "not reported"})`,
                  fix: "NEG not yet ready — backend health check may be pending",
                },
          );
        }
      }
    }

    // --- ext_proc traffic-extension wiring (the surface that silently breaks middleware) ---
    if (projectId) {
      // Traffic extension registered AND covering EVERY forwarding rule. A missing HTTP
      // rule lets http:// bypass middleware (auth/rewrites); a missing extension means the
      // edge middleware never runs at all.
      const teFrs = await execCapture(
        "gcloud",
        [
          "service-extensions",
          "lb-traffic-extensions",
          "describe",
          `${releaseName}-traffic-ext`,
          "--location=global",
          "--project",
          projectId,
          "--format=value(forwardingRules)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (teFrs.exitCode !== 0 || !teFrs.stdout.trim()) {
        results.push({
          name: "ext_proc traffic extension",
          status: "fail",
          message: "not registered — edge middleware is not wired",
          fix: `npx adapter-k8s deploy   # the traffic-ext Job registers it`,
        });
      } else {
        const covered = teFrs.stdout.trim().split(";").filter(Boolean).length;
        // Enumerate THIS release's forwarding rules via its reserved static IP (exact
        // IPAddress match, the same chain cdn-invalidate uses) — `name~${releaseName}`
        // is a substring regex that also matches OTHER releases' rules ("app" vs
        // "myapp2"), producing false coverage failures.
        let frCount: number | null = null;
        const ipAddr = (
          await execCapture(
            "gcloud",
            [
              "compute",
              "addresses",
              "describe",
              `${releaseName}-ip`,
              "--global",
              "--project",
              projectId,
              "--format=value(address)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          )
        ).stdout.trim();
        if (ipAddr) {
          const frList = await execCapture(
            "gcloud",
            [
              "compute",
              "forwarding-rules",
              "list",
              "--project",
              projectId,
              "--filter",
              `IPAddress=${ipAddr}`,
              "--format=value(name)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          );
          if (frList.exitCode === 0) {
            frCount = frList.stdout.trim().split("\n").filter(Boolean).length;
          }
        }
        if (frCount === null) {
          // The old code read .stdout unconditionally — a failed list call meant
          // "covers N/0", a vacuous PASS. Say we can't verify instead.
          results.push({
            name: "ext_proc traffic extension",
            status: "warn",
            message:
              `registered, but forwarding-rule coverage could not be enumerated ` +
              `(static IP / forwarding-rule lookup failed) — cannot verify http:// coverage`,
            fix: `gcloud compute forwarding-rules list --project ${projectId}`,
          });
        } else if (frCount === 0) {
          results.push({
            name: "ext_proc traffic extension",
            status: "warn",
            message:
              `registered, but no forwarding rules found for the release's static ` +
              `IP — the load balancer may not be provisioned yet`,
          });
        } else {
          results.push(
            covered < frCount
              ? {
                  name: "ext_proc traffic extension",
                  status: "fail",
                  message: `covers ${covered}/${frCount} forwarding rules — http:// can bypass middleware`,
                  fix: `npx adapter-k8s deploy   # re-runs the Job to attach every forwarding rule`,
                }
              : {
                  name: "ext_proc traffic extension",
                  status: "pass",
                  message: `registered, covers ${covered}/${frCount} forwarding rules`,
                },
          );
        }
      }

      // Routing backend service must be EXTERNAL_MANAGED with a NEG attached.
      const bsScheme = (
        await execCapture(
          "gcloud",
          [
            "compute",
            "backend-services",
            "describe",
            `${releaseName}-routing-service`,
            "--global",
            "--project",
            projectId,
            "--format=value(loadBalancingScheme)",
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        )
      ).stdout
        .trim()
        .toUpperCase();
      if (bsScheme && bsScheme !== "EXTERNAL_MANAGED") {
        results.push({
          name: "routing backend scheme",
          status: "fail",
          message: `${bsScheme} (the traffic extension requires EXTERNAL_MANAGED)`,
          fix: `gcloud compute backend-services delete ${releaseName}-routing-service --global --project ${projectId} --quiet  # then re-run init + deploy`,
        });
      } else if (bsScheme) {
        results.push({
          name: "routing backend scheme",
          status: "pass",
          message: "EXTERNAL_MANAGED",
        });
        const backends = (
          await execCapture(
            "gcloud",
            [
              "compute",
              "backend-services",
              "describe",
              `${releaseName}-routing-service`,
              "--global",
              "--project",
              projectId,
              "--format=value(backends)",
            ],
            { timeoutMs: EXEC_TIMEOUTS.kubectl },
          )
        ).stdout.trim();
        results.push(
          backends
            ? { name: "routing backend NEG", status: "pass", message: "attached" }
            : {
                name: "routing backend NEG",
                status: "fail",
                message: "no NEG attached — the ext_proc callout has no backend",
                fix: `npx adapter-k8s deploy   # the Job attaches the standalone NEG`,
              },
        );
      }

      // Routing health check must be TCP — a plaintext gRPC check passes against a TLS
      // ext_proc server yet the callout still fails (the failure mode that hid for months).
      const hcType = (
        await execCapture(
          "gcloud",
          [
            "compute",
            "health-checks",
            "describe",
            `${releaseName}-routing-hc`,
            "--global",
            "--project",
            projectId,
            "--format=value(type)",
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        )
      ).stdout
        .trim()
        .toUpperCase();
      if (hcType && hcType !== "TCP") {
        results.push({
          name: "routing health check",
          status: "warn",
          message: `${hcType} (needs TCP; a gRPC check passes plaintext but the TLS callout fails)`,
          fix: `gcloud compute health-checks delete ${releaseName}-routing-hc --global --project ${projectId} --quiet  # then re-run init`,
        });
      } else if (hcType === "TCP") {
        results.push({ name: "routing health check", status: "pass", message: "TCP" });
      }
    }

    // --- Per-host checks: A record, CNAME (DNS auth), Certificate ---
    if (existsSync(infraPath)) {
      const infra = readJsonFile<{ hosts?: string[]; host?: string }>(infraPath);
      const hosts: string[] = Array.isArray(infra.hosts)
        ? infra.hosts
        : infra.host
          ? [infra.host]
          : [];

      // Get certificate status from Certificate Manager
      let certStatus: string | null = null;
      if (projectId) {
        const certResult = await execCapture(
          "gcloud",
          [
            "certificate-manager",
            "certificates",
            "describe",
            `${releaseName}-cert`,
            "--project",
            projectId,
            "--format=value(managed.state)",
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
      }

      for (const host of hosts) {
        results.push(
          ...(await checkDomainForHost({ host, releaseName, projectId, gatewayIp, certStatus })),
        );
      }
    }
  } else {
    results.push({
      name: "K8s cluster",
      status: "fail",
      message: "Cannot connect",
      fix: "Run `gcloud container clusters get-credentials CLUSTER --region REGION --project PROJECT`",
    });
  }

  printCheckResults(results);
}

// Standalone domain checks — called after deploy to show pending DNS/cert work
export async function runDomainChecks(options: {
  projectDir: string;
  releaseName: string;
  // N33: deploy prints its completion banner AFTER these checks and exits non-zero when any
  // FAIL — a release unreachable at its own hostname must not report a successful deploy.
}): Promise<{ failures: number }> {
  const { projectDir, releaseName } = options;
  const infraPath = infrastructurePath(projectDir);
  if (!existsSync(infraPath)) return { failures: 0 };

  const infra = readJsonFile<{ projectId?: string; hosts?: string[]; host?: string }>(infraPath);
  const projectId: string = infra.projectId ?? "";
  const hosts: string[] = Array.isArray(infra.hosts) ? infra.hosts : infra.host ? [infra.host] : [];
  if (hosts.length === 0) return { failures: 0 };

  // Resolve Gateway IP (try static IP from gcloud)
  let gatewayIp: string | null = null;
  if (projectId) {
    const ipResult = await execCapture(
      "gcloud",
      [
        "compute",
        "addresses",
        "describe",
        `${releaseName}-ip`,
        "--global",
        "--project",
        projectId,
        "--format=value(address)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (ipResult.exitCode === 0) gatewayIp = ipResult.stdout.trim();
  }

  let certStatus: string | null = null;
  if (projectId) {
    const certResult = await execCapture(
      "gcloud",
      [
        "certificate-manager",
        "certificates",
        "describe",
        `${releaseName}-cert`,
        "--project",
        projectId,
        "--format=value(managed.state)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
  }

  const results: CheckResult[] = [];

  for (const host of hosts) {
    results.push(
      ...(await checkDomainForHost({ host, releaseName, projectId, gatewayIp, certStatus })),
    );
  }

  const hasIssues = results.some((r) => !r.name.startsWith("---") && r.status !== "pass");
  if (hasIssues) {
    console.log("\n  Domain status:");
  } else {
    console.log("\n  Domains:");
  }
  for (const r of results) {
    if (r.name.startsWith("---")) {
      console.log(`\n  \x1b[1m${r.name.replace(/^-+\s*/, "").replace(/\s*-+$/, "")}\x1b[0m`);
      continue;
    }
    const icon =
      r.status === "pass"
        ? "\x1b[32mPASS\x1b[0m"
        : r.status === "warn"
          ? "\x1b[33mWARN\x1b[0m"
          : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${icon}  ${r.name}: ${r.message}`);
    if (r.fix && r.status !== "pass") {
      console.log(`         Fix: ${r.fix}`);
    }
  }
  // N33: report the count so deploy can downgrade its banner and exit non-zero.
  return {
    failures: results.filter((r) => !r.name.startsWith("---") && r.status === "fail").length,
  };
}
