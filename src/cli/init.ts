// src/cli/init.ts
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./exec.js";
import { generateAdapterConfig, generateInfrastructureJson } from "./scaffold.js";
import { gkeVersionAtLeast, MIN_GKE_VERSION_FOR_CDN } from "./gke-version.js";

export interface InitOptions {
  projectId: string;
  region: string;
  hosts: string[];
  bucket: string;
  registry: string;
  releaseName: string;
  projectDir: string;
  dryRun?: boolean;
  /** Backoff between IAM-binding retries (ms). Defaults to 5000; tests override to run fast. */
  iamRetryDelayMs?: number;
}

export interface GcloudCommand {
  description: string;
  command: string;
  args: string[];
}

export function buildInitGcloudCommands(options: {
  projectId: string;
  region: string;
  bucket: string;
  releaseName: string;
  hosts?: string[];
}): GcloudCommand[] {
  const { projectId, region, bucket, releaseName, hosts = [] } = options;
  const commands: GcloudCommand[] = [];

  // 0. Enable required APIs
  commands.push({
    description: "Enable Required APIs (GKE, Artifact Registry, CAS, etc.)",
    command: "gcloud",
    args: [
      "services",
      "enable",
      "artifactregistry.googleapis.com",
      "container.googleapis.com",
      "networkservices.googleapis.com",
      "compute.googleapis.com",
      "certificatemanager.googleapis.com",
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // 0.1 Create GKE Autopilot cluster
  commands.push({
    description: "Create GKE Autopilot cluster",
    command: "gcloud",
    args: [
      "container",
      "clusters",
      "create-auto",
      `${releaseName}-cluster`,
      "--location",
      region,
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // 0.2 Reserve Global Static IP
  commands.push({
    description: "Reserve Global Static IP for Gateway",
    command: "gcloud",
    args: [
      "compute",
      "addresses",
      "create",
      `${releaseName}-ip`,
      "--global",
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // 0.3 Create Artifact Registry repository
  commands.push({
    description: "Create Artifact Registry repository",
    command: "gcloud",
    args: [
      "artifacts",
      "repositories",
      "create",
      "nextjs",
      "--repository-format",
      "docker",
      "--location",
      region,
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // 1. Create GCS bucket for static assets
  commands.push({
    description: "Create GCS bucket for static assets",
    command: "gcloud",
    args: [
      "storage",
      "buckets",
      "create",
      `gs://${bucket}`,
      "--project",
      projectId,
      "--location",
      region,
      "--uniform-bucket-level-access",
      "--quiet",
    ],
  });

  // 2. Create deploy service account
  commands.push({
    description: "Create deploy service account",
    command: "gcloud",
    args: [
      "iam",
      "service-accounts",
      "create",
      `${releaseName}-deploy`,
      "--project",
      projectId,
      "--display-name",
      `${releaseName} adapter deploy SA`,
      "--quiet",
    ],
  });

  // 3. Grant storage admin on bucket
  commands.push({
    description: "Grant storage admin on bucket",
    command: "gcloud",
    args: [
      "storage",
      "buckets",
      "add-iam-policy-binding",
      `gs://${bucket}`,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/storage.objectAdmin",
      "--condition=None",
      "--quiet",
    ],
  });

  // 4. Grant Artifact Registry writer (for pushing container images)
  commands.push({
    description: "Grant Artifact Registry writer for container images",
    command: "gcloud",
    args: [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/artifactregistry.writer",
      "--condition=None",
      "--quiet",
    ],
  });

  // 5. Grant Artifact Registry repo admin specifically on the new repo
  commands.push({
    description: "Grant Artifact Registry repo admin on nextjs repository",
    command: "gcloud",
    args: [
      "artifacts",
      "repositories",
      "add-iam-policy-binding",
      "nextjs",
      "--location",
      region,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/artifactregistry.repoAdmin",
      "--project",
      projectId,
      "--condition=None",
      "--quiet",
    ],
  });

  // --- Deploy Service Account (Workload Identity for Helm hook Jobs) ---
  // The route-ext update Job needs:
  // - networkservices.admin to import LbRouteExtension
  // - compute.viewer to list forwarding rules (for discovery)
  commands.push({
    description: "Grant deploy SA networkservices.admin role",
    command: "gcloud",
    args: [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/networkservices.admin",
      "--condition=None",
      "--quiet",
    ],
  });

  commands.push({
    description: "Grant deploy SA compute.viewer role (forwarding rule discovery)",
    command: "gcloud",
    args: [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/compute.viewer",
      "--condition=None",
      "--quiet",
    ],
  });

  // The traffic-ext Job also attaches the routing-service NEG to the ext_proc backend
  // service (compute.backendServices.update + networkEndpointGroups.use) — beyond the
  // read-only compute.viewer above.
  commands.push({
    description: "Grant deploy SA compute.loadBalancerAdmin (attach NEG to ext_proc backend)",
    command: "gcloud",
    args: [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/compute.loadBalancerAdmin",
      "--condition=None",
      "--quiet",
    ],
  });

  // Allow the K8s SA to impersonate the GCP deploy SA via Workload Identity
  commands.push({
    description: "Bind K8s SA to GCP SA via Workload Identity",
    command: "gcloud",
    args: [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      `${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`,
      "--role",
      "roles/iam.workloadIdentityUser",
      "--member",
      `serviceAccount:${projectId}.svc.id.goog[default/${releaseName}-deploy-sa]`,
      "--condition=None",
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // --- Route Extension Service (ext_proc) ---
  // Create health check for routing service.
  // TCP (not gRPC): the routing service serves the ext_proc callout over HTTP/2 *with
  // TLS*, and a plaintext gRPC health check fails against a TLS server (which would mark
  // the backend unhealthy and bypass the extension). A TCP check on 8443 stays green for
  // both the h2c (emulate) and TLS (GKE) transports.
  commands.push({
    description: "Create health check for routing service",
    command: "gcloud",
    args: [
      "compute",
      "health-checks",
      "create",
      "tcp",
      `${releaseName}-routing-hc`,
      "--port",
      "8443",
      "--global",
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // Create backend service for routing service (the ext_proc TRAFFIC extension target).
  // Must be EXTERNAL_MANAGED to match the global external ALB the GKE Gateway provisions;
  // the default (EXTERNAL) is rejected by the extension with a scheme-mismatch error.
  commands.push({
    description: "Create backend service for routing service",
    command: "gcloud",
    args: [
      "compute",
      "backend-services",
      "create",
      `${releaseName}-routing-service`,
      "--global",
      "--load-balancing-scheme",
      "EXTERNAL_MANAGED",
      "--protocol",
      "HTTP2",
      "--health-checks",
      `${releaseName}-routing-hc`,
      "--project",
      projectId,
      "--quiet",
    ],
  });

  // Create LbRouteExtension with placeholder CEL
  // gcloud uses `import` (not `create`) for lb-route-extensions — it takes a YAML spec file.
  // We'll skip this in init and handle it via the Helm hook Job on first deploy instead.
  // The Helm hook uses `gcloud service-extensions lb-route-extensions import` with the
  // extension-chains.json generated at build time.

  // --- Certificate Manager (for TLS on GKE Gateway API) ---
  // GKE Gateway API does NOT support ManagedCertificate CRD or certificateRefs.
  // Instead, use Certificate Manager with a certmap annotation on the Gateway.
  if (hosts.length > 0) {
    // Create DNS authorization per host (needed for Google-managed certs)
    for (const host of hosts) {
      const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      commands.push({
        description: `Create DNS authorization for ${host}`,
        command: "gcloud",
        args: [
          "certificate-manager",
          "dns-authorizations",
          "create",
          `${releaseName}-dns-auth-${safeName}`,
          // For wildcard domains (*.example.com), DNS auth must be for the base domain
          "--domain",
          host.replace(/^\*\./, ""),
          "--project",
          projectId,
          "--quiet",
        ],
      });
    }

    // Create Google-managed certificate covering all hosts
    const dnsAuthRefs = hosts.map((host) => {
      const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      return `${releaseName}-dns-auth-${safeName}`;
    });
    commands.push({
      description: "Create Google-managed certificate",
      command: "gcloud",
      args: [
        "certificate-manager",
        "certificates",
        "create",
        `${releaseName}-cert`,
        "--domains",
        hosts.join(","),
        "--dns-authorizations",
        dnsAuthRefs.join(","),
        "--project",
        projectId,
        "--quiet",
      ],
    });

    // Create certificate map
    commands.push({
      description: "Create certificate map",
      command: "gcloud",
      args: [
        "certificate-manager",
        "maps",
        "create",
        `${releaseName}-certmap`,
        "--project",
        projectId,
        "--quiet",
      ],
    });

    // Create certificate map entry per host
    for (const host of hosts) {
      const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      commands.push({
        description: `Create certificate map entry for ${host}`,
        command: "gcloud",
        args: [
          "certificate-manager",
          "maps",
          "entries",
          "create",
          `${releaseName}-certmap-entry-${safeName}`,
          "--map",
          `${releaseName}-certmap`,
          "--certificates",
          `${releaseName}-cert`,
          "--hostname",
          host,
          "--project",
          projectId,
          "--quiet",
        ],
      });
    }
  }

  return commands;
}

// init creates resources idempotently and SKIPS existing ones. A project initialized
// before traffic extensions kept a gRPC health check and a default (EXTERNAL) backend
// service, which the traffic extension rejects — and re-running init won't fix them
// (they already exist). Detect the stale shape and print exact migration commands rather
// than silently leaving middleware unwired.
async function checkRoutingResourceShape(releaseName: string, projectId: string): Promise<void> {
  const hc = `${releaseName}-routing-hc`;
  const bs = `${releaseName}-routing-service`;
  const hcType = (
    await execCapture("gcloud", [
      "compute",
      "health-checks",
      "describe",
      hc,
      "--global",
      "--project",
      projectId,
      "--format=value(type)",
    ])
  ).stdout
    .trim()
    .toUpperCase();
  const bsScheme = (
    await execCapture("gcloud", [
      "compute",
      "backend-services",
      "describe",
      bs,
      "--global",
      "--project",
      projectId,
      "--format=value(loadBalancingScheme)",
    ])
  ).stdout
    .trim()
    .toUpperCase();

  const issues: string[] = [];
  if (bsScheme && bsScheme !== "EXTERNAL_MANAGED")
    issues.push(`backend service '${bs}' scheme is ${bsScheme} (needs EXTERNAL_MANAGED)`);
  if (hcType && hcType !== "TCP") issues.push(`health check '${hc}' type is ${hcType} (needs TCP)`);
  if (issues.length === 0) return;

  console.warn(
    `\n  ! Existing routing-service resources predate the ext_proc traffic-extension shape ` +
      `and it will NOT work as-is:`,
  );
  for (const issue of issues) console.warn(`      - ${issue}`);
  console.warn(
    `    These are immutable, and init skips existing resources — re-running init does not ` +
      `fix them. Migrate (brief callout disruption while recreated), then re-run init + deploy:\n` +
      `      gcloud compute backend-services delete ${bs} --global --project=${projectId} --quiet\n` +
      `      gcloud compute health-checks delete ${hc} --global --project=${projectId} --quiet\n` +
      `      npx adapter-k8s init ...   # recreates them with EXTERNAL_MANAGED + TCP`,
  );
}

export async function runInit(options: InitOptions): Promise<void> {
  const {
    projectId,
    region,
    hosts,
    bucket,
    registry,
    releaseName,
    projectDir,
    dryRun,
    iamRetryDelayMs = 5000,
  } = options;

  console.log(`\nInitializing @next-community/adapter-k8s for project: ${projectId}\n`);

  // 1. Generate gcloud commands
  const commands = buildInitGcloudCommands({
    projectId,
    region,
    bucket,
    releaseName,
    hosts,
  });

  // 2. Run gcloud commands (idempotent — safe to re-run)
  for (const cmd of commands) {
    console.log(`  → ${cmd.description}`);
    if (dryRun) {
      console.log(`    [dry-run] ${cmd.command} ${cmd.args.join(" ")}`);
      continue;
    }
    // Use execCapture to check stderr for "already exists" — gcloud puts
    // error messages in stderr, not in the thrown Error message.
    let result = await execCapture(cmd.command, cmd.args);

    if (result.exitCode !== 0) {
      const isAlreadyExists =
        result.stderr.includes("already exists") ||
        result.stderr.includes("ALREADY_EXISTS") ||
        result.stderr.includes("already own it") ||
        result.stderr.includes("Conflict") ||
        result.stderr.includes("409");

      const isIamBinding = cmd.command === "gcloud" && cmd.args.includes("add-iam-policy-binding");

      if (isAlreadyExists) {
        console.log(`    (already exists — skipping)`);
      } else if (isIamBinding) {
        // IAM bindings routinely fail transiently right after their target is created — a
        // just-created service account is not yet propagated ("does not exist"), or the policy
        // read-modify-write conflicts. This is eventual consistency, so retry with backoff
        // (~30s total covers SA propagation). Applies to ALL grants, not just storage admin —
        // the Artifact Registry writer grant hit exactly this on a fresh init.
        let ok = false;
        for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
          console.log(`    (IAM binding not ready — retry ${attempt}/6)`);
          await new Promise((r) => setTimeout(r, iamRetryDelayMs));
          result = await execCapture(cmd.command, cmd.args);
          ok =
            result.exitCode === 0 ||
            /already exists|ALREADY_EXISTS|already own it/.test(result.stderr);
        }
        if (!ok) {
          throw new Error(`${cmd.description} failed after retries:\n${result.stderr}`);
        }
      } else {
        throw new Error(`${cmd.description} failed:\n${result.stderr}`);
      }
    }
  }

  // 2a-pre. Surface pre-traffic-extension routing resources that init can't fix in place.
  if (!dryRun) {
    await checkRoutingResourceShape(releaseName, projectId);
  }

  // 2a. Cloud CDN (GCPHTTPFilter) needs GKE >= MIN_GKE_VERSION_FOR_CDN, and the scaffolded
  // config enables CDN by default. Warn here; `deploy` hard-fails via CRD detection when a
  // CDN-enabled chart targets an unsupported cluster.
  if (!dryRun) {
    const versionResult = await execCapture("gcloud", [
      "container",
      "clusters",
      "describe",
      `${releaseName}-cluster`,
      "--location",
      region,
      "--project",
      projectId,
      "--format=value(currentMasterVersion)",
      "--quiet",
    ]);
    if (versionResult.exitCode === 0) {
      const version = versionResult.stdout.trim();
      const supported = gkeVersionAtLeast(version, MIN_GKE_VERSION_FOR_CDN);
      if (supported === false) {
        console.warn(
          `  ! Cluster version ${version} is below ${MIN_GKE_VERSION_FOR_CDN}: Cloud CDN ` +
            `(enabled by default in the scaffolded config) will not work. Upgrade the ` +
            `cluster or set provider.gke.cdn.enabled: false.`,
        );
      }
    }
  }

  // 2b. Grant Artifact Registry reader for GKE image pulls
  // GKE Autopilot uses the container-engine-robot service agent for image pulls
  if (!dryRun) {
    console.log("  → Granting Artifact Registry reader for GKE image pulls");
    const projNumResult = await execCapture("gcloud", [
      "projects",
      "describe",
      projectId,
      "--format=value(projectNumber)",
      "--quiet",
    ]);
    if (projNumResult.exitCode === 0) {
      const projectNumber = projNumResult.stdout.trim();
      const serviceAgents = [
        `service-${projectNumber}@container-engine-robot.iam.gserviceaccount.com`,
        `${projectNumber}-compute@developer.gserviceaccount.com`,
      ];
      for (const sa of serviceAgents) {
        await execCapture("gcloud", [
          "artifacts",
          "repositories",
          "add-iam-policy-binding",
          "nextjs",
          "--location",
          region,
          "--member",
          `serviceAccount:${sa}`,
          "--role",
          "roles/artifactregistry.reader",
          "--project",
          projectId,
          "--condition=None",
          "--quiet",
        ]);
      }
    }
  } else {
    console.log("  → [dry-run] Grant Artifact Registry reader for GKE image pulls");
  }

  // 3. Scaffold adapter config (if not exists)
  // Prefer .mjs to avoid Node.js MODULE_TYPELESS_PACKAGE_JSON warning
  const configExists =
    existsSync(path.join(projectDir, "adapter.config.mjs")) ||
    existsSync(path.join(projectDir, "adapter.config.ts")) ||
    existsSync(path.join(projectDir, "adapter.config.js"));

  if (!configExists) {
    const configPath = path.join(projectDir, "adapter.config.mjs");
    console.log("\n  → Scaffolding adapter.config.mjs");
    const configContent = generateAdapterConfig({
      projectId,
      region,
      hosts,
      bucket,
      registry,
    });
    if (!dryRun) {
      writeFileSync(configPath, configContent);
    } else {
      console.log("    [dry-run] Would write adapter.config.mjs");
    }
  } else {
    console.log("\n  → adapter config already exists — skipping");
  }

  // 4. Write infrastructure.json
  const infraDir = path.join(projectDir, ".k8s-adapter");
  const infraPath = path.join(infraDir, "infrastructure.json");
  console.log("  → Writing .k8s-adapter/infrastructure.json");
  if (!dryRun) {
    mkdirSync(infraDir, { recursive: true });
    writeFileSync(
      infraPath,
      generateInfrastructureJson({
        projectId,
        region,
        hosts,
        gcsBucket: bucket,
        containerRegistry: registry,
        gatewayName: `${releaseName}-gateway`,
        routeExtensionName: `${releaseName}-route-ext`,
        releaseName,
      }),
    );
  }

  // 5. Print DNS authorization records needed for Certificate Manager
  if (!dryRun && hosts.length > 0) {
    console.log("\n  → Certificate Manager DNS Authorization");
    console.log("    Add these CNAME records to your DNS provider:\n");
    for (const host of hosts) {
      const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      const authName = `${releaseName}-dns-auth-${safeName}`;
      const dnsAuthResult = await execCapture("gcloud", [
        "certificate-manager",
        "dns-authorizations",
        "describe",
        authName,
        "--project",
        projectId,
        "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
      ]);
      if (dnsAuthResult.exitCode === 0 && dnsAuthResult.stdout.trim()) {
        const [name, type, data] = dnsAuthResult.stdout.trim().split("\t");
        console.log(`    ${name}  ${type}  ${data}`);
      } else {
        console.log(
          `    Run: gcloud certificate-manager dns-authorizations describe ${authName} --project ${projectId}`,
        );
      }
    }
  }

  console.log("\n✓ Init complete.");
  console.log("\nNext Steps:");
  console.log(
    "  1. Add the DNS CNAME records shown above (required for TLS certificate provisioning).",
  );
  console.log("  2. Run `npx adapter-k8s deploy` to build and deploy your application.");
  console.log(`  3. Configure your DNS A records for your hosts:`);
  console.log("     - Wait 5-10 minutes for the GCP Load Balancer to initialize.");
  console.log(
    `     - Run \`kubectl get gateway ${releaseName}-gateway\` to find your external IP address.`,
  );
  for (const h of hosts) {
    console.log(`     - Create a DNS A record for ${h} pointing to that IP.`);
  }
  console.log(`  4. Verify Certificate Status:`);
  console.log(
    `     - Run \`gcloud certificate-manager certificates describe ${releaseName}-cert --project ${projectId}\``,
  );
  console.log("     - Certificate provisioning requires DNS CNAME records to be in place.");
  console.log("\nHappy deploying!\n");
}
