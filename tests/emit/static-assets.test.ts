// tests/emit/static-assets.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStaticManifest } from "../../src/emit/static-assets.js";
import { cdnCacheTag } from "../../src/cdn-tags.js";
import type { AdapterOutputs } from "../../src/types.js";

function outputs(over: Partial<AdapterOutputs> = {}): AdapterOutputs {
  return {
    staticFiles: [],
    prerenders: [],
    appPages: [],
    appRoutes: [],
    pages: [],
    pagesApi: [],
    ...(over as any),
  } as unknown as AdapterOutputs;
}

const PROJ = "/proj";

describe("buildStaticManifest", () => {
  it("emits public/build static files with the right cache-control", () => {
    const m = buildStaticManifest(
      outputs({
        staticFiles: [
          { pathname: "/favicon.ico", filePath: `${PROJ}/public/favicon.ico` },
          {
            pathname: "/_next/static/x.js",
            filePath: `${PROJ}/.next/static/x.js`,
            immutableHash: "abc",
          },
        ] as any,
      }),
      PROJ,
    );
    const fav = m.find((e) => e.pathname === "/favicon.ico")!;
    expect(fav.filePath).toBe("public/favicon.ico");
    // N50: parity with `next start` — measured on 16.2.10, a non-`_next/static` file is
    // served by `send` with no maxAge, i.e. `Cache-Control: public, max-age=0`.
    expect(fav.cacheControl).toBe("public, max-age=0, must-revalidate");
    expect(fav.prerender).toBeUndefined();
    const imm = m.find((e) => e.pathname === "/_next/static/x.js")!;
    expect(imm.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("serves service workers as mutable with Service-Worker-Allowed (not immutable)", () => {
    const m = buildStaticManifest(
      outputs({
        staticFiles: [
          {
            pathname: "/_next/static/service-worker/sw.js",
            filePath: `${PROJ}/.next/static/service-worker/sw.js`,
            immutableHash: undefined,
          },
        ] as any,
      }),
      PROJ,
    );
    const sw = m.find((e) => e.pathname === "/_next/static/service-worker/sw.js")!;
    expect(sw.cacheControl).toBe("public, max-age=0, must-revalidate");
    expect(sw.cacheControl).not.toContain("immutable");
    expect(sw.headers).toEqual({ "Service-Worker-Allowed": "/" });
  });

  it("uses basePath for the service-worker scope when configured", () => {
    const m = buildStaticManifest(
      outputs({
        staticFiles: [
          { pathname: "/_next/static/service-worker/sw.js", filePath: `${PROJ}/x` },
        ] as any,
      }),
      PROJ,
      "/app",
    );
    expect(m[0]!.headers).toEqual({ "Service-Worker-Allowed": "/app" });
  });

  it("serves non-content-hashed _next/static assets immutable too (matches Next's server)", () => {
    const m = buildStaticManifest(
      outputs({
        staticFiles: [
          // _buildManifest.js has a stable name (no immutableHash) but lives under the build-id path
          { pathname: "/_next/static/BUILDID/_buildManifest.js", filePath: `${PROJ}/x` },
        ] as any,
      }),
      PROJ,
    );
    expect(m[0]!.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  // REGRESSION: prerenders must be marked prerender:true so dispatch routes them
  // through the Next handler (ISR/draft/revalidate), and carry the revalidate
  // window. A missing flag would serve stale build files forever.
  it("marks prerenders with prerender:true and carries revalidate/status/headers", () => {
    const m = buildStaticManifest(
      outputs({
        prerenders: [
          {
            pathname: "/blog/first",
            fallback: {
              filePath: `${PROJ}/.next/server/app/blog/first.html`,
              initialStatus: 200,
              initialHeaders: { "x-custom": "1" },
              initialRevalidate: 60,
            },
          },
          {
            pathname: "/404",
            fallback: {
              filePath: `${PROJ}/.next/server/pages/404.html`,
              initialStatus: 404,
            },
          },
        ] as any,
      }),
      PROJ,
    );
    const blog = m.find((e) => e.pathname === "/blog/first")!;
    expect(blog.prerender).toBe(true);
    expect(blog.revalidate).toBe(60);
    expect(blog.status).toBe(200);
    expect(blog.headers).toEqual({ "x-custom": "1" });
    expect(blog.cacheControl).toBe("public, max-age=0, must-revalidate");

    const nf = m.find((e) => e.pathname === "/404")!;
    expect(nf.prerender).toBe(true);
    expect(nf.status).toBe(404); // initialStatus honored (not forced 200)
  });

  it("marks PPR prerenders (postponedState) with ppr:true", () => {
    const m = buildStaticManifest(
      outputs({
        prerenders: [
          {
            pathname: "/ppr",
            fallback: {
              filePath: `${PROJ}/.next/server/app/ppr.html`,
              postponedState: "<postponed>",
            },
          },
        ] as any,
      }),
      PROJ,
    );
    expect(m[0]!.ppr).toBe(true);
    expect(m[0]!.prerender).toBe(true);
  });

  // REGRESSION (live deploy XchOtaGFu6GdFrcdujVc0): Next's adapter outputs do NOT
  // enumerate public/ — outputs.staticFiles covers only build outputs — so the
  // emitted static-assets.json had zero public entries. The pool dispatcher serves
  // Phase-2 (trusted routing-extension dispatch) responses EXCLUSIVELY from this
  // manifest, so every middleware-covered public asset 404'd in production while
  // local Phase-1 resolution still found the file on disk. The manifest must carry
  // the same public/ inventory the pool's filesystem fast paths use.
  describe("public/ directory enumeration", () => {
    let projDir: string;

    beforeEach(() => {
      projDir = mkdtempSync(path.join(os.tmpdir(), "static-assets-public-"));
      const pub = path.join(projDir, "public");
      mkdirSync(path.join(pub, "nested"), { recursive: true });
      writeFileSync(path.join(pub, "sw-revalidation-probe.js"), "self.x=1");
      writeFileSync(path.join(pub, "image probe.svg"), "<svg/>");
      writeFileSync(path.join(pub, "nested", "deep.txt"), "deep");
    });

    afterEach(() => {
      rmSync(projDir, { recursive: true, force: true });
    });

    it("emits every public/ file with the mutable public-file default cache policy", () => {
      const m = buildStaticManifest(outputs(), projDir);
      const sw = m.find((e) => e.pathname === "/sw-revalidation-probe.js")!;
      expect(sw).toBeDefined();
      expect(sw.filePath).toBe("public/sw-revalidation-probe.js");
      expect(sw.cacheControl).toBe("public, max-age=0, must-revalidate");
      expect(sw.prerender).toBeUndefined();
      const nested = m.find((e) => e.pathname === "/nested/deep.txt")!;
      expect(nested.filePath).toBe("public/nested/deep.txt");
    });

    // The dispatcher matches manifest pathnames against `new URL(req.url).pathname`
    // (x-output-id at the edge preserves the request's percent-encoding), so a file
    // named with a space must be keyed "/image%20probe.svg" — the decoded form can
    // never match and 404s.
    it("keys names needing percent-encoding by their canonical URL-encoded pathname", () => {
      const m = buildStaticManifest(outputs(), projDir);
      expect(m.some((e) => e.pathname === "/image probe.svg")).toBe(false);
      const img = m.find((e) => e.pathname === "/image%20probe.svg")!;
      expect(img).toBeDefined();
      // filePath stays decoded — it addresses the real file on disk.
      expect(img.filePath).toBe("public/image probe.svg");
    });

    // N50 (review, Medium): `public, max-age=3600` was NOT what `next start` sends.
    // Measured against real `next start` (Next 16.2.10, arbiter run in scratch):
    //   GET /probe.txt  → Cache-Control: public, max-age=0   (+ weak ETag, Last-Modified)
    //   GET /sw.js      → Cache-Control: public, max-age=0
    //   GET /_next/static/chunks/<hash>.js → public, max-age=31536000, immutable
    // router-server.ts sets Cache-Control only for `nextStaticFolder` matches; public files
    // fall through to `send` with no maxAge (its default is 0). Behind Cloud CDN plus
    // browser caches, an hour-long max-age meant a replaced logo.png — or a cached 404 for
    // a path that just became valid — stayed stale for up to an hour past cutover, and
    // deploy-time cache-tag invalidation reaches the CDN but never the clients.
    it("matches `next start` for public files (max-age=0, revalidated via ETag)", () => {
      const m = buildStaticManifest(outputs(), projDir);
      for (const e of m) {
        expect(e.cacheControl).toBe("public, max-age=0, must-revalidate");
        expect(e.cacheControl).not.toContain("3600");
      }
    });

    // The deliberate choice (see the MUTABLE_FILE_CACHE_CONTROL comment): NO `s-maxage`, so
    // `cdnCacheTag` yields no cache-tag and Cloud CDN stores nothing for a public file. A CDN
    // entry for a public file is precisely the object that can be served without the
    // middleware tier running (invariant 2), and `next start` sends no shared-cache directive
    // (invariant 4). Pinned so a future "let's keep the CDN TTL" edit has to argue with a test.
    it("emits no shared-cache freshness for public files, so no CDN entry to invalidate", () => {
      const m = buildStaticManifest(outputs(), projDir);
      for (const e of m) {
        expect(e.cacheControl).not.toMatch(/s-maxage/);
        expect(cdnCacheTag(e.cacheControl, "b12345")).toEqual({});
      }
    });

    // N50 (review, Medium): canonicalPublicPathname ran the name through the WHATWG URL
    // parser, which MAPS `\` to `/` and STRIPS tab/CR/LF instead of encoding them. So
    // `public/a\b.svg` was keyed "/a/b.svg" — colliding with a real `public/a/b.svg` (the
    // dedup then drops one) or making /a/b.svg serve the backslash file — and
    // `public/a<TAB>b.svg` was keyed "/ab.svg", a pathname no request can ever produce.
    it("percent-encodes backslashes and C0 controls instead of letting URL() fold them", () => {
      const pub = path.join(projDir, "public");
      writeFileSync(path.join(pub, "a\\b.svg"), "<svg/>"); // literal backslash in the name
      writeFileSync(path.join(pub, "c\td.svg"), "<svg/>"); // literal tab in the name
      mkdirSync(path.join(pub, "a"), { recursive: true });
      writeFileSync(path.join(pub, "a", "b.svg"), "<svg>real</svg>");

      const m = buildStaticManifest(outputs(), projDir);
      const byPath = new Map(m.map((e) => [e.pathname, e.filePath]));
      expect(byPath.get("/a%5Cb.svg")).toBe("public/a\\b.svg");
      expect(byPath.get("/c%09d.svg")).toBe("public/c\td.svg");
      // The real nested file keeps the unambiguous key, and nothing collides with it.
      expect(byPath.get("/a/b.svg")).toBe("public/a/b.svg");
      expect(m.filter((e) => e.pathname === "/a/b.svg")).toHaveLength(1);
    });

    it("does not duplicate a public pathname already present in outputs.staticFiles", () => {
      const m = buildStaticManifest(
        outputs({
          staticFiles: [
            {
              pathname: "/sw-revalidation-probe.js",
              filePath: `${projDir}/public/sw-revalidation-probe.js`,
            },
          ] as any,
        }),
        projDir,
      );
      expect(m.filter((e) => e.pathname === "/sw-revalidation-probe.js")).toHaveLength(1);
    });

    it("emits nothing extra when the project has no public/ directory", () => {
      const empty = mkdtempSync(path.join(os.tmpdir(), "static-assets-nopublic-"));
      try {
        expect(buildStaticManifest(outputs(), empty)).toEqual([]);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });

  it("skips prerenders/static files with no filePath and sorts by pathname", () => {
    const m = buildStaticManifest(
      outputs({
        staticFiles: [{ pathname: "/z.txt", filePath: `${PROJ}/z.txt` }] as any,
        prerenders: [
          { pathname: "/a", fallback: { filePath: undefined } },
          { pathname: "/b", fallback: { filePath: `${PROJ}/b.html` } },
        ] as any,
      }),
      PROJ,
    );
    expect(m.map((e) => e.pathname)).toEqual(["/b", "/z.txt"]); // /a skipped, sorted
  });

  // N50 (review, Low): `localeCompare` makes the order ICU-dependent — a small-icu Node
  // and a full-icu Node produce DIFFERENT bytes for the same build, and that file ships
  // inside the image (and into the chart's Docker context), so the same build stops being
  // reproducible across build hosts. Sort by code point instead.
  it("sorts by code point, not locale collation", () => {
    const names = ["/b.txt", "/B.txt", "/a.txt", "/_x.txt", "/-y.txt", "/A.txt"];
    const m = buildStaticManifest(
      outputs({
        staticFiles: names.map((pathname) => ({ pathname, filePath: `${PROJ}${pathname}` })) as any,
      }),
      PROJ,
    );
    expect(m.map((e) => e.pathname)).toEqual([...names].sort());
    // Locale collation would order these differently (case-insensitive-ish, punctuation
    // partially ignored) — pin that the emitted order is NOT the ICU one.
    expect(m.map((e) => e.pathname)).not.toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
