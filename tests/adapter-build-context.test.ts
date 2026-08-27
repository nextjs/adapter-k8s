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
import {
  mockOutputs,
  mockAppPage,
  mockAppRoute,
  mockPrerender,
  mockRouting,
} from "./helpers/mock-outputs.js";
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
  writeFile(`${distDirName}/cache/webpack/build-junk`, "junk");
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
// N40 originally verified that public/ files were excluded one-by-one, and that a
// middleware-COVERED file was NOT excluded (excluding it would bypass middleware at the edge).
// Public-file exclusions were removed 2026-07-29: their URLs are stable so they stay CDN-cached
// across deploys, they were the term that scaled with app content and blew GCP's 512-char
// limit, and dropping them deletes the mis-exclusion hazard entirely. The safety property N40
// existed to protect is now structural — nothing is excluded, so nothing can be mis-excluded —
// and this test pins that end-to-end through a real build.
describe("CEL public-file handling (N40, post-exclusion-removal)", () => {
  it("matches everything, so no file can be mis-excluded", async () => {
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
    // No per-file exclusions at all any more — covered or not.
    expect(cel).not.toContain("/uncovered.txt");
    expect(cel).not.toContain("/logo.png");
    // A middleware-covered public file must NOT be excluded — an exclusion at the edge is a
    // middleware bypass (invariant 2).
    expect(cel).not.toContain("/covered/inside.txt");
    // The `_next/static` prefix exclusion is still there.
    // No exclusions at all: the match condition is the constant `true`. An exclusion is a
    // middleware bypass whenever a matcher covers the excluded path, and the /_next/static/
    // one never even probed the matchers — so it went too, along with any way to get this
    // wrong.
    expect(cel).toBe("true");
  });
});

describe("pool build context staging", () => {
  it("emits one shared runtime base and thin, disjoint deltas for multiple pools", async () => {
    seedProject();
    const route = writeFile(".next/server/app/api/hello/route.js", "module.exports={}");
    const ctx = ctxFor() as any;
    ctx.outputs.appRoutes = [mockAppRoute({ pathname: "/api/hello", filePath: route, assets: {} })];
    const config: K8sAdapterConfig = {
      ...structuredClone(validConfig),
      pools: {
        web: { routes: ["appPages"] },
        api: { routes: ["appRoutes"] },
      },
    };

    await createK8sAdapter(config).onBuildComplete!(ctx);

    const output = path.join(projectDir, ".k8s-adapter/output");
    expect(
      existsSync(path.join(output, "pool-base/dependencies/node_modules/next/package.json")),
    ).toBe(true);
    expect(
      existsSync(
        path.join(output, "pool-base/content/.next/server/chunks/[root-of-the-server]__abc.js"),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(output, "pool-base/fetch-cache/.k8s-adapter/fetch-cache-seed/entry")),
    ).toBe(true);
    expect(existsSync(path.join(output, "pool-base/content/public/logo.png"))).toBe(true);
    expect(existsSync(path.join(output, "pools/web/context/public/logo.png"))).toBe(false);
    expect(existsSync(path.join(output, "pools/api/context/public/logo.png"))).toBe(false);
    expect(existsSync(path.join(output, "pools/web/context/.next/server/app/page.js"))).toBe(true);
    expect(
      existsSync(path.join(output, "pools/api/context/.next/server/app/api/hello/route.js")),
    ).toBe(true);
    expect(existsSync(path.join(output, "pools/api/context/.next/server/app/page.js"))).toBe(false);
    expect(
      existsSync(path.join(output, "pools/web/context/.next/server/app/api/hello/route.js")),
    ).toBe(false);
    expect(readFileSync(path.join(output, "pools/web/Dockerfile"), "utf8")).toContain(
      "FROM ${POOL_BASE_IMAGE}",
    );
    expect(readFileSync(path.join(output, "pool-base/Dockerfile"), "utf8")).toContain(
      "COPY --chown=node:node dependencies/ .",
    );
    expect(JSON.parse(outputFile("build-metadata.json")).poolImageLayout).toBe("shared-base-v1");
  });

  // A3-F2. The factoring above only happens when every pool reached the SAME sharp staging
  // decision. When they disagree, the build keeps standalone pool images — and that branch is
  // now the ONLY thing that puts `public/` and the prerender corpus into each pool's own
  // context. It is therefore exactly where the regression #54 was written against (a public
  // asset 404ing on the pool that receives the request, because the pathname is served from
  // the manifest by whichever pool the router picks) would come back, and the case the test
  // above cannot reach.
  //
  // Decisions can only diverge if the resolver's answer CHANGES between two pools of one
  // build — sharp's platform packages disappearing mid-build (a concurrent install, a
  // workspace/optional-dependency prune, an editor sync). That is the situation the branch
  // exists for, so it is what this reproduces: the `api` pool's asset staging removes the
  // @img packages, after the `web` pool has already staged them.
  it("divergent sharp decisions keep public/ and the prerender pair in EVERY pool context", async () => {
    seedProject();
    const sharpVersion = "0.34.2";
    writeFile(
      "node_modules/sharp/package.json",
      JSON.stringify({ name: "sharp", version: sharpVersion }),
    );
    for (const pkg of ["@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"]) {
      writeFile(
        `node_modules/${pkg}/package.json`,
        JSON.stringify({ name: pkg, version: "1.0.0" }),
      );
      writeFile(`node_modules/${pkg}/lib/sharp.node`, "linux-binary");
    }
    // A prerendered document plus the `.meta` sibling the manifest does not carry — the PPR
    // fs-mirror seed reads it, so "the .html shipped" is not enough (prerenderSiblingFiles).
    const prerenderHtml = writeFile(".next/server/app/blog/post.html", "<html>post</html>");
    writeFile(".next/server/app/blog/post.meta", '{"postponed":null}');

    const route = writeFile(".next/server/app/api/hello/route.js", "module.exports={}");
    const ctx = ctxFor() as any;
    const apiRoute = mockAppRoute({ pathname: "/api/hello", filePath: route, assets: {} });
    // The mid-build disappearance, self-sequenced: it fires the first time the `api` pool's
    // assets are read AFTER the `web` pool staged its own copy, so the two pools genuinely
    // reach different decisions ("staged" vs "install:<version>") within one build.
    Object.defineProperty(apiRoute, "assets", {
      get() {
        const webStaged = path.join(
          projectDir,
          ".k8s-adapter/output/pools/web/context/node_modules/@img/sharp-linux-x64",
        );
        if (existsSync(webStaged)) {
          rmSync(path.join(projectDir, "node_modules/@img"), { recursive: true, force: true });
        }
        return {};
      },
    });
    ctx.outputs.appRoutes = [apiRoute];
    ctx.outputs.prerenders = [
      mockPrerender({
        pathname: "/blog/post",
        sourcePage: "/",
        parentOutputId: ctx.outputs.appPages[0].id,
        fallback: { filePath: prerenderHtml } as never,
      }),
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const config: K8sAdapterConfig = {
      ...structuredClone(validConfig),
      pools: {
        web: { routes: ["appPages"] },
        api: { routes: ["appRoutes"] },
      },
    };
    await createK8sAdapter(config).onBuildComplete!(ctx);

    // The branch under test was actually taken (both decisions occurred, in one build).
    expect(warn.mock.calls.flat().join(" ")).toMatch(
      /different sharp requirements .*staged.*install:0\.34\.2|different sharp requirements .*install:0\.34\.2.*staged/,
    );
    const output = path.join(projectDir, ".k8s-adapter/output");
    // No shared layers at all — the standalone layout must not leave a half-factored base
    // behind, or the pool Dockerfiles would reference an image nothing populated.
    expect(existsSync(path.join(output, "pool-base"))).toBe(false);
    expect(JSON.parse(outputFile("build-metadata.json")).poolImageLayout).not.toBe(
      "shared-base-v1",
    );

    for (const poolName of ["web", "api"]) {
      const context = path.join(output, "pools", poolName, "context");
      // static-assets.json in THIS context claims these pathnames; a request for one can
      // arrive at either pool, so both must be able to serve it from its own image.
      const manifest = JSON.parse(
        readFileSync(path.join(context, "config/static-assets.json"), "utf-8"),
      ) as Array<{ pathname: string; filePath: string }>;
      expect(manifest.map((e) => e.pathname)).toContain("/logo.png");
      expect(manifest.map((e) => e.pathname)).toContain("/blog/post");
      expect(readFileSync(path.join(context, "public/logo.png"), "utf-8")).toBe("png-bytes");
      expect(existsSync(path.join(context, ".next/server/app/blog/post.html"))).toBe(true);
      expect(existsSync(path.join(context, ".next/server/app/blog/post.meta"))).toBe(true);
      // Standalone images, not layered deltas.
      expect(
        readFileSync(path.join(output, "pools", poolName, "Dockerfile"), "utf8"),
      ).not.toContain("FROM ${POOL_BASE_IMAGE}");
    }
  });

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

  it("drops traced Sharp packages for other platforms but retains the selected Linux pair", async () => {
    seedProject();
    const darwin = writeFile("node_modules/@img/sharp-darwin-arm64/lib/sharp.node", "darwin");
    const linux = writeFile("node_modules/@img/sharp-linux-x64/lib/sharp.node", "linux");

    await build({
      handlerAssets: {
        "node_modules/@img/sharp-darwin-arm64/lib/sharp.node": darwin,
        "node_modules/@img/sharp-linux-x64/lib/sharp.node": linux,
      },
    });

    expect(existsSync(poolContext("node_modules/@img/sharp-darwin-arm64"))).toBe(false);
    expect(existsSync(poolContext("node_modules/@img/sharp-linux-x64/lib/sharp.node"))).toBe(true);
  });

  // `next` is the APP's dependency: the staged copy must be the version the app builds
  // against, not whatever the adapter package happens to resolve. With a symlinked adapter
  // checkout (or these tests), adapter-first resolution shipped the ADAPTER repo's `next`
  // into the pool image — a silent version skew between build and runtime.
  it("stages the app's own next package, not the adapter's (app-first resolution)", async () => {
    seedProject();
    writeFile(
      "node_modules/next/package.json",
      JSON.stringify({ name: "next", version: "0.0.0-app-local" }),
    );
    await build();

    const staged = JSON.parse(readFileSync(poolContext("node_modules/next/package.json"), "utf-8"));
    expect(staged.version).toBe("0.0.0-app-local");
  });

  // The build's fetch-cache is `next start`'s warm-start content: FileSystemCache reads
  // `.next/cache/fetch-cache/<key>` for FETCH-kind entries, and the seed layer mirrors that
  // (build-seed-index.ts fetchCacheSeed). Without the files in the image, a
  // post-revalidateTag FETCH read is a MISS and upstream patch-fetch re-fetches WITH the
  // prerender's abort signal attached (a stale HIT re-fetches signal-DETACHED,
  // patch-fetch.ts:1073-1104) — under load the abort wins and the cache-components
  // background revalidation dies with "uncached or runtime data during prerendering"
  // (rdc stale-forever, traced 2026-08-04). Only fetch-cache: the sibling build caches
  // (webpack/turbopack) are the bloat the old blanket exclusion was right about. Staged at
  // .k8s-adapter/fetch-cache-seed, NOT the runtime location — the pod mounts a writable
  // emptyDir over /app/.next/cache that shadows image content (measured: the image had the
  // files, the pod showed an empty dir); the pool server restores the seed at boot.
  it("stages the build's fetch-cache seed but not the other build caches", async () => {
    seedProject();
    await build();

    expect(readFileSync(poolContext(".k8s-adapter/fetch-cache-seed/entry"), "utf-8")).toBe(
      "build cache",
    );
    expect(existsSync(poolContext(".next/cache"))).toBe(false);
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

  it("never lets a traced asset clobber the reserved config/ manifests (stale-emulate trap)", async () => {
    // Live on GKE 2026-07-30: EIGHT consecutive fixture deploys failed at the routing
    // manifest-match guard. The staged context's config/routing-manifest.json carried a build
    // id from TWO DAYS earlier — `adapter-k8s emulate` had left its scratch copies in
    // projectDir/config/, Next's file tracing swept them into the NODE middleware's asset set
    // (155 assets; the middleware shares code that reads CONFIG_DIR), and the asset-staging
    // loop then bulk-copied them OVER the fresh manifests the same build had just written.
    // The guard refused every genuinely-stale image, exactly as designed. `config/` inside a
    // build context is the adapter's reserved namespace: traced assets must never land there.
    seedProject();
    const staleManifest = writeFile(
      "config/routing-manifest.json",
      JSON.stringify({ buildId: "STALE-EMULATE-SCRATCH" }),
    );
    const stalePool = writeFile(
      "config/pool-manifest-default.json",
      JSON.stringify({ buildId: "STALE-EMULATE-SCRATCH" }),
    );
    const mwFile = writeFile(".next/server/middleware.js", "// mw");
    await build({
      middleware: {
        id: "middleware",
        filePath: mwFile,
        pathname: "/_middleware",
        type: 8,
        runtime: "nodejs",
        assets: {
          "config/routing-manifest.json": staleManifest,
          "config/pool-manifest-default.json": stalePool,
        },
        config: { matchers: [] },
      },
    });

    const routingCtx = (rel: string) =>
      path.join(projectDir, ".k8s-adapter/output/routing-service/context", rel);
    const staged = readFileSync(routingCtx("config/routing-manifest.json"), "utf8");
    expect(staged).not.toContain("STALE-EMULATE-SCRATCH");
    // The pool context's config/ is reserved for the same reason.
    const poolStaged = readFileSync(poolContext("config/pool-manifest-ssr.json"), "utf8");
    expect(poolStaged).not.toContain("STALE-EMULATE-SCRATCH");
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

  it("stages public/, @next/routing and a commonjs-pinned package.json; excludes build caches except fetch-cache", async () => {
    seedProject();
    await build({}, sharedConfig);

    expect(readFileSync(sharedContext("public/logo.png"), "utf-8")).toBe("png-bytes");
    expect(existsSync(sharedContext("node_modules/@next/routing/package.json"))).toBe(true);
    // The app's package.json is `type: module`; the image must load CJS build output.
    const pkg = JSON.parse(readFileSync(sharedContext("package.json"), "utf-8"));
    expect(pkg.type).toBe("commonjs");
    expect(pkg.name).toBe("app"); // the rest of the app's manifest is preserved
    // Build output present; the fetch-cache seed staged (next start warm-start parity —
    // see the traced-assets fetch-cache test), build caches absent from the dist copy.
    expect(existsSync(sharedContext(".next/server/app/page.js"))).toBe(true);
    expect(readFileSync(sharedContext(".k8s-adapter/fetch-cache-seed/entry"), "utf-8")).toBe(
      "build cache",
    );
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
