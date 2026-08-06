import { execCapture } from "./exec.js";
import {
  assertSafePoolName,
  assertSafeReleaseName,
  resolveK8sNamespace,
  stablePoolResourceNames,
} from "../emit/templates/utils.js";

export const RETAINED_STABLE_POOL_LABEL = "adapter-k8s.dev/release";
const KEEP_ANNOTATION = "helm.sh/resource-policy";
const KEEP_VALUE = "keep";
const GKE_HCP_CRD = "healthcheckpolicies.networking.gke.io";

type StableKind = "service" | "poddisruptionbudget" | "healthcheckpolicy";

interface StableResource {
  kind: StableKind;
  name: string;
  pool: string;
  resourceVersion: string;
  object: Record<string, unknown>;
}

const typeForKind: Record<StableKind, string> = {
  service: "service",
  poddisruptionbudget: "poddisruptionbudget",
  healthcheckpolicy: "healthcheckpolicy",
};

function expectedName(releaseName: string, pool: string, kind: StableKind): string {
  const names = stablePoolResourceNames(releaseName, pool);
  if (kind === "service") return names.service;
  if (kind === "poddisruptionbudget") return names.pdb;
  return names.hcp;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validateStableResource(
  value: unknown,
  kind: StableKind,
  releaseName: string,
  pool: string,
  namespace: string,
  requireRetainedLabel = false,
): StableResource {
  assertSafeReleaseName(releaseName);
  assertSafePoolName(pool);
  const object = objectRecord(value);
  const metadata = objectRecord(object?.metadata);
  const labels = objectRecord(metadata?.labels);
  const annotations = objectRecord(metadata?.annotations);
  const name = metadata?.name;
  const resourceVersion = metadata?.resourceVersion;
  const wantedName = expectedName(releaseName, pool, kind);
  if (name !== wantedName || typeof resourceVersion !== "string" || !resourceVersion) {
    throw new Error(
      `Stable ${kind} identity mismatch for pool "${pool}": expected name ` +
        `"${wantedName}" with a resourceVersion, got ${JSON.stringify(name ?? null)}.`,
    );
  }

  const helmRelease = annotations?.["meta.helm.sh/release-name"];
  const helmNamespace = annotations?.["meta.helm.sh/release-namespace"];
  if (helmRelease !== releaseName || helmNamespace !== namespace) {
    throw new Error(
      `Stable ${kind} ${wantedName} has foreign Helm ownership ` +
        `(release=${JSON.stringify(helmRelease ?? null)}, namespace=${JSON.stringify(helmNamespace ?? null)}).`,
    );
  }
  if (requireRetainedLabel && labels?.[RETAINED_STABLE_POOL_LABEL] !== releaseName) {
    throw new Error(
      `Stable ${kind} ${wantedName} is missing retained-resource ownership label ` +
        `${RETAINED_STABLE_POOL_LABEL}=${releaseName}.`,
    );
  }

  // Service/PDB have always carried these labels. HCPs emitted before N70 did not, so their
  // exact targetRef below is the migration identity and the transfer patch stamps the labels.
  const labeledRelease = labels?.["app.kubernetes.io/name"];
  const labeledPool = labels?.["app.kubernetes.io/component"];
  if (kind !== "healthcheckpolicy" || labeledRelease !== undefined || labeledPool !== undefined) {
    if (labeledRelease !== releaseName || labeledPool !== pool) {
      throw new Error(
        `Stable ${kind} ${wantedName} has inconsistent release/pool labels ` +
          `(${JSON.stringify(labeledRelease ?? null)}/${JSON.stringify(labeledPool ?? null)}).`,
      );
    }
  }

  const spec = objectRecord(object?.spec);
  if (kind === "service") {
    const selector = objectRecord(spec?.selector);
    if (
      selector?.["app.kubernetes.io/name"] !== releaseName ||
      selector?.["app.kubernetes.io/component"] !== pool
    ) {
      throw new Error(`Stable Service ${wantedName} does not select pool "${pool}".`);
    }
  } else if (kind === "poddisruptionbudget") {
    const selector = objectRecord(objectRecord(spec?.selector)?.matchLabels);
    if (
      selector?.["app.kubernetes.io/name"] !== releaseName ||
      selector?.["app.kubernetes.io/component"] !== pool
    ) {
      throw new Error(`Stable PodDisruptionBudget ${wantedName} does not select pool "${pool}".`);
    }
  } else {
    const targetRef = objectRecord(spec?.targetRef);
    if (
      targetRef?.kind !== "Service" ||
      targetRef?.name !== stablePoolResourceNames(releaseName, pool).service
    ) {
      throw new Error(
        `Stable HealthCheckPolicy ${wantedName} does not target the pool's stable Service.`,
      );
    }
  }

  return { kind, name: wantedName, pool, resourceVersion, object: object! };
}

async function readExact(
  kind: StableKind,
  name: string,
  namespace: string,
): Promise<{ status: "absent" } | { status: "read"; value: unknown }> {
  const result = await execCapture("kubectl", [
    "get",
    typeForKind[kind],
    name,
    "-n",
    namespace,
    "--ignore-not-found",
    "-o",
    "json",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read ${kind} ${name} (kubectl exited ${result.exitCode}` +
        `${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}).`,
    );
  }
  if (!result.stdout.trim()) return { status: "absent" };
  try {
    return { status: "read", value: JSON.parse(result.stdout) };
  } catch (err) {
    throw new Error(
      `Could not parse ${kind} ${name}: ` + `${err instanceof Error ? err.message : String(err)}.`,
    );
  }
}

/** Whether this cluster can contain GKE HealthCheckPolicy resources. */
export async function hasHealthCheckPolicyCrd(): Promise<boolean> {
  const result = await execCapture("kubectl", [
    "get",
    "crd",
    GKE_HCP_CRD,
    "--ignore-not-found",
    "-o",
    "name",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not determine whether the ${GKE_HCP_CRD} CRD exists (kubectl exited ` +
        `${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}).`,
    );
  }
  return result.stdout.trim() !== "";
}

/** Transfer every live stable object for a removed pool out of Helm's deletion set. */
export async function retainRemovedPoolResources(options: {
  releaseName: string;
  pool: string;
  namespace?: string;
  healthCheckPolicyCrd: boolean;
}): Promise<StableKind[]> {
  const { releaseName, pool, healthCheckPolicyCrd } = options;
  const namespace = resolveK8sNamespace(options.namespace);
  const names = stablePoolResourceNames(releaseName, pool);
  // Exhaustive stable per-pool set: renderActiveService emits Service + PDB + optional GKE HCP.
  // Deployments, versioned Services, and HPAs are build-scoped; Gateway/HTTPRoute, routing tier,
  // cache, and NetworkPolicies are release-scoped rather than pool-scoped.
  const candidates: Array<{ kind: StableKind; name: string; required: boolean }> = [
    { kind: "service", name: names.service, required: true },
    { kind: "poddisruptionbudget", name: names.pdb, required: false },
    ...(healthCheckPolicyCrd
      ? [{ kind: "healthcheckpolicy" as const, name: names.hcp, required: false }]
      : []),
  ];
  const retained: StableKind[] = [];
  for (const candidate of candidates) {
    const read = await readExact(candidate.kind, candidate.name, namespace);
    if (read.status === "absent") {
      if (candidate.required) {
        throw new Error(
          `Required stable Service ${candidate.name} for removed pool "${pool}" is missing. ` +
            `Rollback requires that exact DNS/backend identity.`,
        );
      }
      continue;
    }
    const resource = validateStableResource(
      read.value,
      candidate.kind,
      releaseName,
      pool,
      namespace,
    );
    const patch = await execCapture("kubectl", [
      "patch",
      typeForKind[resource.kind],
      resource.name,
      "-n",
      namespace,
      "--type=merge",
      "-p",
      JSON.stringify({
        metadata: {
          resourceVersion: resource.resourceVersion,
          labels: {
            "app.kubernetes.io/name": releaseName,
            "app.kubernetes.io/component": pool,
            [RETAINED_STABLE_POOL_LABEL]: releaseName,
          },
          annotations: { [KEEP_ANNOTATION]: KEEP_VALUE },
        },
      }),
    ]);
    if (patch.exitCode !== 0) {
      throw new Error(
        `Could not retain stable ${resource.kind} ${resource.name} for removed pool ` +
          `"${pool}": ${patch.stderr.trim() || `kubectl exited ${patch.exitCode}`}.`,
      );
    }
    retained.push(resource.kind);
  }
  return retained;
}

export interface StablePoolCleanupResult {
  deleted: string[];
  failures: string[];
}

/**
 * Delete retained stable objects whose pools are outside the current+rollback topology.
 * Every candidate is label-selected, then exact-name/spec/Helm-ownership validated before any
 * delete. Service is deleted last so a partial companion failure leaves an anchor for retry.
 */
export async function cleanupRetainedStablePoolResources(options: {
  releaseName: string;
  keepPools: Iterable<string>;
  namespace?: string;
  healthCheckPolicyCrd: boolean;
}): Promise<StablePoolCleanupResult> {
  const { releaseName, healthCheckPolicyCrd } = options;
  assertSafeReleaseName(releaseName);
  const namespace = resolveK8sNamespace(options.namespace);
  const keepPools = new Set(options.keepPools);
  for (const pool of keepPools) assertSafePoolName(pool);
  const kinds: StableKind[] = [
    "service",
    "poddisruptionbudget",
    ...(healthCheckPolicyCrd ? (["healthcheckpolicy"] as const) : []),
  ];
  const resources: StableResource[] = [];
  const failures: string[] = [];
  for (const kind of kinds) {
    const list = await execCapture("kubectl", [
      "get",
      typeForKind[kind],
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${releaseName},${RETAINED_STABLE_POOL_LABEL}=${releaseName}`,
      "-o",
      "json",
    ]);
    if (list.exitCode !== 0) {
      failures.push(
        `could not list retained ${kind} objects: ` +
          `${list.stderr.trim() || `kubectl exited ${list.exitCode}`}`,
      );
      continue;
    }
    let items: unknown;
    try {
      items = JSON.parse(list.stdout).items;
    } catch (err) {
      failures.push(
        `could not parse retained ${kind} objects: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (!Array.isArray(items)) {
      failures.push(`retained ${kind} list did not contain an items array`);
      continue;
    }
    for (const item of items) {
      const labels = objectRecord(objectRecord(item)?.metadata)?.labels;
      const pool = objectRecord(labels)?.["app.kubernetes.io/component"];
      if (typeof pool !== "string" || pool === "routing-service") {
        failures.push(`retained ${kind} candidate is missing a non-routing pool component`);
        continue;
      }
      try {
        const resource = validateStableResource(item, kind, releaseName, pool, namespace, true);
        if (!keepPools.has(pool)) resources.push(resource);
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // A suspicious candidate or incomplete kind listing makes classification incomplete. Delete
  // nothing; a leak is recoverable, deleting a foreign/live pool object is not.
  if (failures.length > 0) return { deleted: [], failures };

  const byPool = new Map<string, StableResource[]>();
  for (const resource of resources) {
    const bucket = byPool.get(resource.pool) ?? [];
    if (bucket.some((entry) => entry.kind === resource.kind)) {
      failures.push(`duplicate retained ${resource.kind} for pool "${resource.pool}"`);
      continue;
    }
    bucket.push(resource);
    byPool.set(resource.pool, bucket);
  }
  if (failures.length > 0) return { deleted: [], failures };

  const deleted: string[] = [];
  for (const [, poolResources] of byPool) {
    const ordered = [...poolResources].sort((a, b) => {
      const order: Record<StableKind, number> = {
        healthcheckpolicy: 0,
        poddisruptionbudget: 1,
        service: 2,
      };
      return order[a.kind] - order[b.kind];
    });
    let companionFailed = false;
    for (const resource of ordered) {
      if (resource.kind === "service" && companionFailed) continue;
      const result = await execCapture("kubectl", [
        "delete",
        typeForKind[resource.kind],
        resource.name,
        "-n",
        namespace,
        "--ignore-not-found",
      ]);
      if (result.exitCode !== 0) {
        failures.push(
          `could not delete retained ${resource.kind} ${resource.name}: ` +
            `${result.stderr.trim() || `kubectl exited ${result.exitCode}`}`,
        );
        if (resource.kind !== "service") companionFailed = true;
      } else {
        deleted.push(`${resource.kind}/${resource.name}`);
      }
    }
  }
  return { deleted, failures };
}
