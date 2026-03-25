// src/adapter.ts
import { writeFile, mkdir, copyFile, cp, realpath } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  NextAdapter,
  K8sAdapterConfig,
  BuildCompleteContext,
} from "./types.js";

// Get current directory in a way that works in ESM and CJS bundle
const _dirname =
  typeof import.meta !== "undefined" && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : typeof __dirname !== "undefined"
      ? __dirname
      : process.cwd();

import { validateConfig, applyDefaults } from "./config.js";
import { classifyIntoPools } from "./classify.js";
import { buildRoutingManifest } from "./manifest.js";
import { generateHelmChart } from "./emit/helm.js";
import {
  generateDockerfile,
  generatePoolDockerfile,
} from "./emit/dockerfiles.js";
import { generateBuildMetadata } from "./emit/metadata.js";
import { buildStaticManifest } from "./emit/static-assets.js";

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

// Track staged paths per build to avoid redundant work and loops
const stagedPaths = new Set<string>();

async function stageFile(
  projectDir: string,
  sourcePath: string,
  destRelativePath: string,
  poolName: string,
  isShared: boolean = false
): Promise<void> {
  const absSource = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(projectDir, sourcePath);
  
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
    console.warn(`[adapter-k8s] Failed to stage ${sourcePath} -> ${destRelativePath}:`, (err as Error).message);
  }
}

export function createK8sAdapter(userConfig?: K8sAdapterConfig): NextAdapter {
  let config: K8sAdapterConfig | undefined = userConfig;

  async function ensureConfig(projectDir: string) {
    if (config) return config;

    // Try to load from project root
    const configPaths = [
      path.join(projectDir, "adapter.config.ts"),
      path.join(projectDir, "adapter.config.js"),
      path.join(projectDir, "adapter.config.mjs"),
    ];

    for (const p of configPaths) {
      if (existsSync(p)) {
        try {
          const mod = await import(pathToFileURL(p).href);
          const exported = mod.default;
          if (exported && typeof exported === "object") {
            // Standard adapters export the object directly OR an instance.
            // If it's an instance, we tucked the config into a hidden property below.
            config = exported.config || exported;
          }
          break;
        } catch (err) {
          console.error(`Failed to load config from ${p}:`, err);
        }
      }
    }

    if (!config) {
      throw new Error(
        "adapter.config.ts not found. Run `npx adapter-k8s init` to scaffold it.",
      );
    }

    validateConfig(config);
    config = applyDefaults(config);
    return config;
  }

  const adapter: NextAdapter = {
    name: "k8s",

    async modifyConfig(nextConfig, ctx) {
      const projectDir = (ctx as any).projectDir || process.cwd();
      await ensureConfig(projectDir);

      return {
        ...nextConfig,
        compress: false,
      } as typeof nextConfig;
    },

    async onBuildComplete(ctx: BuildCompleteContext) {
      const {
        routing,
        outputs,
        projectDir,
        config: nextConfig,
        buildId,
        nextVersion,
      } = ctx;

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
        nextVersion,
        projectDir,
      });

      // 3. Build static asset manifest
      const staticManifest = buildStaticManifest(outputs, projectDir);

      // 4. Generate Helm chart
      // Read releaseName from infrastructure.json (written by init) so it matches
      // the gcloud resource names (IP, gateway, etc.)
      const infraPath = path.join(projectDir, '.k8s-adapter', 'infrastructure.json');
      const infra = existsSync(infraPath)
        ? JSON.parse(readFileSync(infraPath, 'utf-8'))
        : {};
      const releaseName = infra.releaseName
        ?? path.basename(projectDir).toLowerCase().replace(/[^a-z0-9]/g, '-')
        ?? 'nextjs';

      const helmFiles = generateHelmChart({
        pools,
        buildId,
        nextVersion,
        config: cfg,
        imageRegistry: infra.containerRegistry ?? process.env.IMAGE_REGISTRY ?? "REGISTRY",
        routingManifest,
        releaseName,
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        await writeOutputFile(projectDir, `chart/${filePath}`, content);
      }

      // 5. Build Stage Area & Dockerfiles
      const poolServerSrc = path.join(_dirname, "pool-server.cjs");
      const poolServerContent = existsSync(poolServerSrc) ? readFileSync(poolServerSrc, "utf-8") : "";

      if (cfg.containerStrategy === "shared-image") {
        const sharedStageDir = "shared-context";
        const absSharedStageDir = path.join(OUTPUT_DIR, sharedStageDir);
        
        // Stage everything for shared image
        await cp(path.join(projectDir, ".next"), path.join(projectDir, absSharedStageDir, ".next"), { recursive: true, dereference: true });
        await cp(path.join(projectDir, "node_modules"), path.join(projectDir, absSharedStageDir, "node_modules"), { recursive: true, dereference: true });
        await copyFile(path.join(projectDir, "package.json"), path.join(projectDir, absSharedStageDir, "package.json"));
        
        if (poolServerContent) {
          await writeOutputFile(projectDir, "pool-server.cjs", poolServerContent, absSharedStageDir);
        }
        
        await writeOutputFile(projectDir, "config/routing-manifest.json", JSON.stringify(routingManifest, null, 2), absSharedStageDir);
        await writeOutputFile(projectDir, "config/static-assets.json", JSON.stringify(staticManifest, null, 2), absSharedStageDir);
        
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
                  },
                ]),
            ),
          };
          await writeOutputFile(projectDir, `config/pool-manifest-${poolName}.json`, JSON.stringify(poolManifest, null, 2), absSharedStageDir);
        }

        await writeOutputFile(
          projectDir,
          "Dockerfile",
          generateDockerfile({
            containerStrategy: "shared-image",
            nodeVersion: "22",
            buildId,
          }),
          absSharedStageDir
        );
      } else {
        const firstPoolName = [...pools.keys()][0];
        for (const [poolName, pool] of pools) {
          const isDefaultPool = poolName === firstPoolName;
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
                await stageFile(projectDir, absAsset, relAsset, poolName);
              }
            }
          }

          if (isDefaultPool) {
            for (const asset of staticManifest) {
              const absPath = path.resolve(projectDir, asset.filePath);
              await stageFile(projectDir, absPath, asset.filePath, poolName);
            }
          }

          if (outputs.middleware?.filePath) {
            const relPath = path.relative(
              projectDir,
              outputs.middleware.filePath,
            );
            await stageFile(
              projectDir,
              outputs.middleware.filePath,
              relPath,
              poolName,
            );
          }

          // Stage next/setup-node-env (required for AsyncLocalStorage initialization)
          const nextPkgDir = path.join(projectDir, "node_modules", "next");
          if (existsSync(nextPkgDir)) {
            await stageFile(projectDir, nextPkgDir, "node_modules/next", poolName);
          }

          // Stage @next/routing (required for pool server local route resolution)
          const nextRoutingDir = path.join(projectDir, "node_modules", "@next", "routing");
          if (existsSync(nextRoutingDir)) {
            await stageFile(projectDir, nextRoutingDir, "node_modules/@next/routing", poolName);
          }

          // Shared context files
          await writeOutputFile(
            projectDir,
            "package.json",
            JSON.stringify({ type: "commonjs" }),
            poolStageDir,
          );
          if (poolServerContent) {
            await writeOutputFile(
              projectDir,
              "pool-server.cjs",
              poolServerContent,
              poolStageDir,
            );
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
            poolDir
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
      await writeOutputFile(
        projectDir,
        "build-metadata.json",
        generateBuildMetadata({
          buildId,
          nextVersion,
          poolNames: [...pools.keys()],
          generatedAt: new Date().toISOString(),
          containerStrategy: cfg.containerStrategy,
        }),
      );
    },
  };

  // Expose config for ensureConfig to find when it imports an existing adapter instance
  Object.defineProperty(adapter, "config", {
    value: userConfig,
    enumerable: false,
    writable: false,
  });

  return adapter;
}
