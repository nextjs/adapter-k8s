// tests/middleware-matcher.test.ts
import { describe, it, expect } from "vitest";
import { matchesMiddleware, type MiddlewareMatcher } from "../src/routing-common.js";

const url = (p: string, base = "http://ex.com") => new URL(base + p);
const h = (o: Record<string, string> = {}) => new Headers(o);

// Compiled-manifest-shape regexps (as Next emits, incl _next/data variants).
const M = (source: string, extra: Partial<MiddlewareMatcher> = {}): MiddlewareMatcher => ({
  regexp: `^(?:\\/(_next\\/data\\/[^/]{1,}))?\\${source}(\\.json|\\.rsc)?[\\/#\\?]?$`,
  originalSource: source,
  ...extra,
});

describe("matchesMiddleware", () => {
  it("runs always when there are no matchers", () => {
    expect(matchesMiddleware(undefined, url("/anything"), h())).toBe(true);
    expect(matchesMiddleware([], url("/anything"), h())).toBe(true);
  });

  it("gates on the source regexp", () => {
    const ms = [M("/source-match")];
    expect(matchesMiddleware(ms, url("/source-match"), h())).toBe(true);
    expect(matchesMiddleware(ms, url("/other"), h())).toBe(false);
  });

  it("matches the _next/data variant of the source", () => {
    const ms = [M("/source-match")];
    expect(matchesMiddleware(ms, url("/_next/data/abc/source-match.json"), h())).toBe(true);
  });

  it("has: header with a value regex", () => {
    const ms = [M("/p", { has: [{ type: "header", key: "x-my-header", value: "(?<v>.*)" }] })];
    expect(matchesMiddleware(ms, url("/p"), h({ "x-my-header": "anything" }))).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h())).toBe(false);
  });

  it("has: presence-only query", () => {
    const ms = [M("/p", { has: [{ type: "query", key: "my-query" }] })];
    expect(matchesMiddleware(ms, url("/p?my-query=1"), h())).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h())).toBe(false);
  });

  it("has: cookie with a value regex", () => {
    const ms = [M("/p", { has: [{ type: "cookie", key: "loggedIn", value: "(?<x>true)" }] })];
    expect(matchesMiddleware(ms, url("/p"), h({ cookie: "loggedIn=true; other=1" }))).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h({ cookie: "loggedIn=false" }))).toBe(false);
    expect(matchesMiddleware(ms, url("/p"), h())).toBe(false);
  });

  it("has: host", () => {
    const ms = [M("/p", { has: [{ type: "host", value: "example.com" }] })];
    expect(matchesMiddleware(ms, url("/p", "http://example.com"), h())).toBe(true);
    expect(matchesMiddleware(ms, url("/p", "http://other.com"), h())).toBe(false);
  });

  it("has: exact header value", () => {
    const ms = [M("/p", { has: [{ type: "header", key: "hasParam", value: "with-params" }] })];
    expect(matchesMiddleware(ms, url("/p"), h({ hasParam: "with-params" }))).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h({ hasParam: "other" }))).toBe(false);
  });

  it("missing: matcher fails when the condition IS present", () => {
    const ms = [M("/p", { missing: [{ type: "header", key: "x-my-header" }] })];
    expect(matchesMiddleware(ms, url("/p"), h())).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h({ "x-my-header": "v" }))).toBe(false);
  });

  it("requires ALL has conditions and rejects a bad regexp gracefully", () => {
    const ms = [
      M("/p", {
        has: [
          { type: "header", key: "a", value: "1" },
          { type: "query", key: "b" },
        ],
      }),
    ];
    expect(matchesMiddleware(ms, url("/p?b=x"), h({ a: "1" }))).toBe(true);
    expect(matchesMiddleware(ms, url("/p"), h({ a: "1" }))).toBe(false);
  });

  // REGRESSION: middleware with no config.matcher compiles to a catch-all — it
  // must run on every path (root, nested, with query, _next/data). A bug in the
  // regexp test here would silently disable middleware for whole apps.
  it("runs everywhere for the Next catch-all matcher", () => {
    const catchAll: MiddlewareMatcher[] = [
      {
        regexp:
          "^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)(?:[^/.]{1,}\\/)*[^/.]{1,}))?(\\.json)?[\\/#\\?]?$",
        originalSource: "/:path*",
      },
    ];
    for (const p of ["/", "/about", "/a/b/c", "/dashboard/settings"]) {
      expect(matchesMiddleware(catchAll, url(p), h())).toBe(true);
    }
    expect(matchesMiddleware(catchAll, url("/about?q=1"), h())).toBe(true);
  });

  // REGRESSION: a matcher whose source matches but with an unsatisfiable value
  // regex must NOT falsely match (guards against treating value as literal).
  it("does not match when a has-value regex fails to match", () => {
    const ms = [M("/p", { has: [{ type: "header", key: "x", value: "abc" }] })];
    expect(matchesMiddleware(ms, url("/p"), h({ x: "xyz" }))).toBe(false);
    expect(matchesMiddleware(ms, url("/p"), h({ x: "abc" }))).toBe(true);
  });

  // REGRESSION: middleware must run on matched STATIC/public paths (a matcher on
  // /file.svg or /_next/static/css/:path*), but a normal catch-all matcher must
  // NOT match /_next/ assets (so they still fast-path).
  it("matches explicit static-file and _next/static/css matchers", () => {
    const svg: MiddlewareMatcher[] = [
      {
        regexp: "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/file\\.svg(\\.json|\\.rsc)?[\\/#\\?]?$",
        originalSource: "/file.svg",
      },
    ];
    expect(matchesMiddleware(svg, url("/file.svg"), h())).toBe(true);
    expect(matchesMiddleware(svg, url("/other.svg"), h())).toBe(false);

    const css: MiddlewareMatcher[] = [
      {
        regexp:
          "^(?:\\/(_next\\/data\\/[^/]{1,}))?\\/_next\\/static\\/css(?:\\/((?:[^\\/#\\?]+?)(?:\\/(?:[^\\/#\\?]+?))*))?(\\.json|\\.rsc)?[\\/#\\?]?$",
        originalSource: "/_next/static/css/:path*",
      },
    ];
    expect(matchesMiddleware(css, url("/_next/static/css/app.css"), h())).toBe(true);
    // A chunk JS under /_next/static/chunks must NOT match a css-only matcher.
    expect(matchesMiddleware(css, url("/_next/static/chunks/x.js"), h())).toBe(false);
  });

  it("catch-all matcher excludes /_next/ assets (they keep fast-pathing)", () => {
    const catchAll: MiddlewareMatcher[] = [
      {
        regexp:
          "^(?:\\/(_next\\/data\\/[^/]{1,}))?(?:\\/((?!_next\\/)(?:[^/.]{1,}\\/)*[^/.]{1,}))?(\\.json)?[\\/#\\?]?$",
        originalSource: "/:path*",
      },
    ];
    expect(matchesMiddleware(catchAll, url("/_next/static/chunks/x.js"), h())).toBe(false);
    expect(matchesMiddleware(catchAll, url("/about"), h())).toBe(true);
  });

  // REGRESSION: encoded-slash paths must match a matcher whose source uses a
  // literal slash (/another%2fhello vs source /another/hello).
  it("matches an encoded-slash path against a slash matcher (decoded form)", () => {
    const ms = [M("/another/hello")];
    expect(matchesMiddleware(ms, url("/another%2fhello"), h())).toBe(true);
    expect(matchesMiddleware(ms, url("/another/hello"), h())).toBe(true);
  });
});
