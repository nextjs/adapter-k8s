// tests/pool-server/handler-loader.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveRouteHandlerExport,
  createHandlerLoader,
} from "../../src/pool-server/handler-loader.js";

describe("resolveRouteHandlerExport", () => {
  it("resolves module.handler", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ handler: fn });
    expect(handler).toBe(fn);
  });

  it("resolves module.default when it is a function", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: fn });
    expect(handler).toBe(fn);
  });

  it("resolves module.default.handler", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: { handler: fn } });
    expect(handler).toBe(fn);
  });

  it("resolves module.default.fetch", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: { fetch: fn } });
    expect(handler).toBe(fn);
  });

  it("resolves module.fetch", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ fetch: fn });
    expect(handler).toBe(fn);
  });

  it("throws when no handler found", () => {
    expect(() => resolveRouteHandlerExport({ foo: "bar" })).toThrow(/handler/i);
  });

  describe("_ENTRIES fallback (Turbopack edge modules)", () => {
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)._ENTRIES;
    });

    it("uses the single registered entry when exactly one exists", () => {
      const fn = () => {};
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_edge/one": { default: fn },
      };
      expect(resolveRouteHandlerExport({})).toBe(fn);
    });

    it("refuses to guess when multiple entries are registered and no route is given", () => {
      const fnA = () => "a";
      const fnB = () => "b";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_edge/route-a": { default: fnA },
        "middleware_edge/route-b": { default: fnB },
      };
      expect(() => resolveRouteHandlerExport({})).toThrow(/handler/i);
    });

    it("selects THIS route's entry by key when multiple edge routes are registered", () => {
      // _ENTRIES is process-global and cumulative: with two edge routes loaded, the
      // old exactly-one gate made the second route 500 forever. The keys embed the
      // route (`middleware_app/api/edge/route`), so the lookup must be keyed.
      const fnA = () => "a";
      const fnB = () => "b";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_app/api/edge-a/route": { default: fnA },
        "middleware_app/api/edge-b/route": { default: fnB },
      };
      expect(resolveRouteHandlerExport({}, "/api/edge-a")).toBe(fnA);
      expect(resolveRouteHandlerExport({}, "/api/edge-b")).toBe(fnB);
    });

    it("matches pages entries, dynamic segments, and route groups", () => {
      const page = () => "page";
      const pagesApi = () => "pagesApi";
      const dynamic = () => "dynamic";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_app/(marketing)/about/page": { default: page },
        "middleware_pages/api/legacy": { default: pagesApi },
        "middleware_app/blog/[slug]/route": { default: dynamic },
      };
      expect(resolveRouteHandlerExport({}, "/about")).toBe(page);
      expect(resolveRouteHandlerExport({}, "/api/legacy")).toBe(pagesApi);
      expect(resolveRouteHandlerExport({}, "/blog/[slug]")).toBe(dynamic);
    });

    it("throws on genuine ambiguity: several entries and none match the route", () => {
      const other = () => "other";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_app/api/edge-a/route": { default: other },
        "middleware_app/api/edge-b/route": { default: other },
      };
      expect(() => resolveRouteHandlerExport({}, "/api/unrelated")).toThrow(/handler/i);
    });

    it("falls back to a lone registered entry when the key doesn't match the route", () => {
      // A single entry is unambiguous even if the key format is unexpected —
      // preserve the pre-keying behavior for one-edge-route pools.
      const only = () => "only";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "some_unexpected_key_format": { default: only },
      };
      expect(resolveRouteHandlerExport({}, "/api/edge")).toBe(only);
    });

    it("still prefers the module's own exports over _ENTRIES", () => {
      const own = () => "own";
      const other = () => "other";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_edge/route-a": { default: other },
        "middleware_edge/route-b": { default: other },
      };
      expect(resolveRouteHandlerExport({ handler: own })).toBe(own);
    });
  });
});

describe("createHandlerLoader", () => {
  it("loads and caches handler modules", async () => {
    const mockHandler = () => {};
    const loadModule = vi.fn().mockResolvedValue({ handler: mockHandler });

    const manifest = {
      buildId: "test123",
      poolName: "ssr",
      outputs: {
        "/": {
          id: "/app/page",
          filePath: "/app/.next/server/app/page.js",
          pathname: "/",
          type: "APP_PAGE",
        },
      },
    } as any;

    const loader = createHandlerLoader(manifest, loadModule);

    const handler1 = await loader.load("/");
    expect(handler1).toBe(mockHandler);
    expect(loadModule).toHaveBeenCalledTimes(1);

    // Second call uses cache
    const handler2 = await loader.load("/");
    expect(handler2).toBe(mockHandler);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("throws for unknown output ID", async () => {
    const manifest = { buildId: "test123", poolName: "ssr", outputs: {} } as any;
    const loader = createHandlerLoader(manifest, vi.fn());
    await expect(loader.load("unknown")).rejects.toThrow(/unknown/i);
  });

  it("loads BOTH edge routes of a pool via the keyed _ENTRIES fallback", async () => {
    // Regression: _ENTRIES is process-global, so after the first edge module loaded,
    // the second edge route's resolution saw two entries and threw — 500ing that
    // route for the life of the pod.
    const fnA = () => "a";
    const fnB = () => "b";
    (globalThis as Record<string, unknown>)._ENTRIES = {
      "middleware_app/api/edge-a/route": { default: fnA },
      "middleware_app/api/edge-b/route": { default: fnB },
    };
    try {
      const manifest = {
        buildId: "test123",
        poolName: "edge",
        outputs: {
          "/api/edge-a": {
            id: "/api/edge-a",
            filePath: "handlers/edge-a.js",
            pathname: "/api/edge-a",
            type: "APP_ROUTE",
            runtime: "edge",
          },
          "/api/edge-b": {
            id: "/api/edge-b",
            filePath: "handlers/edge-b.js",
            pathname: "/api/edge-b",
            type: "APP_ROUTE",
            runtime: "edge",
          },
        },
      } as any;
      // Edge modules register into _ENTRIES as an import side effect and export
      // nothing usable themselves.
      const loadModule = vi.fn().mockResolvedValue({});
      const loader = createHandlerLoader(manifest, loadModule);

      expect(await loader.load("/api/edge-a")).toBe(fnA);
      expect(await loader.load("/api/edge-b")).toBe(fnB);
    } finally {
      delete (globalThis as Record<string, unknown>)._ENTRIES;
    }
  });

  it("evicts a rejected load so a later request can retry", async () => {
    const manifest = {
      buildId: "test123",
      poolName: "ssr",
      outputs: {
        "/": {
          id: "/app/page",
          filePath: "/app/.next/server/app/page.js",
          pathname: "/",
          type: "APP_PAGE",
        },
      },
    } as any;

    const mockHandler = () => {};
    const loadModule = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient import failure"))
      .mockResolvedValueOnce({ handler: mockHandler });

    const loader = createHandlerLoader(manifest, loadModule);

    await expect(loader.load("/")).rejects.toThrow(/transient/i);
    // The failure must not be cached — the retry should call loadModule again and succeed.
    const handler = await loader.load("/");
    expect(handler).toBe(mockHandler);
    expect(loadModule).toHaveBeenCalledTimes(2);
  });
});
