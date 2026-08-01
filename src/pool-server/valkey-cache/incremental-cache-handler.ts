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
  chunkManifestTags,
  filterManifestTags,
  isRootParamTag,
  maxTagLength,
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

// Single-flight revalidation lock lifetime. Long enough to cover any sane background
// re-render; short enough that a crashed winner only delays the NEXT revalidation attempt,
// never the serving of the (stale-but-valid) entry. Mirrors adapter-aws's 30s default.
const REVALIDATE_LOCK_TTL_SECONDS = 30;

/**
 * Total budget for one entry's stored tag list (N79). A byte budget, not a count: the point of the
 * bound is to keep entry meta and the freshness HMGET argv bounded, and 128 tags of 1024 chars is
 * a bigger list than 500 tags of 40. 64 KiB is far above anything Next generates (a handful of
 * implicit tags plus the app's declared ones) and far below "unbounded".
 *
 * N79 follow-up (review): the budget is spent in UTF-8 BYTES (`Buffer.byteLength`), not in
 * `String#length`. What lands in the entry JSON and in the freshness `HMGET` argv is the encoded
 * form, so a non-ASCII tag costs 2–4 bytes per UTF-16 unit — an explicit `cacheTag()` of Cyrillic
 * or CJK text counts up to 3x what `.length` reports, and a list "within budget" by `.length`
 * could be ~3x over it on the wire. (Per-tag LIMITS still use `.length`: `maxTagLength` mirrors
 * upstream's own `NEXT_CACHE_*_MAX_LENGTH` checks, which are `.length`-based.)
 */
const MAX_TAG_BYTES_PER_ENTRY = 64 * 1024;
/**
 * Defensive count cap on the private root-param markers, which are otherwise never dropped. Next
 * emits one per root layout param (a handful); this only stops a hand-written
 * `x-next-cache-tags: _N_RP_a,_N_RP_b,…` from making the "never drop" rule unbounded. It is also
 * what makes the budget relaxation below a BOUNDED relaxation.
 */
const MAX_ROOT_PARAM_TAGS = 256;

/** One tag's cost against the budget: its UTF-8 bytes plus one separator byte. */
function tagCostBytes(tag: string): number {
  return Buffer.byteLength(tag, "utf8") + 1;
}

/**
 * Bound a tag list for storage (L9/N5/N79): drop malformed tags and bound the total bytes, keeping
 * declared order. Shared by both handlers.
 *
 * N79 — this used to apply a flat 256-char limit and a flat 128-tag cap, and both were wrong for
 * tags NEXT ITSELF generates:
 *
 *   • The 256-char limit is `NEXT_CACHE_TAG_MAX_LENGTH`, which upstream applies only to EXPLICIT
 *     `cacheTag()` values. Implicit path tags are `_N_T_` + `encodeCacheTag(pathname)`, which
 *     percent-encodes every non-ASCII byte and is bounded by `NEXT_CACHE_SOFT_TAG_MAX_LENGTH`
 *     (1024). A measured 63-char Cyrillic pathname expands to a 348-char tag; a 300-char ASCII
 *     path is a 305-char tag. Probed against real Valkey: such an entry was stored with `tags: []`
 *     — so NOTHING, not `revalidatePath` and not `revalidateTag`, could ever invalidate it, for
 *     the 30 days of `DURABLE_TTL_SECONDS` (`revalidate: false` and PPR shells take exactly that
 *     path). Fixed by applying each tag's real upstream limit (`maxTagLength`).
 *
 *   • The 128-count cap kept declared order, and Next appends the private `_N_RP_*` root-param
 *     markers LAST (`use-cache-wrapper.ts`, `rootParamTags` spread after `fullEntry.tags`). So an
 *     entry with ≥128 tags lost exactly those markers — measured: 132 tags in, 128 stored, both
 *     `_N_RP_*` gone — and the reader then finds `paramNames.size === 0` and serves the COARSE
 *     redirect entry's body (a single `0x00` byte) as the cache hit. Fixed by never dropping a
 *     root-param tag and by bounding total bytes instead of truncating the tail.
 *
 * A tag still over its own upstream limit after all that is dropped: upstream cannot target it
 * either (`revalidatePath` refuses a path longer than `NEXT_CACHE_SOFT_TAG_MAX_LENGTH`), so
 * storing it would only cost bytes.
 *
 * N79 follow-up (review) — the budget is now a real UPPER BOUND, which it was not: reserved
 * `_N_RP_*` markers were pushed unconditionally, so once the reserved set alone exceeded the
 * budget, `remainingBudget` went negative and the returned list simply blew past the advertised
 * cap (with `.length` used as the cost, a non-ASCII list blew past it even without any markers).
 *
 * The deliberate resolution when the RESERVED set alone is over budget: raise the budget to fit
 * exactly the reserved markers (leaving nothing for ordinary tags) and warn once — NEVER silently
 * truncate them. Dropping an `_N_RP_*` marker is the bug this whole path exists to prevent: the
 * reader then finds `paramNames.size === 0` and serves a coarse redirect entry's `0x00`
 * placeholder byte as a cache hit. So the honest bound is
 *   `max(MAX_TAG_BYTES_PER_ENTRY, reserved bytes)`
 * with `reserved bytes` itself bounded by `MAX_ROOT_PARAM_TAGS` markers of at most
 * `NEXT_CACHE_SOFT_TAG_MAX_LENGTH` UTF-16 units each (≤ 256 × (3·1024 + 1) ≈ 768 KiB worst case,
 * and ~4 KiB for anything Next actually emits — one marker per root layout param, ASCII names).
 * Bounded and loud beats silently correct-looking.
 */
export function capTags(raw: readonly string[]): string[] {
  const wellFormed: string[] = [];
  let rootParamCount = 0;
  for (const tag of raw) {
    if (typeof tag !== "string" || tag.length === 0) continue;
    if (tag.length > maxTagLength(tag)) continue;
    if (isRootParamTag(tag) && ++rootParamCount > MAX_ROOT_PARAM_TAGS) {
      // The one case where a marker IS dropped. Never silent: this is the shape that made the
      // reader serve a coarse entry's placeholder body as a hit.
      warnOnce(
        "cap-tags-root-param-count",
        `[valkey-cache] an entry declared more than ${MAX_ROOT_PARAM_TAGS} private root-param ` +
          `tags (_N_RP_*); the excess is dropped. Next emits one per root layout param, so this ` +
          `indicates a forged x-next-cache-tags header.`,
      );
      continue;
    }
    wellFormed.push(tag);
  }
  // Reserve the root-param markers' bytes up front: they are load-bearing metadata (see
  // `isRootParamTag`) and must survive even when the rest of the list is over budget.
  let reservedBytes = 0;
  for (const tag of wellFormed) if (isRootParamTag(tag)) reservedBytes += tagCostBytes(tag);
  let budget = MAX_TAG_BYTES_PER_ENTRY;
  if (reservedBytes > budget) {
    warnOnce(
      "cap-tags-reserved-over-budget",
      `[valkey-cache] an entry's private root-param tags (_N_RP_*) alone need ${reservedBytes} ` +
        `bytes, over the ${MAX_TAG_BYTES_PER_ENTRY}-byte per-entry tag budget. Keeping them all ` +
        `and raising this entry's budget to ${reservedBytes} bytes: dropping one would make the ` +
        `reader serve a coarse entry's placeholder body as a cache hit. No ordinary tag is stored ` +
        `for this entry.`,
    );
    budget = reservedBytes;
  }
  budget -= reservedBytes;
  const tags: string[] = [];
  for (const tag of wellFormed) {
    if (isRootParamTag(tag)) {
      tags.push(tag);
      continue;
    }
    const cost = tagCostBytes(tag);
    // Skip (don't stop): a long tag must not shadow the shorter ones declared after it.
    if (cost > budget) continue;
    budget -= cost;
    tags.push(tag);
  }
  return tags;
}

/**
 * N82: `buildId` namespaces the whole cache keyspace (`k8s:<buildId>:…`), so it must not contain
 * the separator. `NEXT_BUILD_ID` was trusted verbatim at the point of consumption: a `:` in it
 * would let one build's `k8s:a:tags` key alias another's `k8s:a:tags` — e.g. buildId `a:entry`
 * makes `k8s:a:entry:tags` collide with build `a`'s entry key for cacheKey `tags`, so one build
 * reads another build's bytes. AGENTS.md requires validating operator/build-controlled values AT
 * the point of consumption even when they were validated upstream (the adapter's `modifyConfig`
 * generates a hashed, safe id — this is the second gate). Failing closed here is deliberate: the
 * alternative is silently serving another build's cached pages.
 */
const SAFE_BUILD_ID = /^[A-Za-z0-9_.-]{1,128}$/;
export function assertSafeBuildId(buildId: string): void {
  if (!SAFE_BUILD_ID.test(buildId)) {
    throw new Error(
      "[valkey-cache] refusing to use an unsafe build id for the cache keyspace: it must match " +
        "/^[A-Za-z0-9_.-]{1,128}$/ (a `:` would let one build's keys alias another's)",
    );
  }
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
  /** Threaded to the seed lookup — the fs-mirror layer needs the fs-cache read semantics. */
  isFallback?: boolean;
  isRoutePPREnabled?: boolean;
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
  /** N80: the route's own `revalidate` window in seconds (`false` = never time-revalidate), kept
   * so a stale-by-tag read can be signalled as SWR rather than as a blocking re-render. */
  revalidateSeconds?: number | false;
  /** N80: the route's `expire` window in seconds, if it has one. */
  expireSeconds?: number;
}

/**
 * N80: the `lastModified` to report for an entry that a PROFILED (soft) tag revalidation marked
 * stale. This must not be `-1`.
 *
 * `-1` is not "revalidate in the background" — `incremental-cache/index.ts` maps it to
 * `isStale = -1`, and `response-cache/index.ts` implements that as "do NOT early-resolve with the
 * stale value", i.e. the user waits for a full render. `FileSystemCache` never returns `-1` for a
 * merely-stale tag: it returns `null` for an EXPIRED tag and the untouched entry otherwise, letting
 * `index.ts` set `isStale = true` (serve stale + revalidate in the background). Measured before this
 * fix: `after profiled revalidateTag: lastModified = -1` — so `revalidateTag(tag, profile)` blocked
 * here while being instant-with-SWR under `next start`, breaking parity.
 *
 * The way to say "stale, serve it, revalidate behind the request" through this interface is a real
 * `lastModified` that sits just past the route's revalidate window but still inside its expire
 * window: `index.ts` computes `revalidateAfter = revalidate*1000 + lastModified` and sets
 * `isStale = true` when that is in the past, and only escalates to `-1` when
 * `expire*1000 + lastModified` is also past. `-1` remains the answer when SWR is not expressible:
 * a route with no numeric `revalidate` (`revalidate: false`, PPR shells) has `revalidateAfter ===
 * false`, so nothing but `-1` can force a revalidation, and an `expire` window too short to hold
 * the shift genuinely IS past expiry.
 */
function staleByTagLastModified(entry: StoredEntry, now: number): number {
  const revalidate = entry.revalidateSeconds;
  if (typeof revalidate !== "number") return -1;
  // One second past the revalidate boundary: `revalidateAfter` lands at `now - 1000 < now`.
  const shifted = now - revalidate * 1000 - 1000;
  if (shifted <= 0) return -1;
  const expire = entry.expireSeconds;
  if (typeof expire === "number" && expire * 1000 + shifted < now) return -1;
  return shifted;
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
  // N80: the cache-control window is advisory (it only shapes the stale-by-tag `lastModified`), so
  // a corrupt/absent value degrades to "unknown" rather than to a miss — but it must never reach
  // the arithmetic as NaN.
  if (
    "revalidateSeconds" in e &&
    e.revalidateSeconds !== false &&
    !Number.isFinite(e.revalidateSeconds)
  ) {
    delete e.revalidateSeconds;
  }
  if ("expireSeconds" in e && !Number.isFinite(e.expireSeconds)) delete e.expireSeconds;
  return e as unknown as StoredEntry;
}

/** A build-time prerender usable as a cache entry when Valkey has no stored value. */
export interface SeedEntry {
  lastModified: number;
  tags: string[];
  value: Record<string, unknown>;
}

export interface ValkeyIncrementalCacheOptions {
  client: ValkeyClient;
  buildId: string;
  now?: () => number;
  /**
   * Build-seed fallback (see build-seed-index.ts). `next start`'s filesystem cache STARTS
   * FULL — the build outputs are its initial content — while a custom handler starts empty.
   * Next assumes the full model: `dynamicParams: false` refuses to render dynamically and
   * throws "invariant: cache entry required but not generated" on a miss (500'd live on GKE,
   * 2026-07-30), and first requests to any prerendered page re-render instead of serving the
   * artifact. On a Valkey MISS this consults the on-disk build prerender, restoring the
   * warm-start model; stored entries always win, and `set` still writes to Valkey so
   * regeneration owns the key from then on.
   */
  seedLookup?: (
    cacheKey: string,
    ctx?: { kind?: string; isFallback?: boolean; isRoutePPREnabled?: boolean },
  ) => Promise<SeedEntry | null>;
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
  // Bound the stored list (L9/N79): each tag against its own upstream length limit, the whole
  // list against a byte budget, and Next's private `_N_RP_*` markers never dropped.
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
  private readonly seedLookup: ValkeyIncrementalCacheOptions["seedLookup"];

  constructor(options: ValkeyIncrementalCacheOptions) {
    this.client = options.client;
    // N8: never Date.now — patched to throw inside tracked static renders (see wallClockNow).
    this.now = options.now ?? wallClockNow;
    // N82: validate at the point of consumption — this is where the build id becomes keyspace.
    assertSafeBuildId(options.buildId);
    // Same build-namespaced tag keyspace as the V2 handler, so `revalidateTag` is shared.
    this.prefix = `k8s:${options.buildId}:`;
    this.tagsKey = `${this.prefix}tags`;
    this.seedLookup = options.seedLookup;
  }

  private entryKey(cacheKey: string): string {
    return `${this.prefix}inc:${cacheKey}`;
  }

  private revalidateLockKey(cacheKey: string): string {
    return `${this.prefix}inc-revalidate-lock:${cacheKey}`;
  }

  /**
   * Valkey had nothing for this key: consult the build seed. Tag semantics mirror the stored
   * path — a HARD-invalidated tag (updateTag / expireTag, or revalidateTag's expire:0 form)
   * kills the seed exactly as it deletes a stored entry, and a soft-stale tag serves the seed
   * while signalling stale so Next revalidates behind the request. Age-based ISR staleness
   * needs nothing here: Next compares `lastModified` (the build artifact's mtime) against the
   * route's revalidate window itself, which is precisely `next start` serving a stale
   * filesystem entry and regenerating in the background.
   */
  private async seedFallback(cacheKey: string, ctx: GetCtx): Promise<CacheHandlerValue | null> {
    if (!this.seedLookup) return null;
    try {
      const seed = await this.seedLookup(cacheKey, {
        ...(ctx.kind !== undefined ? { kind: ctx.kind } : {}),
        ...(ctx.isFallback !== undefined ? { isFallback: ctx.isFallback } : {}),
        ...(ctx.isRoutePPREnabled !== undefined ? { isRoutePPREnabled: ctx.isRoutePPREnabled } : {}),
      });
      if (!seed) return null;
      const softTags = ctx.softTags ?? ctx.tags ?? [];
      const tags = [...seed.tags, ...softTags];
      const manifest = await this.tagStates(tags);
      const now = this.now();
      if (areTagsExpired(tags, seed.lastModified, manifest, now)) return null;
      const staleByTag = areTagsStale(tags, seed.lastModified, manifest);
      let signalStale = staleByTag;
      if (staleByTag) {
        try {
          const acquired = await this.client.set(
            this.revalidateLockKey(cacheKey),
            "1",
            "NX",
            "EX",
            REVALIDATE_LOCK_TTL_SECONDS,
          );
          signalStale = acquired !== null;
        } catch {
          signalStale = true;
        }
      }
      return {
        lastModified: signalStale
          ? staleByTagLastModified({ lastModified: seed.lastModified } as StoredEntry, now)
          : seed.lastModified,
        value: seed.value as CacheHandlerValue["value"],
      };
    } catch (error) {
      logErrorRateLimited(
        "cache-seed",
        "[valkey-cache] build-seed fallback failed; treating it as a miss",
        error,
      );
      return null;
    }
  }

  /** get() without the seed fallback: STORED entries only (a post-deploy write or null). */
  async getStored(cacheKey: string, ctx: GetCtx = {}): Promise<CacheHandlerValue | null> {
    return this.getImpl(cacheKey, ctx, true);
  }

  async get(cacheKey: string, ctx: GetCtx = {}): Promise<CacheHandlerValue | null> {
    return this.getImpl(cacheKey, ctx, false);
  }

  private async getImpl(
    cacheKey: string,
    ctx: GetCtx,
    skipSeed: boolean,
  ): Promise<CacheHandlerValue | null> {
    try {
      const raw = await this.client.get(this.entryKey(cacheKey));
      if (!raw) return skipSeed ? null : this.seedFallback(cacheKey, ctx);
      const entry = parseStoredEntry(raw);
      if (!entry) return skipSeed ? null : this.seedFallback(cacheKey, ctx); // corrupt entry → seed, else miss (L5)
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
      // A stale (SWR) tag must make Next serve this value and revalidate BEHIND the request —
      // never block on a fresh render (N80, see `staleByTagLastModified`).
      //
      // Single-flight (survey Tier 1 #5, plans/lessons-from-sibling-adapters.md): without a
      // lock, EVERY replica that reads a tag-stale entry gets the stale-signalling
      // lastModified and every one of them re-renders — N pods, N renders, one shared store
      // (adapter-aws locks the same way before enqueueing, router.ts:772-805; adapter-bun
      // built the lock table and forgot to call it). Only the reader that wins a short-TTL
      // NX lock is told "stale"; the rest see the entry as fresh and keep serving it while
      // the winner revalidates (its `set` releases the lock early; the TTL bounds a crashed
      // winner). A lock-acquire FAILURE fails open to the stale signal — at worst the old
      // stampede, never a lost revalidation.
      const staleByTag = areTagsStale(tags, entry.lastModified, manifest);
      let signalStale = staleByTag;
      if (staleByTag) {
        try {
          const acquired = await this.client.set(
            this.revalidateLockKey(cacheKey),
            "1",
            "NX",
            "EX",
            REVALIDATE_LOCK_TTL_SECONDS,
          );
          signalStale = acquired !== null;
        } catch {
          signalStale = true;
        }
      }
      return {
        lastModified: signalStale ? staleByTagLastModified(entry, now) : entry.lastModified,
        value: decodeValue(entry.value),
      };
    } catch (error) {
      // N81: fail open to a miss (Next regenerates) — but SAY SO. This catch was bare, so a
      // PERMANENT read failure (NOAUTH, WRONGTYPE, a cluster -MOVED, an exhausted breaker, an
      // invalid URL) produced ZERO log lines while the pool re-rendered everything from scratch
      // forever. Measured before the fix: four handler operations against a dead Valkey emitted 0
      // log lines. M1's own rationale in stream-codec.ts says an outage "must still be OBSERVABLE".
      logErrorRateLimited(
        "cache-get",
        "[valkey-cache] incremental cache read failed; treating it as a miss (the pool is rendering uncached)",
        error,
      );
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
        // N80: remember the route's own cache-control window so a stale-by-tag read can express
        // stale-while-revalidate instead of forcing a blocking render.
        revalidateSeconds: typeof revalidate === "number" ? revalidate : false,
        ...(typeof ctx.cacheControl?.expire === "number"
          ? { expireSeconds: ctx.cacheControl.expire }
          : {}),
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
      // A completed re-render releases the single-flight revalidation lock early (see `get`);
      // best-effort — the lock's own TTL is the backstop.
      this.client.del(this.revalidateLockKey(cacheKey)).catch(() => undefined);
    } catch (error) {
      // Cache write failure must not break the response — but it must be observable (N81, see
      // the matching comment in `get`).
      logErrorRateLimited(
        "cache-set",
        "[valkey-cache] incremental cache write failed; the entry was not cached (the pool will re-render it)",
        error,
      );
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    // N83: one shared filter for both handlers, so a tag that can be stored is a tag that can be
    // revalidated (and an empty-string tag never becomes a manifest field).
    const list = filterManifestTags(Array.isArray(tags) ? tags : [tags]);
    if (list.length === 0) return;
    try {
      const now = this.now();
      // Chunked, not truncated: every tag the caller passed gets invalidated, in as many
      // EVALs as the per-call argv bound requires.
      for (const chunk of chunkManifestTags(list)) {
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
