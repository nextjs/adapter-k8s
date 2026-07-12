// src/adapter.ts
import { writeFile, mkdir, copyFile, cp, realpath } from "node:fs/promises";
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

import { validateConfig, applyDefaults } from "./config.js";
import { classifyIntoPools } from "./classify.js";
import { buildRoutingManifest } from "./manifest.js";
import { generateHelmChart } from "./emit/helm.js";
import {
  generateDockerfile,
  generatePoolDockerfile,
  generateRoutingServiceDockerfile,
} from "./emit/dockerfiles.js";
import { generateBuildMetadata } from "./emit/metadata.js";
import { generateDockerignore } from "./emit/dockerignore.js";
import { buildStaticManifest } from "./emit/static-assets.js";
import { generateCelExpression } from "./cel.js";
import { generateExtensionChain, determineFailureMode } from "./extension-chain.js";

// Output directory matches §18.3 in the design doc
const OUTPUT_DIR = ".k8s-adapter/output";

async function writeOutputFile(
  projectDir: string,
  relativePath: string,
  content: string,
  baseDir: string = OUTPUT_DIR,
): Promise<void> {
  const fullPath = path.join(projectDir, baseDir, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

// Resolve and copy .next/node_modules/ — Turbopack creates symlinks to
// real node_modules packages. Docker COPY doesn't follow symlinks outside
// the build context, so we resolve each symlink and copy the real content.
async function resolveAndCopyExternals(src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  // Always rebuild — previous builds may have left stale symlinks
  const { rm } = await import("node:fs/promises");
  if (existsSync(dest)) await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const { readdir, lstat, readlink } = await import("node:fs/promises");
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
function assetDestPath(projectDir: string, repoRootRelativeKey: string, absAsset: string): string {
  const abs = path.isAbsolute(absAsset) ? absAsset : path.resolve(projectDir, absAsset);
  if (abs === projectDir || abs.startsWith(projectDir + path.sep)) {
    return path.relative(projectDir, abs);
  }
  return repoRootRelativeKey;
}

// Track staged paths per build to avoid redundant work and loops
const stagedPaths = new Set<string>();

async function stageFile(
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
      validateConfig(config);
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
      await ensureConfig(process.cwd());

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

      return modified as typeof nextConfig;
    },

    async onBuildComplete(ctx: BuildCompleteContext) {
      const { routing, outputs, projectDir, config: nextConfig, buildId, nextVersion } = ctx;
      const repoRoot = (ctx as { repoRoot?: string }).repoRoot ?? projectDir;

      // Regenerate the Helm chart from a clean slate. Chart files are named per
      // pool/build; without wiping, a removed pool's Deployment/Service or a
      // stale template from a prior build survives and gets re-applied by the
      // next `helm upgrade`. Only the generated chart dir is cleared — staged
      // build contexts and injected previous-build templates live elsewhere and
      // are managed by their own steps.
      const { rm } = await import("node:fs/promises");
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

      const cfg = await ensureConfig(projectDir);
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
      const staticManifest = buildStaticManifest(outputs, projectDir);

      // 4. Generate Helm chart
      // Read releaseName from infrastructure.json (written by init) so it matches
      // the gcloud resource names (IP, gateway, etc.)
      const infraPath = path.join(projectDir, ".k8s-adapter", "infrastructure.json");
      const infra = existsSync(infraPath) ? JSON.parse(readFileSync(infraPath, "utf-8")) : {};
      const releaseName =
        infra.releaseName ??
        path
          .basename(projectDir)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-") ??
        "nextjs";

      // Phase 2 artifacts (Route Extension) — computed before Helm chart so extensionChain is available
      const celExpression = generateCelExpression({
        outputs,
        dynamicRoutes: routing.dynamicRoutes,
      });

      const failureModeAllow = determineFailureMode(outputs, cfg.routingService?.failureMode);

      const gkeProvider = cfg.provider.gke;

      const extensionChain = generateExtensionChain({
        celExpression,
        releaseName,
        namespace: infra.namespace ?? "default",
        projectId: infra.projectId ?? "",
        region: infra.region ?? "",
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
        imageRegistry: infra.containerRegistry ?? process.env.IMAGE_REGISTRY ?? "REGISTRY",
        routingManifest,
        releaseName,
        extensionChainJson: extensionChain,
        routingFailOpen: failureModeAllow,
        infrastructure: { projectId: infra.projectId, region: infra.region },
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        await writeOutputFile(projectDir, `chart/${filePath}`, content);
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
          generateDockerfile({
            containerStrategy: "shared-image",
            nodeVersion: "22",
            buildId,
          }),
          absSharedStageDir,
        );
      } else {
        for (const [poolName, pool] of pools) {
          const poolDir = path.join(OUTPUT_DIR, "pools", poolName);
          const poolStageDir = path.join(poolDir, "context");

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
              nodeVersion: "22",
              buildId,
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

      // Phase 2 artifacts — write to output (computation moved above Helm chart generation)
      await writeOutputFile(projectDir, "extension-chains.json", extensionChain);
      await writeOutputFile(projectDir, "cel-expression.txt", celExpression);

      // Routing service Dockerfile + context (skip when staging is disabled)
      if (!skipStaging) {
        const routingServiceDir = path.join(OUTPUT_DIR, "routing-service");

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          generateRoutingServiceDockerfile({ nodeVersion: "22", buildId }),
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
          if (!existsSync(dest)) {
            await mkdir(path.dirname(dest), { recursive: true });
            await cp(depDir, dest, { recursive: true, dereference: true });
          }
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

        // Stage middleware module + its chunk dependencies
        if (outputs.middleware?.filePath && existsSync(outputs.middleware.filePath)) {
          const mwRelPath = path.relative(projectDir, outputs.middleware.filePath);
          const mwDest = path.join(projectDir, routingServiceContextDir, mwRelPath);
          if (!existsSync(mwDest)) {
            await mkdir(path.dirname(mwDest), { recursive: true });
            await copyFile(outputs.middleware.filePath, mwDest);
          }
          // Stage middleware's traced assets (files and directories)
          const mwAssets = (outputs.middleware as any).assets ?? {};
          for (const [relAsset, absAsset] of Object.entries(mwAssets)) {
            if (typeof absAsset === "string" && existsSync(absAsset)) {
              const dest = path.join(
                projectDir,
                routingServiceContextDir,
                assetDestPath(projectDir, relAsset, absAsset),
              );
              if (!existsSync(dest)) {
                await mkdir(path.dirname(dest), { recursive: true });
                const stat = statSync(absAsset);
                if (stat.isDirectory()) {
                  await cp(absAsset, dest, { recursive: true, dereference: true });
                } else {
                  await copyFile(absAsset, dest);
                }
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
          if (existsSync(chunksDir) && !existsSync(chunksDest)) {
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
