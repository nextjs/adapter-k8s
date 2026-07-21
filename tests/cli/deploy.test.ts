// tests/cli/deploy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  buildDockerCommands,
  buildHelmUpgradeArgs,
  assertSafePoolName,
  discoverClusterPodCidr,
} from "../../src/cli/deploy.js";

describe("buildDockerCommands", () => {
  it("generates docker build and push commands per pool with auth", () => {
    const registry = "us-central1-docker.pkg.dev/my-project/nextjs";
    const commands = buildDockerCommands({
      pools: ["ssr", "api"],
      buildId: "abc123",
      registry,
      outputDir: ".k8s-adapter/output",
      containerStrategy: "traced-assets",
    });

    // 1 auth + 2 pools × 2 commands each (build + push) + 2 routing = 7 commands
    expect(commands).toHaveLength(7);
    expect(commands[0]!.description).toContain("Docker authentication");
    expect(commands[1]!.args).toContain("build");
    expect(commands[1]!.args).toContain(".k8s-adapter/output/pools/ssr");
    expect(commands[1]!.args).toContain(`${registry}/nextjs-app-ssr:abc123`);
    expect(commands[2]!.args).toContain("push");
    expect(commands[2]!.args).toContain(`${registry}/nextjs-app-ssr:abc123`);
  });

  it("generates single docker build for shared-image strategy with auth", () => {
    const registry = "us-central1-docker.pkg.dev/my-project/nextjs";
    const commands = buildDockerCommands({
      pools: ["ssr", "api"],
      buildId: "abc123",
      registry,
      outputDir: ".k8s-adapter/output",
      containerStrategy: "shared-image",
    });

    // 1 auth + 1 image × 2 commands (build + push) + 2 routing = 5 commands
    expect(commands).toHaveLength(5);
    expect(commands[0]!.description).toContain("Docker authentication");
    expect(commands[1]!.args).toContain("build");
    expect(commands[1]!.args).toContain(".k8s-adapter/output/shared-context");
    expect(commands[1]!.args).toContain(`${registry}/nextjs-app:abc123`);
  });

  it("includes routing service image in docker commands", () => {
    const commands = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
      outputDir: ".k8s-adapter/output",
      containerStrategy: "traced-assets",
    });

    const routingBuild = commands.find((c) => c.description.includes("routing service"));
    expect(routingBuild).toBeDefined();
  });
});

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
    expect(args).toContain("--take-ownership");
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

  it("omits the podCidrs helm value when not discovered", () => {
    const args = buildHelmUpgradeArgs({ ...base, podCidrs: null });
    expect(args.join(" ")).not.toContain("networkPolicy.podCidrs");
    const args2 = buildHelmUpgradeArgs({ ...base });
    expect(args2.join(" ")).not.toContain("networkPolicy.podCidrs");
  });
});

describe("assertSafePoolName (L15)", () => {
  it("accepts normal pool names", () => {
    expect(() => assertSafePoolName("default")).not.toThrow();
    expect(() => assertSafePoolName("web-1")).not.toThrow();
  });

  it("rejects path-traversal and helm-metacharacter pool names", () => {
    expect(() => assertSafePoolName("../evil")).toThrow(/Invalid pool name/);
    expect(() => assertSafePoolName("pool/sub")).toThrow(/Invalid pool name/);
    expect(() => assertSafePoolName("pool,evil")).toThrow(/Invalid pool name/);
    expect(() => assertSafePoolName("Pool")).toThrow(/Invalid pool name/);
    expect(() => assertSafePoolName("")).toThrow(/Invalid pool name/);
  });
});

describe("discoverClusterPodCidr (fail-closed NetworkPolicy discovery)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const OPTS = { clusterName: "my-app-cluster", region: "us-central1", projectId: "proj" };

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
