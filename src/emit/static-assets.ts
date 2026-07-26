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
// The characters the WHATWG parser would *interpret* rather than encode are
// pre-escaped by hand; the parser then applies the path percent-encode set
// (space, non-ASCII, …) exactly the way browsers encode the request target,
// while leaving characters like &, (, ) untouched — encodeURIComponent would
// over-encode those and mis-key the entry.
//
// N50 (review, Medium): the hand-escaped set used to be only %, ? and #, and the
// comment claimed the parser encoded everything else. It does not — it FOLDS two
// classes:
//   - `\` is mapped to `/` (WHATWG special-scheme path parsing), so `public/a\b.svg`
//     was keyed "/a/b.svg": it either collided with a real `public/a/b.svg` (the dedup
//     below silently drops one) or made /a/b.svg serve the backslash file;
//   - tab, CR and LF are STRIPPED before parsing, so `public/a<TAB>b.svg` was keyed
//     "/ab.svg" — a pathname no request can ever produce, and one that can collide
//     with a real `public/ab.svg`.
// Both are legal POSIX filenames. Percent-encode `\` and every C0 control + DEL by
// hand alongside %, ? and #. (Percent-escapes are emitted uppercase, matching the
// WHATWG/RFC-3986 canonical form the parser itself produces for the characters it
// encodes.)
function canonicalPublicPathname(decodedPathname: string): string {
  const preEscaped = decodedPathname.replace(
    // eslint-disable-next-line no-control-regex
    /[%?#\\\x00-\x1f\x7f]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
  );
  return new URL("http://localhost" + preEscaped).pathname;
}

// Mutable-file cache policy, for public/ files and for build outputs that are NOT
// content-addressed under `_next/static`.
//
// N50 (review, Medium): this was `public, max-age=3600`, which `next start` never
// sends. Measured against real `next start` (Next 16.2.10):
//   GET /probe.txt → `Cache-Control: public, max-age=0` (+ weak ETag, Last-Modified)
//   GET /_next/static/chunks/<hash>.js → `public, max-age=31536000, immutable`
// router-server.ts sets Cache-Control only for `nextStaticFolder` matches; public
// files fall through to `send`, whose default maxAge is 0. An hour of browser-cache
// freshness is not recoverable at deploy time: the CDN honors the deploy's cache-tag
// invalidation, client caches do not — so a replaced logo.png, or a cached 404 for a
// path that just became valid, survived up to an hour past cutover. `must-revalidate`
// is the same freshness (already stale at max-age=0) with no stale-on-error window,
// and the ETag the pool emits makes each revalidation a 304.
// Keep in sync with the pool's public-file fast path and servePublicFileFromDisk
// (pool-server/index.ts, which stamps the same string).
//
// DELIBERATE: no `s-maxage`. Because `cdnCacheTag` (cdn-tags.ts) returns `{}` for a
// max-age=0 response, these responses carry no deploy `cache-tag` — which is correct, as
// there is no shared-cache entry to purge. The alternative (`max-age=0, s-maxage=3600,
// must-revalidate`) would keep Cloud CDN caching public files and keep the tag, but it is
// rejected here for three reasons: (1) invariant 2 — a CDN entry for a public file is
// exactly the object that can be served without the middleware tier ever running, and
// review #7 is what that failure mode costs when it happens; (2) invariant 4 — `next
// start` sends no shared-cache directive, and nothing measured asks for one; (3) it would
// make cutover correctness depend on the tag invalidation firing every time, for a
// marginal saving on files that Phase-4 CDN/GCS offload is meant to move off the pods
// entirely.
const MUTABLE_FILE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

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
      cacheControl: MUTABLE_FILE_CACHE_CONTROL,
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
      cacheControl: MUTABLE_FILE_CACHE_CONTROL,
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

  // N50 (review, Low): sort by CODE POINT, not `localeCompare`. Collation is
  // ICU-dependent (a small-icu Node orders differently from a full-icu one), so the same
  // build produced different manifest bytes on different hosts — and this file ships
  // inside the pool image, so that difference is baked into the artifact.
  return entries.sort((a, b) => (a.pathname < b.pathname ? -1 : a.pathname > b.pathname ? 1 : 0));
}
