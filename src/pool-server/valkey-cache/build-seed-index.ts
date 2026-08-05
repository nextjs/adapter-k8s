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
// serves from (CONFIG_DIR/static-assets.json, present in the pool image). PPR artifacts are
// excluded from THAT source (an html-only seed is half-usable) — they are covered by the
// filesystem-mirror layer below, which reads `.next/server/app/<key>` exactly the way
// next start's FileSystemCache does (html + .meta postponed state + .segments), so
// route-keyed fallback-shell lookups behave like a warm fs cache. Without it, every PPR
// shell lookup missed under the production config and the route rendered fully dynamically
// (k3d full run: the sub-shell-generation family, "(runtime)" where "(buildtime)").
//
// This module is bundled into cache-handler.cjs, which must evaluate cleanly in EVERY runtime
// including edge — so node builtins are required lazily inside functions, never at module eval
// (same rule as the Valkey client; see cache-handler-entry.ts).
import type { SeedEntry } from "./incremental-cache-handler.js";

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
// Edge-compile-safe builtin loading — same contract as resp-client.ts: Turbopack refuses
// static `require("node:*")` specifiers in the Edge Runtime compilation, and this module is
// bundled into next.config.cacheHandler which the edge middleware graph pulls in. The seed
// lookup only ever RUNS in the Node pool; in the edge bundle this is dead code that parses.
function builtin<T>(id: string): T {
  const getBuiltin = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
  ).process?.getBuiltinModule;
  if (!getBuiltin) {
    throw new Error(`[valkey-cache] process.getBuiltinModule unavailable loading ${id}`);
  }
  return getBuiltin(id) as T;
}

/** Edge-parse-safe cwd — Turbopack flags a literal `process.cwd()` as a Node API even in
 * dead code; property access through globalThis is invisible to that detector. */
function cwd(): string {
  return (globalThis as { process?: { cwd?: () => string } }).process!.cwd!();
}

export interface SeedLookupCtx {
  kind?: string;
  isFallback?: boolean;
  isRoutePPREnabled?: boolean;
}

/**
 * Next's fetch-cache keys are hex digests (`incremental-cache/index.ts` generateCacheKey);
 * validate at the point of consumption — the key becomes a filename under `.next/cache`, so
 * separators and dots are refused outright rather than path-normalized.
 */
const SAFE_FETCH_CACHE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Fetch-cache mirror seed: read `<appRoot>/.next/cache/fetch-cache/<key>` the way
 * FileSystemCache.get does for kind FETCH (file-system-cache.ts:146-188 — one JSON file,
 * the CachedFetchValue stored verbatim, lastModified from the file mtime). The BUILD's
 * fetch entries are `next start`'s warm-start content, and their absence is not a mere
 * cold-start cost: after a PROFILED `revalidateTag`, upstream patch-fetch foreground-
 * refetches a STALE fetch entry with the prerender's abort signal DETACHED
 * (patch-fetch.ts:1073-1104, `signal: isStale ? undefined : signal`), while a MISS
 * re-fetches signal-ATTACHED — under load the cache-components background revalidation
 * loses that race and dies with "uncached or runtime data during prerendering", so the
 * page serves stale forever (both rdc consistency tests, traced live 2026-08-04).
 */
function fetchCacheSeed(appRoot: string, cacheKey: string): SeedEntry | null {
  if (!SAFE_FETCH_CACHE_KEY.test(cacheKey)) return null;
  const fs = builtin<typeof import("node:fs")>("node:fs");
  const path = builtin<typeof import("node:path")>("node:path");
  const abs = path.join(appRoot, ".next", "cache", "fetch-cache", cacheKey);
  if (!fs.existsSync(abs)) return null;
  const stat = fs.statSync(abs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return null; // corrupt artifact → miss, exactly like a corrupt stored entry (L5)
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { kind?: unknown }).kind !== "FETCH") {
    return null;
  }
  const tags = (parsed as { tags?: unknown }).tags;
  return {
    lastModified: Math.round(stat.mtimeMs),
    tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
    value: parsed as Record<string, unknown>,
  };
}

/**
 * Filesystem-mirror seed: read `.next/server/app/<key>` the way FileSystemCache.get does
 * (file-system-cache.js:138-181 in the installed next) — html, `.meta` (postponed / headers /
 * status / segmentPaths), rscData only when there is NO postponed state, segment files from
 * `<key>.segments/`. Returns null (miss) when the html is absent or the entry would be
 * half-usable.
 */
function fsMirrorSeed(appRoot: string, cacheKey: string, _ctx?: SeedLookupCtx): SeedEntry | null {
  const fs = builtin<typeof import("node:fs")>("node:fs");
  const path = builtin<typeof import("node:path")>("node:path");
  const base = path.join(appRoot, ".next", "server", "app", ...cacheKey.split("/").filter(Boolean));
  const htmlAbs = cacheKey === "/" ? path.join(appRoot, ".next", "server", "app", "index.html") : `${base}.html`;
  if (!fs.existsSync(htmlAbs)) return null;
  const stat = fs.statSync(htmlAbs);
  const html = fs.readFileSync(htmlAbs, "utf8");
  let meta:
    | {
        status?: number;
        headers?: Record<string, string>;
        postponed?: string;
        segmentPaths?: string[];
      }
    | undefined;
  try {
    meta = JSON.parse(fs.readFileSync(htmlAbs.replace(/\.html$/, ".meta"), "utf8"));
  } catch {
    // fs-cache tolerates a missing meta the same way.
  }
  let rscData: unknown;
  // DELIBERATE DIVERGENCE from FileSystemCache.get (whose gate reduces to
  // `!isFallback && postponed == null`): an isFallback read with no postponed state and no
  // .rsc file DECLINES here instead of returning the bare fallback HTML. Measured A/B on
  // cache-components-prerender-matrix (2026-08-02, lane A/B): honoring fallback reads for
  // these entries hands Next's runtime the build's GENERIC fallback shell and param
  // regions render empty — 3/60 -> 21/60 failing ("Expected: id-<uuid> Received: ''").
  // Declining makes Next render the document fresh, which is the correct (and green)
  // behavior for the partialFallback contract this adapter does not implement.
  if (meta?.postponed == null) {
    const rscAbs = htmlAbs.replace(/\.html$/, ".rsc");
    if (!fs.existsSync(rscAbs)) return null; // half-usable without flight data — decline
    rscData = fs.readFileSync(rscAbs);
  }
  let segmentData: Map<string, unknown> | undefined;
  if (meta?.segmentPaths) {
    segmentData = new Map();
    const segmentsDir = htmlAbs.replace(/\.html$/, ".segments");
    for (const segmentPath of meta.segmentPaths) {
      try {
        // `<key>.segments` + segmentPath + RSC_SEGMENT_SUFFIX (".segment.rsc"), exactly as
        // FileSystemCache.get concatenates them — segmentPath always starts with "/".
        segmentData.set(
          segmentPath,
          fs.readFileSync(path.join(segmentsDir, `${segmentPath}.segment.rsc`)),
        );
      } catch {
        // Same as fs-cache: a missing segment file is treated as dynamic (no prefetch).
      }
    }
  }
  return {
    lastModified: Math.round(stat.mtimeMs),
    tags: seedTags(meta?.headers),
    value: {
      kind: "APP_PAGE",
      html,
      ...(rscData !== undefined ? { rscData } : {}),
      ...(meta?.postponed !== undefined ? { postponed: meta.postponed } : {}),
      headers: seedHeaders(meta?.headers),
      status: meta?.status ?? 200,
      ...(segmentData !== undefined ? { segmentData } : {}),
    },
  };
}

export function createBuildSeedLookup(options?: {
  configDir?: string;
  appRoot?: string;
}): (cacheKey: string, ctx?: SeedLookupCtx) => Promise<SeedEntry | null> {
  let sources: Map<string, SeedSource> | null | undefined;

  const load = (): Map<string, SeedSource> | null => {
    if (sources !== undefined) return sources;
    try {
      const fs = builtin<typeof import("node:fs")>("node:fs");
      const path = builtin<typeof import("node:path")>("node:path");
      const appRoot = options?.appRoot ?? cwd();
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

  return async (cacheKey: string, ctx?: SeedLookupCtx): Promise<SeedEntry | null> => {
    // FETCH keys never appear in the static-assets manifest and must never fall through to
    // the page fs-mirror — they are answered from the staged build fetch-cache or not at all.
    if (ctx?.kind === "FETCH") {
      try {
        return fetchCacheSeed(options?.appRoot ?? cwd(), cacheKey);
      } catch {
        return null;
      }
    }
    const map = load();
    const source = map?.get(cacheKey);
    if (!source) {
      // Keys the manifest doesn't carry — route-keyed PPR fallback shells, concrete PPR
      // prerenders, segment-bearing entries — fall through to the filesystem mirror. Scoped
      // to APP_PAGE (or unstated kind): PAGES/FETCH keys have different shapes.
      if (ctx?.kind !== undefined && ctx.kind !== "APP_PAGE") return null;
      try {
        const appRoot = options?.appRoot ?? cwd();
        return fsMirrorSeed(appRoot, cacheKey, ctx);
      } catch {
        return null;
      }
    }
    const fs = builtin<typeof import("node:fs")>("node:fs");
    const path = builtin<typeof import("node:path")>("node:path");
    const appRoot = options?.appRoot ?? cwd();
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
