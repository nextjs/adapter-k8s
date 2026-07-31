import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * Above this size static bodies are streamed instead of buffered. Below it the buffered path
 * stays one syscall and avoids stream setup for the small files that dominate a build.
 */
export const STATIC_STREAM_THRESHOLD_BYTES = 512 * 1024;

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
 * (a path plus a base64 digest) and insertion order is maintained as an LRU.
 */
const MAX_MEMOIZED_ETAGS = 4096;
const etagCache = new Map<string, string>();
const pendingEtagCache = new Map<string, Promise<string>>();
const MAX_CONCURRENT_ETAG_HASHES = 4;
const MAX_PENDING_ETAG_HASHES = 64;
let activeEtagHashes = 0;
const etagHashQueue: Array<() => void> = [];

function etagCacheKey(filePath: string, stat: { size: number; mtimeMs: number }): string {
  return `${filePath}:${stat.size}:${stat.mtimeMs}`;
}

function rememberEtag(key: string, etag: string): void {
  etagCache.delete(key);
  while (etagCache.size >= MAX_MEMOIZED_ETAGS) {
    const oldest = etagCache.keys().next().value;
    if (oldest === undefined) break;
    etagCache.delete(oldest);
  }
  etagCache.set(key, etag);
}

function cachedEtag(key: string): string | undefined {
  const cached = etagCache.get(key);
  if (cached === undefined) return undefined;
  // Map iteration order is the LRU order. Touch on every hit.
  etagCache.delete(key);
  etagCache.set(key, cached);
  return cached;
}

export function staticAssetEtagForFile(
  filePath: string,
  stat: { size: number; mtimeMs: number },
  readContent: () => Buffer,
): string {
  const key = etagCacheKey(filePath, stat);
  const cached = cachedEtag(key);
  if (cached !== undefined) return cached;
  const etag = staticAssetEtag(readContent());
  rememberEtag(key, etag);
  return etag;
}

function pumpEtagHashQueue(): void {
  while (activeEtagHashes < MAX_CONCURRENT_ETAG_HASHES && etagHashQueue.length > 0) {
    etagHashQueue.shift()!();
  }
}

function hashFileWithAdmission(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const start = (): void => {
      activeEtagHashes++;
      const hash = createHash("sha1");
      let settled = false;
      const settle = (error: Error | null, etag?: string): void => {
        if (settled) return;
        settled = true;
        activeEtagHashes--;
        pumpEtagHashQueue();
        if (error) reject(error);
        else resolve(etag!);
      };
      try {
        const stream = createReadStream(filePath);
        stream.on("data", (chunk: Buffer) => hash.update(chunk));
        stream.once("error", (error) => settle(error));
        stream.once("end", () => settle(null, `"${hash.digest("base64url")}"`));
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
      }
    };

    if (activeEtagHashes < MAX_CONCURRENT_ETAG_HASHES) start();
    else etagHashQueue.push(start);
  });
}

/**
 * The manifest dispatch path needs the same strong, per-file ETag without first allocating the
 * whole asset or synchronously hashing it on the event loop. Hash one bounded stream, share that
 * work across concurrent first requests, then reuse the digest for the process lifetime. Distinct
 * cold assets are bounded too: at most four descriptors/hash streams run and at most 64 unique
 * hashes may be active or queued. Beyond that, return null so dispatch can safely serve without
 * a validator instead of turning an asset fan-out into descriptor/memory exhaustion.
 */
export async function staticAssetEtagForFileAsync(
  filePath: string,
  stat: { size: number; mtimeMs: number },
): Promise<string | null> {
  const key = etagCacheKey(filePath, stat);
  const cached = cachedEtag(key);
  if (cached !== undefined) return cached;
  const pending = pendingEtagCache.get(key);
  if (pending) return pending;
  if (pendingEtagCache.size >= MAX_PENDING_ETAG_HASHES) return null;

  const computation = hashFileWithAdmission(filePath);
  pendingEtagCache.set(key, computation);
  try {
    const etag = await computation;
    rememberEtag(key, etag);
    return etag;
  } finally {
    if (pendingEtagCache.get(key) === computation) pendingEtagCache.delete(key);
  }
}

/** Test seam — the cache is process-global, so a test that asserts recompute must reset it. */
export function __resetEtagCacheForTests(): void {
  if (activeEtagHashes !== 0 || etagHashQueue.length !== 0 || pendingEtagCache.size !== 0) {
    throw new Error("cannot reset ETag caches while hashes are active or queued");
  }
  etagCache.clear();
}

export function __etagHashStatsForTests(): {
  active: number;
  queued: number;
  pending: number;
  maxActive: number;
  maxPending: number;
} {
  return {
    active: activeEtagHashes,
    queued: etagHashQueue.length,
    pending: pendingEtagCache.size,
    maxActive: MAX_CONCURRENT_ETAG_HASHES,
    maxPending: MAX_PENDING_ETAG_HASHES,
  };
}
