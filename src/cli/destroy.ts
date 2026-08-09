// src/cli/destroy.ts
import { existsSync, readFileSync } from "node:fs";
import readline from "node:readline";
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import { cliServiceAccountEmail, deployExtRoleId, deployServiceAccountEmail } from "./init.js";
import { sanitizeForTerminal } from "./terminal.js";
import { INTERNAL_SECRET_COMPONENT } from "../emit/templates/internal-secret.js";
import { ROUTING_MANIFEST_SNAPSHOT_COMPONENT } from "../emit/templates/routing-manifest-configmap.js";
import { COMPOSITION_PLAN_COMPONENT } from "../emit/templates/composition-plan-configmap.js";
import {
  ADAPTER_RELEASE_LABEL,
  assertSafePoolName,
  assertSafeReleaseName,
  poolResourceNames,
  resolveK8sNamespace,
  sanitizeK8sName,
  stablePoolResourceNames,
} from "../emit/templates/utils.js";
import { assertSafeInfrastructure, infrastructurePath } from "./infrastructure-validation.js";
import { readState, StateUnavailableError } from "./state.js";
import {
  compositionPlanNeedsExplicitConfirmation,
  loadDeployedCompositionPlan,
  loadProjectCompositionPlan,
  preflightCompositionPlan,
  type LoadedCompositionPlan,
} from "./composition-plan.js";
import type {
  ExternalCleanupOperation,
  KubernetesOwnedObject,
  RetainedExternalResource,
} from "../composition-plan/index.js";

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

function parseKubernetesList(stdout: string, description: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `${description} returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    throw new Error(`${description} did not contain an items array`);
  }
  return items;
}

interface PoolDeploymentIdentity {
  name: string;
}

/**
 * Prove the exact versioned pool Deployments whose autoscalers this release may own.
 *
 * The API-server selector is intentionally broad enough to find pre-ownership-label releases.
 * The runtime env, component/version labels and exact adapter-derived name must all agree before
 * a Deployment becomes an HPA ownership root; never infer ownership from a name prefix or generic
 * Helm labels.
 */
function parsePoolDeploymentIdentities(
  stdout: string,
  releaseName: string,
): PoolDeploymentIdentity[] {
  const result: PoolDeploymentIdentity[] = [];
  const names = new Set<string>();
  for (const item of parseKubernetesList(stdout, "Versioned pool Deployment listing") as {
    metadata?: { name?: unknown; labels?: Record<string, unknown> };
    spec?: {
      template?: {
        spec?: {
          containers?: { name?: unknown; env?: { name?: unknown; value?: unknown }[] }[];
        };
      };
    };
  }[]) {
    const name = item?.metadata?.name;
    const labels = item?.metadata?.labels;
    const component = labels?.["app.kubernetes.io/component"];
    const version = labels?.["app.kubernetes.io/version"];
    const poolContainer = item?.spec?.template?.spec?.containers?.find(
      (container) => container?.name === "pool-server",
    );
    const env = new Map(
      (poolContainer?.env ?? [])
        .filter(
          (entry): entry is { name: string; value: string } =>
            typeof entry?.name === "string" && typeof entry.value === "string",
        )
        .map((entry) => [entry.name, entry.value]),
    );
    const rawBuildId = env.get("NEXT_BUILD_ID");
    const rawPool = env.get("POOL_NAME");
    const rawRelease = env.get("RELEASE_NAME");

    // This list is intentionally broad enough to find pre-label resources. A foreign Helm
    // Deployment can share the generic app/version labels, so unprovable objects are skipped,
    // not promoted into deletion authority. The runtime identity and exact adapter-derived name
    // are what make a legacy Deployment an HPA ownership root.
    if (
      typeof name !== "string" ||
      labels?.["app.kubernetes.io/name"] !== releaseName ||
      typeof component !== "string" ||
      component === "routing-service" ||
      typeof version !== "string" ||
      rawRelease !== releaseName ||
      rawPool !== component ||
      typeof rawBuildId !== "string"
    ) {
      continue;
    }
    try {
      assertSafePoolName(component);
      const expected = poolResourceNames(releaseName, component, rawBuildId);
      if (name !== expected.deployment || version !== sanitizeK8sName(rawBuildId)) continue;
    } catch {
      continue;
    }
    if (names.has(name)) {
      throw new Error(`Versioned pool Deployment listing repeated Deployment "${name}"`);
    }
    names.add(name);
    result.push({ name });
  }
  return result;
}

/** Select only adapter-named HPAs that target one of the exact owned Deployment identities. */
function parseOwnedHpaNames(stdout: string, deployments: PoolDeploymentIdentity[]): string[] {
  const targets = new Set(deployments.map(({ name }) => name));
  const names = new Set<string>();
  for (const item of parseKubernetesList(stdout, "HPA listing") as {
    metadata?: { name?: unknown };
    spec?: {
      scaleTargetRef?: { apiVersion?: unknown; kind?: unknown; name?: unknown };
    };
  }[]) {
    const target = item?.spec?.scaleTargetRef;
    if (typeof target?.name !== "string" || !targets.has(target.name)) continue;

    const name = item?.metadata?.name;
    const expected = sanitizeK8sName(target.name, "-hpa");
    if (
      target.apiVersion !== "apps/v1" ||
      target.kind !== "Deployment" ||
      typeof name !== "string" ||
      name !== expected
    ) {
      // A foreign autoscaler can target an adapter Deployment. Its target does not make it
      // adapter-owned; only the exact name emitted by hpa.ts is eligible for deletion.
      continue;
    }
    names.add(name);
  }
  return [...names];
}

type StablePoolResourceKind = "service" | "poddisruptionbudget" | "healthcheckpolicy";

/** Validate topology-retained stable pool objects before deleting any exact name. */
function parseStablePoolResourceNames(
  stdout: string,
  kind: StablePoolResourceKind,
  releaseName: string,
  namespace: string,
): string[] {
  const names = new Set<string>();
  for (const item of parseKubernetesList(stdout, `Retained ${kind} listing`) as {
    metadata?: {
      name?: unknown;
      labels?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    };
    spec?: {
      selector?: Record<string, unknown>;
      targetRef?: { group?: unknown; kind?: unknown; name?: unknown };
    };
  }[]) {
    const name = item?.metadata?.name;
    const labels = item?.metadata?.labels;
    const annotations = item?.metadata?.annotations;
    const component = labels?.["app.kubernetes.io/component"];
    if (
      typeof name !== "string" ||
      labels?.["app.kubernetes.io/name"] !== releaseName ||
      labels?.[ADAPTER_RELEASE_LABEL] !== releaseName ||
      annotations?.["meta.helm.sh/release-name"] !== releaseName ||
      annotations?.["meta.helm.sh/release-namespace"] !== namespace ||
      typeof component !== "string"
    ) {
      throw new Error(
        `Retained ${kind} listing contained an object without the exact pool identity`,
      );
    }
    if (component === "routing-service") continue;
    assertSafePoolName(component);
    const resourceNames = stablePoolResourceNames(releaseName, component);
    const expected =
      kind === "service"
        ? resourceNames.service
        : kind === "poddisruptionbudget"
          ? resourceNames.pdb
          : resourceNames.hcp;
    if (name !== expected) {
      throw new Error(
        `Retained ${kind} "${name}" claims pool "${component}", but its adapter-derived ` +
          `name is "${expected}"`,
      );
    }
    const selector = item?.spec?.selector;
    if (
      kind === "service" &&
      (selector?.["app.kubernetes.io/name"] !== releaseName ||
        selector?.["app.kubernetes.io/component"] !== component)
    ) {
      throw new Error(`Retained service "${name}" does not select its exact pool identity`);
    }
    if (kind === "poddisruptionbudget") {
      const matchLabels = selector?.matchLabels as Record<string, unknown> | undefined;
      if (
        matchLabels?.["app.kubernetes.io/name"] !== releaseName ||
        matchLabels?.["app.kubernetes.io/component"] !== component
      ) {
        throw new Error(
          `Retained poddisruptionbudget "${name}" does not select its exact pool identity`,
        );
      }
    }
    if (
      kind === "healthcheckpolicy" &&
      (item?.spec?.targetRef?.group !== "" ||
        item.spec.targetRef.kind !== "Service" ||
        item.spec.targetRef.name !== resourceNames.service)
    ) {
      throw new Error(
        `Retained healthcheckpolicy "${name}" does not target its exact stable Service`,
      );
    }
    names.add(name);
  }
  return [...names];
}

function isOptionalHealthCheckPolicyApiMissing(stderr: string): boolean {
  const s = stderr.toLowerCase();
  if (NOT_GONE_MARKERS.some((marker) => s.includes(marker))) return false;
  return (
    s.includes('the server doesn\'t have a resource type "healthcheckpolicy"') ||
    s.includes('no matches for kind "healthcheckpolicy"') ||
    s.includes("could not find the requested resource")
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

export function buildExternalCleanupCommand(operation: ExternalCleanupOperation): {
  desc: string;
  command: "gcloud";
  args: string[];
} {
  switch (operation.kind) {
    case "gcp-storage-bucket":
      return {
        desc: `GCS bucket "${operation.bucket}"`,
        command: "gcloud",
        args: [
          "storage",
          "rm",
          "-r",
          `gs://${operation.bucket}`,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-service-account":
      return {
        desc: `service account "${operation.email}"`,
        command: "gcloud",
        args: [
          "iam",
          "service-accounts",
          "delete",
          operation.email,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-memorystore":
      return {
        desc: `Memorystore instance "${operation.name}"`,
        command: "gcloud",
        args: [
          "redis",
          "instances",
          "delete",
          operation.name,
          `--region=${operation.region}`,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-traffic-extension":
      return {
        desc: `traffic extension "${operation.name}"`,
        command: "gcloud",
        args: [
          "service-extensions",
          "lb-traffic-extensions",
          "delete",
          operation.name,
          `--location=${operation.location}`,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-backend-service":
      return {
        desc: `backend service "${operation.name}"`,
        command: "gcloud",
        args: [
          "compute",
          "backend-services",
          "delete",
          operation.name,
          `--${operation.scope}`,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-health-check":
      return {
        desc: `health check "${operation.name}"`,
        command: "gcloud",
        args: [
          "compute",
          "health-checks",
          "delete",
          operation.name,
          `--${operation.scope}`,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-global-address":
      return {
        desc: `global address "${operation.name}"`,
        command: "gcloud",
        args: [
          "compute",
          "addresses",
          "delete",
          operation.name,
          "--global",
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
    case "gcp-custom-iam-role":
      return {
        desc: `custom IAM role "${operation.roleId}"`,
        command: "gcloud",
        args: [
          "iam",
          "roles",
          "delete",
          operation.roleId,
          `--project=${operation.projectId}`,
          "--quiet",
        ],
      };
  }
}

function retainedResourceGuidance(resource: RetainedExternalResource): {
  description: string;
  command: string;
} {
  switch (resource.kind) {
    case "gke-cluster": {
      const locationFlag = resource.location.kind === "zone" ? "--zone" : "--region";
      return {
        description: `GKE cluster "${resource.clusterName}"`,
        command:
          `gcloud container clusters delete ${resource.clusterName} ${locationFlag} ` +
          `${resource.location.name} --project ${resource.projectId}`,
      };
    }
    case "gcp-artifact-registry":
      return {
        description: `Artifact Registry "${resource.repository}"`,
        command:
          `gcloud artifacts repositories delete ${resource.repository} --location ` +
          `${resource.region} --project ${resource.projectId}`,
      };
    case "gcp-certificate-manager":
      return {
        description: `Certificate Manager resources prefixed "${resource.releasePrefix}"`,
        command:
          `gcloud certificate-manager maps list --project ${resource.projectId} ` +
          `--filter=name:${resource.releasePrefix}`,
      };
  }
}

export async function removePlannedKubernetesObject(
  owned: KubernetesOwnedObject,
  dryRun: boolean,
): Promise<string | null> {
  const ref = owned.ref;
  const namespaceArgs = ref.namespace ? ["-n", ref.namespace] : [];
  const getArgs = [
    "get",
    ref.resource,
    ref.name,
    ...namespaceArgs,
    "--ignore-not-found",
    "-o",
    "json",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${getArgs.join(" ")}`);
    console.log(
      `  [dry-run] would verify ${owned.ownership.releaseLabel.key}=` +
        `${owned.ownership.releaseLabel.value} before exact deletion`,
    );
    return null;
  }
  const read = await execCapture("kubectl", getArgs, { timeoutMs: EXEC_TIMEOUTS.kubectl });
  if (read.exitCode !== 0) {
    return `${ref.resource} ${ref.name}: ${sanitizeForTerminal(read.stderr.trim()) || `exit ${read.exitCode}`}`;
  }
  if (!read.stdout.trim()) return null;
  let labels: Record<string, unknown> | undefined;
  try {
    labels = JSON.parse(read.stdout)?.metadata?.labels;
  } catch {
    return `${ref.resource} ${ref.name}: invalid Kubernetes object JSON`;
  }
  if (labels?.[owned.ownership.releaseLabel.key] !== owned.ownership.releaseLabel.value) {
    return (
      `${ref.resource} ${ref.name}: ownership label ` +
      `${owned.ownership.releaseLabel.key} does not match ${owned.ownership.releaseLabel.value}`
    );
  }
  const deleted = await execCapture(
    "kubectl",
    ["delete", ref.resource, ref.name, ...namespaceArgs, "--ignore-not-found"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  return deleted.exitCode === 0
    ? null
    : `${ref.resource} ${ref.name}: ${sanitizeForTerminal(deleted.stderr.trim()) || `exit ${deleted.exitCode}`}`;
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

  assertSafeReleaseName(releaseName);
  const infraPath = infrastructurePath(projectDir);
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : undefined;
  // S13: validate before any of these reach a gcloud/kubectl argv.
  assertSafeInfrastructure(infra);
  const namespace = resolveK8sNamespace(infra?.namespace);
  const projectId: string | undefined = infra?.projectId;
  const region: string | undefined = infra?.region;
  const localComposition = loadProjectCompositionPlan(projectDir);

  // L12: destroying is irreversible — gate it. --yes (or -y) skips the prompt and is
  // REQUIRED non-interactively; --dry-run never deletes and skips the gate entirely.
  if (!dryRun) {
    console.log(`\n  *** DESTRUCTIVE: tearing down release "${releaseName}" ***`);
    if (projectId) {
      console.log(`  *** Target GCP project: ${projectId} ***\n`);
      // Best-effort sanity check: warn loudly when the operator's active gcloud project
      // differs from the project this release was deployed to. gcloud failures are
      // tolerated (the deletes below all pass --project explicitly anyway).
      const cfg = await execCapture("gcloud", ["config", "get-value", "project", "--quiet"], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
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
  if (!dryRun && localComposition) {
    let explicitlyConfirmed = yes === true;
    if (compositionPlanNeedsExplicitConfirmation(localComposition.plan) && !explicitlyConfirmed) {
      const ctx = await execCapture("kubectl", ["config", "current-context"], {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      }).catch(() => null);
      const currentContext =
        ctx && ctx.exitCode === 0 ? sanitizeForTerminal(ctx.stdout.trim()) : "";
      console.warn(
        `\n  !!! WARNING: the composition plan requires explicit confirmation of the ` +
          `current kubectl context:\n      ${currentContext || "(unavailable)"}\n`,
      );
      const answer = await promptConfirmation(
        `  Type "yes" to confirm this is the release's intended cluster: `,
      );
      if (answer.trim() !== "yes") {
        throw new Error(
          "Destroy aborted: the composition-plan cluster was not confirmed. No resources were deleted.",
        );
      }
      explicitlyConfirmed = true;
    }
    const preflight = await preflightCompositionPlan(localComposition.plan, {
      explicitlyConfirmed,
    });
    console.log(
      `  → Composition plan verified: ${preflight.clusterIdentity}; Kubernetes ` +
        `${preflight.serverVersion}`,
    );
  } else if (!dryRun && projectId && region) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`  → Connecting to GKE cluster "${clusterName}"...`);
    const cred = await execCapture(
      "gcloud",
      [
        "container",
        "clusters",
        "get-credentials",
        clusterName,
        "--region",
        region,
        "--project",
        projectId,
        "--quiet",
      ],
      { timeoutMs: EXEC_TIMEOUTS.cloudOperation },
    );
    if (cred.exitCode !== 0) {
      throw new Error(
        `Failed to connect to cluster "${clusterName}" — aborting destroy before any ` +
          `deletion: ${sanitizeForTerminal(cred.stderr.trim()) || `exit ${cred.exitCode}`}`,
      );
    }
  } else if (dryRun) {
    if (localComposition) {
      console.log(
        `  [dry-run] Verified local composition plan ${localComposition.digest}; cluster ` +
          `access and identity checks are skipped because they would read or change context.`,
      );
    } else if (projectId && region) {
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
    const ctx = await execCapture("kubectl", ["config", "current-context"], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    }).catch(() => null);
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

  // Retain verified plans in memory before any ConfigMap or Helm deletion. Cluster state may
  // select label-verified Kubernetes objects, but external cleanup is authorized separately by
  // the authenticated local build plan below.
  const plannedSnapshots: LoadedCompositionPlan[] = localComposition ? [localComposition] : [];
  let usesCompositionPlan = localComposition !== null;
  if (!dryRun) {
    const state = await readState(projectDir, releaseName, { namespace }).catch(
      (error: unknown) => {
        if (!(error instanceof StateUnavailableError)) throw error;
        if (localComposition) {
          console.warn(
            `  ! Deploy state is unavailable; continuing from the locally verified composition ` +
              `plan only: ${sanitizeForTerminal(error.message.split("\n")[0]!)}`,
          );
        }
        return null;
      },
    );
    if (state?.compositionPlans) {
      usesCompositionPlan = true;
      for (const buildId of [state.buildId, state.previousBuildId].filter(
        (value): value is string => typeof value === "string",
      )) {
        const expected = state.compositionPlans[buildId];
        if (!expected) continue;
        if (
          localComposition?.plan.metadata.buildId === buildId &&
          (localComposition.digest !== expected.digest ||
            localComposition.plan.target.fingerprint !== expected.targetFingerprint)
        ) {
          throw new Error(
            `Local composition plan for ${buildId} does not match committed deploy state. ` +
              `No resources were deleted.`,
          );
        }
        const snapshot =
          localComposition?.plan.metadata.buildId === buildId
            ? localComposition
            : await loadDeployedCompositionPlan({
                releaseName,
                namespace,
                buildId,
                expected,
              });
        if (!snapshot) {
          throw new Error(
            `Committed composition plan for ${buildId} is missing. No resources were deleted.`,
          );
        }
        if (!plannedSnapshots.some((entry) => entry.digest === snapshot.digest)) {
          plannedSnapshots.push(snapshot);
        }
      }
    }
  }

  // Snapshot exact versioned Deployment identities BEFORE Helm removes the current release.
  // Legacy/rollback-created HPAs have no labels at all, so after their target Deployment is gone
  // there is no safe way to distinguish them from another operator's autoscaler. The target
  // relation is the migration seam: only the adapter-derived HPA name pointing at one of these
  // exact, strongly-labeled Deployments is eligible for the post-uninstall exact-name sweep.
  const legacyRolloutDiscoverySelector = `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version`;
  const retainedRolloutSelector =
    `${ADAPTER_RELEASE_LABEL}=${releaseName},` +
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version`;
  const poolDeploymentListArgs = [
    "get",
    "deployments",
    "-n",
    namespace,
    "-l",
    legacyRolloutDiscoverySelector,
    "-o",
    "json",
  ];
  const hpaListArgs = ["get", "hpa", "-n", namespace, "-o", "json"];
  let exactOwnedHpas: string[] = [];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${poolDeploymentListArgs.join(" ")}`);
    console.log(`  [dry-run] kubectl ${hpaListArgs.join(" ")}`);
    console.log(
      "  [dry-run] would delete only adapter-named HPAs whose scaleTargetRef matches an " +
        "exact selected Deployment",
    );
  } else {
    const deploymentList = await execCapture("kubectl", poolDeploymentListArgs, {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    if (deploymentList.exitCode !== 0) {
      throw new Error(
        `Could not discover versioned pool Deployment identities before Helm uninstall: ` +
          `${sanitizeForTerminal(deploymentList.stderr.trim()) || `exit ${deploymentList.exitCode}`}. ` +
          `No resources were deleted; refusing to orphan legacy unlabeled HPAs.`,
      );
    }

    let deployments: PoolDeploymentIdentity[];
    try {
      deployments = parsePoolDeploymentIdentities(deploymentList.stdout, releaseName);
    } catch (err) {
      throw new Error(
        `Could not validate versioned pool Deployment identities before Helm uninstall: ` +
          `${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}. ` +
          `No resources were deleted; refusing to orphan legacy unlabeled HPAs.`,
      );
    }

    if (deployments.length > 0) {
      const hpaList = await execCapture("kubectl", hpaListArgs, {
        timeoutMs: EXEC_TIMEOUTS.kubectl,
      });
      if (hpaList.exitCode !== 0) {
        throw new Error(
          `Could not discover retained HPAs before Helm uninstall: ` +
            `${sanitizeForTerminal(hpaList.stderr.trim()) || `exit ${hpaList.exitCode}`}. ` +
            `No resources were deleted.`,
        );
      }
      try {
        exactOwnedHpas = parseOwnedHpaNames(hpaList.stdout, deployments);
      } catch (err) {
        throw new Error(
          `Could not validate retained HPAs before Helm uninstall: ` +
            `${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}. ` +
            `No resources were deleted.`,
        );
      }
    }
  }

  // Pin every cluster-side deletion to the release namespace instead of trusting the context.
  if (dryRun) {
    console.log(`  [dry-run] helm uninstall ${releaseName} --namespace ${namespace}`);
  } else {
    console.log("  → Running helm uninstall...");
    const res = await execCapture("helm", ["uninstall", releaseName, "--namespace", namespace], {
      timeoutMs: EXEC_TIMEOUTS.cloudOperation,
    });
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

  // Deploy transfers the outgoing pool Deployments and HPAs out of Helm's release manifest
  // with `helm.sh/resource-policy: keep`. That is required for an abort-safe blue/green rollout,
  // but it also means `helm uninstall` intentionally leaves those objects behind. A failed deploy
  // can leave the incoming build behind as well. Sweep every versioned pool object after uninstall
  // instead of relying on deploy state, which may describe only the last successful cutover.
  //
  // The deletion selector is deliberately stricter than generic Kubernetes conventions:
  // namespace + the adapter's exact release ownership label + matching app/version identity. A
  // foreign Helm resource can legitimately share app.kubernetes.io/name and managed-by values;
  // neither is deletion authority. The version requirement excludes the stable routing tier.
  for (const hpaName of exactOwnedHpas) {
    const exactDelete = await execCapture(
      "kubectl",
      ["delete", "hpa", hpaName, "-n", namespace, "--ignore-not-found"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (exactDelete.exitCode !== 0 && !isAlreadyGoneError(exactDelete.stderr)) {
      console.warn(
        `    WARNING: could not delete retained HPA ${hpaName}: ` +
          `${sanitizeForTerminal(exactDelete.stderr.trim()) || `exit ${exactDelete.exitCode}`}.`,
      );
      failures.push(`retained HPA "${hpaName}"`);
    }
  }
  for (const { kind, description } of [
    { kind: "deployment", description: "retained pool Deployments" },
    { kind: "hpa", description: "retained pool HPAs" },
  ]) {
    const deleteArgs = [
      "delete",
      kind,
      "-n",
      namespace,
      "-l",
      retainedRolloutSelector,
      "--ignore-not-found",
    ];
    if (dryRun) {
      console.log(`  [dry-run] kubectl ${deleteArgs.join(" ")}`);
      continue;
    }

    const res = await execCapture("kubectl", deleteArgs, { timeoutMs: EXEC_TIMEOUTS.kubectl });
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete ${description}: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}.`,
      );
      failures.push(description);
    }
  }

  // A topology-changing deploy can retain a removed pool's stable Service, PDB and (on GKE)
  // HealthCheckPolicy for rollback. The topology transfer stamps these adapter-owned objects
  // without a version label, so they need a separate sweep from build-scoped resources. List by
  // exact dedicated release identity, then validate every component and helper-equivalent derived
  // name before deleting it by exact name. The routing tier uses component=routing-service and is
  // intentionally excluded even if a future migration gives it the same ownership label.
  const retainedStableSelector = `${ADAPTER_RELEASE_LABEL}=${releaseName},app.kubernetes.io/name=${releaseName}`;
  for (const { kind, description, apiOptional } of [
    { kind: "service", description: "retained stable pool Services", apiOptional: false },
    {
      kind: "poddisruptionbudget",
      description: "retained stable pool PodDisruptionBudgets",
      apiOptional: false,
    },
    {
      kind: "healthcheckpolicy",
      description: "retained stable pool HealthCheckPolicies",
      apiOptional: true,
    },
  ] as const) {
    const listArgs = ["get", kind, "-n", namespace, "-l", retainedStableSelector, "-o", "json"];
    if (dryRun) {
      console.log(`  [dry-run] kubectl ${listArgs.join(" ")}`);
      console.log(
        `  [dry-run] would delete exact validated ${kind} names from that adapter-owned list`,
      );
      continue;
    }

    const listed = await execCapture("kubectl", listArgs, { timeoutMs: EXEC_TIMEOUTS.kubectl });
    if (
      listed.exitCode !== 0 &&
      apiOptional &&
      isOptionalHealthCheckPolicyApiMissing(listed.stderr)
    ) {
      continue;
    }
    if (listed.exitCode !== 0) {
      console.warn(
        `    WARNING: could not discover ${description}: ` +
          `${sanitizeForTerminal(listed.stderr.trim()) || `exit ${listed.exitCode}`}.`,
      );
      failures.push(description);
      continue;
    }

    let names: string[];
    try {
      names = parseStablePoolResourceNames(listed.stdout, kind, releaseName, namespace);
    } catch (err) {
      console.warn(
        `    WARNING: could not validate ${description}: ` +
          `${sanitizeForTerminal(err instanceof Error ? err.message : String(err))}.`,
      );
      failures.push(description);
      continue;
    }

    for (const name of names) {
      const deleted = await execCapture(
        "kubectl",
        ["delete", kind, name, "-n", namespace, "--ignore-not-found"],
        { timeoutMs: EXEC_TIMEOUTS.kubectl },
      );
      if (deleted.exitCode !== 0 && !isAlreadyGoneError(deleted.stderr)) {
        console.warn(
          `    WARNING: could not delete ${kind} ${name}: ` +
            `${sanitizeForTerminal(deleted.stderr.trim()) || `exit ${deleted.exitCode}`}.`,
        );
        failures.push(`${description}: "${name}"`);
      }
    }
  }

  const plannedObjects = new Map<string, KubernetesOwnedObject>();
  for (const snapshot of plannedSnapshots) {
    for (const owned of snapshot.plan.operations.cleanup.kubernetes.contributedObjects) {
      plannedObjects.set(
        `${owned.ref.apiVersion}|${owned.ref.resource}|${owned.ref.namespace ?? ""}|${owned.ref.name}`,
        owned,
      );
    }
  }
  for (const owned of plannedObjects.values()) {
    const failure = await removePlannedKubernetesObject(owned, dryRun === true);
    if (failure) {
      console.warn(`    WARNING: planned Kubernetes cleanup failed: ${failure}`);
      failures.push(failure);
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
    namespace,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/managed-by=adapter-k8s`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${cmDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", cmDeleteArgs, { timeoutMs: EXEC_TIMEOUTS.kubectl });
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete adapter state ConfigMaps: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}. Delete them manually ` +
          `(kubectl delete configmap -n ${namespace} -l app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/managed-by=adapter-k8s) or the next deploy may see stale state.`,
      );
    }
  }

  // Helm-owned per-build routing snapshots carry resource-policy: keep so an outgoing
  // ReplicaSet and rollback target never lose the ConfigMap they mount. Helm uninstall
  // deliberately leaves them behind; remove the release-scoped snapshots explicitly.
  const snapshotDeleteArgs = [
    "delete",
    "configmap",
    "-n",
    namespace,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${snapshotDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", snapshotDeleteArgs, {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete retained routing-manifest ConfigMaps: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}. Delete them manually ` +
          `(kubectl delete configmap -n ${namespace} -l app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}).`,
      );
    }
  }

  const compositionDeleteArgs = [
    "delete",
    "configmap",
    "-n",
    namespace,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${COMPOSITION_PLAN_COMPONENT}`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${compositionDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", compositionDeleteArgs, {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete retained composition-plan ConfigMaps: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}.`,
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
    namespace,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
    "--ignore-not-found",
  ];
  if (dryRun) {
    console.log(`  [dry-run] kubectl ${secretDeleteArgs.join(" ")}`);
  } else {
    const res = await execCapture("kubectl", secretDeleteArgs, {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    });
    if (res.exitCode !== 0 && !isAlreadyGoneError(res.stderr)) {
      console.warn(
        `    WARNING: could not delete the internal-dispatch Secrets: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `exit ${res.exitCode}`}. Delete them ` +
          `manually (kubectl delete secret -n ${namespace} -l ` +
          `app.kubernetes.io/name=${releaseName},` +
          `app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}); they are retained by ` +
          `resource-policy and helm uninstall will not remove them.`,
      );
    }
  }

  const retainedResources = new Map<string, RetainedExternalResource>();
  for (const snapshot of plannedSnapshots) {
    for (const resource of snapshot.plan.operations.cleanup.retained) {
      retainedResources.set(JSON.stringify(resource), resource);
    }
  }

  // A plan retained in Kubernetes is useful for exact Kubernetes cleanup because every object is
  // independently checked for its release ownership label before deletion. It is not authority to
  // spend the operator's ambient cloud credentials: a namespace actor can rewrite both deploy state
  // and retained plan ConfigMaps. Only operations also present in the authenticated local build
  // artifact may execute automatically.
  const locallyAuthorizedExternalOperations = new Set(
    (localComposition?.plan.operations.cleanup.external ?? []).map((operation) =>
      JSON.stringify(operation),
    ),
  );
  const skippedExternalCleanup: ReturnType<typeof buildExternalCleanupCommand>[] = [];

  // 2. Clean up external resources from the composition plan, or the legacy infrastructure file.
  if (usesCompositionPlan) {
    const operations = new Map<string, ExternalCleanupOperation>();
    for (const snapshot of plannedSnapshots) {
      for (const operation of snapshot.plan.operations.cleanup.external) {
        operations.set(JSON.stringify(operation), operation);
      }
    }
    for (const [operationKey, operation] of operations) {
      const cleanup = buildExternalCleanupCommand(operation);
      if (!locallyAuthorizedExternalOperations.has(operationKey)) {
        skippedExternalCleanup.push(cleanup);
        continue;
      }
      if (dryRun) {
        console.log(`  [dry-run] ${cleanup.command} ${cleanup.args.join(" ")}`);
        continue;
      }
      console.log(`  → Deleting ${cleanup.desc}`);
      const result = await execCapture(cleanup.command, cleanup.args, {
        timeoutMs: EXEC_TIMEOUTS.cloudOperation,
      });
      if (result.exitCode !== 0 && !isAlreadyGoneError(result.stderr)) {
        console.warn(
          `    WARNING: deletion failed: ` +
            `${sanitizeForTerminal(result.stderr.trim()) || `exit ${result.exitCode}`}`,
        );
        failures.push(cleanup.desc);
      }
    }
    if (operations.size === 0) {
      console.log("  → No adapter-owned external cleanup operations in the composition plan");
    }
  } else if (infra) {
    // Delete GCS bucket
    if (infra.gcsBucket) {
      const bucketArgs = ["storage", "rm", "-r", `gs://${infra.gcsBucket}`, "--quiet"];
      if (dryRun) {
        console.log(`  [dry-run] gcloud ${bucketArgs.join(" ")}`);
      } else {
        console.log(`  → Deleting GCS bucket: ${infra.gcsBucket}`);
        const res = await execCapture("gcloud", bucketArgs, {
          timeoutMs: EXEC_TIMEOUTS.cloudOperation,
        });
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
        const res = await execCapture("gcloud", saArgs, {
          timeoutMs: EXEC_TIMEOUTS.cloudOperation,
        });
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
          const res = await execCapture("gcloud", args, {
            timeoutMs: EXEC_TIMEOUTS.cloudOperation,
          });
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

  if (skippedExternalCleanup.length > 0) {
    console.warn(
      "\n  ! External cleanup was NOT executed because these operations were available only " +
        "from cluster-writable deploy state and composition plans. Automatic execution requires " +
        "the matching local build output to be present when destroy starts. Confirm each resource " +
        `belongs to release "${releaseName}" before running these commands manually:`,
    );
    for (const cleanup of skippedExternalCleanup) {
      console.warn(`    • ${cleanup.desc}: ${cleanup.command} ${cleanup.args.join(" ")}`);
    }
  }

  if (retainedResources.size > 0) {
    console.log("\n  Left in place by the composition plan (remove manually only if unused):");
    for (const resource of retainedResources.values()) {
      const guidance = retainedResourceGuidance(resource);
      console.log(`    • ${guidance.description}: ${guidance.command}`);
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
  if (usesCompositionPlan) {
    console.log(
      skippedExternalCleanup.length > 0
        ? "\n✓ Removed: Helm release, retained rollout/rollback resources, and verified " +
            "Kubernetes cleanup. Cluster-only external cleanup was left for manual review.\n"
        : "\n✓ Removed: Helm release, retained rollout/rollback resources, and every " +
            "adapter-owned cleanup operation corroborated by the local composition plan.\n",
    );
  } else {
    console.log("\n✓ Removed: Helm release, retained pool rollout/rollback resources, GCS bucket,");
    console.log("  both service accounts, and the release-scoped ext_proc resources");
    console.log(
      "  (traffic extension, routing backend, health check, static IP, custom IAM role).\n",
    );
  }
  if (!usesCompositionPlan && projectId) {
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
  // Preserve .k8s-adapter/infrastructure.json: legacy targets need it to find retained resources,
  // and composed targets may still have a local build plan there. Cluster-only plans are removed
  // with the release, so their exact manual commands are printed above before returning.
  console.log(`\n  Local state (.k8s-adapter) preserved.\n`);
}
