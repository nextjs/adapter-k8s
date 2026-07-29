// tests/cli/deploy.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  buildDockerCommands,
  buildHelmUpgradeArgs,
  assertSafePoolName,
  discoverClusterPodCidr,
  discoverClusterNodeCidrs,
  resolveRegistryDigest,
  resolveDeployImageDigests,
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

  it("S24: uses the resolved container CLI, not a hardcoded docker", () => {
    const commands = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry: "reg/nextjs",
      outputDir: "out",
      containerStrategy: "traced-assets",
      containerCli: "podman",
    });
    const buildAndPush = commands.filter((c) => c.command !== "gcloud");
    expect(buildAndPush.length).toBeGreaterThan(0);
    expect(buildAndPush.every((c) => c.command === "podman")).toBe(true);
  });

  it("S24: defaults to docker when no CLI is supplied", () => {
    const commands = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry: "reg/nextjs",
      outputDir: "out",
      containerStrategy: "traced-assets",
    });
    expect(commands.filter((c) => c.command !== "gcloud").every((c) => c.command === "docker")).toBe(
      true,
    );
  });

  it("S24: pins every build to the target platform", () => {
    // A host-native build on Apple Silicon yields arm64 images that die with `exec format
    // error` on GKE's x86 nodes — after a rollout, not at build time.
    const commands = buildDockerCommands({
      pools: ["ssr", "api"],
      buildId: "abc123",
      registry: "reg/nextjs",
      outputDir: "out",
      containerStrategy: "traced-assets",
    });
    const builds = commands.filter((c) => c.args.includes("build"));
    expect(builds.length).toBe(3); // 2 pools + routing service
    for (const b of builds) expect(b.args).toContain("--platform=linux/amd64");
    // ...and never on a push, which takes no such flag.
    for (const p of commands.filter((c) => c.args.includes("push"))) {
      expect(p.args.join(" ")).not.toContain("--platform");
    }
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
    const args = buildHelmUpgradeArgs({ ...base, podCidrs: "10.4.0.0/14", nodeCidrs: "10.128.0.0/20" });
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

describe("resolveRegistryDigest (S23: the registry is authoritative, not the local daemon)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REF = "us-central1-docker.pkg.dev/proj/nextjs/routing-service:build1";

  // `docker inspect` reports RepoDigests only when the LOCAL daemon recorded a push. podman,
  // buildx with certain drivers, and any push that did not go through this daemon leave it
  // empty — and the old code answered that by deploying the MUTABLE tag, on pods that hold
  // the internal dispatch secret. But the image was just pushed: the registry knows the
  // digest. VERIFIED live — `gcloud artifacts docker images describe` returned byte-identical
  // sha256 to `docker inspect` for the same ref.
  it("resolves the digest from the registry", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "sha256:" + "a".repeat(64) + "\n",
      stderr: "",
    });
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBe("sha256:" + "a".repeat(64));
    const args = vi.mocked(exec.execCapture).mock.calls[0]?.[1];
    expect(args).toContain("--format=value(image_summary.digest)");
    expect(args).toContain(REF);
  });

  it("returns null when the registry cannot be reached", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBeNull();
  });

  it("returns null on a malformed digest rather than passing it to helm", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "not-a-digest\n",
      stderr: "",
    });
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBeNull();
  });
});

describe("resolveDeployImageDigests (S23: image integrity fails closed)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REFS: Array<[string, string]> = [
    ["ssr", "reg/nextjs-app-ssr:build1"],
    ["routingService", "reg/routing-service:build1"],
  ];
  const SHA_A = "sha256:" + "a".repeat(64);
  const SHA_B = "sha256:" + "b".repeat(64);
  const dockerOk = (ref: string, sha: string) => ({
    exitCode: 0,
    stdout: `${ref.slice(0, ref.lastIndexOf(":"))}@${sha}\n`,
    stderr: "",
  });

  // NOTE: this originally asserted the OPPOSITE — local-first, with the registry as fallback
  // and an explicit "no registry round-trip" check. Running a real podman deploy disproved
  // that premise (see the S25 cases below): podman's local RepoDigest is not the digest the
  // registry stores, and deploying it fails the rollout. Registry-first is the contract now.
  it("uses the local daemon's digest when it agrees with the registry", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") {
        const ref = args.find((a) => a.includes("/")) ?? "";
        return { exitCode: 0, stdout: (ref.includes("routing") ? SHA_B : SHA_A) + "\n", stderr: "" };
      }
      const ref = args[args.length - 1]!;
      return dockerOk(ref, ref.includes("routing") ? SHA_B : SHA_A);
    }) as never);

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).resolves.toEqual({
      ssr: SHA_A,
      routingService: SHA_B,
    });
  });

  it("S25: prefers the REGISTRY over the local daemon (podman reports a different digest)", async () => {
    // MEASURED with podman 6.0.1 against Artifact Registry: podman converts the manifest on
    // push, so its local RepoDigest is NOT the digest the registry stored —
    //   podman inspect : sha256:e04a0a5b…
    //   registry       : sha256:27fa476b…
    // Deploying the local one produced ImagePullBackOff and a failed rollout on a live
    // cluster. The registry is what kubelet pulls from, so the registry is the truth; the
    // local daemon is only a fallback for when the registry cannot be reached.
    const LOCAL = "sha256:" + "e".repeat(64);
    const REGISTRY = "sha256:" + "7".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: REGISTRY + "\n", stderr: "" };
      const ref = args[args.length - 1]!;
      return { exitCode: 0, stdout: `${ref.slice(0, ref.lastIndexOf(":"))}@${LOCAL}\n`, stderr: "" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(REGISTRY);
    expect(out.routingService).toBe(REGISTRY);
  });

  it("S25: falls back to the local daemon when the registry is unreachable", async () => {
    const LOCAL = "sha256:" + "e".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 1, stdout: "", stderr: "offline" };
      const ref = args[args.length - 1]!;
      return { exitCode: 0, stdout: `${ref.slice(0, ref.lastIndexOf(":"))}@${LOCAL}\n`, stderr: "" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(LOCAL);
  });

  it("falls back to the registry when the local daemon has no RepoDigest", async () => {
    // The podman / buildx / pushed-elsewhere case. Previously this silently deployed the
    // mutable tag; now the registry answers it.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) => {
      if (cmd === "docker") return { exitCode: 0, stdout: "\n", stderr: "" }; // no RepoDigests
      return { exitCode: 0, stdout: SHA_A + "\n", stderr: "" };
    }) as never);

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).resolves.toEqual({
      ssr: SHA_A,
      routingService: SHA_A,
    });
  });

  it("THROWS when neither source can pin an image (no silent mutable-tag deploy)", async () => {
    // A retag of the mutable tag changes what runs on the next pod start or scale-up, on pods
    // that receive the internal dispatch secret and the cache credentials. That is an image
    // integrity failure, not a warning — the repo's own idiom is fail-closed plus an explicit
    // opt-out flag (cf. --allow-no-network-policy).
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });

    await expect(
      resolveDeployImageDigests({ refs: REFS, projectId: "proj" }),
    ).rejects.toThrow(/--allow-mutable-tags/);
  });

  it("names the images it could not pin", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(
      resolveDeployImageDigests({ refs: REFS, projectId: "proj" }),
    ).rejects.toThrow(/routing-service:build1/);
  });

  it("--allow-mutable-tags opts out: warns and omits the unpinned entries", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(
      resolveDeployImageDigests({ refs: REFS, projectId: "proj", allowMutableTags: true }),
    ).resolves.toEqual({});
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
