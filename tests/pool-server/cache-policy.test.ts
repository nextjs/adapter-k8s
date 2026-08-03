import { describe, expect, it } from "vitest";
import {
  createPprRouteMatcher,
  explicitCacheControlWins,
  forcedCdnCacheControl,
} from "../../src/pool-server/cache-policy.js";
import { grantsSharedCacheFreshness } from "../../src/routing-common.js";

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

// N30 (SECURITY/CACHE): the PPR `no-store` verdict came ONLY from `x-nextjs-ppr`, a header the
// ext_proc tier stamps — so every pool-only path (fail-open, CEL-excluded path, an app with no
// middleware and therefore no extension at all, timeout shed, body request, cross-pool hop)
// silently lost it and shipped the entrypoint's own `s-maxage=31536000` UNTAGGED. The pool holds
// the PPR inventory locally; this matcher is what lets it decide for itself.
describe("createPprRouteMatcher", () => {
  const rscConfig = { header: "rsc", suffix: ".rsc" };

  it("matches a static PPR route and its .rsc output without any header", () => {
    const isPpr = createPprRouteMatcher({
      pprRoutes: { "/ssr": {} },
      rscConfig,
    });
    expect(isPpr("/ssr")).toBe(true);
    expect(isPpr("/ssr.rsc")).toBe(true);
    expect(isPpr("/ssr/")).toBe(true);
    expect(isPpr("/not-ppr")).toBe(false);
    // A prefix must not match: `/ssr-adjacent` is a different route.
    expect(isPpr("/ssr-adjacent")).toBe(false);
  });

  it("matches concrete paths under a dynamic PPR template", () => {
    const isPpr = createPprRouteMatcher({
      pprRoutes: { "/blog/[slug]": {} },
      pprCapableRoutes: { "/docs/[...parts]": { rootParams: [] } },
      rscConfig,
    });
    expect(isPpr("/blog/hello")).toBe(true);
    expect(isPpr("/blog/hello.rsc")).toBe(true);
    // A dynamic segment is exactly one segment.
    expect(isPpr("/blog/hello/world")).toBe(false);
    expect(isPpr("/blog")).toBe(false);
    expect(isPpr("/docs/a/b/c")).toBe(true);
    expect(isPpr("/docs")).toBe(false);
  });

  it("honors an optional catch-all at its own root", () => {
    const isPpr = createPprRouteMatcher({ pprRoutes: { "/shop/[[...rest]]": {} } });
    expect(isPpr("/shop")).toBe(true);
    expect(isPpr("/shop/a/b")).toBe(true);
    expect(isPpr("/shopping")).toBe(false);
  });

  it("strips basePath and an i18n locale prefix before matching", () => {
    const isPpr = createPprRouteMatcher({
      pprRoutes: { "/docs/ssr": {} },
      basePath: "/docs",
      i18nLocales: ["en-US", "fr"],
      rscConfig,
    });
    // The output id as the manifest keys it, the public path, and a locale-prefixed request.
    expect(isPpr("/docs/ssr")).toBe(true);
    expect(isPpr("/ssr")).toBe(true);
    expect(isPpr("/docs/fr/ssr")).toBe(true);
    expect(isPpr("/docs/other")).toBe(false);
  });

  it("keeps the interception marker out of the URL grammar", () => {
    const isPpr = createPprRouteMatcher({ pprRoutes: { "/[locale]/(.)[user]/p/[id]": {} } });
    expect(isPpr("/en/foo/p/1")).toBe(true);
    expect(isPpr("/en/foo/p")).toBe(false);
  });

  it("is a cheap constant `false` when the build has no PPR routes at all", () => {
    const isPpr = createPprRouteMatcher({ pprRoutes: {}, pprCapableRoutes: {} });
    expect(isPpr("/anything")).toBe(false);
    expect(isPpr("/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// S24 — RFC 9111 qualified `no-cache="field"` / `private="field"` must not veto the
// shared-freshness check. A bare \bno-cache\b test matched them, so
// `no-cache="set-cookie", s-maxage=600` was classified as granting no freshness and honored
// verbatim on a middleware-covered route — a shared cache implementing the qualified
// semantics then serves unrevalidated hits for the whole window, and because ext_proc is
// post-cache those hits never reach middleware.
// ---------------------------------------------------------------------------
describe("grantsSharedCacheFreshness: qualified directives (S24)", () => {
  it("still treats the UNQUALIFIED forms as an absolute veto", () => {
    for (const cc of ["no-cache", "no-cache, s-maxage=600", "private, max-age=600", "no-store"]) {
      expect(grantsSharedCacheFreshness(cc)).toBe(false);
    }
  });

  it("sees through the ARGUMENTED forms to the freshness they still grant", () => {
    expect(grantsSharedCacheFreshness('no-cache="set-cookie", s-maxage=600')).toBe(true);
    expect(grantsSharedCacheFreshness('private="x-user", s-maxage=600')).toBe(true);
    expect(grantsSharedCacheFreshness('no-cache="set-cookie", max-age=0')).toBe(false);
  });

  it("is refused as an app override on a middleware-covered route", () => {
    // The end-to-end consequence: this value must not survive onto a covered response.
    expect(
      explicitCacheControlWins({
        forced: "no-cache",
        resolvedCacheControl: 'no-cache="set-cookie", s-maxage=600',
        responseCacheControls: [],
      }),
    ).toBe(false);
  });
});

// S41 (SECURITY/CACHE): directive names are tokens, not word-boundary substrings. Treating the
// `no-store` inside `x-no-store` as the real directive let an accompanying s-maxage override the
// middleware no-cache guard, creating a CDN hit path that never reaches ext_proc.
describe("explicitCacheControlWins: exact directive parsing (S41)", () => {
  const wins = (resolvedCacheControl: string): boolean =>
    explicitCacheControlWins({
      forced: "no-cache",
      resolvedCacheControl,
      responseCacheControls: [],
    });

  it("refuses extension names and quoted values that only contain veto directive text", () => {
    for (const cacheControl of [
      "x-no-store, s-maxage=600",
      'x-policy="no-store", s-maxage=600',
      'x-policy="no-cache, private", s-maxage=600',
      "almost-private, max-age=600",
    ]) {
      expect(wins(cacheControl), cacheControl).toBe(false);
    }
  });

  it("still honors exact unqualified vetoes and zero-freshness policies", () => {
    for (const cacheControl of [
      "no-store",
      "no-store, s-maxage=600",
      "no-cache",
      "private",
      "public, max-age=0, must-revalidate",
    ]) {
      expect(wins(cacheControl), cacheControl).toBe(true);
    }
  });

  it("does not mistake no-store text in the entrypoint response for a real veto", () => {
    expect(
      explicitCacheControlWins({
        forced: "no-cache",
        resolvedCacheControl: "public, max-age=0",
        responseCacheControls: ["x-no-store"],
      }),
    ).toBe(true);
    expect(
      explicitCacheControlWins({
        forced: "no-cache",
        resolvedCacheControl: "public, max-age=0",
        responseCacheControls: ["no-store"],
      }),
    ).toBe(false);
  });
});
