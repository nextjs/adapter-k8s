// tests/cli/deploy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
// The pipeline-safe steps (fetch-cache restage, docker commands, digest resolution, pool-name
// guard) moved to src/pipeline/ in GitOps PR1; their unit tests live in tests/pipeline/ now.
import {
  buildHelmUpgradeArgs,
  discoverClusterPodCidr,
  discoverClusterNodeCidrs,
  discoverNodeCidrsFromCluster,
  discoverPodCidrsFromCluster,
  discoverServingBuildId,
  detectHelmUpgradeMode,
  ensureValkeySecretHelmOwnership,
} from "../../src/cli/deploy.js";

describe("buildHelmUpgradeArgs", () => {
  it("generates correct helm upgrade args", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "abc123",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      previousBuildId: null,
    });

    expect(args).toContain("upgrade");
    expect(args).toContain("--install");
    expect(args).toContain("my-app");
    expect(args).toContain(".k8s-adapter/output/chart");
    expect(args.join(" ")).toContain("global.image.tag=abc123");
    expect(args.join(" ")).toContain("activeBuildId=abc123");
    expect(args).not.toContain("--take-ownership");
    expect(args).toContain("--server-side=true");
    expect(args).toContain("--force-conflicts");
  });

  it("omits Helm 4-only flags and any release-wide ownership bypass in client-side mode", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "abc123",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      previousBuildId: null,
      helmUpgradeMode: "client-side",
    });

    expect(args).not.toContain("--take-ownership");
    expect(args).not.toContain("--server-side=true");
    expect(args).not.toContain("--force-conflicts");
  });

  it("includes previousBuildId when set", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "def456",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      previousBuildId: "abc123",
    });

    expect(args.join(" ")).toContain("previousBuildId=abc123");
    expect(args.join(" ")).toContain("activeBuildId=abc123");
  });

  it("pins Helm to the configured namespace", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "abc123",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      previousBuildId: null,
      namespace: "apps",
    });

    expect(args.join(" ")).toContain("--namespace apps --create-namespace");
  });

  it("sanitizes the serving build selector used during the upgrade", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "new-build",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      previousBuildId: "123old",
    });

    expect(args.join(" ")).toContain("activeBuildId=b-123old");
  });

  it("keeps the origin on the outgoing default pool until cutover", () => {
    const args = buildHelmUpgradeArgs({
      releaseName: "my-app",
      chartPath: ".k8s-adapter/output/chart",
      buildId: "new-build",
      registry: "ghcr.io/example/app",
      previousBuildId: "old-build",
      defaultPool: "api",
      previousDefaultPool: "ssr",
    });

    expect(args.join(" ")).toContain("activeDefaultPool=ssr");
    expect(args.join(" ")).not.toContain("activeDefaultPool=api");
  });
});

describe("detectHelmUpgradeMode", () => {
  const CREATE_NAMESPACE =
    "      --create-namespace    if --install is set, create the release namespace";

  beforeEach(() => vi.clearAllMocks());

  it("selects Helm 4 server-side apply from actual Cobra option rows", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout:
        `${CREATE_NAMESPACE}\n` +
        `      --force-conflicts    force server-side apply conflicts\n` +
        `      --server-side string    must be true, false, or auto\n`,
      stderr: "",
    });

    await expect(detectHelmUpgradeMode()).resolves.toBe("server-side");
  });

  it("selects Helm 3 client-side upgrade and ignores flag names mentioned only in prose", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout:
        `${CREATE_NAMESPACE}\n` +
        `This downstream build does not support --server-side or --force-conflicts.\n`,
      stderr: "",
    });

    await expect(detectHelmUpgradeMode()).resolves.toBe("client-side");
  });

  it.each([
    ["server-side only", "      --server-side string    must be true, false, or auto"],
    ["force-conflicts only", "      --force-conflicts    force server-side apply conflicts"],
  ])("uses client-side mode when a downstream build exposes %s", async (_name, row) => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: `${CREATE_NAMESPACE}\n${row}\n`,
      stderr: "",
    });

    await expect(detectHelmUpgradeMode()).resolves.toBe("client-side");
  });

  it("rejects Helm older than the --create-namespace capability floor", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "Usage: helm upgrade [RELEASE] [CHART]",
      stderr: "",
    });

    await expect(detectHelmUpgradeMode()).rejects.toThrow(/Helm 3\.2 or newer/);
  });

  it("reports a non-zero capability probe without leaking terminal controls", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 2,
      stdout: "",
      stderr: "\u001b[31munknown command\u001b[0m",
    });

    let message = "";
    try {
      await detectHelmUpgradeMode();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("helm upgrade --help exited 2:");
    expect(message).toContain("unknown command");
    expect(message).not.toContain("\u001b");
  });

  it("reports a failed capability probe invocation", async () => {
    vi.mocked(exec.execCapture).mockRejectedValue(new Error("spawn helm ENOENT"));

    await expect(detectHelmUpgradeMode()).rejects.toThrow(/spawn helm ENOENT.*Helm 3\.2/s);
  });
});

describe("ensureValkeySecretHelmOwnership", () => {
  const response = (
    fields: [string, string, string, string, string, string, string, string],
  ): { exitCode: number; stdout: string; stderr: string } => ({
    exitCode: 0,
    stdout: fields.join("|"),
    stderr: "",
  });

  beforeEach(() => vi.clearAllMocks());

  it("atomically adopts only the exact unowned legacy adapter Valkey Secret", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce(
        response(["rel-valkey", "Opaque", "rel", "valkey-secret", "", "", "", "123"]),
      )
      .mockResolvedValueOnce({ exitCode: 0, stdout: "secret/rel-valkey patched", stderr: "" });

    await expect(ensureValkeySecretHelmOwnership("rel")).resolves.toBe("adopted");

    const calls = vi.mocked(exec.execCapture).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "kubectl",
      expect.arrayContaining(["get", "secret", "rel-valkey", "--ignore-not-found"]),
      { timeoutMs: exec.EXEC_TIMEOUTS.kubectl },
    ]);
    const patchArgs = calls[1]![1];
    expect(patchArgs).toEqual(
      expect.arrayContaining(["patch", "secret", "rel-valkey", "--type=merge", "-p"]),
    );
    const body = JSON.parse(patchArgs[patchArgs.indexOf("-p") + 1]!) as {
      metadata: {
        resourceVersion: string;
        labels: Record<string, string>;
        annotations: Record<string, string>;
      };
    };
    expect(body.metadata).toEqual({
      resourceVersion: "123",
      labels: { "app.kubernetes.io/managed-by": "Helm" },
      annotations: {
        "meta.helm.sh/release-name": "rel",
        "meta.helm.sh/release-namespace": "default",
      },
    });
  });

  it("accepts an exact Secret already owned by this release without patching it", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(
      response(["rel-valkey", "Opaque", "rel", "valkey-secret", "Helm", "rel", "default", "123"]),
    );

    await expect(ensureValkeySecretHelmOwnership("rel")).resolves.toBe("owned");
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("adopts the legacy Secret into the configured namespace", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce(
        response(["rel-valkey", "Opaque", "rel", "valkey-secret", "", "", "", "123"]),
      )
      .mockResolvedValueOnce({ exitCode: 0, stdout: "secret/rel-valkey patched", stderr: "" });

    await expect(ensureValkeySecretHelmOwnership("rel", "prod")).resolves.toBe("adopted");

    for (const [, args] of vi.mocked(exec.execCapture).mock.calls) {
      expect(args).toEqual(expect.arrayContaining(["-n", "prod"]));
    }
    const patchArgs = vi.mocked(exec.execCapture).mock.calls[1]![1];
    const body = JSON.parse(patchArgs[patchArgs.indexOf("-p") + 1]!) as {
      metadata: { annotations: Record<string, string> };
    };
    expect(body.metadata.annotations["meta.helm.sh/release-namespace"]).toBe("prod");
  });

  it("does nothing when the exact Secret is absent", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await expect(ensureValkeySecretHelmOwnership("rel")).resolves.toBe("absent");
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("cannot adopt a foreign-owned non-cache resource with the colliding name", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(
      response([
        "rel-valkey",
        "Opaque",
        "foreign-app",
        "database-credentials",
        "Helm",
        "foreign-release",
        "default",
        "123",
      ]),
    );

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /foreign or incomplete ownership metadata/,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("cannot adopt an unowned non-cache resource with the colliding name", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(
      response(["rel-valkey", "Opaque", "rel", "database-credentials", "", "", "", "123"]),
    );

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /is not the adapter's legacy Valkey Secret/,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("aborts on partial ownership instead of overwriting it", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(
      response(["rel-valkey", "Opaque", "rel", "valkey-secret", "Helm", "", "", "123"]),
    );

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /foreign or incomplete ownership metadata/,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("refuses an adoption patch without a resourceVersion precondition", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(
      response(["rel-valkey", "Opaque", "rel", "valkey-secret", "", "", "", ""]),
    );

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /no resourceVersion.*optimistic-concurrency/s,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("aborts when the Secret identity cannot be read", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "secrets is forbidden",
    });

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /Could not inspect cache Secret.*secrets is forbidden/s,
    );
    expect(vi.mocked(exec.execCapture)).toHaveBeenCalledOnce();
  });

  it("aborts when the validated Secret cannot be patched", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce(
        response(["rel-valkey", "Opaque", "rel", "valkey-secret", "", "", "", "123"]),
      )
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "forbidden" });

    await expect(ensureValkeySecretHelmOwnership("rel")).rejects.toThrow(
      /Could not attach Helm ownership.*forbidden/s,
    );
  });
});

describe("buildHelmUpgradeArgs — injection guards (H2)", () => {
  const base = {
    releaseName: "my-app",
    chartPath: ".k8s-adapter/output/chart",
    registry: "us-central1-docker.pkg.dev/my-project/nextjs",
    previousBuildId: null,
  };

  it("rejects a buildId containing helm --set metacharacters (comma)", () => {
    expect(() => buildHelmUpgradeArgs({ ...base, buildId: "abc,evil=1" })).toThrow(
      /Invalid buildId/,
    );
  });

  it("rejects a buildId containing quotes", () => {
    expect(() => buildHelmUpgradeArgs({ ...base, buildId: 'abc"evil' })).toThrow(/Invalid buildId/);
    expect(() => buildHelmUpgradeArgs({ ...base, buildId: "abc'evil" })).toThrow(/Invalid buildId/);
  });

  it("rejects a buildId containing backslashes/braces (helm --set breakouts)", () => {
    expect(() => buildHelmUpgradeArgs({ ...base, buildId: "abc\\evil" })).toThrow(
      /Invalid buildId/,
    );
    expect(() => buildHelmUpgradeArgs({ ...base, buildId: "abc{evil}" })).toThrow(
      /Invalid buildId/,
    );
  });

  it("rejects an unsafe previousBuildId", () => {
    expect(() =>
      buildHelmUpgradeArgs({ ...base, buildId: "ok123", previousBuildId: "abc,injected" }),
    ).toThrow(/Invalid buildId/);
    expect(() =>
      buildHelmUpgradeArgs({ ...base, buildId: "ok123", previousBuildId: "123/old" }),
    ).toThrow(/Invalid buildId/);
  });

  it("rejects a registry with a tag or scheme", () => {
    expect(() =>
      buildHelmUpgradeArgs({
        ...base,
        buildId: "ok123",
        registry: "us-central1-docker.pkg.dev/my-project/nextjs:tag",
      }),
    ).toThrow(/Invalid image registry/);
    expect(() =>
      buildHelmUpgradeArgs({ ...base, buildId: "ok123", registry: "https://registry.example.com" }),
    ).toThrow(/Invalid image registry/);
  });
});

describe("buildHelmUpgradeArgs — NetworkPolicy pod CIDRs", () => {
  const base = {
    releaseName: "my-app",
    chartPath: ".k8s-adapter/output/chart",
    buildId: "abc123",
    registry: "us-central1-docker.pkg.dev/my-project/nextjs",
    previousBuildId: null,
  };

  it("appends the podCidrs helm value as a brace list when provided", () => {
    const args = buildHelmUpgradeArgs({ ...base, podCidrs: "10.4.0.0/14" });
    expect(args).toContain("global.networkPolicy.podCidrs={10.4.0.0/14}");
  });

  it("S22: appends the nodeCidrs helm value as a brace list when provided", () => {
    const args = buildHelmUpgradeArgs({ ...base, nodeCidrs: "10.128.0.0/20" });
    expect(args).toContain("global.networkPolicy.nodeCidrs={10.128.0.0/20}");
  });

  it("S22: disables strict when no node range was discovered (--allow-no-network-policy)", () => {
    // values.yaml defaults strict ON, and the chart `fail`s at RENDER time when strict is set
    // without nodeCidrs (VERIFIED against real helm: an empty list is falsy, so
    // `and .strict (not .nodeCidrs)` fires). So the opt-out path — where discovery returned
    // null and podCidrs is null too — must turn strict OFF explicitly, or
    // `--allow-no-network-policy` would hard-fail the deploy instead of deploying without
    // policies, which is the opposite of what the flag promises.
    const args = buildHelmUpgradeArgs({ ...base, podCidrs: null, nodeCidrs: null });
    expect(args).toContain("global.networkPolicy.strict=false");
  });

  it("S22: leaves strict at its secure default whenever the node range IS known", () => {
    const args = buildHelmUpgradeArgs({
      ...base,
      podCidrs: "10.4.0.0/14",
      nodeCidrs: "10.128.0.0/20",
    });
    expect(args.join(" ")).not.toContain("networkPolicy.strict=false");
    expect(args).toContain("global.networkPolicy.nodeCidrs={10.128.0.0/20}");
  });

  it("S22: omits the nodeCidrs helm value when not discovered", () => {
    const args = buildHelmUpgradeArgs({ ...base, nodeCidrs: null });
    expect(args.join(" ")).not.toContain("networkPolicy.nodeCidrs");
  });

  it("omits the podCidrs helm value when not discovered", () => {
    const args = buildHelmUpgradeArgs({ ...base, podCidrs: null });
    expect(args.join(" ")).not.toContain("networkPolicy.podCidrs");
    const args2 = buildHelmUpgradeArgs({ ...base });
    expect(args2.join(" ")).not.toContain("networkPolicy.podCidrs");
  });
});

describe("discoverClusterPodCidr (fail-closed NetworkPolicy discovery)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const OPTS = { clusterName: "my-app-cluster", region: "us-central1", projectId: "proj-12345" };

  it("returns the discovered CIDR", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "10.4.0.0/14\n",
      stderr: "",
    });
    await expect(discoverClusterPodCidr(OPTS)).resolves.toBe("10.4.0.0/14");
    const args = vi.mocked(exec.execCapture).mock.calls[0]?.[1];
    expect(args).toContain("--format=value(clusterIpv4Cidr)");
  });

  it("throws when gcloud errors (no silent fail-open)", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "forbidden",
    });
    await expect(discoverClusterPodCidr(OPTS)).rejects.toThrow(
      /refusing to deploy without network isolation/,
    );
  });

  it("throws on empty output", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 0, stdout: "\n", stderr: "" });
    await expect(discoverClusterPodCidr(OPTS)).rejects.toThrow(/empty output/);
  });

  it("throws on malformed output (would corrupt the helm list otherwise)", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "10.4.0.0/14\nSET LEGACY\n",
      stderr: "",
    });
    await expect(discoverClusterPodCidr(OPTS)).rejects.toThrow(/unexpected value/);
  });

  it("--allow-no-network-policy opts out: warns and returns null", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "forbidden",
    });
    await expect(
      discoverClusterPodCidr({ ...OPTS, allowNoNetworkPolicy: true }),
    ).resolves.toBeNull();
  });
});

describe("discoverNodeCidrsFromCluster (S27: generic clusters have no gcloud)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("derives node ranges from the Kubernetes API, not a cloud API", () => {
    // The strict NetworkPolicy needs the kubelet's source range or every pod goes unready
    // under Calico. discoverClusterNodeCidrs asks gcloud, which a K3s/on-prem cluster does not
    // have — so strict was simply unavailable there, leaving the dataplane on the broad
    // posture. kubectl knows the node addresses on every conformant cluster.
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "10.0.1.5\n10.0.1.6\n10.0.2.7\n",
      stderr: "",
    } as never);

    return expect(discoverNodeCidrsFromCluster()).resolves.toBe(
      "10.0.1.5/32,10.0.1.6/32,10.0.2.7/32",
    );
  });

  it("de-duplicates repeated node addresses", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "10.0.1.5\n10.0.1.5\n",
      stderr: "",
    } as never);
    await expect(discoverNodeCidrsFromCluster()).resolves.toBe("10.0.1.5/32");
  });

  it("returns null when the API cannot be reached, so the caller decides", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "connection refused",
    } as never);
    await expect(discoverNodeCidrsFromCluster()).resolves.toBeNull();
  });

  it("rejects malformed addresses rather than corrupting the helm list", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "10.0.1.5\nnot-an-ip\n",
      stderr: "",
    } as never);
    await expect(discoverNodeCidrsFromCluster()).resolves.toBeNull();
  });
});

describe("discoverPodCidrsFromCluster", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("collects and de-duplicates dual-stack Node podCIDRs", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        items: [
          { spec: { podCIDRs: ["10.42.0.0/24", "fd00:42::/64"] } },
          { spec: { podCIDRs: ["10.42.1.0/24", "fd00:42::/64"] } },
        ],
      }),
      stderr: "",
    } as never);

    await expect(discoverPodCidrsFromCluster()).resolves.toBe(
      "10.42.0.0/24,fd00:42::/64,10.42.1.0/24",
    );
  });

  it("rejects malformed CIDRs and unreadable API responses", async () => {
    vi.mocked(exec.execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ items: [{ spec: { podCIDR: "10.42.0.0/99" } }] }),
      stderr: "",
    } as never);
    await expect(discoverPodCidrsFromCluster()).resolves.toBeNull();

    vi.mocked(exec.execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: "not json",
      stderr: "",
    } as never);
    await expect(discoverPodCidrsFromCluster()).resolves.toBeNull();
  });
});

describe("discoverClusterNodeCidrs (S22: strict posture needs the kubelet's source range)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const OPTS = { clusterName: "my-app-cluster", region: "us-central1", projectId: "proj-12345" };

  // Node IPs come from the cluster subnetwork's PRIMARY range, not from clusterIpv4Cidr
  // (that is the pods' secondary range). VERIFIED on a live Autopilot cluster: subnetwork
  // "default" → 10.128.0.0/20, nodes at 10.128.15.211/215/216; pods at 10.17.0.x inside
  // clusterIpv4Cidr 10.17.0.0/17. Two lookups, because the cluster resource names the
  // subnet but does not carry its range.
  it("resolves the cluster subnetwork, then that subnet's primary range", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "10.128.0.0/20\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "\n", stderr: "" }); // no extra pools

    await expect(discoverClusterNodeCidrs(OPTS)).resolves.toBe("10.128.0.0/20");

    const first = vi.mocked(exec.execCapture).mock.calls[0]?.[1];
    expect(first).toContain("--format=value(subnetwork)");
    const second = vi.mocked(exec.execCapture).mock.calls[1]?.[1];
    expect(second).toContain("--format=value(ipCidrRange)");
    expect(second).toContain("default");
  });

  it("unions any additional node-pool subnets on Standard clusters", async () => {
    // Standard clusters can attach node pools to their own subnets, so the cluster's
    // subnetwork alone can miss the nodes running the pool pods.
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "10.128.0.0/20\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\nother-subnet\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "10.200.0.0/20\n", stderr: "" });

    await expect(discoverClusterNodeCidrs(OPTS)).resolves.toBe("10.128.0.0/20,10.200.0.0/20");
  });

  it("Autopilot blocks node-pool enumeration — the cluster subnet still suffices", async () => {
    // MEASURED: `gcloud container node-pools list` on Autopilot exits non-zero with
    // "Autopilot node pools cannot be accessed or modified". Autopilot runs every node in
    // the cluster subnetwork, so that failure must not be fatal.
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "10.128.0.0/20\n", stderr: "" })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: "",
        stderr: "Autopilot node pools cannot be accessed or modified.",
      });

    await expect(discoverClusterNodeCidrs(OPTS)).resolves.toBe("10.128.0.0/20");
  });

  it("throws when the subnet range cannot be established (fail-closed)", async () => {
    // Rendering strict WITHOUT this range makes the template `fail`, and guessing it wrong
    // leaves every pod unready under Calico. Neither is something to paper over.
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "forbidden" });

    await expect(discoverClusterNodeCidrs(OPTS)).rejects.toThrow(
      /refusing to deploy without network isolation/,
    );
  });

  it("throws on a malformed range rather than corrupting the helm list", async () => {
    vi.mocked(exec.execCapture)
      .mockResolvedValueOnce({ exitCode: 0, stdout: "default\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "10.128.0.0/20 SET LEGACY\n", stderr: "" });

    await expect(discoverClusterNodeCidrs(OPTS)).rejects.toThrow(/unexpected value/);
  });

  it("--allow-no-network-policy opts out: warns and returns null", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(
      discoverClusterNodeCidrs({ ...OPTS, allowNoNetworkPolicy: true }),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// First-upgrade probe migration. `helm upgrade` rewrites the stable HealthCheckPolicy BEFORE
// the cutover, while the ACTIVE pods are still the OUTGOING build's — and a build produced by
// an adapter from before /readyz existed answers only /healthz. Flipping the load balancer to
// /readyz in that window can mark every serving endpoint unhealthy, i.e. the upgrade itself
// causes the outage. So the probe stays on /healthz for one cycle unless recorded state says
// the live build serves /readyz.
// ---------------------------------------------------------------------------
describe("buildHelmUpgradeArgs — poolHealthCheckPath", () => {
  const base = {
    releaseName: "my-app",
    chartPath: "/tmp/chart",
    buildId: "b2",
    registry: "gcr.io/proj-12345",
  };

  it("omits the override for a fresh install (no previous build to strand)", () => {
    const args = buildHelmUpgradeArgs({ ...base, previousBuildId: null });
    expect(args.join(" ")).not.toContain("poolHealthCheckPath");
  });

  it("keeps the LB on /healthz for one cycle when the override is requested", () => {
    const args = buildHelmUpgradeArgs({
      ...base,
      previousBuildId: "b1",
      poolHealthCheckPath: "/healthz",
    });
    expect(args).toContain("poolHealthCheckPath=/healthz");
  });

  it("omits it once the outgoing build is known to serve /readyz", () => {
    const args = buildHelmUpgradeArgs({ ...base, previousBuildId: "b1" });
    expect(args.join(" ")).not.toContain("poolHealthCheckPath");
  });

  it("validates the path — it lands in a bare YAML scalar in the HealthCheckPolicy", () => {
    expect(() =>
      buildHelmUpgradeArgs({
        ...base,
        previousBuildId: "b1",
        poolHealthCheckPath: '/readyz"\n      injected: yes',
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// discoverServingBuildId recovers the live build when deploy state is missing or corrupt. It
// read the build id out of the image tag, which broke once images became digest-pinned:
// per-pool images yield different digest hexes, so the "Deployments disagree" guard aborted
// every recovery on a deployment created by the normal path.
// ---------------------------------------------------------------------------
describe("discoverServingBuildId — digest-pinned images", () => {
  const jsonpathLine = (name: string, image: string, buildId = "") => `${name}|${image}|${buildId}`;

  function mockKubectl(deploymentLines: string[]) {
    vi.mocked(exec.execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      // First call lists the stable active Services (name|component|version selector);
      // second lists the Deployments carrying that version label.
      if (args.includes("svc")) {
        return { exitCode: 0, stdout: "rel-ssr|ssr|b-42\nrel-api|api|b-42\n", stderr: "" };
      }
      return { exitCode: 0, stdout: deploymentLines.join("\n"), stderr: "" };
    }) as never);
  }

  it("uses NEXT_BUILD_ID when the images are digest-pinned", async () => {
    const d = `sha256:${"a".repeat(64)}`;
    mockKubectl([
      jsonpathLine("rel-ssr-b42", `gcr.io/p/nextjs-app-ssr@${d}`, "b-42"),
      jsonpathLine("rel-api-b42", `gcr.io/p/nextjs-app-api@sha256:${"c".repeat(64)}`, "b-42"),
    ]);
    await expect(discoverServingBuildId("rel")).resolves.toBe("b-42");
  });

  it("still works for pre-digest Deployments with no env (tag fallback)", async () => {
    // The recovered id must still sanitize to the Service's version selector ("b-42").
    mockKubectl([
      jsonpathLine("rel-ssr-b42", "gcr.io/p/nextjs-app-ssr:b-42"),
      jsonpathLine("rel-api-b42", "gcr.io/p/nextjs-app-api:b-42"),
    ]);
    await expect(discoverServingBuildId("rel")).resolves.toBe("b-42");
  });

  it("still refuses when Deployments genuinely disagree about the build", async () => {
    mockKubectl([
      jsonpathLine("rel-ssr-b42", "gcr.io/p/nextjs-app-ssr:one", "one"),
      jsonpathLine("rel-api-b42", "gcr.io/p/nextjs-app-api:two", "two"),
    ]);
    await expect(discoverServingBuildId("rel")).rejects.toThrow();
  });
});
