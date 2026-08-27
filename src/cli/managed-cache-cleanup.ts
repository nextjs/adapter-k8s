import { writeFileSync } from "node:fs";
import { deleteManagedCacheIdentityArgs } from "./cache-identity.js";
import { isAlreadyGoneError } from "./deletion-outcome.js";
import { EXEC_TIMEOUTS, execCapture } from "./exec.js";
import { sanitizeForTerminal } from "./terminal.js";

interface ManagedCacheInfrastructureState {
  cacheProjectId?: string;
  cacheRegion?: string;
  cacheProvisioningPending?: string;
}

interface ManagedCacheDeleteCommand {
  command: string;
  args: string[];
  desc: string;
}

export type ManagedCacheCleanupResult =
  | { status: "cleared"; cloudAlreadyAbsent: boolean }
  | { status: "cloud-delete-failed"; detail: string }
  | { status: "identity-delete-failed"; detail: string };

/**
 * Finish one managed-cache deletion in recovery-safe order.
 *
 * The local coordinates are the retry authority after a cloud timeout or cluster RBAC failure.
 * Clear them only after the provider confirms the instance is gone and Kubernetes confirms the
 * coordination claim is gone. Repeating this sequence is safe because provider absence counts as
 * a confirmed cloud deletion.
 */
export async function cleanupManagedCache(options: {
  releaseName: string;
  namespace: string;
  deletion: ManagedCacheDeleteCommand;
  infrastructure?: ManagedCacheInfrastructureState;
  infrastructurePath?: string;
}): Promise<ManagedCacheCleanupResult> {
  const cloudDelete = await execCapture(options.deletion.command, options.deletion.args, {
    timeoutMs: EXEC_TIMEOUTS.cloudOperation,
  });
  const cloudAlreadyAbsent = cloudDelete.exitCode !== 0 && isAlreadyGoneError(cloudDelete.stderr);
  if (cloudDelete.exitCode !== 0 && !cloudAlreadyAbsent) {
    return {
      status: "cloud-delete-failed",
      detail: sanitizeForTerminal(cloudDelete.stderr.trim()) || `exit ${cloudDelete.exitCode}`,
    };
  }

  const identityDelete = await execCapture(
    "kubectl",
    deleteManagedCacheIdentityArgs(options.releaseName, options.namespace),
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (identityDelete.exitCode !== 0 && !isAlreadyGoneError(identityDelete.stderr)) {
    return {
      status: "identity-delete-failed",
      detail:
        sanitizeForTerminal(identityDelete.stderr.trim()) || `exit ${identityDelete.exitCode}`,
    };
  }

  if (options.infrastructure && options.infrastructurePath) {
    delete options.infrastructure.cacheRegion;
    delete options.infrastructure.cacheProjectId;
    delete options.infrastructure.cacheProvisioningPending;
    writeFileSync(options.infrastructurePath, JSON.stringify(options.infrastructure, null, 2));
  }
  return { status: "cleared", cloudAlreadyAbsent };
}
