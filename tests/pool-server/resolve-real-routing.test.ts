import { describe, expect, it } from "vitest";
import { createLocalResolver } from "../../src/pool-server/resolve.js";
import type { RoutingManifest } from "../../src/types.js";

const rsc = {
  header: "rsc",
  varyHeader: "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
  prefetchHeader: "next-router-prefetch",
  didPostponeHeader: "x-nextjs-postponed",
  contentTypeHeader: "text/x-component",
  suffix: ".rsc",
  prefetchSegmentHeader: "next-router-segment-prefetch",
  prefetchSegmentSuffix: ".segment.rsc",
  prefetchSegmentDirSuffix: ".segments",
  clientParamParsing: false,
  dynamicRSCPrerender: false,
};

// Unlike resolve.test.ts, this file intentionally uses the real @next/routing implementation.
// It locks the compiled route shape emitted by Next for `rewrites: [{ source: "/", ... }]` with
// i18n enabled; mocking this boundary previously hid the index-rewrite regression.
describe("createLocalResolver with real @next/routing", () => {
  it.each([
    ["/", "en"],
    ["/nl-NL", "nl-NL"],
  ])("resolves an i18n index rewrite for %s", async (pathname, locale) => {
    const manifest: RoutingManifest = {
      routeGraph: {
        caseSensitive: true,
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [
          {
            source: "/:nextInternalLocale(en|nl\\-NL)",
            // The adapter scopes case folding to custom routes so dynamic routes remain
            // case-sensitive through every ordered @next/routing resolution stage.
            sourceRegex: "(?i:^(?:\\/(en|nl\\-NL))(?:\\/)?$)",
            destination: "/$1/company/about-us?nextInternalLocale=$1",
          },
        ],
        dynamicRoutes: [
          {
            source: "/[...slug]",
            sourceRegex: "^[/]?(?<nextLocale>[^/]{1,})/(?<nxtPslug>.+?)(?:/)?$",
            destination: "/$nextLocale/[...slug]?nxtPslug=$nxtPslug",
          },
        ],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc,
      },
      pathnames: ["/[...slug]", "/en/company/about-us", "/nl-NL/company/about-us"],
      i18n: { locales: ["en", "nl-NL"], defaultLocale: "en" },
      buildId: "build-id",
      basePath: "",
      middleware: null,
      poolAssignments: {
        "/[...slug]": "default",
        "/en/company/about-us": "default",
        "/nl-NL/company/about-us": "default",
      },
      pprRoutes: {},
      nextVersion: "16.3.0",
    };

    const result = await createLocalResolver(manifest).resolve(
      new URL(`http://localhost${pathname}`),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe(`/${locale}/company/about-us`);
      expect(result.invokePath).toBe(
        `${locale === "en" ? "" : `/${locale}`}/company/about-us?nextInternalLocale=${locale}`,
      );
    }
  });

  it("keeps custom routes insensitive and filesystem dynamic routes sensitive by default", async () => {
    const manifest: RoutingManifest = {
      routeGraph: {
        caseSensitive: true,
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [
          {
            source: "/rewrite",
            sourceRegex: "(?i:^\\/rewrite(?:\\/)?$)",
            destination: "/blog/rewritten",
          },
        ],
        dynamicRoutes: [
          {
            source: "/blog/[slug]",
            sourceRegex: "^\\/blog\\/([^/]+?)(?:\\/)?$",
            destination: "/blog/[slug]?slug=$1",
          },
        ],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc,
      },
      pathnames: ["/blog/[slug]"],
      i18n: null,
      buildId: "build-id",
      basePath: "",
      middleware: null,
      poolAssignments: { "/blog/[slug]": "default" },
      pprRoutes: {},
      nextVersion: "16.3.0",
    };
    const resolver = createLocalResolver(manifest);
    const body = () => new ReadableStream<Uint8Array>();

    const custom = await resolver.resolve(
      new URL("http://localhost/REWRITE"),
      new Headers(),
      "GET",
      body(),
    );
    expect(custom.kind).toBe("route");
    if (custom.kind === "route") expect(custom.matchedPathname).toBe("/blog/[slug]");

    const dynamic = await resolver.resolve(
      new URL("http://localhost/BLOG/direct"),
      new Headers(),
      "GET",
      body(),
    );
    // The resolver still selects a fail-safe pool when no route matches; the important contract
    // is that it does not dispatch the differently-cased request to the dynamic template.
    expect(dynamic.kind).toBe("route");
    if (dynamic.kind === "route") expect(dynamic.matchedPathname).toBe("/BLOG/direct");

    const sensitiveResolver = createLocalResolver({
      ...manifest,
      routeGraph: {
        ...manifest.routeGraph,
        afterFiles: [
          {
            source: "/rewrite",
            sourceRegex: "^\\/rewrite(?:\\/)?$",
            destination: "/blog/rewritten",
          },
        ],
      },
    });
    const sensitiveCustom = await sensitiveResolver.resolve(
      new URL("http://localhost/REWRITE"),
      new Headers(),
      "GET",
      body(),
    );
    expect(sensitiveCustom.kind).toBe("route");
    if (sensitiveCustom.kind === "route") {
      expect(sensitiveCustom.matchedPathname).toBe("/REWRITE");
    }
  });

  it("continues ordered rewrites before accepting a case-valid dynamic match", async () => {
    const manifest: RoutingManifest = {
      routeGraph: {
        caseSensitive: true,
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [
          { sourceRegex: "(?i:^/start$)", destination: "/BLOG/x" },
          { sourceRegex: "(?i:^/BLOG/x$)", destination: "/blog/x" },
        ],
        dynamicRoutes: [
          {
            sourceRegex: "^/blog/([^/]+?)$",
            destination: "/blog/[slug]?slug=$1",
          },
        ],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc,
      },
      pathnames: ["/blog/[slug]"],
      i18n: null,
      buildId: "build-id",
      basePath: "",
      middleware: null,
      poolAssignments: { "/blog/[slug]": "default" },
      pprRoutes: {},
      nextVersion: "16.3.0",
    };
    const result = await createLocalResolver(manifest).resolve(
      new URL("http://localhost/start"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe("/blog/[slug]");
      expect(result.invokePath).toBe("/blog/x?slug=x");
    }
  });
});
