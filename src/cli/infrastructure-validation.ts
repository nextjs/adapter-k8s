// src/cli/infrastructure-validation.ts
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
  namespace?: string | undefined;
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
  if (infra.namespace) assertSafeNamespace(infra.namespace);
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
