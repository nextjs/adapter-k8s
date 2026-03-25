// src/cli/state.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const STATE_DIR = '.k8s-adapter';
const STATE_FILE = 'state.json';

export interface AdapterState {
  buildId: string;
  previousBuildId: string | null;
}

export function readState(projectDir: string): AdapterState | null {
  const filePath = path.join(projectDir, STATE_DIR, STATE_FILE);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function writeState(projectDir: string, state: AdapterState): void {
  const dir = path.join(projectDir, STATE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}
