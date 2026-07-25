// tests/pool-server/resolve.test.ts
import { describe, it, expect, vi } from "vitest";
import { createLocalResolver, hasCallableMiddlewareExport } from "../../src/pool-server/resolve.js";
import { mockRouting } from "../helpers/mock-outputs.js";
import type { RoutingManifest } from "../../src/types.js";

vi.mock("@next/routing", async () => {
  const actual = await vi.importActual("@next/routing");
  // routing-common.ts imports the CJS default and destructures detect*; expose a
  // `default` alongside the named exports so both import styles resolve.
  const mocked = {
    ...actual,
    resolveRoutes: vi.fn(),
  };
  return { ...mocked, default: mocked };
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
  it("fails closed when the manifest declares middleware but no callable implementation exists", async () => {
    const resolver = createLocalResolver(
      makeManifest({ middleware: { filePath: "middleware.js" } }),
      {},
    );

    await expect(
      resolver.resolve(
        new URL("http://localhost/protected"),
        new Headers(),
        "GET",
        new ReadableStream<Uint8Array>(),
      ),
    ).resolves.toEqual({ kind: "error", status: 500 });
    expect(resolveRoutes).not.toHaveBeenCalled();
  });

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

  it("prefers the concrete rewrite destination over a dynamic template that also matches", async () => {
    // A rewrite `/rewrite-1 -> /gssp` where a `/[slug]` dynamic route also
    // exists: @next/routing reports resolvedPathname `/[slug]` (the destination
    // `/gssp` matches the dynamic route too) but invocationTarget `/gssp` — the
    // real page. The resolver must route to `/gssp`, not the `[slug]` handler.
    const manifest = makeManifest({
      pathnames: ["/", "/gssp", "/[slug]"],
      poolAssignments: { "/gssp": "ssr", "/[slug]": "ssr" },
    });
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/[slug]",
      invocationTarget: { pathname: "/gssp", query: { nxtPslug: "gssp" } },
      routeMatches: { nxtPslug: "gssp" },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/rewrite-1"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe("/gssp");
    }
  });

  it("does not let a concrete request-path sibling override a beforeFiles rewrite", async () => {
    const manifest = makeManifest({
      pathnames: ["/", "/featured", "/[teamSlug]"],
      poolAssignments: { "/featured": "ssr", "/[teamSlug]": "ssr" },
    });
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/[teamSlug]",
      invocationTarget: { pathname: "/some-team", query: { nxtPteamSlug: "some-team" } },
      routeMatches: { nxtPteamSlug: "some-team" },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/featured"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe("/[teamSlug]");
      expect(result.invokePath).toBe("/some-team");
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
    let backgroundComplete = false;
    const directHandler = vi.fn(async (_request: Request, ctx: { waitUntil: Function }) => {
      ctx.waitUntil(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            backgroundComplete = true;
            resolve();
          }, 5);
        }),
      );
      return new Response(null, {
        status: 200,
        headers: { "x-middleware-next": "1" },
      });
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
    expect(backgroundComplete).toBe(true);
  });

  it("prefers the generated handler entrypoint over compatibility default exports", async () => {
    const manifest = makeManifest();
    const generatedHandler = vi
      .fn()
      .mockResolvedValue(new Response(null, { headers: { "x-middleware-next": "1" } }));
    const compatibilityDefault = vi.fn();
    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/about"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });
      return { resolvedPathname: "/about", invocationTarget: { pathname: "/about" } };
    });

    const resolver = createLocalResolver(manifest, {
      handler: generatedHandler,
      default: compatibilityDefault,
    });
    await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(generatedHandler).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        waitUntil: expect.any(Function),
        requestMeta: { relativeProjectDir: "." },
      }),
    );
    expect(compatibilityDefault).not.toHaveBeenCalled();
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

  it("fails CLOSED with a 500 when middleware throws (no auth bypass)", async () => {
    const manifest = makeManifest();
    const throwingMiddleware = vi.fn().mockRejectedValue(new Error("boom"));

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      // resolveRoutes calls invokeMiddleware; our catch must not let routing proceed.
      const mw = await options.invokeMiddleware({
        url: new URL("http://localhost/protected"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });
      // A throw is surfaced as bodySent (short-circuit), never as "{}" (proceed).
      expect(mw).toEqual({ bodySent: true });
      return { middlewareResponded: true };
    });

    const resolver = createLocalResolver(manifest, {
      default: throwingMiddleware,
      middleware: throwingMiddleware,
    });

    const result = await resolver.resolve(
      new URL("http://localhost/protected"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result).toEqual({ kind: "error", status: 500 });
  });

  it("wraps a POST body as a CloneableBody for node middleware (path 1)", async () => {
    const manifest = makeManifest();
    let receivedBody: any;
    const nodeMiddleware = vi.fn(async (params: any) => {
      receivedBody = params.request.body;
      return { response: new Response(null, { headers: { "x-middleware-next": "1" } }) };
    });
    // Web-adapter shape: default is a function AND there's a handler entrypoint.
    const middlewareModule: any = { default: nodeMiddleware, middleware: () => {} };

    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/file"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("payload"));
            c.close();
          },
        }),
      });
      return { resolvedPathname: "/", invocationTarget: { pathname: "/" } };
    });

    // Fake getCloneableBody: tags the object so we can assert it was used.
    const fakeGetCloneableBody = (readable: any) => ({
      __cloneable: true,
      cloneBodyStream: () => readable,
      finalize: async () => {},
    });

    const resolver = createLocalResolver(
      manifest,
      middlewareModule,
      null,
      fakeGetCloneableBody as any,
    );
    await resolver.resolve(
      new URL("http://localhost/file"),
      new Headers(),
      "POST",
      new ReadableStream<Uint8Array>(),
    );

    expect(receivedBody).toBeDefined();
    expect(receivedBody.__cloneable).toBe(true);
    expect(typeof receivedBody.cloneBodyStream).toBe("function");
  });

  it("sets invokePath to the rewritten path+query (middleware/config rewrite)", async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/blog/[slug]",
      resolvedQuery: { from: "middleware", nxtPslug: "discard-me" },
      invocationTarget: {
        pathname: "/blog/from-middleware",
        query: { some: "middleware", nxtPslug: "from-middleware" },
      },
      routeMatches: { slug: "from-middleware" },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/rw"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.invokePath).toBe("/blog/from-middleware?from=middleware&some=middleware");
      expect(result.invocationQuery).toEqual({ from: "middleware", some: "middleware" });
    }
  });

  it("preserves repeated values in a rewrite destination as a query array", async () => {
    const manifest = makeManifest({
      routeGraph: {
        ...makeManifest().routeGraph,
        beforeFiles: [
          {
            sourceRegex: "^/some-page$",
            destination: "/?items=1&items=2",
          },
        ],
      },
    });
    // @next/routing's current URLSearchParams.set() behavior reports only the final value. The
    // adapter must restore Next's public Pages query contract from the matched route metadata.
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/",
      resolvedQuery: { items: "2" },
      invocationTarget: { pathname: "/", query: { items: "2" } },
    });
    const result = await createLocalResolver(manifest).resolve(
      new URL("http://localhost/some-page"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.invocationQuery).toEqual({ items: ["1", "2"] });
      expect(result.invokePath).toBe("/?items=1&items=2");
    }
  });

  it("routes Pages data requests using their canonical page URL without redirecting", async () => {
    const manifest = makeManifest({
      trailingSlash: true,
      pathnames: ["/ssr-page"],
      poolAssignments: { "/ssr-page": "ssr" },
    });
    (resolveRoutes as any).mockImplementation(async ({ url }: { url: URL }) => {
      expect(url.pathname).toBe("/ssr-page/");
      return {
        resolvedPathname: "/ssr-page",
        invocationTarget: { pathname: "/ssr-page", query: {} },
      };
    });

    const result = await createLocalResolver(manifest).resolve(
      new URL("http://localhost/_next/data/test123/ssr-page.json"),
      new Headers({ "x-nextjs-data": "1" }),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") expect(result.invokePath).toBeUndefined();
  });

  it("does not expose a spoofed data hint to middleware on a document URL", async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockImplementation(async ({ headers }: { headers: Headers }) => {
      expect(headers.has("x-nextjs-data")).toBe(false);
      return {
        resolvedPathname: "/redirect-to-somewhere",
        invocationTarget: { pathname: "/redirect-to-somewhere", query: {} },
      };
    });

    await createLocalResolver(manifest).resolve(
      new URL("http://localhost/redirect-to-somewhere"),
      new Headers({ "x-nextjs-data": "1" }),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
  });

  it("continues same-origin middleware rewrites without losing the public data request", async () => {
    const manifest = makeManifest({
      trailingSlash: true,
      pathnames: ["/blog/[slug]"],
      poolAssignments: { "/blog/[slug]": "ssr" },
    });
    (resolveRoutes as any)
      .mockResolvedValueOnce({
        externalRewrite: new URL("http://localhost/blog/from-middleware/?some=middleware"),
        resolvedHeaders: new Headers({ "x-first": "yes" }),
      })
      .mockResolvedValueOnce({
        resolvedPathname: "/blog/[slug]",
        resolvedQuery: { some: "middleware", nxtPslug: "from-middleware" },
        invocationTarget: {
          pathname: "/blog/from-middleware/",
          query: { some: "middleware", nxtPslug: "from-middleware" },
        },
        routeMatches: { nxtPslug: "from-middleware" },
      });

    const result = await createLocalResolver(manifest).resolve(
      new URL("http://127.0.0.1/_next/data/test123/rewrite.json"),
      new Headers({ "x-nextjs-data": "1" }),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe("/blog/[slug]");
      expect(result.invokePath).toBeUndefined();
      expect(result.invocationQuery).toEqual({ some: "middleware" });
      expect(result.resolvedHeaders?.get("x-first")).toBe("yes");
      // N12: the PUBLIC page path, not a data URL — `next start` emits the bare page path
      // because router-server strips /_next/data/<buildId> before middleware runs, so
      // NextURL.buildId is empty at serialization time. The client copies this verbatim
      // into routeInfo.resolvedAs and _bfl() tests it against the client-router filter to
      // decide whether a HARD navigation is needed (Pages→App rewrites).
      expect(result.resolvedHeaders?.get("x-nextjs-rewrite")).toBe(
        "/blog/from-middleware?some=middleware",
      );
    }
  });

  it("passes a same-origin middleware rewrite as document invocation metadata", async () => {
    const manifest = makeManifest({
      pathnames: ["/about"],
      poolAssignments: { "/about": "ssr" },
    });
    (resolveRoutes as any)
      .mockResolvedValueOnce({
        externalRewrite: new URL("http://localhost/about?from=middleware"),
      })
      .mockResolvedValueOnce({
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about", query: { from: "middleware" } },
      });

    const result = await createLocalResolver(manifest).resolve(
      new URL("http://localhost/public-alias"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.invokePath).toBe("/about?from=middleware");
      expect(result.invocationQuery).toEqual({ from: "middleware" });
    }
  });

  it("runs middleware once when continuing a same-origin POST rewrite", async () => {
    vi.mocked(resolveRoutes).mockReset();
    const middlewareHandler = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe("action-body");
      return new Response(null, {
        headers: { "x-middleware-rewrite": "http://localhost/action-target" },
      });
    });
    (resolveRoutes as any)
      .mockImplementationOnce(async ({ invokeMiddleware, requestBody, headers, url }: any) => {
        await invokeMiddleware({ url, requestBody, headers });
        return { externalRewrite: new URL("http://localhost/action-target") };
      })
      .mockImplementationOnce(async ({ invokeMiddleware, requestBody, headers, url }: any) => {
        // @next/routing calls this hook unconditionally. The resolver must return its already-ran
        // verdict without re-entering user middleware or touching the locked body stream.
        await invokeMiddleware({ url, requestBody, headers });
        return {
          resolvedPathname: "/action-target",
          invocationTarget: { pathname: "/action-target", query: {} },
        };
      });
    const resolver = createLocalResolver(
      makeManifest({
        pathnames: ["/action-target"],
        poolAssignments: { "/action-target": "ssr" },
      }),
      // Real generated middleware modules also include a compatibility default export.
      { handler: middlewareHandler, default: vi.fn() },
    );
    const body = new TextEncoder().encode("action-body");

    const result = await resolver.resolve(
      new URL("http://localhost/action-source"),
      new Headers({ "content-type": "text/plain" }),
      "POST",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    );

    expect(result.kind).toBe("route");
    expect(middlewareHandler).toHaveBeenCalledOnce();
  });

  it("runs middleware once on the i18n trailing-slash retry path (POST body single consumption)", async () => {
    vi.mocked(resolveRoutes).mockReset();
    const middlewareHandler = vi.fn(async (request: Request) => {
      expect(await request.text()).toBe("action-body");
      return new Response(null, { headers: { "x-middleware-next": "1" } });
    });
    (resolveRoutes as any)
      .mockImplementationOnce(async ({ invokeMiddleware, requestBody, headers, url }: any) => {
        // First pass: middleware runs, then routing emits the spurious internal
        // trailing-slash redirect (target locale-stripped == original path, 308).
        await invokeMiddleware({ url, requestBody, headers });
        return {
          redirect: { url: new URL("http://localhost/en/about"), status: 308 },
          resolvedHeaders: new Headers(),
        };
      })
      .mockImplementationOnce(async ({ invokeMiddleware, requestBody, headers, url }: any) => {
        // The retry pass: @next/routing calls this hook unconditionally. The resolver
        // must return its already-ran verdict — re-entering user middleware would
        // throw on the locked POST body stream and surface as a 500.
        await invokeMiddleware({ url, requestBody, headers });
        return {
          resolvedPathname: "/en/about",
          invocationTarget: { pathname: "/en/about" },
          resolvedHeaders: new Headers(),
        };
      });
    const resolver = createLocalResolver(
      makeManifest({
        i18n: { locales: ["en", "fr"], defaultLocale: "en", localeDetection: false } as any,
        middleware: { filePath: "middleware.js" },
      }),
      // Real generated middleware modules also include a compatibility default export.
      { handler: middlewareHandler, default: vi.fn() },
    );

    const result = await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers({ "content-type": "text/plain" }),
      "POST",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("action-body"));
          controller.close();
        },
      }),
    );

    expect(result.kind).toBe("route");
    expect(middlewareHandler).toHaveBeenCalledOnce();
  });

  it("leaves invokePath undefined when the resolved URL equals the request", async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: { x: "1" } },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/about?x=1"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    if (result.kind === "route") expect(result.invokePath).toBeUndefined();
  });

  it("does not expose unresolved optional catch-all sentinels", async () => {
    const manifest = makeManifest({
      pathnames: ["/[[...slug]]"],
      poolAssignments: { "/[[...slug]]": "ssr" },
    });
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/[[...slug]]",
      invocationTarget: { pathname: "/%24nxtPslug", query: { nxtPslug: "$nxtPslug" } },
      routeMatches: { "1": "$nxtPslug", nxtPslug: "$nxtPslug" },
    });

    const result = await createLocalResolver(manifest).resolve(
      new URL("http://localhost/"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );

    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.matchedPathname).toBe("/[[...slug]]");
      expect(result.invokePath).toBeUndefined();
      expect(result.routeMatches).toBeNull();
      expect(result.invocationQuery).toEqual({});
    }
  });

  it("emits x-nextjs-rewritten-path/-query for an RSC middleware rewrite", async () => {
    const manifest = makeManifest();
    // rsc config so isRscReq is detected from the header.
    (manifest.routeGraph as any).rsc = { header: "rsc", suffix: ".rsc" };
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/blog/[slug]",
      invocationTarget: {
        pathname: "/blog/from-middleware",
        // user query + internal capture params that must be filtered out
        query: { some: "middleware", nxtPslug: "from-middleware" },
      },
      routeMatches: { slug: "from-middleware" },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL("http://localhost/rewrite-to-dynamic"),
      new Headers({ rsc: "1" }),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("route");
    if (result.kind === "route") {
      expect(result.resolvedHeaders?.get("x-nextjs-rewritten-path")).toBe("/blog/from-middleware");
      // internal nxtP* filtered, only user query remains
      expect(result.resolvedHeaders?.get("x-nextjs-rewritten-query")).toBe("some=middleware");
    }
  });

  it("does not emit rewrite headers for a non-RSC request or a non-rewrite", async () => {
    const manifest = makeManifest();
    (manifest.routeGraph as any).rsc = { header: "rsc", suffix: ".rsc" };
    // Non-RSC request that IS rewritten → no RSC headers (handled via invokePath).
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/blog/[slug]",
      invocationTarget: { pathname: "/blog/from-middleware", query: { some: "middleware" } },
    });
    const resolver = createLocalResolver(manifest);
    const r1 = await resolver.resolve(
      new URL("http://localhost/rewrite-to-dynamic"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    if (r1.kind === "route") expect(r1.resolvedHeaders?.get("x-nextjs-rewritten-path")).toBeFalsy();

    // RSC request with no rewrite (target === request) → no headers.
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    });
    const r2 = await resolver.resolve(
      new URL("http://localhost/about"),
      new Headers({ rsc: "1" }),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    if (r2.kind === "route") expect(r2.resolvedHeaders?.get("x-nextjs-rewritten-path")).toBeFalsy();
  });

  // REGRESSION: fail-closed must NOT fire for normal middleware. A middleware
  // that returns next()/rewrite/redirect (does not throw) must resolve
  // normally — never a 500. Guards the fail-open→fail-closed change from
  // over-firing on legitimate middleware.
  it("does NOT 500 when middleware returns normally (next)", async () => {
    const manifest = makeManifest();
    const okMiddleware = vi.fn().mockResolvedValue({
      response: new Response(null, { headers: { "x-middleware-next": "1" } }),
      waitUntil: Promise.resolve(),
    });
    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/ok"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });
      return { resolvedPathname: "/ok", invocationTarget: { pathname: "/ok" } };
    });
    const resolver = createLocalResolver(manifest, { default: okMiddleware, middleware: () => {} });
    const result = await resolver.resolve(
      new URL("http://localhost/ok"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(result.kind).toBe("route");
    expect((result as any).status).not.toBe(500);
  });

  // REGRESSION: middleware `matcher` gating. When matchers are provided and the
  // request does NOT match, the middleware function must not be invoked at all
  // (the resolver returns the no-middleware routing result). A bug here would
  // run middleware on paths its config excludes.
  it("skips middleware invocation when the matcher does not match", async () => {
    const manifest = makeManifest();
    const mw = vi.fn().mockResolvedValue({ response: new Response(null) });
    let invokeMwCalled = false;
    (resolveRoutes as any).mockImplementation(async (options: any) => {
      const r = await options.invokeMiddleware({
        url: new URL("http://localhost/not-matched"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });
      invokeMwCalled = true;
      // matcher no-match → invokeMiddleware returns {} without calling mw
      expect(r).toEqual({});
      return { resolvedPathname: "/not-matched", invocationTarget: { pathname: "/not-matched" } };
    });
    const matchers = [{ regexp: "^\\/only-here$", originalSource: "/only-here" }];
    const resolver = createLocalResolver(
      manifest,
      { default: mw, middleware: () => {} },
      null,
      null,
      matchers,
    );
    await resolver.resolve(
      new URL("http://localhost/not-matched"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(invokeMwCalled).toBe(true);
    expect(mw).not.toHaveBeenCalled();
  });

  // REGRESSION: matcher gating must still RUN middleware on a matching path.
  it("invokes middleware when the matcher matches", async () => {
    const manifest = makeManifest();
    const mw = vi.fn().mockResolvedValue({
      response: new Response(null, { headers: { "x-middleware-next": "1" } }),
      waitUntil: Promise.resolve(),
    });
    (resolveRoutes as any).mockImplementation(async (options: any) => {
      await options.invokeMiddleware({
        url: new URL("http://localhost/only-here"),
        headers: new Headers(),
        requestBody: new ReadableStream<Uint8Array>(),
      });
      return { resolvedPathname: "/only-here", invocationTarget: { pathname: "/only-here" } };
    });
    const matchers = [{ regexp: "^\\/only-here$", originalSource: "/only-here" }];
    const resolver = createLocalResolver(
      manifest,
      { default: mw, middleware: () => {} },
      null,
      null,
      matchers,
    );
    await resolver.resolve(
      new URL("http://localhost/only-here"),
      new Headers(),
      "GET",
      new ReadableStream<Uint8Array>(),
    );
    expect(mw).toHaveBeenCalledOnce();
  });
});

describe("hasCallableMiddlewareExport", () => {
  it("accepts supported shapes and rejects module objects without a callable", () => {
    expect(hasCallableMiddlewareExport({ default: vi.fn() })).toBe(true);
    expect(hasCallableMiddlewareExport({ handler: vi.fn() })).toBe(true);
    expect(hasCallableMiddlewareExport({ default: { handler: vi.fn() } })).toBe(true);
    expect(hasCallableMiddlewareExport({ middleware: vi.fn() })).toBe(true);
    expect(hasCallableMiddlewareExport({ default: { default: vi.fn() } })).toBe(true);
    expect(hasCallableMiddlewareExport({})).toBe(false);
  });
});
