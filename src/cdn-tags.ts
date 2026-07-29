// src/cdn-tags.ts
import { createHash } from "node:crypto";

/**
 * A Cloud-CDN-safe cache tag for a build id. Cloud CDN reads `--tags` comma-delimited and caps
 * each tag at 120 bytes (refusing to cache a response whose tags violate its limits); a
 * user-provided `next.config` `generateBuildId` is preserved by the adapter, so the raw id can
 * contain commas or be arbitrarily long. Hashing yields a deterministic, comma-free, 70-char tag
 * that is stable for the same id and distinct for different ids. NOT k8s name sanitization —
 * that is lossy and can collide two distinct ids onto one tag.
 *
 * M13 (2026-07-22 stale-apex incident): this derivation describes what the CURRENT adapter's
 * pool-server stamps. It says nothing about what an OUTGOING build's pods stamped — those were
 * built and deployed under whatever adapter version existed then, and some response classes
 * were cached with NO tag at all (a prerendered `/` marked only `x-nextjs-prerender`, passed
 * through with `s-maxage=31536000`, survived a correctly-computed tag invalidation for days).
 * Therefore the cutover/rollback invalidation must NEVER re-derive a tag for an outgoing
 * build with this function. It uses the tag RECORDED in deploy state when that build went out
 * (state.ts `cdnTags`), and with no recorded tag it falls back to a full `--path=/*` purge —
 * the only mechanism that reaches unknown-format or untagged entries. If you change this
 * derivation, recorded state keeps old builds invalidatable; do not add derivation guessing.
 */
export function cdnTagForBuildId(buildId: string): string {
  return `build-${createHash("sha256").update(buildId).digest("hex")}`;
}

/**
 * Shape of a tag as recorded in deploy state (M13). Used at the point of consumption
 * (cdn-invalidate.ts) before the recorded value reaches gcloud argv / Cloud CDN's
 * comma-delimited `--tags` — a corrupted state value must fall back to the full purge,
 * never be spliced into the command.
 */
export const RECORDED_CDN_TAG_PATTERN = /^build-[0-9a-f]{64}$/;

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
export function cdnCacheTag(
  cacheControl: string,
  buildId: string | undefined,
): Record<string, string> {
  if (!buildId) return {};
  if (/\bimmutable\b/.test(cacheControl)) return {};
  // Tag only what Cloud CDN can actually store: private/no-store/no-cache responses
  // never enter the shared cache, so a tag on them is dead weight and misleading in
  // header dumps. The CDN's freshness lifetime is s-maxage when present, else max-age.
  if (/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)) return {};
  const shared = /\bs-maxage=(\d+)/i.exec(cacheControl) ?? /\bmax-age=(\d+)/i.exec(cacheControl);
  return shared && parseInt(shared[1]!, 10) > 0 ? { "cache-tag": cdnTagForBuildId(buildId) } : {};
}
