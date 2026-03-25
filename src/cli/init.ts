// src/cli/init.ts
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./exec.js";
import {
  generateAdapterConfig,
  generateInfrastructureJson,
} from "./scaffold.js";

export interface InitOptions {
  projectId: string;
  region: string;
  hosts: string[];
  bucket: string;
  registry: string;
  releaseName: string;
  projectDir: string;
  dryRun?: boolean;
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
      "--quiet",
    ],
  });

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
          "certificate-manager", "dns-authorizations", "create",
          `${releaseName}-dns-auth-${safeName}`,
          "--domain", host,
          "--project", projectId,
          "--quiet",
        ],
      });
    }

    // Create Google-managed certificate covering all hosts
    const dnsAuthRefs = hosts.map(host => {
      const safeName = host.replace(/[^a-z0-9]/g, "-").replace(/^-+|-+$/g, "");
      return `${releaseName}-dns-auth-${safeName}`;
    });
    commands.push({
      description: "Create Google-managed certificate",
      command: "gcloud",
      args: [
        "certificate-manager", "certificates", "create",
        `${releaseName}-cert`,
        "--domains", hosts.join(","),
        "--dns-authorizations", dnsAuthRefs.join(","),
        "--project", projectId,
        "--quiet",
      ],
    });

    // Create certificate map
    commands.push({
      description: "Create certificate map",
      command: "gcloud",
      args: [
        "certificate-manager", "maps", "create",
        `${releaseName}-certmap`,
        "--project", projectId,
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
          "certificate-manager", "maps", "entries", "create",
          `${releaseName}-certmap-entry-${safeName}`,
          "--map", `${releaseName}-certmap`,
          "--certificates", `${releaseName}-cert`,
          "--hostname", host,
          "--project", projectId,
          "--quiet",
        ],
      });
    }
  }

  return commands;
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
  } = options;

  console.log(
    `\nInitializing @next-community/adapter-k8s for project: ${projectId}\n`,
  );

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

      if (isAlreadyExists) {
        console.log(`    (already exists — skipping)`);
      } else if (cmd.description.includes("Grant storage admin")) {
        // Retry once for IAM binding as it sometimes fails right after bucket creation
        console.log(`    (retrying...)`);
        await new Promise((r) => setTimeout(r, 2000));
        result = await execCapture(cmd.command, cmd.args);
        if (result.exitCode !== 0) {
          throw new Error(`${cmd.description} failed:\n${result.stderr}`);
        }
      } else {
        throw new Error(`${cmd.description} failed:\n${result.stderr}`);
      }
    }
  }

  // 3. Scaffold adapter.config.ts (if not exists)
  const configPath = path.join(projectDir, "adapter.config.ts");
  if (!existsSync(configPath)) {
    console.log("\n  → Scaffolding adapter.config.ts");
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
      console.log("    [dry-run] Would write adapter.config.ts");
    }
  } else {
    console.log("\n  → adapter.config.ts already exists — skipping");
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
        "certificate-manager", "dns-authorizations", "describe", authName,
        "--project", projectId, "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
      ]);
      if (dnsAuthResult.exitCode === 0 && dnsAuthResult.stdout.trim()) {
        const [name, type, data] = dnsAuthResult.stdout.trim().split("\t");
        console.log(`    ${name}  ${type}  ${data}`);
      } else {
        console.log(`    Run: gcloud certificate-manager dns-authorizations describe ${authName} --project ${projectId}`);
      }
    }
  }

  console.log("\n✓ Init complete.");
  console.log("\nNext Steps:");
  console.log("  1. Add the DNS CNAME records shown above (required for TLS certificate provisioning).");
  console.log("  2. Run `npx adapter-k8s deploy` to build and deploy your application.");
  console.log(`  3. Configure your DNS A records for your hosts:`);
  console.log("     - Wait 5-10 minutes for the GCP Load Balancer to initialize.");
  console.log(`     - Run \`kubectl get gateway ${releaseName}-gateway\` to find your external IP address.`);
  for (const h of hosts) {
    console.log(`     - Create a DNS A record for ${h} pointing to that IP.`);
  }
  console.log(`  4. Verify Certificate Status:`);
  console.log(`     - Run \`gcloud certificate-manager certificates describe ${releaseName}-cert --project ${projectId}\``);
  console.log("     - Certificate provisioning requires DNS CNAME records to be in place.");
  console.log("\nHappy deploying!\n");
}
