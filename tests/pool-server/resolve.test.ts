// tests/pool-server/resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLocalResolver } from "../../src/pool-server/resolve.js";
import { mockRouting } from "../helpers/mock-outputs.js";
import type { RoutingManifest } from "../../src/types.js";

vi.mock("@next/routing", async () => {
  const actual = await vi.importActual("@next/routing");
  return {
    ...actual,
    resolveRoutes: vi.fn(),
  };
});
import { resolveRoutes } from "@next/routing";

function makeManifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  const routing = mockRouting();
  return {
    routeGraph: {
      beforeMiddleware: routing.beforeMiddleware,
      beforeFiles: routing.beforeFiles,
      afterFiles: routing.afterFiles,
      dynamicRoutes: routing.dynamicRoutes,
      onMatch: routing.onMatch,
      fallback: routing.fallback,
      shouldNormalizeNextData: routing.shouldNormalizeNextData,
      rsc: routing.rsc,
    },
    pathnames: ["/", "/about", "/api/hello", "/old-page"],
    i18n: null,
    buildId: "test123",
    basePath: "",
    middleware: null,
    poolAssignments: { "/": "ssr", "/about": "ssr", "/api/hello": "api" },
    pprRoutes: {},
    nextVersion: "16.2.0",
    ...overrides,
  };
}

describe("createLocalResolver", () => {
  it("resolves a known static route", async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about" },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.pool).toBe("ssr");
    }
  });

  it("returns redirect when resolveRoutes returns redirect", async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      redirect: { url: new URL("http://localhost/new-page"), status: 301 },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/old-page"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("redirect");
    if (result.kind === "redirect") {
      expect(result.status).toBe(301);
      expect(result.url.pathname).toBe("/new-page");
    }
  });

  it("invokes legacy middleware default.default({ request }) entrypoint", async () => {
    const manifest = makeManifest();
    const legacyMiddleware = vi.fn().mockResolvedValue({
      response: new Response(null, {
        status: 200,
        headers: { "x-middleware-next": "1" },
      }),
      waitUntil: Promise.resolve(),
    });

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/__cookies__"),
        headers: new Headers({ cookie: "a=1" }),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about" },
      };
    });

    const resolver = createLocalResolver(manifest, {
      default: {
        default: legacyMiddleware,
      },
    });

    await resolver.resolve(
      new URL("http://localhost/__cookies__"),
      new Headers({ cookie: "a=1" }),
      "POST",
      new ReadableStream<Uint8Array>(),
    );

    expect(legacyMiddleware).toHaveBeenCalledTimes(1);
    expect(legacyMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "http://localhost/__cookies__",
          method: "POST",
          headers: expect.objectContaining({ cookie: "a=1" }),
        }),
      }),
    );
  });

  it("returns middleware-response when middleware sends a response body", async () => {
    const manifest = makeManifest();
    const legacyMiddleware = vi.fn().mockResolvedValue({
      response: new Response("blocked", {
        status: 401,
        headers: { "content-type": "text/plain" },
      }),
      waitUntil: Promise.resolve(),
    });

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      const result = await options.invokeMiddleware({
        url: new URL("http://localhost/__cookies__"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      return {
        middlewareResponded: !!result.bodySent,
      };
    });

    const resolver = createLocalResolver(manifest, {
      default: {
        default: legacyMiddleware,
      },
    });

    const result = await resolver.resolve(
      new URL("http://localhost/__cookies__"),
      new Headers(),
      "POST",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("middleware-response");
    if (result.kind === "middleware-response") {
      expect(result.response.status).toBe(401);
    }
  });

  it("continues route resolution when middleware returns x-middleware-next", async () => {
    const manifest = makeManifest();
    const legacyMiddleware = vi.fn().mockResolvedValue({
      response: new Response(null, {
        status: 200,
        headers: { "x-middleware-next": "1" },
      }),
      waitUntil: Promise.resolve(),
    });

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      const middlewareResult = await options.invokeMiddleware({
        url: new URL("http://localhost/about"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      expect(middlewareResult.bodySent).toBeFalsy();

      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about" },
      };
    });

    const resolver = createLocalResolver(manifest, {
      default: {
        default: legacyMiddleware,
      },
    });

    const result = await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.pool).toBe("ssr");
      expect(result.matchedPathname).toBe("/about");
    }
  });

  it("invokes web adapter middleware default({ handler, request, page })", async () => {
    const manifest = makeManifest();
    // Web adapter: module.default is a function that wraps a handler.
    // This is the shape Next.js uses for Node-compiled middleware.
    const adapterFn = vi.fn().mockResolvedValue({
      response: new Response(null, {
        status: 200,
        headers: { "x-middleware-next": "1" },
      }),
    });

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/about"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about" },
      };
    });

    // Module shape: { default: adapterFn, proxy: handlerObj }
    const resolver = createLocalResolver(manifest, {
      default: adapterFn,
      proxy: { handle: vi.fn() },
    });

    await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(adapterFn).toHaveBeenCalledTimes(1);
    expect(adapterFn).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: expect.anything(),
        request: expect.objectContaining({
          url: "http://localhost/about",
          method: "GET",
        }),
        page: "middleware",
      }),
    );
  });

  it("invokes direct handler middleware handler(request, { waitUntil })", async () => {
    const manifest = makeManifest();
    // Direct handler: module has no default function and no default.default.
    // Falls through to path 3: handlerFn(request, { waitUntil }).
    const directHandler = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { "x-middleware-next": "1" },
      }),
    );

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/about"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about" },
      };
    });

    // Module shape: just a function (no default wrapper, no default.default)
    // The code sets handlerFn = module.proxy || module.middleware || module
    // and since module is a function, typeof handlerFn === "function" → path 3
    const resolver = createLocalResolver(manifest, {
      middleware: directHandler,
    } as any);

    await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(directHandler).toHaveBeenCalledTimes(1);
    expect(directHandler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        waitUntil: expect.any(Function),
      }),
    );
  });

  it("returns empty result when no middleware module is provided", async () => {
    const manifest = makeManifest();

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      const result = await options.invokeMiddleware({
        url: new URL("http://localhost/about"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });

      // No middleware → empty result
      expect(result).toEqual({});

      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about" },
      };
    });

    const resolver = createLocalResolver(manifest);

    const result = await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
  });
});
