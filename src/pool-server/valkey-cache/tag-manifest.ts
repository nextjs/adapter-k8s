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

import { warnOnce } from "./stream-codec.js";

/**
 * Retention for the shared tag-manifest hash itself (M11), refreshed on every write by
 * `UPDATE_TAGS_SCRIPT`. Mirrors the entry-key policy (`DURABLE_TTL_SECONDS`): without it,
 * every deploy's build-namespaced manifest (`k8s:<buildId>:tags`) lived FOREVER — entry keys
 * were TTL-bounded but manifests were not, so the keyspace grew without bound across deploys.
 */
export const TAG_MANIFEST_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * How far a client-clock watermark may run ahead of the Valkey SERVER clock before the script
 * clamps it (L16). Watermarks are client-computed (`stale`/`expired`), but entries they are
 * compared against were written by OTHER replicas' clocks: a fast-clock replica's far-future
 * watermark would instantly invalidate entries its peers wrote after the revalidation (or, for
 * a hard expire, sit in the future and fail to invalidate until the clock caught up). 60s
 * absorbs normal NTP jitter; anything beyond it is a broken pod clock, and clamping bounds the
 * blast radius to a 60s over/under-invalidation window.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Atomic last-event-wins merge for the shared tag manifest, used by both the V2 and the classic
 * incremental handlers. KEYS[1] is the manifest key; ARGV is `[field, json, field, json, …,
 * ttlSeconds]` (the trailing TTL refreshes the manifest key's own retention, M11). Each field is
 * overwritten only when the incoming event is `>=` the stored one, so a concurrent older
 * revalidation from another replica can't clobber a newer one. Runs atomically (Redis/Valkey
 * execute a script to completion without interleaving). Returns the number of events whose
 * watermarks had to be clamped for clock skew (L16) — callers warnOnce when it is > 0.
 *
 * The merge clock is the VALKEY SERVER's (`TIME`), not the client-supplied `at`: replicas'
 * clocks skew, and a backward-stepping replica would otherwise stamp an older `at` on a newer
 * event and have its invalidation silently dropped by the merge. The script rewrites the
 * incoming state's `at` to the server time before comparing/storing, so "last event" means
 * "last to reach the server" — a single monotonic clock for ordering. The `stale`/`expired`
 * watermarks stay client-computed: they are compared against entry timestamps, which are
 * themselves client clocks. The client still sends its own `at` (see `computeTagUpdate`) as a
 * fallback for any path where the script can't run its rewrite.
 *
 * The winning event is merged into the stored state PER DIMENSION (M12), not written over it:
 * an event only replaces the watermarks it SETS, preserving stored ones it didn't — exactly
 * Next's read-modify-write (`{...existing, stale: now}` keeps a stored `expired`). The old
 * whole-field replace let `revalidateTag('t', profileWithoutExpire)` (an event with only
 * `{stale, at}`) erase a hard-expire `expired` watermark from an earlier `revalidateTag('t')`,
 * so entries Next would hard-regenerate kept serving stale-with-revalidate.
 *
 * Merge semantics per dimension, for a winning event E over stored state S:
 *   - `stale`:   E's if set, else S's (a hard expire never erases a profile's SWR watermark).
 *   - `expired`: E's if set, else S's (a profile without `expire` never erases a hard expire;
 *                a later hard expire — `expired = now` — replaces a profile's future expiry,
 *                which is what makes the invalidation immediate, matching Next).
 *   - `at`:      always the server time — the LEW ordering key.
 */
export const UPDATE_TAGS_SCRIPT = `
local ttlSeconds = tonumber(ARGV[#ARGV])
local pairCount = #ARGV - 1
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local clamped = 0
local i = 1
while i <= pairCount do
  local field = ARGV[i]
  local incoming = ARGV[i + 1]
  local existing = redis.call('HGET', KEYS[1], field)
  local write = true
  local okNew, nw = pcall(cjson.decode, incoming)
  if okNew and type(nw) == 'table' then
    nw.at = now
    -- L16: clamp fast-clock watermarks to the server clock + bound. A profiled event's
    -- expired watermark legitimately sits far in the future (now + expire*1000), so shift it
    -- by the same amount as its stale base — the intended duration is preserved while the
    -- base is pinned to server time. A hard expire has no stale; its expired watermark IS the
    -- event time, so any value past the bound is pure skew.
    if type(nw.stale) == 'number' and nw.stale > now + ${MAX_CLOCK_SKEW_MS} then
      local shift = nw.stale - now - ${MAX_CLOCK_SKEW_MS}
      nw.stale = nw.stale - shift
      if type(nw.expired) == 'number' then nw.expired = nw.expired - shift end
      clamped = clamped + 1
    elseif nw.stale == nil and type(nw.expired) == 'number' and nw.expired > now + ${MAX_CLOCK_SKEW_MS} then
      nw.expired = now + ${MAX_CLOCK_SKEW_MS}
      clamped = clamped + 1
    end
    if existing then
      local okCur, cur = pcall(cjson.decode, existing)
      if okCur and type(cur) == 'table' then
        local curAt = tonumber(cur.at) or 0
        if now < curAt then
          write = false
        else
          -- M12: per-dimension merge (see the TS docstring) — never whole-field replace.
          if nw.stale == nil then nw.stale = cur.stale end
          if nw.expired == nil then nw.expired = cur.expired end
        end
      end
    end
    if write then incoming = cjson.encode(nw) end
  end
  if write then redis.call('HSET', KEYS[1], field, incoming) end
  i = i + 2
end
-- M11: bound the manifest's own lifetime, refreshed on each write (entry keys are TTL-bounded;
-- the manifest must be too, or every deploy leaks a build-namespaced hash forever).
if ttlSeconds and ttlSeconds > 0 then redis.call('EXPIRE', KEYS[1], ttlSeconds) end
return clamped
`;

/**
 * Surface the L16 clamp count returned by `UPDATE_TAGS_SCRIPT`: when it is > 0, some replica's
 * clock ran more than `MAX_CLOCK_SKEW_MS` ahead of the Valkey server and its watermarks were
 * clamped server-side. The clamp keeps the damage bounded; the warning makes the broken clock
 * observable. Once per process — a skewed replica would otherwise log on every revalidation.
 */
export function warnOnClockSkewClamp(clamped: unknown): void {
  if (typeof clamped === "number" && clamped > 0) {
    warnOnce(
      "clock-skew-clamp",
      `[valkey-cache] a replica clock is more than ${MAX_CLOCK_SKEW_MS}ms ahead of the Valkey server clock; ` +
        "tag-invalidation watermarks were clamped server-side — check pod clock sync (ntp/chrony)",
    );
  }
}

/** Per-tag revalidation watermarks (absolute ms). */
export interface TagState {
  /** Entry became stale at this time — the stale-while-revalidate boundary. */
  stale?: number;
  /** Entry hard-expired at this time. */
  expired?: number;
  /**
   * Event time of the `updateTags` call that produced this state. Used only for the
   * last-event-wins merge across replicas (so a concurrent older revalidation can't clobber a
   * newer one) — not read by the freshness predicates. The Lua merge script rewrites this to
   * the Valkey SERVER's clock on write; the client-stamped value is only a fallback.
   */
  at?: number;
}

/**
 * Parse + sanitize a manifest field read back from Valkey (L5). Corrupt input degrades to
 * `undefined` (treated as "tag never revalidated" — the same as a missing field); non-finite
 * numeric watermarks are dropped, and a corrupt/missing `at` becomes 0 so the server-side
 * merge treats it as older than any real event. Never throws.
 */
export function parseTagState(raw: string): TagState | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const s = parsed as Record<string, unknown>;
  const finite = (x: unknown): number | undefined =>
    typeof x === "number" && Number.isFinite(x) ? x : undefined;
  const out: TagState = {};
  const stale = finite(s.stale);
  if (stale !== undefined) out.stale = stale;
  const expired = finite(s.expired);
  if (expired !== undefined) out.expired = expired;
  out.at = finite(s.at) ?? 0;
  return out;
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
 *
 * The handlers call this with `existing = undefined` and let `UPDATE_TAGS_SCRIPT` merge the
 * event into the stored state server-side (M12) — per dimension, an event replaces only the
 * watermarks it SETS (`stale` + maybe `expired` for a profiled call, `expired` for a hard
 * call) and preserves the rest. That is exactly Next's in-memory read-modify-write
 * (`tagsManifest.set(tag, { ...existingEntry, stale: now })`), made atomic across replicas:
 * a profiled revalidation without `expire` never erases a stored hard-expire watermark, and
 * a later hard expire replaces a stored future expiry (making the invalidation immediate).
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
