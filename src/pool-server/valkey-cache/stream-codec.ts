import type { CacheEntry } from "./types.js";

// Beyond stream (de)serialization, this module hosts the small shared runtime helpers both
// cache handlers need: the entry-size cap and the throttled logging used by the fail-open
// paths. Kept dependency-free (no node imports) so it stays edge-eval-safe like its consumers.

/** Default maximum size of a single cached entry (16 MiB), env-overridable (M6). */
const DEFAULT_MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * The configured maximum entry size in bytes. Read from `ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES` at
 * call time (never at module eval, so importing stays edge-safe and tests can override it);
 * absent/invalid values fall back to the 16 MiB default. An oversized entry is skipped (a
 * miss + recompute) rather than buffered unboundedly into memory and Valkey.
 */
export function maxCacheEntryBytes(): number {
  const raw = process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_CACHE_ENTRY_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_CACHE_ENTRY_BYTES;
  return Math.floor(parsed);
}

const warnedKeys = new Set<string>();

/**
 * `console.warn` at most once per process per `key`. For persistent misconfigurations (e.g. a
 * non-finite cache lifetime from a caller) where per-request logging would spam.
 */
export function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

const RATE_LIMIT_MS = 60_000;
const lastErrorAt = new Map<string, number>();

/**
 * Wall-clock milliseconds WITHOUT `Date.now()` (N8). Under cacheComponents, Next patches
 * `Date.now` to THROW `DYNAMIC_SERVER_USAGE` when called synchronously inside a tracked
 * static render — and this cache stack runs inside renders, so every clock read here must
 * use the unpatched `performance` pair instead (same trick as Next's own default cache
 * handler, next/dist/server/lib/cache-handlers/default.js). Same epoch and semantics as
 * Date.now(); stored timestamps and tag-manifest comparisons are unaffected.
 */
export function wallClockNow(): number {
  return Math.round(performance.timeOrigin + performance.now());
}

/**
 * `console.error` at most once per 60s per failure class (M1). The handlers' invalidation and
 * freshness paths fail open by design — a missed revalidation must not crash a render — but a
 * Valkey outage there must still be OBSERVABLE without emitting one log line per request.
 */
export function logErrorRateLimited(failureClass: string, message: string, error: unknown): void {
  const now = wallClockNow();
  const last = lastErrorAt.get(failureClass);
  if (last !== undefined && now - last < RATE_LIMIT_MS) return;
  lastErrorAt.set(failureClass, now);
  console.error(message, error);
}

/**
 * Drain a cache entry's value stream to a Buffer for storage, WITHOUT consuming the copy
 * Next still needs for the in-flight response. Mirrors Next's own handlers (`default.js`,
 * `resume-data-cache/cache-store.js`): `tee` the stream, hand one branch back to the entry
 * (so the caller's read still works) and drain the other.
 *
 * Returns `null` if the stream errors or delivers partially — a partial entry must be
 * discarded (treated as a miss), never cached. Also returns `null` when the accumulated body
 * exceeds `maxBytes` (M6): an over-cap entry degrades to a miss exactly like a partial
 * stream, and aborting the drain early bounds memory instead of buffering an unbounded
 * stream first and rejecting it after.
 */
export async function drainEntryValue(
  entry: CacheEntry,
  maxBytes: number = maxCacheEntryBytes(),
): Promise<Buffer | null> {
  const [ours, theirs] = entry.value.tee();
  entry.value = theirs;
  try {
    const reader = ours.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          // Stop pulling immediately so an over-cap stream can't grow memory without bound.
          await reader.cancel().catch(() => undefined);
          warnOnce(
            "oversize-entry",
            `[valkey-cache] a cache entry exceeded ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES (${maxBytes} bytes); it was not cached (further occurrences logged once per process)`,
          );
          return null;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Reconstruct a fresh `ReadableStream` from stored bytes. Every `get` gets its own stream —
 * a stored buffer is never handed out as a shared/consumed stream.
 */
export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
