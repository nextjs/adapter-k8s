import type { Redis } from "ioredis";
import { bufferToStream, drainEntryValue } from "./stream-codec.js";
import {
  computeTagUpdate,
  evaluateEntry,
  maxExpiration,
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
 * Atomic last-event-wins merge for the tag manifest. ARGV is [field, json, field, json, …];
 * each field is overwritten only when the incoming `at` (event time) is >= the stored `at`, so
 * concurrent revalidations from different replicas can't clobber a newer one with an older one.
 * Runs atomically (Redis/Valkey execute a script to completion without interleaving).
 */
const UPDATE_TAGS_SCRIPT = `
local i = 1
while i <= #ARGV do
  local field = ARGV[i]
  local incoming = ARGV[i + 1]
  local existing = redis.call('HGET', KEYS[1], field)
  local write = true
  if existing then
    local okCur, cur = pcall(cjson.decode, existing)
    local okNew, nw = pcall(cjson.decode, incoming)
    if okCur and okNew then
      local curAt = tonumber(cur.at) or 0
      local nwAt = tonumber(nw.at) or 0
      if nwAt < curAt then write = false end
    end
  end
  if write then redis.call('HSET', KEYS[1], field, incoming) end
  i = i + 2
end
return 1
`;

export interface ValkeyCacheHandlerOptions {
  client: Redis;
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
  private readonly client: Redis;
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
      const meta = JSON.parse(metaBuf.toString("utf8")) as StoredMeta;

      const now = this.now();
      const manifest = await this.tagStates(meta.tags);
      const freshness = evaluateEntry(meta, manifest, now);
      if (freshness.state === "expired") {
        this.client.del(key).catch(() => undefined);
        return undefined;
      }
      const revalidate = freshness.state === "stale" ? -1 : freshness.revalidate;
      return {
        value: bufferToStream(data.v ?? Buffer.alloc(0)),
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
    try {
      const entry = await pendingEntry;
      const buf = await drainEntryValue(entry);
      if (buf === null) return; // partial/errored stream → miss, don't cache
      const meta: StoredMeta = {
        tags: entry.tags,
        stale: entry.stale,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate: entry.revalidate,
      };
      const ttl = Math.max(entry.expire, entry.revalidate, 1) + RETENTION_MARGIN_SECONDS;
      const key = this.entryKey(cacheKey);
      await this.client
        .multi()
        .hset(key, "m", JSON.stringify(meta), "v", buf)
        .expire(key, Math.ceil(ttl))
        .exec();
    } catch {
      // A cache write failure must not break the response.
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
    } catch {
      return 0;
    }
  }

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    if (tags.length === 0) return;
    try {
      const now = this.now();
      // Apply each tag's new state atomically with LAST-EVENT-WINS semantics: the server-side
      // script only overwrites a field when the incoming `at` (event time) is >= the stored one.
      // This eliminates the read-modify-write race where two replicas revalidating the same tag
      // interleave and an older/profiled update clobbers a newer hard-expire (Redis runs the
      // whole script atomically). Passing `undefined` as the base keeps each event's state
      // self-contained.
      const args: string[] = [];
      for (const tag of tags) {
        args.push(tag, JSON.stringify(computeTagUpdate(undefined, now, durations)));
      }
      await this.client.eval(UPDATE_TAGS_SCRIPT, 1, this.tagsKey, ...args);
    } catch {
      // Best-effort: a failed manifest write means a revalidation is missed, not a crash.
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
        try {
          manifest.set(tag, JSON.parse(raw) as TagState);
        } catch {
          // ignore corrupt field
        }
      }
    });
    return manifest;
  }
}
