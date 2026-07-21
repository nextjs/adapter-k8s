// tests/cli/rollback.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/state.js");
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("node:fs");

import { runRollback } from "../../src/cli/rollback.js";
import { execCapture, execOrThrow } from "../../src/cli/exec.js";
import { readState, writeState } from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { existsSync, readFileSync } from "node:fs";

const PROJECT = "/proj";
const RELEASE = "rel";
const infraPath = path.join(PROJECT, ".k8s-adapter", "infrastructure.json");
const metaPath = path.join(PROJECT, ".k8s-adapter", "output", "build-metadata.json");
const cdnFilter = path.join(
  PROJECT,
  ".k8s-adapter",
  "output",
  "chart",
  "templates",
  "cdn-http-filter.yaml",
);

/** execCapture stub: success everywhere except optionally the service selector patch. */
function capture(patchFails: boolean) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes("deployments"))
      return { exitCode: 0, stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2", stderr: "" };
    if (args.includes("patch") && args.includes("service"))
      return { exitCode: patchFails ? 1 : 0, stdout: "", stderr: patchFails ? "denied" : "" };
    // backend-services list → empty stdout → the health loop breaks immediately.
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

describe("runRollback — CDN invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation(
      (p) => p === infraPath || p === metaPath || p === cdnFilter,
    );
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("invalidates the rolled-away-from build (currentBuildId) on a successful switch", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(invalidateCdnBuildTag).toHaveBeenCalledTimes(1);
    expect(invalidateCdnBuildTag).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildn", releaseName: RELEASE, projectId: "proj" }),
    );
  });

  it("does NOT invalidate anything when the selector switch fails", async () => {
    vi.mocked(execCapture).mockImplementation(capture(true) as never);

    // A failed selector patch aborts with process.exit(1) BEFORE the invalidation call.
    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
  });

  it("L13: dry-run prints the plan without touching the cluster or the kubeconfig", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE, dryRun: true });

    const calls = vi.mocked(execCapture).mock.calls.map(([, args]) => args);
    // get-credentials mutates the operator's kubeconfig — forbidden in dry-run.
    expect(calls.some((args) => args.includes("get-credentials"))).toBe(false);
    // No mutations of any kind.
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
    // The plan was printed.
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("[dry-run] Rollback plan: buildn → buildm");
    expect(printed).toContain("[dry-run] Would scale up previous build: rel-ssr-buildm");
    expect(printed).toContain("[dry-run] Would scale down current build: rel-ssr-buildn");
    expect(printed).toContain("[dry-run] Would patch active Service selectors");
    expect(printed).toContain("[dry-run] Would swap state: buildId=buildm, previousBuildId=buildn");
  });
});
