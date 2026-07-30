// Build-seed index: maps an incremental-cache key to the on-disk build prerender, so a Valkey
// MISS can answer the way `next start`'s filesystem cache would — that cache STARTS FULL (the
// build outputs are its initial content) while a custom handler starts empty. Next assumes the
// full model in two load-bearing places, both observed live on GKE 2026-07-30:
//
//   - `dynamicParams: false` routes refuse to render dynamically: a miss throws
//     "invariant: cache entry required but not generated" and the request 500s.
//   - First requests to any prerendered page re-render instead of serving the artifact,
//     which is wrong even when it does not crash.
//
// The index is built once per process from the SAME static-assets manifest the pool server
// serves from (CONFIG_DIR/static-assets.json, present in the pool image), so the set of
// seedable keys is exactly the set of build prerenders. PPR artifacts are excluded — their
// shells carry postponed state and are owned by the dispatch-level shell/resume machinery.
//
// This module is bundled into cache-handler.cjs, which must evaluate cleanly in EVERY runtime
// including edge — so node builtins are required lazily inside functions, never at module eval
// (same rule as the Valkey client; see cache-handler-entry.ts).
import type { SeedEntry } from "./incremental-cache-handler.js";

declare const require: (id: string) => any;

interface StaticAssetRecord {
  pathname: string;
  filePath: string;
  prerender?: boolean;
  ppr?: unknown;
  status?: number;
  headers?: Record<string, string>;
}

interface SeedSource {
  htmlPath: string;
  rscPath?: string;
  status: number;
  headers: Record<string, string>;
  tags: string[];
}

/** Parse the x-next-cache-tags header the build stamps on prerender records. */
function seedTags(headers: Record<string, string> | undefined): string[] {
  const raw = Object.entries(headers ?? {}).find(
    ([name]) => name.toLowerCase() === "x-next-cache-tags",
  )?.[1];
  if (!raw) return [];
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/** Response headers for the seed value: everything except the internal tag transport. */
function seedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() === "x-next-cache-tags") continue;
    out[name] = value;
  }
  return out;
}

/**
 * Build the pathname → seed-source map. Only App Router document prerenders participate
 * (filePath under `server/app/`, `.html`); their `.rsc` sibling is attached when the manifest
 * carries one. Pages Router prerenders are deliberately absent for now — their cache entries
 * need `pageData` from the JSON sibling and nothing measured requires them yet.
 */
export function buildSeedSources(assets: StaticAssetRecord[]): Map<string, SeedSource> {
  const rscByPathname = new Map<string, string>();
  for (const asset of assets) {
    if (asset.prerender && !asset.ppr && asset.pathname.endsWith(".rsc")) {
      rscByPathname.set(asset.pathname.slice(0, -".rsc".length) || "/", asset.filePath);
    }
  }
  const sources = new Map<string, SeedSource>();
  for (const asset of assets) {
    if (!asset.prerender || asset.ppr) continue;
    if (!asset.filePath.includes("server/app/") || !asset.filePath.endsWith(".html")) continue;
    const source: SeedSource = {
      htmlPath: asset.filePath,
      status: asset.status ?? 200,
      headers: seedHeaders(asset.headers),
      tags: seedTags(asset.headers),
    };
    const rsc = rscByPathname.get(asset.pathname);
    if (rsc !== undefined) source.rscPath = rsc;
    sources.set(asset.pathname, source);
    // Next normalizes the root cache key to "/index" (normalizePagePath); the manifest keys
    // the root prerender as "/". Register both spellings so neither caller misses.
    if (asset.pathname === "/") sources.set("/index", source);
  }
  return sources;
}

/**
 * Create the `seedLookup` used by ValkeyIncrementalCacheHandler. Lazy and defensive: the
 * manifest is read once on first use; any failure (missing manifest, unreadable file) is a
 * miss, never a crash — the caller already treats seed errors as misses and logs them.
 */
export function createBuildSeedLookup(options?: {
  configDir?: string;
  appRoot?: string;
}): (cacheKey: string) => Promise<SeedEntry | null> {
  let sources: Map<string, SeedSource> | null | undefined;

  const load = (): Map<string, SeedSource> | null => {
    if (sources !== undefined) return sources;
    try {
      const fs = require("node:fs");
      const path = require("node:path");
      const appRoot = options?.appRoot ?? process.cwd();
      const configDir = options?.configDir ?? process.env.CONFIG_DIR ?? "config";
      const manifestPath = path.resolve(appRoot, configDir, "static-assets.json");
      const assets = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as StaticAssetRecord[];
      sources = buildSeedSources(assets);
    } catch {
      // No manifest (local run, cache-disabled build) → no seeds. Cached as null so a missing
      // manifest costs one failed read per process, not one per request.
      sources = null;
    }
    return sources;
  };

  return async (cacheKey: string): Promise<SeedEntry | null> => {
    const map = load();
    if (!map) return null;
    const source = map.get(cacheKey);
    if (!source) return null;
    const fs = require("node:fs");
    const path = require("node:path");
    const appRoot = options?.appRoot ?? process.cwd();
    const htmlAbs = path.resolve(appRoot, source.htmlPath);
    const stat = fs.statSync(htmlAbs);
    const html = fs.readFileSync(htmlAbs, "utf8");
    // rscData is REQUIRED on APP_PAGE entries for RSC requests; a seed without one only
    // serves documents, so decline entirely rather than emit a half-usable entry.
    if (!source.rscPath) return null;
    const rscData = fs.readFileSync(path.resolve(appRoot, source.rscPath));
    return {
      // The artifact's mtime — identical across replicas (it is an image layer), survives pod
      // restarts, and anchors Next's own age-vs-revalidate staleness math the same way the
      // filesystem cache's file mtimes do in `next start`.
      lastModified: Math.round(stat.mtimeMs),
      tags: source.tags,
      value: {
        kind: "APP_PAGE",
        html,
        rscData,
        headers: source.headers,
        status: source.status,
      },
    };
  };
}
