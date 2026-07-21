import type { ValkeyClient } from "./client.js";
import { DURABLE_TTL_SECONDS } from "./incremental-cache-handler.js";
import { RespError } from "./resp-client.js";
import {
  bufferToStream,
  drainEntryValue,
  logErrorRateLimited,
  maxCacheEntryBytes,
  warnOnce,
} from "./stream-codec.js";
import {
  computeTagUpdate,
  evaluateEntry,
  maxExpiration,
  parseTagState,
  UPDATE_TAGS_SCRIPT,
  type TagManifest,
  type TagState,
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

/** Extra seconds of Valkey key retention beyond the entry's own `expire` window. */
const RETENTION_MARGIN_SECONDS = 60;

const EMPTY_MANIFEST: TagManifest = new Map();

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
}

/**
 * Valkey-backed implementation of Next 16.2's `use cache` V2 `CacheHandler`.
 *
 * Behaviourally identical to Next's in-process default handler (`default.js`) — same tag
 * predicates, same stale/expire semantics — except the entry store AND the tag manifest live
 * in Valkey, shared across every pool replica. That sharing is the whole point: `updateTags`
 * on one replica invalidates `get` on all the others, which a per-process manifest (and
 * therefore Bun's no-op `refreshTags`) can never do.
 *
 * All Valkey I/O is defensive: a connection failure degrades to a cache miss / no-op so a
 * cache outage never breaks rendering.
 */
export class ValkeyCacheHandler implements CacheHandler {
  private readonly client: ValkeyClient;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly tagsKey: string;
  /** In-process gate so a concurrent `get` waits for an in-flight `set` (interface contract). */
  private readonly pendingSets = new Map<string, Promise<void>>();

  constructor(options: ValkeyCacheHandlerOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.prefix = `k8s:${options.buildId}:`;
    this.tagsKey = `${this.prefix}tags`;
  }

  private entryKey(cacheKey: string): string {
    return `${this.prefix}entry:${cacheKey}`;
  }

  async get(cacheKey: string, _softTags: string[]): Promise<CacheEntry | undefined> {
    // Contract: if a `set` for this key is in flight on this replica, wait for it.
    const pending = this.pendingSets.get(cacheKey);
    if (pending) await pending;

    try {
      const key = this.entryKey(cacheKey);
      const data = await this.client.hgetallBuffer(key);
      const metaBuf = data?.m;
      if (!metaBuf) return undefined;
      // A meta field without its value field is a corrupt/partially-written entry — treat it as
      // a miss (L5). The old code synthesized an EMPTY body and served it as a valid fresh entry.
      const valueBuf = data.v;
      if (!valueBuf) return undefined;
      const meta = parseStoredMeta(metaBuf.toString("utf8"));
      if (!meta) return undefined; // corrupt meta → miss, never a fabricated entry (L5)

      const now = this.now();
      const manifest = await this.tagStates(meta.tags);
      const freshness = evaluateEntry(meta, manifest, now);
      if (freshness.state === "expired") {
        this.client.del(key).catch(() => undefined);
        return undefined;
      }
      const revalidate = freshness.state === "stale" ? -1 : freshness.revalidate;
      return {
        value: bufferToStream(valueBuf),
        tags: meta.tags,
        stale: meta.stale,
        timestamp: meta.timestamp,
        expire: meta.expire,
        revalidate,
      };
    } catch {
      return undefined;
    }
  }

  async set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pendingSets.set(cacheKey, gate);
    const key = this.entryKey(cacheKey);
    // Tracks whether the MULTI/EXEC was dispatched: only then can a partially-applied write
    // exist, and only then is the cleanup DEL warranted (a rejected entry promise must not
    // delete a still-valid previously cached entry).
    let writeAttempted = false;
    try {
      const entry = await pendingEntry;
      // H4: a non-finite or non-positive lifetime would produce a NaN/Infinity EXPIRE argument,
      // which Valkey rejects — while the HSET in the same transaction still applies, leaving the
      // entry cached FOREVER. Refuse to cache it: an uncacheable entry is a miss + recompute.
      if (
        !Number.isFinite(entry.expire) ||
        !Number.isFinite(entry.revalidate) ||
        entry.expire <= 0 ||
        entry.revalidate <= 0
      ) {
        warnOnce(
          "nonfinite-lifetime",
          "[valkey-cache] refusing to cache a `use cache` entry with a non-finite or non-positive expire/revalidate; treating it as uncacheable",
        );
        return;
      }
      const buf = await drainEntryValue(entry, maxCacheEntryBytes());
      if (buf === null) return; // partial/errored/over-cap stream → miss, don't cache
      const meta: StoredMeta = {
        tags: entry.tags,
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      };
      // M7: Next hands INFINITE_CACHE-scale expires (~136 years) to this handler; cap the key
      // TTL at the same durable bound the incremental handler uses. A cold key is just a miss +
      // recompute — freshness logic is TTL-independent.
      const ttl = Math.min(
        Math.max(entry.expire, entry.revalidate, 1) + RETENTION_MARGIN_SECONDS,
        DURABLE_TTL_SECONDS,
      );
      writeAttempted = true;
      const results = await this.client
        .multi()
        .hset(key, "m", JSON.stringify(meta), "v", buf)
        .expire(key, Math.ceil(ttl))
        .exec();
      // H4: MULTI/EXEC is NOT all-or-nothing — a rejected command leaves the others applied
      // (e.g. HSET succeeds, EXPIRE fails → a TTL-less key cached forever). The EXEC reply
      // carries per-command errors as elements; inspect them and treat any failure as a failed
      // write instead of assuming success.
      const failure = results.find((result): result is RespError => result instanceof RespError);
      if (failure) throw failure;
    } catch {
      // A cache write failure must not break the response. If the write may have partially
      // applied, best-effort DEL the key so a TTL-less partial entry can't live forever (the DEL
      // itself may fail during an outage — bounded by the build-namespaced keyspace's lifetime).
      if (writeAttempted) this.client.del(key).catch(() => undefined);
    } finally {
      // Only clear the gate if it's still ours — an overlapping `set` may have replaced it, and
      // deleting a newer set's gate would let a concurrent `get` skip the required wait.
      if (this.pendingSets.get(cacheKey) === gate) this.pendingSets.delete(cacheKey);
      release();
    }
  }

  async refreshTags(): Promise<void> {
    // No-op: we read the shared tag manifest LIVE from Valkey on every `get`/`getExpiration`
    // (below), so there is no per-process snapshot to refresh. This is deliberate — an earlier
    // snapshot design let a replica that didn't handle a `revalidateTag` keep serving a stale
    // in-process `use cache` memo, because its snapshot never saw the peer's invalidation
    // (observed live: two pods diverged, one never picking up a revalidation). Reading live
    // makes cross-replica revalidation immediate on every replica. A snapshot cache can return
    // later as a "make it fast" optimization, but it must refresh from Valkey each request.
  }

  async getExpiration(tags: string[]): Promise<Timestamp> {
    try {
      const manifest = await this.tagStates(tags);
      return maxExpiration(tags, manifest);
    } catch (error) {
      // L3: fail STALE, not fresh. Returning 0 ("never invalidated") would let revalidated
      // entries keep serving during a transient manifest outage; returning the current time
      // (`this.now()` — `Date.now` by default) makes Next treat affected entries as invalidated
      // and regenerate, the same safe direction as `get` degrading to a miss. Logged
      // (rate-limited) so the outage is observable without per-request log spam.
      logErrorRateLimited(
        "getExpiration",
        "[valkey-cache] getExpiration failed to read the tag manifest; treating entries as stale",
        error,
      );
      return this.now();
    }
  }

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    if (tags.length === 0) return;
    try {
      const now = this.now();
      // Apply each tag's new state atomically with LAST-EVENT-WINS semantics: the server-side
      // script only overwrites a field when the incoming event (stamped with the server's clock)
      // is >= the stored one. This eliminates the read-modify-write race where two replicas
      // revalidating the same tag interleave and an older/profiled update clobbers a newer
      // hard-expire (Redis runs the whole script atomically). Passing `undefined` as the base
      // keeps each event's state self-contained.
      const args: string[] = [];
      for (const tag of tags) {
        args.push(tag, JSON.stringify(computeTagUpdate(undefined, now, durations)));
      }
      await this.client.eval(UPDATE_TAGS_SCRIPT, 1, this.tagsKey, ...args);
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
   * Tag states for the given tags, read LIVE from the shared Valkey manifest (one `HMGET`).
   * Reading live — rather than from a per-process snapshot — is what makes a `revalidateTag`
   * on one replica immediately visible to every other replica's `get`/`getExpiration`.
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
