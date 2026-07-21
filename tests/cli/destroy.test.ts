// tests/cli/destroy.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildReleaseScopedGcpResources,
  isAlreadyGoneError,
  runDestroy,
} from "../../src/cli/destroy.js";
import { deployExtRoleId } from "../../src/cli/init.js";
import * as exec from "../../src/cli/exec.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");

// L12: control what the interactive prompt "types" per test.
const mockAnswer = vi.hoisted(() => ({ value: "" }));
vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      question: (_question: string, cb: (answer: string) => void) => cb(mockAnswer.value),
      close: () => {},
    }),
  },
}));

describe("isAlreadyGoneError", () => {
  it("treats genuine not-found errors as already deleted", () => {
    expect(isAlreadyGoneError('Error from server (NotFound): configmaps "x" not found')).toBe(true);
    expect(isAlreadyGoneError("Error: release: not found")).toBe(true);
    expect(isAlreadyGoneError("The bucket you tried to delete does not exist.")).toBe(true);
    expect(isAlreadyGoneError("ERROR: (gcloud) Service account ... was not found.")).toBe(true);
    expect(isAlreadyGoneError("HTTPError 404: Not Found")).toBe(true);
  });

  it("does NOT treat auth/permission/network failures as already deleted", () => {
    expect(
      isAlreadyGoneError("ERROR: (gcloud) PERMISSION_DENIED: caller does not have permission"),
    ).toBe(false);
    expect(isAlreadyGoneError("Error: could not connect to the server: dial tcp timeout")).toBe(
      false,
    );
    expect(isAlreadyGoneError("Error: forbidden: user cannot delete resource")).toBe(false);
    expect(isAlreadyGoneError("Unauthorized")).toBe(false);
    expect(isAlreadyGoneError("")).toBe(false);
  });
});

describe("buildReleaseScopedGcpResources", () => {
  it("deletes the health check created by init", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "my-project");
    const healthCheck = resources.find((resource) => resource.desc.includes("health check"));

    expect(healthCheck?.args).toContain("my-app-routing-hc");
    expect(healthCheck?.args).not.toContain("my-app-routing-tcp");
  });

  it("M9: deletes the release-scoped custom IAM role created by init", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "my-project");
    const role = resources.find((resource) => resource.desc.includes("custom IAM role"));

    expect(role).toBeDefined();
    expect(role!.args).toEqual([
      "iam",
      "roles",
      "delete",
      deployExtRoleId("my-app"),
      "--project=my-project",
      "--quiet",
    ]);
  });
});

describe("runDestroy — confirmation gate (L12)", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const INFRA = {
    projectId: "deploy-project",
    region: "us-central1",
    gcsBucket: "deploy-project-nextjs-static",
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-destroy-test-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".k8s-adapter", "infrastructure.json"), JSON.stringify(INFRA));
    vi.clearAllMocks();
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function printedOutput(): string {
    return [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join("\n");
  }

  it("refuses to destroy non-interactively without --yes", async () => {
    // vitest runs with a non-TTY stdin
    await expect(runDestroy({ projectDir: tmpDir, releaseName: "my-app" })).rejects.toThrow(
      /--yes/,
    );

    // Nothing may have been deleted.
    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      calls.some((a) => a.includes("uninstall") || a.includes("delete") || a.includes("rm")),
    ).toBe(false);
  });

  it("--yes skips the prompt and deletes", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const calls = vi.mocked(exec.execCapture).mock.calls;
    // helm is called via execCapture with ["uninstall", "my-app"]
    expect(calls.some(([cmd, args]) => cmd === "helm" && args.includes("uninstall"))).toBe(true);
    // custom role delete included
    expect(calls.some(([, args]) => args.join(" ").includes("iam roles delete"))).toBe(true);
  });

  it("prompts for the release name on a TTY and proceeds on a match", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.value = "my-app";
    try {
      await runDestroy({ projectDir: tmpDir, releaseName: "my-app" });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    }
    expect(
      vi
        .mocked(exec.execCapture)
        .mock.calls.some(([cmd, args]) => cmd === "helm" && args.includes("uninstall")),
    ).toBe(true);
  });

  it("prompts on a TTY and aborts on a mismatch without deleting anything", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.value = "not-the-release";
    try {
      await expect(runDestroy({ projectDir: tmpDir, releaseName: "my-app" })).rejects.toThrow(
        /aborted/,
      );
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    }
    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      calls.some((a) => a.includes("uninstall") || a.includes("delete") || a.includes("rm ")),
    ).toBe(false);
  });

  it("prints the target project prominently and warns on gcloud project mismatch", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      if (args.includes("config") && args.includes("get-value")) {
        return { exitCode: 0, stdout: "other-project\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const out = printedOutput();
    expect(out).toContain("Target GCP project: deploy-project");
    expect(out).toContain("WARNING");
    expect(out).toContain("other-project");
  });

  it("tolerates gcloud config failure (no warning, destroy proceeds)", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      if (args.includes("config") && args.includes("get-value")) {
        return { exitCode: 1, stdout: "", stderr: "gcloud broken" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    expect(printedOutput()).not.toContain("WARNING");
    expect(
      vi
        .mocked(exec.execCapture)
        .mock.calls.some(([cmd, args]) => cmd === "helm" && args.includes("uninstall")),
    ).toBe(true);
  });

  it("dry-run enumerates every planned deletion and executes nothing", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });

    // Absolutely nothing executed — not even the gcloud config check.
    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();

    const out = printedOutput();
    expect(out).toContain("[dry-run] helm uninstall my-app");
    expect(out).toContain(
      "[dry-run] gcloud storage rm -r gs://deploy-project-nextjs-static --quiet",
    );
    expect(out).toContain("[dry-run] gcloud iam service-accounts delete");
    expect(out).toContain("[dry-run] gcloud service-extensions lb-traffic-extensions delete");
    expect(out).toContain("[dry-run] gcloud compute backend-services delete");
    expect(out).toContain("[dry-run] gcloud compute health-checks delete");
    expect(out).toContain("[dry-run] gcloud compute addresses delete");
    expect(out).toContain(`[dry-run] gcloud iam roles delete ${deployExtRoleId("my-app")}`);
  });

  it("dry-run skips the confirmation gate entirely", async () => {
    // No --yes, non-TTY — must still succeed because dry-run deletes nothing.
    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true }),
    ).resolves.toBeUndefined();
  });
});
