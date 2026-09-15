import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
const composition = vi.hoisted(() => ({ value: null as any }));
vi.mock("../../src/cli/composition-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/composition-plan.js")>();
  return { ...actual, loadProjectCompositionPlan: () => composition.value };
});

import { runTail } from "../../src/cli/tail.js";
import { execCapture } from "../../src/cli/exec.js";

describe("runTail", () => {
  let projectDir: string | undefined;

  afterEach(() => {
    composition.value = null;
    vi.clearAllMocks();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
  });

  it("refuses a context other than the one declared by the composition plan", async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tail-test-"));
    composition.value = {
      plan: {
        metadata: { releaseName: "my-app", namespace: "plan-namespace", buildId: "build-1" },
        target: {
          identity: { kind: "unverified", requireExplicitConfirmation: true },
          access: { kind: "kubeconfig-context", context: "production-cluster" },
        },
      },
    };
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "developer-cluster\n",
      stderr: "",
    } as never);

    await expect(runTail({ projectDir, releaseName: "my-app" })).rejects.toThrow(
      /requires kubeconfig context "production-cluster".*current context.*developer-cluster/s,
    );
    expect(
      vi.mocked(execCapture).mock.calls.some(([, args]) => (args as string[])[0] === "get"),
    ).toBe(false);
  });

  it("accepts an explicitly confirmed current-context composition target", async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tail-test-"));
    composition.value = {
      plan: {
        metadata: { releaseName: "my-app", namespace: "plan-namespace", buildId: "build-1" },
        target: {
          identity: { kind: "unverified", requireExplicitConfirmation: true },
          access: { kind: "kubeconfig-current-context", requireExplicitConfirmation: true },
        },
      },
    };
    vi.mocked(execCapture)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "developer-cluster\n",
        stderr: "",
      } as never)
      .mockRejectedValueOnce(new Error("stop after cluster verification"));

    await expect(runTail({ projectDir, releaseName: "my-app", yes: true })).rejects.toThrow(
      "stop after cluster verification",
    );

    expect(
      vi.mocked(execCapture).mock.calls.some(([, args]) => (args as string[])[0] === "get"),
    ).toBe(true);
  });

  it("reports invalid infrastructure values without mislabeling them as JSON parse failures", async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tail-test-"));
    const adapterDir = path.join(projectDir, ".k8s-adapter");
    mkdirSync(adapterDir);
    const infraPath = path.join(adapterDir, "infrastructure.json");
    writeFileSync(infraPath, JSON.stringify({ namespace: "Invalid" }));

    await expect(runTail({ projectDir, releaseName: "my-app" })).rejects.toThrow(
      new RegExp(`Invalid ${infraPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: Invalid namespace`),
    );
  });

  it("refuses legacy ambient-context tailing until explicitly confirmed", async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tail-test-"));
    const adapterDir = path.join(projectDir, ".k8s-adapter");
    mkdirSync(adapterDir);
    writeFileSync(
      path.join(adapterDir, "infrastructure.json"),
      JSON.stringify({ namespace: "apps" }),
    );
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "developer-cluster\n",
      stderr: "",
    } as never);

    await expect(runTail({ projectDir, releaseName: "my-app" })).rejects.toThrow(
      /Refusing to tail an unpinned kubectl context/,
    );

    expect(vi.mocked(execCapture)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execCapture)).toHaveBeenCalledWith(
      "kubectl",
      ["config", "current-context"],
      expect.any(Object),
    );
  });

  it("uses the legacy namespace after ambient-context confirmation", async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-tail-test-"));
    const adapterDir = path.join(projectDir, ".k8s-adapter");
    mkdirSync(adapterDir);
    writeFileSync(
      path.join(adapterDir, "infrastructure.json"),
      JSON.stringify({ namespace: "apps" }),
    );
    vi.mocked(execCapture)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: "developer-cluster\n",
        stderr: "",
      } as never)
      .mockRejectedValueOnce(new Error("stop after pod discovery"));

    await expect(runTail({ projectDir, releaseName: "my-app", yes: true })).rejects.toThrow(
      "stop after pod discovery",
    );

    expect(vi.mocked(execCapture).mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["get", "pods", "-n", "apps"]),
    );
  });
});
