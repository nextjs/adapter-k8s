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
});

describe("buildRoutingManifest", () => {
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
