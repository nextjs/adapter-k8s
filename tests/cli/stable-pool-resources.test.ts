import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/exec.js");

import { execCapture } from "../../src/cli/exec.js";
import {
  cleanupRetainedStablePoolResources,
  hasHealthCheckPolicyCrd,
  retainRemovedPoolResources,
} from "../../src/cli/stable-pool-resources.js";

const RELEASE = "rel";
const NAMESPACE = "apps";

function stableObject(
  kind: "service" | "poddisruptionbudget" | "healthcheckpolicy",
  pool: string,
  opts: {
    legacyHcpLabels?: boolean;
    wrongName?: boolean;
    retained?: boolean;
    manager?: string;
  } = {},
) {
  const base = `${RELEASE}-${pool}`;
  const name =
    kind === "service" ? base : kind === "poddisruptionbudget" ? `${base}-pdb` : `${base}-hcp`;
  const labels: Record<string, string> = {
    "app.kubernetes.io/managed-by": opts.manager ?? "Helm",
    ...(opts.retained
      ? {
          "adapter-k8s.dev/release": RELEASE,
          "adapter-k8s.dev/retained-stable-pool": RELEASE,
        }
      : {}),
  };
  if (!(kind === "healthcheckpolicy" && opts.legacyHcpLabels)) {
    labels["app.kubernetes.io/name"] = RELEASE;
    labels["app.kubernetes.io/component"] = pool;
  }
  return {
    kind:
      kind === "service"
        ? "Service"
        : kind === "poddisruptionbudget"
          ? "PodDisruptionBudget"
          : "HealthCheckPolicy",
    metadata: {
      name: opts.wrongName ? `${name}-foreign` : name,
      resourceVersion: "123",
      labels,
      annotations: {
        "meta.helm.sh/release-name": RELEASE,
        "meta.helm.sh/release-namespace": NAMESPACE,
      },
    },
    spec:
      kind === "service"
        ? {
            selector: {
              "app.kubernetes.io/name": RELEASE,
              "app.kubernetes.io/component": pool,
              "app.kubernetes.io/version": "buildm",
            },
          }
        : kind === "poddisruptionbudget"
          ? {
              selector: {
                matchLabels: {
                  "app.kubernetes.io/name": RELEASE,
                  "app.kubernetes.io/component": pool,
                },
              },
            }
          : { targetRef: { group: "", kind: "Service", name: base } },
  };
}

describe("hasHealthCheckPolicyCrd", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes an absent generic CRD from a read failure", async () => {
    vi.mocked(execCapture).mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });
    await expect(hasHealthCheckPolicyCrd()).resolves.toBe(false);

    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "customresourcedefinitions is forbidden",
    });
    await expect(hasHealthCheckPolicyCrd()).rejects.toThrow(/Could not determine.*CRD exists/s);
  });
});

describe("retainRemovedPoolResources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("atomically transfers Service, PDB, and legacy-unlabelled HCP identity", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      const kind = args[1] as "service" | "poddisruptionbudget" | "healthcheckpolicy";
      if (args[0] === "get") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            stableObject(kind, "legacy", {
              legacyHcpLabels: true,
              manager: kind === "service" ? "adapter-k8s-active" : "Helm",
            }),
          ),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      retainRemovedPoolResources({
        releaseName: RELEASE,
        pool: "legacy",
        namespace: NAMESPACE,
        healthCheckPolicyCrd: true,
      }),
    ).resolves.toEqual(["service", "poddisruptionbudget", "healthcheckpolicy"]);

    const patches = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => args[0] === "patch")
      .map(([, args]) => ({ kind: args[1], body: JSON.parse(args[args.length - 1]!) }));
    expect(patches.map((patch) => patch.kind)).toEqual([
      "service",
      "poddisruptionbudget",
      "healthcheckpolicy",
    ]);
    for (const patch of patches) {
      expect(patch.body.metadata).toEqual({
        resourceVersion: "123",
        labels: {
          "app.kubernetes.io/name": RELEASE,
          "app.kubernetes.io/component": "legacy",
          "adapter-k8s.dev/release": RELEASE,
          "adapter-k8s.dev/retained-stable-pool": RELEASE,
        },
        annotations: { "helm.sh/resource-policy": "keep" },
      });
    }
  });

  it("allows a generic cluster to have no HCP and an older build to have no PDB", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get" && args[1] === "service") {
        return {
          exitCode: 0,
          stdout: JSON.stringify(stableObject("service", "legacy")),
          stderr: "",
        };
      }
      if (args[0] === "get") return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      retainRemovedPoolResources({
        releaseName: RELEASE,
        pool: "legacy",
        namespace: NAMESPACE,
        healthCheckPolicyCrd: false,
      }),
    ).resolves.toEqual(["service"]);
    expect(
      vi.mocked(execCapture).mock.calls.some(([, args]) => args.includes("healthcheckpolicy")),
    ).toBe(false);
  });

  it("fails closed before Helm on read, identity, or atomic patch failures", async () => {
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "services is forbidden",
    });
    await expect(
      retainRemovedPoolResources({
        releaseName: RELEASE,
        pool: "legacy",
        namespace: NAMESPACE,
        healthCheckPolicyCrd: false,
      }),
    ).rejects.toThrow(/Could not read service.*forbidden/s);

    vi.clearAllMocks();
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify(stableObject("service", "legacy", { wrongName: true })),
      stderr: "",
    });
    await expect(
      retainRemovedPoolResources({
        releaseName: RELEASE,
        pool: "legacy",
        namespace: NAMESPACE,
        healthCheckPolicyCrd: false,
      }),
    ).rejects.toThrow(/identity mismatch/);

    vi.clearAllMocks();
    vi.mocked(execCapture)
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify(stableObject("service", "legacy")),
        stderr: "",
      })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "conflict" });
    await expect(
      retainRemovedPoolResources({
        releaseName: RELEASE,
        pool: "legacy",
        namespace: NAMESPACE,
        healthCheckPolicyCrd: false,
      }),
    ).rejects.toThrow(/Could not retain stable service.*conflict/s);
  });
});

describe("cleanupRetainedStablePoolResources", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes only pools outside current+rollback topology, companions before Service", async () => {
    const deleted: string[] = [];
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get") {
        const kind = args[1] as "service" | "poddisruptionbudget" | "healthcheckpolicy";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              stableObject(kind, "current", { retained: true }),
              stableObject(kind, "obsolete", { retained: true }),
            ],
          }),
          stderr: "",
        };
      }
      deleted.push(`${args[1]}/${args[2]}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      cleanupRetainedStablePoolResources({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        keepPools: ["current", "rollback"],
        healthCheckPolicyCrd: true,
      }),
    ).resolves.toEqual({
      deleted: [
        "healthcheckpolicy/rel-obsolete-hcp",
        "poddisruptionbudget/rel-obsolete-pdb",
        "service/rel-obsolete",
      ],
      failures: [],
    });
    expect(deleted).toEqual([
      "healthcheckpolicy/rel-obsolete-hcp",
      "poddisruptionbudget/rel-obsolete-pdb",
      "service/rel-obsolete",
    ]);
  });

  it("deletes nothing when any label/name/ownership candidate is inconsistent", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get") {
        const kind = args[1] as "service" | "poddisruptionbudget";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [stableObject(kind, "obsolete", { retained: true, wrongName: true })],
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await cleanupRetainedStablePoolResources({
      releaseName: RELEASE,
      namespace: NAMESPACE,
      keepPools: [],
      healthCheckPolicyCrd: false,
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures.join("\n")).toMatch(/identity mismatch/);
    expect(vi.mocked(execCapture).mock.calls.some(([, args]) => args[0] === "delete")).toBe(false);
  });

  it("ignores release-owned stable resources that were never retained as pool resources", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get") {
        if (args[1] !== "service") {
          return { exitCode: 0, stdout: '{"items":[]}', stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: "rel-origin",
                  resourceVersion: "123",
                  labels: {
                    "adapter-k8s.dev/release": RELEASE,
                    "app.kubernetes.io/name": RELEASE,
                    "app.kubernetes.io/component": "origin",
                  },
                  annotations: {
                    "meta.helm.sh/release-name": RELEASE,
                    "meta.helm.sh/release-namespace": NAMESPACE,
                  },
                },
                spec: {
                  selector: {
                    "app.kubernetes.io/name": RELEASE,
                    "app.kubernetes.io/component": "web",
                  },
                },
              },
            ],
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      cleanupRetainedStablePoolResources({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        keepPools: ["web"],
        healthCheckPolicyCrd: false,
      }),
    ).resolves.toEqual({ deleted: [], failures: [] });
    expect(vi.mocked(execCapture).mock.calls.some(([, args]) => args[0] === "delete")).toBe(false);
  });

  it("recognizes markerless resources retained by an older adapter", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get") {
        if (args[1] !== "service") {
          return { exitCode: 0, stdout: '{"items":[]}', stderr: "" };
        }
        const legacy = stableObject("service", "obsolete");
        legacy.metadata.labels["adapter-k8s.dev/release"] = RELEASE;
        legacy.metadata.annotations["helm.sh/resource-policy"] = "keep";
        return {
          exitCode: 0,
          stdout: JSON.stringify({ items: [legacy] }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expect(
      cleanupRetainedStablePoolResources({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        keepPools: [],
        healthCheckPolicyCrd: false,
      }),
    ).resolves.toEqual({ deleted: ["service/rel-obsolete"], failures: [] });
  });

  it("keeps the Service anchor when a companion delete fails", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      if (args[0] === "get") {
        const kind = args[1] as "service" | "poddisruptionbudget";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [stableObject(kind, "obsolete", { retained: true })],
          }),
          stderr: "",
        };
      }
      if (args[1] === "poddisruptionbudget") {
        return { exitCode: 1, stdout: "", stderr: "deletion denied" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await cleanupRetainedStablePoolResources({
      releaseName: RELEASE,
      namespace: NAMESPACE,
      keepPools: [],
      healthCheckPolicyCrd: false,
    });
    expect(result.deleted).toEqual([]);
    expect(result.failures.join("\n")).toContain("deletion denied");
    expect(
      vi
        .mocked(execCapture)
        .mock.calls.some(([, args]) => args[0] === "delete" && args[1] === "service"),
    ).toBe(false);
  });
});
