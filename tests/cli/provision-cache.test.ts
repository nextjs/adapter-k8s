import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  buildDeleteMemorystoreCommand,
  cacheInstanceName,
  provisionMemorystore,
} from "../../src/cli/provision-cache.js";

const OPTS = {
  projectId: "proj-12345",
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

const existingConfig = (overrides: Record<string, unknown> = {}) => ({
  authEnabled: true,
  transitEncryptionMode: "SERVER_AUTHENTICATION",
  memorySizeGb: 1,
  tier: "BASIC",
  authorizedNetwork: "projects/proj-12345/global/networks/default",
  connectMode: "DIRECT_PEERING",
  ...overrides,
});

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

describe("provisionMemorystore with AUTH + in-transit encryption", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("validates plan/config values again at the provisioning boundary", async () => {
    await expect(
      provisionMemorystore({ ...OPTS, network: "--impersonate-service-account" }),
    ).rejects.toThrow(/Invalid Memorystore network/);
    await expect(provisionMemorystore({ ...OPTS, sizeGb: 301 })).rejects.toThrow(
      /sizeGb must be an integer from 1 to 300/,
    );
    await expect(provisionMemorystore({ ...OPTS, tier: "PREMIUM" })).rejects.toThrow(
      /tier must be/,
    );
    expect(exec.execCapture).not.toHaveBeenCalled();
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

  // S8 (SECURITY). This used to assert that an unset `auth` created a PLAINTEXT,
  // unauthenticated instance — i.e. it pinned the insecure default. Memorystore's own defaults
  // are authEnabled=false/transitEncryption=disabled and the chart's NetworkPolicies are
  // Ingress-only, so that instance was readable AND writable by any workload with VPC
  // reachability (read every cached page; inject content by overwriting cached HTML/RSC).
  // Unset now means secure; only an explicit `false` opts out.
  it("creates WITH AUTH when auth is unset (secure by default)", async () => {
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
        return ok(JSON.stringify({ serverCaCerts: [{ cert: "CA-PEM" }] }));
      }
      return ok();
    });
    const endpoint = await provisionMemorystore(OPTS);
    expect(endpoint.authString).toBe("s3cr3t-auth");
    const createCall = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([, args]) => args.includes("create"));
    expect(createCall?.[1]).toContain("--auth-enabled");
    expect(createCall?.[1]).toContain("SERVER_AUTHENTICATION");
  });

  it("omits AUTH flags ONLY on an explicit opt-out, and says so", async () => {
    const logs: string[] = [];
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
    const endpoint = await provisionMemorystore({
      ...OPTS,
      auth: false,
      log: (m: string) => logs.push(m),
    });
    expect(endpoint).toEqual({ host: "10.0.0.1", port: 6379 });
    const createCall = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([, args]) => args.includes("create"));
    expect(createCall?.[1]).not.toContain("--auth-enabled");
    expect(logs.join("\n")).toMatch(/UNAUTHENTICATED/);
  });

  it("refuses a pre-existing non-AUTH instance when secure auth is defaulted", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode",
        ok(
          JSON.stringify(existingConfig({ authEnabled: false, transitEncryptionMode: "DISABLED" })),
        ),
      ],
    ]);
    await expect(provisionMemorystore(OPTS)).rejects.toThrow(/incompatible.*AUTH/i);
  });

  it("refuses to reuse an existing non-AUTH instance when auth is requested", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode",
        ok(
          JSON.stringify(existingConfig({ authEnabled: false, transitEncryptionMode: "DISABLED" })),
        ),
      ],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /incompatible.*AUTH/i,
    );
  });

  it("reuses an existing AUTH-enabled instance and returns its credentials", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      ["--format=json(authEnabled,transitEncryptionMode", ok(JSON.stringify(existingConfig()))],
      ["get-auth-string", ok("s3cr3t-auth\n")],
      ["--format=json(serverCaCerts)", ok(JSON.stringify({ serverCaCerts: [{ cert: "CA-PEM" }] }))],
    ]);
    const endpoint = await provisionMemorystore({ ...OPTS, auth: true });
    expect(endpoint.authString).toBe("s3cr3t-auth");
    expect(endpoint.caCert).toBe("CA-PEM");
  });

  it.each([
    ["size", { memorySizeGb: 2 }],
    ["tier", { tier: "STANDARD_HA" }],
    ["network", { authorizedNetwork: "projects/proj-12345/global/networks/other" }],
    ["network project", { authorizedNetwork: "projects/other-project/global/networks/default" }],
    ["connect mode", { connectMode: "PRIVATE_SERVICE_ACCESS" }],
  ])("refuses to reuse an existing instance with incompatible %s", async (_field, override) => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode",
        ok(JSON.stringify(existingConfig(override))),
      ],
      ["get-auth-string", ok("s3cr3t-auth\n")],
      ["--format=json(serverCaCerts)", ok(JSON.stringify({ serverCaCerts: [{ cert: "CA" }] }))],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /incompatible.*Memorystore|Memorystore.*incompatible/i,
    );
  });

  it("refuses a plaintext plan for an existing AUTH/TLS-only instance", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      ["--format=json(authEnabled,transitEncryptionMode", ok(JSON.stringify(existingConfig()))],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: false })).rejects.toThrow(
      /incompatible.*AUTH|AUTH.*incompatible/i,
    );
  });

  it("refuses a plaintext plan for a partially secured instance", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      [
        "--format=json(authEnabled,transitEncryptionMode",
        ok(JSON.stringify(existingConfig({ authEnabled: false }))),
      ],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: false })).rejects.toThrow(
      /transitEncryptionMode=SERVER_AUTHENTICATION/,
    );
  });

  it("aborts when an existing instance's full configuration cannot be determined", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      // The full describe fails, so the instance must not be reused blind.
      [
        "--format=json(authEnabled,transitEncryptionMode",
        { exitCode: 1, stdout: "", stderr: "permission denied" },
      ],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /Could not verify the full configuration/,
    );
    // Never reached for a credential fetch or a create.
    const joined = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      joined.some((a) => a.includes("get-auth-string") || a.includes("instances create")),
    ).toBe(false);
  });

  it("also aborts when the AUTH describe returns unparseable output", async () => {
    mockGcloud([
      ["services enable", ok()],
      ["--format=value(state,host,port)", ok("READY 10.0.0.1 6379")],
      ["--format=json(authEnabled,transitEncryptionMode", ok("SET LEGACY\n")],
    ]);
    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /Could not verify the full configuration/,
    );
  });

  it("verifies a concurrently created instance before reusing it", async () => {
    let describes = 0;
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      const joined = args.join(" ");
      if (joined.includes("--format=value(state,host,port)")) {
        describes += 1;
        return describes === 1
          ? { exitCode: 1, stdout: "", stderr: "not found" }
          : ok("READY 10.0.0.1 6379");
      }
      if (joined.includes("instances create")) {
        return { exitCode: 1, stdout: "", stderr: "already exists" };
      }
      if (joined.includes("--format=json(authEnabled,transitEncryptionMode")) {
        return ok(JSON.stringify(existingConfig({ memorySizeGb: 2 })));
      }
      return ok();
    });

    await expect(provisionMemorystore({ ...OPTS, auth: true })).rejects.toThrow(
      /memorySizeGb expected 1, found 2/,
    );
  });

  it("caps the instance create with a timeout (no infinite deploy hang)", async () => {
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
    // auth: false keeps this focused on the create timeout — the AUTH default (S8) would
    // otherwise pull the credential fetches into this mock's path.
    await provisionMemorystore({ ...OPTS, auth: false, log: () => undefined });
    const createCall = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([, args]) => args.includes("create"));
    expect(createCall?.[2]).toEqual({ timeoutMs: 20 * 60 * 1000 });
  });
});
