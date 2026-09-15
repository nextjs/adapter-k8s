import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/exec.js");
import { execCapture, execCaptureStdin } from "../../src/cli/exec.js";
import { createEdgeRecovery, revertRoutingServiceToBuild } from "../../src/cutover/edge.js";

const TRUSTED_IMAGE = `trusted.example/project/routing-service@sha256:${"b".repeat(64)}`;
const ATTACKER_IMAGE = `registry.example/attacker/routing-service@sha256:${"a".repeat(64)}`;
const UID = "routing-deployment-uid";
const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
function workload(buildId: string, image = TRUSTED_IMAGE) {
  return {
    metadata: { uid: UID, name: "sample-routing-service" },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "routing-service",
              image,
              env: [
                { name: "NEXT_BUILD_ID", value: buildId },
                {
                  name: "INTERNAL_HEADER_SECRET",
                  valueFrom: { secretKeyRef: { name: `sample-secret-${buildId}`, key: "secret" } },
                },
              ],
            },
          ],
          volumes: [{ name: "routing-manifest", configMap: { name: "sample-routing-manifest" } }],
          nodeSelector: { "kubernetes.io/arch": "arm64" },
        },
      },
    },
  };
}
function revision(buildId = "old-build", image = TRUSTED_IMAGE) {
  const template = workload(buildId, image).spec;
  return {
    metadata: {
      name: "sample-routing-rs",
      ownerReferences: [
        {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: "sample-routing-service",
          uid: UID,
          controller: true,
        },
      ],
    },
    spec: template,
  };
}
function cluster(history: unknown[] = [revision()], live = workload("new-build")) {
  vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
    if (args[0] === "get" && args[1] === "deployment") return ok(JSON.stringify(live));
    if (args[0] === "get" && args[1] === "replicasets")
      return ok(JSON.stringify({ items: history }));
    if (args[0] === "get" && args[1] === "secret") return ok(`secret/${args[2]}`);
    if (args[0] === "get" && args[1] === "configmap") return ok(`configmap/${args[2]}`);
    if (args[0] === "patch" || args[0] === "rollout") return ok();
    throw new Error(`Unexpected kubectl command ${JSON.stringify(args)}`);
  });
}
function patches() {
  return vi
    .mocked(execCapture)
    .mock.calls.filter(([, args]) => args[0] === "patch")
    .map(([, args]) => JSON.parse(args[args.indexOf("-p") + 1]!));
}
function recover() {
  return revertRoutingServiceToBuild({
    releaseName: "sample",
    targetBuildId: "old-build",
    registry: "registry.example/attacker",
    targetImageDigest: `sha256:${"a".repeat(64)}`,
    targetPlatform: "linux/amd64",
    retainCurrentManifest: false,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(execCaptureStdin).mockResolvedValue(ok());
});
describe("routing recovery workload provenance", () => {
  it("does not suggest an attacker image as a manual repair when history is missing", async () => {
    cluster([]);
    const recovery = createEdgeRecovery({
      releaseName: "sample",
      buildId: "new-build",
      previousBuildId: "old-build",
      registry: "registry.example/attacker",
      revertRoutingService: revertRoutingServiceToBuild,
    });
    recovery.markHelmMutationAttempted();
    const result = await recovery.restoreEdgeToPreviousBuild();
    expect(result.restored).toBe(false);
    const guidance = recovery.edgeStatusLines(result).join("\n");
    expect(guidance).not.toContain("registry.example/attacker");
    expect(guidance).not.toContain("set image");
    expect(guidance).toContain("Restore a verified chart or workload revision");
  });

  it("ignores well-formed attacker ConfigMap coordinates and restores the authorized image, Secret, and architecture together", async () => {
    const live = workload("new-build");
    live.spec.template.spec.nodeSelector["kubernetes.io/arch"] = "amd64";
    cluster([revision()], live);
    await recover();
    const spec = patches()[0].spec.template.spec;
    expect(spec.containers[0].image).toBe(TRUSTED_IMAGE);
    expect(JSON.stringify(patches())).not.toContain(ATTACKER_IMAGE);
    expect(spec.containers[0].env).toContainEqual({
      name: "INTERNAL_HEADER_SECRET",
      valueFrom: { secretKeyRef: { name: "sample-secret-old-build", key: "secret" } },
    });
    expect(spec.nodeSelector["kubernetes.io/arch"]).toBe("arm64");
  });
  it.each([
    ["missing history", []],
    ["different build", [revision("unrelated")]],
    [
      "foreign controller UID",
      [
        {
          ...revision(),
          metadata: {
            ownerReferences: [
              { ...revision().metadata.ownerReferences[0], uid: "another-deployment" },
            ],
          },
        },
      ],
    ],
    [
      "foreign controller name",
      [
        {
          ...revision(),
          metadata: {
            ownerReferences: [
              { ...revision().metadata.ownerReferences[0], name: "another-deployment" },
            ],
          },
        },
      ],
    ],
    [
      "non-controller owner",
      [
        {
          ...revision(),
          metadata: {
            ownerReferences: [{ ...revision().metadata.ownerReferences[0], controller: false }],
          },
        },
      ],
    ],
    [
      "wrong owner kind",
      [
        {
          ...revision(),
          metadata: {
            ownerReferences: [{ ...revision().metadata.ownerReferences[0], kind: "Job" }],
          },
        },
      ],
    ],
    ["conflicting image history", [revision(), revision("old-build", ATTACKER_IMAGE)]],
  ])("refuses %s without changing the routing Deployment", async (_label, history) => {
    cluster(history);
    await expect(recover()).rejects.toThrow(/Cannot recover routing build/);
    expect(patches()).toEqual([]);
  });

  it("refuses a live Deployment without a controller UID", async () => {
    const live = workload("new-build");
    live.metadata.uid = "";
    cluster([revision()], live);
    await expect(recover()).rejects.toThrow(/Deployment has no UID/);
    expect(patches()).toEqual([]);
  });

  it("restores the absence of a dispatch Secret after a failed rollout", async () => {
    const live = workload("new-build");
    live.spec.template.spec.containers[0]!.env = [{ name: "NEXT_BUILD_ID", value: "new-build" }];
    cluster([revision()], live);
    const capture = vi.mocked(execCapture).getMockImplementation()!;
    vi.mocked(execCapture).mockImplementation((command, args, options) =>
      args[0] === "rollout"
        ? Promise.resolve({ exitCode: 1, stdout: "", stderr: "rollout timed out" })
        : capture(command, args, options),
    );
    await expect(recover()).rejects.toThrow(/did not roll out/);
    expect(patches()).toHaveLength(2);
    expect(patches()[1].spec.template.spec.containers[0].env).toContainEqual({
      name: "INTERNAL_HEADER_SECRET",
      $patch: "delete",
    });
  });

  it("rejects a replaced Deployment even when the old ReplicaSet controller name matches", async () => {
    const live = workload("new-build");
    live.metadata.uid = "replacement-deployment-uid";
    cluster([revision()], live);
    await expect(recover()).rejects.toThrow(/no retained workload revision/);
    expect(patches()).toEqual([]);
  });

  it("accepts duplicate history only when executable image, Secret and architecture agree", async () => {
    cluster([revision(), revision()]);
    await recover();
    expect(patches()[0].spec.template.spec.containers[0].image).toBe(TRUSTED_IMAGE);
  });

  it.each(["secret", "architecture"])("rejects conflicting %s provenance", async (field) => {
    const changed = revision();
    if (field === "secret")
      changed.spec.template.spec.containers[0]!.env[1]!.valueFrom!.secretKeyRef.name =
        "another-secret";
    else changed.spec.template.spec.nodeSelector["kubernetes.io/arch"] = "amd64";
    cluster([revision(), changed]);
    await expect(recover()).rejects.toThrow(/workload revisions disagree/);
    expect(patches()).toEqual([]);
  });

  it("can recover the target already recorded in the live Deployment without a retained ReplicaSet", async () => {
    cluster([], workload("old-build"));
    await recover();
    expect(patches()[0].spec.template.spec.containers[0].image).toBe(TRUSTED_IMAGE);
  });

  it.each([{ exitCode: 1, stdout: "", stderr: "forbidden" }, ok("not-json"), ok("{}")])(
    "refuses unreadable or malformed revision history",
    async (result) => {
      cluster();
      const capture = vi.mocked(execCapture).getMockImplementation()!;
      vi.mocked(execCapture).mockImplementation((command, args, options) =>
        args[1] === "replicasets" ? Promise.resolve(result) : capture(command, args, options),
      );
      await expect(recover()).rejects.toThrow(/ReplicaSet/);
      expect(patches()).toEqual([]);
    },
  );

  it("preserves an actual legacy tagged revision, with a warning, even without ConfigMap image metadata", async () => {
    const legacy = revision("old-build", "trusted.example/project/routing-service:old-build");
    legacy.spec.template.spec.containers[0]!.env = [];
    cluster([legacy]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await revertRoutingServiceToBuild({
        releaseName: "sample",
        targetBuildId: "old-build",
        registry: undefined,
        retainCurrentManifest: false,
      });
      const container = patches()[0].spec.template.spec.containers[0];
      expect(container.image).toBe("trusted.example/project/routing-service:old-build");
      expect(container.env).toContainEqual({ name: "INTERNAL_HEADER_SECRET", $patch: "delete" });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("mutable TAG"));
    } finally {
      warning.mockRestore();
    }
  });

  it("ignores the target build claim in a digest image's unrelated environment variable", async () => {
    const other = revision("unrelated");
    other.spec.template.spec.containers[0]!.env.push({ name: "USER_BUILD_ID", value: "old-build" });
    cluster([other]);
    await expect(recover()).rejects.toThrow(/no retained workload revision/);
    expect(patches()).toEqual([]);
  });

  it("fails closed when the historical dispatch Secret is missing", async () => {
    cluster();
    const capture = vi.mocked(execCapture).getMockImplementation()!;
    vi.mocked(execCapture).mockImplementation((command, args, options) =>
      args[1] === "secret" ? Promise.resolve(ok()) : capture(command, args, options),
    );
    await expect(recover()).rejects.toThrow(/recorded dispatch Secret is unavailable/);
    expect(patches()).toEqual([]);
  });
});
