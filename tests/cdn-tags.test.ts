// tests/cdn-tags.test.ts
import { describe, it, expect } from "vitest";
import { cdnTagForBuildId, cdnCacheTag } from "../src/cdn-tags.js";

describe("cdnTagForBuildId", () => {
  it("is deterministic, comma-free, and <=120 bytes for adversarial ids", () => {
    for (const id of ["ok-123", "has,comma", "  spaces ", "ünïcodé", "x".repeat(5000)]) {
      const t = cdnTagForBuildId(id);
      expect(t).toMatch(/^build-[0-9a-f]{64}$/);
      expect(t).not.toContain(",");
      expect(Buffer.byteLength(t)).toBeLessThanOrEqual(120);
    }
  });

  it("maps distinct ids to distinct tags and is stable", () => {
    expect(cdnTagForBuildId("a")).toBe(cdnTagForBuildId("a"));
    expect(cdnTagForBuildId("a")).not.toBe(cdnTagForBuildId("b"));
  });
});

describe("cdnCacheTag", () => {
  it("tags mutable cacheable (max-age>0, non-immutable) with the SAFE tag", () => {
    expect(cdnCacheTag("public, max-age=3600", "b123")).toEqual({
      "cache-tag": cdnTagForBuildId("b123"),
    });
  });

  it("does NOT tag immutable/versioned assets", () => {
    expect(cdnCacheTag("public, max-age=31536000, immutable", "b123")).toEqual({});
  });

  it("does not tag non-cacheable, and no-ops without a build id", () => {
    expect(cdnCacheTag("public, max-age=0, must-revalidate", "b123")).toEqual({});
    expect(cdnCacheTag("no-store", "b123")).toEqual({});
    expect(cdnCacheTag("public, max-age=3600", undefined)).toEqual({});
    expect(cdnCacheTag("public, max-age=3600", "")).toEqual({});
  });

  it("uses the shared Cache-Control parser for every shared-cache freshness form", () => {
    const tag = { "cache-tag": cdnTagForBuildId("b123") };
    expect(cdnCacheTag('public, max-age="3600"', "b123")).toEqual(tag);
    expect(cdnCacheTag("max-age=0, stale-while-revalidate=600", "b123")).toEqual(tag);
    expect(cdnCacheTag("max-age=0, stale-if-error=600", "b123")).toEqual(tag);
    expect(cdnCacheTag('private="set-cookie", s-maxage=600', "b123")).toEqual(tag);
    expect(cdnCacheTag("x-no-store, s-maxage=600", "b123")).toEqual(tag);
  });

  it("matches immutable and storage vetoes by exact unqualified directive name", () => {
    const tag = { "cache-tag": cdnTagForBuildId("b123") };
    expect(cdnCacheTag("x-immutable, max-age=3600", "b123")).toEqual(tag);
    expect(cdnCacheTag('immutable="field", max-age=3600', "b123")).toEqual(tag);
    expect(cdnCacheTag('no-cache="set-cookie", max-age=3600', "b123")).toEqual(tag);
    expect(cdnCacheTag("no-cache, max-age=3600", "b123")).toEqual({});
  });

  it("INVARIANT: handler/PPR responses are non-cacheable → never tagged", () => {
    // `writeInnerResponse` forces exactly this cache-control on x-nextjs-cache responses
    // (dispatch.ts), so PPR/handler output is never CDN-cached and correctly carries no tag.
    // If a future cacheable PPR shell is introduced, it must route through cdnCacheTag.
    expect(cdnCacheTag("public, max-age=0, must-revalidate", "b123")).toEqual({});
  });
});
