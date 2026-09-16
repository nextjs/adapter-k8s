import { AsyncLocalStorage } from "node:async_hooks";
import type { ValkeyClient } from "./client.js";
import { assertSafeBuildId, capTags, DURABLE_TTL_SECONDS } from "./incremental-cache-handler.js";
import { sampleValkeyClock } from "./valkey-clock.js";
import {
  bufferToStream,
  drainEntryValue,
  logErrorRateLimited,
  maxCacheEntryBytes,
  wallClockNow,
  warnOnce,
} from "./stream-codec.js";
import {
  computeTagUpdate,
  evaluateEntry,
  chunkManifestTags,
  filterManifestTags,
  maxExpiration,
  MAX_CLOCK_SKEW_MS,
  parseTagState,
  TAG_MANIFEST_EPOCH_FIELD,
  TAG_MANIFEST_TTL_SECONDS,
  UPDATE_TAGS_SCRIPT,
  warnOnClockSkewClamp,
  type TagManifest,
  type TagState,
  type Freshness,
} from "./tag-manifest.js";
import type { CacheEntry, CacheHandler, Timestamp } from "./types.js";

/** JSON metadata stored alongside the buffered value. */
interface StoredMeta {
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

interface StoredRead {
  meta: StoredMeta;
  localTimestamp: number;
  value: Buffer;
  freshness: Freshness;
}

interface LocalEntry {
  tags: string[];
  /** Implicit tags whose shared manifest state was checked before this backing entry was warmed. */
  verifiedSoftTags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
  value: Buffer;
}

const SERVER_TIMESTAMP_MARKER = "__adapter_k8s_valkey_time__";

/**
 * Store a V2 entry with its computation-start timestamp translated into Valkey's clock domain.
 * The translation must preserve the elapsed render time: stamping completion time would let an
 * invalidation that arrived during a long computation lose to the completed write.
 *
 * ARGV is `[meta, value, ttlSeconds, entryTimestamp, clientNow]`. Meta keeps the marker first so
 * the exact-prefix replacement cannot collide with application tags or future fields.
 */
export const STORE_USE_CACHE_ENTRY_SCRIPT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local payload = ARGV[1]
local marker = '{"timestamp":"${SERVER_TIMESTAMP_MARKER}"'
if string.sub(payload, 1, string.len(marker)) ~= marker then
  return redis.error_reply('use-cache entry timestamp marker missing')
end
local clientNow = tonumber(ARGV[5])
local entryTimestamp = tonumber(ARGV[4])
if not clientNow or not entryTimestamp then
  return redis.error_reply('use-cache entry timestamp arguments invalid')
end
local storedTimestamp = now + entryTimestamp - clientNow
local stamped = '{"timestamp":' .. storedTimestamp .. string.sub(payload, string.len(marker) + 1)
redis.call('HSET', KEYS[1], 'm', stamped, 'v', ARGV[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if math.abs(now - clientNow) > ${MAX_CLOCK_SKEW_MS} then return 1 end
return 0
`;

/** Extra seconds of Valkey key retention beyond the entry's own `expire` window. */
const RETENTION_MARGIN_SECONDS = 60;

/** Same default bound as Next's built-in `use cache` handler. This is a staging front, not a
 * second durable cache: Valkey remains the backing store and shared invalidation authority. */
const LOCAL_FRONT_MAX_BYTES = 50 * 1024 * 1024;
/** Metadata-heavy/empty entries still consume Map/object memory even when their body is tiny. */
const LOCAL_FRONT_MAX_ENTRIES = 10_000;
/** A cache-key burst must not turn a miss into an unbounded fan-out of Valkey commands. */
const LOCAL_FRONT_MAX_CONCURRENT_WARMS = 64;
/** Conservative fixed allowance for the Map slot, object, arrays, and Buffer wrapper. */
const LOCAL_ENTRY_OVERHEAD_BYTES = 256;

/**
 * Bound on how long `get` waits for an in-flight same-key `set` before proceeding as a miss
 * (L10). The interface contract wants `get` to wait for an in-flight `set`, but the gate only
 * releases when `set`'s `finally` runs — which awaits an unbounded entry-promise/stream drain.
 * A hung `set` would otherwise block every concurrent same-key `get` (and its render) forever.
 */
const PENDING_SET_WAIT_MS = 5_000;

const EMPTY_MANIFEST: TagManifest = new Map();

interface PreparedInvocation {
  epoch: string | undefined;
}

/** Closure returned by preflight and used to scope only the matching Next invocation. */
export type PreparedUseCacheRunner = <T>(callback: () => T) => T;

/**
 * Parse and validate the stored meta field (L5). A corrupt meta — wrong JSON, non-finite
 * lifetimes, a non-array tag list — degrades to a cache miss, never a synthesized entry.
 */
function parseStoredMeta(raw: string): StoredMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const m = parsed as Record<string, unknown>;
  if (
    !Number.isFinite(m.timestamp) ||
    !Number.isFinite(m.expire) ||
    !Number.isFinite(m.revalidate) ||
    !Number.isFinite(m.stale)
  ) {
    return undefined;
  }
  if (!Array.isArray(m.tags) || !m.tags.every((tag) => typeof tag === "string")) return undefined;
  return m as unknown as StoredMeta;
}

export interface ValkeyCacheHandlerOptions {
  client: ValkeyClient;
  /** Namespaces all keys so blue-green builds never share cache. */
  buildId: string;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  /** How long `get` waits for an in-flight same-key `set` before proceeding as a miss (L10).
   * Defaults to PENDING_SET_WAIT_MS; injectable for tests. */
  pendingSetWaitMs?: number;
}

/**
 * Valkey-backed implementation of Next 16.3's `use cache` V2 `CacheHandler`.
 *
 * Behaviourally identical to Next's production default handler (`default.js`) — time-based
 * revalidation is a synchronous miss, while a profiled tag invalidation can return a stale entry
 * for background revalidation — except the entry store and tag manifest live in Valkey, shared
 * across every pool replica. That sharing is the whole point: `updateTags` on one replica
 * invalidates `get` on all the others, which a per-process manifest cannot do.
 *
 * All Valkey I/O is defensive: a connection failure degrades to a cache miss / no-op so a
 * cache outage never breaks rendering.
 */
export class ValkeyCacheHandler implements CacheHandler {
  private readonly client: ValkeyClient;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly tagsKey: string;
  private readonly pendingSetWaitMs: number;
  /** In-process gate so a concurrent `get` waits for an in-flight `set` (interface contract). */
  private readonly pendingSets = new Map<string, Promise<void>>();
  /** Cache Components decides whether work belongs to the static or runtime stage at an async-I/O
   * boundary. A Valkey round trip inside `get` therefore changes rendered output even on a HIT.
   * The bounded local front keeps reads microtask-fast after the pool has refreshed the shared tag
   * manifest outside Next's render. A cold front deliberately reports a miss and warms in the
   * background; recomputing once is correct, while moving static content into the runtime stage is
   * not (cached-navigation fallback params then leak across client segment-cache entries). */
  private readonly localEntries = new Map<string, LocalEntry>();
  private localBytes = 0;
  private manifestEpoch: string | undefined;
  private backingAvailable = true;
  private readonly warming = new Set<string>();
  private writeGeneration = 0;
  private readonly preparedInvocations = new AsyncLocalStorage<PreparedInvocation>();

  constructor(options: ValkeyCacheHandlerOptions) {
    this.client = options.client;
    // N8: never Date.now — patched to throw inside tracked static renders (see wallClockNow).
    this.now = options.now ?? wallClockNow;
    // N82: validate at the point of consumption — this is where the build id becomes keyspace.
    assertSafeBuildId(options.buildId);
    this.prefix = `k8s:${options.buildId}:`;
    this.tagsKey = `${this.prefix}tags`;
    this.pendingSetWaitMs = options.pendingSetWaitMs ?? PENDING_SET_WAIT_MS;
  }

  private entryKey(cacheKey: string): string {
    return `${this.prefix}entry:${cacheKey}`;
  }

  private clearLocalEntries(): void {
    this.localEntries.clear();
    this.localBytes = 0;
  }

  private localEntrySize(cacheKey: string, entry: LocalEntry): number {
    let size = LOCAL_ENTRY_OVERHEAD_BYTES + Buffer.byteLength(cacheKey) + entry.value.byteLength;
    for (const tag of entry.tags) size += Buffer.byteLength(tag) + 8;
    for (const tag of entry.verifiedSoftTags) size += Buffer.byteLength(tag) + 8;
    return size;
  }

  private removeLocalEntry(cacheKey: string): void {
    const current = this.localEntries.get(cacheKey);
    if (!current) return;
    this.localEntries.delete(cacheKey);
    this.localBytes -= this.localEntrySize(cacheKey, current);
  }

  private putLocalEntry(cacheKey: string, entry: LocalEntry): void {
    const current = this.localEntries.get(cacheKey);
    if (current && current.timestamp > entry.timestamp) return;
    this.removeLocalEntry(cacheKey);
    const entrySize = this.localEntrySize(cacheKey, entry);
    if (entrySize > LOCAL_FRONT_MAX_BYTES) return;
    this.localEntries.set(cacheKey, entry);
    this.localBytes += entrySize;
    while (
      this.localBytes > LOCAL_FRONT_MAX_BYTES ||
      this.localEntries.size > LOCAL_FRONT_MAX_ENTRIES
    ) {
      const oldest = this.localEntries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.removeLocalEntry(oldest);
    }
  }

  private readLocalEntry(cacheKey: string, softTags: string[]): CacheEntry | undefined {
    const entry = this.localEntries.get(cacheKey);
    if (!entry) return undefined;
    // A cache key can be reused with different implicit path tags. Never transfer one backing
    // read's tag verdict to another set: the new combination takes one safe miss and warms itself.
    if (softTags.some((tag) => !entry.verifiedSoftTags.includes(tag))) return undefined;
    // Tag freshness was checked when the entry was produced/warmed, and any later tag update
    // changes the global epoch and clears the whole front before this callback runs. Only the
    // entry's time lifetime remains to evaluate here.
    const freshness = evaluateEntry({ ...entry, tags: [] }, EMPTY_MANIFEST, this.now());
    if (freshness.state === "expired") {
      this.removeLocalEntry(cacheKey);
      return undefined;
    }
    // Map insertion order is the eviction order; refresh it on every hit.
    this.localEntries.delete(cacheKey);
    this.localEntries.set(cacheKey, entry);
    return {
      value: bufferToStream(entry.value),
      tags: entry.tags,
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: freshness.state === "fresh" ? freshness.revalidate : -1,
    };
  }

  private warmLocalEntry(cacheKey: string, softTags: string[]): void {
    const invocation = this.preparedInvocations.getStore();
    if (
      !invocation ||
      invocation.epoch !== this.manifestEpoch ||
      !this.backingAvailable ||
      this.pendingSets.has(cacheKey) ||
      this.warming.has(cacheKey) ||
      this.warming.size >= LOCAL_FRONT_MAX_CONCURRENT_WARMS
    ) {
      return;
    }
    const epoch = invocation.epoch;
    const writeGeneration = this.writeGeneration;
    this.warming.add(cacheKey);
    void this.readStored(cacheKey, softTags)
      .then((read) => {
        // A stale backing entry is useful to unprepared callers for SWR, but the staged front must
        // not turn it fresh by dropping the per-tag manifest. The current request is already a
        // miss and will regenerate it.
        if (
          !read ||
          read.freshness.state !== "fresh" ||
          this.manifestEpoch !== epoch ||
          this.writeGeneration !== writeGeneration
        ) {
          return;
        }
        this.putLocalEntry(cacheKey, {
          tags: read.meta.tags,
          verifiedSoftTags: capTags(softTags),
          stale: read.meta.stale,
          timestamp: read.localTimestamp,
          expire: read.meta.expire,
          revalidate: read.freshness.revalidate,
          value: read.value,
        });
      })
      .catch((error) => {
        logErrorRateLimited(
          "use-cache-warm",
          "[valkey-cache] `use cache` background warm failed; the current request already recomputed the entry",
          error,
        );
      })
      .finally(() => {
        this.warming.delete(cacheKey);
      });
  }

  /**
   * Refresh the shared tag manifest before entering Next's render boundary.
   *
   * Next invokes `CacheHandler.get()` while deciding staged-render ownership. Even a successful
   * network-backed read resolves too late and turns a static Cache Component into runtime data.
   * The pool awaits this method before any cache-dependent fast path. It reads only the manifest's
   * fixed-size epoch; `get` can then make the current request's decision from local state without
   * I/O. Any tag update evicts the whole bounded front. The subsequent backing warm checks only
   * the requested entry's explicit and implicit tags before admitting it to that front.
   */
  async prepareForInvocation(): Promise<PreparedUseCacheRunner> {
    let preparedEpoch: string | undefined;
    try {
      const [rawEpoch] = await this.client.hmget(this.tagsKey, TAG_MANIFEST_EPOCH_FIELD);
      const epoch = rawEpoch ?? "0";
      if (!/^(?:0|[1-9]\d*)$/.test(epoch)) {
        throw new Error("invalid Valkey tag-manifest epoch");
      }
      if (this.manifestEpoch !== undefined && epoch !== this.manifestEpoch) {
        this.clearLocalEntries();
      }
      this.manifestEpoch = epoch;
      preparedEpoch = epoch;
      this.backingAvailable = true;
    } catch (error) {
      // Fail stale, not fresh: if the invalidation authority cannot be read, discard every local
      // value and let this request recompute. The render still stays staged correctly because its
      // subsequent `get` is an immediate local miss.
      this.clearLocalEntries();
      this.manifestEpoch = undefined;
      this.backingAvailable = false;
      logErrorRateLimited(
        "use-cache-prepare",
        "[valkey-cache] shared tag refresh failed before handler invocation; discarding local `use cache` entries",
        error,
      );
    }
    const invocation: PreparedInvocation = { epoch: preparedEpoch };
    return <T>(callback: () => T): T => this.preparedInvocations.run(invocation, callback);
  }

  private async readStored(
    cacheKey: string,
    softTags: string[] = [],
  ): Promise<StoredRead | undefined> {
    const key = this.entryKey(cacheKey);
    const data = await this.client.hgetallBuffer(key);
    const metaBuf = data?.m;
    if (!metaBuf) return undefined;
    const value = data.v;
    if (!value) return undefined;
    const meta = parseStoredMeta(metaBuf.toString("utf8"));
    if (!meta) return undefined;
    const tags = [...meta.tags, ...softTags];
    const manifest = await this.tagStates(tags);
    const clock = await sampleValkeyClock(this.client, this.now);
    const freshness = evaluateEntry({ ...meta, tags }, manifest, clock.serverNow);
    if (freshness.state === "expired") {
      // Keep the expired value until its bounded TTL or a writer replaces it. A blind DEL here
      // can land after a concurrent HSET and remove the fresh replacement.
      return undefined;
    }
    return {
      meta,
      localTimestamp: clock.toLocal(meta.timestamp),
      value,
      freshness,
    };
  }

  private cacheEntry(read: StoredRead): CacheEntry {
    return {
      value: bufferToStream(read.value),
      tags: read.meta.tags,
      stale: read.meta.stale,
      timestamp: read.localTimestamp,
      expire: read.meta.expire,
      revalidate: read.freshness.state === "fresh" ? read.freshness.revalidate : -1,
    };
  }

  async get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined> {
    const invocation = this.preparedInvocations.getStore();
    if (invocation) {
      if (invocation.epoch !== this.manifestEpoch) return undefined;
      const local = this.readLocalEntry(cacheKey, softTags);
      if (local) return local;
      // Do not await the backing store here. Cache Components observes that I/O boundary and
      // moves an otherwise-static component into the runtime stage. The current request safely
      // recomputes; the read warms a later request (and a concurrent `set` wins by timestamp).
      this.warmLocalEntry(cacheKey, softTags);
      return undefined;
    }

    // Contract: if a `set` for this key is in flight on this replica, wait for it — but only
    // up to a bound (L10): a hung `set` must not block this render forever; the read simply
    // proceeds and misses, and Next regenerates.
    const pending = this.pendingSets.get(cacheKey);
    if (pending) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.pendingSetWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }

    try {
      const read = await this.readStored(cacheKey, softTags);
      if (!read) return undefined;
      return this.cacheEntry(read);
    } catch (error) {
      // N81: fail open to a miss — but SAY SO. This catch was bare, so a PERMANENT read failure
      // (NOAUTH, WRONGTYPE, a cluster -MOVED, an exhausted breaker, an invalid URL) produced ZERO
      // log lines while every `use cache` entry was recomputed on every request, forever. Measured
      // before the fix: four handler operations against a dead Valkey emitted 0 log lines.
      logErrorRateLimited(
        "use-cache-get",
        "[valkey-cache] `use cache` read failed; treating it as a miss (the pool is rendering uncached)",
        error,
      );
      return undefined;
    }
  }

  async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    // A writer supersedes any local value and every in-flight backing warm. One coarse generation
    // keeps that race bounded without retaining a per-key version map for attacker-chosen keys.
    this.writeGeneration++;
    this.removeLocalEntry(cacheKey);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingSets.set(cacheKey, gate);
    const key = this.entryKey(cacheKey);
    try {
      const entry = await pendingEntry;
      // H4: a NON-FINITE lifetime would produce a NaN/Infinity EXPIRE argument, which Valkey
      // rejects — while the HSET in the same transaction still applies, leaving the entry cached
      // FOREVER. Refuse those: an uncacheable entry is a miss + recompute.
      if (!Number.isFinite(entry.expire) || !Number.isFinite(entry.revalidate)) {
        warnOnce(
          "nonfinite-lifetime-v2",
          "[valkey-cache] refusing to cache a `use cache` entry with a non-finite expire/revalidate; treating it as uncacheable",
        );
        return;
      }
      // N84: `revalidate <= 0` is STORABLE. This guard used to reject it, which broke nested
      // caches in exactly the situation the cache exists for: `get` above returns
      // `revalidate: -1` for a stale entry (matching Next's default handler), the `use cache`
      // wrapper propagates the MINIMUM revalidate of every inner entry into the enclosing store
      // (`use-cache-wrapper.ts` `propagateCacheLifeAndTagsToRevalidateStore`), and this handler
      // then refused to store the OUTER entry — so nested caches stopped caching for as long as
      // any inner entry was stale. It also meant a `cacheLife({ revalidate: 0 })` entry was never
      // cached at all. Measured before the fix: `stored entry with revalidate=-1? false`,
      // `revalidate=0? false`. Next's own default handler stores both and skips only
      // `expire === 0`; `expire < 0` is its eviction sentinel, so both are non-entries here.
      // The TTL arithmetic below already floors at 1s, so a non-positive revalidate cannot reach
      // EXPIRE. The old message also said "non-finite" about a perfectly finite `-1`.
      if (entry.expire <= 0) return;
      const buf = await drainEntryValue(entry, maxCacheEntryBytes());
      if (buf === null) return; // partial/errored/over-cap stream → miss, don't cache
      const meta = {
        timestamp: SERVER_TIMESTAMP_MARKER,
        // N5: cap the stored tag list like the incremental handler does — `entry.tags` was
        // stored verbatim, so an over-limit list bloated every entry meta and freshness HMGET.
        tags: capTags(entry.tags),
        stale: entry.stale,
        expire: entry.expire,
        revalidate: entry.revalidate,
      } satisfies Omit<StoredMeta, "timestamp"> & { timestamp: string };
      // M7: Next hands INFINITE_CACHE-scale expires (~136 years) to this handler; cap the key
      // TTL at the same durable bound the incremental handler uses. A cold key is just a miss +
      // recompute — freshness logic is TTL-independent.
      const ttl = Math.min(
        Math.max(entry.expire, entry.revalidate, 1) + RETENTION_MARGIN_SECONDS,
        DURABLE_TTL_SECONDS,
      );
      const clientNow = this.now();
      const clamped = await this.client.eval(
        STORE_USE_CACHE_ENTRY_SCRIPT,
        1,
        key,
        JSON.stringify(meta),
        buf,
        String(Math.ceil(ttl)),
        String(entry.timestamp),
        String(clientNow),
      );
      warnOnClockSkewClamp(clamped);
    } catch (error) {
      // The store script is atomic. A transport failure can be ambiguous after commit, so never
      // issue a cleanup DEL that could race a later writer and remove its successful value.
      // N81: and it must be observable (see the matching comment in `get`). A rejected entry
      // promise (a failed render) lands here too, which is why this is rate-limited rather than
      // per-occurrence.
      logErrorRateLimited(
        "use-cache-set",
        "[valkey-cache] `use cache` write failed; the entry was not cached (the pool will recompute it)",
        error,
      );
    } finally {
      // Only clear the gate if it's still ours — an overlapping `set` may have replaced it, and
      // deleting a newer set's gate would let a concurrent `get` skip the required wait.
      if (this.pendingSets.get(cacheKey) === gate) this.pendingSets.delete(cacheKey);
      release();
    }
  }

  async refreshTags(): Promise<void> {
    // Next calls this inside the render lifecycle, where Valkey I/O would change staged-render
    // ownership. The pool performs the real refresh in `prepareForInvocation` before it enters
    // Next. Direct consumers that do not use that preflight still read the manifest live in
    // `get`/`getExpiration`, preserving the original fail-safe behavior.
  }

  async getExpiration(tags: string[]): Promise<Timestamp> {
    // Next defines Infinity as "this handler already checked the implicit tags passed to get".
    // That keeps the staged callback synchronous without weakening invalidation: a local entry is
    // admitted only after those exact soft tags were checked, and every update bumps the epoch.
    if (this.preparedInvocations.getStore()) return Number.POSITIVE_INFINITY;
    try {
      const manifest = await this.tagStates(tags);
      const expiration = maxExpiration(tags, manifest);
      if (expiration === 0) return 0;
      const clock = await sampleValkeyClock(this.client, this.now);
      return clock.toLocal(expiration);
    } catch (error) {
      // Fail stale, not fresh: Next compares this local-domain value with locally returned entry
      // timestamps. A manifest/clock outage therefore regenerates instead of serving invalid data.
      logErrorRateLimited(
        "getExpiration",
        "[valkey-cache] getExpiration failed to read the shared clock/tag manifest; treating entries as stale",
        error,
      );
      return this.now();
    }
  }

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    // N83: same filter the classic handler and `capTags` use — an empty-string tag must not become
    // a real manifest field, and the EVAL argv must be bounded.
    const filtered = filterManifestTags(tags);
    if (filtered.length === 0) return;
    // The cache-handler interface does not expose which implicit soft tags belong to a stored
    // entry. Evicting the bounded front is the only sound immediate local invalidation; peers do
    // the same on their next pre-invocation manifest refresh.
    this.clearLocalEntries();
    this.manifestEpoch = undefined;
    try {
      const now = this.now();
      // Apply each tag's new state atomically with LAST-EVENT-WINS semantics: the server-side
      // script only applies a field when the incoming event (stamped with the server's clock)
      // is >= the stored one, and merges it PER DIMENSION into the stored state (M12). This
      // eliminates the read-modify-write race where two replicas revalidating the same tag
      // interleave (Redis runs the whole script atomically), and keeps a profiled update from
      // erasing a stored hard-expire watermark — the merge Next's in-memory handler gets for
      // free from being single-process. Passing `undefined` as the base lets the script own
      // the merge; the event carries only the watermarks this call SETS.
      // Chunked, not truncated: every tag the caller passed gets invalidated, in as many
      // EVALs as the per-call argv bound requires.
      for (const chunk of chunkManifestTags(filtered)) {
        const args: string[] = [];
        for (const tag of chunk) {
          args.push(tag, JSON.stringify(computeTagUpdate(undefined, now, durations)));
        }
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
      }
    } catch (error) {
      // Best-effort: a failed manifest write means a revalidation is missed, not a crash — but
      // it must be OBSERVABLE (M1): a Valkey outage here otherwise silently serves stale entries
      // indefinitely. Rate-limited so the outage doesn't emit one log line per request.
      logErrorRateLimited(
        "updateTags",
        "[valkey-cache] updateTags failed to write the shared tag manifest; invalidation may be lost",
        error,
      );
    }
  }

  /**
   * Whether any requested tag has shared invalidation state. This is called by the dispatcher's
   * build-seed/PPR-shell gate before Next starts rendering, so a bounded per-request HMGET is safe.
   * A read failure withholds the build artifact rather than serving a potentially stale shell.
   */
  async hasTagUpdates(tags: string[]): Promise<boolean> {
    try {
      const filtered = filterManifestTags(tags);
      if (filtered.length === 0) return false;
      const manifest = await this.tagStates(filtered);
      return manifest.size > 0;
    } catch (error) {
      logErrorRateLimited(
        "use-cache-shell-tags",
        "[valkey-cache] failed to check build artifact tags; treating the seed or shell as stale",
        error,
      );
      return true;
    }
  }

  /**
   * Tag states for an unprepared consumer, read live from the shared Valkey manifest.
   * Production requests instead refresh the full manifest in `prepareForInvocation`, before
   * entering Next's staged render, so their cache-handler callbacks never perform network I/O.
   */
  private async tagStates(tags: string[]): Promise<TagManifest> {
    if (tags.length === 0) return EMPTY_MANIFEST;
    const values = await this.client.hmget(this.tagsKey, ...tags);
    const manifest = new Map<string, TagState>();
    tags.forEach((tag, i) => {
      const raw = values[i];
      if (raw) {
        // Corrupt fields degrade to "no state" (a corrupt `at` becomes 0); never throw (L5).
        const state = parseTagState(raw);
        if (state) manifest.set(tag, state);
      }
    });
    return manifest;
  }
}
