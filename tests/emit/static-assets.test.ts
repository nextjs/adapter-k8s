// tests/emit/static-assets.test.ts
import { describe, it, expect } from "vitest";
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
