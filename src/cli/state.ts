// src/cli/state.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execCapture } from './exec.js';
import { spawn } from 'node:child_process';

const STATE_DIR = '.k8s-adapter';
const STATE_FILE = 'state.json';
const CONFIGMAP_NAME_SUFFIX = '-adapter-state';

export interface AdapterState {
  buildId: string;
  previousBuildId: string | null;
}

// Read state: try cluster ConfigMap first, fall back to local file
export async function readState(projectDir: string, releaseName?: string): Promise<AdapterState | null> {
  if (releaseName) {
    const clusterState = await readClusterState(releaseName);
    if (clusterState) return clusterState;
  }

  const filePath = path.join(projectDir, STATE_DIR, STATE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// Write state: write to both cluster ConfigMap and local file
export async function writeState(projectDir: string, state: AdapterState, releaseName?: string): Promise<void> {
  // Write local file
  const dir = path.join(projectDir, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));

  // Write to cluster ConfigMap
  if (releaseName) {
    await writeClusterState(releaseName, state);
  }
}

async function readClusterState(releaseName: string): Promise<AdapterState | null> {
  const cmName = `${releaseName}${CONFIGMAP_NAME_SUFFIX}`;
  const result = await execCapture('kubectl', [
    'get', 'configmap', cmName,
    '-o', 'jsonpath={.data.state\\.json}',
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

  return new Promise<void>((resolve) => {
    const child = spawn('kubectl', ['apply', '-f', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[adapter-k8s] Failed to write cluster state: ${stderr.trim()}`);
      }
      resolve();
    });
    child.on('error', () => resolve());
    child.stdin?.write(yaml);
    child.stdin?.end();
  });
}
