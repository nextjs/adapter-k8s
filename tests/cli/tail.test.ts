import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTail } from "../../src/cli/tail.js";

describe("runTail", () => {
  let projectDir: string | undefined;

  afterEach(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    projectDir = undefined;
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
});
