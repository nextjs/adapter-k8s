// src/cli/doctor.ts
import { existsSync, readFileSync } from "node:fs";
import { resolve4 } from "node:dns/promises";
import path from "node:path";
import { execCapture } from "./exec.js";

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  fix?: string;
}

async function checkTool(name: string, args: string[]): Promise<CheckResult> {
  const result = await execCapture(name, args).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null; // command not found
    return { exitCode: 1, stdout: "", stderr: err.message }; // other error
  });
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

export async function runDoctor(options: {
  projectDir: string;
  releaseName: string;
}): Promise<void> {
  const { projectDir, releaseName } = options;
  const results: CheckResult[] = [];

  // Ensure kubectl is pointing at the right cluster
  const infraPathForCtx = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (existsSync(infraPathForCtx)) {
    const infraCtx = JSON.parse(readFileSync(infraPathForCtx, "utf-8"));
    if (infraCtx.projectId && infraCtx.region) {
      const clusterName = `${releaseName}-cluster`;
      const credResult = await execCapture("gcloud", [
        "container",
        "clusters",
        "get-credentials",
        clusterName,
        "--region",
        infraCtx.region,
        "--project",
        infraCtx.projectId,
        "--quiet",
      ]);
      if (credResult.exitCode !== 0) {
        console.error(`Failed to connect to cluster "${clusterName}": ${credResult.stderr.trim()}`);
        console.error(
          `Verify: gcloud container clusters get-credentials ${clusterName} --region ${infraCtx.region} --project ${infraCtx.projectId}`,
        );
        process.exit(1);
      }
    }
  }

  console.log("\nRunning health checks...\n");

  // --- Prerequisites ---
  results.push(await checkTool("gcloud", ["--version"]));
  results.push(await checkTool("kubectl", ["version", "--client", "-o", "yaml"]));
  results.push(await checkTool("helm", ["version", "--short"]));
  results.push(await checkTool("docker", ["--version"]));

  // --- Local config ---
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
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
  const { readState } = await import("./state.js");
  const state = await readState(projectDir, releaseName);
  if (state) {
    results.push({ name: "Current build", status: "pass", message: state.buildId });
    if (state.previousBuildId) {
      results.push({
        name: "Previous build",
        status: "pass",
        message: `${state.previousBuildId} (rollback target)`,
      });
    }
  } else {
    results.push({ name: "Deploy state", status: "warn", message: "No deploys yet" });
  }

  // --- GCP resources (only if infrastructure.json exists) ---
  let projectId = "";
  if (existsSync(infraPath)) {
    const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
    projectId = infra.projectId ?? "";

    // gcloud auth
    const authResult = await execCapture("gcloud", ["auth", "print-access-token", "--quiet"]);
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
    const ipResult = await execCapture("gcloud", [
      "compute",
      "addresses",
      "describe",
      ipName,
      "--global",
      "--project",
      projectId,
      "--format=value(address)",
    ]);
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
      const bucketResult = await execCapture("gcloud", [
        "storage",
        "buckets",
        "describe",
        `gs://${infra.gcsBucket}`,
        "--project",
        projectId,
        "--format=value(name)",
      ]);
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
      const arResult = await execCapture("gcloud", [
        "artifacts",
        "repositories",
        "describe",
        repoName,
        "--location",
        infra.region,
        "--project",
        projectId,
        "--format=value(name)",
      ]);
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
  const kubectlOk = await execCapture("kubectl", ["cluster-info"]).catch(() => null);
  if (kubectlOk && kubectlOk.exitCode === 0) {
    results.push({ name: "K8s cluster", status: "pass", message: "Connected" });

    // Gateway
    const gwResult = await execCapture("kubectl", [
      "get",
      "gateway",
      `${releaseName}-gateway`,
      "-o",
      "jsonpath={.status.conditions[?(@.type=='Accepted')].status}",
    ]);
    if (gwResult.exitCode === 0) {
      const accepted = gwResult.stdout.trim();
      if (accepted === "True") {
        results.push({ name: "Gateway", status: "pass", message: "Accepted" });
      } else {
        // Get the reason
        const reasonResult = await execCapture("kubectl", [
          "get",
          "gateway",
          `${releaseName}-gateway`,
          "-o",
          "jsonpath={.status.conditions[?(@.type=='Accepted')].message}",
        ]);
        results.push({
          name: "Gateway",
          status: "fail",
          message: reasonResult.stdout.trim() || `Status: ${accepted || "Unknown"}`,
          fix: `kubectl describe gateway ${releaseName}-gateway`,
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
    const gwIpResult = await execCapture("kubectl", [
      "get",
      "gateway",
      `${releaseName}-gateway`,
      "-o",
      "jsonpath={.status.addresses[0].value}",
    ]);
    if (gwIpResult.exitCode === 0 && gwIpResult.stdout.trim()) {
      gatewayIp = gwIpResult.stdout.trim();
    }
    // Fallback: if Gateway status doesn't have it, use the reserved static IP
    if (!gatewayIp && projectId) {
      const staticIpResult = await execCapture("gcloud", [
        "compute",
        "addresses",
        "describe",
        `${releaseName}-ip`,
        "--global",
        "--project",
        projectId,
        "--format=value(address)",
      ]);
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
    const routeResult = await execCapture("kubectl", [
      "get",
      "httproute",
      `${releaseName}-routes`,
      "-o",
      "jsonpath={.status.parents[0].conditions[?(@.type=='Accepted')].status}",
    ]);
    if (routeResult.exitCode === 0) {
      const accepted = routeResult.stdout.trim();
      results.push(
        accepted === "True"
          ? { name: "HTTPRoute", status: "pass", message: "Accepted" }
          : {
              name: "HTTPRoute",
              status: "fail",
              message: `Status: ${accepted || "Unknown"}`,
              fix: `kubectl describe httproute ${releaseName}-routes`,
            },
      );
    } else {
      results.push({ name: "HTTPRoute", status: "warn", message: "Not found" });
    }

    // Per-deployment health with rollout awareness
    const deploysResult = await execCapture("kubectl", [
      "get",
      "deployments",
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}|{.status.readyReplicas}/{.status.replicas}{"\\n"}{end}',
    ]);
    const currentBuildLower = (state?.buildId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12);
    const previousBuildLower = (state?.previousBuildId ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12);

    let foundCurrentPool = false;

    if (deploysResult.exitCode === 0 && deploysResult.stdout.trim()) {
      for (const line of deploysResult.stdout.trim().split("\n")) {
        const [name, statusStr] = line.split("|");
        if (!name) continue;
        const shortName = name.replace(`${releaseName}-`, "");
        const nameLower = name.toLowerCase();
        const isRouting = shortName === "routing-service";

        // Determine role
        let role = "old";
        if (isRouting) role = "current";
        else if (
          currentBuildLower &&
          nameLower.replace(/[^a-z0-9]/g, "").includes(currentBuildLower)
        )
          role = "current";
        else if (
          previousBuildLower &&
          nameLower.replace(/[^a-z0-9]/g, "").includes(previousBuildLower)
        )
          role = "previous";

        if (role === "current" && !isRouting) foundCurrentPool = true;

        const roleTag = role === "current" ? "" : role === "previous" ? " [previous]" : " [old]";
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
            fix: `kubectl describe deployment/${name}`,
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
            fix: `kubectl describe deployment/${name}`,
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
    let poolNames: string[] = [];
    const metaPath = path.join(projectDir, ".k8s-adapter", "output", "build-metadata.json");
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        if (Array.isArray(meta.pools)) poolNames = meta.pools.filter((p: unknown) => typeof p === "string");
      } catch {
        // Malformed metadata — skip the endpoint check rather than crash.
      }
    }
    for (const pool of poolNames) {
      const svc = `${releaseName}-${pool}`;
      const epResult = await execCapture("kubectl", [
        "get",
        "endpointslice",
        "-l",
        `kubernetes.io/service-name=${svc}`,
        "-o",
        'jsonpath={range .items[*]}{range .endpoints[*]}{.conditions.ready}{"\\n"}{end}{end}',
      ]);
      const readyEndpoints =
        epResult.exitCode === 0
          ? epResult.stdout.trim().split("\n").filter((v) => v.trim() === "true").length
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
          fix: `kubectl get svc ${svc} -o jsonpath='{.spec.selector}' — verify app.kubernetes.io/version matches a running pod's label`,
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
            const [name] = line.split("|");
            return (
              name &&
              !name.includes("routing-service") &&
              name
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "")
                .includes(previousBuildLower)
            );
          });
      if (foundPrevious) {
        results.push({
          name: "Rollback ready",
          status: "pass",
          message: `Previous build ${state.previousBuildId} available`,
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

    // Pod errors — check recent logs for recurring errors
    const podsResult = await execCapture("kubectl", [
      "get",
      "pods",
      "-l",
      `app.kubernetes.io/name=${releaseName}`,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ]);
    if (podsResult.exitCode === 0 && podsResult.stdout.trim()) {
      const firstPod = podsResult.stdout.trim().split("\n")[0];
      if (firstPod) {
        const logsResult = await execCapture("kubectl", ["logs", firstPod, "--tail=50"]);
        if (logsResult.exitCode === 0) {
          const errorLines = logsResult.stdout
            .split("\n")
            .filter(
              (l) =>
                l.includes("Error") ||
                l.includes("error") ||
                l.includes("FATAL") ||
                l.includes("Cannot find module"),
            );
          if (errorLines.length > 0) {
            const firstError = errorLines[0]!.trim().slice(0, 120);
            results.push({
              name: "Pod logs",
              status: "fail",
              message: `Errors detected: ${firstError}`,
              fix: `kubectl logs ${firstPod} --tail=50`,
            });
          } else {
            results.push({ name: "Pod logs", status: "pass", message: "No errors in recent logs" });
          }
        }
      }
    }

    // GCP backend health checks — query actual LB health status
    if (projectId) {
      // List backend services associated with this release
      const bsResult = await execCapture("gcloud", [
        "compute",
        "backend-services",
        "list",
        "--project",
        projectId,
        "--global",
        "--filter",
        `name~${releaseName}`,
        "--format=value(name)",
      ]);
      if (bsResult.exitCode === 0 && bsResult.stdout.trim()) {
        for (const bsName of bsResult.stdout.trim().split("\n")) {
          if (!bsName) continue;
          const healthResult = await execCapture("gcloud", [
            "compute",
            "backend-services",
            "get-health",
            bsName,
            "--project",
            projectId,
            "--global",
            "--format=json",
          ]);
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
              // Check if this backend is from the current build or a stale old one
              const currentBuildId = state?.buildId?.toLowerCase() ?? "";
              const isCurrentBuild =
                !currentBuildId ||
                bsName
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, "")
                  .includes(
                    currentBuildId
                      .toLowerCase()
                      .replace(/[^a-z0-9]/g, "")
                      .slice(0, 12),
                  );

              if (total === 0) {
                results.push({
                  name: `LB health: ${shortName}`,
                  status: isCurrentBuild ? "warn" : "pass",
                  message: isCurrentBuild
                    ? "No backends registered yet"
                    : "Old build (pending cleanup)",
                });
              } else if (healthy === total) {
                results.push({
                  name: `LB health: ${shortName}`,
                  status: "pass",
                  message: `${healthy}/${total} healthy`,
                });
              } else if (!isCurrentBuild) {
                // Old build backends being unhealthy is expected — don't fail
                results.push({
                  name: `LB health: ${shortName}`,
                  status: "warn",
                  message: `${healthy}/${total} healthy (old build, pending cleanup)`,
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

      // Also check NEG status from K8s side
      const negResult = await execCapture("kubectl", [
        "get",
        "svcneg",
        "-o",
        'jsonpath={range .items[*]}{.metadata.name}: {.status.conditions[0].type}={.status.conditions[0].status}{"\\n"}{end}',
      ]);
      if (negResult.exitCode === 0 && negResult.stdout.trim()) {
        for (const line of negResult.stdout.trim().split("\n")) {
          if (!line.includes(releaseName)) continue;
          const healthy = line.includes("=True");
          results.push(
            healthy
              ? {
                  name: "Backend NEG",
                  status: "pass",
                  message: line.split(":")[0]?.trim() ?? "Ready",
                }
              : {
                  name: "Backend NEG",
                  status: "warn",
                  message: line.trim(),
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
      const teFrs = await execCapture("gcloud", [
        "service-extensions", "lb-traffic-extensions", "describe", `${releaseName}-traffic-ext`,
        "--location=global", "--project", projectId, "--format=value(forwardingRules)",
      ]);
      if (teFrs.exitCode !== 0 || !teFrs.stdout.trim()) {
        results.push({
          name: "ext_proc traffic extension",
          status: "fail",
          message: "not registered — edge middleware is not wired",
          fix: `npx adapter-k8s deploy   # the traffic-ext Job registers it`,
        });
      } else {
        const covered = teFrs.stdout.trim().split(";").filter(Boolean).length;
        const allFrs = (
          await execCapture("gcloud", [
            "compute", "forwarding-rules", "list", "--project", projectId,
            "--filter", `name~${releaseName}`, "--format=value(name)",
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean).length;
        results.push(
          allFrs > 0 && covered < allFrs
            ? {
                name: "ext_proc traffic extension",
                status: "fail",
                message: `covers ${covered}/${allFrs} forwarding rules — http:// can bypass middleware`,
                fix: `npx adapter-k8s deploy   # re-runs the Job to attach every forwarding rule`,
              }
            : {
                name: "ext_proc traffic extension",
                status: "pass",
                message: `registered, covers ${covered}/${allFrs} forwarding rules`,
              },
        );
      }

      // Routing backend service must be EXTERNAL_MANAGED with a NEG attached.
      const bsScheme = (
        await execCapture("gcloud", [
          "compute", "backend-services", "describe", `${releaseName}-routing-service`,
          "--global", "--project", projectId, "--format=value(loadBalancingScheme)",
        ])
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
        results.push({ name: "routing backend scheme", status: "pass", message: "EXTERNAL_MANAGED" });
        const backends = (
          await execCapture("gcloud", [
            "compute", "backend-services", "describe", `${releaseName}-routing-service`,
            "--global", "--project", projectId, "--format=value(backends)",
          ])
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
        await execCapture("gcloud", [
          "compute", "health-checks", "describe", `${releaseName}-routing-hc`,
          "--global", "--project", projectId, "--format=value(type)",
        ])
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
      const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
      const hosts: string[] = Array.isArray(infra.hosts)
        ? infra.hosts
        : infra.host
          ? [infra.host]
          : [];
      const gwIp = gatewayIp;

      // Get certificate status from Certificate Manager
      let certStatus: string | null = null;
      if (projectId) {
        const certResult = await execCapture("gcloud", [
          "certificate-manager",
          "certificates",
          "describe",
          `${releaseName}-cert`,
          "--project",
          projectId,
          "--format=value(managed.state)",
        ]);
        certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
      }

      for (const host of hosts) {
        // Wildcard domains: skip DNS A record check (can't resolve *.example.com)
        // but still check CNAME auth and cert status
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
              fix: gwIp
                ? `Add DNS: ${host} A ${gwIp}`
                : "Add A record after Gateway IP is assigned",
            });
          } else if (gwIp && resolvedIp !== gwIp) {
            results.push({
              name: `  A record`,
              status: "warn",
              message: `${resolvedIp} (expected ${gwIp})`,
              fix: `Update DNS: ${host} A ${gwIp}`,
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
            ...(gwIp
              ? { fix: `Add DNS: ${host} A ${gwIp} (or use individual subdomain A records)` }
              : {}),
          });
        }

        // CNAME for DNS authorization (Certificate Manager)
        if (projectId) {
          const authName = `${releaseName}-dns-auth-${safeName}`;
          const authResult = await execCapture("gcloud", [
            "certificate-manager",
            "dns-authorizations",
            "describe",
            authName,
            "--project",
            projectId,
            "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
          ]);
          if (authResult.exitCode === 0 && authResult.stdout.trim()) {
            const parts = authResult.stdout.trim().split(/\s+/);
            const cnameHost = parts[0] ?? "";
            const cnameTarget = parts[2] ?? parts[1] ?? "";

            // Check if the CNAME actually resolves
            const { resolveCname } = await import("node:dns/promises");
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
        } else if (projectId) {
          results.push({
            name: `  TLS certificate`,
            status: "warn",
            message: "Not found",
            fix: `Run \`npx adapter-k8s init\` to create certificates`,
          });
        }
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

  // --- Print results ---
  console.log("");
  let fails = 0;
  let warns = 0;
  let checkCount = 0;
  for (const r of results) {
    // Section separator
    if (r.name.startsWith("---")) {
      console.log(`\n  \x1b[1m${r.name.replace(/^-+\s*/, "").replace(/\s*-+$/, "")}\x1b[0m`);
      continue;
    }
    checkCount++;
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
    if (r.status === "fail") fails++;
    if (r.status === "warn") warns++;
  }

  console.log(
    `\n  ${checkCount} checks: ${checkCount - fails - warns} passed, ${warns} warnings, ${fails} failures\n`,
  );

  if (fails > 0) process.exit(1);
}

// Standalone domain checks — called after deploy to show pending DNS/cert work
export async function runDomainChecks(options: {
  projectDir: string;
  releaseName: string;
}): Promise<void> {
  const { projectDir, releaseName } = options;
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (!existsSync(infraPath)) return;

  const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
  const projectId: string = infra.projectId ?? "";
  const hosts: string[] = Array.isArray(infra.hosts) ? infra.hosts : infra.host ? [infra.host] : [];
  if (hosts.length === 0) return;

  // Resolve Gateway IP (try static IP from gcloud)
  let gatewayIp: string | null = null;
  if (projectId) {
    const ipResult = await execCapture("gcloud", [
      "compute",
      "addresses",
      "describe",
      `${releaseName}-ip`,
      "--global",
      "--project",
      projectId,
      "--format=value(address)",
    ]);
    if (ipResult.exitCode === 0) gatewayIp = ipResult.stdout.trim();
  }

  // Certificate status
  let certStatus: string | null = null;
  if (projectId) {
    const certResult = await execCapture("gcloud", [
      "certificate-manager",
      "certificates",
      "describe",
      `${releaseName}-cert`,
      "--project",
      projectId,
      "--format=value(managed.state)",
    ]);
    certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
  }

  const results: CheckResult[] = [];

  for (const host of hosts) {
    const isWildcard = host.includes("*");
    const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");

    results.push({ name: `--- ${host}`, status: "pass", message: "---" });

    // A record (skip resolve for wildcards)
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
        results.push({ name: `  A record`, status: "pass", message: `${host} -> ${resolvedIp}` });
      }
    } else {
      results.push({
        name: `  A record`,
        status: "warn",
        message: "Wildcard — configure A record for base domain or subdomains",
        ...(gatewayIp ? { fix: `Add DNS: ${host} A ${gatewayIp}` } : {}),
      });
    }

    // CNAME for DNS authorization
    if (projectId) {
      const authName = `${releaseName}-dns-auth-${safeName}`;
      const authResult = await execCapture("gcloud", [
        "certificate-manager",
        "dns-authorizations",
        "describe",
        authName,
        "--project",
        projectId,
        "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
      ]);
      if (authResult.exitCode === 0 && authResult.stdout.trim()) {
        const parts = authResult.stdout.trim().split(/\s+/);
        const cnameHost = parts[0] ?? "";
        const cnameTarget = parts[2] ?? parts[1] ?? "";

        const { resolveCname } = await import("node:dns/promises");
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
    }
  }

  // Print
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
}
