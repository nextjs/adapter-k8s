// tests/emit/static-assets.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildStaticManifest } from "../../src/emit/static-assets.js";
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
    expect(fav.cacheControl).toBe("public, max-age=3600");
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
      expect(sw.cacheControl).toBe("public, max-age=3600");
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
});
