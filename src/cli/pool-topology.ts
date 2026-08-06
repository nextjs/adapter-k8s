import { execCapture } from "./exec.js";
import type { AdapterState } from "./state.js";
import {
  assertSafeBuildId,
  assertSafePoolName,
  assertSafeReleaseName,
  poolResourceNames,
  resolveK8sNamespace,
  sanitizeK8sName,
} from "../emit/templates/utils.js";

/**
 * Return the exact pool set recorded when a build was deployed.
 *
 * Missing data is a legacy state, not an empty topology. Callers must either recover the
 * topology from build-scoped Kubernetes objects or fail closed; treating it as `[]` lets Helm
 * prune the rollback target.
 */
export function recordedBuildPools(state: AdapterState, buildId: string): string[] | null {
  assertSafeBuildId(buildId);
  const topologies = state.poolTopologies;
  if (topologies === undefined) return null;
  if (!topologies || typeof topologies !== "object" || Array.isArray(topologies)) {
    throw new Error(`Deploy state contains an invalid poolTopologies map.`);
  }
  if (!Object.hasOwn(topologies, buildId)) return null;

  const pools = topologies[buildId];
  if (!Array.isArray(pools) || pools.length === 0) {
    throw new Error(
      `Deploy state contains an invalid pool topology for build "${buildId}". Expected a ` +
        `non-empty array; refusing to treat an unknown topology as an empty build.`,
    );
  }

  const seen = new Set<string>();
  for (const pool of pools) {
    if (typeof pool !== "string") {
      throw new Error(
        `Deploy state contains a non-string pool in the topology for build "${buildId}".`,
      );
    }
    assertSafePoolName(pool);
    if (seen.has(pool)) {
      throw new Error(
        `Deploy state contains duplicate pool "${pool}" in the topology for build ` +
          `"${buildId}".`,
      );
    }
    seen.add(pool);
  }
  return [...pools];
}

/**
 * Migrate a legacy state by reading the build's immutable, versioned Deployments.
 *
 * Resource names are reconstructed from the recorded build id and the component label, then
 * compared with the object Kubernetes returned. This is intentionally stricter than listing
 * stable Services: a stale Service can outlive its build, while a matching versioned Deployment
 * is the rollback artifact itself. No image reference is invented or parsed.
 */
export async function discoverBuildPools(
  releaseName: string,
  buildId: string,
  configuredNamespace?: string,
): Promise<string[]> {
  assertSafeReleaseName(releaseName);
  assertSafeBuildId(buildId);
  const namespace = resolveK8sNamespace(configuredNamespace);
  const version = sanitizeK8sName(buildId);
  const result = await execCapture("kubectl", [
    "get",
    "deployments",
    "-n",
    namespace,
    "-l",
    `app.kubernetes.io/name=${releaseName},app.kubernetes.io/version=${version},` +
      `app.kubernetes.io/component!=routing-service`,
    "-o",
    "json",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not recover the pool topology for build "${buildId}" from Kubernetes ` +
        `(kubectl exited ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}). ` +
        `Refusing to continue: an incomplete topology can delete or strand rollback pools.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(
      `Could not recover the pool topology for build "${buildId}": kubectl returned ` +
        `invalid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `Could not recover the pool topology for build "${buildId}": the Deployment list ` +
        `did not contain an items array.`,
    );
  }

  const pools = new Set<string>();
  for (const item of items as {
    metadata?: { name?: unknown; labels?: Record<string, unknown> };
  }[]) {
    const name = item?.metadata?.name;
    const labels = item?.metadata?.labels;
    const pool = labels?.["app.kubernetes.io/component"];
    const itemVersion = labels?.["app.kubernetes.io/version"];
    if (typeof name !== "string" || typeof pool !== "string" || itemVersion !== version) {
      throw new Error(
        `Could not recover the pool topology for build "${buildId}": a selected Deployment ` +
          `is missing its exact name, component, or version label.`,
      );
    }
    assertSafePoolName(pool);
    const expected = poolResourceNames(releaseName, pool, buildId).deployment;
    if (name !== expected) {
      throw new Error(
        `Could not recover the pool topology for build "${buildId}": Deployment ` +
          `"${name}" claims pool "${pool}", but the adapter-derived name is ` +
          `"${expected}". Refusing to trust inconsistent labels.`,
      );
    }
    if (pools.has(pool)) {
      throw new Error(
        `Could not recover the pool topology for build "${buildId}": more than one ` +
          `Deployment claims pool "${pool}".`,
      );
    }
    pools.add(pool);
  }

  if (pools.size === 0) {
    throw new Error(
      `Could not recover any pool Deployment for build "${buildId}" in namespace ` +
        `"${namespace}". Refusing to continue: the rollback topology is unknown.`,
    );
  }
  return [...pools].sort();
}
