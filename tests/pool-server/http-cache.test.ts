import { describe, expect, it } from "vitest";
import { ifNoneMatchMatches, staticAssetEtag } from "../../src/pool-server/http-cache.js";

describe("static asset HTTP validators", () => {
  it("uses stable content identity rather than replica-local file metadata", () => {
    expect(staticAssetEtag(Buffer.from("same bytes"))).toBe(
      staticAssetEtag(Buffer.from("same bytes")),
    );
    expect(staticAssetEtag(Buffer.from("same bytes"))).not.toBe(
      staticAssetEtag(Buffer.from("different bytes")),
    );
  });

  it("accepts weak, list, and wildcard If-None-Match validators", () => {
    const etag = staticAssetEtag(Buffer.from("worker"));
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
  });
});

