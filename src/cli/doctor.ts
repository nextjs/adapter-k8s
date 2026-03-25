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
    return { name: `${name} installed`, status: "fail", message: `${name} not found in PATH`, fix: `Install ${name}` };
  }
  // Command exists but may have failed — still "installed"
  const version = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  return { name: `${name} installed`, status: "pass", message: version };
}

export async function runDoctor(options: { projectDir: string; releaseName: string }): Promise<void> {
  const { projectDir, releaseName } = options;
  const results: CheckResult[] = [];

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
    existsSync(path.join(projectDir, "adapter.config.ts")) ||
    existsSync(path.join(projectDir, "adapter.config.js"));
  results.push(
    configExists
      ? { name: "adapter.config", status: "pass", message: "Found" }
      : { name: "adapter.config", status: "warn", message: "Not found (will use defaults)", fix: "Run `npx adapter-k8s init` to scaffold" },
  );

  const statePath = path.join(projectDir, ".k8s-adapter", "state.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    results.push({ name: "Last deploy", status: "pass", message: `buildId: ${state.buildId}` });
  } else {
    results.push({ name: "Last deploy", status: "warn", message: "No deploys yet" });
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
        : { name: "gcloud auth", status: "fail", message: "Not authenticated", fix: "Run `gcloud auth login`" },
    );

    // Static IP
    const ipName = `${releaseName}-ip`;
    const ipResult = await execCapture("gcloud", [
      "compute", "addresses", "describe", ipName,
      "--global", "--project", projectId, "--format=value(address)",
    ]);
    if (ipResult.exitCode === 0) {
      results.push({ name: "Static IP", status: "pass", message: `${ipName} = ${ipResult.stdout.trim()}` });
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
        "storage", "buckets", "describe", `gs://${infra.gcsBucket}`,
        "--project", projectId, "--format=value(name)",
      ]);
      results.push(
        bucketResult.exitCode === 0
          ? { name: "GCS bucket", status: "pass", message: infra.gcsBucket }
          : { name: "GCS bucket", status: "fail", message: `${infra.gcsBucket} not found`, fix: `gcloud storage buckets create gs://${infra.gcsBucket} --project ${projectId} --location ${infra.region}` },
      );
    }

    // Artifact Registry
    if (infra.containerRegistry) {
      const repoName = infra.containerRegistry.split("/").pop() ?? "nextjs";
      const arResult = await execCapture("gcloud", [
        "artifacts", "repositories", "describe", repoName,
        "--location", infra.region, "--project", projectId, "--format=value(name)",
      ]);
      results.push(
        arResult.exitCode === 0
          ? { name: "Artifact Registry", status: "pass", message: infra.containerRegistry }
          : { name: "Artifact Registry", status: "fail", message: `Repository not found`, fix: `gcloud artifacts repositories create ${repoName} --repository-format docker --location ${infra.region} --project ${projectId}` },
      );
    }
  }

  // --- Kubernetes resources ---
  const kubectlOk = await execCapture("kubectl", ["cluster-info"]).catch(() => null);
  if (kubectlOk && kubectlOk.exitCode === 0) {
    results.push({ name: "K8s cluster", status: "pass", message: "Connected" });

    // Gateway
    const gwResult = await execCapture("kubectl", [
      "get", "gateway", `${releaseName}-gateway`, "-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].status}",
    ]);
    if (gwResult.exitCode === 0) {
      const accepted = gwResult.stdout.trim();
      if (accepted === "True") {
        results.push({ name: "Gateway", status: "pass", message: "Accepted" });
      } else {
        // Get the reason
        const reasonResult = await execCapture("kubectl", [
          "get", "gateway", `${releaseName}-gateway`, "-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].message}",
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
      "get", "gateway", `${releaseName}-gateway`, "-o", "jsonpath={.status.addresses[0].value}",
    ]);
    if (gwIpResult.exitCode === 0 && gwIpResult.stdout.trim()) {
      gatewayIp = gwIpResult.stdout.trim();
    }
    // Fallback: if Gateway status doesn't have it, use the reserved static IP
    if (!gatewayIp && projectId) {
      const staticIpResult = await execCapture("gcloud", [
        "compute", "addresses", "describe", `${releaseName}-ip`,
        "--global", "--project", projectId, "--format=value(address)",
      ]);
      if (staticIpResult.exitCode === 0 && staticIpResult.stdout.trim()) {
        gatewayIp = staticIpResult.stdout.trim();
      }
    }
    if (gatewayIp) {
      results.push({ name: "Gateway IP", status: "pass", message: gatewayIp });
    } else if (gwResult.exitCode === 0) {
      results.push({ name: "Gateway IP", status: "warn", message: "Not yet assigned (LB provisioning takes 5-10 min)" });
    }

    // HTTPRoute
    const routeResult = await execCapture("kubectl", [
      "get", "httproute", `${releaseName}-routes`, "-o", "jsonpath={.status.parents[0].conditions[?(@.type=='Accepted')].status}",
    ]);
    if (routeResult.exitCode === 0) {
      const accepted = routeResult.stdout.trim();
      results.push(
        accepted === "True"
          ? { name: "HTTPRoute", status: "pass", message: "Accepted" }
          : { name: "HTTPRoute", status: "fail", message: `Status: ${accepted || "Unknown"}`, fix: `kubectl describe httproute ${releaseName}-routes` },
      );
    } else {
      results.push({ name: "HTTPRoute", status: "warn", message: "Not found" });
    }

    // Pool pods
    const podsResult = await execCapture("kubectl", [
      "get", "pods", "-l", `app.kubernetes.io/name=${releaseName}`,
      "-o", "jsonpath={range .items[*]}{.metadata.name} {.status.phase}{\"\\n\"}{end}",
    ]);
    if (podsResult.exitCode === 0 && podsResult.stdout.trim()) {
      const pods = podsResult.stdout.trim().split("\n").filter(Boolean);
      const running = pods.filter(p => p.includes("Running")).length;
      const notRunning = pods.filter(p => !p.includes("Running"));
      if (notRunning.length === 0) {
        results.push({ name: "Pods", status: "pass", message: `${running}/${pods.length} running` });
      } else {
        results.push({
          name: "Pods",
          status: "fail",
          message: `${running}/${pods.length} running`,
          fix: `kubectl describe pod ${notRunning[0]?.split(" ")[0]}`,
        });
      }
    } else {
      results.push({ name: "Pods", status: "warn", message: "No pods found" });
    }

    // Pod errors — check recent logs for recurring errors
    if (podsResult.exitCode === 0 && podsResult.stdout.trim()) {
      const firstPod = podsResult.stdout.trim().split("\n")[0]?.split(" ")[0];
      if (firstPod) {
        const logsResult = await execCapture("kubectl", [
          "logs", firstPod, "--tail=50",
        ]);
        if (logsResult.exitCode === 0) {
          const errorLines = logsResult.stdout.split("\n").filter(l =>
            l.includes("Error") || l.includes("error") || l.includes("FATAL") || l.includes("Cannot find module")
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

    // Backend health — check if the GCP load balancer backend service is healthy
    if (projectId) {
      const backendsResult = await execCapture("gcloud", [
        "compute", "backend-services", "get-health",
        `k8s1-${releaseName}`, // GKE auto-generated backend name may differ
        "--global", "--project", projectId, "--format=json",
      ]).catch(() => null);
      // GKE backend service names are auto-generated, so this may not match.
      // Instead, check via the NEG health
      const negResult = await execCapture("kubectl", [
        "get", "svcneg", "-o", "jsonpath={range .items[*]}{.metadata.name}: {.status.conditions[0].type}={.status.conditions[0].status}{\"\\n\"}{end}",
      ]);
      if (negResult.exitCode === 0 && negResult.stdout.trim()) {
        for (const line of negResult.stdout.trim().split("\n")) {
          if (!line.includes(releaseName)) continue;
          const healthy = line.includes("=True");
          results.push(
            healthy
              ? { name: "Backend NEG", status: "pass", message: line.split(":")[0]?.trim() ?? "Ready" }
              : { name: "Backend NEG", status: "warn", message: line.trim(), fix: "NEG not yet ready — backend health check may be pending" },
          );
        }
      }
    }

    // --- Per-host checks: A record, CNAME (DNS auth), Certificate ---
    if (existsSync(infraPath)) {
      const infra = JSON.parse(readFileSync(infraPath, "utf-8"));
      const hosts: string[] = Array.isArray(infra.hosts) ? infra.hosts : infra.host ? [infra.host] : [];
      const gwIp = gatewayIp;

      // Get certificate status from Certificate Manager
      let certStatus: string | null = null;
      if (projectId) {
        const certResult = await execCapture("gcloud", [
          "certificate-manager", "certificates", "describe", `${releaseName}-cert`,
          "--project", projectId, "--format=value(managed.state)",
        ]);
        certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
      }

      for (const host of hosts) {
        if (host.includes("*")) continue;
        const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");

        results.push({ name: `--- ${host}`, status: "pass", message: "---" });

        // A record
        const resolvedIp = await resolve4(host).then(ips => ips[0] ?? null).catch(() => null);
        if (!resolvedIp) {
          results.push({
            name: `  A record`,
            status: "fail",
            message: "Does not resolve",
            fix: gwIp ? `Add DNS: ${host} A ${gwIp}` : "Add A record after Gateway IP is assigned",
          });
        } else if (gwIp && resolvedIp !== gwIp) {
          results.push({
            name: `  A record`,
            status: "warn",
            message: `${resolvedIp} (expected ${gwIp})`,
            fix: `Update DNS: ${host} A ${gwIp}`,
          });
        } else {
          results.push({ name: `  A record`, status: "pass", message: `${host} -> ${resolvedIp}` });
        }

        // CNAME for DNS authorization (Certificate Manager)
        if (projectId) {
          const authName = `${releaseName}-dns-auth-${safeName}`;
          const authResult = await execCapture("gcloud", [
            "certificate-manager", "dns-authorizations", "describe", authName,
            "--project", projectId,
            "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
          ]);
          if (authResult.exitCode === 0 && authResult.stdout.trim()) {
            const parts = authResult.stdout.trim().split(/\s+/);
            const cnameHost = parts[0] ?? "";
            const cnameTarget = parts[2] ?? parts[1] ?? "";

            // Check if the CNAME actually resolves
            const { resolveCname } = await import("node:dns/promises");
            const cnameResolved = await resolveCname(cnameHost).then(r => r[0] ?? null).catch(() => null);

            if (cnameResolved) {
              results.push({ name: `  CNAME (cert auth)`, status: "pass", message: `${cnameHost} -> ${cnameResolved}` });
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
              fix: certStatus === "PROVISIONING"
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
    const icon = r.status === "pass" ? "\x1b[32mPASS\x1b[0m" : r.status === "warn" ? "\x1b[33mWARN\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${icon}  ${r.name}: ${r.message}`);
    if (r.fix && r.status !== "pass") {
      console.log(`         Fix: ${r.fix}`);
    }
    if (r.status === "fail") fails++;
    if (r.status === "warn") warns++;
  }

  console.log(`\n  ${checkCount} checks: ${checkCount - fails - warns} passed, ${warns} warnings, ${fails} failures\n`);

  if (fails > 0) process.exit(1);
}

// Standalone domain checks — called after deploy to show pending DNS/cert work
export async function runDomainChecks(options: { projectDir: string; releaseName: string }): Promise<void> {
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
      "compute", "addresses", "describe", `${releaseName}-ip`,
      "--global", "--project", projectId, "--format=value(address)",
    ]);
    if (ipResult.exitCode === 0) gatewayIp = ipResult.stdout.trim();
  }

  // Certificate status
  let certStatus: string | null = null;
  if (projectId) {
    const certResult = await execCapture("gcloud", [
      "certificate-manager", "certificates", "describe", `${releaseName}-cert`,
      "--project", projectId, "--format=value(managed.state)",
    ]);
    certStatus = certResult.exitCode === 0 ? certResult.stdout.trim() : null;
  }

  const results: CheckResult[] = [];

  for (const host of hosts) {
    if (host.includes("*")) continue;
    const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");

    results.push({ name: `--- ${host}`, status: "pass", message: "---" });

    // A record
    const resolvedIp = await resolve4(host).then(ips => ips[0] ?? null).catch(() => null);
    if (!resolvedIp) {
      results.push({
        name: `  A record`,
        status: "fail",
        message: "Does not resolve",
        fix: gatewayIp ? `Add DNS: ${host} A ${gatewayIp}` : "Add A record after Gateway IP is assigned",
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

    // CNAME for DNS authorization
    if (projectId) {
      const authName = `${releaseName}-dns-auth-${safeName}`;
      const authResult = await execCapture("gcloud", [
        "certificate-manager", "dns-authorizations", "describe", authName,
        "--project", projectId,
        "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
      ]);
      if (authResult.exitCode === 0 && authResult.stdout.trim()) {
        const parts = authResult.stdout.trim().split(/\s+/);
        const cnameHost = parts[0] ?? "";
        const cnameTarget = parts[2] ?? parts[1] ?? "";

        const { resolveCname } = await import("node:dns/promises");
        const cnameResolved = await resolveCname(cnameHost).then(r => r[0] ?? null).catch(() => null);

        if (cnameResolved) {
          results.push({ name: `  CNAME (cert auth)`, status: "pass", message: `${cnameHost} -> ${cnameResolved}` });
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
          fix: certStatus === "PROVISIONING"
            ? "Requires CNAME + A records. Provisioning can take up to 60 min."
            : `gcloud certificate-manager certificates describe ${releaseName}-cert --project ${projectId}`,
        });
      }
    }
  }

  // Print
  const hasIssues = results.some(r => !r.name.startsWith("---") && r.status !== "pass");
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
    const icon = r.status === "pass" ? "\x1b[32mPASS\x1b[0m" : r.status === "warn" ? "\x1b[33mWARN\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${icon}  ${r.name}: ${r.message}`);
    if (r.fix && r.status !== "pass") {
      console.log(`         Fix: ${r.fix}`);
    }
  }
}
