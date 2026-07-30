// tests/cli/state.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/cli/exec.js");

import {
  readState,
  writeState,
  ClusterStateWriteError,
  ClusterStateReadError,
  LocalStateReadError,
  StateDisagreementError,
  StateUnavailableError,
  type AdapterState,
} from "../../src/cli/state.js";
import { execCapture, execCaptureStdin } from "../../src/cli/exec.js";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
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
    await writeState(tmpDir, { ...state, basedOnGeneration: null });
    const read = await readState(tmpDir);
    // N21: every write stamps a monotonic generation + updatedAt on top of the payload.
    expect(read).toMatchObject(state);
    expect(read!.generation).toBe(1);
  });

  it("overwrites existing state", async () => {
    await writeState(tmpDir, { buildId: "first", previousBuildId: null, basedOnGeneration: null });
    await writeState(tmpDir, {
      buildId: "second",
      previousBuildId: "first",
      basedOnGeneration: 1,
    });
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
    await writeState(tmpDir, { ...state, basedOnGeneration: null });
    expect(await readState(tmpDir)).toMatchObject(state);
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
    await expect(
      writeState(tmpDir, { ...state, basedOnGeneration: null }),
    ).resolves.toBeUndefined();
    expect(await readState(tmpDir)).toMatchObject(state);
    expect(execCapture).not.toHaveBeenCalled();
    expect(execCaptureStdin).not.toHaveBeenCalled();
  });

  it("exposes ClusterStateWriteError as an Error subclass for callers to surface", () => {
    const err = new ClusterStateWriteError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ClusterStateWriteError");
  });

  it("leaves no .tmp file behind after an atomic write", async () => {
    await writeState(tmpDir, { buildId: "atomic", previousBuildId: null, basedOnGeneration: null });
    const files = readdirSync(path.join(tmpDir, ".k8s-adapter"));
    expect(files).toEqual(["state.json"]);
    expect(existsSync(path.join(tmpDir, ".k8s-adapter", "state.json.tmp"))).toBe(false);
  });

  it("L13: localOnly reads skip the cluster ConfigMap even with a releaseName", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "cluster-build", previousBuildId: "local-build" }),
    );
    writeLocal(tmpDir, { buildId: "local-build", previousBuildId: null });

    const local = await readState(tmpDir, "rel", { localOnly: true });
    expect(local!.buildId).toBe("local-build");
    expect(execCapture).not.toHaveBeenCalled();

    const cluster = await readState(tmpDir, "rel");
    expect(cluster!.buildId).toBe("cluster-build");
    // ...and the cluster read is pinned to the namespace init binds Workload Identity to.
    expect(vi.mocked(execCapture).mock.calls[0]![1]).toContain("default");
  });
});

/** A `kubectl get configmap -o json` reply carrying `state.json`. */
function clusterGet(
  state: unknown,
  { resourceVersion = "100" }: { resourceVersion?: string | null } = {},
) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "rel-adapter-state",
        ...(resourceVersion === null ? {} : { resourceVersion }),
      },
      data: { "state.json": JSON.stringify(state) },
    }),
    stderr: "",
  };
}

/** `--ignore-not-found`: a genuinely absent ConfigMap is exit 0 + empty stdout. */
const CLUSTER_ABSENT = { exitCode: 0, stdout: "", stderr: "" };

function writeLocal(dir: string, state: unknown): void {
  const stateDir = path.join(dir, ".k8s-adapter");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(state));
}

function localState(dir: string): AdapterState {
  return JSON.parse(readFileSync(path.join(dir, ".k8s-adapter", "state.json"), "utf-8"));
}

describe("readState — N20: unreadable cluster state is never 'no deploys yet'", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-n20-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("keys absence on --ignore-not-found (exit 0 + empty stdout), never on stderr text", async () => {
    vi.mocked(execCapture).mockResolvedValue(CLUSTER_ABSENT);
    expect(await readState(tmpDir, "rel")).toBeNull();
    const args = vi.mocked(execCapture).mock.calls[0]![1];
    expect(args).toContain("--ignore-not-found");
    expect(args).toContain("json");
    // Bounded: state.ts runs at the deploy's commit point.
    expect(vi.mocked(execCapture).mock.calls[0]![2]).toMatchObject({
      timeoutMs: expect.any(Number),
    });
  });

  it("THROWS on a non-zero kubectl exit instead of reporting no state (the #1 outage)", async () => {
    // A transient RBAC/connectivity failure used to become previousBuildId=null, which
    // skipped deploy's retained-manifest injection so helm DELETED the serving Deployment.
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: 'Error from server (Forbidden): configmaps "rel-adapter-state" is forbidden',
    });
    await expect(readState(tmpDir, "rel")).rejects.toBeInstanceOf(ClusterStateReadError);
    await expect(readState(tmpDir, "rel")).rejects.toThrow(/NOT "no deploys yet"/);
  });

  it("THROWS when the ConfigMap body is unparseable", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        metadata: { name: "rel-adapter-state", resourceVersion: "9" },
        data: { "state.json": "{not json" },
      }),
      stderr: "",
    });
    await expect(readState(tmpDir, "rel")).rejects.toBeInstanceOf(ClusterStateReadError);
  });

  it("THROWS when the ConfigMap exists but carries no state.json key", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ metadata: { name: "rel-adapter-state", resourceVersion: "9" } }),
      stderr: "",
    });
    await expect(readState(tmpDir, "rel")).rejects.toThrow(/carries no "state.json"/);
  });

  it("THROWS when the recorded state has the wrong shape", async () => {
    vi.mocked(execCapture).mockResolvedValue(clusterGet({ nope: true }));
    await expect(readState(tmpDir, "rel")).rejects.toThrow(/missing a string "buildId"/);
  });

  it("THROWS on an unparseable LOCAL state file instead of reporting no state", async () => {
    writeLocal(tmpDir, "x");
    writeFileSync(path.join(tmpDir, ".k8s-adapter", "state.json"), "{truncated");
    await expect(readState(tmpDir)).rejects.toBeInstanceOf(LocalStateReadError);
    // ...and every failure mode is one catchable family for callers.
    await expect(readState(tmpDir)).rejects.toBeInstanceOf(StateUnavailableError);
  });

  it("falls back to the local file when the ConfigMap is genuinely absent", async () => {
    vi.mocked(execCapture).mockResolvedValue(CLUSTER_ABSENT);
    writeLocal(tmpDir, { buildId: "local-only", previousBuildId: null });
    expect((await readState(tmpDir, "rel"))!.buildId).toBe("local-only");
  });
});

describe("readState — N21: newest state wins (stale ConfigMap must not beat a newer local file)", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-n21-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("prefers the LOCAL file when its generation is higher (the failed-mirror recovery)", async () => {
    // The documented recovery: cutover to B succeeded, the ConfigMap write failed, the
    // operator re-runs. Preferring the ConfigMap put the selector back on build A —
    // which the previous run had scaled to ZERO replicas.
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "A", previousBuildId: "A0", generation: 4 }),
    );
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A", generation: 5 });
    expect((await readState(tmpDir, "rel"))!.buildId).toBe("B");
  });

  it("prefers the CLUSTER ConfigMap when its generation is higher", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "C", previousBuildId: "B", generation: 9 }),
    );
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A", generation: 8 });
    expect((await readState(tmpDir, "rel"))!.buildId).toBe("C");
  });

  it("legacy states (no generation): the build CHAIN proves which side recorded the later cutover", async () => {
    // Backward compatibility: neither side has generation/updatedAt. local={B, prev A}
    // and cluster={A, …} means local recorded the cutover A→B — local is newer.
    vi.mocked(execCapture).mockResolvedValue(clusterGet({ buildId: "A", previousBuildId: "A0" }));
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A" });
    expect((await readState(tmpDir, "rel"))!.buildId).toBe("B");

    // ...and symmetrically, a cluster that recorded a rollback beats a stale local file.
    vi.mocked(execCapture).mockResolvedValue(clusterGet({ buildId: "A", previousBuildId: "B" }));
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A0" });
    expect((await readState(tmpDir, "rel"))!.buildId).toBe("A");
  });

  it("legacy states that disagree with NO chain evidence: refuses to proceed", async () => {
    vi.mocked(execCapture).mockResolvedValue(clusterGet({ buildId: "A", previousBuildId: "A0" }));
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "B0" });
    await expect(readState(tmpDir, "rel")).rejects.toBeInstanceOf(StateDisagreementError);
    await expect(readState(tmpDir, "rel")).rejects.toThrow(/neither is provably newer/);
  });

  it("identical build pointers at the same generation: no conflict, cluster copy wins", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A", cdnTags: { B: "build-x" } }),
    );
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A" });
    const state = await readState(tmpDir, "rel");
    expect(state).toMatchObject({ buildId: "B", cdnTags: { B: "build-x" } });
  });

  it("writeState stamps a monotonic generation above BOTH copies, plus updatedAt", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A", generation: 7 }),
    );
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    writeLocal(tmpDir, { buildId: "B", previousBuildId: "A", generation: 3 });

    await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "B", basedOnGeneration: null },
      "rel",
    );

    expect(localState(tmpDir).generation).toBe(8);
    expect(localState(tmpDir).updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const applied = JSON.parse(vi.mocked(execCaptureStdin).mock.calls[0]![2] as string);
    expect(JSON.parse(applied.data["state.json"]).generation).toBe(8);
  });

  it("an incoming generation is a FLOOR, so a failed cluster read still writes a newer local file", async () => {
    // CI has no local file (.k8s-adapter/ is gitignored): without the floor the local
    // write would be generation 1 and the stale cluster copy (generation 7) would win
    // the re-run — the #2 outage again.
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Unable to connect to the server",
    });
    await expect(
      writeState(tmpDir, { buildId: "C", previousBuildId: "B", basedOnGeneration: 7 }, "rel"),
    ).rejects.toBeInstanceOf(ClusterStateWriteError);
    // Local file was still written, provably newer than the unreadable cluster copy.
    expect(localState(tmpDir)).toMatchObject({ buildId: "C", generation: 8 });
    // ...and nothing was written to the cluster blind.
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });
});

describe("writeState — N22/N23: exec.ts only, and last-writer-wins is closed", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-n23-"));
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("N22: pipes the ConfigMap through execCaptureStdin with a timeout (never raw spawn)", async () => {
    vi.mocked(execCapture).mockResolvedValue(clusterGet({ buildId: "B", previousBuildId: "A" }));
    await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "B", basedOnGeneration: null },
      "rel",
    );

    expect(vi.mocked(execCaptureStdin)).toHaveBeenCalledTimes(1);
    const [cmd, args, stdin, opts] = vi.mocked(execCaptureStdin).mock.calls[0]!;
    expect(cmd).toBe("kubectl");
    expect(args).toContain("-f");
    expect(args).toContain("-");
    expect(args).toContain("default");
    expect(opts).toMatchObject({ timeoutMs: expect.any(Number) });
    // The payload is JSON on stdin — never on argv, never hand-escaped YAML.
    expect(JSON.parse(stdin as string).kind).toBe("ConfigMap");
    expect(args.join(" ")).not.toContain("state.json");
  });

  it("N23: replaces with the read resourceVersion as an optimistic-concurrency precondition", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A" }, { resourceVersion: "4242" }),
    );
    await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "B", basedOnGeneration: null },
      "rel",
    );

    const [, args, stdin] = vi.mocked(execCaptureStdin).mock.calls[0]!;
    expect(args[0]).toBe("replace");
    expect(JSON.parse(stdin as string).metadata.resourceVersion).toBe("4242");
  });

  it("N23: creates (no precondition) when the ConfigMap does not exist yet", async () => {
    vi.mocked(execCapture).mockResolvedValue(CLUSTER_ABSENT);
    await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: null, basedOnGeneration: null },
      "rel",
    );

    const [, args, stdin] = vi.mocked(execCaptureStdin).mock.calls[0]!;
    expect(args[0]).toBe("create");
    expect(JSON.parse(stdin as string).metadata.resourceVersion).toBeUndefined();
    // destroy deletes the kubectl-owned state ConfigMap by this label pair.
    expect(JSON.parse(stdin as string).metadata.labels).toMatchObject({
      "app.kubernetes.io/name": "rel",
      "app.kubernetes.io/managed-by": "adapter-k8s",
    });
  });

  it("N23: a concurrent deploy that moved the object makes THIS write fail loudly", async () => {
    // Two deploys both read prev=A and deployed B and C. Blind applies made the loser
    // silent: state ended {buildId: C, previousBuildId: A} while B's resources existed,
    // were never scaled to 0, and rollback targeted A instead of B.
    let reads = 0;
    vi.mocked(execCapture).mockImplementation(async () => {
      reads++;
      return clusterGet(
        { buildId: "B", previousBuildId: "A" },
        { resourceVersion: reads === 1 ? "100" : "101" },
      );
    });
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Operation cannot be fulfilled on configmaps: the object has been modified",
    });

    const err = await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "B", basedOnGeneration: null },
      "rel",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ClusterStateWriteError);
    expect(err.concurrent).toBe(true);
    expect(err.message).toMatch(/modified by ANOTHER deploy or rollback/);
    expect(err.message).toMatch(/100 → 101/);
  });

  it("N23: an ordinary write failure is NOT reported as a concurrent write", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A" }, { resourceVersion: "100" }),
    );
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "error: failed to create configmap: quota exceeded",
    });

    const err = await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "B", basedOnGeneration: null },
      "rel",
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ClusterStateWriteError);
    expect(err.concurrent).toBe(false);
    expect(err.message).toMatch(/quota exceeded/);
  });

  it("S19: refuses to commit over a generation that moved since this deploy read it", async () => {
    // N23's resourceVersion precondition closes BLIND writes, but not read-modify-write
    // staleness: deploy C reads state at generation 5, deploy B commits generation 6 during
    // C's rollout window, and C then re-reads at commit time — picking up B's CURRENT
    // resourceVersion, so the precondition is satisfied and C writes {buildId: C,
    // previousBuildId: A} at generation 7. B is orphaned exactly as the N23 comment
    // describes: its resources exist, state never mentions it, and rollback targets A.
    // basedOnGeneration is the generation this deploy READ, so a cluster generation above it
    // means someone else committed in between and this write must lose.
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A", generation: 6 }),
    );
    writeLocal(tmpDir, { buildId: "A", previousBuildId: null, generation: 5 });

    const err = await writeState(
      tmpDir,
      { buildId: "C", previousBuildId: "A", basedOnGeneration: 5 },
      "rel",
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ClusterStateWriteError);
    expect(err.concurrent).toBe(true);
    expect(err.message).toMatch(/generation 6/);
    // Nothing was written to the cluster...
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
    // ...and the LOCAL file was not advanced either. readState takes the newer of the two
    // copies, so stamping a higher local generation here would make this loser's stale view
    // beat the winner's committed state on the very next read.
    expect(localState(tmpDir)).toMatchObject({ buildId: "A", generation: 5 });
  });

  it("S19: commits normally when the generation is unchanged since the deploy read it", async () => {
    vi.mocked(execCapture).mockResolvedValue(
      clusterGet({ buildId: "B", previousBuildId: "A", generation: 5 }),
    );
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await writeState(tmpDir, { buildId: "C", previousBuildId: "B", basedOnGeneration: 5 }, "rel");

    expect(localState(tmpDir)).toMatchObject({ buildId: "C", generation: 6 });
    expect(vi.mocked(execCaptureStdin)).toHaveBeenCalled();
  });

  it("N30: round-trips the unretained-manifest degradation record", async () => {
    vi.mocked(execCapture).mockResolvedValue(CLUSTER_ABSENT);
    await writeState(
      tmpDir,
      {
        buildId: "C",
        previousBuildId: "B",
        unretainedManifestBuilds: ["B"],
        basedOnGeneration: null,
      },
      "rel",
    );
    expect(localState(tmpDir).unretainedManifestBuilds).toEqual(["B"]);
  });
});
