// tests/pool-server/handler-loader.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveRouteHandlerExport,
  resolveUpgradeHandlerExport,
  createHandlerLoader,
} from "../../src/pool-server/handler-loader.js";

describe("resolveUpgradeHandlerExport", () => {
  it("resolves Next's generated top-level entrypoint", () => {
    const upgradeHandler = () => {};
    expect(resolveUpgradeHandlerExport({ upgradeHandler })).toBe(upgradeHandler);
  });

  it("accepts the dynamic-import wrapper around CommonJS module.exports", () => {
    const upgradeHandler = () => {};
    expect(resolveUpgradeHandlerExport({ default: { upgradeHandler } })).toBe(upgradeHandler);
  });

  it("does not mistake a userland export for the generated adapter contract", () => {
    const upgradeHandler = () => {};
    expect(
      resolveUpgradeHandlerExport({ routeModule: { userland: { upgradeHandler } } }),
    ).toBeUndefined();
  });
});

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

  it("preserves the routeModule receiver for instance handlers", () => {
    const routeModule = {
      marker: "bound",
      handle(this: { marker: string }) {
        return this.marker;
      },
    };
    const handler = resolveRouteHandlerExport({ routeModule });
    expect(handler()).toBe("bound");
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

    // N17: `(group)` and `@slot` are invisible in the URL, but an INTERCEPTION marker is glued
    // to its segment (`(...)post`, `(.)modal`, `(..)(..)b`) and is part of the route id. The
    // old unanchored strips (`/\/\([^/]+\)/g`) ate `(...)post` whole, collapsing
    // `app/feed/@modal/(..)photo/[id]/page` to `/feed/[id]` — the interception route was never
    // found, AND the bogus key could shadow a real `/feed/[id]`.
    it("preserves interception markers while still stripping whole-segment groups/slots", () => {
      const intercepted = () => "intercepted";
      const plain = () => "plain";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_app/feed/@modal/(..)photo/[id]/page": { default: intercepted },
        "middleware_app/feed/[id]/page": { default: plain },
      };
      // The interception marker survives, so its own route id resolves...
      expect(resolveRouteHandlerExport({}, "/feed/(..)photo/[id]")).toBe(intercepted);
      // ...and it does not shadow the real sibling route.
      expect(resolveRouteHandlerExport({}, "/feed/[id]")).toBe(plain);
    });

    it("keeps a leading-segment interception marker like (..)(..)b", () => {
      const fn = () => "double-up";
      const other = () => "other";
      (globalThis as Record<string, unknown>)._ENTRIES = {
        "middleware_app/(..)(..)b/page": { default: fn },
        "middleware_app/(group)/c/page": { default: other },
      };
      expect(resolveRouteHandlerExport({}, "/(..)(..)b")).toBe(fn);
      // A whole-segment route group is still invisible in the URL.
      expect(resolveRouteHandlerExport({}, "/c")).toBe(other);
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
        some_unexpected_key_format: { default: only },
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
  it("imports one module for its HTTP and WebSocket entrypoints", async () => {
    const handler = () => {};
    const upgradeHandler = () => {};
    const loadModule = vi.fn().mockResolvedValue({ handler, upgradeHandler });
    const manifest = {
      buildId: "test123",
      poolName: "routes",
      outputs: {
        "/socket": {
          id: "/socket",
          filePath: "handlers/socket.js",
          pathname: "/socket",
          type: "APP_ROUTE",
          runtime: "nodejs",
        },
      },
    } as any;
    const loader = createHandlerLoader(manifest, loadModule);

    expect(await loader.load("/socket")).toBe(handler);
    expect(await loader.loadUpgrade("/socket")).toBe(upgradeHandler);
    expect(loadModule).toHaveBeenCalledOnce();
  });

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

  it("does not load private ResponseCache code for a module without the route-module seam", async () => {
    const responseCacheCtor = vi.fn(() => {
      throw new Error("private ResponseCache should not be required");
    });
    const loader = createHandlerLoader(
      {
        buildId: "test123",
        poolName: "routes",
        outputs: {
          route: {
            id: "route",
            filePath: "route.js",
            pathname: "/route",
            type: "APP_ROUTE",
          },
        },
      } as any,
      vi.fn().mockResolvedValue({ handler: () => "ok" }),
      { responseCacheCtor: responseCacheCtor as any },
    );

    expect((await loader.load("route"))()).toBe("ok");
    expect(responseCacheCtor).not.toHaveBeenCalled();
  });

  it("un-latches ResponseCache: per-request minimalMode, one instance per mode", async () => {
    // route-module.ts:1101 lazily constructs `new ResponseCache(minimalMode)` ONCE per
    // route-module instance — latching the FIRST request's mode for the process lifetime
    // (our loader caches the module). response-cache/index.ts:493 skips the incremental
    // write under latched-minimal, so a cold pod whose first hit was a MINIMAL document
    // render never persisted a background revalidation again: resume-data-cache served
    // stale >12s on fresh pods while byte-identical sequences passed on warmed ones
    // (codex-traced, 2026-08-04). The loader now wraps getResponseCache to pick a
    // per-MODE instance from the live request's meta.
    const ctorCalls: boolean[] = [];
    class FakeResponseCache {
      constructor(minimal: boolean) {
        ctorCalls.push(minimal);
      }

      async handleRevalidate() {
        return null;
      }
    }
    const routeModule = {
      getResponseCache: () => {
        throw new Error("original latch should have been replaced");
      },
    };
    const loadModule = vi.fn().mockResolvedValue({ handler: () => {}, routeModule });
    const manifest = {
      buildId: "test123",
      poolName: "ssr",
      outputs: {
        "/": { id: "/app/page", filePath: "x.js", pathname: "/", type: "APP_PAGE" },
      },
    } as any;
    const loader = createHandlerLoader(manifest, loadModule, {
      responseCacheCtor: FakeResponseCache as any,
    });
    await loader.load("/");

    const META = Symbol.for("NextInternalRequestMeta");
    const reqMin = { [META]: { minimalMode: true } };
    const reqNonMin = { [META]: { minimalMode: false } };
    const a = routeModule.getResponseCache(reqMin as any);
    const b = routeModule.getResponseCache(reqNonMin as any);
    const a2 = routeModule.getResponseCache(reqMin as any);
    expect(a).not.toBe(b);
    expect(a2).toBe(a); // batcher dedupe preserved within a mode
    expect(ctorCalls).toEqual([true, false]);
  });

  it("forces stale non-minimal PPR regeneration to ignore the old page's RDC", async () => {
    class FakeResponseCache {
      async handleRevalidate(
        _key: string,
        _incrementalCache: unknown,
        _isRoutePPREnabled: boolean,
        _isFallback: boolean,
        generator: (context: Record<string, unknown>) => unknown,
      ) {
        return generator({ forceStaticRender: false });
      }
    }
    const routeModule = { getResponseCache: () => undefined };
    const loader = createHandlerLoader(
      {
        buildId: "test123",
        poolName: "ssr",
        outputs: {
          "/page": {
            id: "/app/page",
            filePath: "x.js",
            pathname: "/page",
            type: "APP_PAGE",
          },
        },
      } as any,
      vi.fn().mockResolvedValue({ handler: () => {}, routeModule }),
      { responseCacheCtor: FakeResponseCache as any, rscHeader: "rsc" },
    );
    await loader.load("/page");

    const META = Symbol.for("NextInternalRequestMeta");
    const responseCache = routeModule.getResponseCache({
      [META]: { minimalMode: false },
    } as any) as any;
    const generator = vi.fn((context) => ({
      cacheControl: { revalidate: 900 },
      value: { kind: "APP_PAGE", context },
    }));

    await responseCache.handleRevalidate(
      "/page",
      { requestHeaders: { rsc: "1" } },
      true,
      false,
      generator,
      { isStale: true, value: { kind: "APP_PAGE" } },
      true,
    );
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ forceStaticRender: true }));

    generator.mockClear();
    await responseCache.handleRevalidate(
      "/page",
      { requestHeaders: {} },
      true,
      false,
      generator,
      { isStale: true, value: { kind: "APP_PAGE" } },
      true,
    );
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ forceStaticRender: false }));

    generator.mockClear();
    await responseCache.handleRevalidate(
      "/page",
      { requestHeaders: { rsc: "1" } },
      true,
      false,
      generator,
      { value: { kind: "APP_PAGE" } },
      false,
    );
    expect(generator).toHaveBeenCalledWith(expect.objectContaining({ forceStaticRender: false }));
  });

  it("refuses a ResponseCache runtime without the required revalidation seam", async () => {
    class IncompatibleResponseCache {}
    const routeModule = { getResponseCache: () => undefined };
    const loader = createHandlerLoader(
      {
        buildId: "test123",
        poolName: "ssr",
        outputs: {
          "/page": { id: "/app/page", filePath: "x.js", pathname: "/page", type: "APP_PAGE" },
        },
      } as any,
      vi.fn().mockResolvedValue({ handler: () => {}, routeModule }),
      { responseCacheCtor: IncompatibleResponseCache as any },
    );
    await loader.load("/page");

    expect(() => routeModule.getResponseCache({})).toThrow(/unsupported.*handleRevalidate/i);
  });

  it("imports and patches one route module shared by multiple output IDs once", async () => {
    class FakeResponseCache {
      async handleRevalidate() {
        return null;
      }
    }
    const routeModule = { getResponseCache: () => undefined };
    const handler = () => undefined;
    const loadModule = vi.fn().mockResolvedValue({ handler, routeModule });
    const loader = createHandlerLoader(
      {
        buildId: "test123",
        poolName: "ssr",
        outputs: {
          page: { id: "page", filePath: "shared.js", pathname: "/page", type: "APP_PAGE" },
          rsc: { id: "rsc", filePath: "shared.js", pathname: "/page.rsc", type: "APP_PAGE" },
        },
      } as any,
      loadModule,
      { responseCacheCtor: FakeResponseCache as any },
    );

    expect(await loader.load("page")).toBe(handler);
    expect(await loader.load("rsc")).toBe(handler);
    expect(loadModule).toHaveBeenCalledOnce();
  });

  it("persists normal and prefetch PPR misses through Next's real minimal ResponseCache", async () => {
    const routeModule = {
      getResponseCache: () => {
        throw new Error("original latch should have been replaced");
      },
    };
    const loader = createHandlerLoader(
      {
        buildId: "test123",
        poolName: "ssr",
        outputs: {
          "/page": {
            id: "/app/page",
            filePath: "x.js",
            pathname: "/page",
            type: "APP_PAGE",
          },
        },
      } as any,
      vi.fn().mockResolvedValue({ handler: () => {}, routeModule }),
    );
    await loader.load("/page");

    const META = Symbol.for("NextInternalRequestMeta");
    const responseCache = routeModule.getResponseCache({
      [META]: { minimalMode: true },
    } as any) as any;
    const set = vi.fn().mockResolvedValue(undefined);
    const incrementalCache = { get: vi.fn(), set };
    const generated = (pathname: string) => {
      return {
        cacheControl: { revalidate: 900, expire: 31_536_000 },
        value: {
          kind: "APP_PAGE",
          html: {
            toUnchunkedString: vi.fn().mockResolvedValue(`<html>${pathname}</html>`),
          },
          postponed: "fresh-token",
        },
      };
    };
    const get = (pathname: string, isPrefetch = false) =>
      responseCache.get(
        pathname,
        vi.fn().mockImplementation(async () => generated(pathname)),
        {
          routeKind: "APP_PAGE",
          incrementalCache,
          isRoutePPREnabled: true,
          isFallback: false,
          isPrefetch,
          invocationID: pathname,
        },
      );

    await Promise.all([get("/page"), get("/page")]);
    // In Next 16.3 a prefetch miss bypasses revalidate() and calls handleRevalidate()
    // directly. This is the path the old fake proof could not exercise.
    await get("/prefetch", true);

    expect(set).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledWith(
      "/page",
      expect.objectContaining({
        kind: "APP_PAGE",
        html: "<html>/page</html>",
      }),
      {
        cacheControl: { revalidate: 900, expire: 31_536_000 },
        isFallback: false,
        isRoutePPREnabled: true,
      },
    );
    expect(set).toHaveBeenCalledWith(
      "/prefetch",
      expect.objectContaining({ kind: "APP_PAGE", html: "<html>/prefetch</html>" }),
      expect.objectContaining({ isRoutePPREnabled: true }),
    );

    const writeError = new Error("Valkey unavailable");
    set.mockRejectedValueOnce(writeError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(get("/write-failure")).resolves.toBeTruthy();
    expect(errorSpy).toHaveBeenCalledWith(
      "[pool-server] minimal PPR cache write failed:",
      writeError,
    );
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
