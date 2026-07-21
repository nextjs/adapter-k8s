// src/cli/destroy.ts
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import { execCapture } from "./exec.js";
import { deployExtRoleId } from "./init.js";

export interface DestroyOptions {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
  /** Skip the interactive confirmation prompt (required for non-interactive use). */
  yes?: boolean;
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
    // The least-privilege custom role bound to the deploy SA (created by init) is
    // release-scoped — remove it with the rest of the release teardown.
    {
      desc: `custom IAM role "${deployExtRoleId(releaseName)}"`,
      args: [
        "iam",
        "roles",
        "delete",
        deployExtRoleId(releaseName),
        `--project=${projectId}`,
        "--quiet",
      ],
    },
  ];
}

function promptConfirmation(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function runDestroy(options: DestroyOptions): Promise<void> {
  const { projectDir, releaseName, dryRun, yes } = options;

  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;
  const projectId: string | undefined = infra?.projectId;
  const region: string | undefined = infra?.region;

  // L12: destroying is irreversible — gate it. --yes (or -y) skips the prompt and is
  // REQUIRED non-interactively; --dry-run never deletes and skips the gate entirely.
  if (!dryRun) {
    console.log(`\n  *** DESTRUCTIVE: tearing down release "${releaseName}" ***`);
    if (projectId) {
      console.log(`  *** Target GCP project: ${projectId} ***\n`);
      // Best-effort sanity check: warn loudly when the operator's active gcloud project
      // differs from the project this release was deployed to. gcloud failures are
      // tolerated (the deletes below all pass --project explicitly anyway).
      const cfg = await execCapture("gcloud", ["config", "get-value", "project", "--quiet"]).catch(
        () => null,
      );
      const activeProject = cfg && cfg.exitCode === 0 ? cfg.stdout.trim() : "";
      if (activeProject && activeProject !== projectId) {
        console.warn(
          `\n  !!! WARNING: your active gcloud project is "${activeProject}", but this ` +
            `release was deployed to "${projectId}".\n` +
            `      Deletion commands target "${projectId}" explicitly. Abort now if this ` +
            `is unexpected.\n`,
        );
      }
    } else {
      console.log("");
    }
    if (!yes) {
      if (!process.stdin.isTTY) {
        throw new Error(
          "Refusing to destroy without confirmation: stdin is not interactive. " +
            "Re-run with --yes (or -y) to confirm destruction, or use --dry-run to preview " +
            "the planned deletions.",
        );
      }
      const answer = await promptConfirmation(
        `  Type the release name ("${releaseName}") to confirm destruction: `,
      );
      if (answer.trim() !== releaseName) {
        throw new Error(
          `Destroy aborted: confirmation did not match "${releaseName}". No resources were deleted.`,
        );
      }
      console.log("");
    }
  } else {
    console.log(
      `\n[dry-run] Destroy plan for release "${releaseName}"` +
        `${projectId ? ` in GCP project "${projectId}"` : ""} — nothing will be deleted:\n`,
    );
  }

  // Resources that failed for a reason OTHER than "already gone". These make the
  // destroy incomplete and cause a non-zero exit + preserved local state.
  const failures: string[] = [];

  // 1. Helm uninstall
  if (dryRun) {
    console.log(`  [dry-run] helm uninstall ${releaseName}`);
  } else {
    console.log("  → Running helm uninstall...");
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
  }

  // 2. Clean up GCP resources from infrastructure.json
  if (infra) {
    // Delete GCS bucket
    if (infra.gcsBucket) {
      const bucketArgs = ["storage", "rm", "-r", `gs://${infra.gcsBucket}`, "--quiet"];
      if (dryRun) {
        console.log(`  [dry-run] gcloud ${bucketArgs.join(" ")}`);
      } else {
        console.log(`  → Deleting GCS bucket: ${infra.gcsBucket}`);
        const res = await execCapture("gcloud", bucketArgs);
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
    if (projectId) {
      const saEmail = `${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`;
      const saArgs = [
        "iam",
        "service-accounts",
        "delete",
        saEmail,
        "--project",
        projectId,
        "--quiet",
      ];
      if (dryRun) {
        console.log(`  [dry-run] gcloud ${saArgs.join(" ")}`);
      } else {
        console.log(`  → Deleting deploy service account`);
        const res = await execCapture("gcloud", saArgs);
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

    // Delete the release-scoped ext_proc resources (in dependency order: the traffic
    // extension references the backend, which references the health check). helm uninstall
    // removed the Gateway/Service, but these are provisioned outside the chart and would
    // otherwise be left billing/dangling — the exact "destroy silently leaves infra" gap.
    if (projectId) {
      // The managed cache may live in a different region than the cluster when
      // cache.memorystore.region overrides it — deploy persists that as infra.cacheRegion. Use it
      // so destroy deletes the instance where it actually is, not the cluster region.
      const extResources = buildReleaseScopedGcpResources(
        releaseName,
        projectId,
        infra?.cacheRegion ?? infra?.region,
      );
      for (const { desc, args } of extResources) {
        if (dryRun) {
          console.log(`  [dry-run] gcloud ${args.join(" ")}`);
        } else {
          console.log(`  → Deleting ${desc}`);
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

  if (dryRun) {
    console.log(
      `\n[dry-run] No resources were deleted. Re-run without --dry-run (and with --yes ` +
        `if non-interactive) to execute the plan above.\n`,
    );
    return;
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
  console.log("\n✓ Removed: Helm release, GCS bucket, deploy service account, and the");
  console.log("  release-scoped ext_proc resources (traffic extension, routing backend,");
  console.log("  health check, static IP, custom IAM role).\n");
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
