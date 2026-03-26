// src/emit/static-assets.ts
import path from 'node:path';
import type { AdapterOutputs, StaticAssetEntry } from '../types.js';

export function buildStaticManifest(outputs: AdapterOutputs, projectDir: string): StaticAssetEntry[] {
  const entries: StaticAssetEntry[] = [];

  // Static files have a top-level filePath
  for (const file of outputs.staticFiles) {
    if (!file.filePath) continue;
    entries.push({
      pathname: file.pathname,
      filePath: path.relative(projectDir, file.filePath),
      cacheControl: (file as any).immutableHash
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    });
  }

  // Prerenders have their HTML in fallback.filePath, not a top-level filePath
  for (const prerender of outputs.prerenders) {
    const fallbackPath = prerender.fallback?.filePath;
    if (!fallbackPath) continue;
    entries.push({
      pathname: prerender.pathname,
      filePath: path.relative(projectDir, fallbackPath),
      cacheControl: "public, max-age=3600",
    });
  }

  return entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
