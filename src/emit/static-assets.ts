// src/emit/static-assets.ts
import type { AdapterOutputs, StaticAssetEntry } from "../types.js";

export function buildStaticManifest(outputs: AdapterOutputs): StaticAssetEntry[] {
  const entries: StaticAssetEntry[] = [];

  const staticOutputs = [
    ...outputs.staticFiles,
    ...outputs.prerenders,
    ...outputs.appPages.filter((p) => p.type === (1 as any)), // STATIC_PAGE if available
    ...outputs.pages.filter((p) => p.type === (1 as any)),
  ];

  for (const file of staticOutputs) {
    entries.push({
      pathname: file.pathname,
      filePath: file.filePath,
      cacheControl: (file as any).immutableHash
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600',
    });
  }

  return entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
