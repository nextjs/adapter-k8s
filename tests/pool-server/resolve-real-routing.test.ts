import { describe, expect, it } from "vitest";
import { createLocalResolver } from "../../src/pool-server/resolve.js";
import type { RoutingManifest } from "../../src/types.js";

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
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [
          {
            source: "/:nextInternalLocale(en|nl\\-NL)",
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
        rsc: {
          header: "rsc",
          varyHeader:
            "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
          prefetchHeader: "next-router-prefetch",
          didPostponeHeader: "x-nextjs-postponed",
          contentTypeHeader: "text/x-component",
          suffix: ".rsc",
          prefetchSegmentHeader: "next-router-segment-prefetch",
          prefetchSegmentSuffix: ".segment.rsc",
          prefetchSegmentDirSuffix: ".segments",
          clientParamParsing: false,
          dynamicRSCPrerender: false,
        },
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
});
