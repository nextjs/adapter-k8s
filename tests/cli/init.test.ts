// tests/cli/init.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildInitGcloudCommands,
  runInit,
  cliServiceAccountEmail,
  deployExtRoleId,
  deployServiceAccountEmail,
  DEPLOY_EXT_ROLE_PERMISSIONS,
} from "../../src/cli/init.js";
import * as exec from "../../src/cli/exec.js";
import * as scaffold from "../../src/cli/scaffold.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/scaffold.js");

const VALID = {
  projectId: "my-project",
  region: "us-central1",
  hosts: ["app.example.com"],
  bucket: "my-project-nextjs-static",
  registry: "us-central1-docker.pkg.dev/my-project/nextjs",
  releaseName: "my-app",
};

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

  it("M9: grants Artifact Registry writer at REPOSITORY scope, not project scope", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });

    // S6: there are now TWO commands for this role — the GRANT (to the CLI SA) and the
    // REVOCATION of the legacy grant from the Workload-Identity-bound deploy SA.
    const writerGrants = commands.filter(
      (c) =>
        c.args.includes("roles/artifactregistry.writer") &&
        c.args.includes("add-iam-policy-binding"),
    );
    expect(writerGrants).toHaveLength(1);
    // Repository-scoped binding (mirrors the repoAdmin pattern), not `projects add-iam-policy-binding`.
    expect(writerGrants[0]!.args).toContain("repositories");
    expect(writerGrants[0]!.args).toContain("add-iam-policy-binding");
    expect(writerGrants[0]!.args).toContain("nextjs");
    expect(writerGrants[0]!.args).not.toContain("projects");
  });

  it("M9: binds the release-scoped custom role instead of the broad admin roles", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });
    const flat = commands.map((c) => c.args.join(" ")).join("\n");

    expect(flat).not.toContain("roles/networkservices.admin");
    expect(flat).not.toContain("roles/compute.loadBalancerAdmin");

    const customBinding = commands.find((c) =>
      c.args.some((a) => a.includes(`projects/my-project/roles/${deployExtRoleId("my-app")}`)),
    );
    expect(customBinding).toBeDefined();
    expect(customBinding!.args).toContain("add-iam-policy-binding");
  });

  it("NetworkPolicy: Autopilot clusters never get --enable-network-policy (it is rejected)", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
    });
    const clusterCmd = commands.find((c) => c.args.includes("clusters"));
    expect(clusterCmd!.args).toContain("create-auto");
    expect(clusterCmd!.args).not.toContain("--enable-network-policy");
  });

  it("NetworkPolicy: Standard clusters are created with --enable-network-policy", () => {
    const commands = buildInitGcloudCommands({
      projectId: "my-project",
      region: "us-central1",
      bucket: "my-project-nextjs-static",
      releaseName: "my-app",
      autopilot: false,
    });
    const clusterCmd = commands.find((c) => c.args.includes("clusters"));
    expect(clusterCmd!.args).toContain("create");
    expect(clusterCmd!.args).not.toContain("create-auto");
    expect(clusterCmd!.args).toContain("--enable-network-policy");
  });
});

describe("deployExtRoleId", () => {
  it("derives a hyphen-free role id from the release name", () => {
    expect(deployExtRoleId("my-app")).toBe("nextjs_deploy_ext_my_app");
  });

  it("matches the GCP custom-role id charset and length limits", () => {
    for (const name of ["a", "my-app", "x".repeat(40)]) {
      expect(deployExtRoleId(name)).toMatch(/^[a-zA-Z0-9_]{3,64}$/);
    }
  });

  it("covers exactly the permissions the traffic-extension Job needs", () => {
    expect(DEPLOY_EXT_ROLE_PERMISSIONS).toContain("networkservices.lbTrafficExtensions.create");
    expect(DEPLOY_EXT_ROLE_PERMISSIONS).toContain("networkservices.lbTrafficExtensions.update");
    expect(DEPLOY_EXT_ROLE_PERMISSIONS).toContain("compute.backendServices.update");
    expect(DEPLOY_EXT_ROLE_PERMISSIONS).toContain("compute.forwardingRules.list");
  });
});

// S6 (SECURITY). The deploy SA is Workload-Identity-bound, so anyone who can create a Pod in
// the release's namespace can assume it. Its only in-cluster consumer is the route-extension
// Job, which needs the traffic-extension role and nothing else — so bucket object-admin and
// Artifact Registry writer now live on a separate CLI-only identity that no Pod can assume.
describe("S6: the deploy GSA is split from the CLI GSA", () => {
  const OPTS = {
    projectId: "my-project",
    region: "us-central1",
    bucket: "my-project-nextjs-static",
    releaseName: "my-app",
  };
  const DEPLOY_SA = `serviceAccount:${deployServiceAccountEmail("my-app", "my-project")}`;
  const CLI_SA = `serviceAccount:${cliServiceAccountEmail("my-app", "my-project")}`;
  const commands = buildInitGcloudCommands(OPTS);
  const grantsFor = (role: string, verb: "add-iam-policy-binding" | "remove-iam-policy-binding") =>
    commands.filter((c) => c.args.includes(role) && c.args.includes(verb));

  it("creates both identities", () => {
    const created = commands
      .filter((c) => c.args.includes("service-accounts") && c.args.includes("create"))
      .map((c) => c.args[3]);
    expect(created).toContain("my-app-deploy");
    expect(created).toContain("my-app-cli");
  });

  it("grants bucket object-admin and registry writer to the CLI SA, never the deploy SA", () => {
    for (const role of ["roles/storage.objectAdmin", "roles/artifactregistry.writer"]) {
      const grants = grantsFor(role, "add-iam-policy-binding");
      expect(grants).toHaveLength(1);
      expect(grants[0]!.args).toContain(CLI_SA);
      expect(grants[0]!.args).not.toContain(DEPLOY_SA);
    }
  });

  it("leaves the deploy SA with the release-scoped traffic-extension role only", () => {
    const deployGrants = commands.filter(
      (c) => c.args.includes("add-iam-policy-binding") && c.args.includes(DEPLOY_SA),
    );
    // Exactly one grant TO the deploy SA: the custom role. (The Workload Identity binding is
    // a grant ON it, with the KSA as the member — asserted separately below.)
    expect(deployGrants).toHaveLength(1);
    expect(deployGrants[0]!.args).toContain(
      `projects/my-project/roles/${deployExtRoleId("my-app")}`,
    );
  });

  it("Workload-Identity-binds ONLY the deploy SA — no Pod can assume the CLI SA", () => {
    const wi = commands.filter((c) => c.args.includes("roles/iam.workloadIdentityUser"));
    expect(wi).toHaveLength(1);
    expect(wi[0]!.args).toContain(deployServiceAccountEmail("my-app", "my-project"));
    expect(wi[0]!.args.join(" ")).not.toContain("my-app-cli@");
  });

  it("revokes the legacy grants from the deploy SA, AFTER granting them to the CLI SA", () => {
    for (const role of ["roles/storage.objectAdmin", "roles/artifactregistry.writer"]) {
      const revokes = grantsFor(role, "remove-iam-policy-binding");
      expect(revokes).toHaveLength(1);
      expect(revokes[0]!.args).toContain(DEPLOY_SA);
      // Non-interactive, and scoped the same way the grant was (bucket / repository).
      expect(revokes[0]!.args).toContain("--condition=None");
      expect(revokes[0]!.args).toContain("--quiet");
      // Order matters: a fatal grant failure must never leave NEITHER identity holding it.
      expect(commands.indexOf(revokes[0]!)).toBeGreaterThan(
        commands.indexOf(grantsFor(role, "add-iam-policy-binding")[0]!),
      );
    }
    expect(
      grantsFor("roles/artifactregistry.writer", "remove-iam-policy-binding")[0]!.args,
    ).toContain("repositories");
    expect(grantsFor("roles/storage.objectAdmin", "remove-iam-policy-binding")[0]!.args).toContain(
      "gs://my-project-nextjs-static",
    );
  });
});

describe("runInit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-init-test-"));
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockScaffold(): void {
    vi.spyOn(scaffold, "generateAdapterConfig").mockReturnValue("config");
    vi.spyOn(scaffold, "generateInfrastructureJson").mockReturnValue("infra");
  }

  it("retries on IAM binding failure and handles already exists", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();

    // Fail the storage-admin binding once (retry then succeeds), and report
    // ALREADY_EXISTS for the Artifact Registry writer grant.
    let storageGrantFailed = false;
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("roles/storage.objectAdmin") && !storageGrantFailed) {
        storageGrantFailed = true;
        return { exitCode: 1, stdout: "", stderr: "denied" };
      }
      if (args.includes("roles/artifactregistry.writer")) {
        return { exitCode: 1, stdout: "", stderr: "ALREADY_EXISTS" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runInit({
      ...VALID,
      projectDir: tmpDir,
      iamRetryDelayMs: 0,
    });

    // Should have called execCapture for all gcloud commands + DNS auth describe
    expect(execCapture).toHaveBeenCalled();
    expect(scaffold.generateAdapterConfig).toHaveBeenCalled();
    expect(scaffold.generateInfrastructureJson).toHaveBeenCalled();
  });

  // S6: `init` is idempotent and re-run routinely, so the revocations that MOVE bucket/registry
  // write off the Workload-Identity-bound deploy SA must converge in BOTH directions — over a
  // release that still has them, and over one that never did.
  describe("S6: re-running init converges the GSA split", () => {
    /** Records the gcloud argv, answering `notFound` for the two revocations when asked. */
    function scriptGcloud(opts: { revokeOutcome: "removed" | "absent" | "denied" }) {
      const execCapture = vi.spyOn(exec, "execCapture");
      mockScaffold();
      execCapture.mockImplementation(async (_cmd, args) => {
        if (args.includes("remove-iam-policy-binding")) {
          if (opts.revokeOutcome === "removed") return { exitCode: 0, stdout: "", stderr: "" };
          if (opts.revokeOutcome === "absent") {
            return {
              exitCode: 1,
              stdout: "",
              stderr: "ERROR: Policy binding with the specified member and role not found!",
            };
          }
          return {
            exitCode: 1,
            stdout: "",
            stderr: "PERMISSION_DENIED: caller lacks setIamPolicy",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      return execCapture;
    }

    it("revokes the legacy bindings on an existing release that still has them", async () => {
      const execCapture = scriptGcloud({ revokeOutcome: "removed" });

      await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

      const revokes = execCapture.mock.calls
        .map(([, args]) => args)
        .filter((a) => a.includes("remove-iam-policy-binding"));
      expect(revokes).toHaveLength(2);
      const deploySa = `serviceAccount:${deployServiceAccountEmail(VALID.releaseName, VALID.projectId)}`;
      for (const argv of revokes) expect(argv).toContain(deploySa);
      // ...and the grants went to the CLI SA in the same run.
      const cliSa = `serviceAccount:${cliServiceAccountEmail(VALID.releaseName, VALID.projectId)}`;
      const grants = execCapture.mock.calls
        .map(([, args]) => args)
        .filter(
          (a) =>
            a.includes("add-iam-policy-binding") &&
            (a.includes("roles/storage.objectAdmin") ||
              a.includes("roles/artifactregistry.writer")),
        );
      expect(grants).toHaveLength(2);
      for (const argv of grants) expect(argv).toContain(cliSa);
    });

    it("treats an absent binding as done — a fresh init and every later re-run", async () => {
      const execCapture = scriptGcloud({ revokeOutcome: "absent" });

      // Must NOT throw: on a new release there was never a binding to revoke, and after the
      // first successful run there is not one either.
      await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

      // Skipped, not retried six times: exactly one attempt per revocation.
      const revokeAttempts = execCapture.mock.calls
        .map(([, args]) => args)
        .filter((a) => a.includes("remove-iam-policy-binding"));
      expect(revokeAttempts).toHaveLength(2);
      expect(scaffold.generateInfrastructureJson).toHaveBeenCalled();
    });

    it("still fails loudly when a revocation is genuinely denied", async () => {
      // "Not found" is the only benign outcome — a permission problem would otherwise leave the
      // impersonable identity holding bucket + registry write while init reported success.
      scriptGcloud({ revokeOutcome: "denied" });

      await expect(runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 })).rejects.toThrow(
        /Revoke .* failed after retries/,
      );
    });
  });

  it("creates the custom traffic-extension role and binds it (never the admin roles)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

    const calls = execCapture.mock.calls.map(([, args]) => args);
    const roleCreate = calls.find((a) => a.includes("roles") && a.includes("create"));
    expect(roleCreate).toBeDefined();
    expect(roleCreate!).toContain(deployExtRoleId(VALID.releaseName));
    for (const perm of DEPLOY_EXT_ROLE_PERMISSIONS) {
      expect(roleCreate!.join(" ")).toContain(perm);
    }
    const flat = calls.map((a) => a.join(" ")).join("\n");
    expect(flat).not.toContain("roles/networkservices.admin");
    expect(flat).not.toContain("roles/compute.loadBalancerAdmin");
  });

  it("updates the custom role when it already exists (idempotent)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("roles") && args.includes("create")) {
        return { exitCode: 1, stdout: "", stderr: "ALREADY_EXISTS" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

    const calls = execCapture.mock.calls.map(([, args]) => args);
    const roleUpdate = calls.find((a) => a.includes("roles") && a.includes("update"));
    expect(roleUpdate).toBeDefined();
    expect(roleUpdate!).toContain(deployExtRoleId(VALID.releaseName));
    for (const perm of DEPLOY_EXT_ROLE_PERMISSIONS) {
      expect(roleUpdate!.join(" ")).toContain(perm);
    }
  });

  it("fails loudly when the custom role cannot be created (no admin-role fallback)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "PERMISSION_DENIED" });

    await expect(runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 })).rejects.toThrow(
      /custom IAM role/,
    );
  });

  it("validates operator inputs before running anything (injection guards)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await expect(
      runInit({ ...VALID, hosts: ["evil'example.com"], projectDir: tmpDir }),
    ).rejects.toThrow(/Invalid hostname/);
    await expect(runInit({ ...VALID, bucket: "bad bucket'", projectDir: tmpDir })).rejects.toThrow(
      /Invalid bucket name/,
    );
    await expect(
      runInit({ ...VALID, registry: "registry.example.com/x:tag", projectDir: tmpDir }),
    ).rejects.toThrow(/Invalid image registry/);
    await expect(runInit({ ...VALID, projectId: "BAD", projectDir: tmpDir })).rejects.toThrow(
      /Invalid projectId/,
    );
    await expect(runInit({ ...VALID, region: "us central1", projectDir: tmpDir })).rejects.toThrow(
      /Invalid region/,
    );

    // Nothing should have been executed for any of the invalid inputs.
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("M4b: scaffolds .gitignore with .k8s-adapter/ and never duplicates it", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });
    const gitignorePath = path.join(tmpDir, ".gitignore");
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf-8")).toContain(".k8s-adapter/");

    // Second run: line must not be duplicated.
    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });
    const content = readFileSync(gitignorePath, "utf-8");
    const occurrences = content.split("\n").filter((l) => l.trim() === ".k8s-adapter/").length;
    expect(occurrences).toBe(1);
  });

  it("M4b: appends to an existing .gitignore (adding a trailing newline if needed)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules"); // no trailing newline
    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });
    const content = readFileSync(path.join(tmpDir, ".gitignore"), "utf-8");
    expect(content).toBe("node_modules\n.k8s-adapter/\n");
  });

  it("dry-run prints the role commands without executing them", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runInit({ ...VALID, projectDir: tmpDir, dryRun: true, iamRetryDelayMs: 0 });

    expect(execCapture).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("[dry-run] gcloud iam roles create");
    expect(printed).toContain(deployExtRoleId(VALID.releaseName));
    // dry-run must not scaffold .gitignore
    expect(existsSync(path.join(tmpDir, ".gitignore"))).toBe(false);
  });

  it("fails loudly when bucket creation 409s and the bucket is FOREIGN (not visible)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    // The GCS bucket namespace is global: HTTP 409 means "name taken", not "we own it".
    // The old substring matcher treated the 409 as already-exists and init declared
    // success while later static-asset uploads failed against a stranger's bucket.
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("buckets") && args.includes("create")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "HTTPError 409: The requested bucket name is not available",
        };
      }
      if (args.includes("buckets") && args.includes("describe")) {
        return { exitCode: 1, stdout: "", stderr: "not found" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 })).rejects.toThrow(
      /not visible from project/,
    );
  });

  it("skips bucket creation when the 409'd bucket is verified accessible (ours)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    mockScaffold();
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("buckets") && args.includes("create")) {
        return { exitCode: 1, stdout: "", stderr: "HTTPError 409: conflict" };
      }
      if (args.includes("buckets") && args.includes("describe")) {
        return { exitCode: 0, stdout: VALID.bucket, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("verified accessible");
    // Init completed: infrastructure.json was generated.
    expect(scaffold.generateInfrastructureJson).toHaveBeenCalled();
  });

  it("warns loudly when the GKE image-pull IAM grants fail (ImagePullBackOff precursor)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockScaffold();
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("projects") && args.includes("describe")) {
        return { exitCode: 0, stdout: "123456789", stderr: "" };
      }
      if (args.includes("roles/artifactregistry.reader")) {
        return { exitCode: 1, stdout: "", stderr: "PERMISSION_DENIED" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    // Non-fatal by design — but the warning MUST fire (silence meant ImagePullBackOff
    // at deploy was the first symptom).
    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("artifactregistry.reader");
    expect(warned).toContain("ImagePullBackOff");
  });

  it("warns loudly when the project-number lookup fails (reader grants skipped)", async () => {
    const execCapture = vi.spyOn(exec, "execCapture");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockScaffold();
    execCapture.mockImplementation(async (_cmd, args) => {
      if (args.includes("projects") && args.includes("describe")) {
        return { exitCode: 1, stdout: "", stderr: "PERMISSION_DENIED" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runInit({ ...VALID, projectDir: tmpDir, iamRetryDelayMs: 0 });

    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain("project number");
    expect(warned).toContain("ImagePullBackOff");
  });
});
