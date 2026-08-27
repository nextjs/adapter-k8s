import { EXEC_TIMEOUTS, execCapture, execCaptureStdin } from "./exec.js";
import { sanitizeForTerminal } from "./terminal.js";
import {
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
} from "../emit/templates/utils.js";

export const MANAGED_CACHE_IDENTITY_COMPONENT = "managed-cache-identity";

export interface ManagedCacheIdentity {
  projectId: string;
  region: string;
}

export function managedCacheIdentityName(releaseName: string): string {
  assertSafeReleaseName(releaseName);
  return `${releaseName}-cache-identity`;
}

function validateIdentity(identity: ManagedCacheIdentity): void {
  assertSafeProjectId(identity.projectId);
  assertSafeRegion(identity.region);
}

/**
 * Read the cluster-side identity that serializes paid cache creation across deploy hosts.
 * Its values are coordination state, not cloud authorization: callers still compare them with
 * the authenticated composition plan before executing a GCP operation.
 */
export async function readManagedCacheIdentity(
  releaseName: string,
  namespace: string,
): Promise<ManagedCacheIdentity | null> {
  const name = managedCacheIdentityName(releaseName);
  assertSafeNamespace(namespace);
  const result = await execCapture(
    "kubectl",
    ["get", "configmap", name, "-n", namespace, "--ignore-not-found", "-o", "json"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Could not read managed-cache identity ConfigMap ${name}: ` +
        `${sanitizeForTerminal(result.stderr.trim()) || `kubectl exited ${result.exitCode}`}`,
    );
  }
  if (!result.stdout.trim()) return null;

  let object: {
    metadata?: { labels?: Record<string, unknown> };
    data?: Record<string, unknown>;
  };
  try {
    object = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Managed-cache identity ConfigMap ${name} returned invalid JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const labels = object.metadata?.labels;
  if (
    labels?.["app.kubernetes.io/name"] !== releaseName ||
    labels?.["app.kubernetes.io/component"] !== MANAGED_CACHE_IDENTITY_COMPONENT ||
    labels?.["adapter-k8s.dev/release"] !== releaseName
  ) {
    throw new Error(
      `ConfigMap ${name} has foreign or incomplete ownership metadata; refusing to use it ` +
        `to coordinate paid cache infrastructure.`,
    );
  }
  const projectId = object.data?.projectId;
  const region = object.data?.region;
  if (typeof projectId !== "string" || typeof region !== "string") {
    throw new Error(`Managed-cache identity ConfigMap ${name} has incomplete coordinates.`);
  }
  const identity = { projectId, region };
  validateIdentity(identity);
  return identity;
}

function assertSameIdentity(
  name: string,
  existing: ManagedCacheIdentity,
  expected: ManagedCacheIdentity,
): void {
  if (existing.projectId !== expected.projectId || existing.region !== expected.region) {
    throw new Error(
      `Managed-cache identity ${name} already claims ${existing.projectId}/${existing.region}; ` +
        `this plan requests ${expected.projectId}/${expected.region}. Refusing to create a ` +
        `second regional instance for one release. Destroy the existing cache intentionally ` +
        `before changing coordinates.`,
    );
  }
}

/**
 * Atomically claim one project/region for the release. `kubectl create` supplies the compare-and-
 * set: concurrent deploy hosts may share the same claim, but a different coordinate loses before
 * either host calls GCP.
 */
export async function claimManagedCacheIdentity(
  releaseName: string,
  namespace: string,
  expected: ManagedCacheIdentity,
): Promise<void> {
  const name = managedCacheIdentityName(releaseName);
  assertSafeNamespace(namespace);
  validateIdentity(expected);
  const existing = await readManagedCacheIdentity(releaseName, namespace);
  if (existing) {
    assertSameIdentity(name, existing, expected);
    return;
  }

  const created = await execCaptureStdin(
    "kubectl",
    ["create", "-f", "-"],
    JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name,
        namespace,
        labels: {
          "app.kubernetes.io/name": releaseName,
          "app.kubernetes.io/component": MANAGED_CACHE_IDENTITY_COMPONENT,
          "adapter-k8s.dev/release": releaseName,
        },
      },
      data: { projectId: expected.projectId, region: expected.region },
    }),
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (created.exitCode === 0) return;
  if (!/alreadyexists|already exists/i.test(created.stderr)) {
    throw new Error(
      `Could not claim managed-cache identity ${name}: ` +
        `${sanitizeForTerminal(created.stderr.trim()) || `kubectl exited ${created.exitCode}`}`,
    );
  }

  const raced = await readManagedCacheIdentity(releaseName, namespace);
  if (!raced) {
    throw new Error(
      `Managed-cache identity ${name} was created concurrently but could not be read back. ` +
        `Refusing to provision paid infrastructure.`,
    );
  }
  assertSameIdentity(name, raced, expected);
}

export function deleteManagedCacheIdentityArgs(releaseName: string, namespace: string): string[] {
  assertSafeReleaseName(releaseName);
  assertSafeNamespace(namespace);
  return [
    "delete",
    "configmap",
    managedCacheIdentityName(releaseName),
    "-n",
    namespace,
    "--ignore-not-found",
  ];
}
