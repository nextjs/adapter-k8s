// src/cli/destroy.ts
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import { execCapture } from "./exec.js";
import { cliServiceAccountEmail, deployExtRoleId, deployServiceAccountEmail } from "./init.js";
import { sanitizeForTerminal } from "./terminal.js";
import { INTERNAL_SECRET_COMPONENT } from "../emit/templates/internal-secret.js";
import { K8S_NAMESPACE } from "../emit/templates/utils.js";
import { assertSafeInfrastructure, infrastructurePath } from "./infrastructure-validation.js";

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
// N28: the positive needles are substrings, so they also matched failures that merely
// CONTAIN them — `error dialing backend: 404 page not found ("no such host")` is a
// connectivity failure, not a deletion, and deploy used this predicate to decide "nothing is
// serving from the previous build" (then scaled a build serving N≫2 down to 2 mid-deploy).
// Any auth/connectivity/quota marker now vetoes "gone", and the bare "404"/"no such" needles
// are removed: a naked 404 with no other evidence is not proof of absence. Callers that CAN
// key on a machine-readable signal must do so instead — deploy's retained-manifest probe now
// uses `--ignore-not-found` (exit 0 + empty stdout).
const NOT_GONE_MARKERS = [
  "permission",
  "forbidden",
  "unauthorized",
  "unauthenticated",
  "credential",
  "invalid_grant",
  "dial tcp",
  "no such host",
  "connection refused",
  "unable to connect",
  "i/o timeout",
  "timed out",
  "quota",
  "rate limit",
  "service unavailable",
];

export function isAlreadyGoneError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  if (NOT_GONE_MARKERS.some((m) => s.includes(m))) return false;
  return (
    s.includes("notfound") ||
    s.includes("not_found") ||
    s.includes("not found") ||
    s.includes("does not exist") ||
    s.includes("was not found") ||
    s.includes("release: not found")
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

  const infraPath = infrastructurePath(projectDir);
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;
  // S13: validate before any of these reach a gcloud/kubectl argv.
  assertSafeInfrastructure(infra);
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

  // Pin kubectl at THIS release's cluster before any cluster mutation — helm uninstall
  // and the state-ConfigMap delete otherwise run against whatever context happens to be
  // current, and destroying the wrong cluster's release is unrecoverable. Every other
  // command (deploy/rollback/doctor) already does this; destroy historically did not.
  // Dry-run must not mutate the operator's kubeconfig (L13).
  if (!dryRun && projectId && region) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`  → Connecting to GKE cluster "${clusterName}"...`);
    const cred = await execCapture("gcloud", [
      "container",
      "clusters",
      "get-credentials",
      clusterName,
      "--region",
      region,
      "--project",
      projectId,
      "--quiet",
    ]);
    if (cred.exitCode !== 0) {
      throw new Error(
        `Failed to connect to cluster "${clusterName}" — aborting destroy before any ` +
          `deletion: ${sanitizeForTerminal(cred.stderr.trim()) || `exit ${cred.exitCode}`}`,
      );
    }
  } else if (dryRun) {
    if (projectId && region) {
      console.log(
        `  [dry-run] Skipping "gcloud container clusters get-credentials" (it would mutate your kubeconfig).`,
      );
    } else {
      console.log(
        `  [dry-run] infrastructure.json is missing projectId/region — kubectl context ` +
          `pinning is impossible. A real destroy would target whatever kubectl context is ` +
          `current (and ask you to confirm it).`,
      );
    }
  } else {
    // C1: context pinning is IMPOSSIBLE (infrastructure.json missing, or missing
    // projectId/region), so the cluster-side teardown below (helm uninstall, state
    // ConfigMaps) would run against whatever kubectl context happens to be current —
    // the exact wrong-cluster failure the pinning above was added to close. Surface
    // the current context loudly and require explicit confirmation (--yes skips it,
    // same as the destruction gate).
    const ctx = await execCapture("kubectl", ["config", "current-context"]).catch(() => null);
    // L14: the context name is kubeconfig-sourced — strip terminal control chars.
    const currentContext = ctx && ctx.exitCode === 0 ? sanitizeForTerminal(ctx.stdout.trim()) : "";
    console.warn(
      `\n  !!! WARNING: infrastructure.json is missing projectId/region, so kubectl could ` +
        `NOT be pinned to this release's cluster.\n` +
        `      The cluster-side teardown (helm uninstall, adapter ConfigMaps) will run ` +
        `against your CURRENT kubectl context:\n` +
        `      ${currentContext || "(no current context / kubectl unavailable)"}\n`,
    );
    if (!yes) {
      if (!process.stdin.isTTY) {
        throw new Error(
          "Refusing to destroy against an unpinned kubectl context non-interactively. " +
            "Re-run with --yes (or -y) only if the context above is the intended cluster, " +
            "or restore projectId/region in .k8s-adapter/infrastructure.json so the " +
            "context can be pinned.",
        );
      }
      const answer = await promptConfirmation(
        `  Type "yes" to confirm this kubectl context is the intended cluster: `,
      );
      if (answer.trim() !== "yes") {
        throw new Error(
          "Destroy aborted: the current kubectl context was not confirmed as the " +
            "intended cluster. No resources were deleted.",
        );
      }
      console.log("");
    }
  }

  // 1. Helm uninstall. The release lives in the "default" namespace — the same one init
  // binds Workload Identity to — so pin it instead of trusting the context's namespace.
  if (dryRun) {
    console.log(`  [dry-run] helm uninstall ${releaseName} --namespace default`);
  } else {
    console.log("  → Running helm uninstall...");
    const res = await execCapture("helm", ["uninstall", releaseName, "--namespace", "default"]);
    if (res.exitCode !== 0) {
      if (isAlreadyGoneError(res.stderr)) {
        console.log("    (release not found or already uninstalled)");
      } else {
        console.warn(
          `    WARNING: helm uninstall failed: ${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}`,
        );
        failures.push(`helm release "${releaseName}"`);
      }
    }
  }

  // 1b. Delete the adapter-written ConfigMaps helm doesn't own: the deploy-state
  // ConfigMap (state.ts writes it via kubectl apply) and any retained routing-manifest
  // snapshot ConfigMaps (rollback/deploy retention). A stale state ConfigMap otherwise
  // survives destroy and resurrects the destroyed build as "previous" on the next
  // deploy of this release name. Best-effort: warn, don't fail the destroy.
  const cmDeleteArgs = [
    "delete",
    "configmap",
    "-n",
    "default",
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/managed-by=adapter-k8s`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${cmDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", cmDeleteArgs);
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete adapter state ConfigMaps: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}. Delete them manually ` +
          `(kubectl delete configmap -n default -l app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/managed-by=adapter-k8s) or the next deploy may see stale state.`,
      );
    }
  }

  // 1c. Delete the per-build internal-dispatch Secrets (N87). These carry
  // `helm.sh/resource-policy: keep` ON PURPOSE — a build's secret must outlive the upgrade that
  // renders the next build's one, or the retained rollback target's pods cannot start — which
  // means `helm uninstall` deliberately does NOT remove them. So destroy has to, and the
  // ConfigMap sweep above does not cover them: different kind, and these carry
  // `managed-by: Helm` (helm owns them) rather than the adapter's own managed-by label, so they
  // are selected by component instead. Without this, a destroyed release leaves its dispatch
  // secrets in the namespace indefinitely.
  const secretDeleteArgs = [
    "delete",
    "secret",
    "-n",
    K8S_NAMESPACE,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${secretDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", secretDeleteArgs);
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete the internal-dispatch Secrets: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}. Delete them ` +
          `manually (kubectl delete secret -n ${K8S_NAMESPACE} -l ` +
          `app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}); they are retained by ` +
          `resource-policy and helm uninstall will not remove them.`,
      );
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
              `    WARNING: bucket deletion failed: ${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}`,
            );
            failures.push(`GCS bucket "${infra.gcsBucket}"`);
          }
        }
      }
    }

    // Delete the service accounts. S6: init creates TWO — the Workload-Identity-bound
    // `<release>-deploy` (the route-extension Job) and `<release>-cli`, which holds the bucket
    // objectAdmin and Artifact Registry writer grants and is bound to nothing in the cluster.
    // BOTH are release-scoped, so both go here: leaving `<release>-cli` behind would leave a
    // live identity with write access to a bucket and a registry for a release that no longer
    // exists, which is the "destroy silently leaves infra" gap in its most sensitive form.
    if (projectId) {
      for (const { label, saEmail } of [
        { label: "deploy", saEmail: deployServiceAccountEmail(releaseName, projectId) },
        { label: "CLI", saEmail: cliServiceAccountEmail(releaseName, projectId) },
      ]) {
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
          continue;
        }
        console.log(`  → Deleting ${label} service account`);
        const res = await execCapture("gcloud", saArgs);
        if (res.exitCode !== 0) {
          if (isAlreadyGoneError(res.stderr)) {
            // The normal case for `<release>-cli` on a release inited before the S6 split.
            console.log("    (service account not found or already deleted)");
          } else {
            console.warn(
              `    WARNING: service account deletion failed: ${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}`,
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
                `    WARNING: deletion failed: ${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}`,
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
  console.log("\n✓ Removed: Helm release, GCS bucket, both service accounts, and the");
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
