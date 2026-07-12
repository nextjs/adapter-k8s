// src/cli/destroy.ts
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
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

export function buildReleaseScopedGcpResources(
  releaseName: string,
  projectId: string,
  region?: string,
): { desc: string; args: string[] }[] {
  return [
    // Managed cache (Memorystore) is release-scoped and ephemeral — remove it. No-ops when the
    // instance was never provisioned (BYO cache) or is already gone. Requires the region.
    ...(region
      ? [
          {
            desc: `Memorystore instance "${releaseName}-cache"`,
            args: [
              "redis",
              "instances",
              "delete",
              `${releaseName}-cache`,
              `--region=${region}`,
              `--project=${projectId}`,
              "--quiet",
            ],
          },
        ]
      : []),
    {
      desc: `traffic extension "${releaseName}-traffic-ext"`,
      args: [
        "service-extensions",
        "lb-traffic-extensions",
        "delete",
        `${releaseName}-traffic-ext`,
        "--location=global",
        `--project=${projectId}`,
        "--quiet",
      ],
    },
    {
      desc: `routing backend service "${releaseName}-routing-service"`,
      args: [
        "compute",
        "backend-services",
        "delete",
        `${releaseName}-routing-service`,
        "--global",
        `--project=${projectId}`,
        "--quiet",
      ],
    },
    {
      desc: `routing health check "${releaseName}-routing-hc"`,
      args: [
        "compute",
        "health-checks",
        "delete",
        `${releaseName}-routing-hc`,
        "--global",
        `--project=${projectId}`,
        "--quiet",
      ],
    },
    {
      desc: `static IP "${releaseName}-ip"`,
      args: [
        "compute",
        "addresses",
        "delete",
        `${releaseName}-ip`,
        "--global",
        `--project=${projectId}`,
        "--quiet",
      ],
    },
  ];
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

    // Delete the release-scoped ext_proc resources (in dependency order: the traffic
    // extension references the backend, which references the health check). helm uninstall
    // removed the Gateway/Service, but these are provisioned outside the chart and would
    // otherwise be left billing/dangling — the exact "destroy silently leaves infra" gap.
    const projectId: string | undefined = infra.projectId;
    if (projectId) {
      const extResources = buildReleaseScopedGcpResources(releaseName, projectId, infra?.region);
      for (const { desc, args } of extResources) {
        console.log(`  → Deleting ${desc}`);
        if (!dryRun) {
          const res = await execCapture("gcloud", args);
          if (res.exitCode !== 0) {
            if (isAlreadyGoneError(res.stderr)) {
              console.log("    (not found or already deleted)");
            } else {
              console.warn(
                `    WARNING: deletion failed: ${res.stderr.trim() || `exit ${res.exitCode}`}`,
              );
              failures.push(desc);
            }
          }
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

  // 4. Report honestly what was removed vs what remains. destroy deliberately does NOT
  // auto-delete the GKE cluster or Artifact Registry: both are commonly SHARED across
  // releases and expensive/slow to recreate, so nuking them from a per-release `destroy` is
  // unsafe. Surface them with exact commands instead of silently leaving them AND deleting
  // the state needed to find them (the previous behavior).
  const infra = existsSync(path.join(projectDir, ".k8s-adapter", "infrastructure.json"))
    ? JSON.parse(
        readFileSync(path.join(projectDir, ".k8s-adapter", "infrastructure.json"), "utf-8"),
      )
    : {};
  const projectId: string | undefined = infra.projectId;
  const region: string | undefined = infra.region;
  console.log("\n✓ Removed: Helm release, GCS bucket, deploy service account, and the");
  console.log("  release-scoped ext_proc resources (traffic extension, routing backend,");
  console.log("  health check, static IP).\n");
  if (projectId) {
    console.log("  Left in place (shared / expensive — remove manually if truly unused):");
    console.log(
      `    • GKE cluster:        gcloud container clusters delete ${releaseName}-cluster --region ${region ?? "REGION"} --project ${projectId}`,
    );
    console.log(
      `    • Artifact Registry:  gcloud artifacts repositories delete nextjs --location ${region ?? "REGION"} --project ${projectId}`,
    );
    console.log(`    • TLS/DNS (Certificate Manager): certificate map, certificate, and DNS`);
    console.log(
      `      authorizations named "${releaseName}-*" — list: gcloud certificate-manager maps list --project ${projectId}`,
    );
  }
  // Preserve .k8s-adapter/infrastructure.json: it names the resources left above, so the
  // manual commands and any retry stay possible. (Previously this was deleted, orphaning them.)
  console.log(
    `\n  Local state (.k8s-adapter) preserved so the resources above remain discoverable.\n`,
  );
}
