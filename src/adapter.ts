// src/adapter.ts
import { writeFile, mkdir, copyFile, cp, rm, realpath, readdir, lstat } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { NextAdapter, K8sAdapterConfig, BuildCompleteContext } from "./types.js";

// Get current directory in a way that works in ESM and CJS bundle
const _dirname =
  typeof import.meta !== "undefined" && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : typeof __dirname !== "undefined"
      ? __dirname
      : process.cwd();

// Resolve a dependency's directory, preferring the ADAPTER package (where the dep is
// declared, e.g. @next/routing) over the app root. Strict package managers (pnpm) do not
// expose the adapter's transitive deps from the app root, so app-first resolution turns a
// valid install into "cannot find module". App-root is kept as a fallback for hoisted
// layouts (npm) and for a symlinked adapter checkout.
function resolveDepDir(dep: string, projectDir: string): string | undefined {
  const fromFiles = [
    path.join(_dirname, "index.js"), // adapter package (dist/)
    path.join(projectDir, "package.json"), // app root
  ];
  for (const fromFile of fromFiles) {
    try {
      return path.dirname(createRequire(fromFile).resolve(`${dep}/package.json`));
    } catch {
      // try the next resolution root
    }
  }
  return undefined;
}

// Whether the app defines LEGACY EDGE middleware (`middleware.ts`). A node-based incremental
// `cacheHandler` (the adapter's bundled zero-dep RESP2 client over node:net/node:tls) gets
// bundled by Turbopack INTO the edge middleware runtime, where it can't evaluate — so the
// adapter skips registering that handler when edge middleware is present.
// The modern `proxy.ts` runs on Node (no edge bundle) and is NOT matched here, so it gets the full
// handler. (The V2 `use cache` handler, registered via the global symbol, is unaffected either way
// and always shares `use cache` entries cross-replica.)
// Exported (with the staging helpers below) for hermetic unit tests — see
// tests/adapter-staging.test.ts. No behavior change.
export function hasEdgeMiddleware(projectDir: string): boolean {
  const names = [
    "middleware.ts",
    "middleware.js",
    "middleware.tsx",
    "middleware.jsx",
    "middleware.mjs",
  ];
  for (const dir of [projectDir, path.join(projectDir, "src")]) {
    for (const name of names) {
      if (existsSync(path.join(dir, name))) return true;
    }
  }
  return false;
}

import { validateConfig, applyDefaults } from "./config.js";
import { classifyIntoPools } from "./classify.js";
import { buildRoutingManifest } from "./manifest.js";
import { generateHelmChart, SECRET_CHART_FILES } from "./emit/helm.js";
import {
  assertSafeBuildId,
  assertSafeImageRegistry,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  findBuildIdNameCollision,
  K8S_NAMESPACE,
} from "./emit/templates/utils.js";
import {
  generateDockerfile,
  generatePoolDockerfile,
  generateRoutingServiceDockerfile,
} from "./emit/dockerfiles.js";
import { generateBuildMetadata } from "./emit/metadata.js";
import { generateDockerignore } from "./emit/dockerignore.js";
import { buildStaticManifest } from "./emit/static-assets.js";
import { collectPublicPathnames } from "./pool-server/public-files.js";
import { generateCelExpression } from "./cel.js";
import { generateExtensionChain, determineFailureMode } from "./extension-chain.js";

// Output directory matches §18.3 in the design doc
const OUTPUT_DIR = ".k8s-adapter/output";

async function writeOutputFile(
  projectDir: string,
  relativePath: string,
  content: string,
  baseDir: string = OUTPUT_DIR,
  mode?: number,
): Promise<void> {
  const fullPath = path.join(projectDir, baseDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
}

// Resolve and copy .next/node_modules/ — Turbopack creates symlinks to
// real node_modules packages. Docker COPY doesn't follow symlinks outside
// the build context, so we resolve each symlink and copy the real content.
export async function resolveAndCopyExternals(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  // Always rebuild — previous builds may have left stale symlinks
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src);

  for (const entry of entries) {
    const srcEntry = path.join(src, entry);
    const destEntry = path.join(dest, entry);
    const stat = await lstat(srcEntry);

    if (stat.isSymbolicLink()) {
      // Resolve the symlink to its real target and copy the content
      const realTarget = await realpath(srcEntry);
      if (existsSync(realTarget)) {
        const targetStat = statSync(realTarget);
        if (targetStat.isDirectory()) {
          await cp(realTarget, destEntry, { recursive: true, dereference: true });
        } else {
          await copyFile(realTarget, destEntry);
        }
      }
    } else if (stat.isDirectory()) {
      // Recurse into scoped package directories (e.g., @opentelemetry/)
      await resolveAndCopyExternals(srcEntry, destEntry);
    } else {
      await copyFile(srcEntry, destEntry);
    }
  }
}

// Traced-asset keys are relative to ctx.repoRoot (the tracing root), which differs from
// ctx.projectDir in a monorepo/workspace. Entrypoints are staged relative to projectDir,
// so an asset that lives *under* projectDir must be re-based to a projectDir-relative
// destination — otherwise Node's upward node_modules walk from the (projectDir-relative)
// entrypoint can't reach it. Assets outside projectDir (hoisted to repoRoot/node_modules,
// which is already the common layout) keep their repoRoot-relative key, which lands them
// where the upward walk expects. Sibling-workspace-package assets remain a known gap
// (warned about at build time). When repoRoot === projectDir this is a no-op.
export function assetDestPath(
  projectDir: string,
  repoRootRelativeKey: string,
  absAsset: string,
): string {
  const abs = path.isAbsolute(absAsset) ? absAsset : path.resolve(projectDir, absAsset);
  if (abs === projectDir || abs.startsWith(projectDir + path.sep)) {
    return path.relative(projectDir, abs);
  }
  return repoRootRelativeKey;
}

// Track staged paths per build to avoid redundant work and loops
export const stagedPaths = new Set<string>();

export async function stageFile(
  projectDir: string,
  sourcePath: string,
  destRelativePath: string,
  poolName: string,
  isShared: boolean = false,
): Promise<void> {
  const absSource = path.isAbsolute(sourcePath) ? sourcePath : path.resolve(projectDir, sourcePath);

  const stageDir = isShared
    ? path.join(projectDir, OUTPUT_DIR, "shared-context")
    : path.join(projectDir, OUTPUT_DIR, "pools", poolName, "context");

  const absDest = path.join(stageDir, destRelativePath);

  if (stagedPaths.has(absDest)) return;
  if (!existsSync(absSource)) return;

  const realSource = await realpath(absSource).catch(() => absSource);
  // If destination already exists, check if it's the same as source
  if (existsSync(absDest)) {
    const realDest = await realpath(absDest).catch(() => absDest);
    if (realSource === realDest) return;
  }

  // Final guard: ensure dest is not inside source (prevents ERR_FS_CP_EINVAL)
  if (absDest.startsWith(realSource + path.sep) || absDest === realSource) {
    return;
  }

  stagedPaths.add(absDest);

  try {
    await mkdir(path.dirname(absDest), { recursive: true });

    const sourceStat = statSync(absSource);
    if (sourceStat.isDirectory()) {
      // dereference: true is required to pull in symlinked node_modules content
      await cp(absSource, absDest, { recursive: true, dereference: true });
    } else {
      await copyFile(absSource, absDest);
    }
  } catch (err) {
    console.warn(
      `[adapter-k8s] Failed to stage ${sourcePath} -> ${destRelativePath}:`,
      (err as Error).message,
    );
  }
}

// Sharp's native runtime packages for the emitted pool container platform: the pool
// base image is node:*-slim (linux glibc) and GKE's default node pools are amd64, so
// the container needs the linux-x64 pair. esbuild inlines sharp's JS into
// pool-server.cjs, but the binding stays a RUNTIME require
// (`@img/sharp-linux-x64/sharp.node`, which in turn dlopens libvips from
// `@img/sharp-libvips-linux-x64`). Build XchOtaGFu6GdFrcdujVc0 shipped without either
// — every containerized /_next/image failed the sharp load (503 "sharp is
// unavailable") while local runs resolved the binding by walking up to the repo's own
// node_modules, which masked the gap.
export const SHARP_RUNTIME_PACKAGES = [
  "@img/sharp-linux-x64",
  "@img/sharp-libvips-linux-x64",
] as const;

// Resolver for sharp and its platform packages. resolveDepDir asks for
// `${dep}/package.json`, which the @img/* packages BLOCK via their exports maps
// (they export "./package", not "./package.json") — ERR_PACKAGE_PATH_NOT_EXPORTED
// would silently skip staging on every build. Resolve the exported "./package"
// subpath instead (sharp itself exports both), adapter-first like resolveDepDir.
// Falls back to the sibling layout next to the resolved sharp package: npm hoists
// @img/* beside sharp, and pnpm links a package's deps as virtual-store siblings.
export function resolveSharpDepDir(dep: string, projectDir: string): string | undefined {
  const fromFiles = [
    path.join(_dirname, "index.js"), // adapter package (dist/)
    path.join(projectDir, "package.json"), // app root
  ];
  for (const fromFile of fromFiles) {
    try {
      return path.dirname(createRequire(fromFile).resolve(`${dep}/package`));
    } catch {
      // try the next resolution root
    }
  }
  if (dep !== "sharp") {
    // Check the sibling of EVERY resolvable sharp copy — the adapter-first copy may
    // simply not have this platform package installed while the app root's does.
    for (const fromFile of fromFiles) {
      try {
        const sharpDir = path.dirname(createRequire(fromFile).resolve("sharp/package"));
        const sibling = path.join(sharpDir, "..", ...dep.split("/"));
        if (existsSync(path.join(sibling, "package.json"))) return sibling;
      } catch {
        // try the next resolution root
      }
    }
  }
  return undefined;
}

// Stage sharp's linux-x64 native packages into the pool's traced-assets context.
// npm installs platform-specific optional packages for the BUILD host only, so a
// darwin/arm64 host won't have the linux-x64 pair at all — in that case fall back to
// reporting the app's resolved sharp version so the caller can emit an npm-install
// step into the pool Dockerfile (running inside the image resolves the correct
// platform packages natively). `staged: false` with no version means sharp is not
// resolvable at all; image optimization will be unavailable in the container.
export async function stageSharpRuntimePackages(
  projectDir: string,
  poolName: string,
  resolveDep: (dep: string, projectDir: string) => string | undefined = resolveSharpDepDir,
): Promise<{ staged: boolean; sharpVersion?: string }> {
  const resolved = SHARP_RUNTIME_PACKAGES.map((pkg) => ({ pkg, dir: resolveDep(pkg, projectDir) }));
  if (resolved.every(({ dir }) => dir !== undefined && existsSync(dir))) {
    for (const { pkg, dir } of resolved) {
      await stageFile(projectDir, dir!, `node_modules/${pkg}`, poolName);
    }
    return { staged: true };
  }
  const sharpDir = resolveDep("sharp", projectDir);
  const sharpPkgJson = sharpDir ? path.join(sharpDir, "package.json") : undefined;
  if (sharpPkgJson && existsSync(sharpPkgJson)) {
    try {
      const version = (JSON.parse(readFileSync(sharpPkgJson, "utf-8")) as { version?: unknown })
        .version;
      if (typeof version === "string" && version.length > 0) {
        return { staged: false, sharpVersion: version };
      }
    } catch {
      // Unreadable/corrupt sharp package.json — fall through to the warning below.
    }
  }
  console.warn(
    `[adapter-k8s] Could not resolve sharp's linux-x64 runtime packages ` +
      `(${SHARP_RUNTIME_PACKAGES.join(", ")}) or a local sharp install — ` +
      `/_next/image optimization will be UNAVAILABLE (503) in the "${poolName}" pool container.`,
  );
  return { staged: false };
}

// releaseName comes from infrastructure.json (written by init, so it matches the gcloud
// resource names — IP, gateway, etc.) with a project-dir-basename fallback. The fallback
// is capped at 40 chars to mirror assertSafeReleaseName's limit — an over-long directory
// basename otherwise flows into template rendering and fails there with a far less
// actionable error. An all-symbols basename sanitizes to "" — fall back to "nextjs"
// (the `??` on infra.releaseName used to be dead: .replace() never yields null/undefined).
function deriveReleaseName(projectDir: string): string {
  const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
  const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : {};
  return (
    infra.releaseName ??
    (path
      .basename(projectDir)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "-")
      // Cap BEFORE stripping edge hyphens — the slice can land on one.
      .slice(0, 40)
      .replace(/^-+|-+$/g, "") ||
      "nextjs")
  );
}

export function createK8sAdapter(userConfig?: K8sAdapterConfig): NextAdapter {
  let config: K8sAdapterConfig | undefined = userConfig;
  let configNormalized = false;

  async function ensureConfig(projectDir: string) {
    if (!config) {
      // Try to load from project root
      const configPaths = [
        path.join(projectDir, "adapter.config.mjs"),
        path.join(projectDir, "adapter.config.ts"),
        path.join(projectDir, "adapter.config.js"),
      ];

      for (const p of configPaths) {
        if (existsSync(p)) {
          try {
            const mod = await import(pathToFileURL(p).href);
            const exported = mod.default;
            if (exported && typeof exported === "object") {
              config = exported.config || exported;
              break;
            }
            console.warn(
              `[adapter-k8s] ${p} loaded but has no usable default export (expected an object ` +
                `or a createK8sAdapter() instance); ignoring it.`,
            );
          } catch (err) {
            console.error(`Failed to load config from ${p}:`, err);
          }
        }
      }

      if (!config) {
        console.log("[adapter-k8s] No adapter config found, using defaults");
        config = {
          pools: {
            default: { routes: ["appPages", "appRoutes", "pagesApi", "pages"] },
          },
          provider: {
            gke: {
              gateway: {
                type: "gateway-api",
                className: "gke-l7-global-external-managed",
                hosts: [{ hostname: "localhost", tls: { enabled: false } }],
              },
            },
          },
        };
      }
    }

    if (!configNormalized) {
      // Pass the release name (when derivable) so validateConfig can enforce the
      // COMBINED release+pool length budget — the per-field 40-char caps alone
      // permit composed resource names whose build id truncates away entirely.
      let releaseNameForBudget: string | undefined;
      try {
        releaseNameForBudget = deriveReleaseName(projectDir);
      } catch {
        // Corrupt infrastructure.json — skip the combined check here; onBuildComplete
        // reads the same file and surfaces the parse error with context.
      }
      validateConfig(config, releaseNameForBudget);
      config = applyDefaults(config);
      configNormalized = true;
    }
    return config;
  }

  const adapter: NextAdapter = {
    name: "k8s",

    async modifyConfig(nextConfig, ctx) {
      // The stable adapter API ctx has { phase, nextVersion } — no projectDir.
      // Use process.cwd() which is the project root during build.
      const cfg = await ensureConfig(process.cwd());

      const modified: Record<string, unknown> = {
        ...nextConfig,
        compress: false,
        // Set turbopack root to the project directory to avoid workspace detection issues
        // when the adapter is loaded from outside the project tree (e.g., e2e tests)
        turbopack: {
          ...(nextConfig as any).turbopack,
          root: (nextConfig as any).turbopack?.root ?? process.cwd(),
        },
        // Generate K8s-friendly build IDs: lowercase alphanumeric + hyphens only.
        // Next.js default buildId can contain uppercase, underscores, and other chars
        // that cause issues in K8s resource names, labels, and image tags.
        generateBuildId:
          nextConfig.generateBuildId ??
          (() => {
            const timestamp = Date.now().toString(36);
            const random = Math.random().toString(36).slice(2, 8);
            return `b${timestamp}${random}`;
          }),
      };

      // Opt into immutable static assets (Turbopack-only). Next then content-addresses immutable
      // assets and drops the `?dpl` skew token from their URLs (mutable assets like service workers
      // keep it), and the adapter serves them per Next's own header policy (see static-asset-headers).
      // Respect an explicit user opt-out.
      {
        const userImmutable = (
          nextConfig.experimental as { supportsImmutableAssets?: boolean } | undefined
        )?.supportsImmutableAssets;
        // ADAPTER_K8S_DISABLE_IMMUTABLE_ASSETS=1 forces it off — used to A/B whether the immutable
        // asset split regresses client bootstrap (asset URLs move under /_next/static/immutable/).
        const disabled = process.env.ADAPTER_K8S_DISABLE_IMMUTABLE_ASSETS === "1";
        modified.experimental = {
          ...((modified.experimental as Record<string, unknown>) ?? {}),
          supportsImmutableAssets: disabled ? false : (userImmutable ?? true),
        };
      }

      // Local build profile: cap workers and memory for constrained environments
      // (e2e tests, local emulation). Set ADAPTER_K8S_BUILD_CPUS to activate.
      const buildCpus = parseInt(process.env.ADAPTER_K8S_BUILD_CPUS ?? "", 10);
      if (buildCpus > 0) {
        modified.experimental = {
          ...((modified.experimental as Record<string, unknown>) ?? {}),
          cpus: buildCpus,
          memoryBasedWorkersCount: false,
          parallelServerCompiles: false,
          parallelServerBuildTraces: false,
          webpackBuildWorker: false,
        };
      }

      // Register the Valkey-backed incremental cache handler when the cache is enabled. The
      // bundled module (shipped in the adapter's dist) is copied to a build-surviving path and set
      // as `next.config.cacheHandler`. It falls back to Next's file-system cache when VALKEY_URL is
      // absent — so it is inert during `next build` and local runs, and only backs the incremental
      // cache (PPR shells + ISR pages) with Valkey at runtime in the pool, where VALKEY_URL +
      // NEXT_BUILD_ID are injected. Sharing this store is what makes those revalidate cross-replica.
      if (cfg.cache?.enabled && !hasEdgeMiddleware(process.cwd())) {
        // Respect an application-provided cacheHandler rather than silently overwriting it — the two
        // are mutually exclusive (a custom handler owns the incremental cache, so the adapter's
        // shared store can't also own it). Warn and keep theirs; the V2 `use cache` handler still
        // registers at runtime, but cross-replica ISR/PPR-shell sharing needs the adapter's handler.
        const existingHandler =
          (modified as { cacheHandler?: unknown }).cacheHandler ??
          (nextConfig as { cacheHandler?: unknown }).cacheHandler;
        if (existingHandler) {
          console.warn(
            "[adapter-k8s] cache.enabled but next.config already sets `cacheHandler` — keeping " +
              "yours and skipping the adapter's shared incremental cache. Remove your cacheHandler " +
              "for cross-replica ISR / PPR-shell revalidation, or set cache.enabled=false to silence.",
          );
        } else {
          const src = path.join(_dirname, "cache-handler.cjs");
          if (existsSync(src)) {
            const destDir = path.join(process.cwd(), ".k8s-adapter");
            await mkdir(destDir, { recursive: true });
            const dest = path.join(destDir, "cache-handler.cjs");
            await copyFile(src, dest);
            modified.cacheHandler = dest;
            // The handler's bundled Redis client uses only `node:net`/`node:tls` (loaded lazily),
            // which Next externalizes automatically — so there's no third-party package to mark
            // external or stage into the pool container.
          }
        }
      }

      return modified as typeof nextConfig;
    },

    async onBuildComplete(ctx: BuildCompleteContext) {
      const { routing, outputs, projectDir, config: nextConfig, buildId, nextVersion } = ctx;
      const repoRoot = (ctx as { repoRoot?: string }).repoRoot ?? projectDir;

      // The finalized build id (Next's default or a custom `generateBuildId()` — commonly
      // a git ref in CI) flows into helm `--set` values, K8s resource names/labels, image
      // tags, and chart YAML. Validate it here, at the source, so an unsafe id fails the
      // build with a clear message instead of injecting into any of those sinks.
      assertSafeBuildId(buildId);

      // Config and release name are needed by the collision guard below (and the
      // rest of the build); resolve them before any artifact is touched.
      const cfg = await ensureConfig(projectDir);
      const releaseName = deriveReleaseName(projectDir);

      // Blue/green requires the new and current builds to have DISTINCT sanitized K8s
      // names: resource names, pod labels, and the active-Service selector all derive
      // from `${releaseName}-${poolName}-${buildId}` truncated to 63 chars (59 for the
      // -hpa/-hcp variants). Compare the COMPOSED truncated names — comparing
      // sanitizeK8sName(buildId) alone misses the case where a long release+pool
      // prefix truncates the build id away entirely, making EVERY consecutive deploy
      // collide. The deploy CLI performs the same composed-name check against cluster
      // state; catching it at build time fails before any artifact is emitted.
      // Best-effort read: no state file (first deploy) means no comparison. Only the
      // read/parse sits inside the try — the comparison and its throw are OUTSIDE, so
      // the catch can never swallow the guard's own error (the old shape re-threw by
      // matching a message prefix; a reworded message would have no-op'd the guard).
      let previousBuildId: string | null = null;
      try {
        const statePath = path.join(projectDir, ".k8s-adapter", "state.json");
        if (existsSync(statePath)) {
          const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
            buildId?: unknown;
          };
          if (typeof state.buildId === "string") previousBuildId = state.buildId;
        }
      } catch {
        // Unreadable/corrupt state.json: ignore — the deploy-side check is authoritative.
      }
      if (previousBuildId !== null) {
        const collision = findBuildIdNameCollision(
          releaseName,
          Object.keys(cfg.pools),
          buildId,
          previousBuildId,
        );
        if (collision !== null) {
          throw new Error(
            `[adapter-k8s] build id sanitizes to the same K8s name as the previous build: ` +
              `"${buildId}" and "${previousBuildId}" both produce the ${collision.kind} name ` +
              `"${collision.name}" after sanitization and 63-char truncation (release ` +
              `"${releaseName}") — blue/green resource names, pod labels, and the ` +
              `active-Service selector would collide. Choose a distinct generateBuildId, ` +
              `or shorten the release/pool names so more of the build id survives.`,
          );
        }
      }

      // Regenerate the Helm chart from a clean slate. Chart files are named per
      // pool/build; without wiping, a removed pool's Deployment/Service or a
      // stale template from a prior build survives and gets re-applied by the
      // next `helm upgrade`. Only the generated chart dir is cleared — staged
      // build contexts and injected previous-build templates live elsewhere and
      // are managed by their own steps.
      const chartDir = path.join(projectDir, OUTPUT_DIR, "chart");
      if (existsSync(chartDir)) await rm(chartDir, { recursive: true, force: true });

      // In a monorepo the tracing root (repoRoot) sits above the app dir (projectDir).
      // Traced assets under projectDir are re-based correctly (see assetDestPath), and
      // deps hoisted to repoRoot/node_modules resolve via the upward node_modules walk.
      // Assets that live in a *sibling* workspace package (outside projectDir, e.g.
      // repoRoot/packages/*) are staged at their repoRoot-relative path and may not be
      // reachable by Node's resolution from the app entrypoint — warn so it's not silent.
      if (repoRoot !== projectDir) {
        console.warn(
          `[adapter-k8s] Monorepo detected (repoRoot ${repoRoot} != projectDir ${projectDir}). ` +
            `Traced dependencies in sibling workspace packages may not resolve at runtime; ` +
            `ensure such deps are hoisted or bundled into the app's node_modules.`,
        );
      }

      // Dump raw build context for debugging
      const debugDir = path.join(projectDir, OUTPUT_DIR, "debug");
      await mkdir(debugDir, { recursive: true });
      await writeFile(
        path.join(debugDir, "build-context.json"),
        JSON.stringify(
          {
            buildId,
            nextVersion,
            basePath: nextConfig.basePath,
            i18n: nextConfig.i18n,
            routing,
            outputKeys: Object.keys(outputs),
            outputs: Object.fromEntries(
              Object.entries(outputs).map(([k, v]) => {
                if (Array.isArray(v)) {
                  return [
                    k,
                    v.map((item: any) => ({
                      ...item,
                      // Truncate large fields
                      assets: item.assets
                        ? `[${Object.keys(item.assets).length} assets]`
                        : undefined,
                    })),
                  ];
                }
                if (v && typeof v === "object" && "filePath" in v) {
                  return [
                    k,
                    {
                      ...v,
                      assets: v.assets ? `[${Object.keys(v.assets).length} assets]` : undefined,
                    },
                  ];
                }
                return [k, v];
              }),
            ),
          },
          null,
          2,
        ),
      );

      stagedPaths.clear();

      // 1. Classify outputs into pools
      const pools = classifyIntoPools(outputs, cfg);

      // 2. Build routing manifest
      const routingManifest = buildRoutingManifest({
        routing,
        outputs,
        pools,
        buildId,
        basePath: nextConfig.basePath ?? "",
        i18n: nextConfig.i18n ?? null,
        trailingSlash: nextConfig.trailingSlash ?? false,
        nextVersion,
        projectDir,
      });

      // 3. Build static asset manifest
      const staticManifest = buildStaticManifest(outputs, projectDir, nextConfig.basePath ?? "");

      // 4. Generate Helm chart
      // releaseName was derived up top (deriveReleaseName — infrastructure.json with a
      // capped basename fallback); infrastructure.json also carries namespace/registry/
      // project values consumed below.
      const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
      const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : {};

      // Phase 2 artifacts (Route Extension) — computed before Helm chart so extensionChain is available
      const celExpression = generateCelExpression({
        outputs,
        dynamicRoutes: routing.dynamicRoutes,
        // request.path at the LB includes the basePath — the CEL must too.
        basePath: nextConfig.basePath ?? "",
      });

      const failureModeAllow = determineFailureMode(outputs, cfg.routingService?.failureMode);

      const gkeProvider = cfg.provider.gke;

      // infrastructure.json is operator/CI-managed state, but a tampered or hand-edited
      // value here flows into helm --set, resource names, and chart YAML — validate at
      // the point of consumption and fail the build rather than emit an unsafe chart.
      const namespace = infra.namespace ?? K8S_NAMESPACE;
      try {
        assertSafeNamespace(namespace);
      } catch (err) {
        throw new Error(
          `[adapter-k8s] Unsafe namespace in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
        );
      }
      // The namespace feeds ONLY the ext_proc extension-chain authority
      // (`<release>-routing-service.<namespace>.svc.cluster.local`, extension-chain.ts)
      // — every kubectl/helm call in the CLI pins the literal K8S_NAMESPACE, and init
      // binds Workload Identity to default/<release>-deploy-sa. A non-default value
      // here would land workloads in "default" while the GXLB callout targets the
      // other namespace: every edge callout fails, and diagnostics chase the "wrong"
      // resources. Fail fast at build time instead of emitting a skewed chain.
      if (namespace !== K8S_NAMESPACE) {
        throw new Error(
          `[adapter-k8s] Unsupported namespace "${namespace}" in ` +
            `.k8s-adapter/infrastructure.json: this adapter version deploys only to the ` +
            `"${K8S_NAMESPACE}" namespace (init binds Workload Identity to ` +
            `${K8S_NAMESPACE}/<release>-deploy-sa and every kubectl/helm call pins it). ` +
            `Remove "namespace" from infrastructure.json.`,
        );
      }

      const configuredRegistry = infra.containerRegistry ?? process.env.IMAGE_REGISTRY;
      if (configuredRegistry !== undefined) {
        try {
          assertSafeImageRegistry(configuredRegistry);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe image registry from ` +
              `${infra.containerRegistry ? "infrastructure.json containerRegistry" : "the IMAGE_REGISTRY env var"}: ` +
              `${(err as Error).message}`,
          );
        }
      }
      const imageRegistry = configuredRegistry ?? "REGISTRY";

      // projectId/region flow into the extension-chain JSON, which the route-ext
      // ConfigMap template re-interpolates into quoted YAML scalars (service,
      // authority) — validate at the source so a tampered infrastructure.json
      // fails the build instead of injecting into the chart downstream.
      if (infra.projectId !== undefined) {
        try {
          assertSafeProjectId(infra.projectId);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe projectId in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
          );
        }
      }
      if (infra.region !== undefined) {
        try {
          assertSafeRegion(infra.region);
        } catch (err) {
          throw new Error(
            `[adapter-k8s] Unsafe region in .k8s-adapter/infrastructure.json: ${(err as Error).message}`,
          );
        }
      }

      const extensionChain = generateExtensionChain({
        celExpression,
        releaseName,
        namespace,
        projectId: infra.projectId ?? "",
        timeout: gkeProvider.serviceExtensions?.routeExtension?.timeout
          ? `${gkeProvider.serviceExtensions.routeExtension.timeout}s`
          : "5s",
        failureModeAllow,
      });

      const helmFiles = generateHelmChart({
        pools,
        buildId,
        nextVersion,
        config: cfg,
        imageRegistry,
        routingManifest,
        releaseName,
        extensionChainJson: extensionChain,
        routingFailOpen: failureModeAllow,
        infrastructure: { projectId: infra.projectId, region: infra.region },
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        // Secret-bearing templates land on disk mode 0600 — they hold the internal
        // dispatch secret / Valkey AUTH and must not be group/world-readable.
        await writeOutputFile(
          projectDir,
          `chart/${filePath}`,
          content,
          OUTPUT_DIR,
          SECRET_CHART_FILES.has(filePath) ? 0o600 : undefined,
        );
      }

      // 5. Build Stage Area & Dockerfiles
      // Skip staging when running in e2e/emulate mode — the pool server reads
      // directly from .next/ and staging doubles inode usage needlessly.
      const skipStaging = process.env.ADAPTER_K8S_SKIP_STAGING === "1";

      const poolServerSrc = path.join(_dirname, "pool-server.cjs");
      const poolServerContent = existsSync(poolServerSrc)
        ? readFileSync(poolServerSrc, "utf-8")
        : "";

      // NOTE: `.env` / `.env.production` are deliberately NOT staged into any
      // Docker build context. They can hold secrets (DB URLs, non-NEXT_PUBLIC
      // API keys) and would otherwise be baked into pushed image layers. Env is
      // supplied to running containers via Kubernetes (ConfigMap/Secret +
      // envFrom); the runtime reads it from process.env. Each build context
      // also gets a `.dockerignore` (below) so a stray `COPY . .` can't pick
      // one up. Local emulate is unaffected: it runs the servers with
      // cwd=projectDir, so loadEnvConfig reads the real project `.env` directly.

      if (skipStaging) {
        // Only write pool manifests — skip Docker context staging (saves thousands of inodes)
        for (const [poolName, pool] of pools) {
          const poolManifest = {
            buildId,
            poolName,
            outputs: Object.fromEntries(
              pool.outputs.map((o: any) => [
                o.pathname,
                {
                  id: o.id ?? o.pathname,
                  filePath: path.relative(projectDir, o.filePath),
                  pathname: o.pathname,
                  type: o.type,
                  runtime: o.runtime ?? "nodejs",
                },
              ]),
            ),
          };
          await writeOutputFile(
            projectDir,
            `pool-manifest-${poolName}.json`,
            JSON.stringify(poolManifest, null, 2),
          );
        }
      } else if (cfg.containerStrategy === "shared-image") {
        const sharedStageDir = "shared-context";
        const absSharedStageDir = path.join(OUTPUT_DIR, sharedStageDir);

        // Stage everything for shared image
        await cp(
          path.join(projectDir, ".next"),
          path.join(projectDir, absSharedStageDir, ".next"),
          { recursive: true, dereference: true },
        );
        await cp(
          path.join(projectDir, "node_modules"),
          path.join(projectDir, absSharedStageDir, "node_modules"),
          { recursive: true, dereference: true },
        );
        await copyFile(
          path.join(projectDir, "package.json"),
          path.join(projectDir, absSharedStageDir, "package.json"),
        );

        // Stage the registered incremental cache handler. Next resolves `next.config.cacheHandler`
        // at runtime relative to the app root (`../.k8s-adapter/cache-handler.cjs`), so the shared
        // image must contain it too — otherwise the pool crashes with module-not-found on startup.
        if (cfg.cache?.enabled && !hasEdgeMiddleware(projectDir)) {
          const handlerSrc = path.join(projectDir, ".k8s-adapter", "cache-handler.cjs");
          if (existsSync(handlerSrc)) {
            await mkdir(path.join(projectDir, absSharedStageDir, ".k8s-adapter"), {
              recursive: true,
            });
            await copyFile(
              handlerSrc,
              path.join(projectDir, absSharedStageDir, ".k8s-adapter", "cache-handler.cjs"),
            );
          }
        }

        // Keep .env secrets out of the shared image (built from this context).
        await writeOutputFile(
          projectDir,
          ".dockerignore",
          generateDockerignore(),
          absSharedStageDir,
        );

        if (poolServerContent) {
          await writeOutputFile(
            projectDir,
            "pool-server.cjs",
            poolServerContent,
            absSharedStageDir,
          );
        }

        await writeOutputFile(
          projectDir,
          "config/routing-manifest.json",
          JSON.stringify(routingManifest, null, 2),
          absSharedStageDir,
        );
        await writeOutputFile(
          projectDir,
          "config/static-assets.json",
          JSON.stringify(staticManifest, null, 2),
          absSharedStageDir,
        );

        for (const [poolName, pool] of pools) {
          const poolManifest = {
            buildId,
            poolName,
            outputs: Object.fromEntries(
              pool.outputs
                .filter((o) => !!o.filePath)
                .map((o) => [
                  o.pathname,
                  {
                    id: o.id,
                    filePath: path.relative(projectDir, o.filePath),
                    pathname: o.pathname,
                    type: o.type,
                    runtime:
                      "runtime" in o && typeof o.runtime === "string" ? o.runtime : undefined,
                  },
                ]),
            ),
          };
          await writeOutputFile(
            projectDir,
            `config/pool-manifest-${poolName}.json`,
            JSON.stringify(poolManifest, null, 2),
            absSharedStageDir,
          );
        }

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          // Base image version comes from DEFAULT_EMITTED_NODE_VERSION (dockerfiles.ts)
          // — Node >= 24 is required for the manifest's inline (?i:) regexes (N24).
          generateDockerfile({
            containerStrategy: "shared-image",
            buildId,
          }),
          absSharedStageDir,
        );
      } else {
        for (const [poolName, pool] of pools) {
          const poolDir = path.join(OUTPUT_DIR, "pools", poolName);
          const poolStageDir = path.join(poolDir, "context");

          // Stage the Valkey incremental cache handler at the same project-relative path the build
          // config points at, so the runtime `cacheHandler` (resolved relative to distDir/.next)
          // finds it inside the pool container.
          if (cfg.cache?.enabled && !hasEdgeMiddleware(projectDir)) {
            await stageFile(
              projectDir,
              path.join(projectDir, ".k8s-adapter", "cache-handler.cjs"),
              ".k8s-adapter/cache-handler.cjs",
              poolName,
            );
          }

          // Copy required files into context
          for (const output of pool.outputs) {
            if (!output.filePath) continue;
            const relPath = path.relative(projectDir, output.filePath);
            await stageFile(projectDir, output.filePath, relPath, poolName);

            const assets = output.assets || (output as any).outputs || {};
            for (const [relAsset, absAsset] of Object.entries(assets)) {
              if (typeof absAsset === "string") {
                await stageFile(
                  projectDir,
                  absAsset,
                  assetDestPath(projectDir, relAsset, absAsset),
                  poolName,
                );
              }
            }
          }

          // Stage static/public/prerender files into EVERY pool image, not just
          // the default one. static-assets.json is written to every pool's config
          // (so every dispatcher knows these paths), and the gateway routes a
          // shared URL prefix to whichever pool owns a route under it — which may
          // be a non-default pool. If the files lived only in the default pool,
          // a public asset under such a prefix would 404 on the pool that
          // actually receives it. (Phase 4 CDN/GCS offload will move these off
          // the pods entirely and make this staging unnecessary.)
          for (const asset of staticManifest) {
            const absPath = path.resolve(projectDir, asset.filePath);
            await stageFile(projectDir, absPath, asset.filePath, poolName);
          }

          // Stage public/ files (favicon, robots, arbitrary static assets). They are NOT in
          // Next's staticFiles output — the loop above misses them — so without this the pool's
          // public-file fast-path 404s on every public asset. Enumerate with the same helper the
          // router uses. (Until Phase-4 CDN/GCS offload moves these off the pods entirely.)
          for (const publicPathname of collectPublicPathnames(projectDir)) {
            const rel = `public${publicPathname}`; // publicPathname starts with "/"
            await stageFile(projectDir, path.join(projectDir, rel), rel, poolName);
          }

          if (outputs.middleware?.filePath) {
            const relPath = path.relative(projectDir, outputs.middleware.filePath);
            await stageFile(projectDir, outputs.middleware.filePath, relPath, poolName);
            // Stage middleware's traced assets (chunk dependencies)
            const mwAssets = (outputs.middleware as any).assets ?? {};
            for (const [relAsset, absAsset] of Object.entries(mwAssets)) {
              if (typeof absAsset === "string") {
                await stageFile(
                  projectDir,
                  absAsset,
                  assetDestPath(projectDir, relAsset, absAsset),
                  poolName,
                );
              }
            }
          }

          // Stage .next/server/chunks/ — required by Turbopack runtime for
          // middleware and handler chunk loading
          const chunksDir = path.join(projectDir, ".next", "server", "chunks");
          if (existsSync(chunksDir)) {
            await stageFile(projectDir, chunksDir, ".next/server/chunks", poolName);
          }

          // Stage .next/node_modules/ — Turbopack's resolved external modules
          // (hashed names like @opentelemetry/api-6ec0324a2d0bd38c)
          // These are symlinks pointing outside .next/ — Docker COPY can't follow them.
          // Resolve each symlink and copy the real content.
          const nextNodeModules = path.join(projectDir, ".next", "node_modules");
          if (existsSync(nextNodeModules)) {
            const dest = path.join(
              projectDir,
              OUTPUT_DIR,
              "pools",
              poolName,
              "context",
              ".next",
              "node_modules",
            );
            await resolveAndCopyExternals(nextNodeModules, dest);
          }

          // Stage next/setup-node-env (required for AsyncLocalStorage initialization)
          const nextPkgDir = path.join(projectDir, "node_modules", "next");
          if (existsSync(nextPkgDir)) {
            await stageFile(projectDir, nextPkgDir, "node_modules/next", poolName);
          }

          // Stage @next/routing (required for pool server local route resolution).
          // Resolve adapter-first (it is the adapter's own dependency); a silent skip here
          // ships a pool image that crashes at runtime with "Cannot find module
          // '@next/routing'", so fail the build loudly if it cannot be located.
          const nextRoutingDir = resolveDepDir("@next/routing", projectDir);
          if (!nextRoutingDir || !existsSync(nextRoutingDir)) {
            throw new Error(
              `[adapter-k8s] Could not resolve @next/routing from ${projectDir}. It is required ` +
                `at runtime by the pool server. Ensure @next/routing is installed and resolvable ` +
                `from your app (it is a dependency of @next-community/adapter-k8s).`,
            );
          }
          await stageFile(projectDir, nextRoutingDir, "node_modules/@next/routing", poolName);

          // Stage sharp's native linux-x64 packages (see stageSharpRuntimePackages) —
          // pool-server.cjs inlines sharp's JS but requires the platform binding at
          // runtime, and the traced-assets context otherwise ships no @img/* at all.
          const sharpStaging = await stageSharpRuntimePackages(projectDir, poolName);

          // Keep .env secrets out of the pool image. The Dockerfile's
          // `COPY context/ .` runs from this pool dir (the docker build
          // context), so the .dockerignore lives here alongside the Dockerfile.
          await writeOutputFile(projectDir, ".dockerignore", generateDockerignore(), poolDir);

          // Shared context files
          await writeOutputFile(
            projectDir,
            "package.json",
            JSON.stringify({ type: "commonjs" }),
            poolStageDir,
          );
          if (poolServerContent) {
            await writeOutputFile(projectDir, "pool-server.cjs", poolServerContent, poolStageDir);
          }

          const poolManifest = {
            buildId,
            poolName,
            outputs: Object.fromEntries(
              pool.outputs
                .filter((o) => !!o.filePath)
                .map((o) => [
                  o.pathname,
                  {
                    id: o.id,
                    filePath: path.relative(projectDir, o.filePath),
                    pathname: o.pathname,
                    type: o.type,
                    runtime:
                      "runtime" in o && typeof o.runtime === "string" ? o.runtime : undefined,
                  },
                ]),
            ),
          };

          await writeOutputFile(
            projectDir,
            `config/pool-manifest-${poolName}.json`,
            JSON.stringify(poolManifest, null, 2),
            poolStageDir,
          );
          await writeOutputFile(
            projectDir,
            "config/routing-manifest.json",
            JSON.stringify(routingManifest, null, 2),
            poolStageDir,
          );
          await writeOutputFile(
            projectDir,
            "config/static-assets.json",
            JSON.stringify(staticManifest, null, 2),
            poolStageDir,
          );

          await writeOutputFile(
            projectDir,
            `Dockerfile`,
            generatePoolDockerfile({
              poolName,
              buildId,
              // Build host lacked linux-x64 sharp packages — install in-image instead,
              // pinned to the app's sharp so the native ABI matches the inlined JS.
              ...(!sharpStaging.staged && sharpStaging.sharpVersion
                ? { installSharpVersion: sharpStaging.sharpVersion }
                : {}),
            }),
            poolDir,
          );
        }
      }

      // 6. Write final artifacts to output root for CLI visibility
      await writeOutputFile(
        projectDir,
        "routing-manifest.json",
        JSON.stringify(routingManifest, null, 2),
      );
      await writeOutputFile(
        projectDir,
        "static-assets.json",
        JSON.stringify(staticManifest, null, 2),
      );
      // Deploy/rollback read this to decide whether to invalidate the outgoing build's CDN tag.
      // Emitted here (not infra state, which lacks cdn config); a missing/false flag = no-op.
      await writeOutputFile(
        projectDir,
        "cdn-invalidation.json",
        JSON.stringify({ invalidateOnDeploy: gkeProvider.cdn?.invalidateOnDeploy ?? true }),
      );

      // Phase 2 artifacts — write to output (computation moved above Helm chart generation)
      await writeOutputFile(projectDir, "extension-chains.json", extensionChain);
      await writeOutputFile(projectDir, "cel-expression.txt", celExpression);

      // Routing service Dockerfile + context (skip when staging is disabled)
      if (!skipStaging) {
        const routingServiceDir = path.join(OUTPUT_DIR, "routing-service");

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          generateRoutingServiceDockerfile({ buildId }),
          routingServiceDir,
        );

        const routingServiceContextDir = path.join(routingServiceDir, "context");

        // Copy routing-service runtime (from adapter package dist/). esbuild bundles
        // connectrpc/protobuf-es and the generated ext_proc Envoy types into this CJS
        // bundle, so there's no separate .proto file to stage.
        const routingServiceSrc = path.join(_dirname, "routing-service.cjs");
        if (existsSync(routingServiceSrc)) {
          await writeOutputFile(
            projectDir,
            "routing-service.cjs",
            readFileSync(routingServiceSrc, "utf-8"),
            routingServiceContextDir,
          );
        }

        // Routing manifest for the routing service
        await writeOutputFile(
          projectDir,
          "config/routing-manifest.json",
          JSON.stringify(routingManifest, null, 2),
          routingServiceContextDir,
        );

        // Stage runtime dependencies for routing service (externals not bundled by esbuild)
        // connectrpc/protobuf-es and the generated Envoy protos are bundled into
        // routing-service.mjs; only @next/routing is external.
        const routingServiceDeps = ["@next/routing"];
        for (const dep of routingServiceDeps) {
          // Resolve adapter-first (@next/routing is the adapter's own dependency). A silent
          // skip here ships a routing-service image that crashloops with "Cannot find module
          // '@next/routing'" — exactly how it failed undetected. Fail the build loudly.
          const depDir = resolveDepDir(dep, projectDir);
          if (!depDir || !existsSync(depDir)) {
            throw new Error(
              `[adapter-k8s] Could not resolve ${dep} for the routing service from ${projectDir}. ` +
                `It is required at runtime by the routing service (ext_proc). Ensure it is installed ` +
                `and resolvable from your app.`,
            );
          }
          const dest = path.join(
            projectDir,
            routingServiceContextDir,
            "node_modules",
            ...dep.split("/"),
          );
          // Refresh every build (the context dir persists) so a dependency upgrade actually ships
          // rather than being shadowed by a stale copy from an earlier build.
          await rm(dest, { recursive: true, force: true });
          await mkdir(path.dirname(dest), { recursive: true });
          await cp(depDir, dest, { recursive: true, dereference: true });
        }

        // Keep .env secrets out of the routing-service image. `docker build`
        // uses the routing-service dir as its context, so the .dockerignore lives
        // there alongside the Dockerfile.
        await writeOutputFile(
          projectDir,
          ".dockerignore",
          generateDockerignore(),
          routingServiceDir,
        );

        // Stage middleware module + its chunk dependencies. These MUST be re-copied every build:
        // the routing-service context dir persists across builds, and a prior `if (!existsSync)`
        // guard here froze the ext_proc tier at the first build's middleware (its `middleware.js`
        // pins a specific chunk hash, so a stale copy silently runs old middleware code forever).
        if (outputs.middleware?.filePath && existsSync(outputs.middleware.filePath)) {
          const mwRelPath = path.relative(projectDir, outputs.middleware.filePath);
          const mwDest = path.join(projectDir, routingServiceContextDir, mwRelPath);
          await mkdir(path.dirname(mwDest), { recursive: true });
          await copyFile(outputs.middleware.filePath, mwDest);
          // Stage middleware's traced assets (files and directories)
          const mwAssets = (outputs.middleware as any).assets ?? {};
          for (const [relAsset, absAsset] of Object.entries(mwAssets)) {
            if (typeof absAsset === "string" && existsSync(absAsset)) {
              const dest = path.join(
                projectDir,
                routingServiceContextDir,
                assetDestPath(projectDir, relAsset, absAsset),
              );
              await mkdir(path.dirname(dest), { recursive: true });
              const stat = statSync(absAsset);
              if (stat.isDirectory()) {
                await cp(absAsset, dest, { recursive: true, dereference: true });
              } else {
                await copyFile(absAsset, dest);
              }
            }
          }
          // Stage .next/server/chunks/ for Turbopack runtime chunk loading
          const chunksDir = path.join(projectDir, ".next", "server", "chunks");
          const chunksDest = path.join(
            projectDir,
            routingServiceContextDir,
            ".next",
            "server",
            "chunks",
          );

          // Stage .next/node_modules/ — Turbopack's resolved external modules
          const nextNodeModules = path.join(projectDir, ".next", "node_modules");
          const nextNodeModulesDest = path.join(
            projectDir,
            routingServiceContextDir,
            ".next",
            "node_modules",
          );
          if (existsSync(nextNodeModules)) {
            await resolveAndCopyExternals(nextNodeModules, nextNodeModulesDest);
          }
          if (existsSync(chunksDir)) {
            // Replace the whole chunk set (not merge) so a stale prior build's chunks can't linger
            // and shadow the current middleware's referenced chunk.
            await rm(chunksDest, { recursive: true, force: true });
            await mkdir(path.dirname(chunksDest), { recursive: true });
            await cp(chunksDir, chunksDest, { recursive: true, dereference: true });
          }
        }
      } // end if (!skipStaging)

      await writeOutputFile(
        projectDir,
        "build-metadata.json",
        generateBuildMetadata({
          buildId,
          nextVersion,
          poolNames: [...pools.keys()],
          generatedAt: new Date().toISOString(),
          containerStrategy: cfg.containerStrategy,
          hasMiddleware: !!outputs.middleware,
          failureModeAllow,
          cacheEnabled: cfg.cache?.enabled ?? false,
          cacheManaged: !!cfg.cache?.enabled && !cfg.cache.url,
          ...(cfg.cache?.memorystore ? { cacheMemorystore: cfg.cache.memorystore } : {}),
        }),
      );
    },
  };

  // Expose config for ensureConfig to find when it imports an existing adapter instance
  Object.defineProperty(adapter, "config", {
    get: () => config,
    enumerable: false,
  });

  return adapter;
}
