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
  it("percent-encodes and escapes literals embedded in the match condition", () => {
    // These assertions used to ride along on the public-file exclusion tests. The exclusions
    // are gone, but escapeCelString still guards the one literal that remains (the
    // basePath-prefixed /_next/static/ prefix), so the contract is pinned directly.
    expect(escapeCelString("/caf\u00e9.txt")).toBe("/caf%C3%A9.txt");
    expect(escapeCelString("/my file.txt")).toBe("/my%20file.txt");
    expect(escapeCelString("/100%.txt")).toBe("/100%25.txt");
    expect(escapeCelString("/o'brien.txt")).toBe("/o\\'brien.txt");
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

  // FAIL-SAFE: a middleware matcher source that doesn't compile at BUILD time might
  // still cover a public file — excluding the file would let it bypass ext_proc (and
  // middleware) entirely at the edge. Keep it behind ext_proc instead.
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

  it("budgets against GCP's REAL 512-character limit", () => {
    // Measured on GKE 2026-07-29 deploying upstream's app-dir/app-static fixture:
    //   ERROR: (gcloud.service-extensions.lb-traffic-extensions.import) INVALID_ARGUMENT:
    //   INVALID_CEL_EXPRESSION: expression exceeded max length 512
    // The budget was 1024 — double the real ceiling — so an expression between 512 and 1024
    // characters passed the build with NO warning and then failed the deploy at cutover,
    // which is precisely the "hear it from `next build`, not from gcloud" outcome this
    // constant exists to produce.
    expect(CEL_EXPRESSION_WARN_LENGTH).toBe(512);
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
});

