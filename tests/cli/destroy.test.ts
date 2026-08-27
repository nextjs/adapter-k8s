// tests/cli/destroy.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildExternalCleanupCommand,
  buildReleaseScopedGcpResources,
  isAlreadyGoneError,
  removePlannedKubernetesObject,
  runDestroy,
} from "../../src/cli/destroy.js";
import { deployExtRoleId } from "../../src/cli/init.js";
import * as exec from "../../src/cli/exec.js";
import {
  compileTarget,
  defineResourceComponent,
  defineTarget,
  kubernetesCluster,
  manualExposure,
} from "../../src/target/index.js";
import {
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  type CompositionPlan,
  type RetainedExternalResource,
} from "../../src/composition-plan/index.js";
import { compositionPlanConfigMapName } from "../../src/emit/templates/composition-plan-configmap.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");

function successfulDestroyCommand(args: string[]) {
  const jsonOutput = args.includes("-o") && args[args.indexOf("-o") + 1] === "json";
  return { exitCode: 0, stdout: jsonOutput ? '{"items":[]}' : "", stderr: "" };
}

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

  it("deletes a regional cache in its recorded project without moving other resources", () => {
    const resources = buildReleaseScopedGcpResources(
      "my-app",
      "cluster-project",
      "europe-west1",
      "cache-project",
    );
    const cache = resources.find((resource) => resource.desc.includes("Memorystore"));
    const extension = resources.find((resource) => resource.desc.includes("traffic extension"));

    expect(cache?.args).toContain("--project=cache-project");
    expect(cache?.args).toContain("--region=europe-west1");
    expect(extension?.args).toContain("--project=cluster-project");
  });
});

describe("composition-plan cleanup", () => {
  it("translates typed external operations without inferred names", () => {
    expect(
      buildExternalCleanupCommand({
        kind: "gcp-global-address",
        projectId: "project-123",
        name: "shared-edge-address",
      }),
    ).toEqual({
      desc: 'global address "shared-edge-address"',
      command: "gcloud",
      args: [
        "compute",
        "addresses",
        "delete",
        "shared-edge-address",
        "--global",
        "--project=project-123",
        "--quiet",
      ],
    });
  });

  it("verifies the release ownership label before exact Kubernetes deletion", async () => {
    const owned = {
      ref: {
        apiVersion: "networking.k8s.io/v1",
        resource: "ingresses",
        name: "custom-entry",
        namespace: "apps",
      },
      lifecycle: "helm" as const,
      ownership: {
        releaseLabel: { key: "adapter-k8s.dev/release" as const, value: "my-app" },
        helmRelease: { name: "my-app", namespace: "apps" },
      },
    };
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({
          metadata: { labels: { "adapter-k8s.dev/release": "my-app" } },
        }),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await expect(removePlannedKubernetesObject(owned, false)).resolves.toBeNull();
    expect(vi.mocked(exec.execCapture).mock.calls[1]).toEqual([
      "kubectl",
      ["delete", "ingresses", "custom-entry", "-n", "apps", "--ignore-not-found"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    ]);

    vi.mocked(exec.execCapture).mockReset();
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        metadata: { labels: { "adapter-k8s.dev/release": "another-app" } },
      }),
      stderr: "",
    });
    await expect(removePlannedKubernetesObject(owned, false)).resolves.toMatch(
      /ownership label.*does not match/i,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledTimes(1);
  });
});

describe("runDestroy — composition-plan trust boundary", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  const targetFingerprint = (plan: CompositionPlan) => plan.target.fingerprint;

  function plan(options: {
    buildId: string;
    objectName?: string;
    externalAddress?: string;
    retained?: RetainedExternalResource[];
  }): CompositionPlan {
    const lifecycle = defineResourceComponent({
      name: `lifecycle-${options.buildId}`,
      build(context) {
        return {
          ...(options.objectName
            ? {
                objects: [
                  {
                    apiVersion: "v1",
                    kind: "ConfigMap",
                    resource: "configmaps",
                    metadata: { name: options.objectName, namespace: context.namespace },
                    body: { data: { source: "composition-plan" } },
                  },
                ],
              }
            : {}),
          ...(options.externalAddress
            ? {
                externalCleanup: [
                  {
                    kind: "gcp-global-address" as const,
                    projectId: "project-123",
                    name: options.externalAddress,
                  },
                ],
              }
            : {}),
          retained: options.retained ?? [],
        };
      },
    });
    return compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({
          hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
        }),
        resources: [lifecycle],
      }),
      {
        releaseName: "my-app",
        namespace: "default",
        buildId: options.buildId,
        imageRegistry: "ghcr.io/example/my-app",
        pools: ["default"],
        defaultPool: "default",
        failurePolicy: "closed",
        cache: "none",
      },
    ).plan;
  }

  function planConfigMap(value: CompositionPlan): string {
    return JSON.stringify({
      metadata: {
        annotations: {
          "adapter-k8s.dev/composition-digest": fingerprintCompositionPlan(value),
        },
      },
      data: { "plan.json": canonicalCompositionPlanJson(value) },
    });
  }

  function authorizeExternalCleanupLocally(value: CompositionPlan): void {
    const outputDir = path.join(tmpDir, ".k8s-adapter", "output");
    const digest = fingerprintCompositionPlan(value);
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      path.join(outputDir, "composition-plan.json"),
      canonicalCompositionPlanJson(value),
    );
    writeFileSync(
      path.join(outputDir, "build-metadata.json"),
      JSON.stringify({
        buildId: value.metadata.buildId,
        compositionPlan: { digest, targetFingerprint: value.target.fingerprint },
      }),
    );
  }

  async function destroyFromClusterPlans(plans: CompositionPlan[]): Promise<void> {
    const [current, previous] = plans;
    const state = {
      buildId: current!.metadata.buildId,
      previousBuildId: previous?.metadata.buildId ?? null,
      compositionPlans: Object.fromEntries(
        plans.map((value) => [
          value.metadata.buildId,
          {
            digest: fingerprintCompositionPlan(value),
            targetFingerprint: targetFingerprint(value),
          },
        ]),
      ),
    };
    const plansByName = new Map(
      plans.map((value) => [compositionPlanConfigMapName("my-app", value.metadata.buildId), value]),
    );
    vi.mocked(exec.execCapture).mockImplementation(async (command, args) => {
      if (command === "gcloud") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "kubectl" && args.join(" ") === "config current-context") {
        return { exitCode: 0, stdout: "home\n", stderr: "" };
      }
      if (command === "kubectl" && args.at(-1) === "/version") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ gitVersion: "v1.35.0" }),
          stderr: "",
        };
      }
      const discovery = new Map<string, Array<{ name: string; kind: string }>>([
        ["/api/v1", [{ name: "services", kind: "Service" }]],
        ["/apis/apps/v1", [{ name: "deployments", kind: "Deployment" }]],
        [
          "/apis/autoscaling/v2",
          [{ name: "horizontalpodautoscalers", kind: "HorizontalPodAutoscaler" }],
        ],
        ["/apis/policy/v1", [{ name: "poddisruptionbudgets", kind: "PodDisruptionBudget" }]],
        ["/apis/networking.k8s.io/v1", [{ name: "networkpolicies", kind: "NetworkPolicy" }]],
        ["/apis/discovery.k8s.io/v1", [{ name: "endpointslices", kind: "EndpointSlice" }]],
      ]);
      if (command === "kubectl" && discovery.has(args.at(-1)!)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ resources: discovery.get(args.at(-1)!) }),
          stderr: "",
        };
      }
      if (command === "kubectl" && args.includes("my-app-adapter-state")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ data: { "state.json": JSON.stringify(state) } }),
          stderr: "",
        };
      }
      if (command === "kubectl" && args[0] === "get" && args[1] === "configmap") {
        const value = plansByName.get(args[2]!);
        if (value) return { exitCode: 0, stdout: planConfigMap(value), stderr: "" };
      }
      if (
        command === "kubectl" &&
        args[0] === "get" &&
        args[1] === "configmaps" &&
        plans.some((value) =>
          value.operations.cleanup.kubernetes.contributedObjects.some(
            (owned) => owned.ref.name === args[2],
          ),
        )
      ) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            metadata: { labels: { "adapter-k8s.dev/release": "my-app" } },
          }),
          stderr: "",
        };
      }
      return successfulDestroyCommand(args);
    });
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-plan-trust-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("never executes cluster-only external operations but preserves owned Kubernetes cleanup", async () => {
    await destroyFromClusterPlans([
      plan({ buildId: "build-2", objectName: "custom-config", externalAddress: "planted-ip" }),
    ]);

    expect(vi.mocked(exec.execCapture).mock.calls.some(([command]) => command === "gcloud")).toBe(
      false,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledWith(
      "kubectl",
      ["delete", "configmaps", "custom-config", "-n", "default", "--ignore-not-found"],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    const warnings = warnSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnings).toContain("External cleanup was NOT executed");
    expect(warnings).toContain(
      'global address "planted-ip": gcloud compute addresses delete planted-ip --global --project=project-123 --quiet',
    );
  });

  it("executes an external operation corroborated by the local build plan", async () => {
    const value = plan({ buildId: "build-2", externalAddress: "release-ip" });
    authorizeExternalCleanupLocally(value);

    await destroyFromClusterPlans([value]);

    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledWith(
      "gcloud",
      [
        "compute",
        "addresses",
        "delete",
        "release-ip",
        "--global",
        "--project=project-123",
        "--quiet",
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(warnSpy.mock.calls.flat().join("\n")).not.toContain("External cleanup was NOT executed");
  });

  it("prints the exact union of retained resources from current and previous plans", async () => {
    const sharedCluster: RetainedExternalResource = {
      kind: "gke-cluster",
      projectId: "project-123",
      clusterName: "shared-cluster",
      location: { kind: "region", name: "europe-west2" },
    };
    await destroyFromClusterPlans([
      plan({
        buildId: "build-2",
        retained: [
          sharedCluster,
          {
            kind: "gcp-artifact-registry",
            projectId: "project-123",
            region: "europe-west2",
            repository: "nextjs",
          },
        ],
      }),
      plan({
        buildId: "build-1",
        retained: [
          sharedCluster,
          {
            kind: "gcp-certificate-manager",
            projectId: "project-123",
            releasePrefix: "my-app",
          },
        ],
      }),
    ]);

    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    const clusterLine =
      '    • GKE cluster "shared-cluster": gcloud container clusters delete shared-cluster --region europe-west2 --project project-123';
    expect(output.split(clusterLine)).toHaveLength(2);
    expect(output).toContain(
      '    • Artifact Registry "nextjs": gcloud artifacts repositories delete nextjs --location europe-west2 --project project-123',
    );
    expect(output).toContain(
      '    • Certificate Manager resources prefixed "my-app": gcloud certificate-manager maps list --project project-123 --filter=name:my-app',
    );
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
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) =>
      successfulDestroyCommand(args),
    );
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

  it("refuses incomplete cache coordinates before deleting any resource", async () => {
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({ ...INFRA, cacheRegion: "europe-west1" }),
    );

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow(/incomplete managed-cache identity.*cacheProjectId=undefined/s);

    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();
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
      return successfulDestroyCommand(args);
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
      return successfulDestroyCommand(args);
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

  it("targets the configured namespace for release-scoped Kubernetes resources", async () => {
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({ ...INFRA, namespace: "apps" }),
    );

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });

    const out = printedOutput();
    expect(out).toContain("helm uninstall my-app --namespace apps");
    expect(out).toContain("kubectl delete configmap -n apps");
    expect(out).toContain("kubectl delete secret -n apps");
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
      return successfulDestroyCommand(args);
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
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) =>
      successfulDestroyCommand(args),
    );
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
      return successfulDestroyCommand(args);
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
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) =>
      successfulDestroyCommand(args),
    );
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
      if (cmd === "kubectl" && args.includes("delete") && args.includes("configmap")) {
        return { exitCode: 1, stdout: "", stderr: "forbidden by RBAC" };
      }
      return successfulDestroyCommand(args);
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
      return successfulDestroyCommand(args);
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
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) =>
      successfulDestroyCommand(args),
    );
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

  it("sweeps retained routing snapshots left behind by Helm", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const del = vi
      .mocked(exec.execCapture)
      .mock.calls.map(([, args]) => args)
      .find(
        (args) =>
          args[0] === "delete" &&
          args[1] === "configmap" &&
          args.some((arg) => arg.includes("routing-manifest-snapshot")),
      );
    expect(del).toBeDefined();
    expect(del!.join(" ")).toContain(
      "app.kubernetes.io/name=my-app,app.kubernetes.io/component=routing-manifest-snapshot",
    );
    expect(del).toContain("--ignore-not-found");
  });

  it("warns rather than failing the destroy when the sweep cannot run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(exec.execCapture).mockImplementation((async (_c: string, args: string[]) => {
      if (args[0] === "delete" && args[1] === "secret") {
        return { exitCode: 1, stdout: "", stderr: "forbidden" };
      }
      return successfulDestroyCommand(args);
    }) as never);

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/could not delete the internal-dispatch Secrets/),
    );
    warn.mockRestore();
  });
});

describe("destroy: retained rollout resources", () => {
  let tmpDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-destroy-rollout-"));
    mkdirSync(path.join(tmpDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(tmpDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify({ projectId: "deploy-project", region: "us-central1", namespace: "apps" }),
    );
    vi.clearAllMocks();
    vi.mocked(exec.execCapture).mockImplementation(async (_cmd, args) =>
      successfulDestroyCommand(args),
    );
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function rolloutDelete(kind: "deployment" | "hpa"): string[] | undefined {
    return vi
      .mocked(exec.execCapture)
      .mock.calls.find(
        ([cmd, args]) => cmd === "kubectl" && args[0] === "delete" && args[1] === kind,
      )?.[1];
  }

  it("dry-run includes the rollout-resource sweeps without executing them", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", dryRun: true });

    expect(vi.mocked(exec.execCapture)).not.toHaveBeenCalled();
    const output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("[dry-run] kubectl delete deployment -n apps -l");
    expect(output).toContain("[dry-run] kubectl delete hpa -n apps -l");
  });

  it("deletes retained Deployments and HPAs by dedicated release ownership and namespace", async () => {
    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const expectedSelector =
      "adapter-k8s.dev/release=my-app," +
      "app.kubernetes.io/name=my-app," +
      "app.kubernetes.io/version";
    for (const kind of ["deployment", "hpa"] as const) {
      const deletion = rolloutDelete(kind);
      expect(deletion).toEqual([
        "delete",
        kind,
        "-n",
        "apps",
        "-l",
        expectedSelector,
        "--ignore-not-found",
      ]);
    }

    const calls = vi.mocked(exec.execCapture).mock.calls;
    const helmIndex = calls.findIndex(([cmd, args]) => cmd === "helm" && args[0] === "uninstall");
    expect(calls.findIndex(([, args]) => args === rolloutDelete("deployment"))).toBeGreaterThan(
      helmIndex,
    );
  });

  it("treats retained rollout resources that are already gone as success", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "delete" && ["deployment", "hpa"].includes(args[1]!)) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `Error from server (NotFound): ${args[1]}s not found`,
        };
      }
      return successfulDestroyCommand(args);
    });

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).resolves.toBeUndefined();
    expect(rolloutDelete("deployment")).toBeDefined();
    expect(rolloutDelete("hpa")).toBeDefined();
  });

  it("reports a real rollout-resource deletion error as an incomplete destroy", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "delete" && args[1] === "deployment") {
        return { exitCode: 1, stdout: "", stderr: "forbidden by RBAC" };
      }
      return successfulDestroyCommand(args);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "retained pool Deployments",
    );
  });

  it("deletes a legacy unlabeled HPA only through its exact owned Deployment target", async () => {
    const deploymentName = "my-app-web-build-a";
    const hpaName = "my-app-web-build-a-hpa";
    const foreignDeployment = "my-app-foreign-build-a";
    const foreignHpa = "my-app-foreign-build-a-hpa";
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "deployments") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: deploymentName,
                  labels: {
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": "web",
                    "app.kubernetes.io/version": "build-a",
                    "app.kubernetes.io/managed-by": "Helm",
                  },
                },
                spec: {
                  template: {
                    spec: {
                      containers: [
                        {
                          name: "pool-server",
                          env: [
                            { name: "NEXT_BUILD_ID", value: "build-a" },
                            { name: "POOL_NAME", value: "web" },
                            { name: "RELEASE_NAME", value: "my-app" },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
              {
                metadata: {
                  name: foreignDeployment,
                  labels: {
                    // Same generic app/Helm/version identity is legal for another chart and
                    // must never become deletion authority.
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": "foreign",
                    "app.kubernetes.io/version": "build-a",
                    "app.kubernetes.io/managed-by": "Helm",
                  },
                },
                spec: {
                  template: {
                    spec: {
                      containers: [{ name: "foreign-server", env: [] }],
                    },
                  },
                },
              },
            ],
          }),
        };
      }
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "hpa") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: hpaName },
                spec: {
                  scaleTargetRef: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    name: deploymentName,
                  },
                },
              },
              {
                metadata: { name: "foreign-autoscaler" },
                spec: {
                  scaleTargetRef: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    name: deploymentName,
                  },
                },
              },
              {
                metadata: { name: "my-app-looking-hpa" },
                spec: {
                  scaleTargetRef: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    name: "someone-elses-deployment",
                  },
                },
              },
              {
                metadata: { name: foreignHpa },
                spec: {
                  scaleTargetRef: {
                    apiVersion: "apps/v1",
                    kind: "Deployment",
                    name: foreignDeployment,
                  },
                },
              },
            ],
          }),
        };
      }
      return successfulDestroyCommand(args);
    });

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const exactHpaDeletes = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "kubectl" && args[0] === "delete" && args[1] === "hpa" && !args.includes("-l"),
      )
      .map(([, args]) => args[2]);
    expect(exactHpaDeletes).toEqual([hpaName]);
    expect(exactHpaDeletes).not.toContain("foreign-autoscaler");
    expect(exactHpaDeletes).not.toContain("my-app-looking-hpa");
    expect(exactHpaDeletes).not.toContain(foreignHpa);
  });

  it("fails honestly when legacy HPA ownership cannot be discovered through RBAC", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "deployments") {
        return { exitCode: 1, stdout: "", stderr: "forbidden by RBAC" };
      }
      return successfulDestroyCommand(args);
    });
    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow(
      /Could not discover versioned pool Deployment identities.*No resources were deleted/s,
    );
    expect(
      vi
        .mocked(exec.execCapture)
        .mock.calls.some(
          ([cmd, args]) => cmd === "helm" || (cmd === "kubectl" && args[0] === "delete"),
        ),
    ).toBe(false);
  });

  it("fails honestly when the HPA ownership listing is invalid JSON", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "deployments") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: "my-app-web-build-a",
                  labels: {
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": "web",
                    "app.kubernetes.io/version": "build-a",
                  },
                },
                spec: {
                  template: {
                    spec: {
                      containers: [
                        {
                          name: "pool-server",
                          env: [
                            { name: "NEXT_BUILD_ID", value: "build-a" },
                            { name: "POOL_NAME", value: "web" },
                            { name: "RELEASE_NAME", value: "my-app" },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            ],
          }),
        };
      }
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "hpa") {
        return { exitCode: 0, stdout: "not-json", stderr: "" };
      }
      return successfulDestroyCommand(args);
    });
    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow(/Could not validate retained HPAs.*No resources were deleted/s);
    expect(
      vi
        .mocked(exec.execCapture)
        .mock.calls.some(
          ([cmd, args]) => cmd === "helm" || (cmd === "kubectl" && args[0] === "delete"),
        ),
    ).toBe(false);
  });

  it("deletes exact topology-retained stable pool resources but excludes routing", async () => {
    const item = (
      kind: "service" | "poddisruptionbudget" | "healthcheckpolicy",
      name: string,
      component: string,
    ) => ({
      metadata: {
        name,
        labels: {
          "adapter-k8s.dev/release": "my-app",
          "app.kubernetes.io/name": "my-app",
          "app.kubernetes.io/component": component,
          // Destroy does not rely on this generic label: old Helm and the chart's own value
          // can both survive depending on Helm version/ownership mode.
          "app.kubernetes.io/managed-by": component === "legacy" ? "Helm" : "adapter-k8s-active",
        },
        annotations: {
          "meta.helm.sh/release-name": "my-app",
          "meta.helm.sh/release-namespace": "apps",
        },
      },
      spec:
        kind === "service"
          ? {
              selector: {
                "app.kubernetes.io/name": "my-app",
                "app.kubernetes.io/component": component,
                "app.kubernetes.io/version": "build-a",
              },
            }
          : kind === "poddisruptionbudget"
            ? {
                selector: {
                  matchLabels: {
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": component,
                  },
                },
              }
            : {
                targetRef: {
                  group: "",
                  kind: "Service",
                  name:
                    component === "routing-service" ? "my-app-routing-service" : "my-app-legacy",
                },
              },
    });
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args.includes("-l")) {
        if (args[1] === "service") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              items: [
                item("service", "my-app-legacy", "legacy"),
                item("service", "my-app-routing-service", "routing-service"),
              ],
            }),
          };
        }
        if (args[1] === "poddisruptionbudget") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              items: [
                item("poddisruptionbudget", "my-app-legacy-pdb", "legacy"),
                item("poddisruptionbudget", "my-app-routing-service-pdb", "routing-service"),
              ],
            }),
          };
        }
        if (args[1] === "healthcheckpolicy") {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              items: [
                item("healthcheckpolicy", "my-app-legacy-hcp", "legacy"),
                item("healthcheckpolicy", "my-app-routing-service-hcp", "routing-service"),
              ],
            }),
          };
        }
      }
      return successfulDestroyCommand(args);
    });

    await runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true });

    const exactDeletes = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "kubectl" &&
          args[0] === "delete" &&
          ["service", "poddisruptionbudget", "healthcheckpolicy"].includes(args[1]!),
      )
      .map(([, args]) => `${args[1]}/${args[2]}`);
    expect(exactDeletes).toEqual([
      "service/my-app-legacy",
      "poddisruptionbudget/my-app-legacy-pdb",
      "healthcheckpolicy/my-app-legacy-hcp",
    ]);
    expect(exactDeletes.some((name) => name.includes("routing"))).toBe(false);
    const stableListSelectors = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(
        ([cmd, args]) =>
          cmd === "kubectl" &&
          args[0] === "get" &&
          ["service", "poddisruptionbudget", "healthcheckpolicy"].includes(args[1]!),
      )
      .map(([, args]) => args[args.indexOf("-l") + 1]);
    expect(stableListSelectors).toEqual(
      Array(3).fill("adapter-k8s.dev/release=my-app,app.kubernetes.io/name=my-app"),
    );
    expect(stableListSelectors.some((selector) => selector?.includes("managed-by"))).toBe(false);
  });

  it("does not delete a retained stable resource whose name disagrees with its component", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "service") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: "my-app-not-legacy",
                  labels: {
                    "adapter-k8s.dev/release": "my-app",
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": "legacy",
                  },
                  annotations: {
                    "meta.helm.sh/release-name": "my-app",
                    "meta.helm.sh/release-namespace": "apps",
                  },
                },
                spec: {
                  selector: {
                    "app.kubernetes.io/name": "my-app",
                    "app.kubernetes.io/component": "legacy",
                  },
                },
              },
            ],
          }),
        };
      }
      return successfulDestroyCommand(args);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(
      vi
        .mocked(exec.execCapture)
        .mock.calls.some(
          ([cmd, args]) =>
            cmd === "kubectl" && args[0] === "delete" && args[2] === "my-app-not-legacy",
        ),
    ).toBe(false);
  });

  it("treats an absent HealthCheckPolicy API as a generic-cluster no-op", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "healthcheckpolicy") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'error: the server doesn\'t have a resource type "healthcheckpolicy"',
        };
      }
      return successfulDestroyCommand(args);
    });

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).resolves.toBeUndefined();
  });

  it("does not mistake HealthCheckPolicy RBAC denial for an absent optional API", async () => {
    vi.mocked(exec.execCapture).mockImplementation(async (cmd, args) => {
      if (cmd === "kubectl" && args[0] === "get" && args[1] === "healthcheckpolicy") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'forbidden: could not find the requested resource "healthcheckpolicies"',
        };
      }
      return successfulDestroyCommand(args);
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    await expect(
      runDestroy({ projectDir: tmpDir, releaseName: "my-app", yes: true }),
    ).rejects.toThrow("process.exit(1)");
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "retained stable pool HealthCheckPolicies",
    );
  });
});
