// src/cdn-tags.ts
import { createHash } from "node:crypto";

/**
 * A Cloud-CDN-safe cache tag for a build id. Cloud CDN reads `--tags` comma-delimited and caps
 * each tag at 120 bytes (refusing to cache a response whose tags violate its limits); a
 * user-provided `next.config` `generateBuildId` is preserved by the adapter, so the raw id can
 * contain commas or be arbitrarily long. Hashing yields a deterministic, comma-free, 70-char tag
 * that is stable for the same id and distinct for different ids. NOT k8s name sanitization —
 * that is lossy and can collide two distinct ids onto one tag.
 */
export function cdnTagForBuildId(buildId: string): string {
  return `build-${createHash("sha256").update(buildId).digest("hex")}`;
}

/**
 * Cache-Tag header for CDN-cacheable, *mutable* static responses — content served at the same
 * URL across deploys, so a new build can make it stale (Pages-Router SSG HTML, `public/` files).
 * Returns `{}` for:
 *  - `immutable` assets: content-hash/`?dpl`-versioned and shared across deploys, so tagging +
 *    invalidating them would re-fetch identical bytes every deploy;
 *  - non-cacheable responses (`max-age=0`, `no-store`) the CDN never stores;
 *  - a missing build id.
 * The tag value is the safe hashed tag, identical to what deploy/rollback invalidate with.
 */
export function cdnCacheTag(cacheControl: string, buildId: string | undefined): Record<string, string> {
  if (!buildId) return {};
  if (/\bimmutable\b/.test(cacheControl)) return {};
  const m = /max-age=(\d+)/.exec(cacheControl);
  return m && parseInt(m[1]!, 10) > 0 ? { "cache-tag": cdnTagForBuildId(buildId) } : {};
}
