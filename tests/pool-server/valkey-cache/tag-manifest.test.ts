import { afterEach, describe, expect, it, vi } from "vitest";
import {
  areTagsExpired,
  areTagsStale,
  computeTagUpdate,
  evaluateEntry,
  MAX_CLOCK_SKEW_MS,
  maxExpiration,
  parseTagState,
  TAG_MANIFEST_TTL_SECONDS,
  UPDATE_TAGS_SCRIPT,
  warnOnClockSkewClamp,
  type TagManifest,
  type TagState,
} from "../../../src/pool-server/valkey-cache/tag-manifest.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const manifest = (entries: Record<string, TagState>): TagManifest =>
  new Map(Object.entries(entries));

const NOW = 1_000_000;

describe("areTagsExpired (mirrors Next tags-manifest.external.js)", () => {
  it("expires when a tag's expired watermark is in the past and newer than the entry", () => {
    const m = manifest({ a: { expired: 500 } });
    // entry created before the watermark, watermark already elapsed
    expect(areTagsExpired(["a"], 400, m, NOW)).toBe(true);
  });

  it("does NOT expire on a FUTURE expired watermark (stays stale/SWR)", () => {
    // profiled revalidateTag sets expired = now + expire*1000, i.e. in the future
    const m = manifest({ a: { stale: NOW, expired: NOW + 300_000 } });
    expect(areTagsExpired(["a"], NOW - 10, m, NOW)).toBe(false);
  });

  it("does NOT expire when the watermark predates the entry (entry is newer)", () => {
    const m = manifest({ a: { expired: 500 } });
    expect(areTagsExpired(["a"], 600, m, NOW)).toBe(false);
  });

  it("returns false for tags with no manifest entry", () => {
    expect(areTagsExpired(["missing"], 400, manifest({}), NOW)).toBe(false);
  });
});

describe("areTagsStale", () => {
  it("is stale when a tag's stale watermark is newer than the entry", () => {
    expect(areTagsStale(["a"], 400, manifest({ a: { stale: 500 } }))).toBe(true);
  });
  it("is not stale when the watermark predates the entry", () => {
    expect(areTagsStale(["a"], 600, manifest({ a: { stale: 500 } }))).toBe(false);
  });
});

describe("computeTagUpdate (mirrors default.js updateTags)", () => {
  it("with a duration: marks stale=now and expired=now+expire*1000", () => {
    expect(computeTagUpdate(undefined, NOW, { expire: 300 })).toEqual({
      stale: NOW,
      expired: NOW + 300_000,
      at: NOW,
    });
  });

  it("without durations: immediate expiry (expired=now), no stale", () => {
    expect(computeTagUpdate(undefined, NOW)).toEqual({ expired: NOW, at: NOW });
  });

  it("preserves existing fields and stamps the event time", () => {
    expect(computeTagUpdate({ stale: 1, expired: 2 }, NOW, {})).toEqual({
      stale: NOW,
      expired: 2,
      at: NOW,
    });
  });

  it("hard expire preserves a stored stale watermark (per-dimension merge, M12)", () => {
    // The server-side script merges an event's SET dimensions into the stored state; a hard
    // expire only sets `expired`, so a prior profile's `stale` watermark must survive. This
    // mirrors Next's read-modify-write (`{...existing, expired: now}`).
    expect(computeTagUpdate({ stale: 1 }, NOW)).toEqual({ stale: 1, expired: NOW, at: NOW });
  });

  it("a profile without `expire` leaves `expired` unset for the server-side merge (M12)", () => {
    // The event must NOT carry an `expired` key — otherwise the merge would (correctly)
    // replace the stored one. The stored hard-expire watermark is preserved by the script.
    const event = computeTagUpdate(undefined, NOW, {});
    expect(event).toEqual({ stale: NOW, at: NOW });
    expect("expired" in event).toBe(false);
  });
});

describe("maxExpiration (mirrors default.js getExpiration)", () => {
  it("returns the max expired watermark across tags, 0 if none", () => {
    const m = manifest({ a: { expired: 100 }, b: { expired: 900 }, c: {} });
    expect(maxExpiration(["a", "b", "c"], m)).toBe(900);
    expect(maxExpiration(["c", "missing"], m)).toBe(0);
  });
});

describe("UPDATE_TAGS_SCRIPT (L7: merge ordered on the server clock)", () => {
  it("takes the merge timestamp from the server's TIME, not an ARGV-supplied `at`", () => {
    expect(UPDATE_TAGS_SCRIPT).toContain("redis.call('TIME')");
    // The incoming state's `at` is rewritten to the server time before comparing/storing.
    expect(UPDATE_TAGS_SCRIPT).toContain("nw.at = now");
    // The merge comparison is against the server clock, never a client-parsed `nw.at`.
    expect(UPDATE_TAGS_SCRIPT).not.toContain("nwAt");
  });
});

describe("UPDATE_TAGS_SCRIPT (M11: the manifest key itself is TTL-bounded)", () => {
  it("EXPIREs the manifest key from the trailing ARGV ttl on every write", () => {
    expect(UPDATE_TAGS_SCRIPT).toContain("redis.call('EXPIRE', KEYS[1], ttlSeconds)");
    // The ttl is read off the END of ARGV, and the field/json pairs stop before it.
    expect(UPDATE_TAGS_SCRIPT).toContain("tonumber(ARGV[#ARGV])");
    expect(UPDATE_TAGS_SCRIPT).toContain("pairCount = #ARGV - 1");
    expect(UPDATE_TAGS_SCRIPT).toContain("while i <= pairCount");
    // 30 days, mirroring DURABLE_TTL_SECONDS for entry keys.
    expect(TAG_MANIFEST_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });
});

describe("UPDATE_TAGS_SCRIPT (M12: per-dimension merge, not whole-field replace)", () => {
  it("preserves stored watermarks the incoming event did not set", () => {
    // A profiled event without `expire` (only `{stale, at}`) must not erase a stored
    // hard-expire `expired` watermark, and a hard expire must not erase a stored `stale`.
    expect(UPDATE_TAGS_SCRIPT).toContain("if nw.stale == nil then nw.stale = cur.stale end");
    expect(UPDATE_TAGS_SCRIPT).toContain("if nw.expired == nil then nw.expired = cur.expired end");
    // The merge only happens for the event that WINS the server-clock ordering.
    expect(UPDATE_TAGS_SCRIPT).toContain("if now < curAt then");
  });
});

describe("UPDATE_TAGS_SCRIPT (L16: fast-clock watermarks are clamped to the server clock)", () => {
  it("clamps stale/hard-expired watermarks past the skew bound and reports the count", () => {
    const bound = String(MAX_CLOCK_SKEW_MS);
    expect(MAX_CLOCK_SKEW_MS).toBe(60_000);
    expect(UPDATE_TAGS_SCRIPT).toContain(`nw.stale > now + ${bound}`);
    // A hard expire (no stale) has its expired watermark clamped directly.
    expect(UPDATE_TAGS_SCRIPT).toContain(`nw.expired = now + ${bound}`);
    // A profiled event's expired watermark is SHIFTED with its stale base (duration preserved).
    expect(UPDATE_TAGS_SCRIPT).toContain("nw.expired = nw.expired - shift");
    // The script returns the clamp count so callers can warn.
    expect(UPDATE_TAGS_SCRIPT).toContain("return clamped");
  });
});

describe("warnOnClockSkewClamp (L16)", () => {
  it("warns once when the script reports clamping, silently otherwise", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnOnClockSkewClamp(0);
    warnOnClockSkewClamp(null);
    warnOnClockSkewClamp(undefined);
    expect(warn).not.toHaveBeenCalled();
    warnOnClockSkewClamp(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/clock/);
    warnOnClockSkewClamp(1); // once per process
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("parseTagState (L5: corrupt manifest fields degrade safely)", () => {
  it("parses a well-formed state", () => {
    expect(parseTagState(JSON.stringify({ stale: 1, expired: 2, at: 3 }))).toEqual({
      stale: 1,
      expired: 2,
      at: 3,
    });
  });

  it("returns undefined for invalid JSON", () => {
    expect(parseTagState("{not json")).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    expect(parseTagState("42")).toBeUndefined();
    expect(parseTagState('"str"')).toBeUndefined();
    expect(parseTagState("null")).toBeUndefined();
    expect(parseTagState("[1,2]")).toBeUndefined();
  });

  it("treats a corrupt `at` as 0 (older than any real event in the merge)", () => {
    expect(parseTagState(JSON.stringify({ expired: 5, at: "soon" }))).toEqual({
      expired: 5,
      at: 0,
    });
    expect(parseTagState(JSON.stringify({ expired: 5 }))).toEqual({ expired: 5, at: 0 });
  });

  it("drops non-finite watermarks instead of poisoning freshness predicates", () => {
    // JSON can't represent Infinity/NaN, but a hand-corrupted field can carry strings/null.
    expect(parseTagState(JSON.stringify({ stale: "x", expired: null, at: 7 }))).toEqual({
      at: 7,
    });
  });
});

describe("evaluateEntry (three-state freshness)", () => {
  const base = { timestamp: NOW, revalidate: 60, expire: 300, tags: ["a"] };

  it("fresh within the revalidate window", () => {
    expect(evaluateEntry(base, manifest({}), NOW + 10_000)).toEqual({
      state: "fresh",
      revalidate: 60,
    });
  });

  it("stale past the revalidate window but within expire", () => {
    expect(evaluateEntry(base, manifest({}), NOW + 120_000)).toEqual({ state: "stale" });
  });

  it("expired past the expire window", () => {
    expect(evaluateEntry(base, manifest({}), NOW + 400_000)).toEqual({ state: "expired" });
  });

  it("expired when an explicit tag was hard-revalidated (no duration)", () => {
    const m = manifest({ a: computeTagUpdate(undefined, NOW + 5_000) });
    expect(evaluateEntry(base, m, NOW + 10_000)).toEqual({ state: "expired" });
  });

  it("stale (not expired) when an explicit tag was revalidated with a future expire", () => {
    const m = manifest({ a: computeTagUpdate(undefined, NOW + 5_000, { expire: 300 }) });
    // watermark stale=NOW+5000 > entry timestamp NOW → stale; expired is in the future → not dropped
    expect(evaluateEntry(base, m, NOW + 10_000)).toEqual({ state: "stale" });
  });
});
