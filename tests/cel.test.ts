import { describe, it, expect, vi } from "vitest";
import {
  generateCelExpression,
  extractStaticPrefix,
  escapeCelString,
  CEL_EXPRESSION_WARN_LENGTH,
} from "../src/cel.js";
import {
  mockOutputs,
  mockStaticFile,
  mockPrerender,
  mockAppPage,
  mockAppRoute,
} from "./helpers/mock-outputs.js";

describe("extractStaticPrefix", () => {
  it("extracts prefix from dynamic route regex", () => {
    expect(extractStaticPrefix("^/blog/([^/]+?)(?:/)?$")).toBe("/blog/");
  });
  it("extracts prefix from nested dynamic route", () => {
    expect(extractStaticPrefix("^/api/users/([^/]+?)/posts(?:/)?$")).toBe("/api/users/");
  });
  it("returns null for root-level dynamic route", () => {
    expect(extractStaticPrefix("^/([^/]+?)(?:/)?$")).toBe("/");
  });
  it("returns null for unparseable regex", () => {
    expect(extractStaticPrefix("(?:)")).toBeNull();
  });

  it("skips a leading locale capture group instead of returning a match-all '/'", () => {
    // i18n dynamic routes are baked with a leading locale group; extracting through
    // it used to yield "/" (match-all) for a route with a real static prefix.
    expect(extractStaticPrefix("^/(?<nxtPlocale>en|fr)/blog/([^/]+?)(?:/)?$")).toBe("/blog/");
    expect(extractStaticPrefix("^/(?<nextLocale>en|nl\\-NL)/docs/(.+?)(?:/)?$")).toBe("/docs/");
  });

  it("keeps '/' for a root catch-all even with a locale group (nothing static after it)", () => {
    // The locale group is skipped, but the remainder is itself dynamic — "/" is the
    // honest prefix (it really can match any first segment).
    expect(extractStaticPrefix("^[/]?(?<nextLocale>[^/]{1,})/(?<nxtPslug>.+?)(?:/)?$")).toBe("/");
  });

  it("does NOT skip a leading non-locale capture group", () => {
    // A root dynamic segment matches any first segment, so "/" is correct here and
    // must not be "improved" into dropping the route from the inclusions.
    expect(extractStaticPrefix("^/(?<slug>[^/]+?)(?:/)?$")).toBe("/");
  });

  // REGRESSION: a user `[locale]` dynamic param compiles to a NON-enumerable
  // locale-named group. Stripping it yielded "/blog/" while requests arrive as
  // "/en/blog/x" — the emitted startsWith('/blog/') inclusion could never fire and
  // the route extension was silently disabled for the app. Non-enumerable locale
  // groups must fall back to the over-broad-but-functional "/" (pre-strip behavior).
  it("falls back to '/' for a NON-enumerable leading locale group with a static suffix", () => {
    expect(extractStaticPrefix("^/(?<nxtPlocale>[^/]+?)/blog/([^/]+?)(?:/)?$")).toBe("/");
    // Any group name CONTAINING "locale" (e.g. [localeId]) hits the same path.
    expect(extractStaticPrefix("^/(?<nxtPlocaleId>[^/]+?)/docs/(.+?)(?:/)?$")).toBe("/");
  });
});

describe("generateCelExpression", () => {
  it("generates exclusion list when middleware exists", () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/favicon.ico" }),
        mockStaticFile({ pathname: "/robots.txt" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).toContain("request.path == '/robots.txt'");
    // Method is NOT gated in CEL: the extension must run on POSTs too, so it can strip
    // client-spoofed dispatch headers. Body-capable requests with middleware are short-
    // circuited at runtime by the handler backstop, not by the CEL match condition.
    expect(cel).toMatch(/^!\(/);
    expect(cel).not.toContain("request.method");
  });

  it("does not exclude public files matched by middleware matchers", () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/favicon.ico" }),
        mockStaticFile({ pathname: "/api-docs.html" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/api-docs.*$" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).not.toContain("api-docs");
  });

  it("generates inclusion list when no middleware", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/about" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
      prerenders: [
        mockPrerender({
          pathname: "/blog/hello",
          fallback: { filePath: "/dist/blog.html", initialRevalidate: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/blog/([^/]+?)(?:/)?$" }] as any,
    });
    expect(cel).toContain("request.path.startsWith('/blog/')");
    expect(cel).toContain("request.path.startsWith('/_next/image')");
    expect(cel).not.toMatch(/^!\(/);
    // The no-middleware branch is NOT method-gated — resolveRoutes is body-independent, so
    // edge dispatch for POST/etc. stays valid when there's no middleware to run.
    expect(cel).not.toContain("request.method");
  });

  it("includes a purely-static ISR pathname not covered by any dynamic route", () => {
    // A fully-static prerendered page with revalidation (e.g. `export const
    // revalidate = 60`) has no dynamicRoutes prefix to fall back on, so the
    // prerender's own pathname must be included directly.
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/pricing" })],
      prerenders: [
        mockPrerender({
          pathname: "/pricing",
          sourcePage: "/pricing",
          fallback: { filePath: "/dist/pricing.html", initialRevalidate: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/pricing'");
    expect(cel).toContain("request.path.startsWith('/_next/image')");
    expect(cel).not.toBe("false");
    expect(cel).not.toMatch(/^!\(/);
  });

  it("escapes single quotes in public-file pathnames to avoid CEL injection", () => {
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/o'brien.txt" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    // The quote must be backslash-escaped, keeping the string literal intact.
    expect(cel).toContain("request.path == '/o\\'brien.txt'");
    // No unescaped quote should prematurely close the literal.
    expect(cel).not.toContain("'/o'brien.txt'");
  });

  it("percent-encodes non-ASCII and space pathnames instead of failing the build", () => {
    // The wire :path is always percent-encoded (UTF-8, uppercase hex) — the CEL literal
    // must match that form or the exclusion never fires. Previously a non-ASCII public
    // file (café.txt) aborted `next build` outright.
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/café.txt" }),
        mockStaticFile({ pathname: "/my file.txt" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/caf%C3%A9.txt'");
    expect(cel).toContain("request.path == '/my%20file.txt'");
    // Direct-escaper contract, incl. URL delimiters that would break raw matching.
    expect(escapeCelString("/café.txt")).toBe("/caf%C3%A9.txt");
    expect(escapeCelString("/my file.txt")).toBe("/my%20file.txt");
    expect(escapeCelString("/100%.txt")).toBe("/100%25.txt");
  });

  it("rejects control characters in pathnames instead of letting them fold in YAML", () => {
    // The CEL text is embedded in a YAML scalar in route-extension.yaml — a newline in a
    // public filename would silently fold and corrupt the extension spec. Fail the build.
    expect(() => escapeCelString("/evil\nfile.txt")).toThrow(/control characters/);
    expect(() => escapeCelString("/evil\tfile.txt")).toThrow(/control characters/);
    // Printable ASCII (incl. quotes) still escapes normally.
    expect(escapeCelString("/o'brien.txt")).toBe("/o\\'brien.txt");
  });

  it("returns false when nothing needs ext_proc", () => {
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/_next/static/chunk.js" })],
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toBe("false");
  });

  it("excludes _next/static even when middleware matches everything", () => {
    const outputs = mockOutputs({
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/.*$" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
  });

  it("expands locale-prefixed dynamic routes into per-locale inclusions (no middleware)", () => {
    // Request paths for an i18n app arrive locale-prefixed (/en/blog/x) — a bare
    // /blog/ inclusion could never fire. The CEL must name the real prefixes.
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/blog/[slug]" })],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [
        { sourceRegex: "^/(?<nxtPlocale>en|fr)/blog/([^/]+?)(?:/)?$" },
        // non-enumerable locale group → bare prefix fallback (fail-safe)
        { sourceRegex: "^[/]?(?<nextLocale>[^/]{1,})/(?<nxtPslug>.+?)(?:/)?$" },
      ] as any,
    });
    expect(cel).toContain("request.path.startsWith('/en/blog/')");
    expect(cel).toContain("request.path.startsWith('/fr/blog/')");
    expect(cel).not.toContain("request.path.startsWith('/blog/')");
    // root catch-all with a non-enumerable locale group keeps its match-all prefix
    expect(cel).toContain("request.path.startsWith('/')");
  });

  it("emits a functional '/' inclusion for a user [locale] param instead of a dead prefix", () => {
    // `/[locale]/blog/[slug]` bakes a non-enumerable locale-named group; the inclusion
    // must NOT be startsWith('/blog/') (never matches /en/blog/x — the route extension
    // would be silently disabled) but the honest match-all '/'.
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/[locale]/blog/[slug]" })],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/(?<nxtPlocale>[^/]+?)/blog/([^/]+?)(?:/)?$" }] as any,
    });
    expect(cel).not.toContain("request.path.startsWith('/blog/')");
    expect(cel).toContain("request.path.startsWith('/')");
    // ...while enumerable i18n locales in the same manifest keep the per-locale expansion.
    const celEnumerable = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/(?<nxtPlocale>en|fr)/blog/([^/]+?)(?:/)?$" }] as any,
    });
    expect(celEnumerable).toContain("request.path.startsWith('/en/blog/')");
    expect(celEnumerable).toContain("request.path.startsWith('/fr/blog/')");
    expect(celEnumerable).not.toContain("request.path.startsWith('/blog/')");
  });

  // FAIL-SAFE: a middleware matcher source that doesn't compile at BUILD time might
  // still cover a public file — excluding the file would let it bypass ext_proc (and
  // middleware) entirely at the edge. Keep it behind ext_proc instead.
  it("keeps a public file behind ext_proc when a matcher source fails to compile", () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: "/maybe-covered.html" }),
        mockStaticFile({ pathname: "/favicon.ico" }),
      ],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "(?<broken" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    // No exact-match exclusions at all — every public file stays behind ext_proc.
    expect(cel).not.toContain("maybe-covered");
    expect(cel).not.toContain("favicon");
    // The always-safe _next/static exclusion is unaffected.
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
  });

  // The runtime matcher (routing-common matchesMiddleware) tests raw AND decoded
  // pathname forms — the build-time coverage probe must be at least as generous.
  it("probes middleware coverage with both encoded and decoded pathname forms", () => {
    // Matcher written against the ENCODED wire form of a non-ASCII public file.
    const encodedMatcher = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/café.txt" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/caf%C3%A9\\.txt$" }] },
      } as any,
    });
    expect(generateCelExpression({ outputs: encodedMatcher, dynamicRoutes: [] })).not.toContain(
      "caf",
    );

    // Matcher written against the DECODED form of a percent-encoded pathname.
    const decodedMatcher = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/my%20file.txt" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/my file\\.txt$" }] },
      } as any,
    });
    expect(generateCelExpression({ outputs: decodedMatcher, dynamicRoutes: [] })).not.toContain(
      "file.txt",
    );
  });

  it("warns at build time when the CEL expression exceeds the size budget", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const small = mockOutputs({
        staticFiles: [mockStaticFile({ pathname: "/favicon.ico" })],
        middleware: {
          id: "middleware",
          filePath: "/dist/server/middleware.js",
          pathname: "/middleware",
          type: 8 as any,
          config: { matchers: [] },
        } as any,
      });
      generateCelExpression({ outputs: small, dynamicRoutes: [] });
      expect(warn).not.toHaveBeenCalled();

      const many = mockOutputs({
        staticFiles: Array.from({ length: 60 }, (_, i) =>
          mockStaticFile({ pathname: `/some-quite-long-public-file-name-${i}.txt` }),
        ),
        middleware: {
          id: "middleware",
          filePath: "/dist/server/middleware.js",
          pathname: "/middleware",
          type: 8 as any,
          config: { matchers: [] },
        } as any,
      });
      const cel = generateCelExpression({ outputs: many, dynamicRoutes: [] });
      expect(cel.length).toBeGreaterThan(CEL_EXPRESSION_WARN_LENGTH);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("CEL match condition");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("generateCelExpression with basePath", () => {
  const mwOutputs = (staticFiles: { pathname: string }[]) =>
    mockOutputs({
      staticFiles: staticFiles.map((f) => mockStaticFile(f)),
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [] },
      } as any,
    });

  it("prefixes static exclusions with the basePath (middleware app)", () => {
    // request.path at the LB is the raw :path, which INCLUDES the basePath —
    // basePath-less comparisons never fire for a basePath app.
    const cel = generateCelExpression({
      outputs: mwOutputs([{ pathname: "/favicon.ico" }]),
      dynamicRoutes: [],
      basePath: "/docs",
    });
    expect(cel).toContain("request.path.startsWith('/docs/_next/static/')");
    expect(cel).toContain("request.path == '/docs/favicon.ico'");
    expect(cel).not.toContain("'/favicon.ico'");
  });

  it("probes middleware coverage with the basePath-prefixed pathname", () => {
    // Next bakes the basePath into matcher sourceRegexes, so the coverage probe
    // must test the wire path — a basePath-less probe would wrongly exclude
    // middleware-covered public files.
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: "/api-docs.html" })],
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: { matchers: [{ sourceRegex: "^/docs/api-docs.*$" }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [], basePath: "/docs" });
    expect(cel).not.toContain("api-docs");
  });

  it("prefixes inclusions with the basePath (no-middleware app)", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/about" })],
      prerenders: [
        mockPrerender({
          pathname: "/blog/hello",
          fallback: { filePath: "/dist/blog.html", initialRevalidate: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/blog/([^/]+?)(?:/)?$" }] as any,
      basePath: "/docs",
    });
    expect(cel).toContain("request.path.startsWith('/docs/blog/')");
    expect(cel).toContain("request.path == '/docs/blog/hello'");
    expect(cel).toContain("request.path.startsWith('/docs/_next/image')");
  });

  it("prefixes locale-expanded inclusions with the basePath", () => {
    const outputs = mockOutputs({ appPages: [mockAppPage({ pathname: "/blog/[slug]" })] });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: "^/(?<nxtPlocale>en|fr)/blog/([^/]+?)(?:/)?$" }] as any,
      basePath: "/docs",
    });
    expect(cel).toContain("request.path.startsWith('/docs/en/blog/')");
    expect(cel).toContain("request.path.startsWith('/docs/fr/blog/')");
  });
});
