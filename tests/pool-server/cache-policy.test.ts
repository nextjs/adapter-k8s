import { describe, expect, it } from "vitest";
import { forcedCdnCacheControl } from "../../src/pool-server/cache-policy.js";

describe("forcedCdnCacheControl", () => {
  it("forces production middleware matches to revalidate at the CDN boundary", () => {
    expect(
      forcedCdnCacheControl({
        isPprRoute: false,
        middlewareCovers: true,
        emulateNextServer: false,
      }),
    ).toBe("no-cache");
  });

  it("preserves Next response semantics only in the CDN-less deploy-test harness", () => {
    expect(
      forcedCdnCacheControl({
        isPprRoute: false,
        middlewareCovers: true,
        emulateNextServer: true,
      }),
    ).toBeNull();
  });

  it("never permits a streamed PPR response into Cloud CDN", () => {
    expect(
      forcedCdnCacheControl({
        isPprRoute: true,
        middlewareCovers: true,
        emulateNextServer: true,
      }),
    ).toBe("no-store");
  });
});
