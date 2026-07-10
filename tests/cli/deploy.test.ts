// tests/cli/deploy.test.ts
import { describe, it, expect } from "vitest";
import { buildDockerCommands, buildHelmUpgradeArgs } from "../../src/cli/deploy.js";

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
      previousBuildId: "123/old",
    });

    expect(args.join(" ")).toContain("activeBuildId=b-123-old");
  });
});
