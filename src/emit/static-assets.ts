// src/emit/static-assets.ts
import path from 'node:path';
import type { AdapterOutputs, StaticAssetEntry } from '../types.js';

export function buildStaticManifest(outputs: AdapterOutputs, projectDir: string): StaticAssetEntry[] {
  const entries: StaticAssetEntry[] = [];

  const staticOutputs = [
    ...outputs.staticFiles,
    ...outputs.prerenders,
  ];

  for (const file of staticOutputs) {
    if (!file.filePath) {
      console.warn(`[adapter-k8s] Skipping static asset without filePath: ${file.pathname}`);
      continue;
    }
    entries.push({
      pathname: file.pathname,
      filePath: path.relative(projectDir, file.filePath),
      cacheControl: (file as any).immutableHash
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    });
  }

  return entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
