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
  discoverNodeCidrsFromCluster,
  discoverPodCidrsFromCluster,
  resolveRegistryDigest,
  resolveRegistryDigestAny,
  resolveDeployImageDigests,
  discoverServingBuildId,
  detectHelmUpgradeMode,
  ensureValkeySecretHelmOwnership,
  resolveImageDigest,
  refreshFetchCacheStaging,
} from "../../src/cli/deploy.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// The build's fetch-cache is written ASYNCHRONOUSLY by the static-export workers, and
// upstream orders nothing between those writes and handleBuildComplete — measured: my
// repro build staged it fine (write landed 750ms before the staging read) while two
// consecutive harness builds shipped images WITHOUT it (the write lost the race with
// onBuildComplete's existsSync). Deploy runs minutes later, when the artifact is
// certainly on disk, so it re-stages the fetch-cache into every image context before
// `docker build`. See build-seed-index.ts fetchCacheSeed for why the files matter.
describe("refreshFetchCacheStaging", () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "deploy-fetch-cache-"));
  });
  const write = (rel: string, content = "x") => {
    const abs = path.join(projectDir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  it("copies the build fetch-cache into every pool context (traced-assets)", () => {
    write(".next/cache/fetch-cache/abc123", "entry-bytes");
    write(".k8s-adapter/output/pools/ssr/context/pool-server.cjs");
    write(".k8s-adapter/output/pools/api/context/pool-server.cjs");

    refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
      distDir: ".next",
      pools: ["ssr", "api"],
      containerStrategy: "traced-assets",
    });

    for (const pool of ["ssr", "api"]) {
      expect(
        readFileSync(
          path.join(
            projectDir,
            `.k8s-adapter/output/pools/${pool}/context/.k8s-adapter/fetch-cache-seed/abc123`,
          ),
          "utf-8",
        ),
      ).toBe("entry-bytes");
    }
  });

  it("copies into the shared context (shared-image) and replaces a stale copy", () => {
    write(".next/cache/fetch-cache/fresh", "fresh");
    write(".k8s-adapter/output/shared-context/pool-server.cjs");
    write(".k8s-adapter/output/shared-context/.k8s-adapter/fetch-cache-seed/stale", "stale");

    refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
      distDir: ".next",
      pools: ["default"],
      containerStrategy: "shared-image",
    });

    const base = path.join(
      projectDir,
      ".k8s-adapter/output/shared-context/.k8s-adapter/fetch-cache-seed",
    );
    expect(readFileSync(path.join(base, "fresh"), "utf-8")).toBe("fresh");
    // A build's staged copy is REPLACED wholesale — entries deleted from the build's
    // fetch-cache must not keep shipping (same rule as the context wipe, #32).
    expect(existsSync(path.join(base, "stale"))).toBe(false);
  });

  it("no-ops when the build produced no fetch-cache, and skips absent contexts", () => {
    write(".k8s-adapter/output/pools/ssr/context/pool-server.cjs");
    refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
      distDir: ".next",
      pools: ["ssr", "ghost"],
      containerStrategy: "traced-assets",
    });
    expect(
      existsSync(
        path.join(
          projectDir,
          ".k8s-adapter/output/pools/ssr/context/.k8s-adapter/fetch-cache-seed",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a distDir that escapes the project (metadata is build-controlled)", () => {
    write(".next/cache/fetch-cache/abc", "x");
    write(".k8s-adapter/output/pools/ssr/context/pool-server.cjs");
    const victim = path.join(path.dirname(projectDir), `victim-${path.basename(projectDir)}`);
    mkdirSync(path.join(victim, "cache/fetch-cache"), { recursive: true });
    writeFileSync(path.join(victim, "cache/fetch-cache/leak"), "outside");
    try {
      expect(() =>
        refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
          distDir: `../${path.basename(victim)}`,
          pools: ["ssr"],
          containerStrategy: "traced-assets",
        }),
      ).toThrow(/distDir/);
      expect(existsSync(path.join(projectDir, ".k8s-adapter/output/pools/ssr/context"))).toBe(true);
    } finally {
      rmSync(victim, { recursive: true, force: true });
    }
  });
});

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
    expect(
      commands.filter((c) => c.command !== "gcloud").every((c) => c.command === "docker"),
    ).toBe(true);
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

  it("pins every build to the platform recorded by the build artifact", () => {
    const commands = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry: "reg/nextjs",
      outputDir: "out",
      containerStrategy: "traced-assets",
      targetPlatform: "linux/arm64",
    });
    const builds = commands.filter((c) => c.args.includes("build"));
    expect(builds).toHaveLength(2);
    for (const command of builds) expect(command.args).toContain("--platform=linux/arm64");
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

  it("uses the composed registry authentication operation instead of hostname inference", () => {
    const registry = "us-central1-docker.pkg.dev/my-project/nextjs";
    const ambient = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry,
      outputDir: "out",
      containerStrategy: "traced-assets",
      registryAuthentication: { kind: "ambient-credentials" },
    });
    expect(ambient.some((command) => command.command === "gcloud")).toBe(false);

    expect(() =>
      buildDockerCommands({
        pools: ["ssr"],
        buildId: "abc123",
        registry,
        outputDir: "out",
        containerStrategy: "traced-assets",
        registryAuthentication: {
          kind: "gcloud-docker-helper",
          registryHost: "europe-west1-docker.pkg.dev",
        },
      }),
    ).toThrow(/authentication names host.*repository uses/i);
  });

  it("omits the routing image for portable pool-local routing", () => {
    const commands = buildDockerCommands({
      pools: ["ssr"],
      buildId: "abc123",
      registry: "ghcr.io/example/app",
      outputDir: "out",
      containerStrategy: "traced-assets",
      includeRoutingService: false,
    });
    expect(commands).toHaveLength(2);
    expect(commands.some((command) => command.description.includes("routing service"))).toBe(false);
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

describe("resolveRegistryDigestAny (S28: works on ECR/ACR/Harbor, not just Artifact Registry)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REF = "myregistry.example.com/ns/app:b1";
  const SHA = "sha256:" + "d".repeat(64);
  const singleManifest = JSON.stringify({ schemaVersion: 2, config: { digest: SHA }, layers: [] });
  const imageConfig = (architecture = "amd64") => JSON.stringify({ os: "linux", architecture });

  it("prefers crane when it is available", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd !== "crane") return { exitCode: 127, stdout: "", stderr: "not found" };
      if (args[0] === "manifest") return { exitCode: 0, stdout: singleManifest, stderr: "" };
      if (args[0] === "config") return { exitCode: 0, stdout: imageConfig(), stderr: "" };
      return { exitCode: 0, stdout: SHA + "\n", stderr: "" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("falls back to skopeo", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "skopeo"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ Digest: SHA, Os: "linux", Architecture: "amd64" }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "podman")).resolves.toBe(SHA);
  });

  it("falls back to `docker manifest inspect -v`, which needs no extra tooling", async () => {
    // VERIFIED against Artifact Registry: `docker manifest inspect -v` reported
    // sha256:ed188f20… byte-identical to `gcloud artifacts docker images describe`. It queries
    // the REGISTRY, so unlike `docker inspect` it is not the local daemon's opinion.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("manifest")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              digest: SHA,
              size: 1995,
              platform: { os: "linux", architecture: "amd64" },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("picks the TARGET PLATFORM's child from a manifest LIST, not the first entry", async () => {
    // This test previously asserted element [0], which encoded a real bug: the order of a
    // manifest list is the registry's, so an ARM-first list would pin the arm64 child and the
    // pods would die with `exec format error` on x86 nodes. The child digest is also not the
    // digest of the index the tag points at. Since the platform we build is fixed
    // (targetPlatform()), select the matching child explicitly.
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
              { Descriptor: { digest: SHA, platform: { os: "linux", architecture: "amd64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("uses the build artifact platform when selecting a manifest-list child", async () => {
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: SHA, platform: { os: "linux", architecture: "amd64" } } },
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBe(ARM);
  });

  it("refuses a manifest LIST with no child for the platform we deploy", async () => {
    // Pinning an image that cannot run is worse than failing: it deploys, then CrashLoops with
    // `exec format error` after cutover has begun.
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
  });

  it("rejects an amd64-only crane index when arm64 is requested", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "crane" && args[0] === "manifest"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 2,
              manifests: [
                {
                  digest: SHA,
                  platform: { os: "linux", architecture: "amd64" },
                },
              ],
            }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBeNull();
  });

  it("rejects a skopeo result whose reported platform differs from the request", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "skopeo"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ Digest: SHA, Os: "linux", Architecture: "amd64" }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "podman", "linux/arm64")).resolves.toBeNull();
  });

  it("rejects a single docker manifest without target-platform evidence", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? { exitCode: 0, stdout: JSON.stringify({ Descriptor: { digest: SHA } }), stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBeNull();
  });

  it("does NOT use `docker manifest inspect` for a non-docker runtime", async () => {
    // nerdctl has no `manifest inspect`, and podman's is for manifest LISTS it manages
    // locally — neither answers for a remote registry.
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "x",
    } as never);
    await resolveRegistryDigestAny(REF, "nerdctl");
    const cmds = vi.mocked(exec.execCapture).mock.calls.map(([c]) => c);
    expect(cmds).not.toContain("nerdctl");
  });

  it("returns null when no probe can answer, so the caller fails closed", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "x",
    } as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
  });

  it("rejects a malformed digest rather than passing it to helm", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd !== "crane") return { exitCode: 127, stdout: "", stderr: "x" };
      if (args[0] === "manifest") return { exitCode: 0, stdout: singleManifest, stderr: "" };
      if (args[0] === "config") return { exitCode: 0, stdout: imageConfig(), stderr: "" };
      return { exitCode: 0, stdout: "not-a-digest\n", stderr: "" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
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
    const digest = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: digest + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [{ digest, platform: { os: "linux", architecture: "amd64" } }],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBe("sha256:" + "a".repeat(64));
    const args = vi.mocked(exec.execCapture).mock.calls[0]?.[1];
    expect(args).toContain("--format=value(image_summary.digest)");
    expect(args).toContain(REF);
  });

  it("does not accept an amd64-only Artifact Registry index for an arm64 deploy", async () => {
    const index = "sha256:" + "f".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: index + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                digest: "sha256:" + "a".repeat(64),
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(resolveRegistryDigest(REF, "proj", "linux/arm64")).resolves.toBeNull();
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

describe("S27: image integrity must not depend on the CLOUD", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("resolves digests for a generic build with no GCP project", () => {
    // The digest block was gated on `infra.projectId`, which only a GCP config has. A generic
    // deploy therefore skipped resolution entirely and shipped MUTABLE TAGS — silently
    // bypassing the --allow-mutable-tags gate that exists precisely to make that a decision
    // rather than an accident. The registry probe is provider-specific; the REQUIREMENT is not.
    const SHA = "sha256:" + "c".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "inspect") {
        const ref = args[args.length - 1]!;
        return {
          exitCode: 0,
          stdout: `linux/amd64\n${ref.slice(0, ref.lastIndexOf(":"))}@${SHA}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "no gcloud here" };
    }) as never);

    return expect(
      resolveDeployImageDigests({
        refs: [["ssr", "registry.example.com/ns/app:b1"]],
        projectId: "",
        containerCli: "docker",
      }),
    ).resolves.toEqual({ ssr: SHA });
  });

  it("still fails closed for a generic build when nothing can pin the image", () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "x" });
    return expect(
      resolveDeployImageDigests({
        refs: [["ssr", "registry.example.com/ns/app:b1"]],
        projectId: "",
      }),
    ).rejects.toThrow(/--allow-mutable-tags/);
  });

  it("does not probe Artifact Registry when the plan selects OCI distribution", async () => {
    const SHA = "sha256:" + "d".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (command: string, args: string[]) => {
      if (command === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [{ digest: SHA, platform: { os: "linux", architecture: "amd64" } }],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "us-central1-docker.pkg.dev/proj/repo/app:b1"]],
        projectId: "proj",
        digestLookup: { kind: "oci-distribution" },
      }),
    ).resolves.toEqual({ ssr: SHA });
    expect(vi.mocked(exec.execCapture).mock.calls.some(([command]) => command === "gcloud")).toBe(
      false,
    );
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
    stdout: `linux/amd64\n${ref.slice(0, ref.lastIndexOf(":"))}@${sha}\n`,
    stderr: "",
  });
  const craneIndex = (ref: string, digest: string, architecture = "amd64") => ({
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          digest,
          platform: { os: "linux", architecture },
          annotations: { ref },
        },
      ],
    }),
    stderr: "",
  });

  // NOTE: this originally asserted the OPPOSITE — local-first, with the registry as fallback
  // and an explicit "no registry round-trip" check. Running a real podman deploy disproved
  // that premise (see the S25 cases below): podman's local RepoDigest is not the digest the
  // registry stores, and deploying it fails the rollout. Registry-first is the contract now.
  it("uses the platform-validated registry digest", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") {
        const ref = args.find((a) => a.includes("/")) ?? "";
        return {
          exitCode: 0,
          stdout: (ref.includes("routing") ? SHA_B : SHA_A) + "\n",
          stderr: "",
        };
      }
      if (cmd === "crane" && args[0] === "manifest") {
        const ref = args[1]!;
        return craneIndex(ref, ref.includes("routing") ? SHA_B : SHA_A);
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
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
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, REGISTRY);
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, LOCAL);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(REGISTRY);
    expect(out.routingService).toBe(REGISTRY);
  });

  it("S28: uses the generic registry probe when there is no GCP project", async () => {
    // An ECR/ACR/Harbor deploy has no projectId, so the AR probe no-ops. Before this it fell
    // straight to the local daemon — the path podman gets wrong.
    const SHA = "sha256:" + "9".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "crane" && args[0] === "manifest"
        ? craneIndex(args[1]!, SHA)
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);

    const out = await resolveDeployImageDigests({
      refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
      projectId: "",
      containerCli: "docker",
    });
    expect(out.ssr).toBe(SHA);
  });

  it("S28: prefers the REGISTRY over a disagreeing local daemon on any registry", async () => {
    const LOCAL = "sha256:" + "e".repeat(64);
    const REGISTRY = "sha256:" + "7".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, REGISTRY);
      if (cmd === "docker" && args.includes("inspect")) {
        const ref = args[args.length - 1]!;
        return dockerOk(ref, LOCAL);
      }
      return { exitCode: 127, stdout: "", stderr: "x" };
    }) as never);

    const out = await resolveDeployImageDigests({
      refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
      projectId: "",
      containerCli: "docker",
    });
    expect(out.ssr).toBe(REGISTRY);
  });

  it("S28: does NOT trust a non-docker local daemon when no registry answered", async () => {
    // MEASURED with podman 6.0.1: its local RepoDigest matched the registry for one image and
    // differed for another (e04a0a5b… vs 27fa476b…), because push can rewrite the manifest.
    // An unreliable digest is worse than none — deploying it yields ImagePullBackOff at
    // rollout, after cutover has begun. Failing at deploy time is the louder, earlier failure.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "podman" && args.includes("inspect")) {
        const ref = args[args.length - 1]!;
        return {
          exitCode: 0,
          stdout: `${ref.slice(0, ref.lastIndexOf(":"))}@sha256:${"f".repeat(64)}\n`,
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "x" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
        projectId: "",
        containerCli: "podman",
      }),
    ).rejects.toThrow(/crane|skopeo/);
  });

  it("rejects an amd64-only registry and local image when the artifact targets arm64", async () => {
    const INDEX = "sha256:" + "1".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: INDEX + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return craneIndex(args[1]!, SHA_A, "amd64");
      }
      if (cmd === "skopeo") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Digest: INDEX, Os: "linux", Architecture: "amd64" }),
          stderr: "",
        };
      }
      if (cmd === "docker" && args.includes("manifest")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Descriptor: {
                digest: SHA_A,
                platform: { os: "linux", architecture: "amd64" },
              },
            },
          ]),
          stderr: "",
        };
      }
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, SHA_A);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "us-docker.pkg.dev/p/r/app:b1"]],
        projectId: "p",
        targetPlatform: "linux/arm64",
      }),
    ).rejects.toThrow(/No registry probe could pin/);
  });

  it("S25: falls back to the local daemon when the registry is unreachable", async () => {
    const LOCAL = "sha256:" + "e".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 1, stdout: "", stderr: "offline" };
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, LOCAL);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(LOCAL);
  });

  it("falls back to the registry when the local daemon has no RepoDigest", async () => {
    // The podman / buildx / pushed-elsewhere case. Previously this silently deployed the
    // mutable tag; now the registry answers it.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: SHA_A + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, SHA_A);
      if (cmd === "docker" && args[0] === "inspect") {
        return { exitCode: 0, stdout: "linux/amd64\n", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
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

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).rejects.toThrow(
      /--allow-mutable-tags/,
    );
  });

  it("names the images it could not pin", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).rejects.toThrow(
      /routing-service:build1/,
    );
  });

  it("--allow-mutable-tags opts out: warns and omits the unpinned entries", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(
      resolveDeployImageDigests({ refs: REFS, projectId: "proj", allowMutableTags: true }),
    ).resolves.toEqual({});
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
// resolveImageDigest — RepoDigests belongs to the image ID, so one local image tagged and
// pushed to several repositories carries an entry per repository. Taking index 0 and pairing
// its digest with the repository being deployed can name a manifest that does not exist there,
// leaving the new pods in ImagePullBackOff.
// ---------------------------------------------------------------------------
describe("resolveImageDigest", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;
  const DIGEST_B = `sha256:${"b".repeat(64)}`;

  function mockInspect(stdout: string, exitCode = 0) {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode,
      stdout: exitCode === 0 ? `linux/amd64\n${stdout}` : stdout,
      stderr: "",
    });
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

  it("rejects a local image built for a different platform", async () => {
    mockInspect(`gcr.io/proj/nextjs-app-ssr@${DIGEST_A}\n`);
    await expect(
      resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1", "docker", "linux/arm64"),
    ).resolves.toBeNull();
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
