// tests/manifest.test.ts
import { describe, it, expect } from "vitest";
import { buildRoutingManifest, collectOutputPathnames } from "../src/manifest.js";
import {
  mockAppPage,
  mockAppRoute,
  mockOutputs,
  mockPrerender,
  mockStaticFile,
  mockRouting,
} from "./helpers/mock-outputs.js";
import type { PoolDefinition } from "../src/types.js";

describe("collectOutputPathnames", () => {
  it("collects unique sorted pathnames from all output types", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/about" }), mockAppPage({ pathname: "/" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
      staticFiles: [mockStaticFile({ pathname: "/_next/static/chunk.js" })],
    });
    const result = collectOutputPathnames(outputs);
    expect(result).toEqual(["/", "/_next/static/chunk.js", "/about", "/api/hello"]);
  });

  it("adds the public '/' alias for the Pages Router '/index' root output", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/index" }), mockAppPage({ pathname: "/about" })],
    });
    const result = collectOutputPathnames(outputs);
    // both the internal "/index" key and the public "/" the request arrives as
    expect(result).toContain("/");
    expect(result).toContain("/index");
    expect(result).toContain("/about");
  });
});

describe("buildRoutingManifest", () => {
  // REGRESSION: middleware config.matcher must be carried into the routing
  // manifest (build-time sourceRegex -> regexp) so the ext_proc edge can gate
  // middleware. Without it the routing service runs middleware on every path.
  it("extracts middleware matchers (sourceRegex -> regexp) into the manifest", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" })],
      middleware: {
        pathname: "/_middleware",
        filePath: "/app/.next/server/middleware.js",
        config: {
          matchers: [
            {
              source: "/only-here",
              sourceRegex: "^\\/only-here$",
              has: [{ type: "header", key: "x" }],
            },
            { source: "/other", sourceRegex: "^\\/other$", missing: [{ type: "query", key: "q" }] },
          ],
        },
      } as any,
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "b",
      basePath: "",
      i18n: null,
      trailingSlash: false,
      nextVersion: "16.2.0",
      projectDir: "/app",
    } as any);
    expect(manifest.middleware?.matchers).toEqual([
      {
        regexp: "^\\/only-here$",
        has: [{ type: "header", key: "x" }],
        originalSource: "/only-here",
      },
      { regexp: "^\\/other$", missing: [{ type: "query", key: "q" }], originalSource: "/other" },
    ]);
  });

  it("generates manifest with routeGraph and pool assignments", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" }), mockAppPage({ pathname: "/about" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
    });
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [outputs.appPages[0]!, outputs.appPages[1]!],
          config: { routes: ["appPages"] },
        },
      ],
      ["api", { name: "api", outputs: [outputs.appRoutes[0]!], config: { routes: ["appRoutes"] } }],
    ]);
    const routing = mockRouting();
    const manifest = buildRoutingManifest({
      routing,
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.buildId).toBe("test123");
    expect(manifest.poolAssignments).toEqual({
      "/": "ssr",
      "/about": "ssr",
      "/api/hello": "api",
    });
    expect(manifest.routeGraph).toBeDefined();
    expect(manifest.pathnames).toContain("/");
    expect(manifest.pathnames).toContain("/api/hello");
  });

  it("wraps rewrite/redirect sourceRegex case-insensitively (matches next start)", () => {
    const routing = mockRouting({
      beforeFiles: [
        { source: "/redir", sourceRegex: "^\\/redir(?:\\/)?$", destination: "/dest", status: 307 },
      ],
      afterFiles: [
        { source: "/rewrite-1", sourceRegex: "^\\/rewrite-1(?:\\/)?$", destination: "/gssp" },
      ],
    });
    const manifest = buildRoutingManifest({
      routing,
      outputs: mockOutputs({}),
      pools: new Map<string, PoolDefinition>(),
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    const rg = manifest.routeGraph as {
      afterFiles: Array<{ sourceRegex: string }>;
      beforeFiles: Array<{ sourceRegex: string }>;
    };
    expect(rg.afterFiles[0]!.sourceRegex).toBe("(?i:^\\/rewrite-1(?:\\/)?$)");
    expect(rg.beforeFiles[0]!.sourceRegex).toBe("(?i:^\\/redir(?:\\/)?$)");
    // the wrapped regex matches a differently-cased request path
    expect(new RegExp(rg.afterFiles[0]!.sourceRegex).test("/Rewrite-1")).toBe(true);
    // named groups + non-source rules are untouched (idempotent, no double-wrap)
    expect(rg.afterFiles[0]!.sourceRegex.startsWith("(?i:(?i:")).toBe(false);
  });

  it("assigns a prerender to its parent route's pool, not the first pool", () => {
    // Multi-pool setup: "web" is first (the default fallback pool), "blog" owns
    // the /blog/[slug] template. A concrete prerender /blog/hello must inherit
    // "blog" via its parentOutputId, not be force-assigned to "web".
    const webPage = mockAppPage({ pathname: "/", id: "/app/page" });
    const blogTemplate = mockAppPage({ pathname: "/blog/[slug]", id: "/app/blog/[slug]" });
    const outputs = mockOutputs({
      appPages: [webPage, blogTemplate],
      prerenders: [
        mockPrerender({
          pathname: "/blog/hello",
          sourcePage: "/blog/[slug]",
          // parentOutputId defaults to `/app/blog/[slug]`, matching blogTemplate.id
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["web", { name: "web", outputs: [webPage], config: { routes: ["appPages"] } }],
      ["blog", { name: "blog", outputs: [blogTemplate], config: { routes: ["/blog/**"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.poolAssignments["/blog/hello"]).toBe("blog");
  });

  it("detects PPR routes from prerenders", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/dashboard" })],
      prerenders: [
        mockPrerender({
          pathname: "/dashboard",
          // @ts-ignore - mock property
          parentOutputId: "/app/dashboard",
          fallback: {
            filePath: "/app/dist/dashboard.html",
            postponedState: "abc123",
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/dashboard"]).toEqual({
      postponedState: "abc123",
      fallbackFilePath: "dist/dashboard.html",
    });
  });

  it("captures shell cache tags + revalidate/expire from fallback.initialHeaders", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/dashboard" })],
      prerenders: [
        mockPrerender({
          pathname: "/dashboard",
          // @ts-ignore - mock property
          parentOutputId: "/app/dashboard",
          fallback: {
            filePath: "/app/dist/dashboard.html",
            postponedState: "abc123",
            // @ts-ignore - mock property
            initialHeaders: { "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/dashboard" },
            initialRevalidate: 60,
            initialExpiration: 300,
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/dashboard"]).toEqual({
      postponedState: "abc123",
      fallbackFilePath: "dist/dashboard.html",
      initialHeaders: { "x-next-cache-tags": "_N_T_/layout,_N_T_/page,_N_T_/dashboard" },
      tags: ["_N_T_/layout", "_N_T_/page", "_N_T_/dashboard"],
      revalidate: 60,
      expire: 300,
    });
  });

  it("excludes PPR routes when postponedState or filePath is missing", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/partial" })],
      prerenders: [
        mockPrerender({
          pathname: "/partial",
          // @ts-ignore - mock property
          parentOutputId: "/app/partial",
          fallback: {
            filePath: undefined,
            postponedState: undefined,
          },
          config: { renderingMode: "PARTIALLY_STATIC" as any },
        }),
      ],
    });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.pprRoutes["/partial"]).toBeUndefined();
  });

  it("places rsc inside routeGraph", () => {
    const outputs = mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] });
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [outputs.appPages[0]!], config: { routes: ["appPages"] } }],
    ]);
    const manifest = buildRoutingManifest({
      routing: mockRouting(),
      outputs,
      pools,
      buildId: "test123",
      basePath: "",
      i18n: null,
      nextVersion: "16.2.0",
      projectDir: "/app",
    });

    expect(manifest.routeGraph.rsc).toBeDefined();
    expect(manifest.routeGraph.rsc.header).toBe("RSC");
    expect((manifest as any).rsc).toBeUndefined();
  });
});
