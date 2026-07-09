// src/emit/static-assets.ts
import path from "node:path";
import type { AdapterOutputs, StaticAssetEntry } from "../types.js";

export function buildStaticManifest(
  outputs: AdapterOutputs,
  projectDir: string,
): StaticAssetEntry[] {
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

  // Prerenders have their content in fallback.filePath with initialHeaders/initialStatus
  for (const prerender of outputs.prerenders) {
    const fallback = prerender.fallback;
    if (!fallback?.filePath) continue;
    const entry: StaticAssetEntry = {
      pathname: prerender.pathname,
      filePath: path.relative(projectDir, fallback.filePath),
      cacheControl: "public, max-age=0, must-revalidate",
    };
    if (fallback.initialHeaders) entry.headers = fallback.initialHeaders;
    if (fallback.initialStatus) entry.status = fallback.initialStatus;
    if (fallback.postponedState) entry.ppr = true;
    if (fallback.initialRevalidate !== undefined) entry.revalidate = fallback.initialRevalidate;
    entry.prerender = true;
    entries.push(entry);
  }

  return entries.sort((a, b) => a.pathname.localeCompare(b.pathname));
}
