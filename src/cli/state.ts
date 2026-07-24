// src/cli/state.ts
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execCapture } from "./exec.js";
import { spawn } from "node:child_process";

const STATE_DIR = ".k8s-adapter";
const STATE_FILE = "state.json";
const CONFIGMAP_NAME_SUFFIX = "-adapter-state";
// init binds Workload Identity to [<namespace>/${releaseName}-deploy-sa] with the literal
// namespace "default" — the release (and therefore this ConfigMap) lives there. Pin it:
// reading/writing via whatever namespace the operator's context happens to have can
// silently target the wrong namespace.
const STATE_NAMESPACE = "default";

export interface AdapterState {
  buildId: string;
  previousBuildId: string | null;
  /**
   * M13 (2026-07-22 stale-apex incident): the exact Cache-Tag each build's pool-server
   * stamps on CDN-cacheable responses, keyed by buildId and recorded at that build's
   * deploy. Cutover/rollback invalidation uses the RECORDED tag for the outgoing build —
   * never a re-derivation under the current code, which may not match what the (older)
   * outgoing build's pods actually stamped. Absent key (or absent map, for states written
   * before recording existed) means the outgoing build's tag provenance is unknown and
   * invalidation falls back to a full `--path=/*` purge. Pruned by deploy to the two
   * builds still in play.
   */
  cdnTags?: Record<string, string>;
}

// Thrown when the local file was written but the cluster ConfigMap mirror failed.
// Callers must surface this rather than reporting a clean success — a swallowed
// failure leaves local=new / cluster=old, and readState prefers the ConfigMap,
// which silently corrupts later deploy/rollback build-matching.
export class ClusterStateWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterStateWriteError";
  }
}

// Read state: try cluster ConfigMap first, fall back to local file.
// `localOnly` skips the cluster read entirely — required for dry-run paths (L13: the
// kubectl context may point anywhere, and pinning it would mutate the kubeconfig).
export async function readState(
  projectDir: string,
  releaseName?: string,
  opts?: { localOnly?: boolean },
): Promise<AdapterState | null> {
  if (releaseName && !opts?.localOnly) {
    const clusterState = await readClusterState(releaseName);
    if (clusterState) return clusterState;
  }

  const filePath = path.join(projectDir, STATE_DIR, STATE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

// Write state: write to both cluster ConfigMap and local file.
// Policy: always write the local file first so it reflects the latest intended
// state; then mirror to the cluster ConfigMap. If the cluster write fails we keep
// the freshly-written local file but PROPAGATE the error (ClusterStateWriteError)
// so the caller does not claim a clean success while cluster state is stale.
export async function writeState(
  projectDir: string,
  state: AdapterState,
  releaseName?: string,
): Promise<void> {
  // Write local file atomically (tmp + rename): a crash mid-write previously could
  // leave a truncated state.json that readState then silently treated as "no deploys".
  // No cross-process deploy lockfile, deliberately: commits are single short writes
  // sequenced after cutover, and a lock abandoned by a killed deploy would brick every
  // later deploy until manually removed — a worse failure mode than the lost-update
  // race, which the cluster-side health/cutover gates already serialize in practice.
  const dir = path.join(projectDir, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, STATE_FILE);
  const tmp = path.join(dir, `${STATE_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, target);

  // Write to cluster ConfigMap (throws ClusterStateWriteError on failure)
  if (releaseName) {
    await writeClusterState(releaseName, state);
  }
}

async function readClusterState(releaseName: string): Promise<AdapterState | null> {
  const cmName = `${releaseName}${CONFIGMAP_NAME_SUFFIX}`;
  const result = await execCapture("kubectl", [
    "get",
    "configmap",
    cmName,
    "-n",
    STATE_NAMESPACE,
    "-o",
    "jsonpath={.data.state\\.json}",
  ]).catch(() => null);

  if (!result || result.exitCode !== 0 || !result.stdout.trim()) return null;

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

async function writeClusterState(releaseName: string, state: AdapterState): Promise<void> {
  const cmName = `${releaseName}${CONFIGMAP_NAME_SUFFIX}`;
  const stateJson = JSON.stringify(state);

  // Use kubectl apply with piped YAML — no temp file needed
  const yaml = `apiVersion: v1
kind: ConfigMap
metadata:
  name: ${cmName}
  labels:
    app.kubernetes.io/name: ${releaseName}
    app.kubernetes.io/managed-by: adapter-k8s
data:
  state.json: '${stateJson.replace(/'/g, "''")}'
`;

  return new Promise<void>((resolve, reject) => {
    const child = spawn("kubectl", ["apply", "-n", STATE_NAMESPACE, "-f", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new ClusterStateWriteError(
            `Failed to write cluster state ConfigMap ${cmName}: ${stderr.trim() || `kubectl apply exited ${code}`}`,
          ),
        );
      } else {
        resolve();
      }
    });
    child.on("error", (err) =>
      reject(
        new ClusterStateWriteError(
          `Failed to run kubectl apply for cluster state ConfigMap ${cmName}: ${err.message}`,
        ),
      ),
    );
    child.stdin?.write(yaml);
    child.stdin?.end();
  });
}
