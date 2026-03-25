// src/adapter.ts
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { NextAdapter, K8sAdapterConfig, BuildCompleteContext } from './types.js';
import { validateConfig, applyDefaults } from './config.js';
import { classifyIntoPools } from './classify.js';
import { buildRoutingManifest } from './manifest.js';
import { generateHelmChart } from './emit/helm.js';
import { generateDockerfile, generatePoolDockerfile } from './emit/dockerfiles.js';
import { generateBuildMetadata } from './emit/metadata.js';
import { buildStaticManifest } from './emit/static-assets.js';

// Output directory matches §18.3 in the design doc
const OUTPUT_DIR = '.k8s-adapter/output';

async function writeOutputFile(distDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(distDir, OUTPUT_DIR, relativePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

export function createK8sAdapter(userConfig: K8sAdapterConfig): NextAdapter {
  validateConfig(userConfig);
  const config = applyDefaults(userConfig);

  return {
    name: 'k8s',

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
      const { routing, outputs, distDir, config: nextConfig, buildId, nextVersion } = ctx;

      // 1. Classify outputs into pools
      const pools = classifyIntoPools(outputs, config);

      // 2. Build routing manifest
      const routingManifest = buildRoutingManifest({
        routing,
        outputs,
        pools,
        buildId,
        basePath: nextConfig.basePath ?? '',
        i18n: nextConfig.i18n ?? null,
        nextVersion,
      });

      // 3. Build static asset manifest
      const staticManifest = buildStaticManifest(outputs);

      // 4. Generate Helm chart
      const helmFiles = generateHelmChart({
        pools,
        buildId,
        nextVersion,
        config,
        imageRegistry: process.env.IMAGE_REGISTRY ?? 'REGISTRY',
        routingManifest,
      });

      for (const [filePath, content] of Object.entries(helmFiles)) {
        await writeOutputFile(distDir, `chart/${filePath}`, content);
      }

      // 5. Generate Dockerfiles
      if (config.containerStrategy === 'shared-image') {
        await writeOutputFile(distDir, 'Dockerfile', generateDockerfile({
          containerStrategy: 'shared-image',
          nodeVersion: '22',
        }));
      } else {
        for (const [poolName, pool] of pools) {
          const assets: Record<string, string> = {};
          const entrypoints: string[] = [];
          for (const output of pool.outputs) {
            entrypoints.push(output.filePath);
            for (const [rel, abs] of Object.entries(output.assets)) {
              assets[rel] = abs;
            }
          }
          await writeOutputFile(distDir, `Dockerfile.${poolName}`, generatePoolDockerfile({
            poolName,
            assets,
            entrypoints,
            nodeVersion: '22',
          }));
        }
      }

      // 6. Write manifests
      await writeOutputFile(distDir, 'routing-manifest.json', JSON.stringify(routingManifest, null, 2));
      await writeOutputFile(distDir, 'static-assets.json', JSON.stringify(staticManifest, null, 2));

      // 7. Write pool manifests (one per pool — used by pool server)
      for (const [poolName, pool] of pools) {
        const poolManifest = {
          buildId,
          poolName,
          outputs: Object.fromEntries(
            pool.outputs.map((o) => [
              o.id,
              { id: o.id, filePath: o.filePath, pathname: o.pathname, type: o.type },
            ])
          ),
        };
        await writeOutputFile(distDir, `pool-manifest-${poolName}.json`, JSON.stringify(poolManifest, null, 2));
      }

      // 8. Write build metadata
      await writeOutputFile(distDir, 'build-metadata.json', generateBuildMetadata({
        buildId,
        nextVersion,
        poolNames: [...pools.keys()],
        generatedAt: new Date().toISOString(),
      }));

      // 9. Write placeholder pool-server.js (Phase 1b will provide the real implementation)
      await writeOutputFile(
        distDir,
        '../.k8s-adapter/pool-server.js',
        'console.log("Pool server placeholder. Real implementation in Phase 1b.");'
      );
    },
  };
}
