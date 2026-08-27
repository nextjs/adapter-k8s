// tests/routing-common.test.ts
//
// Unit tests for the shared routing helpers added during the e2e-conformance
// pass. Every case here mirrors upstream `next start` behavior that was
// verified empirically against the Next.js e2e deploy suite fixtures:
//  - prefixRequestLocale:      @next/routing never surfaces its internal
//                              locale-prefixed URL, and malformes the root.
//  - normalizeI18nRedirect:    detection redirects get "/fr/" → "/fr"; rule
//                              redirects must not leak the auto-added locale
//                              but must keep explicit `locale: false` targets.
//  - normalizeLocationRedirect: `Location: /$1` rules can't preserve the query
//                              and capture the internal locale prefix.
//  - collapseSlashesRedirect:  upstream 308s "//foo" to "/foo".
//  - normalizeMatchedPathname: trailingSlash keys outputs without a slash and
//                              the root as "/index".
//  - preferConcreteOutput:     prerenders beat dynamic templates, with
//                              percent-decoded lookup.
//  - rscParentCandidates:      .rsc / segment payloads dispatch to the parent
//                              page handler.
//  - stripAddedLocale /         the de-duplicated helpers behind the single
//    queryFromUrl /             rewrite-invocation derivation both tiers now
//    isRscRequest /             share (see routing-common.tier-parity.test.ts
//    resolveOutputPathname:     for the cross-tier assertions).
import { describe, it, expect, vi } from "vitest";
import {
  assertValidRoutingManifest,
  collapseSlashesRedirect,
  fitsPoolHeaderBudget,
  grantsSharedCacheFreshness,
  headerBlockBytes,
  POOL_HEADER_BUDGET_RESERVE_BYTES,
  POOL_MAX_HEADER_BYTES,
  middlewareAuthoredRedirect,
  serializeHeaderMap,
  isRscRequest,
  localeAlignedRouteParamPathname,
  normalizeI18nRedirect,
  normalizeLocationRedirect,
  normalizeMatchedPathname,
  normalizeResolvedRedirect,
  parseRequestUrl,
  preferConcreteOutput,
  prefixRequestLocale,
  prepareRequest,
  queryFromUrl,
  resolveOutputPathname,
  rscParentCandidates,
  stripAddedLocale,
  stripBasePath,
  templateOutputCandidates,
} from "../src/routing-common.js";

const I18N = { locales: ["en", "fr", "sv"], defaultLocale: "en" };

function url(path: string, base = "http://localhost:3000"): URL {
  // Construct like the resolvers do (`scheme://authority` + raw path) so paths
  // with leading "//" aren't mis-parsed as protocol-relative URLs.
  return new URL(base + path);
}

describe("parseRequestUrl", () => {
  it("rejects absolute-form and asterisk-form targets instead of replacing Host authority", () => {
    expect(() => parseRequestUrl("http://evil.example/path", "app.example.com")).toThrow(
      /origin-form/,
    );
    expect(() => parseRequestUrl("*", "app.example.com")).toThrow(/origin-form/);
  });

  it("keeps protocol-relative-looking targets under the validated Host authority", () => {
    const parsed = parseRequestUrl("//evil.example/path", "app.example.com");
    expect(parsed.origin).toBe("http://app.example.com");
    expect(parsed.pathname).toBe("//evil.example/path");
  });
});

describe("prefixRequestLocale", () => {
  it("prefixes the root with the default locale", () => {
    const u = url("/");
    const added = prefixRequestLocale(u, new Headers(), I18N, "");
    expect(u.pathname).toBe("/en");
    expect(added).toBe("en");
  });

  it("prefixes the root in slashed form when trailingSlash is on", () => {
    const u = url("/");
    prefixRequestLocale(u, new Headers(), I18N, "", true);
    expect(u.pathname).toBe("/en/");
  });

  it("prefixes non-root paths and preserves their slash shape", () => {
    const a = url("/about");
    prefixRequestLocale(a, new Headers(), I18N, "");
    expect(a.pathname).toBe("/en/about");

    const b = url("/about/");
    prefixRequestLocale(b, new Headers(), I18N, "");
    expect(b.pathname).toBe("/en/about/");
  });

  it("keeps already-prefixed paths untouched", () => {
    const u = url("/fr/about");
    const added = prefixRequestLocale(u, new Headers(), I18N, "");
    expect(u.pathname).toBe("/fr/about");
    expect(added).toBeNull();
  });

  it("skips /_next/ and /api/ paths", () => {
    for (const p of ["/_next/static/x.js", "/api/hello"]) {
      const u = url(p);
      prefixRequestLocale(u, new Headers(), I18N, "");
      expect(u.pathname).toBe(p);
    }
  });

  it("respects basePath", () => {
    const u = url("/base/about");
    prefixRequestLocale(u, new Headers(), I18N, "/base");
    expect(u.pathname).toBe("/base/en/about");
  });

  it("uses the default locale for non-root paths despite a preferred locale", () => {
    const u = url("/about");
    const headers = new Headers({ cookie: "NEXT_LOCALE=fr" });
    const added = prefixRequestLocale(u, headers, I18N, "");
    expect(u.pathname).toBe("/en/about");
    expect(added).toBe("en");
  });

  it("leaves the index alone when detection picks a non-default locale", () => {
    for (const pathname of ["/", "/index"]) {
      const u = url(pathname);
      const headers = new Headers({ cookie: "NEXT_LOCALE=fr" });
      expect(prefixRequestLocale(u, headers, I18N, "")).toBeNull();
      expect(u.pathname).toBe(pathname);
    }
  });

  it("honors the NEXT_LOCALE cookie when it matches the default", () => {
    const u = url("/");
    const headers = new Headers({ cookie: "NEXT_LOCALE=en", "accept-language": "fr" });
    // cookie wins over accept-language, and en === default → prefix
    prefixRequestLocale(u, headers, I18N, "");
    expect(u.pathname).toBe("/en");
  });

  it("does nothing without i18n", () => {
    const u = url("/");
    expect(prefixRequestLocale(u, new Headers(), null, "")).toBeNull();
    expect(u.pathname).toBe("/");
  });
});

describe("normalizeI18nRedirect", () => {
  it("keeps redirects when the request was already locale-scoped", () => {
    const r = normalizeI18nRedirect(
      { url: url("/sv/newpage"), status: 307 },
      url("/en/to-sv"),
      I18N,
      "",
    );
    expect(r.kind).toBe("keep");
  });

  it("fixes the detection redirect's root slash artifact (/fr/ → /fr)", () => {
    const r = normalizeI18nRedirect({ url: url("/fr/"), status: 307 }, url("/"), I18N, "");
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") expect(r.url.pathname).toBe("/fr");
  });

  it("keeps a non-root detection redirect", () => {
    const r = normalizeI18nRedirect(
      { url: url("/fr/about"), status: 307 },
      url("/about"),
      I18N,
      "",
    );
    expect(r.kind).toBe("keep");
  });

  it("turns the internal 308 trailing-slash artifact into a retry", () => {
    const r = normalizeI18nRedirect({ url: url("/en"), status: 308 }, url("/"), I18N, "");
    expect(r.kind).toBe("retry");
    if (r.kind === "retry") expect(r.retryUrl.pathname).toBe("/en");
  });

  it("preserves the query on retry", () => {
    const r = normalizeI18nRedirect({ url: url("/en"), status: 308 }, url("/?q=1"), I18N, "");
    if (r.kind === "retry") expect(r.retryUrl.search).toBe("?q=1");
    expect(r.kind).toBe("retry");
  });

  it("keeps explicit different-locale destinations (locale: false rules)", () => {
    const r = normalizeI18nRedirect(
      { url: url("/sv/newpage"), status: 307 },
      url("/to-sv"),
      I18N,
      "",
      "en",
    );
    expect(r.kind).toBe("keep");
  });

  it("strips the auto-added locale from rule redirect targets", () => {
    const r = normalizeI18nRedirect(
      { url: url("/en/somewhere/else"), status: 307 },
      url("/redirect-1"),
      I18N,
      "",
      "en",
    );
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") expect(r.url.pathname).toBe("/somewhere/else");
  });

  it("keeps locale-bearing targets when no locale was auto-added", () => {
    const r = normalizeI18nRedirect(
      { url: url("/en/somewhere/else"), status: 307 },
      url("/redirect-1"),
      I18N,
      "",
      null,
    );
    expect(r.kind).toBe("keep");
  });

  it("fixes the root slash artifact on cross-origin domain redirects only", () => {
    const r = normalizeI18nRedirect(
      { url: url("/fr/", "https://example.fr"), status: 307 },
      url("/"),
      I18N,
      "",
    );
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") {
      expect(r.url.origin).toBe("https://example.fr");
      expect(r.url.pathname).toBe("/fr");
    }

    const keep = normalizeI18nRedirect(
      { url: url("/fr/about", "https://example.fr"), status: 307 },
      url("/about"),
      I18N,
      "",
    );
    expect(keep.kind).toBe("keep");
  });

  it("applies basePath when stripping", () => {
    const r = normalizeI18nRedirect(
      { url: url("/base/en/somewhere"), status: 307 },
      url("/base/redirect-1"),
      I18N,
      "/base",
      "en",
    );
    expect(r.kind).toBe("rewrite");
    if (r.kind === "rewrite") expect(r.url.pathname).toBe("/base/somewhere");
  });
});

describe("normalizeLocationRedirect", () => {
  it("preserves the query on pure slash-flip redirects", () => {
    const target = url("/redirects");
    normalizeLocationRedirect(target, url("/redirects/?success=true"), null, "");
    expect(target.search).toBe("?success=true");
  });

  it("does not touch redirects to different paths", () => {
    const target = url("/other");
    normalizeLocationRedirect(target, url("/page?q=1"), null, "");
    expect(target.search).toBe("");
    expect(target.pathname).toBe("/other");
  });

  it("does not override a target that already has a query", () => {
    const target = url("/redirects?keep=me");
    normalizeLocationRedirect(target, url("/redirects/?other=1"), null, "");
    expect(target.search).toBe("?keep=me");
  });

  it("strips the internal locale from slash-flip redirects", () => {
    // trailing-slash rule ran on the internally-prefixed path: /about → /en/about/
    const target = url("/en/about/");
    normalizeLocationRedirect(target, url("/about"), I18N, "");
    expect(target.pathname).toBe("/about/");
  });

  it("strips the auto-added locale from rule Location targets", () => {
    const target = url("/en/somewhere/else");
    normalizeLocationRedirect(target, url("/redirect-1"), I18N, "", "en");
    expect(target.pathname).toBe("/somewhere/else");
  });

  it("keeps deliberate different-locale Location targets", () => {
    const target = url("/sv/newpage");
    normalizeLocationRedirect(target, url("/to-sv"), I18N, "", "en");
    expect(target.pathname).toBe("/sv/newpage");
  });

  it("keeps locale targets when the request was locale-scoped", () => {
    const target = url("/en/about/");
    normalizeLocationRedirect(target, url("/en/about"), I18N, "", null);
    expect(target.pathname).toBe("/en/about/");
  });

  it("ignores cross-origin targets", () => {
    const target = url("/en/about/", "https://elsewhere.example");
    normalizeLocationRedirect(target, url("/about?q=1"), I18N, "", "en");
    expect(target.pathname).toBe("/en/about/");
    expect(target.search).toBe("");
  });
});

describe("collapseSlashesRedirect", () => {
  it("returns null for normal paths", () => {
    expect(collapseSlashesRedirect(url("/a/b"))).toBeNull();
    expect(collapseSlashesRedirect(url("/"))).toBeNull();
  });

  it("collapses duplicate slashes and preserves the query", () => {
    const r = collapseSlashesRedirect(url("/base//to-sv?q=1"));
    expect(r).not.toBeNull();
    expect(r!.pathname).toBe("/base/to-sv");
    expect(r!.search).toBe("?q=1");
  });

  it("collapses runs of slashes anywhere in the path", () => {
    expect(collapseSlashesRedirect(url("///a///b//"))!.pathname).toBe("/a/b/");
  });
});

describe("normalizeMatchedPathname", () => {
  const assignments = { "/about": "default", "/index": "default" };

  it("keeps exact matches", () => {
    expect(normalizeMatchedPathname("/about", assignments)).toBe("/about");
  });

  it("maps trailing-slash requests to the slashless output key", () => {
    expect(normalizeMatchedPathname("/about/", assignments)).toBe("/about");
  });

  it("maps the root to /index when only /index is registered", () => {
    expect(normalizeMatchedPathname("/", assignments)).toBe("/index");
  });

  it("prefers a real '/' assignment over /index", () => {
    expect(normalizeMatchedPathname("/", { "/": "default", "/index": "default" })).toBe("/");
  });

  it("passes unknown pathnames through", () => {
    expect(normalizeMatchedPathname("/missing", assignments)).toBe("/missing");
  });
});

describe("preferConcreteOutput", () => {
  const assignments = {
    "/[id]": "default",
    "/sticks & stones": "default",
    "/plain": "default",
  };

  it("prefers a concrete prerender over a dynamic template", () => {
    expect(preferConcreteOutput("/sticks & stones", "/[id]", assignments)).toBe("/sticks & stones");
  });

  it("decodes the request path when looking up outputs", () => {
    expect(preferConcreteOutput("/sticks%20%26%20stones", "/[id]", assignments)).toBe(
      "/sticks & stones",
    );
  });

  it("ignores a request trailing slash when preferring a concrete output", () => {
    expect(preferConcreteOutput("/plain/", "/[id]", assignments)).toBe("/plain");
  });

  it("keeps a non-template resolution even when the request path is an output", () => {
    expect(preferConcreteOutput("/plain", "/plain", assignments)).toBeUndefined();
  });

  it("returns undefined when nothing concrete exists", () => {
    expect(preferConcreteOutput("/unknown", "/[id]", assignments)).toBeUndefined();
  });

  it("survives malformed percent-encoding", () => {
    expect(preferConcreteOutput("/%zz", "/[id]", assignments)).toBeUndefined();
  });
});

describe("rscParentCandidates", () => {
  const rsc = {
    header: "rsc",
    suffix: ".rsc",
    prefetchSegmentHeader: "next-router-segment-prefetch",
    prefetchSegmentDirSuffix: ".segments",
    prefetchSegmentSuffix: ".segment.rsc",
  };

  it("maps .rsc payloads to the parent page", () => {
    expect(rscParentCandidates("/page.rsc", rsc)).toEqual(["/page"]);
  });

  it("maps the root .rsc through /index to /", () => {
    expect(rscParentCandidates("/index.rsc", rsc)).toEqual(["/", "/index"]);
  });

  it("maps segment payloads to the parent page", () => {
    expect(rscParentCandidates("/page.segments/_tree.segment.rsc", rsc)).toEqual(["/page"]);
    expect(rscParentCandidates("/index.segments/__PAGE__.segment.rsc", rsc)).toEqual([
      "/",
      "/index",
    ]);
  });

  it("returns nothing for plain pathnames or missing config", () => {
    expect(rscParentCandidates("/page", rsc)).toEqual([]);
    expect(rscParentCandidates("/page.rsc", undefined)).toEqual([]);
  });
});

describe("stripBasePath", () => {
  it("strips only at segment boundaries", () => {
    expect(stripBasePath("/docs/page", "/docs")).toBe("/page");
    expect(stripBasePath("/docs", "/docs")).toBe("/");
    expect(stripBasePath("/docsy", "/docs")).toBe("/docsy");
    expect(stripBasePath("/page", "")).toBe("/page");
  });
});

describe("templateOutputCandidates", () => {
  const ids = ["/blog/[slug]", "/docs/[...parts]", "/opt/[[...rest]]", "/static", "/a/[b]/c"];

  it("matches dynamic segments", () => {
    expect(templateOutputCandidates("/blog/hello", ids)).toEqual(["/blog/[slug]"]);
    expect(templateOutputCandidates("/a/x/c", ids)).toEqual(["/a/[b]/c"]);
  });

  it("matches catch-alls and optional catch-alls", () => {
    expect(templateOutputCandidates("/docs/a/b/c", ids)).toEqual(["/docs/[...parts]"]);
    expect(templateOutputCandidates("/opt", ids)).toEqual(["/opt/[[...rest]]"]);
    expect(templateOutputCandidates("/opt/a/b", ids)).toEqual(["/opt/[[...rest]]"]);
  });

  it("matches percent-encoded concrete paths", () => {
    expect(templateOutputCandidates("/blog/sticks%20%26%20stones", ids)).toEqual(["/blog/[slug]"]);
  });

  it("does not match literals or cross-segment paths", () => {
    expect(templateOutputCandidates("/static", ids)).toEqual([]);
    expect(templateOutputCandidates("/blog/a/b", ids)).toEqual(
      ["/docs/[...parts]"].filter(() => false),
    );
  });

  it("prefers more specific templates", () => {
    const both = ["/x/[...all]", "/x/[one]"];
    expect(templateOutputCandidates("/x/only", both)[0]).toBe("/x/[one]");
  });

  // N9: i18n expands one Pages route per locale, so a locale-prefixed concrete path
  // matches both the prefixed and unprefixed template at identical weight. Manifest
  // key order must not decide it — the locale-prefixed template has to win, or the
  // locale segment becomes the first catch-all param.
  it("prefers a locale-prefixed template over the bare root catch-all", () => {
    const i18nIds = ["/[[...slug]]", "/en-US/[[...slug]]", "/nl-NL/[[...slug]]"];
    expect(templateOutputCandidates("/en-US", i18nIds)[0]).toBe("/en-US/[[...slug]]");
    expect(templateOutputCandidates("/nl-NL/another", i18nIds)[0]).toBe("/nl-NL/[[...slug]]");
    const catchAllIds = ["/[...slug]", "/nl-NL/[...slug]", "/en/[...slug]"];
    expect(templateOutputCandidates("/nl-NL/hello", catchAllIds)[0]).toBe("/nl-NL/[...slug]");
  });
});

describe("prepareRequest / normalizeResolvedRedirect (shared orchestration)", () => {
  const manifest = { i18n: I18N, basePath: "", trailingSlash: false };

  it("strips client-sent x-middleware-* control headers before middleware can see them", () => {
    // app-middleware-proxy "should ignore x-middleware-set-cookie as a request header"
    // (full-run v4): the POOL sanitizes these, but Phase-2 middleware runs at the ROUTING
    // tier on the client's raw headers — NextResponse.next() then round-trips the spoofed
    // header through x-middleware-override-headers and the handler observed a cookie the
    // client never legitimately set. The public Pages Router prefetch hint stays.
    const headers = new Headers({
      "x-middleware-set-cookie": "spoofed=1",
      "x-middleware-override-headers": "x",
      "x-middleware-prefetch": "1",
      "x-ordinary": "keep",
    });
    prepareRequest(url("/"), headers, manifest);
    expect(headers.get("x-middleware-set-cookie")).toBeNull();
    expect(headers.get("x-middleware-override-headers")).toBeNull();
    expect(headers.get("x-middleware-prefetch")).toBe("1");
    expect(headers.get("x-ordinary")).toBe("keep");
  });

  it("400s malformed encoding and 308s duplicate slashes", () => {
    expect(prepareRequest(url("/%zz"), new Headers(), manifest)).toEqual({
      kind: "error",
      status: 400,
    });
    const r = prepareRequest(url("//a?q=1"), new Headers(), manifest);
    expect(r.kind).toBe("redirect");
    if (r.kind === "redirect") {
      expect(r.status).toBe(308);
      expect(r.url.pathname + r.url.search).toBe("/a?q=1");
    }
  });

  it("locale-prefixes and preserves the original URL", () => {
    const r = prepareRequest(url("/about?q=1"), new Headers(), manifest);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.url.pathname).toBe("/en/about");
      expect(r.originalUrl.pathname).toBe("/about");
      expect(r.addedLocale).toBe("en");
    }
  });

  it("normalizes Pages data URLs before trailing-slash rules and middleware", () => {
    const r = prepareRequest(
      url("/docs/_next/data/build123/blog/first.json?draft=1"),
      new Headers({ "x-nextjs-data": "1" }),
      { buildId: "build123", i18n: null, basePath: "/docs", trailingSlash: true },
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.isDataRequest).toBe(true);
      expect(r.url.pathname + r.url.search).toBe("/docs/blog/first/?draft=1");
      expect(r.originalUrl.pathname).toBe("/docs/_next/data/build123/blog/first.json");
    }
  });

  it("carries resolvedHeaders on rule redirects and strips the added locale", () => {
    const prep = prepareRequest(url("/redirect-1"), new Headers(), manifest);
    if (prep.kind !== "ok") throw new Error("expected ok");
    const headers = new Headers({ "x-extra": "hi" });
    const out = normalizeResolvedRedirect(
      { redirect: { url: url("/en/somewhere"), status: 307 }, resolvedHeaders: headers },
      prep,
      manifest,
    );
    expect(out?.kind).toBe("redirect");
    if (out?.kind === "redirect") {
      expect(out.url.pathname).toBe("/somewhere");
      expect(out.resolvedHeaders?.get("x-extra")).toBe("hi");
    }
  });

  it("resolves relative Locations against the request URL (HTTP semantics)", () => {
    const prep = prepareRequest(url("/dir/page"), new Headers(), {
      i18n: null,
      basePath: "",
    });
    if (prep.kind !== "ok") throw new Error("expected ok");
    const out = normalizeResolvedRedirect(
      { resolvedHeaders: new Headers({ location: "settings" }), status: 307 },
      prep,
      { i18n: null, basePath: "" },
    );
    expect(out?.kind).toBe("redirect");
    if (out?.kind === "redirect") expect(out.url.pathname).toBe("/dir/settings");
  });

  it("returns null when there is no redirect", () => {
    const prep = prepareRequest(url("/page"), new Headers(), { i18n: null, basePath: "" });
    if (prep.kind !== "ok") throw new Error("expected ok");
    expect(
      normalizeResolvedRedirect({ resolvedHeaders: new Headers() }, prep, {
        i18n: null,
        basePath: "",
      }),
    ).toBeNull();
  });

  // N15: rule redirects from next.config `redirects()` compile to a ROUTE carrying a Location
  // header and no destination. Upstream carries the REQUEST query onto such a target when the
  // target has none (@next/routing >= 16.3 resolveRedirectLocationWithRequestQuery); we depend on
  // 16.2.x, which does not, so routing-common mirrors it.
  //
  // Measured against `next start` (Next 16.3.0-canary.84, app-dir/rsc-query-routing fixture,
  // `redirects()` /redirect/source → /redirect/dest):
  //   GET /redirect/source?_rsc=abc123  → 308 location: /redirect/dest?_rsc=abc123
  //   GET /redirect/source?foo=1        → 308 location: /redirect/dest?foo=1
  //   GET /redirect/source              → 308 location: /redirect/dest
  describe("rule-redirect request-query carry (N15)", () => {
    const plain = { i18n: null, basePath: "" };

    function normalize(
      requestPath: string,
      location: string,
      opts?: { middlewareAuthored?: boolean },
    ) {
      const prep = prepareRequest(url(requestPath), new Headers(), plain);
      if (prep.kind !== "ok") throw new Error("expected ok");
      const out = normalizeResolvedRedirect(
        { resolvedHeaders: new Headers({ location }), status: 308 },
        prep,
        plain,
        opts,
      );
      if (out?.kind !== "redirect") throw new Error("expected redirect");
      return out.url.pathname + out.url.search;
    }

    it("carries the RSC cache-busting param onto a query-less target", () => {
      expect(normalize("/redirect/source?_rsc=abc123", "/redirect/dest")).toBe(
        "/redirect/dest?_rsc=abc123",
      );
    });

    it("carries an arbitrary request query onto a query-less target", () => {
      expect(normalize("/redirect/source?foo=1", "/redirect/dest")).toBe("/redirect/dest?foo=1");
      expect(normalize("/redirect/source?foo=1&bar=2", "/redirect/dest")).toBe(
        "/redirect/dest?foo=1&bar=2",
      );
    });

    it("does NOT overwrite a target that already carries a query", () => {
      expect(normalize("/redirect/source?foo=1", "/redirect/dest?keep=me")).toBe(
        "/redirect/dest?keep=me",
      );
    });

    it("is a no-op when the request has no query", () => {
      expect(normalize("/redirect/source", "/redirect/dest")).toBe("/redirect/dest");
    });

    // A middleware-authored Location's target is authoritative — an unguarded carry broke
    // e2e/middleware-redirects with ERR_TOO_MANY_REDIRECTS (the carried query re-matched the
    // middleware's own source condition).
    it("never carries onto a middleware-authored Location", () => {
      expect(normalize("/protected?foo=1", "/login", { middlewareAuthored: true })).toBe("/login");
      expect(normalize("/protected?_rsc=abc123", "/login", { middlewareAuthored: true })).toBe(
        "/login",
      );
    });
  });
});

// N9: a pool may hold only the UNPREFIXED template (multi-pool splits), where
// templateOutputCandidates' tie-break cannot help — the locale must be stripped from
// the param path so it doesn't land in the catch-all params.
describe("localeAlignedRouteParamPathname", () => {
  const locales = ["en-US", "nl-NL", "nl", "fr"];

  it("keeps the concrete path when the handler template carries the same locale", () => {
    expect(localeAlignedRouteParamPathname("/nl-NL/hello", "/nl-NL/[...slug]", locales)).toBe(
      "/nl-NL/hello",
    );
    expect(localeAlignedRouteParamPathname("/en-US", "/en-US/[[...slug]]", locales)).toBe("/en-US");
  });

  it("strips the locale when the handler template does not carry it", () => {
    expect(localeAlignedRouteParamPathname("/nl-NL/hello", "/[...slug]", locales)).toBe("/hello");
    expect(localeAlignedRouteParamPathname("/en-US", "/[[...slug]]", locales)).toBe("/");
  });

  it("leaves non-locale paths untouched", () => {
    expect(localeAlignedRouteParamPathname("/blog/hello", "/blog/[slug]", locales)).toBe(
      "/blog/hello",
    );
    expect(localeAlignedRouteParamPathname("/blog/hello", "/[...slug]", locales)).toBe(
      "/blog/hello",
    );
    expect(localeAlignedRouteParamPathname("/nl-BE/x", "/[...slug]", locales)).toBe("/nl-BE/x");
  });
});

// --- De-duplicated helpers (were private copies / open-coded in one or both tiers) -------
// Cross-tier equality is asserted in tests/routing-common.tier-parity.test.ts; these pin the
// per-helper edge cases that made the copies worth removing.

describe("stripAddedLocale", () => {
  it("strips the locale WE added, at a segment boundary only", () => {
    expect(stripAddedLocale("/en/about", "en")).toBe("/about");
    expect(stripAddedLocale("/en", "en")).toBe("/");
    // "/english" is NOT under "/en" — a prefix match without the boundary would corrupt it.
    expect(stripAddedLocale("/english/x", "en")).toBe("/english/x");
    expect(stripAddedLocale("/enx", "en")).toBe("/enx");
  });

  it("is a no-op when no locale was auto-added, or the path carries a different one", () => {
    expect(stripAddedLocale("/en/about", null)).toBe("/en/about");
    expect(stripAddedLocale("/en/about", undefined)).toBe("/en/about");
    expect(stripAddedLocale("/fr/about", "en")).toBe("/fr/about");
  });

  it("keeps a percent-encoded remainder byte-identical", () => {
    expect(stripAddedLocale("/en/caf%C3%A9", "en")).toBe("/caf%C3%A9");
  });
});

describe("queryFromUrl", () => {
  it("collapses repeated keys into an array, preserving order", () => {
    expect(queryFromUrl(new URL("http://x/y?a=1&a=2&a=3&b=4"))).toEqual({
      a: ["1", "2", "3"],
      b: "4",
    });
  });

  it("decodes percent-encoding and treats a valueless key as empty string", () => {
    expect(queryFromUrl(new URL("http://x/y?q=caf%C3%A9+au+lait&empty=&bare"))).toEqual({
      q: "café au lait",
      empty: "",
      bare: "",
    });
  });

  it("returns an empty record for a query-less URL", () => {
    expect(queryFromUrl(new URL("http://x/y"))).toEqual({});
  });
});

describe("isRscRequest", () => {
  const rsc = { header: "rsc", suffix: ".rsc" };

  it("is true only for an exact '1' on the manifest's negotiation header", () => {
    expect(isRscRequest(new Headers({ rsc: "1" }), rsc)).toBe(true);
    expect(isRscRequest(new Headers({ rsc: "0" }), rsc)).toBe(false);
    expect(isRscRequest(new Headers({ rsc: "true" }), rsc)).toBe(false);
    expect(isRscRequest(new Headers(), rsc)).toBe(false);
  });

  it("is false when the build has no rsc config", () => {
    expect(isRscRequest(new Headers({ rsc: "1" }), undefined)).toBe(false);
  });
});

describe("resolveOutputPathname", () => {
  const poolAssignments = { "/gssp": "ssr", "/[slug]": "ssr", "/featured": "ssr" };

  it("prefers a concrete output for the REWRITE TARGET over a dynamic template", () => {
    expect(
      resolveOutputPathname({
        requestPathname: "/rewrite-1",
        resolvedPathname: "/[slug]",
        invocationTargetPathname: "/gssp",
        poolAssignments,
      }),
    ).toBe("/gssp");
  });

  it("does not let the public pathname's own output undo a rewrite", () => {
    // `/featured` is both a real output and a rewrite source pointing elsewhere.
    expect(
      resolveOutputPathname({
        requestPathname: "/featured",
        resolvedPathname: "/[slug]",
        invocationTargetPathname: "/gssp",
        poolAssignments,
      }),
    ).toBe("/gssp");
  });

  it("prefers a concrete output for the request path when nothing was rewritten", () => {
    expect(
      resolveOutputPathname({
        requestPathname: "/gssp",
        resolvedPathname: "/[slug]",
        invocationTargetPathname: "/gssp",
        poolAssignments,
      }),
    ).toBe("/gssp");
    // No invocation target at all: the request path is the match.
    expect(
      resolveOutputPathname({
        requestPathname: "/gssp",
        resolvedPathname: "/[slug]",
        invocationTargetPathname: undefined,
        poolAssignments,
      }),
    ).toBe("/gssp");
  });

  it("keeps the dynamic template when no concrete output exists", () => {
    expect(
      resolveOutputPathname({
        requestPathname: "/blog/anything",
        resolvedPathname: "/[slug]",
        invocationTargetPathname: "/blog/anything",
        poolAssignments,
      }),
    ).toBe("/[slug]");
  });

  it("falls back to the request pathname when routing resolved nothing", () => {
    expect(
      resolveOutputPathname({
        requestPathname: "/unknown",
        resolvedPathname: undefined,
        invocationTargetPathname: undefined,
        poolAssignments,
      }),
    ).toBe("/unknown");
  });
});

// ---------------------------------------------------------------------------------------
// N40 — the shared predicates and the boot-time manifest gate.
// ---------------------------------------------------------------------------------------

describe("grantsSharedCacheFreshness", () => {
  // The predicate's own words: "gives a shared cache a window in which it may serve hits
  // WITHOUT REVALIDATING". Two consumers depend on it — the pool's middleware invariant
  // (cache-policy.ts explicitCacheControlWins) and the edge's N18 RSC guard
  // (routing-service/handler.ts withRscCacheBustingGuard).
  it("is true for a positive s-maxage or max-age", () => {
    expect(grantsSharedCacheFreshness("s-maxage=60")).toBe(true);
    expect(grantsSharedCacheFreshness("public, max-age=3600")).toBe(true);
    expect(grantsSharedCacheFreshness("S-MAXAGE=1")).toBe(true);
  });

  it("is false for revalidate-every-time and non-storable policies", () => {
    expect(grantsSharedCacheFreshness("max-age=0")).toBe(false);
    expect(grantsSharedCacheFreshness("public, max-age=0, must-revalidate")).toBe(false);
    expect(grantsSharedCacheFreshness("no-store")).toBe(false);
    expect(grantsSharedCacheFreshness("no-cache")).toBe(false);
    expect(grantsSharedCacheFreshness("private, max-age=600")).toBe(false);
    expect(grantsSharedCacheFreshness("")).toBe(false);
  });

  it("is true for a positive stale-while-revalidate even with max-age=0 (N40)", () => {
    // THE BUG THIS PINS: only s-maxage/max-age were computed, so
    // `max-age=0, stale-while-revalidate=600` read as "grants no unrevalidated window" —
    // passing BOTH consumers. RFC 5861 makes that a 600-second window in which a shared cache
    // may serve a STALE hit without revalidating first, independent of max-age. On a
    // middleware-covered route those hits bypass the ext_proc callout entirely (Cloud CDN is
    // in front of it); on the edge it left an unvalidated RSC response storable.
    expect(grantsSharedCacheFreshness("max-age=0, stale-while-revalidate=600")).toBe(true);
    expect(grantsSharedCacheFreshness("stale-while-revalidate=1")).toBe(true);
    expect(grantsSharedCacheFreshness("public, STALE-WHILE-REVALIDATE=30")).toBe(true);
    expect(grantsSharedCacheFreshness("max-age=0, stale-if-error=600")).toBe(true);
  });

  it("still vetoes on no-cache/private even with stale-while-revalidate", () => {
    expect(grantsSharedCacheFreshness("no-cache, stale-while-revalidate=600")).toBe(false);
    expect(grantsSharedCacheFreshness("private, stale-while-revalidate=600")).toBe(false);
    expect(grantsSharedCacheFreshness("no-store, s-maxage=600")).toBe(false);
  });

  it("matches exact directive names and respects quoted commas", () => {
    expect(grantsSharedCacheFreshness("x-s-maxage=600")).toBe(false);
    expect(grantsSharedCacheFreshness("x-no-store, s-maxage=600")).toBe(true);
    expect(grantsSharedCacheFreshness('x-policy="no-store, private", s-maxage=600')).toBe(true);
    expect(grantsSharedCacheFreshness("almost-private, max-age=600")).toBe(true);
  });

  it("treats a zero stale-while-revalidate as no window", () => {
    expect(grantsSharedCacheFreshness("max-age=0, stale-while-revalidate=0")).toBe(false);
  });
});

describe("middlewareAuthoredRedirect", () => {
  it("is false for a plain NextResponse.next() (N40)", () => {
    // THE BUG THIS PINS: both tiers passed `middlewareResponse != null`, which is TRUE for a
    // plain next(). That disabled the N15 request-query carry for every app with middleware,
    // and a typical matcher covers `/(.*)`.
    const next = new Response(null, { status: 200, headers: { "x-middleware-next": "1" } });
    expect(middlewareAuthoredRedirect(next)).toBe(false);
  });

  it("is true exactly when the middleware response carries a Location", () => {
    expect(
      middlewareAuthoredRedirect(new Response(null, { status: 307, headers: { location: "/x" } })),
    ).toBe(true);
    // Case-insensitive, per Headers semantics.
    expect(
      middlewareAuthoredRedirect(new Response(null, { status: 308, headers: { Location: "/x" } })),
    ).toBe(true);
  });

  it("is false when middleware produced no response at all", () => {
    expect(middlewareAuthoredRedirect(undefined)).toBe(false);
    expect(middlewareAuthoredRedirect(null)).toBe(false);
  });
});

describe("serializeHeaderMap", () => {
  it("returns null for an empty set so the caller can skip the header", () => {
    expect(serializeHeaderMap(new Headers())).toBeNull();
  });

  it("keeps each Set-Cookie intact instead of comma-folding them", () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    headers.append("set-cookie", "b=2");
    headers.set("x-thing", "v");
    const parsed = JSON.parse(serializeHeaderMap(headers)!);
    expect(parsed["set-cookie"]).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT", "b=2"]);
    expect(parsed["x-thing"]).toBe("v");
  });
});

describe("pool header budget (N40b)", () => {
  it("counts HTTP/1.1 framing bytes, not string length", () => {
    // `name: value\r\n` — 4 bytes of framing per entry.
    expect(headerBlockBytes([["a", "b"]])).toBe(1 + 1 + 4);
    // Multi-byte values count their BYTES: a cookie or JSON value can carry UTF-8.
    expect(headerBlockBytes([["x-café", "é"]])).toBe(
      Buffer.byteLength("x-café") + Buffer.byteLength("é") + 4,
    );
    expect(
      headerBlockBytes([
        ["a", "b"],
        ["cc", "dd"],
      ]),
    ).toBe(6 + 8);
  });

  it("is pinned to Node's default maxHeaderSize, which the pool server does not override", async () => {
    // MEASURED (Node 24.11.0): a default `createServer()` accepts a header block up to 16408
    // wire bytes and answers anything larger with 431 from the PARSER (HPE_HEADER_OVERFLOW),
    // before the request handler runs. pool-server/server.ts calls createServer() with no
    // maxHeaderSize and the emitted container sets no --max-http-header-size, so this default
    // is the production ceiling. tests/routing-service/handler.test.ts drives a real server
    // with the real header block; this pins the constant the guard divides by.
    const http = await import("node:http");
    expect(POOL_MAX_HEADER_BYTES).toBe(http.default.maxHeaderSize);
  });

  it("fits exactly up to the limit minus the reserve", () => {
    const limit = POOL_MAX_HEADER_BYTES - POOL_HEADER_BUDGET_RESERVE_BYTES;
    expect(fitsPoolHeaderBudget(limit)).toBe(true);
    expect(fitsPoolHeaderBudget(limit + 1)).toBe(false);
    // The reserve covers the request line and the headers Envoy adds after the mutation.
    expect(POOL_HEADER_BUDGET_RESERVE_BYTES).toBeGreaterThan(0);
    expect(POOL_HEADER_BUDGET_RESERVE_BYTES).toBeLessThan(POOL_MAX_HEADER_BYTES);
  });
});

describe("assertValidRoutingManifest", () => {
  const graph = () => ({
    beforeMiddleware: [],
    beforeFiles: [],
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
  });
  const valid = () => ({
    buildId: "abc",
    basePath: "",
    pathnames: ["/"],
    poolAssignments: { "/": "default" },
    pprRoutes: {},
    routeGraph: graph(),
  });

  it("accepts a well-formed manifest", () => {
    expect(() => assertValidRoutingManifest(valid(), "m.json")).not.toThrow();
  });

  for (const [name, mutate] of [
    ["not an object", () => "nope"],
    ["an array", () => []],
    ["missing buildId", () => ({ ...valid(), buildId: undefined })],
    ["empty buildId", () => ({ ...valid(), buildId: "" })],
    ["non-string basePath", () => ({ ...valid(), basePath: null })],
    ["non-array pathnames", () => ({ ...valid(), pathnames: {} })],
    ["non-string pathname entry", () => ({ ...valid(), pathnames: ["/", 7] })],
    ["missing poolAssignments", () => ({ ...valid(), poolAssignments: undefined })],
    ["missing pprRoutes", () => ({ ...valid(), pprRoutes: undefined })],
    ["missing routeGraph", () => ({ ...valid(), routeGraph: undefined })],
    [
      "missing a routeGraph bucket",
      () => ({ ...valid(), routeGraph: { ...graph(), dynamicRoutes: undefined } }),
    ],
    [
      "a non-array routeGraph bucket",
      () => ({ ...valid(), routeGraph: { ...graph(), afterFiles: {} } }),
    ],
    [
      "a route entry with no sourceRegex",
      () => ({ ...valid(), routeGraph: { ...graph(), afterFiles: [{ destination: "/x" }] } }),
    ],
  ] as [string, () => unknown][]) {
    it(`throws for ${name}`, () => {
      expect(() => assertValidRoutingManifest(mutate(), "m.json")).toThrow(
        /Invalid routing manifest at m\.json/,
      );
    });
  }

  it("throws for a sourceRegex this runtime cannot compile (N40)", () => {
    // THE BUG THIS PINS: @next/routing's matchRoute does `new RegExp(entry.sourceRegex)` with
    // NO try/catch (unlike compileMatcherRegex's documented fail-safe for middleware matchers).
    // One uncompilable route therefore threw inside resolveRoutes on EVERY request →
    // createProcessHandler's catch → `failOpen === false` whenever the app has middleware →
    // 500 on everything, while /healthz kept answering 200 so nothing evicted the pod.
    const manifest = {
      ...valid(),
      routeGraph: { ...graph(), dynamicRoutes: [{ sourceRegex: "^/(unclosed" }] },
    };
    expect(() => assertValidRoutingManifest(manifest, "m.json")).toThrow(
      /routeGraph\.dynamicRoutes\[0\]\.sourceRegex` does not compile/,
    );
  });

  it("names the offending bucket and index so the operator can find it", () => {
    const manifest = {
      ...valid(),
      routeGraph: {
        ...graph(),
        beforeFiles: [{ sourceRegex: "^/ok$" }, { sourceRegex: "^/(?<dup>a)(?<dup>b)$" }],
      },
    };
    expect(() => assertValidRoutingManifest(manifest, "m.json")).toThrow(
      /routeGraph\.beforeFiles\[1\]/,
    );
  });

  it("WARNS but does not throw for an uncompilable middleware matcher", () => {
    // Deliberate asymmetry: compileMatcherRegex treats an uncompilable matcher as MATCHED, so
    // middleware runs for everything — degraded, never a bypass. Turning that documented
    // fail-safe into a crash would convert a working deploy into a failed one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const manifest = {
        ...valid(),
        middleware: { filePath: "m.js", matchers: [{ regexp: "^/(unclosed" }] },
      };
      expect(() => assertValidRoutingManifest(manifest, "m.json")).not.toThrow();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("middleware matcher regexp does not");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("serializeHeaderMap ↔ the pool's parseResolvedHeaders wire contract (N40)", () => {
  // The edge writes `x-resolved-headers` and `x-mw-request-headers` with serializeHeaderMap;
  // the pool reads both with pool-server/index.ts's `parseResolvedHeaders`. That reader is a
  // module-private function, so its body is copied VERBATIM here — if the two shapes ever
  // drift, this fails instead of a production request silently losing a header. The awkward
  // cases are the ones that motivated the shape: a Set-Cookie whose `Expires` contains a comma
  // (which Headers.entries() would fold lossily) and the comma-joined
  // `x-middleware-set-cookie` that dispatch.ts splits on `/,(?=[^;]*=)/`.
  function parseResolvedHeaders(raw: string | undefined): Headers | undefined {
    if (!raw) return undefined;
    try {
      const obj = JSON.parse(raw) as Record<string, string | string[]>;
      const headers = new Headers();
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }
      return headers;
    } catch {
      return undefined;
    }
  }

  it("round-trips a realistic mutated request-header set byte-exactly", () => {
    const original = new Headers({
      host: "app.example.com",
      cookie: "sid=abc",
      "x-authenticated-user": "alice",
      "x-middleware-set-cookie": "flash=1; Path=/,theme=dark; Path=/",
    });
    original.append("set-cookie", "a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    original.append("set-cookie", "b=2");

    const back = parseResolvedHeaders(serializeHeaderMap(original)!)!;
    const norm = (h: Headers) => ({
      entries: [...h.entries()].filter(([k]) => k !== "set-cookie").sort(),
      cookies: h.getSetCookie(),
    });
    expect(norm(back)).toEqual(norm(original));
  });
});
