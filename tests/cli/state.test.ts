// tests/cli/state.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readState, writeState, type AdapterState } from '../../src/cli/state.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('state', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'adapter-k8s-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns null when state file does not exist', async () => {
    const state = await readState(tmpDir);
    expect(state).toBeNull();
  });

  it('reads existing state file', async () => {
    const stateDir = path.join(tmpDir, '.k8s-adapter');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, 'state.json'),
      JSON.stringify({ buildId: 'abc123', previousBuildId: null }),
    );
    const state = await readState(tmpDir);
    expect(state).toEqual({ buildId: 'abc123', previousBuildId: null });
  });

  it('writes state file (creates directory if needed)', async () => {
    const state: AdapterState = { buildId: 'def456', previousBuildId: 'abc123' };
    await writeState(tmpDir, state);
    const read = await readState(tmpDir);
    expect(read).toEqual(state);
  });

  it('overwrites existing state', async () => {
    await writeState(tmpDir, { buildId: 'first', previousBuildId: null });
    await writeState(tmpDir, { buildId: 'second', previousBuildId: 'first' });
    const state = await readState(tmpDir);
    expect(state!.buildId).toBe('second');
    expect(state!.previousBuildId).toBe('first');
  });
});
