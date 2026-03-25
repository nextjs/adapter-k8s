// src/emit/static-assets.ts
import path from 'node:path';
import type { AdapterOutputs, StaticAssetEntry } from '../types.js';

export function buildStaticManifest(outputs: AdapterOutputs, projectDir: string): StaticAssetEntry[] {
  const entries: StaticAssetEntry[] = [];

  const staticOutputs = [
    ...outputs.staticFiles,
    ...outputs.prerenders,
    ...outputs.appPages.filter((p) => String(p.type) === "STATIC_PAGE"),
    ...outputs.pages.filter((p) => String(p.type) === "STATIC_PAGE"),
  ];

  for (const file of staticOutputs) {
    entries.push({
      pathname: file.pathname,
      filePath: path.relative(projectDir, file.filePath),
      cacheControl: (file as any).immutableHash
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    });
  }

  return entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
