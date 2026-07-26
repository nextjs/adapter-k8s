// tests/cli/deploy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  buildDockerCommands,
  buildHelmUpgradeArgs,
  assertSafePoolName,
  discoverClusterPodCidr,
  discoverServingBuildId,
  resolveImageDigest,
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
// resolveImageDigest — RepoDigests belongs to the image ID, so one local image tagged and
// pushed to several repositories carries an entry per repository. Taking index 0 and pairing
// its digest with the repository being deployed can name a manifest that does not exist there,
// leaving the new pods in ImagePullBackOff.
// ---------------------------------------------------------------------------
describe("resolveImageDigest", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;
  const DIGEST_B = `sha256:${"b".repeat(64)}`;

  function mockInspect(stdout: string, exitCode = 0) {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode, stdout, stderr: "" });
  }

  it("selects the entry whose repository matches the pushed image", async () => {
    mockInspect(
      `other.registry/nextjs-app-ssr@${DIGEST_B}\ngcr.io/proj/nextjs-app-ssr@${DIGEST_A}\n`,
    );
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBe(DIGEST_A);
  });

  it("returns null when no entry matches, rather than guessing", async () => {
    mockInspect(`other.registry/nextjs-app-ssr@${DIGEST_B}\n`);
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });

  it("returns null (deploy warns, does not fail) when inspect fails or reports nothing", async () => {
    mockInspect("", 1);
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
    mockInspect("\n");
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });

  it("rejects a malformed digest", async () => {
    mockInspect("gcr.io/proj/nextjs-app-ssr@sha256:nope\n");
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// discoverServingBuildId recovers the live build when deploy state is missing or corrupt. It
// read the build id out of the image tag, which broke once images became digest-pinned:
// per-pool images yield different digest hexes, so the "Deployments disagree" guard aborted
// every recovery on a deployment created by the normal path.
// ---------------------------------------------------------------------------
describe("discoverServingBuildId — digest-pinned images", () => {
  const jsonpathLine = (name: string, image: string, buildId = "") =>
    `${name}|${image}|${buildId}`;

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
