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
import { describe, it, expect } from "vitest";
import {
  collapseSlashesRedirect,
  normalizeI18nRedirect,
  normalizeLocationRedirect,
  normalizeMatchedPathname,
  normalizeResolvedRedirect,
  preferConcreteOutput,
  prefixRequestLocale,
  prepareRequest,
  rscParentCandidates,
  stripBasePath,
  templateOutputCandidates,
} from "../src/routing-common.js";

const I18N = { locales: ["en", "fr", "sv"], defaultLocale: "en" };

function url(path: string, base = "http://localhost:3000"): URL {
  // Construct like the resolvers do (`scheme://authority` + raw path) so paths
  // with leading "//" aren't mis-parsed as protocol-relative URLs.
  return new URL(base + path);
}

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

  it("leaves the URL alone when detection picks a non-default locale (resolveRoutes redirects)", () => {
    const u = url("/about");
    const headers = new Headers({ cookie: "NEXT_LOCALE=fr" });
    const added = prefixRequestLocale(u, headers, I18N, "");
    expect(u.pathname).toBe("/about");
    expect(added).toBeNull();
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
    const r = normalizeI18nRedirect({ url: url("/fr/about"), status: 307 }, url("/about"), I18N, "");
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
    expect(preferConcreteOutput("/sticks & stones", "/[id]", assignments)).toBe(
      "/sticks & stones",
    );
  });

  it("decodes the request path when looking up outputs", () => {
    expect(preferConcreteOutput("/sticks%20%26%20stones", "/[id]", assignments)).toBe(
      "/sticks & stones",
    );
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
    expect(templateOutputCandidates("/blog/sticks%20%26%20stones", ids)).toEqual([
      "/blog/[slug]",
    ]);
  });

  it("does not match literals or cross-segment paths", () => {
    expect(templateOutputCandidates("/static", ids)).toEqual([]);
    expect(templateOutputCandidates("/blog/a/b", ids)).toEqual(["/docs/[...parts]"].filter(() => false));
  });

  it("prefers more specific templates", () => {
    const both = ["/x/[...all]", "/x/[one]"];
    expect(templateOutputCandidates("/x/only", both)[0]).toBe("/x/[one]");
  });
});

describe("prepareRequest / normalizeResolvedRedirect (shared orchestration)", () => {
  const manifest = { i18n: I18N, basePath: "", trailingSlash: false };

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
});
