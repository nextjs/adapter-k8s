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

// N50 (review #22): `nextConfig.generateBuildId ?? (() => …)` never fell through, because
// Next's DEFAULT config value for generateBuildId is a FUNCTION — `() => null`
// (next/dist/server/config-shared.js). So the adapter's "K8s-friendly" generator had never
// run for any app: Next's `generateBuildId(config.generateBuildId, nanoid)` saw the null and
// used a raw 21-char nanoid (uppercase, `_`, `-`). Evidence: the committed fixture output
// carries `buildId: z84KgootQN1WpGZR3aUBj` while no fixture sets generateBuildId. That id is
// the DOCKER IMAGE TAG for every emitted image, and a tag must match `[\w][\w.-]*`, so
// roughly 1 nanoid in 64 begins with `-` and fails `docker build` — after a full build.
describe("K8s-friendly build id generation (N50)", () => {
  const generatedId = async (nextConfig: Record<string, unknown>) => {
    const adapter = createK8sAdapter(validConfig);
    const modified = (await adapter.modifyConfig!(nextConfig as any, {} as any)) as {
      generateBuildId: () => Promise<string | null>;
    };
    return modified.generateBuildId();
  };

  it("generates a lowercase-alnum id when the config carries Next's default `() => null`", async () => {
    const id = await generatedId({ generateBuildId: () => null });
    expect(id).toMatch(/^b[0-9a-z]+$/);
    // Docker-tag safe (`[\w][\w.-]*`) — never a leading "-" or ".".
    expect(id).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
  });

  it("generates one when generateBuildId is absent entirely", async () => {
    expect(await generatedId({})).toMatch(/^b[0-9a-z]+$/);
  });

  it("honors a real user generateBuildId (sync and async)", async () => {
    expect(await generatedId({ generateBuildId: () => "git-sha-abc" })).toBe("git-sha-abc");
    expect(await generatedId({ generateBuildId: async () => "async-id" })).toBe("async-id");
  });

  it("falls back when the user's generator declines (null/undefined/empty)", async () => {
    for (const value of [null, undefined, ""]) {
      expect(await generatedId({ generateBuildId: () => value })).toMatch(/^b[0-9a-z]+$/);
    }
  });

  it("produces distinct ids across calls (blue/green names derive from it)", async () => {
    const ids = new Set<string | null>();
    for (let i = 0; i < 20; i++) ids.add(await generatedId({}));
    expect(ids.size).toBeGreaterThan(1);
  });
});

// N50 (review #29): `if (existsSync(src))` around the cache-handler copy meant a missing
// bundle silently dropped `next.config.cacheHandler` — ISR/PPR-shell revalidation stopped
// being cross-replica with no log line, while build-metadata still advertised the cache and
// deploy provisioned a Memorystore instance the incremental cache never used.
describe("cache handler bundle is required when cache.enabled (N50)", () => {
  it("throws, naming the missing bundle and `npm run build`", async () => {
    const emptyDir = mkdtempSync(path.join(os.tmpdir(), "adapter-nobundles-"));
    const saved = process.env.ADAPTER_K8S_BUNDLE_DIR;
    process.env.ADAPTER_K8S_BUNDLE_DIR = emptyDir;
    try {
      const adapter = createK8sAdapter({ ...validConfig, cache: { enabled: true } });
      await expect(adapter.modifyConfig!({} as any, {} as any)).rejects.toThrow(
        /Missing adapter runtime bundle.*cache-handler\.cjs.*npm run build/s,
      );
    } finally {
      if (saved === undefined) delete process.env.ADAPTER_K8S_BUNDLE_DIR;
      else process.env.ADAPTER_K8S_BUNDLE_DIR = saved;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("the per-process memory cache is disabled when the shared cache is registered", () => {
  // Next fronts any custom cacheHandler with a per-process in-memory LRU whose tag manifest
  // is process-local. Across replicas that layer is incoherent by construction: a
  // revalidateTag on another pod (or in an edge sandbox on the SAME pod) never invalidates
  // it, so a tagged fetch entry pins for its whole revalidate window. Measured on GKE via
  // upstream app-static's "revalidate tag correctly with edge route handler" (2026-07-30).
  it("sets cacheMaxMemorySize: 0 alongside the cacheHandler", async () => {
    const saved = process.env.ADAPTER_K8S_BUNDLE_DIR;
    process.env.ADAPTER_K8S_BUNDLE_DIR = path.join(__dirname, "..", "dist");
    try {
      const adapter = createK8sAdapter({ ...validConfig, cache: { enabled: true } });
      const modified = await adapter.modifyConfig!({} as any, {} as any);
      expect((modified as { cacheHandler?: string }).cacheHandler).toBeTruthy();
      expect((modified as { cacheMaxMemorySize?: number }).cacheMaxMemorySize).toBe(0);
    } finally {
      if (saved === undefined) delete process.env.ADAPTER_K8S_BUNDLE_DIR;
      else process.env.ADAPTER_K8S_BUNDLE_DIR = saved;
    }
  });

  it("leaves cacheMaxMemorySize alone when the cache is disabled", async () => {
    const adapter = createK8sAdapter(validConfig);
    const modified = await adapter.modifyConfig!({} as any, {} as any);
    expect((modified as { cacheMaxMemorySize?: number }).cacheMaxMemorySize).toBeUndefined();
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

  // N50 (review #22): BUILD_ID_RE permits a leading "." or "-", which `docker build -t`
  // rejects with "invalid reference format" — after the whole build. Assert the tighter
  // Docker-tag charset at the same place the build id is validated.
  it.each(["-leading-hyphen", ".leading-dot"])(
    "rejects a build id that is not a valid Docker tag (%s)",
    async (buildId) => {
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
      ).rejects.toThrow(/cannot be used as a Docker image tag/);
    },
  );

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

  it("completes a minimal build (skip-staging) and emits a valid CEL for a basePath app", async () => {
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
    // The CEL is now a constant: basePath no longer appears because nothing is excluded.
    // Threading basePath through the build is still exercised elsewhere (the emitted routes,
    // manifest and probe-path guard all consume it); what this asserts is that a basePath app
    // still produces a valid match condition.
    expect(cel).toBe("true");
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

  // N62 (review #25, routing-tier handoff): pools `api` + `api-v2` with buildId `v2` emit the
  // SAME Service/Deployment name (`<release>-api-v2`) — once as api's versioned object and
  // once as api-v2's stable one. helm writes both documents and last-writer-wins, so the
  // HTTPRoute backendRef can resolve to the wrong pool's pods and the cutover patches the
  // wrong object's selector. The pre-existing guard only ran when state.json held a previous
  // build id, i.e. never on a first deploy or from a fresh CI checkout (.k8s-adapter/ is
  // gitignored), so this check must sit outside it.
  it("fails when two pool names collide within THIS build (no state.json needed)", async () => {
    const adapter = createK8sAdapter({
      ...validConfig,
      pools: { api: { routes: ["appRoutes"] }, "api-v2": { routes: ["appPages"] } },
    });
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("v2"))).rejects.toThrow(
      /pool names collide within build "v2".*emitted TWICE/s,
    );
  });

  it("accepts colliding-looking pool names when the build id does not bridge them", async () => {
    const adapter = createK8sAdapter({
      ...validConfig,
      pools: { api: { routes: ["appRoutes"] }, "api-v2": { routes: ["appPages"] } },
    });
    await adapter.modifyConfig!({} as any, {} as any);
    await expect(adapter.onBuildComplete!(ctx("b12345"))).resolves.toBeUndefined();
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
