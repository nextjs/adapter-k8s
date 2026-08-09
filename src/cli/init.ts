// src/cli/init.ts
import { existsSync, writeFileSync, appendFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execCapture, EXEC_TIMEOUTS } from "./exec.js";
import { generateAdapterConfig, generateInfrastructureJson } from "./scaffold.js";
import { gkeVersionAtLeast, MIN_GKE_VERSION_FOR_CDN } from "./gke-version.js";
import { sanitizeForTerminal } from "./terminal.js";
import { infrastructureWritePath } from "./infrastructure-validation.js";
import {
  assertSafeBucketName,
  assertSafeHostname,
  assertSafeImageRegistry,
  assertSafeProjectId,
  assertSafeRegion,
  resolveK8sNamespace,
} from "../emit/templates/utils.js";

export interface InitOptions {
  projectId: string;
  region: string;
  hosts: string[];
  bucket: string;
  registry: string;
  releaseName: string;
  namespace?: string;
  projectDir: string;
  dryRun?: boolean;
  /** Backoff between IAM-binding retries (ms). Defaults to 5000; tests override to run fast. */
  iamRetryDelayMs?: number;
  /**
   * Cluster mode. Defaults to Autopilot (always enforces NetworkPolicy). Standard
   * clusters are created with --enable-network-policy, which Autopilot rejects.
   */
  autopilot?: boolean;
}

export interface GcloudCommand {
  description: string;
  command: string;
  args: string[];
}

// M9: least-privilege stand-in for the project-level roles/networkservices.admin and
// roles/compute.loadBalancerAdmin grants. Covers exactly the gcloud calls made by the
// traffic-extension update Job (src/emit/templates/route-ext-update-job.ts).
export const DEPLOY_EXT_ROLE_PERMISSIONS = [
  "compute.addresses.get",
  "compute.forwardingRules.list",
  "compute.networkEndpointGroups.list",
  "compute.backendServices.get",
  "compute.backendServices.update",
  "networkservices.lbTrafficExtensions.create",
  "networkservices.lbTrafficExtensions.update",
  "networkservices.lbTrafficExtensions.get",
] as const;

// GCP custom role IDs forbid hyphens (^[a-zA-Z0-9_]{3,64}$), so derive the id from the
// release name with `-` → `_`. The 18-char prefix + 40-char release cap fits the 64-char
// limit; slice defensively anyway.
export function deployExtRoleId(releaseName: string): string {
  return `nextjs_deploy_ext_${releaseName.replace(/-/g, "_")}`.slice(0, 64);
}

/**
 * S6 (SECURITY). TWO identities, deliberately.
 *
 * `<release>-deploy` is the WORKLOAD-IDENTITY-BOUND one: `<release>-deploy-sa` in the
 * cluster namespace maps to it (emit/templates/deploy-service-account.ts), so anyone who can
 * create a Pod in that namespace can assume it — that is the open residual from the security
 * review. Its ONLY in-cluster consumer is the route-extension update Job, whose required
 * permissions are exactly DEPLOY_EXT_ROLE_PERMISSIONS. So it now holds nothing else.
 *
 * `<release>-cli` is for the work the CLI does under its OWN credentials — uploading static
 * assets to the bucket and pushing images to Artifact Registry. It is NOT bound to any
 * Kubernetes ServiceAccount, so no Pod can assume it, which is the whole point of the split:
 * bucket object-admin and registry-writer used to sit on the impersonable identity next to
 * `roles/iam.workloadIdentityUser`, so pod-creation in the namespace conferred write access to
 * both (and, with the mutable image tags of the day, a path to dispatch-secret theft — see the
 * repoAdmin note below).
 *
 * The WI-bound identity keeps its name so an existing release keeps working untouched: the
 * KSA annotation, `destroy`'s SA deletion and any existing binding all still resolve. The
 * split is expressed by MOVING the two grants to the new identity and revoking them from the
 * old one, which is also what makes a re-run of `init` over an existing release converge.
 */
export function deployServiceAccountEmail(releaseName: string, projectId: string): string {
  return `${releaseName}-deploy@${projectId}.iam.gserviceaccount.com`;
}

/** The CLI-only identity (bucket + registry writes). Never Workload-Identity-bound. */
export function cliServiceAccountEmail(releaseName: string, projectId: string): string {
  return `${releaseName}-cli@${projectId}.iam.gserviceaccount.com`;
}

export function buildInitGcloudCommands(options: {
  projectId: string;
  region: string;
  bucket: string;
  releaseName: string;
  namespace?: string;
  hosts?: string[];
  autopilot?: boolean;
}): GcloudCommand[] {
  const { projectId, region, bucket, releaseName, hosts = [], autopilot = true } = options;
  const namespace = resolveK8sNamespace(options.namespace);
  const commands: GcloudCommand[] = [];
  // S6: the impersonable Job identity and the CLI-only one. See the doc comments above —
  // every grant below is deliberate about WHICH of the two it lands on.
  const deploySa = deployServiceAccountEmail(releaseName, projectId);
  const cliSa = cliServiceAccountEmail(releaseName, projectId);

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

  // 0.1 Create the GKE cluster. Autopilot always enforces NetworkPolicy and REJECTS
  // --enable-network-policy, so only pass it for Standard clusters.
  if (autopilot) {
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
  } else {
    commands.push({
      description: "Create GKE Standard cluster (NetworkPolicy enforced)",
      command: "gcloud",
      args: [
        "container",
        "clusters",
        "create",
        `${releaseName}-cluster`,
        "--location",
        region,
        "--project",
        projectId,
        "--enable-network-policy",
        "--quiet",
      ],
    });
  }

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

  // 2. Create the Workload-Identity-bound deploy service account (the route-extension Job).
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

  // 2b. S6 (SECURITY). Create the CLI-only identity that carries the storage/registry writes.
  // Separate from the deploy SA because that one is assumable by any Pod in the release's
  // namespace (Workload Identity); this one is bound to nothing in the cluster.
  commands.push({
    description: "Create CLI service account (bucket + registry writes, no Workload Identity)",
    command: "gcloud",
    args: [
      "iam",
      "service-accounts",
      "create",
      `${releaseName}-cli`,
      "--project",
      projectId,
      "--display-name",
      `${releaseName} adapter CLI SA (asset upload + image push)`,
      "--quiet",
    ],
  });

  // 3. Grant storage admin on bucket — to the CLI SA (S6: the CLI uploads static assets; the
  // in-cluster Job has no business writing to the bucket).
  commands.push({
    description: "Grant storage admin on bucket (CLI SA)",
    command: "gcloud",
    args: [
      "storage",
      "buckets",
      "add-iam-policy-binding",
      `gs://${bucket}`,
      "--member",
      `serviceAccount:${cliSa}`,
      "--role",
      "roles/storage.objectAdmin",
      "--condition=None",
      "--quiet",
    ],
  });

  // 4. Grant Artifact Registry writer on the repository only (M9: least privilege —
  // pushing images must not require project-wide writer), to the CLI SA (S6: `docker push`
  // is a CLI operation; the Job never pushes an image).
  commands.push({
    description: "Grant Artifact Registry writer on nextjs repository (CLI SA)",
    command: "gcloud",
    args: [
      "artifacts",
      "repositories",
      "add-iam-policy-binding",
      "nextjs",
      "--location",
      region,
      "--member",
      `serviceAccount:${cliSa}`,
      "--role",
      "roles/artifactregistry.writer",
      "--project",
      projectId,
      "--condition=None",
      "--quiet",
    ],
  });

  // 4b. S6 (SECURITY). Revoke the same two grants from the WORKLOAD-IDENTITY-BOUND deploy SA,
  // which is where they used to live. Without this the split is cosmetic on every release that
  // already exists: `init` is idempotent and re-run routinely, and the old bindings would
  // simply persist alongside the new ones — leaving pod-creation in the namespace equal to
  // bucket + registry write, exactly the residual this removes.
  //
  // Ordered AFTER the grants above so a failed grant (fatal) can never leave the release with
  // neither identity holding the permission. Absent bindings are the NORMAL case on a fresh
  // init and are skipped, not failed (see the remove-iam-policy-binding branch in runInit) —
  // that is what makes a re-run converge instead of erroring.
  commands.push({
    description: "Revoke bucket object-admin from the deploy SA (moved to the CLI SA)",
    command: "gcloud",
    args: [
      "storage",
      "buckets",
      "remove-iam-policy-binding",
      `gs://${bucket}`,
      "--member",
      `serviceAccount:${deploySa}`,
      "--role",
      "roles/storage.objectAdmin",
      "--condition=None",
      "--quiet",
    ],
  });
  commands.push({
    description: "Revoke Artifact Registry writer from the deploy SA (moved to the CLI SA)",
    command: "gcloud",
    args: [
      "artifacts",
      "repositories",
      "remove-iam-policy-binding",
      "nextjs",
      "--location",
      region,
      "--member",
      `serviceAccount:${deploySa}`,
      "--role",
      "roles/artifactregistry.writer",
      "--project",
      projectId,
      "--condition=None",
      "--quiet",
    ],
  });

  // 5. S6/S27 (SECURITY). `roles/artifactregistry.repoAdmin` USED TO BE GRANTED HERE and has
  // been removed. The CLI only ever pushes images, which `roles/artifactregistry.writer`
  // (granted above) already covers; repoAdmin additionally allows deleting and RETAGGING
  // artifacts. That matters because this SA is impersonable by anyone who can create a Pod in
  // the namespace (Workload Identity binding below), images are deployed by mutable tag, and
  // the pods hold INTERNAL_HEADER_SECRET — so retag rights turned pod-creation into
  // dispatch-secret theft on the next restart. Do not reinstate it: if a future command needs
  // to delete artifacts, grant it for that command, scoped to the repo, not to the workload
  // identity.

  // --- Deploy Service Account (Workload Identity for Helm hook Jobs) ---
  // M9: the route-ext update Job gets a release-scoped CUSTOM role (created/updated
  // imperatively in runInit before these commands run) bound at project level, instead
  // of the broad networkservices.admin + compute.loadBalancerAdmin roles it used to
  // receive. compute.viewer remains for generic read-only diagnostics.
  commands.push({
    description: "Grant deploy SA release-scoped traffic-extension role",
    command: "gcloud",
    args: [
      "projects",
      "add-iam-policy-binding",
      projectId,
      "--member",
      `serviceAccount:${deploySa}`,
      "--role",
      `projects/${projectId}/roles/${deployExtRoleId(releaseName)}`,
      "--condition=None",
      "--quiet",
    ],
  });

  // S6/S27 (SECURITY). The project-wide `roles/compute.viewer` grant that used to sit here has
  // been removed. Its stated purpose — forwarding-rule discovery — is already covered by the
  // release-scoped custom role's own `compute.forwardingRules.list`; what the broad role added
  // was project-wide get/list on EVERY compute resource, which is pure reconnaissance value for
  // anyone who impersonates this SA through the Workload Identity binding below.

  // Allow the K8s SA to impersonate the GCP deploy SA via Workload Identity.
  // S6: this binding is why the deploy SA must stay minimal — it is what makes the identity
  // assumable from inside the cluster. The CLI SA above deliberately gets NO such binding, so
  // the storage/registry permissions it now holds are not reachable from a Pod.
  commands.push({
    description: "Bind K8s SA to GCP SA via Workload Identity",
    command: "gcloud",
    args: [
      "iam",
      "service-accounts",
      "add-iam-policy-binding",
      deploySa,
      "--role",
      "roles/iam.workloadIdentityUser",
      "--member",
      `serviceAccount:${projectId}.svc.id.goog[${namespace}/${releaseName}-deploy-sa]`,
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
    await execCapture(
      "gcloud",
      [
        "compute",
        "health-checks",
        "describe",
        hc,
        "--global",
        "--project",
        projectId,
        "--format=value(type)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    )
  ).stdout
    .trim()
    .toUpperCase();
  const bsScheme = (
    await execCapture(
      "gcloud",
      [
        "compute",
        "backend-services",
        "describe",
        bs,
        "--global",
        "--project",
        projectId,
        "--format=value(loadBalancingScheme)",
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    )
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
    namespace: configuredNamespace,
    projectDir,
    dryRun,
    iamRetryDelayMs = 5000,
    autopilot = true,
  } = options;
  const namespace = resolveK8sNamespace(configuredNamespace);

  const infraPath = infrastructureWritePath(projectDir);
  if (existsSync(infraPath)) {
    let existing: { namespace?: unknown };
    try {
      existing = JSON.parse(readFileSync(infraPath, "utf-8"));
    } catch (err) {
      throw new Error(
        `Failed to parse ${infraPath}: ${err instanceof Error ? err.message : String(err)}. ` +
          `Fix the file before re-running init.`,
      );
    }
    const existingNamespace = resolveK8sNamespace(existing.namespace);
    if (existingNamespace !== namespace) {
      throw new Error(
        `Cannot change the namespace of an existing release from "${existingNamespace}" to ` +
          `"${namespace}". The old namespace still contains release state and Workload ` +
          `Identity bindings. Destroy that release first, or use a new release/config variant.`,
      );
    }
  }

  // Validate every operator-supplied value BEFORE it reaches a gcloud arg array or the
  // scaffolded adapter.config.mjs — a `'` in a host/bucket name would otherwise be raw
  // JS injection into the generated config file.
  assertSafeProjectId(projectId);
  assertSafeRegion(region);
  assertSafeBucketName(bucket);
  assertSafeImageRegistry(registry);
  for (const host of hosts) assertSafeHostname(host);

  console.log(`\nInitializing @next-community/adapter-k8s for project: ${projectId}\n`);

  // 0. Ensure the least-privilege custom IAM role for the traffic-extension Job exists
  // BEFORE the command loop binds it. Fail loudly — never fall back to broad admin
  // roles. Idempotent: create, and on "already exists" update with the same set.
  const extRoleId = deployExtRoleId(releaseName);
  const extRoleTitle = `Next.js deploy traffic-extension (${releaseName})`;
  const extRoleArgs = [
    "--project",
    projectId,
    "--title",
    extRoleTitle,
    "--permissions",
    DEPLOY_EXT_ROLE_PERMISSIONS.join(","),
    "--quiet",
  ];
  console.log(`  → Ensuring custom IAM role ${extRoleId} (traffic-extension Job)`);
  if (dryRun) {
    console.log(`    [dry-run] gcloud iam roles create ${extRoleId} ${extRoleArgs.join(" ")}`);
    console.log(
      `    [dry-run]   (on "already exists": gcloud iam roles update ${extRoleId} with the same permissions)`,
    );
  } else {
    const created = await execCapture(
      "gcloud",
      ["iam", "roles", "create", extRoleId, ...extRoleArgs],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (created.exitCode !== 0) {
      if (/already exists|ALREADY_EXISTS/.test(created.stderr)) {
        const updated = await execCapture(
          "gcloud",
          ["iam", "roles", "update", extRoleId, ...extRoleArgs],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (updated.exitCode !== 0) {
          throw new Error(
            `Updating custom IAM role ${extRoleId} failed:\n${sanitizeForTerminal(updated.stderr)}`,
          );
        }
      } else {
        throw new Error(
          `Creating custom IAM role ${extRoleId} failed:\n${sanitizeForTerminal(created.stderr)}`,
        );
      }
    }
  }

  // 1. Generate gcloud commands
  const commands = buildInitGcloudCommands({
    projectId,
    region,
    bucket,
    releaseName,
    namespace,
    hosts,
    autopilot,
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
    let result = await execCapture(cmd.command, cmd.args, {
      timeoutMs: EXEC_TIMEOUTS.cloudOperation,
    });

    if (result.exitCode !== 0) {
      // Broad substrings ("Conflict", bare "409") are NOT already-exists signals: the
      // GCS bucket namespace is global, so a name collision is HTTP 409 whether WE own
      // the bucket or a stranger does — and the old matcher printed
      // "(already exists — skipping)" for both, letting init declare success while every
      // later static-asset upload failed against someone else's bucket.
      const isAlreadyExists =
        result.stderr.includes("already exists") ||
        result.stderr.includes("ALREADY_EXISTS") ||
        result.stderr.includes("already own it");

      const isBucketCreate =
        cmd.command === "gcloud" &&
        cmd.args.includes("buckets") &&
        cmd.args.includes("create") &&
        cmd.args.includes(`gs://${bucket}`);
      const isIamBinding = cmd.command === "gcloud" && cmd.args.includes("add-iam-policy-binding");
      // S6: the two revocations that MOVE bucket/registry write off the Workload-Identity-bound
      // deploy SA. "There is no such binding" is the normal outcome on a fresh init (and on
      // every re-run after the first), so it must be a skip, not a failure — `init` is
      // idempotent and re-run routinely, and a non-convergent step would brick it. Anything
      // else (permission denied, wrong project, a transient policy conflict) still fails or
      // retries exactly like an addition.
      const isIamRemoval =
        cmd.command === "gcloud" && cmd.args.includes("remove-iam-policy-binding");
      const bindingAbsent = (stderr: string): boolean =>
        /not found|NOT_FOUND|does not exist|no matching/i.test(stderr);

      if (isBucketCreate) {
        // Verify the existing bucket is visible to THIS project before skipping; a
        // foreign-owned name must fail loudly so the operator picks another one.
        const check = await execCapture(
          "gcloud",
          [
            "storage",
            "buckets",
            "describe",
            `gs://${bucket}`,
            "--project",
            projectId,
            "--format=value(name)",
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (check.exitCode === 0) {
          console.log(`    (already exists — verified accessible — skipping)`);
        } else {
          throw new Error(
            `${cmd.description} failed, and gs://${bucket} is not visible from project ` +
              `${projectId}. The GCS bucket namespace is shared by all GCP users — the name ` +
              `is likely owned by someone else. Re-run with a different --bucket name.\n` +
              `Original error:\n${sanitizeForTerminal(result.stderr)}`,
          );
        }
      } else if (isAlreadyExists) {
        console.log(`    (already exists — skipping)`);
      } else if (isIamRemoval && bindingAbsent(result.stderr)) {
        console.log(`    (no such binding — nothing to revoke)`);
      } else if (isIamBinding || isIamRemoval) {
        // IAM bindings routinely fail transiently right after their target is created — a
        // just-created service account is not yet propagated ("does not exist"), or the policy
        // read-modify-write conflicts. This is eventual consistency, so retry with backoff
        // (~30s total covers SA propagation). Applies to ALL grants, not just storage admin —
        // the Artifact Registry writer grant hit exactly this on a fresh init.
        let ok = false;
        for (let attempt = 1; attempt <= 6 && !ok; attempt++) {
          console.log(`    (IAM binding not ready — retry ${attempt}/6)`);
          await new Promise((r) => setTimeout(r, iamRetryDelayMs));
          result = await execCapture(cmd.command, cmd.args, {
            timeoutMs: EXEC_TIMEOUTS.cloudOperation,
          });
          ok =
            result.exitCode === 0 ||
            /already exists|ALREADY_EXISTS|already own it/.test(result.stderr) ||
            // S6: a revocation that now reports the binding as absent has converged — the
            // first attempt may well have applied it before the policy read raced.
            (isIamRemoval && bindingAbsent(result.stderr));
        }
        if (!ok) {
          throw new Error(`${cmd.description} failed after retries:\n${result.stderr}`);
        }
      } else {
        throw new Error(`${cmd.description} failed:\n${result.stderr}`);
      }
    }
  }

  // 2z. S6 (SECURITY). Say which identity is which — the split changes what CI must present,
  // and the revocations above are silent otherwise. Printed for dry-run too.
  console.log(
    `\n  ℹ This release has TWO GCP service accounts, deliberately:\n` +
      `      ${cliServiceAccountEmail(releaseName, projectId)}\n` +
      `        Bucket object-admin + Artifact Registry writer. Used by THIS CLI (asset upload,\n` +
      `        image push) under your own or your CI's credentials. Bound to no Kubernetes\n` +
      `        ServiceAccount, so no Pod can assume it.\n` +
      `      ${deployServiceAccountEmail(releaseName, projectId)}\n` +
      `        The in-cluster route-extension Job ONLY: the release-scoped traffic-extension\n` +
      `        role (${deployExtRoleId(releaseName)}) and nothing else. It is Workload-Identity\n` +
      `        bound, i.e. assumable by anyone who can create a Pod in the release's namespace —\n` +
      `        which is exactly why the storage/registry grants no longer live on it.\n` +
      `    If a CI pipeline authenticates AS the deploy SA to push images or upload assets, point\n` +
      `    it at the CLI SA instead — init has just revoked those two grants from the deploy SA.`,
  );

  // 2a-pre. Surface pre-traffic-extension routing resources that init can't fix in place.
  if (!dryRun) {
    await checkRoutingResourceShape(releaseName, projectId);
  }

  // 2a. Cloud CDN (GCPHTTPFilter) needs GKE >= MIN_GKE_VERSION_FOR_CDN, and the scaffolded
  // config enables CDN by default. Warn here; `deploy` hard-fails via CRD detection when a
  // CDN-enabled chart targets an unsupported cluster.
  if (!dryRun) {
    const versionResult = await execCapture(
      "gcloud",
      [
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
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
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
    const projNumResult = await execCapture(
      "gcloud",
      ["projects", "describe", projectId, "--format=value(projectNumber)", "--quiet"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (projNumResult.exitCode === 0) {
      const projectNumber = projNumResult.stdout.trim();
      const serviceAgents = [
        `service-${projectNumber}@container-engine-robot.iam.gserviceaccount.com`,
        `${projectNumber}-compute@developer.gserviceaccount.com`,
      ];
      for (const sa of serviceAgents) {
        const grant = await execCapture(
          "gcloud",
          [
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
          ],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        // A failed grant used to be swallowed — the first symptom was ImagePullBackOff
        // at deploy time, far from the cause. Warn loudly (non-fatal: the operator may
        // manage these grants centrally).
        if (grant.exitCode !== 0) {
          console.warn(
            `  ! Granting roles/artifactregistry.reader to ${sa} FAILED — GKE nodes may ` +
              `be unable to pull images (first symptom: ImagePullBackOff at deploy).\n` +
              `    ${grant.stderr.trim().split("\n")[0] ?? ""}`,
          );
        }
      }
    } else {
      console.warn(
        `  ! Could not look up the project number for ${projectId} — SKIPPED the Artifact ` +
          `Registry reader grants for GKE image pulls. Pods may fail with ImagePullBackOff ` +
          `at deploy; grant roles/artifactregistry.reader on the 'nextjs' repository to the ` +
          `container-engine-robot and compute service agents manually.\n` +
          `    ${projNumResult.stderr.trim().split("\n")[0] ?? ""}`,
      );
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
  const infraDir = path.dirname(infraPath);
  console.log(`  → Writing ${path.relative(projectDir, infraPath)}`);
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
        namespace,
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
      const dnsAuthResult = await execCapture(
        "gcloud",
        [
          "certificate-manager",
          "dns-authorizations",
          "describe",
          authName,
          "--project",
          projectId,
          "--format=value(dnsResourceRecord.name,dnsResourceRecord.type,dnsResourceRecord.data)",
        ],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
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

  // 6. M4b: .k8s-adapter/ holds generated secrets (cache connection Secret, deploy
  // state) — make sure it can never be committed.
  if (!dryRun) {
    const gitignorePath = path.join(projectDir, ".gitignore");
    const ignoreLine = ".k8s-adapter/";
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : null;
    const alreadyIgnored =
      existing !== null && existing.split("\n").some((l) => l.trim() === ignoreLine);
    if (!alreadyIgnored) {
      if (existing === null) {
        writeFileSync(gitignorePath, `${ignoreLine}\n`);
      } else {
        const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        appendFileSync(gitignorePath, `${prefix}${ignoreLine}\n`);
      }
      console.log(`  → Added "${ignoreLine}" to .gitignore`);
    }
    console.log(
      "  ℹ .k8s-adapter/ contains generated secrets and state — it must not be committed.",
    );
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
    `     - Run \`kubectl get gateway ${releaseName}-gateway -n ${namespace}\` to find your external IP address.`,
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
