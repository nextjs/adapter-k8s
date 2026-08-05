// src/cli/infrastructure-validation.ts
import path from "node:path";
import { existsSync } from "node:fs";
import {
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
} from "../emit/templates/utils.js";

/** The infrastructure.json fields that reach a subprocess argv. */
export interface InfrastructureArgvFields {
  projectId?: string | undefined;
  region?: string | undefined;
  namespace?: unknown;
  containerRegistry?: string | undefined;
  gcsBucket?: string | undefined;
  cacheRegion?: string | undefined;
  clusterName?: string | undefined;
}

/**
 * S13 (SECURITY). Validate every infrastructure.json value that reaches a `gcloud`/`kubectl`/
 * `helm` argv, at the point it is read.
 *
 * `deploy` and `init` already did this; `destroy`, `describe`, `doctor`, `tail` and `rollback`
 * spliced `projectId`, `region`, `gcsBucket`, `containerRegistry` and `cacheRegion` straight
 * into argv with no checks at all. On POSIX that is inert — everything goes through execFile
 * with `shell: false`, so a metacharacter is one literal argv token. On WINDOWS it is not:
 * `gcloud` resolves to `gcloud.cmd` and a `.cmd` shim can re-parse metacharacters out of its
 * arguments. So a poisoned checkout (a PR that un-ignores `.k8s-adapter/` and writes
 * `projectId: "x&calc"`) plus an operator running any of the READ-ONLY commands — the ones
 * you reach for first, and the ones that skipped validation — was command execution under
 * their GCP credentials. `deploy` would have rejected the same file.
 *
 * Fields are optional because these commands tolerate a partial file (they degrade to
 * unpinned behavior with their own warnings); a PRESENT value must always be well-formed.
 */
export function assertSafeInfrastructure(infra: InfrastructureArgvFields | null | undefined): void {
  if (!infra) return;
  if (infra.projectId) assertSafeProjectId(infra.projectId);
  if (infra.region) assertSafeRegion(infra.region);
  if (infra.namespace !== undefined) assertSafeNamespace(infra.namespace);
  if (infra.containerRegistry) assertSafeImageRegistry(infra.containerRegistry);
  // A region-shaped value; same charset as `region` (lowercase alnum + hyphen).
  if (infra.cacheRegion) assertSafeRegion(infra.cacheRegion);
  // GCS bucket and GKE cluster names: DNS-ish labels. Reject anything that could be argv
  // metacharacters, a flag ("--foo"), or path traversal.
  for (const [field, value] of [
    ["gcsBucket", infra.gcsBucket],
    ["clusterName", infra.clusterName],
  ] as const) {
    if (!value) continue;
    if (!/^[a-z0-9][a-z0-9._-]{0,61}[a-z0-9]$/.test(value)) {
      throw new Error(
        `Unsafe infrastructure.json ${field} ${JSON.stringify(value)}: expected lowercase ` +
          `alphanumerics with "." "_" "-" separators. This value is passed to gcloud/kubectl.`,
      );
    }
  }
}

/**
 * Path to the release's infrastructure.json, honouring the ADAPTER_K8S_CONFIG variant.
 *
 * One project often targets more than one cluster — GKE and a generic cluster, say — and each
 * needs its own registry and release identity. Swapping a single infrastructure.json between
 * them makes the file that decides WHERE a deploy goes into mutable global state, and forgetting
 * to restore it is silent right up until something deploys somewhere unintended. Variants let
 * both live side by side: `infrastructure.scaleway.json` beside `infrastructure.json`.
 *
 * The variant is validated in adapter.ts as a bare name (never a path), so it cannot escape the
 * `.k8s-adapter` directory. Falls back to the unsuffixed file when no variant file exists, so an
 * existing single-target project is unaffected.
 */
export function infrastructurePath(projectDir: string): string {
  const scoped = infrastructureWritePath(projectDir);
  const variant = process.env.ADAPTER_K8S_CONFIG?.trim();
  if (!variant) return scoped;
  // NO FALLBACK. Falling back was a cross-wiring hazard: the adapter loads
  // adapter.config.<variant>.mjs while this returned the DEFAULT infrastructure.json, so a
  // half-present variant built config A against infrastructure B — a deploy aimed at one
  // cluster pushing to another cluster's registry, with nothing in the output saying so.
  // A requested variant must be complete or the deploy stops.
  if (!existsSync(scoped)) {
    throw new Error(
      `ADAPTER_K8S_CONFIG=${variant} was requested but ${scoped} does not exist. A variant must ` +
        `provide BOTH adapter.config.${variant}.mjs and .k8s-adapter/infrastructure.${variant}.json` +
        ` — falling back to the default target would build one cluster's config against ` +
        `another's infrastructure. Create the file, or unset ADAPTER_K8S_CONFIG.`,
    );
  }
  return scoped;
}

/**
 * Path where init writes infrastructure state. Unlike infrastructurePath(), this permits a
 * selected variant not to exist yet because creating it is init's job.
 */
export function infrastructureWritePath(projectDir: string): string {
  const variant = process.env.ADAPTER_K8S_CONFIG?.trim();
  const base = path.join(projectDir, ".k8s-adapter");
  if (!variant) return path.join(base, "infrastructure.json");
  if (!/^[a-z0-9][-a-z0-9_]*$/i.test(variant)) {
    throw new Error(
      `ADAPTER_K8S_CONFIG=${JSON.stringify(variant)} is not a valid variant name. Use a bare ` +
        `name like "scaleway"; it is interpolated into a filename, so a path is refused.`,
    );
  }
  return path.join(base, `infrastructure.${variant}.json`);
}

/**
 * Path to the deploy-state file, scoped to the variant.
 *
 * State carries `buildId`/`previousBuildId`/`generation`, and the chart's `activeBuildId` is
 * derived from it. Sharing one file across targets means a higher generation from target A can
 * supply target B's activeBuildId — which repoints B's Services at a build that only ever
 * existed on A, during `helm upgrade`, before any readiness gate runs.
 */
export function stateFileName(): string {
  const variant = process.env.ADAPTER_K8S_CONFIG?.trim();
  if (variant && /^[a-z0-9][-a-z0-9_]*$/i.test(variant)) return `state.${variant}.json`;
  return "state.json";
}

/**
 * The build-output directory, scoped to the variant.
 *
 * `.k8s-adapter/output` holds the emitted chart, and the routing tier's image registry is baked
 * into its Deployment template at BUILD time — so a chart is only valid for the target it was
 * emitted for. Sharing one directory across variants meant `--skip-build` deployed whichever
 * target built last: MEASURED, a Scaleway deploy reused a GKE chart and its routing pods went
 * ImagePullBackOff with a 403 against Artifact Registry, after helm had already applied.
 *
 * A fingerprint check in deploy.ts still catches a mismatch (belt and braces, and it covers
 * pre-existing output that predates this scoping). Scoping is what makes switching targets not
 * require a rebuild.
 */
export function outputDirName(): string {
  const variant = process.env.ADAPTER_K8S_CONFIG?.trim();
  if (variant && /^[a-z0-9][-a-z0-9_]*$/i.test(variant)) return `output.${variant}`;
  return "output";
}
