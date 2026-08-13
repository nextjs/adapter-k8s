// tests/pipeline/images.test.ts
// Moved from tests/cli/deploy.test.ts with the GitOps PR1 extraction of the pipeline-safe
// deploy steps into src/pipeline/ (A6/A7 image build/push + fetch-cache restage, and the
// L15 pool-name guard). The tests are unchanged; only the import path moved.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import {
  assertSafePoolName,
  buildDockerCommands,
  refreshFetchCacheStaging,
} from "../../src/pipeline/images.js";
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

  it("copies once into the shared pool base for the layered traced-assets layout", () => {
    write(".next/cache/fetch-cache/abc123", "entry-bytes");
    write(".k8s-adapter/output/pool-base/fetch-cache/.keep");
    write(".k8s-adapter/output/pools/ssr/context/pool-manifest.json");
    write(".k8s-adapter/output/pools/api/context/pool-manifest.json");
    write(
      ".k8s-adapter/output/pools/ssr/context/.k8s-adapter/fetch-cache-seed/stale",
      "old-cli seed",
    );
    write(
      ".k8s-adapter/output/pools/api/context/.k8s-adapter/fetch-cache-seed/stale",
      "old-cli seed",
    );

    refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
      distDir: ".next",
      pools: ["ssr", "api"],
      containerStrategy: "traced-assets",
      poolImageLayout: "shared-base-v1",
    });

    expect(
      readFileSync(
        path.join(
          projectDir,
          ".k8s-adapter/output/pool-base/fetch-cache/.k8s-adapter/fetch-cache-seed/abc123",
        ),
        "utf8",
      ),
    ).toBe("entry-bytes");
    for (const pool of ["ssr", "api"]) {
      expect(
        existsSync(
          path.join(
            projectDir,
            `.k8s-adapter/output/pools/${pool}/context/.k8s-adapter/fetch-cache-seed`,
          ),
        ),
      ).toBe(false);
    }
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

  it("refuses an image layout that this CLI does not understand", () => {
    write(".next/cache/fetch-cache/abc", "x");
    expect(() =>
      refreshFetchCacheStaging(projectDir, path.join(projectDir, ".k8s-adapter/output"), {
        pools: ["ssr"],
        containerStrategy: "traced-assets",
        poolImageLayout: "shared-base-v2",
      }),
    ).toThrow(/Unsupported.*shared-base-v2.*Upgrade/);
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

  it("builds one local pool base and makes every thin pool image inherit it", () => {
    const registry = "ghcr.io/example/app";
    const commands = buildDockerCommands({
      pools: ["web", "api"],
      buildId: "abc123",
      registry,
      outputDir: ".k8s-adapter/output",
      containerStrategy: "traced-assets",
      poolImageLayout: "shared-base-v1",
      includeRoutingService: false,
    });

    expect(commands).toHaveLength(6);
    expect(commands[0]!.description).toBe("Build shared pool base");
    expect(commands[0]!.args.at(-1)).toBe(".k8s-adapter/output/pool-base");
    const baseTag = commands[0]!.args[commands[0]!.args.indexOf("-t") + 1]!;
    expect(baseTag).toMatch(/^localhost\/adapter-k8s-pool-base:[a-f0-9]{24}$/);
    expect(commands.filter((command) => command.description.includes("Push shared"))).toEqual([]);
    expect(commands[1]).toEqual({
      description: "Verify shared pool base is visible in the container CLI image store",
      command: "docker",
      args: ["image", "inspect", baseTag],
    });
    for (const pool of ["web", "api"]) {
      const build = commands.find((command) => command.description === `Build ${pool} image`)!;
      expect(build.args).toContain("--build-arg");
      expect(build.args).toContain(`POOL_BASE_IMAGE=${baseTag}`);
      expect(build.args.at(-1)).toBe(`.k8s-adapter/output/pools/${pool}`);
    }
    expect(commands[3]!.description).toBe("Push web image");
    expect(commands[5]!.description).toBe("Push api image");
  });

  it("refuses build commands for an unknown pool image layout", () => {
    expect(() =>
      buildDockerCommands({
        pools: ["web", "api"],
        buildId: "abc123",
        registry: "ghcr.io/example/app",
        outputDir: "out",
        containerStrategy: "traced-assets",
        poolImageLayout: "shared-base-v2" as never,
      }),
    ).toThrow(/Unsupported.*shared-base-v2.*Upgrade/);
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
