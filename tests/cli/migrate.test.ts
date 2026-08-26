// tests/cli/migrate.test.ts
//
// GitOps PR2 (design §4.2 keep-at-birth, §7 Q6): `adapter-k8s migrate` annotates a LIVE
// imperative release's retained set with the reconciler prune protections BEFORE GitOps
// mode is enabled. This is a hard prerequisite, not a recommendation: the 2026-08-10 live
// Argo audit watched `prune: true` delete the keep-annotated dispatch Secret, the
// manifest snapshot, the composition-plan CM — and the still-serving previous build's
// Deployment while the stable Service still selected it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");

// Same prompt seam as destroy.test.ts (L12): control what the TTY confirmation "types".
const mockAnswer = vi.hoisted(() => ({ value: "", queue: [] as string[] }));
vi.mock("node:readline", () => ({
  default: {
    createInterface: () => ({
      question: (_q: string, cb: (answer: string) => void) =>
        cb(mockAnswer.queue.length > 0 ? mockAnswer.queue.shift()! : mockAnswer.value),
      close: () => {},
    }),
  },
}));

import { keepAtBirthAnnotationArgs, runMigrate } from "../../src/cli/migrate.js";
import { execCapture, execOrThrow } from "../../src/cli/exec.js";
import { keepAtBirthAnnotationEntries } from "../../src/emit/templates/utils.js";

const RELEASE = "my-app";
const PINNED_INFRA = { projectId: "my-project", region: "us-central1", namespace: "default" };

/** What the live cluster reports per label-selected sweep — the audit's retained set. */
const RETAINED: Record<string, string[]> = {
  // Parked previous build + serving build, both pools; the routing tier carries a version
  // label too and is annotated (inert: it is in every bundle's manifest).
  "deployments|app.kubernetes.io/name=my-app,app.kubernetes.io/version": [
    "my-app-ssr-buildm",
    "my-app-ssr-buildn",
    "my-app-routing-service",
  ],
  // Versioned Services (the stable active ones carry no version label — deliberately NOT
  // annotated: the reconciler must keep managing them under the selector ignore rules).
  "services|app.kubernetes.io/name=my-app,app.kubernetes.io/version": [
    "my-app-ssr-buildm",
    "my-app-ssr-buildn",
  ],
  // The serving build's HPA (the parked build's was deleted at park time).
  "horizontalpodautoscalers|app.kubernetes.io/name=my-app,app.kubernetes.io/version": [
    "my-app-ssr-buildn-hpa",
  ],
  "secrets|app.kubernetes.io/name=my-app,app.kubernetes.io/component=internal-secret": [
    "my-app-internal-buildm",
    "my-app-internal-buildn",
  ],
  "configmaps|app.kubernetes.io/name=my-app,app.kubernetes.io/component=routing-manifest-snapshot":
    ["my-app-routing-manifest-abc123"],
  "configmaps|app.kubernetes.io/name=my-app,app.kubernetes.io/component=composition-plan": [
    "my-app-composition-plan-buildn",
  ],
  // The state ConfigMap: kubectl-created, in no manifest at all — a pruning reconciler
  // over the namespace would delete the release's only durable deploy state.
  "configmaps|app.kubernetes.io/name=my-app,app.kubernetes.io/managed-by=adapter-k8s": [
    "my-app-adapter-state",
  ],
  "externalsecrets|app.kubernetes.io/name=my-app,app.kubernetes.io/component=external-secret": [
    "my-app-ihs-buildn",
  ],
};

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function writeInfra(infra: Record<string, unknown> | null): void {
  mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
  if (infra) {
    writeFileSync(path.join(tmpDir, ".k8s-adapter", "infrastructure.json"), JSON.stringify(infra));
  }
}

/** A scripted cluster: label-selected listings answer from RETAINED, annotates succeed. */
function scriptCluster(
  overrides: { listFailsFor?: string; annotateFailsFor?: string; empty?: boolean } = {},
) {
  vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
    if (args[0] === "config") {
      return { exitCode: 0, stdout: "kind-some-other-cluster\n", stderr: "" };
    }
    if (args[0] === "get") {
      const key = `${args[1]}|${args[args.indexOf("-l") + 1]}`;
      if (overrides.listFailsFor === args[1]) {
        return { exitCode: 1, stdout: "", stderr: "deployments is forbidden" };
      }
      const names = overrides.empty ? [] : (RETAINED[key] ?? []);
      return { exitCode: 0, stdout: names.length ? `${names.join("\n")}\n` : "", stderr: "" };
    }
    if (args[0] === "annotate") {
      if (overrides.annotateFailsFor === args[2]) {
        return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }) as never);
}

/** Every `kubectl annotate` argv the run issued. */
function annotateCalls(): string[][] {
  return vi
    .mocked(execCapture)
    .mock.calls.map(([, args]) => args as string[])
    .filter((args) => args[0] === "annotate");
}

function printed(): string {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((c) => String(c[0]))
    .join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAnswer.value = "";
  mockAnswer.queue = [];
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-migrate-"));
  vi.mocked(execOrThrow).mockResolvedValue(undefined as never);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("keepAtBirthAnnotationArgs", () => {
  it("is derived from the SAME source the chart templates render", () => {
    expect(keepAtBirthAnnotationArgs()).toEqual([
      "helm.sh/resource-policy=keep",
      "argocd.argoproj.io/sync-options=Prune=false",
      "kustomize.toolkit.fluxcd.io/prune=disabled",
    ]);
    // A divergence between the migrate path and the render path is the whole hazard: a
    // migrated release would carry different protections than a freshly emitted build.
    const rendered = keepAtBirthAnnotationEntries("")
      .trimEnd()
      .split("\n")
      .map((l) => l.replace(": ", "="));
    expect(keepAtBirthAnnotationArgs()).toEqual(rendered);
    // Argo's value itself contains "=", so the split must happen at the FIRST ": " only.
    expect(keepAtBirthAnnotationArgs()[1]!.split("=").length).toBe(3);
  });
});

describe("runMigrate — annotating the retained set", () => {
  it("annotates the FULL retained set the live Argo audit showed being pruned", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });

    const annotated = annotateCalls().map((a) => `${a[1]}/${a[2]}`);
    expect(annotated).toEqual([
      // Parked + serving builds' Deployments (both absent from the NEXT bundle's manifest)
      "deployments/my-app-ssr-buildm",
      "deployments/my-app-ssr-buildn",
      "deployments/my-app-routing-service",
      // Versioned Services
      "services/my-app-ssr-buildm",
      "services/my-app-ssr-buildn",
      // Per-build HPA
      "horizontalpodautoscalers/my-app-ssr-buildn-hpa",
      // The keep-annotated CM/Secret families Helm preserves but Argo/Flux prune ignores
      "secrets/my-app-internal-buildm",
      "secrets/my-app-internal-buildn",
      "configmaps/my-app-routing-manifest-abc123",
      "configmaps/my-app-composition-plan-buildn",
      "externalsecrets/my-app-ihs-buildn",
      // ...and the kubectl-created state ConfigMap
      "configmaps/my-app-adapter-state",
    ]);
    // Each object gets all THREE engines' annotations, overwriting any stale value.
    for (const args of annotateCalls()) {
      for (const kv of keepAtBirthAnnotationArgs()) expect(args).toContain(kv);
      expect(args).toContain("--overwrite");
      expect(args).toContain("-n");
      expect(args[args.indexOf("-n") + 1]).toBe("default");
    }
  });

  it("selects by the release's own label taxonomy — never by name guessing", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });

    const selectors = vi
      .mocked(execCapture)
      .mock.calls.map(([, args]) => args as string[])
      .filter((a) => a[0] === "get")
      .map((a) => `${a[1]} -l ${a[a.indexOf("-l") + 1]}`);
    expect(selectors).toEqual([
      "deployments -l app.kubernetes.io/name=my-app,app.kubernetes.io/version",
      "services -l app.kubernetes.io/name=my-app,app.kubernetes.io/version",
      "horizontalpodautoscalers -l app.kubernetes.io/name=my-app,app.kubernetes.io/version",
      "secrets -l app.kubernetes.io/name=my-app,app.kubernetes.io/component=internal-secret",
      "configmaps -l app.kubernetes.io/name=my-app,app.kubernetes.io/component=routing-manifest-snapshot",
      "configmaps -l app.kubernetes.io/name=my-app,app.kubernetes.io/component=composition-plan",
      "externalsecrets -l app.kubernetes.io/name=my-app,app.kubernetes.io/component=external-secret",
      "configmaps -l app.kubernetes.io/name=my-app,app.kubernetes.io/managed-by=adapter-k8s",
    ]);
    // The stable active Services (no version label) are deliberately NOT swept: they ARE
    // in every bundle's manifest, and the reconciler must keep managing them.
    expect(selectors.some((s) => s === "services -l app.kubernetes.io/name=my-app")).toBe(false);
  });

  it("is IDEMPOTENT: a re-run issues byte-identical calls and adds nothing new", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });
    const first = annotateCalls();
    vi.mocked(execCapture).mockClear();
    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });
    const second = annotateCalls();

    // `kubectl annotate --overwrite` with CONSTANT values: same objects, same annotations,
    // same order — no generation counter, timestamp, or accumulating key to drift.
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("REPORTS what it changed (per object, then a count)", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });

    const out = printed();
    expect(out).toContain("✓ deployments/my-app-ssr-buildm");
    expect(out).toContain("✓ configmaps/my-app-adapter-state");
    expect(out).toContain("12 object(s) carry the keep-at-birth annotations");
    // ...and it names the annotations it applied, so the operator can verify by hand.
    for (const kv of keepAtBirthAnnotationArgs()) expect(out).toContain(kv);
  });

  it("says so plainly when the release has nothing to annotate", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster({ empty: true });
    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });
    expect(printed()).toContain("nothing found");
    expect(annotateCalls()).toHaveLength(0);
  });

  it("S13: rejects a poisoned infrastructure.json BEFORE any gcloud/kubectl call", async () => {
    // destroy/describe/doctor/tail/rollback all ran assertSafeInfrastructure on this read;
    // migrate was the gap — projectId/region below reach a `gcloud get-credentials` argv.
    writeInfra({ ...PINNED_INFRA, projectId: "x&calc" });
    await expect(
      runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true }),
    ).rejects.toThrow(/Invalid projectId/);
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    // And the region slot is covered by the same read-time battery.
    writeInfra({ ...PINNED_INFRA, region: "us-central1;rm -rf /" });
    await expect(
      runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true }),
    ).rejects.toThrow(/Invalid region/);
  });

  it("FAILS CLOSED on an unreadable list — an unannotated set must never look migrated", async () => {
    // The N20 family: "could not list" is NOT "nothing to annotate". Exiting 0 here would
    // green-light enabling a pruning reconciler over an unprotected parked build.
    writeInfra(PINNED_INFRA);
    scriptCluster({ listFailsFor: "deployments" });

    await expect(
      runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true }),
    ).rejects.toThrow(/Migration incomplete[\s\S]*Do NOT enable a pruning reconciler/);
    expect(printed()).toContain("could not list deployments");
  });

  it("FAILS CLOSED when a single annotate is rejected", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster({ annotateFailsFor: "my-app-ssr-buildn-hpa" });
    await expect(
      runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true }),
    ).rejects.toThrow(/Migration incomplete: 1 object/);
    expect(printed()).toContain("could not annotate horizontalpodautoscalers");
  });

  it("dry-run prints the plan and executes NO annotate (and pins no context)", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, dryRun: true });

    expect(annotateCalls()).toHaveLength(0);
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    const out = printed();
    expect(out).toContain("[dry-run] kubectl annotate deployments my-app-ssr-buildm");
    expect(out).toContain("12 object(s) would be annotated");
  });

  it("pins the kubectl context to the release's own cluster when it can", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });

    const [cmd, args] = vi.mocked(execOrThrow).mock.calls[0]!;
    expect(cmd).toBe("gcloud");
    expect(args).toContain("get-credentials");
    expect(args).toContain(`${RELEASE}-cluster`);
    expect(args).toContain("my-project");
  });

  it("validates the release name before any cluster contact", async () => {
    writeInfra(PINNED_INFRA);
    scriptCluster();
    await expect(
      runMigrate({ projectDir: tmpDir, releaseName: "BAD_RELEASE", yes: true }),
    ).rejects.toThrow(/Invalid releaseName/);
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
  });
});

describe("runMigrate — unpinnable kubectl context (destroy's C1 guard idiom)", () => {
  // No projectId/region: there are no GKE credentials to pin with.
  const UNPINNABLE = { namespace: "default" };

  it("REFUSES non-interactively without --yes, and annotates nothing", async () => {
    writeInfra(UNPINNABLE);
    scriptCluster();

    await expect(runMigrate({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /Refusing to migrate against an unpinned kubectl context non-interactively/,
    );
    expect(annotateCalls()).toHaveLength(0);
    // The current context is surfaced first, so the operator can see what they nearly hit.
    expect(printed()).toContain("could NOT be pinned");
    expect(printed()).toContain("kind-some-other-cluster");
  });

  it("a missing infrastructure.json is also unpinnable (never a silent local-context run)", async () => {
    writeInfra(null);
    scriptCluster();
    await expect(runMigrate({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(/--yes/);
    expect(annotateCalls()).toHaveLength(0);
  });

  it("--yes proceeds against the surfaced context without pinning", async () => {
    writeInfra(UNPINNABLE);
    scriptCluster();

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, yes: true });

    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    expect(annotateCalls().length).toBeGreaterThan(0);
  });

  it("TTY: aborts without annotating when the context is NOT confirmed", async () => {
    writeInfra(UNPINNABLE);
    scriptCluster();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.queue = ["no"];

    // Annotating the WRONG cluster silently "passes" the documented prerequisite while
    // leaving the real cluster unprotected — worse than failing.
    await expect(runMigrate({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /kubectl context was not confirmed[\s\S]*Nothing was annotated/,
    );
    expect(annotateCalls()).toHaveLength(0);
  });

  it("TTY: an explicit yes proceeds", async () => {
    writeInfra(UNPINNABLE);
    scriptCluster();
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    mockAnswer.queue = ["yes"];

    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE });
    expect(annotateCalls().length).toBeGreaterThan(0);
  });

  it("dry-run needs no confirmation at all (it mutates nothing)", async () => {
    writeInfra(UNPINNABLE);
    scriptCluster();
    await runMigrate({ projectDir: tmpDir, releaseName: RELEASE, dryRun: true });
    expect(annotateCalls()).toHaveLength(0);
    expect(printed()).toContain("Context pinning is skipped");
  });
});
