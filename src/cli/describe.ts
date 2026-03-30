// src/cli/describe.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import boxen from "boxen";
import { execCapture } from "./exec.js";

const W = 62; // inner content width for boxen

export async function runDescribe(options: {
  projectDir: string;
  releaseName: string;
}): Promise<void> {
  const { projectDir, releaseName } = options;
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : null;

  // Read state from cluster ConfigMap (works for CI/CD + local)
  const { readState } = await import("./state.js");
  const state = await readState(projectDir, releaseName);

  // Ensure kubectl is pointing at the right cluster
  if (infra?.projectId && infra?.region) {
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
      console.error(`Failed to connect to cluster: ${credResult.stderr.trim()}`);
      process.exit(1);
    }
  }
  const hosts: string[] = infra?.hosts ?? [];
  const projectId: string = infra?.projectId ?? "unknown";
  const region: string = infra?.region ?? "unknown";
  const buildId = state?.buildId ?? "none";
  const previousBuildId = state?.previousBuildId ?? null;

  // Read generated CEL expression from build output
  const celPath = path.join(projectDir, ".k8s-adapter", "output", "cel-expression.txt");
  const celExpression = existsSync(celPath) ? readFileSync(celPath, "utf-8").trim() : null;

  let gatewayIp = "pending";
  let certStatus = "unknown";

  if (infra?.projectId) {
    const ipResult = await execCapture("gcloud", [
      "compute",
      "addresses",
      "describe",
      `${releaseName}-ip`,
      "--global",
      "--project",
      projectId,
      "--format=value(address)",
    ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    if (ipResult.exitCode === 0) gatewayIp = ipResult.stdout.trim();

    const certResult = await execCapture("gcloud", [
      "certificate-manager",
      "certificates",
      "describe",
      `${releaseName}-cert`,
      "--project",
      projectId,
      "--format=value(managed.state)",
    ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    if (certResult.exitCode === 0) certStatus = certResult.stdout.trim().toLowerCase();
  }

  const deploymentsResult = await execCapture("kubectl", [
    "get",
    "deployments",
    "-l",
    `app.kubernetes.io/name=${releaseName}`,
    "-o",
    'jsonpath={range .items[*]}{.metadata.name}|{.status.readyReplicas}/{.status.replicas}|{.spec.template.spec.containers[0].image}{"\\n"}{end}',
  ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));

  interface DeployInfo {
    shortName: string;
    status: string;
    revision: string;
    isRouting: boolean;
    role: "current" | "previous" | "old";
  }

  const currentBuildLower = buildId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 12);
  const previousBuildLower =
    previousBuildId
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "")
      .slice(0, 12) ?? "";

  const deployments: DeployInfo[] = [];
  if (deploymentsResult.exitCode === 0 && deploymentsResult.stdout.trim()) {
    for (const line of deploymentsResult.stdout.trim().split("\n")) {
      const [name, status, image] = line.split("|");
      if (!name) continue;
      const shortName = name.replace(`${releaseName}-`, "");
      const nameLower = name.toLowerCase();
      const isRouting = shortName === "routing-service";

      let role: DeployInfo["role"] = "old";
      const nameAlpha = nameLower.replace(/[^a-z0-9]/g, "");
      if (isRouting || nameAlpha.includes(currentBuildLower)) {
        role = "current";
      } else if (previousBuildLower && nameAlpha.includes(previousBuildLower)) {
        role = "previous";
      }

      // When scaled to 0, readyReplicas and replicas are absent from the API,
      // so jsonpath returns empty strings → status is "/" instead of "0/0".
      const [ready, total] = (status ?? "/").split("/");
      const normalizedStatus = `${ready || "0"}/${total || "0"}`;

      deployments.push({
        shortName,
        status: normalizedStatus,
        revision: image?.split(":").pop() ?? "unknown",
        isRouting,
        role,
      });
    }
  }

  // Style
  const d = "\x1b[2m";
  const b = "\x1b[1m";
  const g = "\x1b[32m";
  const y = "\x1b[33m";
  const r = "\x1b[31m";
  const c = "\x1b[36m";
  const x = "\x1b[0m";

  function icon(dep: DeployInfo): string {
    const { status, role } = dep;
    // Scaled to 0 is expected for previous/old — not an error
    if (status === "0/0") return role === "current" ? `${r}●${x}` : `${d}●${x}`;
    if (status.startsWith("0/")) return `${r}●${x}`;
    const [ready, total] = status.split("/");
    return ready === total ? `${g}●${x}` : `${y}●${x}`;
  }

  function fmtDeploy(dep: DeployInfo): string {
    const roleTag =
      dep.role === "current"
        ? `${g}current${x}`
        : dep.role === "previous"
          ? `${y}previous${x}`
          : `${d}old${x}`;
    return `  ${icon(dep)} ${dep.shortName}  ${d}${dep.status}${x}  [${roleTag}]`;
  }

  const hostList = hosts.length > 0 ? hosts.join(", ") : "not configured";
  const routingDeploys = deployments.filter((dep) => dep.isRouting);
  const poolDeploys = deployments.filter((dep) => !dep.isRouting);

  // Header
  console.log(`
${b}${c}${releaseName}${x} ${d}— @next-community/adapter-k8s${x}
${d}Project: ${projectId}  Region: ${region}${x}
${d}Build:   ${buildId}${previousBuildId ? `  Previous: ${previousBuildId}` : ""}${x}

${b}Request Flow${x}

  ${d}Clients${x}
  ${d}│${x}  ${hostList}
  ${d}▼${x}`);

  // ALB box
  // Format CEL expression for display — break long expressions across lines
  const celDisplay = celExpression
    ? celExpression.replace(/ \|\| /g, ` ||\n  `).replace(/ && /g, ` &&\n  `)
    : "not generated (run deploy first)";

  const celMode = celExpression
    ? celExpression.startsWith("!(")
      ? "exclusion list (has middleware)"
      : "inclusion list (no middleware)"
    : "";

  const celSection = [
    `${c}CEL Filter${x}${celMode ? `  ${d}${celMode}${x}` : ""}`,
    `${d}Invoke ext_proc when:${x}`,
    `${c}${celDisplay}${x}`,
  ].join("\n");

  const albContent = [
    `${b}GCP Application Load Balancer${x}`,
    `${d}IP: ${gatewayIp}   TLS: ${certStatus}${x}`,
    ``,
    boxen(celSection, {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      borderStyle: "single",
      dimBorder: true,
    }),
    ``,
    `    ${d}matched${x}              ${d}skipped${x}`,
    `       ${d}│${x}                     ${d}│${x}`,
    `       ${d}▼${x}                     ${d}▼${x}`,
    `  ${c}ext_proc${x} ${d}(gRPC)${x} ──▶ ${c}URL Map / HTTPRoute${x}`,
    `                      ${d}x-upstream-pool → pool backend${x}`,
    `                      ${d}path fallback → default pool${x}`,
  ].join("\n");

  console.log(boxen(albContent, { padding: 1, borderStyle: "round" }));

  console.log(`         ${d}│${x}`);
  console.log(`         ${d}▼${x}`);

  // GKE Cluster box
  const routingSection = [
    `${c}Route Extension Service${x} ${d}(ext_proc gRPC :8443)${x}`,
    `${d}resolveRoutes() + middleware invocation${x}`,
    ``,
    ...(routingDeploys.length > 0 ? routingDeploys.map(fmtDeploy) : [`  ${r}●${x} not deployed`]),
  ].join("\n");

  const poolSection = [
    `${c}Pool Servers${x} ${d}(HTTP :3000, handler via import())${x}`,
    ``,
    ...(poolDeploys.length > 0 ? poolDeploys.map(fmtDeploy) : [`  ${y}●${x} no pools deployed`]),
    ``,
    `${d}Config: routing-manifest.json, pool-manifest.json${x}`,
    `${d}Health: /healthz on :3000${x}`,
  ].join("\n");

  const gkeContent = [
    `${b}GKE Cluster${x}`,
    ``,
    boxen(routingSection, {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      borderStyle: "single",
      dimBorder: true,
    }),
    ``,
    `  ${d}│${x} ${d}x-upstream-pool, x-output-id${x}`,
    `  ${d}│${x} ${d}x-matched-pathname, x-route-matches${x}`,
    `  ${d}▼${x}`,
    ``,
    boxen(poolSection, {
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
      borderStyle: "single",
      dimBorder: true,
    }),
  ].join("\n");

  console.log(boxen(gkeContent, { padding: 1, borderStyle: "round" }));
  console.log("");
}
