// src/cli/migrate.ts
//
// `adapter-k8s migrate` — GitOps PR2 (design §4.2 "keep-at-birth", §7 Q6): annotate a
// LIVE imperative release's retained set with the reconciler prune-protection
// annotations BEFORE GitOps mode is enabled. A HARD PREREQUISITE, not a recommendation
// (docs/gitops.md): builds deployed by the imperative CLI carry none of the keep-at-birth
// annotations, so the FIRST sync of a pruning reconciler over an existing release deletes
// the parked rollback build — and, observed live (2026-08-10 audit), the still-serving
// build's Deployment while the stable Service still selected it.
//
// What it annotates — the retained set, i.e. everything a sync would prune because it is
// absent from (or keep-annotated out of) the new bundle's rendered manifest:
//   - the parked previous build's pool Deployments and versioned Services, and the
//     serving build's (both are absent from the NEXT bundle's manifest once bundles are
//     replaced wholesale);
//   - per-build HPAs (the serving build's — the parked build's HPA was deleted at park
//     time, so it is annotated only if present);
//   - the keep-annotated per-build CMs/Secrets that Helm preserves but Argo/Flux prune
//     ignores: dispatch Secrets (N87), routing-manifest snapshot CMs, composition-plan
//     CMs — these carry `helm.sh/resource-policy: keep` already and gain the Argo/Flux
//     annotations here.
//
// Selection is by the release's own label taxonomy (app.kubernetes.io/name +
// component/version), the same labels deploy's E6 GC sweeps on — never name guessing.
// Idempotent: `kubectl annotate --overwrite` with constant values; re-running is a no-op.
//
// Guard idiom: same as destroy. Cluster contact against an unpinnable context refuses
// without --yes non-interactively, and prompts on a TTY.
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { EXEC_TIMEOUTS, execCapture, execOrThrow } from "./exec.js";
import { infrastructurePath } from "./infrastructure-validation.js";
import { sanitizeForTerminal } from "./terminal.js";
import { resolveK8sNamespace, assertSafeReleaseName } from "../emit/templates/utils.js";
import { keepAtBirthAnnotationEntries } from "../emit/templates/utils.js";
import { INTERNAL_SECRET_COMPONENT } from "../emit/templates/internal-secret.js";
import { ROUTING_MANIFEST_SNAPSHOT_COMPONENT } from "../emit/templates/routing-manifest-configmap.js";
import { COMPOSITION_PLAN_COMPONENT } from "../emit/templates/composition-plan-configmap.js";
import { EXTERNAL_SECRET_COMPONENT } from "../emit/templates/external-secret.js";

export interface MigrateOptions {
  projectDir: string;
  releaseName: string;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * The three keep-at-birth annotations as kubectl `key=value` args. Derived from the SAME
 * single source the chart templates render (keepAtBirthAnnotationEntries) so the migrate
 * path and the render path can never disagree on the annotation set.
 */
export function keepAtBirthAnnotationArgs(): string[] {
  return keepAtBirthAnnotationEntries("")
    .trimEnd()
    .split("\n")
    .map((line) => {
      const idx = line.indexOf(": ");
      return `${line.slice(0, idx)}=${line.slice(idx + 2)}`;
    });
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

/** One annotate sweep: list by label selector, annotate each object found. */
async function annotateByLabel(opts: {
  kind: string;
  labelSelector: string;
  namespace: string;
  dryRun: boolean;
  failures: string[];
}): Promise<string[]> {
  const { kind, labelSelector, namespace, dryRun, failures } = opts;
  const list = await execCapture(
    "kubectl",
    [
      "get",
      kind,
      "-n",
      namespace,
      "-l",
      labelSelector,
      "-o",
      'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    ],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (list.exitCode !== 0) {
    // Fail-closed accounting (N20 family): an unreadable list is NOT "nothing to
    // annotate" — record it so migrate exits nonzero and the operator never enables a
    // pruning reconciler over an unannotated set.
    failures.push(
      `could not list ${kind} (${labelSelector}): ` +
        `${sanitizeForTerminal(list.stderr.trim()) || `kubectl exited ${list.exitCode}`}`,
    );
    return [];
  }
  const names = list.stdout.trim().split("\n").filter(Boolean);
  const annotated: string[] = [];
  for (const name of names) {
    if (dryRun) {
      console.log(
        `  [dry-run] kubectl annotate ${kind} ${name} -n ${namespace} ` +
          `${keepAtBirthAnnotationArgs().join(" ")} --overwrite`,
      );
      annotated.push(`${kind}/${name}`);
      continue;
    }
    const res = await execCapture(
      "kubectl",
      ["annotate", kind, name, "-n", namespace, ...keepAtBirthAnnotationArgs(), "--overwrite"],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (res.exitCode !== 0) {
      failures.push(
        `could not annotate ${kind} ${name}: ` +
          `${sanitizeForTerminal(res.stderr.trim()) || `kubectl exited ${res.exitCode}`}`,
      );
    } else {
      annotated.push(`${kind}/${name}`);
    }
  }
  return annotated;
}

export async function runMigrate(options: MigrateOptions): Promise<void> {
  const { projectDir, releaseName, yes } = options;
  const dryRun = options.dryRun === true;
  assertSafeReleaseName(releaseName);

  const infraPath = infrastructurePath(projectDir);
  const infra: Record<string, string | undefined> = existsSync(infraPath)
    ? JSON.parse(readFileSync(infraPath, "utf-8"))
    : {};
  const namespace = resolveK8sNamespace(infra.namespace);

  // Invariant 6 / destroy's C1 guard, verbatim idiom: pin the kubectl context before any
  // cluster contact; when pinning is impossible (generic/composition targets have no GKE
  // credentials to pin with), surface the current context and refuse without --yes
  // non-interactively. Migrate only ANNOTATES — but annotating the wrong cluster's
  // objects silently "passes" the documented prerequisite while leaving the real
  // cluster unprotected, which is worse than failing.
  const canPinContext = Boolean(infra.projectId && infra.region);
  if (!dryRun && canPinContext) {
    const clusterName = `${releaseName}-cluster`;
    console.log(`\n  → Connecting to GKE cluster "${clusterName}"...`);
    await execOrThrow(
      "gcloud",
      [
        "container",
        "clusters",
        "get-credentials",
        clusterName,
        "--region",
        infra.region!,
        "--project",
        infra.projectId!,
        "--quiet",
      ],
      { timeoutMs: EXEC_TIMEOUTS.cloudOperation },
    );
  } else if (!dryRun && !canPinContext) {
    const ctx = await execCapture("kubectl", ["config", "current-context"], {
      timeoutMs: EXEC_TIMEOUTS.kubectl,
    }).catch(() => null);
    const currentContext = ctx && ctx.exitCode === 0 ? sanitizeForTerminal(ctx.stdout.trim()) : "";
    console.warn(
      `\n  !!! WARNING: infrastructure.json is missing projectId/region, so kubectl could ` +
        `NOT be pinned to this release's cluster.\n` +
        `      The migration annotations will be applied to your CURRENT kubectl context:\n` +
        `      ${currentContext || "(no current context / kubectl unavailable)"}\n`,
    );
    if (!yes) {
      if (!process.stdin.isTTY) {
        throw new Error(
          "Refusing to migrate against an unpinned kubectl context non-interactively. " +
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
          "Migrate aborted: the current kubectl context was not confirmed as the " +
            "intended cluster. Nothing was annotated.",
        );
      }
      console.log("");
    }
  } else if (dryRun) {
    console.log(
      `\n[dry-run] Migration plan for release "${releaseName}" in namespace "${namespace}" — ` +
        `nothing will be annotated. Context pinning is skipped (it would mutate your kubeconfig).`,
    );
  }

  console.log(
    `\n  → Annotating release "${releaseName}"'s retained set with the keep-at-birth ` +
      `prune protections (${keepAtBirthAnnotationArgs().join(", ")})...`,
  );

  const failures: string[] = [];
  const annotated: string[] = [];
  const releaseSelector = `app.kubernetes.io/name=${releaseName}`;

  // Per-build workloads and versioned Services: every Deployment/HPA/Service carrying a
  // version label belongs to a build (parked or serving); the stable active Services
  // carry no version label and are deliberately NOT annotated (they ARE in every
  // bundle's manifest — the reconciler must keep managing them, under the selector
  // ignore rules). The routing Deployment carries a version label too and IS annotated:
  // it is stable-named and in the bundle, so the annotation is inert for prune (never
  // absent from the manifest) — harmless, and simpler than name-excluding it.
  annotated.push(
    ...(await annotateByLabel({
      kind: "deployments",
      labelSelector: `${releaseSelector},app.kubernetes.io/version`,
      namespace,
      dryRun,
      failures,
    })),
    ...(await annotateByLabel({
      kind: "services",
      labelSelector: `${releaseSelector},app.kubernetes.io/version`,
      namespace,
      dryRun,
      failures,
    })),
    ...(await annotateByLabel({
      kind: "horizontalpodautoscalers",
      labelSelector: `${releaseSelector},app.kubernetes.io/version`,
      namespace,
      dryRun,
      failures,
    })),
    // The keep-annotated CM/Secret families (N87 dispatch Secrets, routing-manifest
    // snapshots, composition plans): Helm's `keep` already protects them from `helm
    // upgrade`; the Argo/Flux annotations extend that protection to reconciler prune.
    ...(await annotateByLabel({
      kind: "secrets",
      labelSelector: `${releaseSelector},app.kubernetes.io/component=${INTERNAL_SECRET_COMPONENT}`,
      namespace,
      dryRun,
      failures,
    })),
    ...(await annotateByLabel({
      kind: "configmaps",
      labelSelector: `${releaseSelector},app.kubernetes.io/component=${ROUTING_MANIFEST_SNAPSHOT_COMPONENT}`,
      namespace,
      dryRun,
      failures,
    })),
    ...(await annotateByLabel({
      kind: "configmaps",
      labelSelector: `${releaseSelector},app.kubernetes.io/component=${COMPOSITION_PLAN_COMPONENT}`,
      namespace,
      dryRun,
      failures,
    })),
    // Per-build ExternalSecrets (creationPolicy: Owner): pruning one garbage-collects
    // the dispatch Secret the parked build still mounts.
    ...(await annotateByLabel({
      kind: "externalsecrets",
      labelSelector: `${releaseSelector},app.kubernetes.io/component=${EXTERNAL_SECRET_COMPONENT}`,
      namespace,
      dryRun,
      failures,
    })),
    // The state ConfigMap: kubectl-created (not in any manifest), so a pruning
    // reconciler configured over the namespace would delete the release's only durable
    // deploy state. Same annotations, by exact managed-by label pair.
    ...(await annotateByLabel({
      kind: "configmaps",
      labelSelector: `${releaseSelector},app.kubernetes.io/managed-by=adapter-k8s`,
      namespace,
      dryRun,
      failures,
    })),
  );

  for (const name of annotated) console.log(`    ✓ ${name}`);
  if (annotated.length === 0 && failures.length === 0) {
    console.log(
      `    (nothing found — no per-build objects for release "${releaseName}" in ` +
        `namespace "${namespace}". Has this release ever been deployed here?)`,
    );
  }
  if (failures.length > 0) {
    for (const f of failures) console.error(`  ! ${f}`);
    throw new Error(
      `Migration incomplete: ${failures.length} object(s)/list(s) could not be annotated. ` +
        `Do NOT enable a pruning reconciler over this release until a re-run reports every ` +
        `object annotated — an unannotated parked build is deleted on the first sync.`,
    );
  }
  console.log(
    dryRun
      ? `\n[dry-run] ${annotated.length} object(s) would be annotated.`
      : `\n  ✓ Migration complete: ${annotated.length} object(s) carry the keep-at-birth ` +
          `annotations. The release is safe to manage with a GitOps reconciler ` +
          `(cutover.mode: job bundles annotate new builds at birth from here on).`,
  );
}
