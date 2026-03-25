// tests/cli/init.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildInitGcloudCommands, runInit } from "../../src/cli/init.js";
import * as exec from "../../src/cli/exec.js";
import * as scaffold from "../../src/cli/scaffold.js";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/scaffold.js");

describe("buildInitGcloudCommands", () => {
  it("generates correct gcloud commands for GCS bucket and GKE", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });

    const bucketCmd = commands.find((c) => c.description.includes("GCS bucket"));
    expect(bucketCmd).toBeDefined();
    expect(bucketCmd!.args).toContain("gs://my-project-nextjs-static");

    const apiCmd = commands.find((c) => c.description.includes("Required APIs"));
    expect(apiCmd).toBeDefined();
    expect(apiCmd!.args).toContain("container.googleapis.com");

    const clusterCmd = commands.find((c) =>
      c.description.includes("GKE Autopilot cluster"),
    );
    expect(clusterCmd).toBeDefined();
    expect(clusterCmd!.args).toContain("create-auto");
  });

  it("includes IAM service account creation", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });

    const saCmd = commands.find((c) => c.description.includes("service account"));
    expect(saCmd).toBeDefined();
  });
});

describe("runInit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-init-test-"));
    vi.clearAllMocks();
  });

  it("retries on IAM binding failure and handles already exists", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    const generateAdapterConfig = vi
      .spyOn(scaffold, "generateAdapterConfig")
      .mockReturnValue("config");
    const generateInfrastructureJson = vi
      .spyOn(scaffold, "generateInfrastructureJson")
      .mockReturnValue("infra");

    // Mock sequence of responses
    execCapture
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // APIs
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // Cluster
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // Repo create
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // Bucket create
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // SA create
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" }) // IAM binding fail (will retry)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }) // IAM binding retry success
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "ALREADY_EXISTS",
      }) // Registry writer (already exists)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" }); // Repo admin success

    await runInit({
      projectId: "p",
      region: "r",
      host: "h",
      bucket: "b",
      registry: "reg",
      releaseName: "rel",
      projectDir: tmpDir,
    });

    // APIs, Cluster, Repo, Bucket, SA, IAM (1 + retry), Registry, RepoAdmin = 9 calls
    expect(execCapture).toHaveBeenCalledTimes(9);
    expect(generateAdapterConfig).toHaveBeenCalled();
    expect(generateInfrastructureJson).toHaveBeenCalled();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
