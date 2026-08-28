// Pure tag-staleness logic for the Valkey-backed V2 `use cache` CacheHandler.
//
// This mirrors Next 16.3's reference implementation exactly:
//   - `areTagsExpired` / `areTagsStale` from
//     next/dist/server/lib/incremental-cache/tags-manifest.external.js
//   - `updateTags` / `getExpiration` from
//     next/dist/server/lib/cache-handlers/default.js
//
// The ONLY difference from Next's in-process handler is where the manifest lives: ours is
// backed by Valkey so revalidation propagates across every replica (Next's default keeps it
// in a per-process Map, which is why `refreshTags` is a no-op there and cross-replica
// invalidation is impossible). Unprepared reads fetch only their relevant fields. Pool requests
// first read the fixed-size epoch field, then keep Cache Components callbacks network-free.
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
 * Reserved hash field incremented atomically with every tag-manifest update. A pool request reads
 * only this scalar before entering Next's staged render; reading the complete, high-cardinality
 * manifest on every request would make tag count an unbounded dataplane cost. The control-byte
 * prefix is outside Next's generated tag namespace, and filterManifestTags rejects it explicitly.
 */
export const TAG_MANIFEST_EPOCH_FIELD = "\u001fadapter-k8s-epoch";

/**
 * How far a replica's clock may differ from the Valkey SERVER clock before the skew is reported
 * (L16/N78). The script REBASES every watermark onto the server clock regardless of the size of the
 * difference (see `UPDATE_TAGS_SCRIPT`); this constant only decides when the divergence is large
 * enough to be a broken pod clock worth logging. 60s absorbs normal NTP jitter.
 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/**
 * Upstream per-tag length limits (`packages/next/src/lib/constants.ts`), N79. These are two
 * DIFFERENT limits and conflating them is what made entries un-invalidatable:
 *   - `NEXT_CACHE_TAG_MAX_LENGTH = 256` — enforced by `cacheTag()` / `validateTags` on tags the
 *     app declares explicitly. A longer explicit tag is already dropped by Next itself.
 *   - `NEXT_CACHE_SOFT_TAG_MAX_LENGTH = 1024` — the bound `revalidatePath` applies, i.e. the
 *     limit that governs the IMPLICIT tags Next generates for every route.
 */
export const MAX_EXPLICIT_TAG_LENGTH = 256;
export const MAX_SOFT_TAG_LENGTH = 1024;
/** `NEXT_CACHE_IMPLICIT_TAG_ID` — the prefix on Next's derived per-path tags. */
const IMPLICIT_TAG_PREFIX = "_N_T_";
/** `NEXT_CACHE_ROOT_PARAM_TAG_ID` — private markers on a `use cache` coarse/redirect entry. */
const ROOT_PARAM_TAG_PREFIX = "_N_RP_";

/**
 * Whether a tag is one of Next's private root-param markers. These are not user tags at all: the
 * `use cache` wrapper reads them back off the COARSE entry to learn which root params belong in
 * the specific cache key (`use-cache-wrapper.ts`, "Check if this is a redirect entry"). Losing
 * them makes the reader see `paramNames.size === 0` and serve the redirect entry's placeholder
 * body — a single `0x00` byte — as the cache hit.
 */
export function isRootParamTag(tag: string): boolean {
  return tag.startsWith(ROOT_PARAM_TAG_PREFIX);
}

/** The applicable upstream length limit for one tag (N79). */
export function maxTagLength(tag: string): number {
  return tag.startsWith(IMPLICIT_TAG_PREFIX) || isRootParamTag(tag)
    ? MAX_SOFT_TAG_LENGTH
    : MAX_EXPLICIT_TAG_LENGTH;
}

/**
 * Upper bound on how many tags one `updateTags`/`revalidateTag` call may push into the EVAL argv
 * (N83). Next's own `revalidateTag` takes one tag at a time; the array form comes from the classic
 * handler's `revalidateTag(tags[])`, which Next calls with the route's tag list.
 */
const MAX_MANIFEST_TAGS_PER_CALL = 256;

/**
 * N83: the one filter both handlers use before a tag reaches the manifest keyspace. Previously the
 * classic handler `.filter(Boolean)`-ed its input while the V2 handler only rejected an empty
 * ARRAY — so a `""` tag from the V2 path became a real hash field, and neither path bounded the
 * per-tag length or the argv size. Same charset/length rules as `capTags`, so a tag that can be
 * STORED with an entry is exactly a tag that can be REVALIDATED.
 */
export function filterManifestTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    if (tag === TAG_MANIFEST_EPOCH_FIELD) continue;
    if (tag.length > maxTagLength(tag)) continue;
    out.push(tag);
  }
  return out;
}

/**
 * Split validated tags into EVAL-sized batches.
 *
 * This used to be a truncation inside filterManifestTags: past MAX_MANIFEST_TAGS_PER_CALL the
 * remaining tags were silently DROPPED, so a `revalidateTag`/`updateTags` call with more than
 * 256 tags never invalidated the tail — those entries stayed fresh until their durable TTL
 * expired, with nothing logged. The bound exists to keep one EVAL's argv reasonable, and that
 * is a reason to send several commands, not to discard work the caller asked for.
 */
export function chunkManifestTags(tags: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < tags.length; i += MAX_MANIFEST_TAGS_PER_CALL) {
    chunks.push(tags.slice(i, i + MAX_MANIFEST_TAGS_PER_CALL));
  }
  return chunks;
}

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
 * "last to reach the server" — a single monotonic clock for ordering.
 *
 * N78: the `stale`/`expired` WATERMARKS are rebased onto the same server clock, by shifting them
 * by `serverNow - clientAt`. They used to stay client-computed with only a one-sided ceiling
 * (clamped when more than MAX_CLOCK_SKEW_MS in the FUTURE), which lost hard `revalidateTag`s
 * outright on an unsynced fleet. Probed against real Valkey, before the fix:
 *   • a pod 5 minutes BEHIND: stored `{"expired": now-300000}` — there was no floor, so the
 *     watermark sat 5 minutes in the past and invalidated NOTHING written recently
 *     (`expired > entryTimestamp` false for every current entry).
 *   • a pod 5 minutes AHEAD: the hard expire was clamped to `now + 60000` and carries no `stale`,
 *     so `expired <= now` was false for a full minute — the entry read back `revalidate: 60`,
 *     i.e. FRESH, not even stale-while-revalidate.
 * Shifting by the delta fixes both directions at once and is exactly "stamp from Valkey's own
 * TIME" for the two shapes that matter: a hard event carries `expired == at`, so it lands on the
 * server's now; a profiled event carries `stale == at` and `expired == at + expire*1000`, so its
 * base lands on the server's now and the intended duration is preserved bit-for-bit.
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
    -- N78: rebase EVERY client-computed watermark onto the Valkey server clock by shifting it by
    -- the client's offset from that clock. 'at' is the event's client timestamp, and both
    -- computeTagUpdate shapes are anchored to it (hard: expired == at; profiled: stale == at and
    -- expired == at + expire*1000), so a single shift pins the base to server time in BOTH
    -- directions (a behind clock is dragged forward, an ahead clock back) while preserving a
    -- profile's intended duration exactly. Report the shift as a clamp when it exceeds the skew
    -- bound so a broken pod clock stays observable.
    local clientAt = tonumber(nw.at)
    local shift = 0
    if clientAt then shift = now - clientAt end
    if shift > ${MAX_CLOCK_SKEW_MS} or shift < -${MAX_CLOCK_SKEW_MS} then
      clamped = clamped + 1
    end
    if type(nw.stale) == 'number' then nw.stale = nw.stale + shift end
    if type(nw.expired) == 'number' then nw.expired = nw.expired + shift end
    nw.at = now
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
-- The fixed-size epoch lets pool requests notice any peer invalidation without HGETALL-ing an
-- unbounded manifest inside the request path. It shares this script's atomic boundary: a reader
-- can observe either the old fields+epoch or the new fields+epoch, never a torn update.
redis.call('HINCRBY', KEYS[1], '${TAG_MANIFEST_EPOCH_FIELD}', 1)
-- M11: bound the manifest's own lifetime, refreshed on each write (entry keys are TTL-bounded;
-- the manifest must be too, or every deploy leaks a build-namespaced hash forever).
if ttlSeconds and ttlSeconds > 0 then redis.call('EXPIRE', KEYS[1], ttlSeconds) end
return clamped
`;

/**
 * Surface the skew flag/count returned by the server-clocked cache scripts. Entries and tag
 * watermarks remain correct because they are stored in Valkey's domain; the warning identifies a
 * broken pod clock. Once per process avoids one line per cache operation.
 */
export function warnOnClockSkewClamp(clamped: unknown): void {
  if (typeof clamped === "number" && clamped > 0) {
    warnOnce(
      "clock-skew-clamp",
      `[valkey-cache] a replica clock differs from the Valkey server clock by more than ${MAX_CLOCK_SKEW_MS}ms; ` +
        "cache timestamps were translated to the shared server clock — check pod clock sync (ntp/chrony)",
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
 * The freshness decision used by the handler's `get`. Production Next treats the time-based
 * `revalidate` boundary as a miss so the request regenerates synchronously; `expire` remains the
 * hard retention boundary and controls profiled tag invalidations. Only a tag profile with a
 * future expire watermark is stale-while-revalidate.
 */
export function evaluateEntry(
  entry: { timestamp: number; revalidate: number; expire: number; tags: readonly string[] },
  manifest: TagManifest,
  now: number,
): Freshness {
  if (now > entry.timestamp + entry.expire * 1000) return { state: "expired" };
  if (areTagsExpired(entry.tags, entry.timestamp, manifest, now)) return { state: "expired" };
  if (now > entry.timestamp + entry.revalidate * 1000) return { state: "expired" };
  if (areTagsStale(entry.tags, entry.timestamp, manifest)) return { state: "stale" };
  return { state: "fresh", revalidate: entry.revalidate };
}
