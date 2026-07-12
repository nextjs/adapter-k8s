import { describe, expect, it } from "vitest";
import {
  areTagsExpired,
  areTagsStale,
  computeTagUpdate,
  evaluateEntry,
  maxExpiration,
  type TagManifest,
  type TagState,
} from "../../../src/pool-server/valkey-cache/tag-manifest.js";

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
});

describe("maxExpiration (mirrors default.js getExpiration)", () => {
  it("returns the max expired watermark across tags, 0 if none", () => {
    const m = manifest({ a: { expired: 100 }, b: { expired: 900 }, c: {} });
    expect(maxExpiration(["a", "b", "c"], m)).toBe(900);
    expect(maxExpiration(["c", "missing"], m)).toBe(0);
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
