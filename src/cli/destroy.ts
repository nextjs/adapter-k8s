// src/cli/destroy.ts
import path from "node:path";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { execCapture } from "./exec.js";

export interface DestroyOptions {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
}

// Distinguish "the resource is already gone" (idempotent success) from genuine
// failures (auth, permission, network). Only the former should be treated as
// already-deleted; the latter must be surfaced so destroy doesn't silently succeed.
export function isAlreadyGoneError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("notfound") ||
    s.includes("not found") ||
    s.includes("does not exist") ||
    s.includes("was not found") ||
    s.includes("release: not found") ||
    s.includes("no such") ||
    s.includes("404")
  );
}

export async function runDestroy(options: DestroyOptions): Promise<void> {
  const { projectDir, releaseName, dryRun } = options;

  console.log(`\nDestroying deployment: ${releaseName}\n`);

  // Resources that failed for a reason OTHER than "already gone". These make the
  // destroy incomplete and cause a non-zero exit + preserved local state.
  const failures: string[] = [];

  // 1. Helm uninstall
  console.log("  → Running helm uninstall...");
  if (!dryRun) {
    const res = await execCapture("helm", ["uninstall", releaseName]);
    if (res.exitCode !== 0) {
      if (isAlreadyGoneError(res.stderr)) {
        console.log("    (release not found or already uninstalled)");
      } else {
        console.warn(
          `    WARNING: helm uninstall failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
        );
        failures.push(`helm release "${releaseName}"`);
      }
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
        const res = await execCapture("gcloud", [
          "storage",
          "rm",
          "-r",
          `gs://${infra.gcsBucket}`,
          "--quiet",
        ]);
        if (res.exitCode !== 0) {
          if (isAlreadyGoneError(res.stderr)) {
            console.log("    (bucket not found or already deleted)");
          } else {
            console.warn(
              `    WARNING: bucket deletion failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
            );
            failures.push(`GCS bucket "${infra.gcsBucket}"`);
          }
        }
      }
    }

    // Delete service account
    console.log(`  → Deleting deploy service account`);
    if (!dryRun) {
      const saEmail = `${releaseName}-deploy@${infra.projectId}.iam.gserviceaccount.com`;
      const res = await execCapture("gcloud", [
        "iam",
        "service-accounts",
        "delete",
        saEmail,
        "--project",
        infra.projectId,
        "--quiet",
      ]);
      if (res.exitCode !== 0) {
        if (isAlreadyGoneError(res.stderr)) {
          console.log("    (service account not found or already deleted)");
        } else {
          console.warn(
            `    WARNING: service account deletion failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
          );
          failures.push(`service account "${saEmail}"`);
        }
      }
    }
  }

  // 3. Report incomplete destroy before touching local state. If real (non-"already
  // gone") failures occurred, keep .k8s-adapter so infrastructure.json is available
  // to retry, and exit non-zero.
  if (failures.length > 0) {
    console.error(`\n✗ Destroy incomplete. These resources could not be removed:`);
    for (const f of failures) console.error(`    - ${f}`);
    console.error(
      `  These failed for reasons other than "already deleted" (e.g. auth, permission, network).`,
    );
    console.error(
      `  Local .k8s-adapter state was preserved. Resolve the errors above and re-run destroy.\n`,
    );
    process.exit(1);
  }

  // 4. Clean up local state (only when every resource was fully removed)
  const stateDir = path.join(projectDir, ".k8s-adapter");
  if (existsSync(stateDir) && !dryRun) {
    console.log("  → Removing .k8s-adapter directory");
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log("\n✓ Destroy complete\n");
}
