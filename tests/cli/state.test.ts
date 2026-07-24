// tests/cli/state.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/cli/exec.js");

import {
  readState,
  writeState,
  ClusterStateWriteError,
  type AdapterState,
} from "../../src/cli/state.js";
import { execCapture } from "../../src/cli/exec.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when state file does not exist", async () => {
    const state = await readState(tmpDir);
    expect(state).toBeNull();
  });

  it("reads existing state file", async () => {
    const stateDir = path.join(tmpDir, ".k8s-adapter");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ buildId: "abc123", previousBuildId: null }),
    );
    const state = await readState(tmpDir);
    expect(state).toEqual({ buildId: "abc123", previousBuildId: null });
  });

  it("writes state file (creates directory if needed)", async () => {
    const state: AdapterState = { buildId: "def456", previousBuildId: "abc123" };
    await writeState(tmpDir, state);
    const read = await readState(tmpDir);
    expect(read).toEqual(state);
  });

  it("overwrites existing state", async () => {
    await writeState(tmpDir, { buildId: "first", previousBuildId: null });
    await writeState(tmpDir, { buildId: "second", previousBuildId: "first" });
    const state = await readState(tmpDir);
    expect(state!.buildId).toBe("second");
    expect(state!.previousBuildId).toBe("first");
  });

  it("M13: round-trips recorded per-build CDN tags", async () => {
    const state: AdapterState = {
      buildId: "buildn",
      previousBuildId: "buildm",
      cdnTags: { buildn: `build-${"ab".repeat(32)}`, buildm: `build-${"cd".repeat(32)}` },
    };
    await writeState(tmpDir, state);
    expect(await readState(tmpDir)).toEqual(state);
  });

  it("M13: reads legacy state without cdnTags (pre-recording deploys)", async () => {
    const stateDir = path.join(tmpDir, ".k8s-adapter");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ buildId: "abc123", previousBuildId: null }),
    );
    const state = await readState(tmpDir);
    expect(state).toEqual({ buildId: "abc123", previousBuildId: null });
    expect(state!.cdnTags).toBeUndefined();
  });

  it("writes the local file even when no releaseName is given (no cluster mirror)", async () => {
    const state: AdapterState = { buildId: "local-only", previousBuildId: null };
    // Without a releaseName the cluster ConfigMap is never touched, so this must not throw.
    await expect(writeState(tmpDir, state)).resolves.toBeUndefined();
    expect(await readState(tmpDir)).toEqual(state);
  });

  it("exposes ClusterStateWriteError as an Error subclass for callers to surface", () => {
    const err = new ClusterStateWriteError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClusterStateWriteError");
  });

  it("leaves no .tmp file behind after an atomic write", async () => {
    await writeState(tmpDir, { buildId: "atomic", previousBuildId: null });
    const files = readdirSync(path.join(tmpDir, ".k8s-adapter"));
    expect(files).toEqual(["state.json"]);
    expect(existsSync(path.join(tmpDir, ".k8s-adapter", "state.json.tmp"))).toBe(false);
  });

  it("L13: localOnly reads skip the cluster ConfigMap even with a releaseName", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ buildId: "cluster-build", previousBuildId: null }),
      stderr: "",
    });
    const stateDir = path.join(tmpDir, ".k8s-adapter");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      path.join(stateDir, "state.json"),
      JSON.stringify({ buildId: "local-build", previousBuildId: null }),
    );

    const local = await readState(tmpDir, "rel", { localOnly: true });
    expect(local!.buildId).toBe("local-build");
    expect(execCapture).not.toHaveBeenCalled();

    const cluster = await readState(tmpDir, "rel");
    expect(cluster!.buildId).toBe("cluster-build");
    // ...and the cluster read is pinned to the namespace init binds Workload Identity to.
    expect(vi.mocked(execCapture).mock.calls[0]![1]).toContain("default");
  });
});
