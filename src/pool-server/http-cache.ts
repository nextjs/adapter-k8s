import { createHash } from "node:crypto";

export function staticAssetEtag(content: Buffer): string {
  // Strong content identity lets mutable static artifacts such as generated service workers use
  // `max-age=0, must-revalidate` without downloading an unchanged body on every update check.
  // Do not derive this from mtime: staged image layers can change timestamps without changing the
  // asset, while the bytes are the cache validator shared by every pool replica.
  return `"${createHash("sha1").update(content).digest("base64url")}"`;
}

export function ifNoneMatchMatches(value: string | undefined, etag: string): boolean {
  if (!value) return false;
  return value.split(",").some((candidate) => {
    const normalized = candidate.trim().replace(/^W\//, "");
    return normalized === "*" || normalized === etag;
  });
}

/**
 * S14 (AVAILABILITY). Per-path ETag memoization, keyed on identity that changes when the file
 * does (absolute path + size + mtimeMs).
 *
 * Every static/public serve used to `readFileSync` the whole file AND re-hash all of it with
 * SHA-1, on every request — including HEAD, and including the conditional requests these
 * responses invite: they are stamped `public, max-age=0, must-revalidate`, so Cloud CDN
 * revalidates with essentially every client request. A 50 MiB asset therefore cost a full
 * synchronous read plus a full hash per request on a 512 MiB pod, blocking the event loop for
 * the duration. Image content is immutable within a build, so the digest only has to be
 * computed once per file per process.
 *
 * Bounded so a large public/ directory cannot itself become the leak: entries are small
 * (a path plus a base64 digest) and the map is cleared wholesale when it exceeds the cap,
 * which costs one recompute per file rather than tracking LRU order.
 */
const MAX_MEMOIZED_ETAGS = 4096;
const etagCache = new Map<string, string>();

export function staticAssetEtagForFile(
  filePath: string,
  stat: { size: number; mtimeMs: number },
  readContent: () => Buffer,
): string {
  const key = `${filePath}:${stat.size}:${stat.mtimeMs}`;
  const cached = etagCache.get(key);
  if (cached !== undefined) return cached;
  const etag = staticAssetEtag(readContent());
  if (etagCache.size >= MAX_MEMOIZED_ETAGS) etagCache.clear();
  etagCache.set(key, etag);
  return etag;
}

/** Test seam — the cache is process-global, so a test that asserts recompute must reset it. */
export function __resetEtagCacheForTests(): void {
  etagCache.clear();
}
