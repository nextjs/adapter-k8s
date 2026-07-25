// Valkey-backed classic incremental `CacheHandler` — the store Next uses for prerendered pages:
// PPR shells (APP_PAGE), ISR pages (PAGES), and route/redirect responses. This is a SEPARATE
// interface from the V2 `use cache` handler (that one is registered via the global symbol and
// handles `use cache` entries); this one is registered via `next.config.cacheHandler` and handles
// the incremental page cache.
//
// Sharing this across replicas is what closes the two remaining cross-replica gaps:
//   - a `use cache` value baked into a STATIC PPR shell now revalidates cross-replica (the shell
//     entry + its tag invalidation live in Valkey, not each pod's local file-system cache);
//   - classic ISR (`export const revalidate`) revalidates cross-replica too — a free side effect.
//
// It reuses the SAME shared Valkey tag manifest as the V2 handler (same keyspace), so a single
// `revalidateTag` is honored consistently by both. Like the V2 handler, it owns its own staleness:
// `get` returns null when the entry's tags have been revalidated since it was stored (Next then
// regenerates), so the per-process `tags-manifest.external` check Next also runs is irrelevant here.
import type { ValkeyClient } from "./client.js";
import { logErrorRateLimited, maxCacheEntryBytes, wallClockNow, warnOnce } from "./stream-codec.js";
import {
  areTagsExpired,
  areTagsStale,
  computeTagUpdate,
  parseTagState,
  TAG_MANIFEST_TTL_SECONDS,
  UPDATE_TAGS_SCRIPT,
  warnOnClockSkewClamp,
  type TagState,
} from "./tag-manifest.js";

const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";
const RETENTION_MARGIN_SECONDS = 60;
// Retention for entries with no time-based lifetime (`revalidate: false` / static / PPR shells that
// never time-revalidate). Next's semantics are "cache until a tag revalidates it", so these must NOT
// fall to the ~61s numeric-revalidate floor (which would make them cold-miss every minute). Bounded
// (not infinite) so a failed blue/green teardown can't leak build-namespaced keys forever; a build
// living past this simply re-renders the entry once, then re-caches it. Exported: the V2 `use cache`
// handler caps its key TTL at the same bound (M7).
export const DURABLE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// Bounds for the tag list stored with an entry (L9). Next's own `cacheTag()` enforces the
// 256-char per-tag limit, but a route handler can set `x-next-cache-tags` manually with
// arbitrary content — drop over-limit tags rather than storing/looking-up unbounded lists.
const MAX_TAGS_PER_ENTRY = 128;
const MAX_TAG_LENGTH = 256;

/**
 * Bound a tag list for storage (L9): drop empty/over-long tags and cap the count, keeping the
 * first well-formed tags in declared order. Shared by both handlers (N5) — the V2 `use cache`
 * handler stored `entry.tags` uncapped, so a route emitting thousands of cache tags would push
 * an unbounded list into every entry's meta and every freshness HMGET.
 */
export function capTags(raw: readonly string[]): string[] {
  const tags: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG_LENGTH) continue;
    tags.push(tag);
    if (tags.length >= MAX_TAGS_PER_ENTRY) break;
  }
  return tags;
}

// Minimal structural mirror of Next's classic CacheHandler contract (avoids a compile-time
// dependency on Next internals). `value` is an `IncrementalCacheValue`; we serialize its binary
// members (Buffers, the segmentData Map) to base64 for JSON storage.
interface CacheHandlerValue {
  lastModified?: number;
  value: unknown | null;
}
interface GetCtx {
  kind?: string;
  softTags?: string[];
  tags?: string[];
}
interface SetCtx {
  tags?: string[];
  cacheControl?: { revalidate?: number | false; expire?: number };
  revalidate?: number | false;
}

interface StoredEntry {
  /** Serialized IncrementalCacheValue (binary members base64-encoded). */
  value: unknown;
  tags: string[];
  lastModified: number;
  /** Retention hint (seconds) for the Valkey key TTL; not the staleness source. */
  ttlSeconds: number;
}

/**
 * Parse and validate a stored incremental entry (L5). A corrupt entry — wrong JSON, non-finite
 * `lastModified`/`ttlSeconds`, a non-array tag list, or a missing `value` member (`null` is a
 * REAL cached value, but it must be present) — degrades to a miss so Next regenerates.
 */
function parseStoredEntry(raw: string): StoredEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const e = parsed as Record<string, unknown>;
  if (!Number.isFinite(e.lastModified)) return undefined;
  if (!Array.isArray(e.tags) || !e.tags.every((tag) => typeof tag === "string")) return undefined;
  if (typeof e.ttlSeconds !== "number" || !Number.isFinite(e.ttlSeconds) || e.ttlSeconds <= 0) {
    return undefined;
  }
  if (!("value" in e)) return undefined;
  return e as unknown as StoredEntry;
}

export interface ValkeyIncrementalCacheOptions {
  client: ValkeyClient;
  buildId: string;
  now?: () => number;
}

// ---- binary (de)serialization: Buffers ↔ base64, the segmentData Map ↔ an object ----

function encodeValue(value: Record<string, unknown> | null): unknown {
  if (!value || typeof value !== "object") return value;
  const kind = value.kind;
  const out: Record<string, unknown> = { ...value };
  if (Buffer.isBuffer(value.rscData)) out.rscData = { __b64: value.rscData.toString("base64") };
  if (Buffer.isBuffer(value.body)) out.body = { __b64: value.body.toString("base64") };
  // IMAGE entries (kind === "IMAGE", used when images.customCacheHandler is on) carry a raw Buffer.
  if (Buffer.isBuffer(value.buffer)) out.buffer = { __b64: value.buffer.toString("base64") };
  if (value.segmentData instanceof Map) {
    const seg: Record<string, string> = {};
    for (const [k, v] of value.segmentData as Map<string, Buffer>) seg[k] = v.toString("base64");
    out.segmentData = { __segmap: seg };
  }
  void kind;
  return out;
}

function decodeValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...v };
  const b64 = (x: unknown): Buffer | undefined =>
    x && typeof x === "object" && "__b64" in (x as object)
      ? Buffer.from((x as { __b64: string }).__b64, "base64")
      : undefined;
  const rsc = b64(v.rscData);
  if (rsc) out.rscData = rsc;
  const body = b64(v.body);
  if (body) out.body = body;
  const imgBuf = b64(v.buffer);
  if (imgBuf) out.buffer = imgBuf;
  if (
    v.segmentData &&
    typeof v.segmentData === "object" &&
    "__segmap" in (v.segmentData as object)
  ) {
    const seg = (v.segmentData as { __segmap: Record<string, string> }).__segmap;
    const map = new Map<string, Buffer>();
    for (const [k, s] of Object.entries(seg)) map.set(k, Buffer.from(s, "base64"));
    out.segmentData = map;
  }
  return out;
}

function extractTags(value: Record<string, unknown> | null, ctx: SetCtx): string[] {
  let raw: string[];
  if (ctx.tags && ctx.tags.length) {
    raw = ctx.tags;
  } else {
    const headers = value?.headers as Record<string, string | string[]> | undefined;
    const header = headers?.[NEXT_CACHE_TAGS_HEADER];
    if (typeof header === "string") {
      raw = header
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (Array.isArray(header)) {
      raw = header
        .flatMap((t) => t.split(","))
        .map((t) => t.trim())
        .filter(Boolean);
    } else {
      raw = [];
    }
  }
  // Cap count and per-tag length (L9): over-limit tags are dropped, keeping the first
  // well-formed ones in declared order.
  return capTags(raw);
}

/**
 * Valkey-backed classic incremental cache handler. Registered via `next.config.cacheHandler`.
 * All Valkey I/O is defensive — a cache outage degrades to a miss (Next regenerates), never a crash.
 */
export class ValkeyIncrementalCacheHandler {
  private readonly client: ValkeyClient;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly tagsKey: string;

  constructor(options: ValkeyIncrementalCacheOptions) {
    this.client = options.client;
    // N8: never Date.now — patched to throw inside tracked static renders (see wallClockNow).
    this.now = options.now ?? wallClockNow;
    // Same build-namespaced tag keyspace as the V2 handler, so `revalidateTag` is shared.
    this.prefix = `k8s:${options.buildId}:`;
    this.tagsKey = `${this.prefix}tags`;
  }

  private entryKey(cacheKey: string): string {
    return `${this.prefix}inc:${cacheKey}`;
  }

  async get(cacheKey: string, ctx: GetCtx = {}): Promise<CacheHandlerValue | null> {
    try {
      const raw = await this.client.get(this.entryKey(cacheKey));
      if (!raw) return null;
      const entry = parseStoredEntry(raw);
      if (!entry) return null; // corrupt entry → miss, Next regenerates (L5)
      const now = this.now();

      // Own the staleness check against the SHARED manifest (the tags-manifest.external check Next
      // also runs is per-process and irrelevant for a custom handler). Combine the entry's own
      // tags with any request soft tags.
      const softTags = ctx.softTags ?? ctx.tags ?? [];
      const tags = [...entry.tags, ...softTags];
      const manifest = await this.tagStates(tags);
      if (areTagsExpired(tags, entry.lastModified, manifest, now)) {
        this.client.del(this.entryKey(cacheKey)).catch(() => undefined);
        return null; // hard-revalidated → miss → Next regenerates + calls set
      }
      // A stale (SWR) tag makes Next revalidate in the background; signal via lastModified=-1,
      // matching file-system-cache's "trigger blocking/background validation" behavior.
      const staleByTag = areTagsStale(tags, entry.lastModified, manifest);
      return {
        lastModified: staleByTag ? -1 : entry.lastModified,
        value: decodeValue(entry.value),
      };
    } catch {
      return null;
    }
  }

  async set(
    cacheKey: string,
    data: Record<string, unknown> | null,
    ctx: SetCtx = {},
  ): Promise<void> {
    try {
      // `null` is a real cached value (Next stores it for not-found / 404 responses) — keep it as an
      // entry so the negative result is shared across replicas, don't delete.
      const tags = extractTags(data, ctx);
      // FETCH entries carry their revalidate on the value (SetIncrementalFetchCacheContext has no
      // `revalidate`); everything else carries it on ctx. Fall back to ctx for both.
      const dataRevalidate =
        data?.kind === "FETCH" && typeof (data as { revalidate?: unknown }).revalidate === "number"
          ? (data as { revalidate: number }).revalidate
          : undefined;
      const revalidate =
        typeof dataRevalidate === "number"
          ? dataRevalidate
          : typeof ctx.revalidate === "number"
            ? ctx.revalidate
            : typeof ctx.cacheControl?.revalidate === "number"
              ? ctx.cacheControl.revalidate
              : undefined;
      // A numeric revalidate or expire gives a time-based TTL; their ABSENCE (e.g. `revalidate:false`
      // → undefined here) means "never time-revalidate" → durable retention, not the 1s+margin floor.
      const hasNumericLifetime =
        typeof revalidate === "number" || typeof ctx.cacheControl?.expire === "number";
      const ttlSeconds = hasNumericLifetime
        ? Math.max(revalidate ?? 0, ctx.cacheControl?.expire ?? 0, 1) + RETENTION_MARGIN_SECONDS
        : DURABLE_TTL_SECONDS;
      // N6: a non-finite numeric lifetime (`revalidate: Infinity` / NaN — `typeof` says
      // "number" for both) would produce a non-finite SET EX argument, which Valkey rejects —
      // the write fails and the entry is silently never cached. Refuse to cache it instead,
      // mirroring the V2 handler's H4 guard.
      if (!Number.isFinite(ttlSeconds)) {
        warnOnce(
          "nonfinite-lifetime",
          "[valkey-cache] refusing to cache an incremental entry with a non-finite revalidate/expire; treating it as uncacheable",
        );
        return;
      }
      const entry: StoredEntry = {
        value: encodeValue(data),
        tags,
        lastModified: this.now(),
        ttlSeconds: Math.ceil(ttlSeconds),
      };
      const serialized = JSON.stringify(entry);
      // M6: skip (and log once) when the serialized entry exceeds the configured cap — an
      // oversized page/shell must not be pushed through the socket into Valkey unboundedly.
      if (Buffer.byteLength(serialized, "utf8") > maxCacheEntryBytes()) {
        warnOnce(
          "oversize-entry",
          `[valkey-cache] an incremental cache entry exceeded ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES; it was not cached (further occurrences logged once per process)`,
        );
        return;
      }
      await this.client.set(this.entryKey(cacheKey), serialized, "EX", entry.ttlSeconds);
    } catch {
      // Cache write failure must not break the response.
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean);
    if (list.length === 0) return;
    try {
      const now = this.now();
      const args: string[] = [];
      for (const tag of list)
        args.push(tag, JSON.stringify(computeTagUpdate(undefined, now, durations)));
      // The trailing argv refreshes the manifest key's own TTL on every write (M11), bounding
      // the per-build manifest's lifetime the same way entry keys are bounded.
      const clamped = await this.client.eval(
        UPDATE_TAGS_SCRIPT,
        1,
        this.tagsKey,
        ...args,
        String(TAG_MANIFEST_TTL_SECONDS),
      );
      warnOnClockSkewClamp(clamped);
    } catch (error) {
      // Best-effort; a missed manifest write means a revalidation is skipped, not a crash — but
      // it must be OBSERVABLE (M1). Rate-limited so a Valkey outage doesn't spam per-request logs.
      logErrorRateLimited(
        "revalidateTag",
        "[valkey-cache] revalidateTag failed to write the shared tag manifest; invalidation may be lost",
        error,
      );
    }
  }

  resetRequestCache(): void {
    // No per-request in-memory state to reset (every read hits the shared store live).
  }

  private async tagStates(tags: string[]): Promise<Map<string, TagState>> {
    const manifest = new Map<string, TagState>();
    if (tags.length === 0) return manifest;
    const values = await this.client.hmget(this.tagsKey, ...tags);
    tags.forEach((tag, i) => {
      const rawState = values[i];
      if (rawState) {
        // Corrupt fields degrade to "no state" (a corrupt `at` becomes 0); never throw (L5).
        const state = parseTagState(rawState);
        if (state) manifest.set(tag, state);
      }
    });
    return manifest;
  }
}
