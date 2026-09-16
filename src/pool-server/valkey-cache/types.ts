// Structural mirror of Next 16.3's `use cache` handler interface
// (next/dist/server/lib/cache-handlers/types.d.ts). Defined locally so the adapter's
// pool-server bundle doesn't take a compile-time dependency on Next internals.

export type Timestamp = number;

export interface CacheEntry {
  /** May error / deliver partially — a handler must decide whether to keep it. */
  value: ReadableStream<Uint8Array>;
  /** Explicit tags on the entry (from `cacheTag()`), excluding soft/implicit tags. */
  tags: string[];
  /** Client-facing stale duration (seconds); not used for entry expiration. */
  stale: number;
  /** When the entry was created (ms since epoch). */
  timestamp: Timestamp;
  /** How long the entry may be used (seconds); longer than `revalidate`. */
  expire: number;
  /** How long until the entry should be revalidated (seconds). */
  revalidate: number;
}

export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<Timestamp>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
