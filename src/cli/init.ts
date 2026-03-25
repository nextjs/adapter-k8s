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
  host: string;
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
}): GcloudCommand[] {
  const { projectId, region, bucket, releaseName } = options;
  const commands: GcloudCommand[] = [];

  // 0. Enable required APIs
  commands.push({
    description: "Enable Required APIs (Artifact Registry, GKE, Service Extensions)",
    command: "gcloud",
    args: [
      "services",
      "enable",
      "artifactregistry.googleapis.com",
      "container.googleapis.com",
      "networkservices.googleapis.com",
      "compute.googleapis.com",
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

  // 0.2 Create Artifact Registry repository
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

  return commands;
}

export async function runInit(options: InitOptions): Promise<void> {
  const {
    projectId,
    region,
    host,
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
      host,
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
        host,
        gcsBucket: bucket,
        containerRegistry: registry,
        gatewayName: `${releaseName}-gateway`,
        routeExtensionName: `${releaseName}-route-ext`,
      }),
    );
  }

  console.log("\n✓ Init complete.");
  console.log("\nNext Steps:");
  console.log("  1. Run `npx adapter-k8s deploy` to build and deploy your application.");
  console.log(`  2. Configure your DNS for ${host}:`);
  console.log("     - Wait 5-10 minutes for the GCP Load Balancer to initialize.");
  console.log(`     - Run \`kubectl get gateway ${releaseName}-gateway\` to find your external IP address.`);
  console.log(`     - Create a DNS A record for ${host} pointing to that IP.`);
  console.log("\nHappy deploying!\n");
}
