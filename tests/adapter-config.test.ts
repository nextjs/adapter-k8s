import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createK8sAdapter } from "../src/adapter.js";
import { mockOutputs, mockAppPage, mockRouting } from "./helpers/mock-outputs.js";
import type { K8sAdapterConfig } from "../src/types.js";

const validConfig: K8sAdapterConfig = {
  pools: { ssr: { routes: ["appPages"] } },
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke",
        hosts: [{ hostname: "example.com", tls: { enabled: true } }],
      },
    },
  },
};

describe("createK8sAdapter config normalization", () => {
  it("validates a directly supplied config", async () => {
    const adapter = createK8sAdapter({
      ...validConfig,
      pools: { Bad_Name: { routes: ["appPages"] } },
    });

    await expect(adapter.modifyConfig!({} as any, {} as any)).rejects.toThrow(/pool name/);
  });

  it("applies defaults to a directly supplied config", async () => {
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);

    expect((adapter as any).config.containerStrategy).toBe("traced-assets");
    expect((adapter as any).config.provider.gke.cdn.enabled).toBe(false);
  });

  // N14: Next pins the build id to the constant `build-TfctsWXpff2fKS` whenever
  // deploymentId is set (getBuildId in next/src/build/index.ts), and every blue/green
  // resource name + the CDN cutover cache-tag derive from the build id — so consecutive
  // deploys would collide. WARN at build time (the Next e2e deploy harness sets
  // NEXT_DEPLOYMENT_ID deliberately and never cuts over); deploy refuses the cutover.
  it("warns about next.config deploymentId but still builds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = createK8sAdapter(validConfig);
      await expect(
        adapter.modifyConfig!({ deploymentId: "dpl-abc123" } as any, {} as any),
      ).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join(" ")).toMatch(/deploymentId.*build id/s);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn without deploymentId", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = createK8sAdapter(validConfig);
      await expect(adapter.modifyConfig!({} as any, {} as any)).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join(" ")).not.toMatch(/deploymentId/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("buildId validation at build time (H2)", () => {
  // The finalized buildId flows into helm --set values, K8s names/labels, image tags and
  // chart YAML — an unsafe one (e.g. a git branch from a custom generateBuildId) must
  // fail the build at the source, before any artifact is emitted.
  it.each([
    ['feature/foo";rm', "YAML/shell breakout"],
    ["foo,bar=baz", "helm --set metacharacters"],
    ["foo\\bar", "helm --set escape char"],
    ["line1\nline2", "newline"],
  ])("rejects an unsafe buildId (%s)", async (buildId) => {
    const adapter = createK8sAdapter(validConfig);
    await expect(
      adapter.onBuildComplete!({
        buildId,
        routing: {},
        outputs: {},
        projectDir: "/nonexistent",
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).rejects.toThrow(/Invalid buildId/);
  });

  it("mentions the generateBuildId contract in the error", async () => {
    const adapter = createK8sAdapter(validConfig);
    await expect(
      adapter.onBuildComplete!({
        buildId: "bad,id",
        routing: {},
        outputs: {},
        projectDir: "/nonexistent",
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).rejects.toThrow(/generateBuildId/);
  });
});

// Full onBuildComplete passes in a tmp projectDir (staging skipped via env). These
// exercise the adapter-level guards that need real files: state.json, infrastructure.json.
describe("onBuildComplete build-time guards", () => {
  let projectDir: string;
  let savedSkip: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-build-"));
    savedSkip = process.env.ADAPTER_K8S_SKIP_STAGING;
    process.env.ADAPTER_K8S_SKIP_STAGING = "1";
  });

  afterEach(() => {
    if (savedSkip === undefined) delete process.env.ADAPTER_K8S_SKIP_STAGING;
    else process.env.ADAPTER_K8S_SKIP_STAGING = savedSkip;
    rmSync(projectDir, { recursive: true, force: true });
  });

  const ctx = (buildId: string, config: Record<string, unknown> = {}) =>
    ({
      buildId,
      routing: mockRouting(),
      outputs: mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] }),
      projectDir,
      config,
      nextVersion: "16.2.0",
    }) as any;

  const writeInfra = (infra: Record<string, unknown>) => {
    mkdirSync(path.join(projectDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".k8s-adapter", "infrastructure.json"),
      JSON.stringify(infra),
    );
  };

  it("completes a minimal build (skip-staging) and threads basePath into the CEL", async () => {
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    const withMiddleware = ctx("b12345", { basePath: "/docs" });
    withMiddleware.outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/_middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    await expect(adapter.onBuildComplete!(withMiddleware)).resolves.toBeUndefined();
    const cel = readFileSync(
      path.join(projectDir, ".k8s-adapter/output/cel-expression.txt"),
      "utf-8",
    );
    expect(cel).toContain("/docs/_next/static/");
  });

  it("fails the build when the build id sanitizes to the previous build's K8s name", async () => {
    mkdirSync(path.join(projectDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".k8s-adapter", "state.json"),
      JSON.stringify({ buildId: "abc-def", previousBuildId: null }),
    );
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    // "abc_def" and "abc-def" sanitize to the same K8s name — blue/green collision.
    await expect(adapter.onBuildComplete!(ctx("abc_def"))).rejects.toThrow(
      /sanitizes to the same K8s name as the previous build/,
    );
  });

  it("fails when release+pool truncation collapses distinct build ids (composed-name guard)", async () => {
    // 20-char release + 38-char pool = a 60-char `release-pool-` prefix: only 3
    // build-id chars survive the 63-char truncation, so "abc12345xyz" and
    // "abc99999xyz" produce IDENTICAL composed resource names even though
    // sanitizeK8sName(buildId) alone (the old guard's comparison) differs.
    writeInfra({ releaseName: "r".repeat(20) });
    writeFileSync(
      path.join(projectDir, ".k8s-adapter", "state.json"),
      JSON.stringify({ buildId: "abc12345xyz", previousBuildId: null }),
    );
    const adapter = createK8sAdapter({
      ...validConfig,
      pools: { ["p".repeat(38)]: { routes: ["appPages"] } },
    });
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("abc99999xyz"))).rejects.toThrow(
      /sanitizes to the same K8s name as the previous build/,
    );
  });

  it("accepts a build id that sanitizes distinctly from the previous build", async () => {
    mkdirSync(path.join(projectDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".k8s-adapter", "state.json"),
      JSON.stringify({ buildId: "abc-def", previousBuildId: null }),
    );
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("xyz-123"))).resolves.toBeUndefined();
  });

  it("ignores a corrupt state.json (best-effort; deploy re-checks authoritatively)", async () => {
    mkdirSync(path.join(projectDir, ".k8s-adapter"), { recursive: true });
    writeFileSync(path.join(projectDir, ".k8s-adapter", "state.json"), "{not json");
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).resolves.toBeUndefined();
  });

  it("rejects an unsafe projectId/region from infrastructure.json before emitting the chart", async () => {
    writeInfra({ projectId: 'bad";inject: true', region: "us-central1" });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).rejects.toThrow(/Unsafe projectId/);

    writeInfra({ projectId: "my-project-1", region: "us-central1;reboot" });
    const adapter2 = createK8sAdapter(validConfig);
    await adapter2.modifyConfig!({} as any, {} as any);
    await expect(adapter2.onBuildComplete!(ctx("b12345"))).rejects.toThrow(/Unsafe region/);
  });

  it("accepts a valid projectId/region from infrastructure.json", async () => {
    writeInfra({ projectId: "my-project-1", region: "us-central1" });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).resolves.toBeUndefined();
  });

  it("rejects a non-default namespace from infrastructure.json (fail-fast, actionable)", async () => {
    // The namespace feeds ONLY the ext_proc extension-chain authority; every
    // kubectl/helm call pins the literal "default" (init binds Workload Identity
    // there). Honoring "prod" here shipped workloads to default while the GXLB
    // callout targeted prod — every edge callout failed. The build must refuse.
    writeInfra({ namespace: "prod" });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).rejects.toThrow(
      /Unsupported namespace "prod".*deploys only to the "default" namespace.*Remove "namespace"/s,
    );
  });

  it('accepts an explicit namespace of "default" (and none at all)', async () => {
    writeInfra({ namespace: "default" });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).resolves.toBeUndefined();
  });

  it("still rejects an UNSAFE namespace with the injection-guard message", async () => {
    // assertSafeNamespace runs first: a value that could break YAML/CEL gets the
    // injection error, not the unsupported-namespace one.
    writeInfra({ namespace: 'bad";inject' });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).rejects.toThrow(/Unsafe namespace/);
  });

  it("falls back to releaseName 'nextjs' for an all-symbols project-dir basename", async () => {
    const symbolDir = path.join(projectDir, "!!!");
    mkdirSync(symbolDir, { recursive: true });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(
      adapter.onBuildComplete!({
        buildId: "b12345",
        routing: mockRouting(),
        outputs: mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] }),
        projectDir: symbolDir,
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).resolves.toBeUndefined();
    const gateway = readFileSync(
      path.join(symbolDir, ".k8s-adapter/output/chart/templates/gateway.yaml"),
      "utf-8",
    );
    expect(gateway).toContain("nextjs-gateway");
  });

  it("caps an over-long project-dir basename fallback releaseName at 40 chars", async () => {
    // Mirrors validateConfig's 40-char release cap: an uncapped fallback used to flow
    // into template rendering and fail there with a far less actionable error.
    const longDir = path.join(projectDir, "x".repeat(50));
    mkdirSync(longDir, { recursive: true });
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(
      adapter.onBuildComplete!({
        buildId: "b12345",
        routing: mockRouting(),
        outputs: mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] }),
        projectDir: longDir,
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).resolves.toBeUndefined();
    const gateway = readFileSync(
      path.join(longDir, ".k8s-adapter/output/chart/templates/gateway.yaml"),
      "utf-8",
    );
    expect(gateway).toContain(`${"x".repeat(40)}-gateway`);
    expect(gateway).not.toContain("x".repeat(41));
  });
});
