// src/emit/static-assets.ts
import path from "node:path";
import type { AdapterOutputs, StaticAssetEntry } from "../types.js";
import { isNextStaticPath, nextStaticAssetHeaders } from "../static-asset-headers.js";
import { collectPublicPathnames } from "../pool-server/public-files.js";

// Canonical URL-encoded form of a public file's pathname — the exact string
// `new URL(req.url, base).pathname` yields when a client requests the file.
// The dispatcher matches manifest pathnames against that form (the routing
// extension's x-output-id and Phase-1 matchedPathname both preserve the
// request's percent-encoding), so `public/image probe.svg` must be keyed
// "/image%20probe.svg" — its decoded filesystem name can never match.
// Only %, ? and # are pre-escaped by hand (they are structural to the URL
// parser: an unescaped "?" would truncate the path into a query); the WHATWG
// parser then applies the path percent-encode set (space, non-ASCII, controls,
// …) exactly the way browsers encode the request target, while leaving
// characters like &, (, ) untouched — encodeURIComponent would over-encode
// those and mis-key the entry.
function canonicalPublicPathname(decodedPathname: string): string {
  return new URL(
    "http://localhost" +
      decodedPathname.replace(/%/g, "%25").replace(/\?/g, "%3F").replace(/#/g, "%23"),
  ).pathname;
}

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

  // public/ files are NOT in Next's adapter outputs (staticFiles covers only build
  // outputs), but the pool dispatcher serves Phase-2 (trusted routing-extension
  // dispatch) responses EXCLUSIVELY from this manifest. Missing entries here made
  // every middleware-covered public asset 404 in production (build XchOtaGFu6GdF…)
  // while local Phase-1 resolution still found the file on disk — enumerate
  // public/ with the same helper the pool's resolver uses so dispatch shares the
  // fast paths' inventory. filePath stays the decoded on-disk name; the pathname
  // key is the canonical URL-encoded form requests actually carry. (basePath
  // handling for public files is an existing gap shared with the pool's
  // filesystem fast paths — pathnames here are deliberately un-prefixed, matching
  // the routing manifest's `pathnames` convention.)
  const seenPathnames = new Set(entries.map((e) => e.pathname));
  for (const publicPathname of collectPublicPathnames(projectDir)) {
    const pathname = canonicalPublicPathname(publicPathname);
    if (seenPathnames.has(pathname)) continue;
    seenPathnames.add(pathname);
    entries.push({
      pathname,
      // POSIX join: publicPathname always starts with "/" and uses "/" separators.
      filePath: `public${publicPathname}`,
      // Mutable public-file default — same policy as the pool's public fast path;
      // next.config headers() overrides arrive at request time via the resolved
      // routing verdict (x-resolved-headers), which dispatch merges over this.
      cacheControl: "public, max-age=3600",
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
