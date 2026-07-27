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

// L12: control what the interactive prompt "types" per test. `queue` answers multiple
// prompts in order (release-name gate, then the unpinned-context confirmation); when
// the queue is empty every prompt gets `value`.
const mockAnswer = vi.hoisted(() => ({ value: "", queue: [] as string[] }));
vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      question: (_question: string, cb: (answer: string) => void) =>
        cb(mockAnswer.queue.length > 0 ? mockAnswer.queue.shift()! : mockAnswer.value),
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
    // S6: init creates TWO release-scoped service accounts, so destroy must plan BOTH. Leaving
    // `<release>-cli` behind would leave a live identity holding bucket objectAdmin + Artifact
    // Registry writer for a release that no longer exists.
    expect(out).toContain(
      "[dry-run] gcloud iam service-accounts delete my-app-deploy@deploy-project.iam.gserviceaccount.com",
    );
    expect(out).toContain(
      "[dry-run] gcloud iam service-accounts delete my-app-cli@deploy-project.iam.gserviceaccount.com",
    );
    expect(out).toContain("[dry-run] gcloud service-extensions lb-traffic-extensions delete");
    expect(out).toContain("[dry-run] gcloud compute backend-services delete");
    expect(out).toContain("[dry-run] gcloud compute health-checks delete");
    expect(out).toContain("[dry-run] gcloud compute addresses delete");
    expect(out).toContain(`[dry-run] gcloud iam roles delete ${deployExtRoleId("my-app")}`);
  });

  it("deletes BOTH service accounts for real (not only the deploy one)", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    const deleted = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "gcloud" &&
          args[0] === "iam" &&
          args[1] === "service-accounts" &&
          args[2] === "delete",
      )
      .map(([, args]) => args[3]);
    expect(deleted).toEqual([
      "my-app-deploy@deploy-project.iam.gserviceaccount.com",
      "my-app-cli@deploy-project.iam.gserviceaccount.com",
    ]);
  });

  it("treats a missing CLI service account as normal, not a failure", async () => {
    // The expected state for any release inited BEFORE the S6 split: `<release>-cli` was never
    // created, so its deletion 404s and must not be reported as a leftover resource.
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      if (
        args.includes("service-accounts") &&
        args.includes("my-app-cli@deploy-project.iam.gserviceaccount.com")
      ) {
        return { exitCode: 1, stdout: "", stderr: "NOT_FOUND: Unknown service account" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    const out = printedOutput();
    expect(out).toContain("(service account not found or already deleted)");
    expect(out).not.toContain("WARNING: service account deletion failed");
    expect(out).not.toContain('my-app-cli@deploy-project.iam.gserviceaccount.com"');
  });

  it("dry-run skips the confirmation gate entirely", async () => {
    // No --yes, non-TTY — must still succeed because dry-run deletes nothing.
    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true }),
    ).resolves.toBeUndefined();
  });
});

describe("runDestroy — kubectl context pinning", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const INFRA = { projectId: "deploy-project", region: "us-central1" };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-destroy-test-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(path.join(tmpDir, ".k8s-adapter", "infrastructure.json"), JSON.stringify(INFRA));
    vi.clearAllMocks();
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs get-credentials BEFORE helm uninstall", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    const credIdx = calls.findIndex((a) => a.includes("get-credentials"));
    const helmIdx = calls.findIndex((a) => a.includes("uninstall"));
    expect(credIdx).toBeGreaterThanOrEqual(0);
    expect(helmIdx).toBeGreaterThan(credIdx);
    // ...and it targets this release's cluster explicitly.
    expect(calls[credIdx]).toContain("my-app-cluster");
    expect(calls[credIdx]).toContain("--project deploy-project");
  });

  it("aborts before ANY deletion when get-credentials fails", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      if (args.includes("get-credentials")) {
        return { exitCode: 1, stdout: "", stderr: "cluster not found" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow(/Failed to connect to cluster "my-app-cluster"/);
    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      calls.some((a) => a.includes("uninstall") || a.includes("delete") || a.includes("rm -r")),
    ).toBe(false);
  });

  it("helm uninstall is pinned to the default namespace", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    const helm = vi
      .mocked(exec.execCapture)
      .mock.calls.find(([cmd, args]) => cmd === "helm" && args.includes("uninstall"));
    expect(helm?.[1]).toContain("--namespace");
    expect(helm?.[1]).toContain("default");
  });

  it("dry-run does not run get-credentials and prints the skip line", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });
    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain(
      `[dry-run] Skipping "gcloud container clusters get-credentials" (it would mutate your kubeconfig).`,
    );
  });
});

describe("runDestroy — adapter state ConfigMap cleanup", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const INFRA = { projectId: "deploy-project", region: "us-central1" };

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

  it("deletes the adapter state ConfigMaps (state + routing-manifest snapshots) after helm uninstall", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const calls = vi.mocked(exec.execCapture).mock.calls;
    const cmDelete = calls.find(
      ([cmd, args]) => cmd === "kubectl" && args.includes("delete") && args.includes("configmap"),
    );
    expect(cmDelete).toBeDefined();
    expect(cmDelete![1].join(" ")).toContain(
      "app.kubernetes.io/name=my-app,app.kubernetes.io/managed-by=adapter-k8s",
    );
    expect(cmDelete![1]).toContain("--ignore-not-found");
    expect(cmDelete![1]).toContain("default");
    // Ordered after helm uninstall (cluster is pinned, release removed first).
    const helmIdx = calls.findIndex(([cmd]) => cmd === "helm");
    expect(calls.indexOf(cmDelete!)).toBeGreaterThan(helmIdx);
  });

  it("tolerates a ConfigMap-delete failure (warns, destroy still succeeds)", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args.includes("delete")) {
        return { exitCode: 1, stdout: "", stderr: "forbidden by RBAC" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).resolves.toBeUndefined();
    expect(
      warnSpy.mock.calls.some((c) =>
        String(c[0]).includes("could not delete adapter state ConfigMaps"),
      ),
    ).toBe(true);
  });

  it("dry-run prints the ConfigMap delete without executing it", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });
    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("[dry-run] kubectl delete configmap -n default -l");
  });
});

describe("runDestroy — unpinnable kubectl context (C1)", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  // No region → context pinning is impossible.
  const INFRA_NO_REGION = { projectId: "deploy-project" };

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-destroy-test-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify(INFRA_NO_REGION),
    );
    vi.clearAllMocks();
    mockAnswer.value = "";
    mockAnswer.queue = [];
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) => {
      if (args.includes("current-context")) {
        return { exitCode: 0, stdout: "gke_other-project_us-west1_some-cluster\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    mockAnswer.queue = [];
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function printedOutput(): string {
    return [...logSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join("\n");
  }

  it("--yes: prints the CURRENT kubectl context loudly and proceeds without pinning", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    // Pinning never ran (nothing to pin with)...
    expect(calls.some((a) => a.includes("get-credentials"))).toBe(false);
    // ...but the current context was fetched and surfaced before anything was deleted.
    const ctxIdx = calls.findIndex((a) => a.includes("current-context"));
    const helmIdx = calls.findIndex((a) => a.includes("uninstall"));
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(helmIdx).toBeGreaterThan(ctxIdx);
    const out = printedOutput();
    expect(out).toContain("could NOT be pinned");
    expect(out).toContain("gke_other-project_us-west1_some-cluster");
  });

  it("TTY: requires explicit confirmation of the current context before deleting", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.queue = ["my-app", "yes"]; // release-name gate, then context confirmation
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

  it("TTY: aborts without deleting anything when the context is NOT confirmed", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.queue = ["my-app", "no"];
    try {
      await expect(runDestroy({ projectDir: tmpDir, releaseName: "my-app" })).rejects.toThrow(
        /kubectl context was not confirmed/,
      );
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    }
    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      calls.some((a) => a.includes("uninstall") || a.includes("delete") || a.includes("rm -r")),
    ).toBe(false);
  });

  it("non-TTY without --yes refuses (context cannot be confirmed)", async () => {
    // The release-name gate already requires --yes non-interactively; with --yes the
    // context confirmation is skipped too — so exercise the context gate directly by
    // simulating a TTY release-name confirmation... not possible non-interactively.
    // What must hold: without --yes on a non-TTY stdin, destroy never reaches deletion.
    await expect(runDestroy({ projectDir: tmpDir, releaseName: "my-app" })).rejects.toThrow(
      /--yes/,
    );
    const calls = vi.mocked(exec.execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(calls.some((a) => a.includes("uninstall") || a.includes("delete"))).toBe(false);
  });

  it("dry-run prints that pinning is impossible without executing anything", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });
    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();
    const out = printedOutput();
    expect(out).toContain("kubectl context pinning is impossible");
  });

  it("missing infrastructure.json entirely also triggers the context confirmation", async () => {
    rmSync(path.join(tmpDir, ".k8s-adapter", "infrastructure.json"));
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    const out = printedOutput();
    expect(out).toContain("could NOT be pinned");
    expect(out).toContain("gke_other-project_us-west1_some-cluster");
  });
});

// ---------------------------------------------------------------------------
// N87: the per-build internal-dispatch Secrets carry `helm.sh/resource-policy: keep` on purpose —
// a build's secret must outlive the upgrade that renders the next build's one, or the retained
// rollback target's pods cannot start. That means `helm uninstall` deliberately does NOT remove
// them, so destroy must. The ConfigMap sweep does not cover them: different kind, and these are
// helm-owned (`managed-by: Helm`) rather than carrying the adapter's own managed-by label.
// ---------------------------------------------------------------------------
describe("destroy: retained internal-dispatch Secrets", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-destroy-secret-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({ projectId: "deploy-project", region: "us-central1" }),
    );
    vi.clearAllMocks();
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sweeps them by component label, which helm uninstall leaves behind", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const del = vi
      .mocked(exec.execCapture)
      .mock.calls.map(([, args]) => args)
      .find((a) => a[0] === "delete" && a[1] === "secret");
    expect(del).toBeDefined();
    const joined = del!.join(" ");
    expect(joined).toContain("app.kubernetes.io/component=internal-secret");
    expect(joined).toContain("app.kubernetes.io/name=my-app");
    // Absence is not a failure — a release that never deployed has none.
    expect(del).toContain("--ignore-not-found");
  });

  it("warns rather than failing the destroy when the sweep cannot run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(exec.execCapture).mockImplementation((async (_c: string, args: string[]) => {
      if (args[0] === "delete" && args[1] === "secret") {
        return { exitCode: 1, stdout: "", stderr: "forbidden" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not delete the internal-dispatch Secrets/),
    );
    warn.mockRestore();
  });
});
