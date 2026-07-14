// src/emit/static-assets.ts
import path from "node:path";
import type { AdapterOutputs, StaticAssetEntry } from "../types.js";
import { isNextStaticPath, nextStaticAssetHeaders } from "../static-asset-headers.js";

// Next's file-based metadata routes (robots/sitemap/manifest + generated icon/OG image routes).
// These are revalidatable, so they get `max-age=0, must-revalidate`, not the static-file default.
function isMetadataRoute(pathname: string): boolean {
  return (
    /^\/(robots\.txt|sitemap\.xml|manifest\.(json|webmanifest))$/.test(pathname) ||
    /^\/sitemap\/\d+\.xml$/.test(pathname) ||
    /\/(icon|apple-icon|opengraph-image|twitter-image)(-[^/]+)?(\.\w+)?$/.test(pathname)
  );
}

export function buildStaticManifest(
  outputs: AdapterOutputs,
  projectDir: string,
  basePath = "",
): StaticAssetEntry[] {
  const entries: StaticAssetEntry[] = [];

  // Static files have a top-level filePath
  for (const file of outputs.staticFiles) {
    if (!file.filePath) continue;
    const entry: StaticAssetEntry = {
      pathname: file.pathname,
      filePath: path.relative(projectDir, file.filePath),
      cacheControl: "public, max-age=3600",
    };
    if (isNextStaticPath(file.pathname)) {
      // `_next/static/*` follows Next's own header policy (immutable, except service workers).
      const { cacheControl, headers } = nextStaticAssetHeaders(file.pathname, basePath);
      entry.cacheControl = cacheControl;
      if (headers) entry.headers = headers;
    } else if (isMetadataRoute(file.pathname)) {
      // Metadata routes (robots/sitemap/manifest, generated at build) are revalidatable — Next
      // serves them `public, max-age=0, must-revalidate`, not the static default.
      entry.cacheControl = "public, max-age=0, must-revalidate";
    } else if ((file as { immutableHash?: string }).immutableHash) {
      // Content-hashed public asset (rare) — safe to serve immutable.
      entry.cacheControl = "public, max-age=31536000, immutable";
    }
    entries.push(entry);
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
