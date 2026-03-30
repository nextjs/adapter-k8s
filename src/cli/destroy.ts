// src/cli/destroy.ts
import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execOrThrow } from "./exec.js";

export interface DestroyOptions {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
}

export async function runDestroy(options: DestroyOptions): Promise<void> {
  const { projectDir, releaseName, dryRun } = options;

  console.log(`\nDestroying deployment: ${releaseName}\n`);

  // 1. Helm uninstall
  console.log("  → Running helm uninstall...");
  if (!dryRun) {
    try {
      await execOrThrow("helm", ["uninstall", releaseName]);
    } catch {
      console.log("    (release not found or already uninstalled)");
    }
  } else {
    console.log(`    [dry-run] helm uninstall ${releaseName}`);
  }

  // 2. Clean up GCP resources from infrastructure.json
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  if (existsSync(infraPath)) {
    const infra = JSON.parse(readFileSync(infraPath, "utf-8"));

    // Delete GCS bucket
    if (infra.gcsBucket) {
      console.log(`  → Deleting GCS bucket: ${infra.gcsBucket}`);
      if (!dryRun) {
        try {
          await execOrThrow("gcloud", [
            "storage",
            "rm",
            "-r",
            `gs://${infra.gcsBucket}`,
            "--quiet",
          ]);
        } catch {
          console.log("    (bucket not found or already deleted)");
        }
      }
    }

    // Delete service account
    console.log(`  → Deleting deploy service account`);
    if (!dryRun) {
      try {
        await execOrThrow("gcloud", [
          "iam",
          "service-accounts",
          "delete",
          `${releaseName}-deploy@${infra.projectId}.iam.gserviceaccount.com`,
          "--project",
          infra.projectId,
          "--quiet",
        ]);
      } catch {
        console.log("    (service account not found or already deleted)");
      }
    }
  }

  // 3. Clean up local state
  const stateDir = path.join(projectDir, ".k8s-adapter");
  if (existsSync(stateDir) && !dryRun) {
    console.log("  → Removing .k8s-adapter directory");
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log("\n✓ Destroy complete\n");
}
