import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  buildDeleteMemorystoreCommand,
  cacheInstanceName,
  provisionMemorystore,
} from "../../src/cli/provision-cache.js";
import { buildReleaseScopedGcpResources } from "../../src/cli/destroy.js";

const OPTS = {
  projectId: "proj",
  region: "us-central1",
  releaseName: "test-app",
  log: () => {},
};

// Sequence the gcloud responses a provisioning run makes. The key is matched
// against the joined args so order doesn't matter.
function mockGcloud(responses: [match: string, result: exec.ExecCaptureResult][]) {
  vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
    const joined = args.join(" ");
    for (const [match, result] of responses) {
      if (joined.includes(match)) return result;
    }
    return { exitCode: 1, stdout: "", stderr: `unmocked gcloud call: ${joined}` };
  });
}

const ok = (stdout = ""): exec.ExecCaptureResult => ({ exitCode: 0, stdout, stderr: "" });

describe("cacheInstanceName", () => {
  it("derives a deterministic per-release instance name", () => {
    expect(cacheInstanceName("test-app")).toBe("test-app-cache");
  });
});

describe("buildDeleteMemorystoreCommand", () => {
  it("builds a region-scoped delete", () => {
    const cmd = buildDeleteMemorystoreCommand("test-app", "us-central1", "proj");
    expect(cmd.command).toBe("gcloud");
    expect(cmd.args).toEqual([
      "redis",
      "instances",
      "delete",
      "test-app-cache",
      "--region",
      "us-central1",
      "--project",
      "proj",
      "--quiet",
    ]);
  });
});

describe("buildReleaseScopedGcpResources (cache teardown)", () => {
  it("omits the Memorystore delete when no region is given", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "proj");
    expect(resources.some((r) => r.desc.includes("Memorystore"))).toBe(false);
  });

  it("includes a region-scoped Memorystore delete when region is given", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "proj", "us-central1");
    const cache = resources.find((r) => r.desc.includes("Memorystore"));
    expect(cache).toBeDefined();
    expect(cache?.args).toContain("my-app-cache");
    expect(cache?.args).toContain("--region=us-central1");
  });
});

describe("provisionMemorystore with AUTH + in-transit encryption", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("creates the instance with AUTH + SERVER_AUTHENTICATION and returns authString + CA", async () => {
    // describeInstance is called twice with the same args: not-found first (create
    // path), then READY (waitForReady). Track calls to sequence the two answers.
    let describes = 0;
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("--format=value(state,host,port)")) {
        describes += 1;
        return describes === 1
          ? { exitCode: 1, stdout: "", stderr: "not found" }
          : ok("READY 10.0.0.1 6379");
      }
      if (joined.includes("get-auth-string")) return ok("s3cr3t-auth\n");
      if (joined.includes("--format=json(serverCaCerts)")) {
        return ok(
          JSON.stringify({ serverCaCerts: [{ cert: "-----BEGIN CERTIFICATE-----\nCA\n" }] }),
        );
      }
      return ok();
    });
    const endpoint = await provisionMemorystore({ ...OPTS, auth: true });
    expect(endpoint).toEqual({
      host: "10.0.0.1",
      port: 6379,
      authString: "s3cr3t-auth",
      caCert: "-----BEGIN CERTIFICATE-----\nCA\n",
    });
    const createCall = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([, args]) => args.includes("create"));
    expect(createCall?.[1]).toContain("--auth-enabled");
    expect(createCall?.[1]).toContain("--transit-encryption-mode");
    expect(createCall?.[1]).toContain("SERVER_AUTHENTICATION");
  });

  it("omits AUTH flags when auth is not requested", async () => {
    let describes = 0;
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("--format=value(state,host,port)")) {
        describes += 1;
        return describes === 1
          ? { exitCode: 1, stdout: "", stderr: "not found" }
          : ok("READY 10.0.0.1 6379");
      }
      return ok();
    });
    const endpoint = await provisionMemorystore(OPTS);
    expect(endpoint).toEqual({ host: "10.0.0.1", port: 6379 });
    const createCall = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([, args]) => args.includes("create"));
    expect(createCall?.[1]).not.toContain("--auth-enabled");
  });

  it("refuses to reuse an existing non-AUTH instance when auth is requested", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode)",
        ok(JSON.stringify({ authEnabled: false, transitEncryptionMode: "DISABLED" })),
      ],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /already exists WITHOUT AUTH/,
    );
  });

  it("reuses an existing AUTH-enabled instance and returns its credentials", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode)",
        ok(JSON.stringify({ authEnabled: true, transitEncryptionMode: "SERVER_AUTHENTICATION" })),
      ],
      ["get-auth-string", ok("s3cr3t-auth\n")],
      ["--format=json(serverCaCerts)", ok(JSON.stringify({ serverCaCerts: [{ cert: "CA-PEM" }] }))],
    ]);
    const endpoint = await provisionMemorystore({ ...OPTS, auth: true });
    expect(endpoint.authString).toBe("s3cr3t-auth");
    expect(endpoint.caCert).toBe("CA-PEM");
  });
});
