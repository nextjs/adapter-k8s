// tests/adapter-build-context.test.ts
//
// End-to-end-ish tests for onBuildComplete's Docker BUILD CONTEXT staging: the part that
// decides what is inside the emitted images. Hermetic — every build runs against a mkdtemp
// project with a synthetic dist dir and a synthetic adapter bundle dir
// (ADAPTER_K8S_BUNDLE_DIR), so nothing here needs `npm run build` or a real Next build.
//
// These pin the N50 review findings that are only observable at whole-build level:
//   #32 stale files in a re-used build context   #31 wasmAssets never staged
//   #33 ctx.distDir ignored                      #30 shared-image staging gaps
//   #29 silent skips of the adapter bundles      #20 non-reproducible chart/metadata
//   #34 node-runtime middleware.ts               (+ the unified pool-manifest shape)
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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

let projectDir: string;
let bundleDir: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  "ADAPTER_K8S_SKIP_STAGING",
  "ADAPTER_K8S_BUNDLE_DIR",
  "ADAPTER_K8S_INTERNAL_SECRET_KEY",
  "SOURCE_DATE_EPOCH",
];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.ADAPTER_K8S_SKIP_STAGING;
  projectDir = mkdtempSync(path.join(os.tmpdir(), "adapter-ctx-"));
  bundleDir = mkdtempSync(path.join(os.tmpdir(), "adapter-bundles-"));
  // The three esbuild bundles the emitted Dockerfiles run.
  writeFileSync(path.join(bundleDir, "pool-server.cjs"), "// pool server");
  writeFileSync(path.join(bundleDir, "routing-service.cjs"), "// routing service");
  writeFileSync(path.join(bundleDir, "cache-handler.cjs"), "// cache handler");
  process.env.ADAPTER_K8S_BUNDLE_DIR = bundleDir;
  // A fixed key makes the derived internal secret deterministic across the test's builds
  // without touching the machine's .k8s-adapter/internal-secret.key.
  process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY = "unit-test-key";
  // Deterministic builtAt (and therefore build-metadata.generatedAt).
  process.env.SOURCE_DATE_EPOCH = "1750000000";
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
});

const writeFile = (rel: string, content = "x") => {
  const abs = path.join(projectDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};

/**
 * A minimal but realistic build output tree: one app page handler, its traced chunk, the
 * Turbopack chunks dir, a public file, and the app package.json. `distDirName` exercises
 * ctx.distDir (#33).
 */
function seedProject(distDirName = ".next") {
  writeFile("package.json", JSON.stringify({ name: "app", type: "module" }));
  writeFile(`${distDirName}/BUILD_ID`, "b12345");
  const handler = writeFile(`${distDirName}/server/app/page.js`, "module.exports={}");
  const chunk = writeFile(`${distDirName}/server/chunks/[root-of-the-server]__abc.js`, "chunk");
  writeFile(`${distDirName}/server/chunks/stale-from-previous-build.js`, "stale");
  writeFile(`${distDirName}/cache/fetch-cache/entry`, "build cache");
  writeFile("public/logo.png", "png-bytes");
  // node_modules/next must be resolvable from the app for the pool image (setup-node-env).
  writeFile("node_modules/next/package.json", JSON.stringify({ name: "next", version: "16.2.10" }));
  writeFile("node_modules/next/dist/server/setup-node-env.js", "//");
  return { distDir: path.join(projectDir, distDirName), handler, chunk };
}

function ctxFor({
  distDirName = ".next",
  buildId = "b12345",
  handlerAssets = {},
  wasmAssets,
  middleware,
  config = {},
}: {
  distDirName?: string;
  buildId?: string;
  handlerAssets?: Record<string, string>;
  wasmAssets?: Record<string, string>;
  middleware?: Record<string, unknown>;
  config?: Record<string, unknown>;
} = {}) {
  const distDir = path.join(projectDir, distDirName);
  const page = mockAppPage({
    pathname: "/",
    filePath: path.join(distDir, "server/app/page.js"),
    assets: handlerAssets,
  });
  if (wasmAssets) (page as unknown as Record<string, unknown>).wasmAssets = wasmAssets;
  return {
    buildId,
    routing: mockRouting(),
    outputs: mockOutputs({
      appPages: [page],
      ...(middleware ? { middleware: middleware as never } : {}),
    }),
    projectDir,
    repoRoot: projectDir,
    distDir,
    config,
    nextVersion: "16.2.0",
  } as never;
}

const poolContext = (rel: string) =>
  path.join(projectDir, ".k8s-adapter/output/pools/ssr/context", rel);
const sharedContext = (rel: string) =>
  path.join(projectDir, ".k8s-adapter/output/shared-context", rel);
const outputFile = (rel: string) =>
  readFileSync(path.join(projectDir, ".k8s-adapter/output", rel), "utf-8");

async function build(overrides: Parameters<typeof ctxFor>[0] = {}, cfg = validConfig) {
  const adapter = createK8sAdapter(structuredClone(cfg));
  await adapter.onBuildComplete!(ctxFor(overrides));
}

// N40 (routing-tier handoff): Next never enumerates `public/` as an adapter output, so the
// CEL's per-file exclusion loop had nothing to iterate — the emitted expression carried ZERO
// per-file exclusions and the oversize warning's advice ("reduce the number of public files")
// was unactionable. adapter.ts now passes `collectPublicPathnames(projectDir)`, the same
// enumeration the static-asset manifest and the pool's pathname set use.
describe("CEL public-file exclusions (N40)", () => {
  it("excludes public files the middleware matcher does not cover, and keeps covered ones in", async () => {
    seedProject();
    writeFile("public/uncovered.txt", "not matched by the middleware matcher");
    writeFile("public/covered/inside.txt", "matched by the middleware matcher");
    const mwFile = writeFile(".next/server/middleware.js", "// mw");
    await build({
      middleware: {
        id: "middleware",
        filePath: mwFile,
        pathname: "/_middleware",
        type: 8,
        runtime: "nodejs",
        assets: {},
        // Matcher covering only /covered/*
        config: { matchers: [{ source: "/covered/:path*", sourceRegex: "^/covered(?:/(.*))?$" }] },
      },
    });

    const cel = outputFile("cel-expression.txt");
    expect(cel).toContain("request.path == '/uncovered.txt'");
    expect(cel).toContain("request.path == '/logo.png'");
    // A middleware-covered public file must NOT be excluded — an exclusion at the edge is a
    // middleware bypass (invariant 2).
    expect(cel).not.toContain("/covered/inside.txt");
    // The `_next/static` prefix exclusion is still there.
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
  });
});

describe("pool build context staging", () => {
  it("stages handler, traced assets, chunks, public files, next and @next/routing", async () => {
    const { chunk } = seedProject();
    await build({ handlerAssets: { ".next/server/app/page.js.nft.json": chunk } });

    expect(existsSync(poolContext(".next/server/app/page.js"))).toBe(true);
    expect(existsSync(poolContext(".next/server/chunks/[root-of-the-server]__abc.js"))).toBe(true);
    expect(readFileSync(poolContext("public/logo.png"), "utf-8")).toBe("png-bytes");
    expect(existsSync(poolContext("node_modules/next/package.json"))).toBe(true);
    expect(existsSync(poolContext("node_modules/@next/routing/package.json"))).toBe(true);
    expect(readFileSync(poolContext("pool-server.cjs"), "utf-8")).toBe("// pool server");
    // The CJS pin — the staged `<dist>/server/**/*.js` are CommonJS.
    expect(JSON.parse(readFileSync(poolContext("package.json"), "utf-8"))).toEqual({
      type: "commonjs",
    });
  });

  // N50 (review #32, reproduced): the pool context dirs were never wiped and `stageFile`
  // copies with `cp(..., { recursive: true })`, which MERGES — so a chunk (or a route
  // handler, or a public file) deleted from the source kept shipping inside every subsequent
  // image, and stayed reachable by the pool's filesystem paths.
  it("wipes the context before staging so deleted sources stop shipping (#32)", async () => {
    seedProject();
    await build();
    const staleInContext = poolContext(".next/server/chunks/stale-from-previous-build.js");
    expect(existsSync(staleInContext)).toBe(true);

    // Second build after the chunk and the public file are deleted from the source.
    rmSync(path.join(projectDir, ".next/server/chunks/stale-from-previous-build.js"));
    rmSync(path.join(projectDir, "public/logo.png"));
    await build();

    expect(existsSync(staleInContext)).toBe(false);
    expect(existsSync(poolContext("public/logo.png"))).toBe(false);
    // …while the current build's files are all still there.
    expect(existsSync(poolContext(".next/server/app/page.js"))).toBe(true);
    expect(existsSync(poolContext(".next/server/chunks/[root-of-the-server]__abc.js"))).toBe(true);
  });

  // N50 (review #31): Next emits edge-function WASM in a SEPARATE `wasmAssets` field and
  // staging only read `assets`/`outputs`. ext_proc fails CLOSED when the app has middleware,
  // so a middleware bundle that cannot load its WASM 500s every request.
  it("stages wasmAssets for outputs and for middleware (#31)", async () => {
    seedProject();
    const wasm = writeFile(".next/server/edge-chunks/wasm_abc.wasm", "\0asm");
    const mwFile = writeFile(".next/server/middleware.js", "// mw");
    const mwWasm = writeFile(".next/server/edge-chunks/mw_wasm.wasm", "\0asm");
    await build({
      wasmAssets: { ".next/server/edge-chunks/wasm_abc.wasm": wasm },
      middleware: {
        id: "middleware",
        filePath: mwFile,
        pathname: "/_middleware",
        type: 8,
        runtime: "edge",
        assets: {},
        wasmAssets: { ".next/server/edge-chunks/mw_wasm.wasm": mwWasm },
        config: { matchers: [] },
      },
    });

    expect(existsSync(poolContext(".next/server/edge-chunks/wasm_abc.wasm"))).toBe(true);
    expect(existsSync(poolContext(".next/server/edge-chunks/mw_wasm.wasm"))).toBe(true);
    // The ext_proc (routing-service) context runs the SAME middleware bundle at the edge.
    expect(
      existsSync(
        path.join(
          projectDir,
          ".k8s-adapter/output/routing-service/context/.next/server/edge-chunks/mw_wasm.wasm",
        ),
      ),
    ).toBe(true);
  });

  // N50 (review #33): `.next` was hardcoded at every staging site and each site was guarded
  // by existsSync, so a custom distDir staged no chunks and no `<dist>/node_modules`
  // externals — the pool could not load a single handler, silently.
  describe("custom distDir (#33)", () => {
    it("stages from ctx.distDir at the same project-relative path", async () => {
      seedProject("build");
      await build({ distDirName: "build" });
      expect(existsSync(poolContext("build/server/app/page.js"))).toBe(true);
      expect(existsSync(poolContext("build/server/chunks/[root-of-the-server]__abc.js"))).toBe(
        true,
      );
      expect(existsSync(poolContext(".next/server/chunks"))).toBe(false);
    });

    it("fails loudly when the resolved dist dir is absent", async () => {
      seedProject("build");
      await expect(build({ distDirName: "does-not-exist" })).rejects.toThrow(
        /Build output directory not found.*does-not-exist/s,
      );
    });
  });

  // N50 (review #29): a missing bundle used to stage a context whose Dockerfile still CMDs
  // the missing file — the image built, pushed, and CrashLoopBackOff'd with no build signal.
  describe("missing adapter bundles fail the build (#29)", () => {
    it.each(["pool-server.cjs", "routing-service.cjs"])("throws for a missing %s", async (name) => {
      seedProject();
      rmSync(path.join(bundleDir, name));
      await expect(build()).rejects.toThrow(
        new RegExp(`Missing adapter runtime bundle.*${name.replace(".", "\\.")}`, "s"),
      );
    });

    it("names `npm run build` in the message", async () => {
      seedProject();
      rmSync(path.join(bundleDir, "pool-server.cjs"));
      await expect(build()).rejects.toThrow(/npm run build/);
    });
  });

  // N50 (review, Medium): all three branches now build the pool manifest from one helper.
  // The SKIP_STAGING branch used a different shape (`o.id ?? o.pathname`, no filePath
  // filter), so a pool output without a filePath threw a bare TypeError there while the other
  // two branches defended against it — local emulation validated a shape production never has.
  it("emits one pool-manifest shape for staged and skip-staging builds", async () => {
    seedProject();
    await build();
    const staged = JSON.parse(readFileSync(poolContext("config/pool-manifest-ssr.json"), "utf-8"));

    process.env.ADAPTER_K8S_SKIP_STAGING = "1";
    rmSync(path.join(projectDir, ".k8s-adapter/output"), { recursive: true, force: true });
    await build();
    const skipped = JSON.parse(outputFile("pool-manifest-ssr.json"));
    expect(skipped).toEqual(staged);
  });

  it("skip-staging tolerates an output with no filePath (used to TypeError)", async () => {
    seedProject();
    process.env.ADAPTER_K8S_SKIP_STAGING = "1";
    const adapter = createK8sAdapter(structuredClone(validConfig));
    const ctx = ctxFor();
    (ctx as { outputs: { appPages: Array<Record<string, unknown>> } }).outputs.appPages.push({
      id: "/app/no-file",
      pathname: "/no-file",
      type: 4,
      runtime: "nodejs",
      assets: {},
      config: {},
    } as never);
    await expect(adapter.onBuildComplete!(ctx)).resolves.toBeUndefined();
    const manifest = JSON.parse(outputFile("pool-manifest-ssr.json"));
    expect(Object.keys(manifest.outputs)).toEqual(["/"]);
  });
});

// N50 (review #30): shared-image omitted public/ entirely (while writing a
// static-assets.json into the same context that references every public file as
// `public/<name>`), plus sharp's platform packages, the loud @next/routing resolution guard,
// and the `{"type":"commonjs"}` pin; and it baked `<dist>/cache` into the image.
describe("shared-image strategy (#30)", () => {
  const sharedConfig: K8sAdapterConfig = { ...validConfig, containerStrategy: "shared-image" };

  it("stages public/, @next/routing and a commonjs-pinned package.json; excludes dist cache", async () => {
    seedProject();
    await build({}, sharedConfig);

    expect(readFileSync(sharedContext("public/logo.png"), "utf-8")).toBe("png-bytes");
    expect(existsSync(sharedContext("node_modules/@next/routing/package.json"))).toBe(true);
    // The app's package.json is `type: module`; the image must load CJS build output.
    const pkg = JSON.parse(readFileSync(sharedContext("package.json"), "utf-8"));
    expect(pkg.type).toBe("commonjs");
    expect(pkg.name).toBe("app"); // the rest of the app's manifest is preserved
    // Build output present, build cache absent.
    expect(existsSync(sharedContext(".next/server/app/page.js"))).toBe(true);
    expect(existsSync(sharedContext(".next/cache"))).toBe(false);
    // static-assets.json references public/logo.png — which is now actually there.
    const staticManifest = JSON.parse(
      readFileSync(sharedContext("config/static-assets.json"), "utf-8"),
    ) as Array<{ filePath: string }>;
    for (const entry of staticManifest) {
      expect(existsSync(sharedContext(entry.filePath)), entry.filePath).toBe(true);
    }
  });

  it("wipes the shared context between builds", async () => {
    seedProject();
    await build({}, sharedConfig);
    expect(existsSync(sharedContext("public/logo.png"))).toBe(true);
    rmSync(path.join(projectDir, "public/logo.png"));
    await build({}, sharedConfig);
    expect(existsSync(sharedContext("public/logo.png"))).toBe(false);
  });
});

// N50 (review #20): the chart used to embed a fresh randomBytes(32) internal secret and a
// wall-clock build-metadata timestamp, so regenerating the chart for an UNCHANGED build
// produced a different chart — no way to audit invariant 5 — and rotated the dispatch secret
// out from under the pods that were still serving (middleware then ran twice per request).
describe("reproducible emit (#20)", () => {
  it("re-emitting the same build produces the same secret and metadata", async () => {
    seedProject();
    await build();
    const first = {
      secret: outputFile("chart/templates/internal-secret.yaml"),
      metadata: outputFile("build-metadata.json"),
      chartYaml: outputFile("chart/Chart.yaml"),
    };
    await build();
    expect(outputFile("chart/templates/internal-secret.yaml")).toBe(first.secret);
    expect(outputFile("build-metadata.json")).toBe(first.metadata);
    expect(outputFile("chart/Chart.yaml")).toBe(first.chartYaml);
    // generatedAt is the build's stable builtAt (SOURCE_DATE_EPOCH here), not Date.now().
    expect(JSON.parse(first.metadata).generatedAt).toBe(new Date(1750000000 * 1000).toISOString());
  });

  it("derives a DIFFERENT secret per build id, and a real secret (32 bytes hex)", async () => {
    seedProject();
    await build({ buildId: "b12345" });
    const a = outputFile("chart/templates/internal-secret.yaml");
    rmSync(path.join(projectDir, ".k8s-adapter/output"), { recursive: true, force: true });
    await build({ buildId: "b99999" });
    const b = outputFile("chart/templates/internal-secret.yaml");
    expect(a).not.toBe(b);
    expect(a).toMatch(/secret: "[0-9a-f]{64}"/);
  });

  it("persists an operator key under .k8s-adapter when no env key is set", async () => {
    delete process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY;
    seedProject();
    await build();
    const keyPath = path.join(projectDir, ".k8s-adapter/internal-secret.key");
    expect(existsSync(keyPath)).toBe(true);
    const first = outputFile("chart/templates/internal-secret.yaml");
    // A second build reuses the persisted key ⇒ same secret for the same build id.
    await build();
    expect(outputFile("chart/templates/internal-secret.yaml")).toBe(first);
  });
});

// N50 (review #34): the incremental cache handler was skipped for any file named
// `middleware.*`, even when it declares the node runtime — silently disabling cross-replica
// ISR/PPR-shell revalidation while build-metadata still advertised the cache.
describe("cache handler registration vs middleware runtime (#34)", () => {
  const cacheConfig: K8sAdapterConfig = { ...validConfig, cache: { enabled: true } };

  it("stages the handler and records it when next.config references it", async () => {
    seedProject();
    writeFile("middleware.ts", 'export const runtime = "nodejs";\nexport default function () {}\n');
    // What modifyConfig produces for a node-runtime middleware app (it writes the bundle into
    // <projectDir>/.k8s-adapter and points next.config.cacheHandler at it). Written directly
    // here so the test never depends on process.cwd() — see the hasEdgeMiddleware tests in
    // adapter-staging.test.ts for the registration decision itself.
    writeFile(".k8s-adapter/cache-handler.cjs", "// cache handler");
    await build(
      { config: { cacheHandler: path.join(projectDir, ".k8s-adapter/cache-handler.cjs") } },
      cacheConfig,
    );
    const metadata = JSON.parse(outputFile("build-metadata.json"));
    expect(metadata.cacheEnabled).toBe(true);
    expect(metadata.incrementalCacheHandler).toBe(true);
    expect(existsSync(poolContext(".k8s-adapter/cache-handler.cjs"))).toBe(true);
  });

  it("records incrementalCacheHandler:false and warns loudly for edge middleware", async () => {
    seedProject();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mwFile = writeFile(".next/server/middleware.js", "// mw");
      await build(
        {
          // no `cacheHandler` in ctx.config ⇒ modifyConfig skipped it (edge middleware)
          middleware: {
            id: "middleware",
            filePath: mwFile,
            pathname: "/_middleware",
            type: 8,
            runtime: "edge",
            assets: {},
            config: { matchers: [] },
          },
        },
        cacheConfig,
      );
      const metadata = JSON.parse(outputFile("build-metadata.json"));
      expect(metadata.incrementalCacheHandler).toBe(false);
      // cacheEnabled stays true: the managed Valkey still backs `use cache` (V2 handler).
      expect(metadata.cacheEnabled).toBe(true);
      expect(warn.mock.calls.flat().join(" ")).toMatch(/INCREMENTAL cache handler is NOT/);
      expect(existsSync(poolContext(".k8s-adapter/cache-handler.cjs"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
