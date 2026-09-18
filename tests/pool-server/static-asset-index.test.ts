import { describe, expect, it } from "vitest";
import type { StaticAssetEntry } from "../../src/types.js";
import { createStaticAssetIndex } from "../../src/pool-server/static-asset-index.js";

function asset(pathname: string, filePath: string, prerender = false): StaticAssetEntry {
  return { pathname, filePath, prerender };
}

// These predicates are the pre-index serving expressions. Keep the manifest scan as the oracle:
// trying lookup candidates in order would silently change which conflicting entry wins.
function scanRoute(
  assets: readonly StaticAssetEntry[],
  candidates: readonly string[],
  basePath: string,
  isRsc: boolean,
) {
  return assets.find((a) =>
    candidates.some(
      (candidate) =>
        a.pathname === candidate ||
        a.pathname === (candidate.endsWith("/") ? candidate.slice(0, -1) : candidate + "/") ||
        (candidate === "/" && a.pathname === "/index") ||
        (basePath && candidate === basePath && (a.pathname === "/" || a.pathname === "/index")) ||
        (basePath && candidate === basePath && a.pathname === `${basePath}/index`) ||
        (isRsc && a.pathname === candidate + ".rsc"),
    ),
  );
}

describe("immutable static asset lookup", () => {
  it("preserves manifest priority across aliases and duplicate paths", () => {
    const early = asset("/docs/index", "first.html", true);
    const later = asset("/docs", "second.html", true);
    const duplicate = asset("/docs/index", "third.html", true);
    expect(createStaticAssetIndex([early, later, duplicate]).findRoute(["/docs"], "/docs")).toBe(
      early,
    );
    expect(createStaticAssetIndex([later, early, duplicate]).findRoute(["/docs"], "/docs")).toBe(
      later,
    );
  });

  it("indexes plain and prerender duplicates independently", () => {
    const plain = asset("/same", "public.txt");
    const prerender = asset("/same", "page.html", true);
    for (const assets of [
      [plain, prerender],
      [prerender, plain],
    ]) {
      const index = createStaticAssetIndex(assets);
      expect(index.find(["/same"])).toBe(assets[0]);
      expect(index.find(["/same"], "plain")).toBe(plain);
      expect(index.find(["/same"], "prerender")).toBe(prerender);
      expect(index.hasPlainPath("/same/")).toBe(true);
    }
  });

  it("matches the serving predicates for heterogeneous manifests and candidate permutations", () => {
    const paths = [
      "",
      "/",
      "/index",
      "/docs",
      "/docs/",
      "/docs/index",
      "/docs/index/",
      "/page",
      "/page/",
      "/page.rsc",
      "/page/.rsc",
      "/docs/page",
      "/docs/page/",
      "/caf%C3%A9",
      "/café",
      "/caf%C3%A9/",
      "/café.rsc",
      "/encoded%2Fsegment",
      "/encoded/segment",
      "/_next/static/chunk.js",
      "/missing",
    ];
    const entries = paths.flatMap((pathname, i) => [
      asset(pathname, `asset-${i}`, i % 3 === 0),
      asset(pathname, `duplicate-${i}`, i % 3 !== 0),
    ]);
    const manifests = [
      [],
      entries,
      [...entries].reverse(),
      [...entries.slice(13), ...entries.slice(0, 13)],
    ];
    const candidates = paths.map((pathname) => [pathname]);
    candidates.push(["/caf%C3%A9", "/café"], ["/café", "/caf%C3%A9"], ["/missing", "/page"], []);
    for (const assets of manifests) {
      const index = createStaticAssetIndex(assets);
      for (const names of candidates) {
        for (const basePath of ["", "/docs"]) {
          for (const isRsc of [false, true]) {
            expect(index.findRoute(names, basePath, isRsc)).toBe(
              scanRoute(assets, names, basePath, isRsc),
            );
          }
        }
        expect(index.find(names)).toBe(assets.find((a) => names.includes(a.pathname)));
        expect(index.find(names, "prerender")).toBe(
          assets.find((a) => a.prerender && names.includes(a.pathname)),
        );
        for (const pathname of names) {
          expect(index.hasPlainPath(pathname)).toBe(
            assets.some(
              (a) =>
                !a.prerender &&
                (a.pathname === pathname ||
                  a.pathname === (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/")),
            ),
          );
        }
      }
    }
  });
});
