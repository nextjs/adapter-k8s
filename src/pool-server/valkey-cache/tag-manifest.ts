// Pure tag-staleness logic for the Valkey-backed V2 `use cache` CacheHandler.
//
// This mirrors Next 16.2's reference implementation exactly:
//   - `areTagsExpired` / `areTagsStale` from
//     next/dist/server/lib/incremental-cache/tags-manifest.external.js
//   - `updateTags` / `getExpiration` from
//     next/dist/server/lib/cache-handlers/default.js
//
// The ONLY difference from Next's in-process handler is where the manifest lives: ours is
// backed by Valkey so revalidation propagates across every replica (Next's default keeps it
// in a per-process Map, which is why `refreshTags` is a no-op there and cross-replica
// invalidation is impossible). The predicates below operate on an in-memory snapshot that
// `refreshTags()` pulls from Valkey at the start of each request.
//
// Watermarks are absolute milliseconds since the epoch, matching Next.

/**
 * Atomic last-event-wins merge for the shared tag manifest, used by both the V2 and the classic
 * incremental handlers. ARGV is `[field, json, field, json, …]`; each field is overwritten only
 * when the incoming `at` (event time) is `>=` the stored one, so a concurrent older revalidation
 * from another replica can't clobber a newer one. Runs atomically (Redis/Valkey execute a script
 * to completion without interleaving).
 */
export const UPDATE_TAGS_SCRIPT = `
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

/** Per-tag revalidation watermarks (absolute ms). */
export interface TagState {
  /** Entry became stale at this time — the stale-while-revalidate boundary. */
  stale?: number;
  /** Entry hard-expired at this time. */
  expired?: number;
  /**
   * Event time of the `updateTags` call that produced this state. Used only for the
   * last-event-wins merge across replicas (so a concurrent older revalidation can't clobber a
   * newer one) — not read by the freshness predicates.
   */
  at?: number;
}

export type TagManifest = ReadonlyMap<string, TagState>;

/**
 * Mirror of Next's `areTagsExpired`: a tag hard-expires the entry only when its `expired`
 * watermark is in the past (`expired <= now`) AND newer than the entry's creation
 * (`expired > entryTimestamp`). A FUTURE `expired` — which a profiled `revalidateTag`
 * sets as `now + expire*1000` — does NOT expire the entry yet; it stays stale/SWR.
 */
export function areTagsExpired(
  tags: readonly string[],
  entryTimestamp: number,
  manifest: TagManifest,
  now: number,
): boolean {
  for (const tag of tags) {
    const expiredAt = manifest.get(tag)?.expired;
    if (typeof expiredAt === "number" && expiredAt <= now && expiredAt > entryTimestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Mirror of Next's `areTagsStale`: a tag marks the entry stale when its `stale` watermark
 * is newer than the entry's creation timestamp.
 */
export function areTagsStale(
  tags: readonly string[],
  entryTimestamp: number,
  manifest: TagManifest,
): boolean {
  for (const tag of tags) {
    const staleAt = manifest.get(tag)?.stale ?? 0;
    if (staleAt > entryTimestamp) return true;
  }
  return false;
}

/**
 * Mirror of the default handler's `getExpiration`: the max `expired` watermark across the
 * given tags, or 0 if none were ever revalidated. Next passes the request's soft (implicit
 * path) tags here at request start and compares the result against entry timestamps itself,
 * so `get` only needs to check the entry's own explicit tags.
 */
export function maxExpiration(tags: readonly string[], manifest: TagManifest): number {
  let max = 0;
  for (const tag of tags) {
    const expiredAt = manifest.get(tag)?.expired ?? 0;
    if (expiredAt > max) max = expiredAt;
  }
  return max;
}

/**
 * Mirror of the default handler's `updateTags`: mark `stale = now` immediately, and set the
 * `expired` watermark to `now + expire*1000` when a duration/profile is supplied, else to
 * `now` (immediate expiry — the no-durations default). Returns the new state to persist,
 * preserving any existing fields.
 */
export function computeTagUpdate(
  existing: TagState | undefined,
  now: number,
  durations?: { expire?: number },
): TagState {
  if (durations) {
    const next: TagState = { ...existing, stale: now, at: now };
    if (durations.expire !== undefined) {
      next.expired = now + durations.expire * 1000;
    }
    return next;
  }
  return { ...existing, expired: now, at: now };
}

/** Three-state freshness verdict for a stored entry. */
export type Freshness =
  | { state: "expired" }
  | { state: "stale" }
  | { state: "fresh"; revalidate: number };

/**
 * The freshness decision used by the handler's `get`. Unlike Next's in-memory default
 * handler — which evicts at `revalidate` because memory is short-lived — a persistent
 * (Valkey) cache keeps an entry up to the longer `expire` window and serves it stale
 * (`revalidate: -1`) in between, which is the intended stale-while-revalidate behavior
 * (the interface documents `expire` as "how long the entry is allowed to be used",
 * `revalidate` as "how long until the entry should be revalidated").
 */
export function evaluateEntry(
  entry: { timestamp: number; revalidate: number; expire: number; tags: readonly string[] },
  manifest: TagManifest,
  now: number,
): Freshness {
  if (now > entry.timestamp + entry.expire * 1000) return { state: "expired" };
  if (areTagsExpired(entry.tags, entry.timestamp, manifest, now)) return { state: "expired" };
  if (now > entry.timestamp + entry.revalidate * 1000) return { state: "stale" };
  if (areTagsStale(entry.tags, entry.timestamp, manifest)) return { state: "stale" };
  return { state: "fresh", revalidate: entry.revalidate };
}
