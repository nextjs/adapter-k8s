// src/adapter.ts
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  NextAdapter,
  K8sAdapterConfig,
  BuildCompleteContext,
} from "./types.js";

// Get current directory in a way that works in ESM and CJS bundle
const _dirname =
  typeof import.meta.url === "string"
    ? path.dirname(fileURLToPath(import.meta.url))
    : __dirname;
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
): Promise<void> {
  const fullPath = path.join(projectDir, OUTPUT_DIR, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
}

export function createK8sAdapter(userConfig: K8sAdapterConfig): NextAdapter {
  validateConfig(userConfig);
  const config = applyDefaults(userConfig);

  return {
    name: "k8s",

    modifyConfig(nextConfig) {
      return {
        ...nextConfig,
        compress: false,
        // TODO (Phase 3): cacheHandler for ISR
        // TODO (Phase 3): cacheHandlers for 'use cache' directives
        // TODO (Phase 4): assetPrefix from CDN origin
        // TODO (Phase 4): images.loader + images.loaderFile for image optimizer sidecar
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

      // 1. Classify outputs into pools
      const pools = classifyIntoPools(outputs, config);

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
      const helmFiles = generateHelmChart({
        pools,
        buildId,
        nextVersion,
        config,
        imageRegistry: process.env.IMAGE_REGISTRY ?? "REGISTRY",
        routingManifest,
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        await writeOutputFile(projectDir, `chart/${filePath}`, content);
      }

      // 5. Generate Dockerfiles
      if (config.containerStrategy === "shared-image") {
        await writeOutputFile(
          projectDir,
          "Dockerfile",
          generateDockerfile({
            containerStrategy: "shared-image",
            nodeVersion: "22",
            buildId,
          }),
        );
      } else {
        const firstPoolName = [...pools.keys()][0];
        for (const [poolName, pool] of pools) {
          const assets: Record<string, string> = {};
          const entrypoints: string[] = [];
          for (const output of pool.outputs) {
            entrypoints.push(path.relative(projectDir, output.filePath));
            for (const rel of Object.keys(output.assets)) {
              assets[rel] = rel;
            }
          }

          const isDefaultPool = poolName === firstPoolName;
          const staticPaths = isDefaultPool
            ? staticManifest.map((a) => a.filePath)
            : [];

          await writeOutputFile(
            projectDir,
            `Dockerfile.${poolName}`,
            generatePoolDockerfile({
              poolName,
              assets,
              entrypoints,
              nodeVersion: "22",
              buildId,
              middlewarePath: outputs.middleware
                ? path.relative(projectDir, outputs.middleware.filePath)
                : null,
              staticPaths,
            }),
          );
        }
      }

      // 6. Write manifests
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

      // 7. Write pool manifests (one per pool — used by pool server)
      for (const [poolName, pool] of pools) {
        const poolManifest = {
          buildId,
          poolName,
          outputs: Object.fromEntries(
            pool.outputs.map((o) => [
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
          `pool-manifest-${poolName}.json`,
          JSON.stringify(poolManifest, null, 2),
        );
      }

      // 8. Write build metadata
      await writeOutputFile(
        projectDir,
        "build-metadata.json",
        generateBuildMetadata({
          buildId,
          nextVersion,
          poolNames: [...pools.keys()],
          generatedAt: new Date().toISOString(),
        }),
      );

      // 9. Copy pool server runtime
      try {
        // In the bundled package, pool-server.cjs is a sibling of index.cjs in dist/
        const poolServerSrc = path.join(_dirname, "pool-server.cjs");
        if (existsSync(poolServerSrc)) {
          const poolServerContent = readFileSync(poolServerSrc, "utf-8");
          await writeOutputFile(projectDir, "pool-server.cjs", poolServerContent);
        } else {
          console.warn("Pool server bundle not found at", poolServerSrc);
        }
      } catch (err) {
        console.warn("Failed to resolve pool server runtime:", err);
      }
    },
  };
}
