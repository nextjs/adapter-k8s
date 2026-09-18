import { execCapture, EXEC_TIMEOUTS } from "../cli/exec.js";
import {
  assertSafeBuildId,
  assertSafeNamespace,
  assertSafePoolName,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import { RETENTION_EXPIRY_ANNOTATION } from "../retention-expiry.js";

/** Renewing the marker fences cleanup; a crashed rollback still has a finite recovery window. */
export async function setRetentionExpiry(
  release: string,
  namespace: string,
  buildId: string,
  pools: string[],
  expiresAt: number,
  allowMissing = false,
): Promise<void> {
  assertSafeReleaseName(release);
  assertSafeNamespace(namespace);
  assertSafeBuildId(buildId);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    throw new Error("Invalid retention expiry");
  for (const pool of pools) {
    assertSafePoolName(pool);
    const name = sanitizeK8sName(`${release}-${pool}-${buildId}`);
    const result = await execCapture(
      "kubectl",
      [
        "patch",
        "deployment",
        name,
        "-n",
        namespace,
        "--type=merge",
        "-p",
        JSON.stringify({
          metadata: {
            annotations: {
              [RETENTION_EXPIRY_ANNOTATION]: JSON.stringify({ buildId, expiresAt }),
            },
          },
        }),
      ],
      { timeoutMs: EXEC_TIMEOUTS.kubectl },
    );
    if (result.exitCode !== 0) {
      // A plain GitOps Job can start before its Deployment exists. No old cleanup
      // snapshot can affect a future object with a different UID; D1 still waits for it.
      if (allowMissing) {
        const existing = await execCapture(
          "kubectl",
          ["get", "deployment", name, "-n", namespace, "--ignore-not-found", "-o", "name"],
          { timeoutMs: EXEC_TIMEOUTS.kubectl },
        );
        if (existing.exitCode === 0 && !existing.stdout.trim()) continue;
      }
      throw new Error(`Could not arm retention expiry for ${name}`);
    }
  }
}

export async function protectRetentionBuild(
  release: string,
  namespace: string,
  buildId: string,
  pools: string[],
): Promise<void> {
  await setRetentionExpiry(release, namespace, buildId, pools, Date.now() + 3_600_000, true);
}
