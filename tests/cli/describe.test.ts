// tests/cli/describe.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/state.js");

import { runDescribe } from "../../src/cli/describe.js";
import { execCapture } from "../../src/cli/exec.js";
import { readState } from "../../src/cli/state.js";

const RELEASE = "rel";

describe("runDescribe", () => {
  let tmpDir: string;
  let callOrder: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-describe-test-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({ projectId: "proj-12345", region: "us-central1", hosts: [] }),
    );
    callOrder = [];
    vi.clearAllMocks();
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("get-credentials")) callOrder.push("get-credentials");
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);
    vi.mocked(readState).mockImplementation((async () => {
      callOrder.push("readState");
      return null;
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs get-credentials BEFORE reading deploy state (kubectl context pinning)", async () => {
    // Regression: describe read state before pinning the kubectl context, so the
    // cluster ConfigMap read could hit a stale context's cluster (the same bug class
    // rollback was fixed for — AGENTS.md invariant 6).
    await runDescribe({ projectDir: tmpDir, releaseName: RELEASE });

    expect(callOrder).toEqual(["get-credentials", "readState"]);
  });

  it("pins the kubectl deployments read to the default namespace", async () => {
    // A kubeconfig namespace override otherwise makes describe show nothing deployed.
    await runDescribe({ projectDir: tmpDir, releaseName: RELEASE });

    const depCall = vi
      .mocked(execCapture)
      .mock.calls.find(([cmd, args]) => cmd === "kubectl" && args.includes("deployments"));
    expect(depCall).toBeDefined();
    expect(depCall![1].join(" ")).toContain("-n default");
    expect(depCall![1].filter((arg) => arg.startsWith("jsonpath="))).toHaveLength(1);
  });

  it("uses the configured namespace for state and deployment reads", async () => {
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({
        projectId: "proj-12345",
        region: "us-central1",
        hosts: [],
        namespace: "apps",
      }),
    );

    await runDescribe({ projectDir: tmpDir, releaseName: RELEASE });

    expect(readState).toHaveBeenCalledWith(tmpDir, RELEASE, { namespace: "apps" });
    const depCall = vi
      .mocked(execCapture)
      .mock.calls.find(([cmd, args]) => cmd === "kubectl" && args.includes("deployments"));
    expect(depCall?.[1].join(" ")).toContain("-n apps");
  });

  it("classifies builds by EXACT version label, not prefix matching", async () => {
    // Two build ids sharing a 12-char normalized prefix must not both classify as
    // "current" (the prefix-substring technique caused a production 503 — see deploy.ts).
    const buildA = "aaaabbbbcccc1111";
    const buildB = "aaaabbbbcccc2222"; // same first 12 chars after normalization
    vi.mocked(readState).mockImplementation((async () => {
      callOrder.push("readState");
      return { buildId: buildA, previousBuildId: null };
    }) as never);
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("get-credentials")) {
        callOrder.push("get-credentials");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("deployments")) {
        return {
          exitCode: 0,
          stdout:
            `rel-ssr-${buildA}|2/2|img:${buildA}|${buildA}\n` +
            `rel-ssr-${buildB}|0/0|img:${buildB}|${buildB}\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    await runDescribe({ projectDir: tmpDir, releaseName: RELEASE });

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    // Strip ANSI escapes for stable assertions.
    // oxlint-disable-next-line no-control-regex
    const plain = printed.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain).toMatch(new RegExp(`ssr-${buildA}.*\\[current\\]`));
    expect(plain).toMatch(new RegExp(`ssr-${buildB}.*\\[old\\]`));
    expect(plain).not.toMatch(new RegExp(`ssr-${buildB}.*\\[current\\]`));
  });
});
