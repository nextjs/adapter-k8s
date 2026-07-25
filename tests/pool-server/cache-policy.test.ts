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

  // N18 (SECURITY): an RSC request whose `_rsc` doesn't authenticate its RSC headers must not
  // produce a STORABLE response — poisoning needs storage, so `no-store` closes the class.
  describe("unvalidated RSC cache-busting param", () => {
    it("forces no-store", () => {
      expect(
        forcedCdnCacheControl({
          isPprRoute: false,
          middlewareCovers: false,
          emulateNextServer: false,
          rscHeadersUnvalidated: true,
        }),
      ).toBe("no-store");
    });

    it("outranks the middleware `no-cache` verdict (no-cache still permits storage)", () => {
      expect(
        forcedCdnCacheControl({
          isPprRoute: false,
          middlewareCovers: true,
          emulateNextServer: false,
          rscHeadersUnvalidated: true,
        }),
      ).toBe("no-store");
    });

    it("is NOT exempted in the deploy-test harness — `next start` 307s these requests, so a", () => {
      // cacheable response is not `next start` parity either; `no-store` is closer to it.
      expect(
        forcedCdnCacheControl({
          isPprRoute: false,
          middlewareCovers: true,
          emulateNextServer: true,
          rscHeadersUnvalidated: true,
        }),
      ).toBe("no-store");
    });

    it("changes nothing when the param validates (default false ⇒ existing callers unaffected)", () => {
      expect(
        forcedCdnCacheControl({
          isPprRoute: false,
          middlewareCovers: false,
          emulateNextServer: false,
          rscHeadersUnvalidated: false,
        }),
      ).toBeNull();
    });
  });
});
