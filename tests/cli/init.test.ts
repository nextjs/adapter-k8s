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
  it("generates correct gcloud commands for infrastructure", () => {
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

    const clusterCmd = commands.find((c) => c.description.includes("GKE Autopilot cluster"));
    expect(clusterCmd).toBeDefined();
    expect(clusterCmd!.args).toContain("create-auto");

    const ipCmd = commands.find((c) => c.description.includes("Reserve Global Static IP"));
    expect(ipCmd).toBeDefined();
    expect(ipCmd!.args).toContain("addresses");
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

  it("includes routing service backend provisioning commands", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });

    const backendCmd = commands.find((c) => c.description.includes("backend service for routing"));
    expect(backendCmd).toBeDefined();
    // Must be EXTERNAL_MANAGED to match the global external ALB (the traffic-extension target);
    // the default EXTERNAL scheme is rejected with a scheme-mismatch error.
    expect(backendCmd!.args).toContain("EXTERNAL_MANAGED");

    const hcCmd = commands.find((c) => c.description.includes("health check for routing"));
    expect(hcCmd).toBeDefined();
    // TCP, not gRPC: a plaintext gRPC health check fails against the TLS ext_proc server.
    expect(hcCmd!.args).toContain("tcp");
    expect(hcCmd!.args).not.toContain("grpc");

    // LbRouteExtension is created via Helm hook `import`, not during init
    const routeExtCmd = commands.find((c) => c.description.includes("LbRouteExtension"));
    expect(routeExtCmd).toBeUndefined();
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

    // Mock: all gcloud commands succeed, except IAM binding (retry) and registry (already exists)
    // Default to success for all calls
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    // Override specific calls: IAM binding fails first, then succeeds on retry
    let callCount = 0;
    execCapture.mockImplementation(async () => {
      callCount++;
      // Call 7 = IAM binding (Grant storage admin) — fail first time
      if (callCount === 7) return { exitCode: 1, stdout: "", stderr: "denied" };
      // Call 8 = IAM binding retry — succeed
      // Call 9 = Registry writer — already exists
      if (callCount === 9) return { exitCode: 1, stdout: "", stderr: "ALREADY_EXISTS" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runInit({
      projectId: "p",
      region: "r",
      hosts: ["h"],
      bucket: "b",
      registry: "reg",
      releaseName: "rel",
      projectDir: tmpDir,
    });

    // Should have called execCapture for all gcloud commands + DNS auth describe
    expect(execCapture).toHaveBeenCalled();
    expect(generateAdapterConfig).toHaveBeenCalled();
    expect(generateInfrastructureJson).toHaveBeenCalled();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
