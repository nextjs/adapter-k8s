// tests/pool-server/dispatch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDispatcher,
  extractRouteParams,
  getContentType,
  pagesDataRequestPathnameToPagePath,
} from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolveResult } from "../../src/pool-server/resolve.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "localhost", ...headers },
    pipe: vi.fn(),
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    _ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    write(chunk: string) {
      res._body += chunk;
      return true;
    },
    end(body?: string) {
      if (body) res._body += body;
      res._ended = true;
    },
    headersSent: false,
    writableEnded: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

describe("createDispatcher", () => {
  it("keeps Pages data protocol segments out of optional catch-all params", () => {
    const rootPath = pagesDataRequestPathnameToPagePath("/_next/data/build123/index.json");
    const nestedPath = pagesDataRequestPathnameToPagePath("/docs/_next/data/build123/one/two.json");
    const localizedRootPath = pagesDataRequestPathnameToPagePath("/_next/data/build123/fr.json", [
      "en-US",
      "fr",
    ]);

    expect(rootPath).toBe("/");
    expect(extractRouteParams("/[[...slug]]", null, rootPath!)).toBeUndefined();
    expect(nestedPath).toBe("/docs/one/two");
    expect(extractRouteParams("/docs/[[...slug]]", null, nestedPath!)).toEqual({
      slug: ["one", "two"],
    });
    expect(localizedRootPath).toBe("/");
    expect(extractRouteParams("/[[...slug]]", null, localizedRootPath!)).toBeUndefined();
  });

  it("extracts an i18n catch-all from the concrete rewritten prerender path", () => {
    expect(
      extractRouteParams("/en/[...slug]", { nextInternalLocale: "en" }, "/en/company/about-us"),
    ).toEqual({ slug: ["company", "about-us"] });
  });

  it("dispatches route to handler", async () => {
    const handler = vi.fn();
    const revalidate = vi.fn().mockResolvedValue(undefined);
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
    };

    const dispatcher = createDispatcher({
      handlerLoader,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
      revalidate,
    });

    const req = mockReq("/about");
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/about",
      routeMatches: null,
      resolvedHeaders: undefined,
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);

    expect(handlerLoader.load).toHaveBeenCalledWith("/about");
    expect(localHandlerInvoker).toHaveBeenCalledWith(
      expect.objectContaining({
        handler,
        req,
        res,
        matchedPathname: "/about",
        routeMatches: null,
        revalidate,
      }),
    );
  });

  it("maps the public root pathname to the Pages Router /index output", async () => {
    const handler = vi.fn();
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn((outputId: string) => outputId === "/index"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
    };
    const dispatcher = createDispatcher({
      handlerLoader: handlerLoader as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/",
          filePath: ".next/server/pages/index.html",
          cacheControl: "public, max-age=0, must-revalidate",
          prerender: true,
        },
      ],
      localHandlerInvoker,
    });

    await dispatcher.dispatch(mockReq("/"), mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/",
      routeMatches: null,
      resolvedHeaders: undefined,
    });

    expect(handlerLoader.load).toHaveBeenCalledWith("/index");
    expect(localHandlerInvoker).toHaveBeenCalledWith(
      expect.objectContaining({ matchedPathname: "/index" }),
    );
  });

  it("sets the public matched route on basePath data responses", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
      basePath: "/docs",
    });
    const req = mockReq("/docs/_next/data/test123/first.json?path=first");
    const res = mockRes();

    await dispatcher.dispatch(req, res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/docs/[...path]",
      routeMatches: { path: "first" },
      resolvedHeaders: undefined,
    });

    expect(res._headers["x-nextjs-matched-path"]).toBe("/[...path]");
  });

  it("bails dynamic Pages middleware prefetches without invoking GSSP", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
    });
    const req = mockReq("/_next/data/test123/sha.json?hello=goodbye", {
      "x-middleware-prefetch": "1",
    });
    const res = mockRes();

    await dispatcher.dispatch(req, res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/shallow",
      routeMatches: null,
      resolvedHeaders: new Headers({
        "x-nextjs-rewrite": "/_next/data/test123/shallow.json?hello=goodbye",
      }),
    });

    expect(res._status).toBe(200);
    expect(res._headers["x-middleware-skip"]).toBe("1");
    expect(res._body).toBe("{}");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("does not bail middleware prefetches rewritten to a prerender", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/ssg/hello",
          filePath: ".next/server/pages/ssg/hello.html",
          cacheControl: "public, max-age=0, must-revalidate",
          prerender: true,
        },
      ],
      localHandlerInvoker,
    });

    await dispatcher.dispatch(
      mockReq("/_next/data/test123/to-ssg.json", { "x-middleware-prefetch": "1" }),
      mockRes(),
      {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/ssg/[slug]",
        routeMatches: { slug: "hello" },
        resolvedHeaders: new Headers({
          "x-nextjs-rewrite": "/_next/data/test123/ssg/hello.json",
        }),
      },
    );

    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });

  // N12: the wire form resolve.ts now emits (`next start` parity) is the bare public page
  // path. Both forms must resolve to the same prerender, or every prefetch would bail.
  it("does not bail middleware prefetches rewritten to a prerender (bare page-path form)", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/ssg/hello",
          filePath: ".next/server/pages/ssg/hello.html",
          cacheControl: "public, max-age=0, must-revalidate",
          prerender: true,
        },
      ],
      localHandlerInvoker,
    });

    await dispatcher.dispatch(
      mockReq("/_next/data/test123/to-ssg.json", { "x-middleware-prefetch": "1" }),
      mockRes(),
      {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/ssg/[slug]",
        routeMatches: { slug: "hello" },
        resolvedHeaders: new Headers({ "x-nextjs-rewrite": "/ssg/hello" }),
      },
    );

    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });

  it("provides a render404 callback that renders the custom not-found entrypoint", async () => {
    const pageHandler = vi.fn();
    const notFoundHandler = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(res.statusCode);
      res.end("custom app 404");
    });
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn(async (outputId: string) =>
        outputId === "/_not-found" ? notFoundHandler : pageHandler,
      ),
      has: vi.fn((outputId: string) => outputId === "/about" || outputId === "/_not-found"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
    };

    const dispatcher = createDispatcher({
      handlerLoader: handlerLoader as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
    });
    const req = mockReq("/about");
    const res = mockRes();

    await dispatcher.dispatch(req, res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/about",
      routeMatches: null,
      resolvedHeaders: undefined,
    });

    const render404 = localHandlerInvoker.mock.calls[0]?.[0]?.render404;
    expect(render404).toBeTypeOf("function");
    await render404(req, res);

    expect(notFoundHandler).toHaveBeenCalledOnce();
    expect(res._status).toBe(404);
    expect(res._body).toBe("custom app 404");
  });

  it("provides an error callback that invokes the custom 500 entrypoint with error metadata", async () => {
    const pageHandler = vi.fn();
    const errorHandler = vi.fn(
      (
        _req: IncomingMessage,
        res: ServerResponse,
        ctx: { requestMeta: Record<string, unknown> },
      ) => {
        expect(ctx.requestMeta.invokeStatus).toBe(500);
        expect(ctx.requestMeta.invokeError).toBeInstanceOf(Error);
        res.writeHead(res.statusCode);
        res.end("custom pages/500");
      },
    );
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn(async (outputId: string) => (outputId === "/500" ? errorHandler : pageHandler)),
      has: vi.fn((outputId: string) => outputId === "/about" || outputId === "/500"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
    };
    const dispatcher = createDispatcher({
      handlerLoader: handlerLoader as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
    });
    const req = mockReq("/about");
    const res = mockRes();

    await dispatcher.dispatch(req, res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/about",
      routeMatches: null,
      resolvedHeaders: undefined,
    });
    const renderError = localHandlerInvoker.mock.calls[0]?.[0]?.renderError;
    expect(renderError).toBeTypeOf("function");
    await renderError(req, res, new Error("oof"));

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(res._status).toBe(500);
    expect(res._body).toBe("custom pages/500");
  });

  it("renders a Pages 404 through /_error with invokeStatus when no /404 output exists", async () => {
    const errorHandler = vi.fn(
      (
        _req: IncomingMessage,
        res: ServerResponse,
        ctx: { requestMeta: Record<string, unknown> },
      ) => {
        expect(ctx.requestMeta.outputId).toBe("/_error");
        expect(ctx.requestMeta.invokeStatus).toBe(404);
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h2>pages error entrypoint</h2>");
      },
    );
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(errorHandler),
        has: vi.fn((outputId: string) => outputId === "/_error"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });
    const res = mockRes();

    await dispatcher.dispatch(mockReq("/missing"), res, { kind: "not-found" });

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(res._status).toBe(404);
    expect(res._body).toContain("pages error entrypoint");
  });

  it("prefers a prerendered custom 500 over the generic /_error handler", async () => {
    writeFileSync(path.join(os.tmpdir(), "adapter-k8s-custom-500.html"), "custom static 500");
    const previousCwd = process.cwd;
    process.cwd = () => os.tmpdir();
    const errorHandler = vi.fn();
    const pageHandler = vi.fn(() => {
      throw new Error("page failed");
    });
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn(async (outputId: string) =>
          outputId === "/_error" ? errorHandler : pageHandler,
        ),
        has: vi.fn((outputId: string) => outputId === "/boom" || outputId === "/_error"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "PAGES" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/500",
          filePath: "adapter-k8s-custom-500.html",
          cacheControl: "public, max-age=0, must-revalidate",
          prerender: true,
        },
      ],
    });
    const res = mockRes();

    try {
      await dispatcher.dispatch(mockReq("/boom"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/boom",
        routeMatches: null,
        resolvedHeaders: undefined,
      });
    } finally {
      process.cwd = previousCwd;
      rmSync(path.join(os.tmpdir(), "adapter-k8s-custom-500.html"), { force: true });
    }

    expect(res._status).toBe(500);
    expect(res._body).toContain("custom static 500");
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it("handles redirects", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });

    const req = mockReq("/old");
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: "redirect",
      url: new URL("http://localhost/new"),
      status: 301,
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    expect(res._status).toBe(301);
    expect(res._headers["location"]).toBe("http://localhost/new");
  });

  it("preserves multiple Set-Cookie headers on a middleware-response", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });

    const mwHeaders = new Headers();
    mwHeaders.append("set-cookie", "a=1; Path=/");
    mwHeaders.append("set-cookie", "b=2; Path=/");
    const req = mockReq("/gated");
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: "middleware-response",
      response: new Response(null, { status: 200, headers: mwHeaders }),
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);

    const setCookie = res._headers["set-cookie"] as unknown as string[];
    expect(Array.isArray(setCookie)).toBe(true);
    expect(setCookie).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("proxies external rewrites", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });

    const req = mockReq("/proxy");
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: "external-rewrite",
      url: new URL("https://external.example.com/api"),
    };

    // External rewrites are proxied — the actual HTTP request will fail in tests
    // but the dispatch should attempt the proxy (not return 502 immediately)
    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    // Proxy will fail with connection error in test env → 502, but the body is generic:
    // the upstream error detail must not leak to clients (L1).
    expect(res._status).toBe(502);
    expect(res._body).toBe("Bad Gateway");
  });

  it("returns 404 for not-found", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });

    const req = mockReq("/nonexistent");
    const res = mockRes();
    const resolution: ResolveResult = { kind: "not-found" };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    expect(res._status).toBe(404);
  });

  it("uses a basePath-prefixed custom 404 output", async () => {
    const handler = vi.fn();
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn((pathname: string) => pathname === "/docs/404"),
      get: vi.fn(),
    } as any;
    const dispatcher = createDispatcher({
      handlerLoader,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      basePath: "/docs",
      localHandlerInvoker,
    });

    await dispatcher.dispatch(mockReq("/docs/missing"), mockRes() as unknown as ServerResponse, {
      kind: "not-found",
    });

    expect(handlerLoader.load).toHaveBeenCalledWith("/docs/404");
    expect(localHandlerInvoker).toHaveBeenCalledWith(
      expect.objectContaining({ matchedPathname: "/docs/404", forceStatus: 404 }),
    );
  });

  it("attempts to invoke edge runtime routes (no longer rejects with 501)", async () => {
    const handler = vi.fn();
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          runtime: "edge",
          filePath: "/app/.next/server/edge/page.js",
        }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
    });

    const req = mockReq("/edge-page");
    const res = mockRes();
    await dispatcher.dispatch(req, res as unknown as ServerResponse, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/edge-page",
      routeMatches: null,
      resolvedHeaders: undefined,
    });

    // Edge routes are now attempted through the normal handler path
    expect(localHandlerInvoker).toHaveBeenCalled();
  });

  it("merges dynamic params into the request URL for edge Pages outputs", async () => {
    let backgroundComplete = false;
    const edgeRouteRunner = vi.fn().mockResolvedValue({
      response: new Response("ok"),
      waitUntil: new Promise<void>((resolve) => {
        setTimeout(() => {
          backgroundComplete = true;
          resolve();
        }, 5);
      }),
    });
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          runtime: "edge",
          type: "PAGES",
          filePath: "/app/.next/server/edge/page.js",
        }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      edgeRouteRunner,
    });

    const req = mockReq("/post-1?draft=1");
    const res = mockRes();
    await dispatcher.dispatch(req, res as unknown as ServerResponse, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/[id]",
      routeMatches: { "1": "post-1", nxtPid: "post-1" },
      resolvedHeaders: undefined,
    });

    expect(edgeRouteRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "http://localhost/post-1?draft=1&nxtPid=post-1",
          page: { name: "/[id]", params: { id: "post-1" } },
          waitUntil: expect.any(Function),
        }),
      }),
    );
    expect(res._status).toBe(200);
    expect(res._body).toBe("ok");
    expect(backgroundComplete).toBe(true);
  });

  it("recovers Edge App catch-all params from the concrete pathname", async () => {
    const edgeRouteRunner = vi.fn().mockResolvedValue({
      response: new Response("ok"),
      waitUntil: Promise.resolve(),
    });
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          runtime: "edge",
          type: "APP_ROUTE",
          filePath: "/app/.next/server/edge/page.js",
        }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      edgeRouteRunner,
    });

    await dispatcher.dispatch(mockReq("/edge/one/two"), mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/edge/[[...slug]]",
      // @next/routing can omit the named alias for an optional catch-all Edge output.
      routeMatches: null,
      resolvedHeaders: undefined,
    });

    expect(edgeRouteRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "http://localhost/edge/one/two?nxtPslug=one%2Ftwo",
          page: { name: "/edge/[[...slug]]", params: { slug: ["one", "two"] } },
        }),
      }),
    );
  });

  it("invokes edge routes with the resolved middleware rewrite URL", async () => {
    const edgeRouteRunner = vi.fn().mockResolvedValue({
      response: Response.json({ ok: true }),
      waitUntil: Promise.resolve(),
    });
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          runtime: "edge",
          type: "PAGES_API",
          filePath: "/app/.next/server/edge/api.js",
        }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      edgeRouteRunner,
    });

    await dispatcher.dispatch(mockReq("/rewrite-me?a=b"), mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/api/edge-search-params",
      routeMatches: null,
      resolvedHeaders: undefined,
      invokePath: "/api/edge-search-params?a=b&foo=bar",
      invocationQuery: { a: "b", foo: "bar" },
    });

    expect(edgeRouteRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "http://localhost/rewrite-me?a=b&foo=bar",
        }),
      }),
    );
  });

  it("transports rewritten dynamic params to an Edge App Route", async () => {
    const edgeRouteRunner = vi.fn().mockResolvedValue({
      response: Response.json({ ok: true }),
      waitUntil: Promise.resolve(),
    });
    const dispatcher = createDispatcher({
      handlerLoader: {
        load: vi.fn(),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({
          runtime: "edge",
          type: "APP_ROUTE",
          filePath: "/app/.next/server/edge/route.js",
        }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      edgeRouteRunner,
    });

    await dispatcher.dispatch(mockReq("/dynamic-test/foo"), mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/dynamic/[slug]",
      routeMatches: null,
      resolvedHeaders: undefined,
      invokePath: "/dynamic/foo",
    });

    expect(edgeRouteRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          url: "http://localhost/dynamic-test/foo?nxtPslug=foo",
          page: { name: "/dynamic/[slug]", params: { slug: "foo" } },
        }),
      }),
    );
  });

  it("applies middleware-mutated request headers before invoking the handler", async () => {
    const handler = vi.fn();
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
    };

    const dispatcher = createDispatcher({
      handlerLoader,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
    });

    const req = mockReq("/about", { cookie: "a=1", "x-remove-me": "gone" });
    const res = mockRes();

    // middlewareRequestHeaders is the FINAL set of request headers after
    // responseToMiddlewareResult processing — replaces req.headers entirely
    // to respect header deletions from x-middleware-override-headers.
    await dispatcher.dispatch(req, res as unknown as ServerResponse, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/about",
      routeMatches: null,
      resolvedHeaders: undefined,
      middlewareRequestHeaders: new Headers({
        cookie: "b=2",
        authorization: "Bearer token",
        "x-middleware-next": "1",
      }),
    });

    // Headers replaced entirely (not merged) — original cookie is gone
    expect(req.headers.cookie).toBe("b=2");
    expect(req.headers.authorization).toBe("Bearer token");
    expect(req.headers["x-remove-me"]).toBeUndefined();
    // x-middleware-* filtered out
    expect(req.headers["x-middleware-next"]).toBeUndefined();
    // host preserved from original request
    expect(req.headers.host).toBe("localhost");
    expect(localHandlerInvoker).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
      }),
    );
  });

  describe("static asset serving", () => {
    let tmpDir: string;
    const origCwd = process.cwd;

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `dispatch-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      process.cwd = () => tmpDir;
    });

    afterEach(() => {
      process.cwd = origCwd;
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("prefers a prerendered custom 404 over the generic /_error handler", async () => {
      writeFileSync(path.join(tmpDir, "404.html"), '<main id="not-found">404 page</main>');
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const errorHandler = vi.fn();
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn(async (outputId: string) =>
            outputId === "/_error" ? errorHandler : vi.fn(),
          ),
          has: vi.fn((outputId: string) => outputId === "/about" || outputId === "/_error"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/404",
            filePath: "404.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
      });
      const req = mockReq("/about");
      const res = mockRes();

      await dispatcher.dispatch(req, res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/about",
        routeMatches: null,
        resolvedHeaders: undefined,
      });
      await localHandlerInvoker.mock.calls[0]?.[0]?.render404(req, res);

      expect(res._status).toBe(404);
      expect(res._body).toContain("404 page");
      expect(errorHandler).not.toHaveBeenCalled();
    });

    it("serves a public static file (favicon.ico) from the manifest", async () => {
      writeFileSync(path.join(tmpDir, "favicon.ico"), "icon-data");

      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/favicon.ico",
            filePath: "favicon.ico",
            cacheControl: "public, max-age=3600",
          },
        ],
      });

      const req = mockReq("/favicon.ico");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/favicon.ico",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toBe("image/x-icon");
      expect(res._headers["cache-control"]).toBe("public, max-age=3600");
      expect(res._ended).toBe(true);
    });

    it("ETag-revalidates a mutable static worker without returning its body again", async () => {
      writeFileSync(path.join(tmpDir, "sw.js"), "self.addEventListener('fetch', () => {})");
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/_next/static/service-worker/sw.js",
            filePath: "sw.js",
            cacheControl: "public, max-age=0, must-revalidate",
          },
        ],
      });
      const resolution = {
        kind: "route" as const,
        pool: "ssr",
        matchedPathname: "/_next/static/service-worker/sw.js",
        routeMatches: null,
        resolvedHeaders: undefined,
      };
      const first = mockRes();
      await dispatcher.dispatch(mockReq(resolution.matchedPathname), first, resolution);

      expect(first._status).toBe(200);
      expect(first._headers.etag).toMatch(/^".+"$/);
      expect(first._body).toContain("addEventListener");

      const revalidated = mockRes();
      await dispatcher.dispatch(
        mockReq(resolution.matchedPathname, { "if-none-match": first._headers.etag }),
        revalidated,
        resolution,
      );

      expect(revalidated._status).toBe(304);
      expect(revalidated._headers.etag).toBe(first._headers.etag);
      expect(revalidated._body).toBe("");
    });

    it("lets app-owned resolved headers override static asset defaults case-insensitively", async () => {
      writeFileSync(path.join(tmpDir, "cache-probe.txt"), "probe");
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/cache-probe.txt",
            filePath: "cache-probe.txt",
            cacheControl: "public, max-age=3600",
          },
        ],
      });
      const res = mockRes();

      await dispatcher.dispatch(mockReq("/cache-probe.txt"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/cache-probe.txt",
        routeMatches: null,
        resolvedHeaders: new Headers({ "Cache-Control": "max-age=1234" }),
      });

      expect(res._headers["cache-control"]).toBe("max-age=1234");
      expect(
        Object.keys(res._headers).filter((name) => name.toLowerCase() === "cache-control"),
      ).toHaveLength(1);
    });

    it("serves an extensionless handler-less prerender as text/html (not octet-stream download)", async () => {
      // A pure-static index page (pages/index.js, no getStaticProps) is served
      // straight from the manifest with no per-asset content-type header. Its
      // pathname is extensionless ("/index"), so deriving the type from the
      // pathname yields application/octet-stream and the browser DOWNLOADS the
      // HTML. The type must come from the .html filePath instead.
      mkdirSync(path.join(tmpDir, ".next", "server", "pages"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, ".next", "server", "pages", "index.html"),
        "<!DOCTYPE html><html><body>home</body></html>",
      );

      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          get: vi.fn(),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/index",
            filePath: ".next/server/pages/index.html",
            cacheControl: "public, max-age=3600",
            prerender: true,
          },
        ],
      });

      const req = mockReq("/", { rsc: "1" });
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/index",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res._headers.vary).toBe(
        "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch",
      );
      expect(res._body).toContain("home");
    });

    it("serves a prerender fallback with adapter-provided headers", async () => {
      mkdirSync(path.join(tmpDir, ".next", "server", "app"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, ".next", "server", "app", "index.html"),
        "<html>prerendered</html>",
      );

      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/",
            filePath: ".next/server/app/index.html",
            cacheControl: "public, max-age=3600",
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-nextjs-cache": "HIT",
            },
            status: 200,
          },
        ],
      });

      const req = mockReq("/");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(res._headers["x-nextjs-cache"]).toBe("HIT");
      expect(res._ended).toBe(true);
    });

    it("derives opaque metadata artifact content types from their public pathname", async () => {
      writeFileSync(path.join(tmpDir, "sitemap.body"), "<urlset />");
      writeFileSync(path.join(tmpDir, "icon.body"), "png-bytes");
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/sitemap.xml",
            filePath: "sitemap.body",
            cacheControl: "public, max-age=0, must-revalidate",
          },
          {
            pathname: "/icon.png",
            filePath: "icon.body",
            cacheControl: "public, max-age=0, must-revalidate",
          },
        ],
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/sitemap.xml"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/sitemap.xml",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._headers["content-type"]).toBe("application/xml");
      expect(res._body).toBe("<urlset />");

      const iconRes = mockRes();
      await dispatcher.dispatch(mockReq("/icon.png"), iconRes, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/icon.png",
        routeMatches: null,
        resolvedHeaders: undefined,
      });
      expect(iconRes._status).toBe(200);
      expect(iconRes._headers["content-type"]).toBe("image/png");
    });

    it("serves a fresh concrete ISR seed instead of its template handler", async () => {
      writeFileSync(path.join(tmpDir, "fr-1.html"), "<p>buildtime</p>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const handlerLoader = {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn((pathname: string) => pathname === "/[lang]/[slug]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      };
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoader as any,
        poolName: "ssr",
        buildId: "test123",
        outputIds: ["/[lang]/[slug]"],
        staticAssets: [
          {
            pathname: "/fr/1",
            filePath: "fr-1.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
            revalidate: 900,
          },
        ],
        localHandlerInvoker,
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/fr/1"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/fr/1",
        routeMatches: { lang: "fr", slug: "1" },
        resolvedHeaders: undefined,
      });

      expect(res._body).toBe("<p>buildtime</p>");
      expect(localHandlerInvoker).not.toHaveBeenCalled();
    });

    it("prepends the build-time PPR shell to a document resume", async () => {
      writeFileSync(path.join(tmpDir, "ppr-shell.html"), "<html><body><p>shell</p>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        pprRoutes: {
          "/dashboard": {
            postponedState: "postponed-state",
            fallbackFilePath: "ppr-shell.html",
            initialHeaders: { "content-type": "text/html; charset=utf-8" },
            initialStatus: 200,
          },
        },
      });

      await dispatcher.dispatch(mockReq("/dashboard"), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/dashboard",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          responsePrefix: {
            filePath: path.join(tmpDir, "ppr-shell.html"),
            headers: { "content-type": "text/html; charset=utf-8" },
            status: 200,
          },
        }),
      );
    });

    it("does not prepend a shell when a partial-fallback resume returns a full document", async () => {
      writeFileSync(path.join(tmpDir, "cached-shell.html"), "<!DOCTYPE html><p>cached-shell</p>");
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        innerRes.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        innerRes.end("<!DOCTYPE html><p>specialized-shell</p><script>resume()</script>");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {
          "/dashboard": {
            postponedState: "postponed-state",
            fallbackFilePath: "cached-shell.html",
          },
        },
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/dashboard"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/dashboard",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._body).toBe("<!DOCTYPE html><p>specialized-shell</p><script>resume()</script>");
    });

    it("deduplicates PPR shell and resume headers case-insensitively", async () => {
      writeFileSync(path.join(tmpDir, "cached-shell.html"), "<!DOCTYPE html><p>shell</p>");
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        innerRes.writeHead(200, { link: "</resume.css>; rel=preload; as=style" });
        innerRes.end("<script>resume()</script>");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {
          "/dashboard": {
            postponedState: "postponed-state",
            fallbackFilePath: "cached-shell.html",
            initialHeaders: { Link: "</shell.css>; rel=preload; as=style" },
          },
        },
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/dashboard"), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/dashboard",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._headers).toMatchObject({ link: "</resume.css>; rel=preload; as=style" });
      expect(
        Object.keys(res._headers).filter((name) => name.toLowerCase() === "link"),
      ).toHaveLength(1);
    });

    it("prefers a specialized PPR shell over the executable handler template", async () => {
      writeFileSync(path.join(tmpDir, "generic.html"), "generic-shell");
      writeFileSync(path.join(tmpDir, "en.html"), "en-shell");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const handlerLoader = {
        load: vi.fn().mockResolvedValue(vi.fn()),
        has: vi.fn((pathname: string) => pathname === "/[lang]/[slug]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      };
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoader as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        outputIds: ["/[lang]/[slug]"],
        localHandlerInvoker,
        pprRoutes: {
          "/[lang]/[slug]": {
            postponedState: "generic-state",
            fallbackFilePath: "generic.html",
          },
          "/en/[slug]": {
            postponedState: "en-state",
            fallbackFilePath: "en.html",
            chainHeaders: { "next-resume": "1" },
          },
        },
      });

      const req = mockReq("/en/post");
      await dispatcher.dispatch(req, mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/en/[slug]",
        routeMatches: { lang: "en", slug: "post" },
        resolvedHeaders: undefined,
      });

      expect(handlerLoader.load).toHaveBeenCalledWith("/[lang]/[slug]");
      expect((req as any)[Symbol.for("NextInternalRequestMeta")].postponed).toBe("en-state");
      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          responsePrefix: expect.objectContaining({ filePath: path.join(tmpDir, "en.html") }),
          invocationHeaders: { "next-resume": "1" },
        }),
      );
    });

    it("does not reuse a template PPR shell for a concrete non-PPR prerender", async () => {
      writeFileSync(path.join(tmpDir, "generic.html"), "generic-shell");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        outputIds: ["/[slug]"],
        staticAssets: [
          {
            pathname: "/blocking",
            filePath: "blocking.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
        entrypointOwnsPprShell: true,
        pprRoutes: {
          "/[slug]": {
            postponedState: "generic-state",
            fallbackFilePath: "generic.html",
          },
        },
      });

      const req = mockReq("/blocking");
      await dispatcher.dispatch(req, mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blocking",
        routeMatches: { slug: "blocking" },
        resolvedHeaders: undefined,
      });

      expect((req as any)[Symbol.for("NextInternalRequestMeta")]?.postponed).toBeUndefined();
      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.not.objectContaining({ responsePrefix: expect.anything() }),
      );
    });

    it("lets the E2E filesystem stand-in own only build-emitted PPR handlers", async () => {
      writeFileSync(path.join(tmpDir, "generic.html"), "generic-shell");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        entrypointOwnsPprShell: true,
        pprRoutes: {
          "/[slug]": {
            postponedState: "generic-state",
            fallbackFilePath: "generic.html",
          },
        },
      });

      await dispatcher.dispatch(mockReq("/novel"), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/[slug]",
        routeMatches: { slug: "novel" },
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({ minimalMode: false }),
      );
    });

    it("keeps E2E handlers without a build-emitted PPR artifact in minimal mode", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        entrypointOwnsPprShell: true,
        pprRoutes: {},
      });

      await dispatcher.dispatch(mockReq("/blocking"), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/[slug]",
        routeMatches: { slug: "blocking" },
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({ minimalMode: true }),
      );
    });

    it("does not prepend an HTML PPR shell to an RSC resume", async () => {
      writeFileSync(path.join(tmpDir, "ppr-shell.html"), "<html><body><p>shell</p>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        pprRoutes: {
          "/dashboard": {
            postponedState: "postponed-state",
            fallbackFilePath: "ppr-shell.html",
          },
        },
      });

      await dispatcher.dispatch(mockReq("/dashboard", { rsc: "1" }), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/dashboard",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.not.objectContaining({ responsePrefix: expect.anything() }),
      );
    });

    it("serves a seeded segment-prefetch entry even when its parent page has a handler", async () => {
      mkdirSync(path.join(tmpDir, "index.segments"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, "index.segments", "__PAGE__.segment.rsc"),
        "seeded-segment-rsc",
      );
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/index.segments/__PAGE__.segment.rsc",
            filePath: "index.segments/__PAGE__.segment.rsc",
            cacheControl: "public, max-age=0, must-revalidate",
            headers: { "content-type": "text/x-component" },
            prerender: true,
          },
        ],
        localHandlerInvoker,
        rscConfig: {
          header: "rsc",
          suffix: ".rsc",
          prefetchSegmentHeader: "next-router-segment-prefetch",
          prefetchSegmentDirSuffix: ".segments",
          prefetchSegmentSuffix: ".segment.rsc",
        },
      });
      const res = mockRes();

      await dispatcher.dispatch(
        mockReq("/?_rsc=abc", {
          rsc: "1",
          "next-router-prefetch": "1",
          "next-router-segment-prefetch": "/__PAGE__",
        }),
        res,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/index.segments/__PAGE__.segment.rsc",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
      );

      expect(res._status).toBe(200);
      expect(res._body).toBe("seeded-segment-rsc");
      expect(localHandlerInvoker).not.toHaveBeenCalled();
    });

    it("schedules an E2E filesystem shell fill after serving a seeded segment prefetch", async () => {
      mkdirSync(path.join(tmpDir, "index.segments"), { recursive: true });
      writeFileSync(
        path.join(tmpDir, "index.segments", "__PAGE__.segment.rsc"),
        "seeded-segment-rsc",
      );
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/index.segments/__PAGE__.segment.rsc",
            filePath: "index.segments/__PAGE__.segment.rsc",
            cacheControl: "public, max-age=0, must-revalidate",
            headers: { "content-type": "text/x-component" },
            prerender: true,
          },
        ],
        localHandlerInvoker,
        entrypointOwnsPprShell: true,
        rscConfig: {
          header: "rsc",
          suffix: ".rsc",
          prefetchSegmentHeader: "next-router-segment-prefetch",
          prefetchSegmentDirSuffix: ".segments",
          prefetchSegmentSuffix: ".segment.rsc",
        },
      });

      await dispatcher.dispatch(
        mockReq("/?_rsc=abc", {
          rsc: "1",
          "next-router-prefetch": "1",
          "next-router-segment-prefetch": "/__PAGE__",
        }),
        mockRes(),
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/index.segments/__PAGE__.segment.rsc",
          routeMatches: null,
          resolvedHeaders: undefined,
        },
      );

      await vi.waitFor(() => expect(localHandlerInvoker).toHaveBeenCalledOnce());
      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          discardResponse: true,
          req: expect.objectContaining({
            method: "GET",
            headers: expect.not.objectContaining({
              rsc: expect.anything(),
              "next-router-prefetch": expect.anything(),
              "next-router-segment-prefetch": expect.anything(),
            }),
          }),
        }),
      );
    });

    it("serves a seeded concrete RSC entry when execution maps to a dynamic parent handler", async () => {
      mkdirSync(path.join(tmpDir, "blog"), { recursive: true });
      writeFileSync(path.join(tmpDir, "blog", "first.rsc"), "seeded-concrete-rsc");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/blog/first.rsc",
            filePath: "blog/first.rsc",
            cacheControl: "public, max-age=0, must-revalidate",
            headers: { "content-type": "text/x-component" },
            prerender: true,
          },
        ],
        localHandlerInvoker,
        outputIds: ["/blog/[slug]"],
        rscConfig: { header: "rsc", suffix: ".rsc" },
      });
      const res = mockRes();

      await dispatcher.dispatch(mockReq("/blog/first?_rsc=abc", { rsc: "1" }), res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/first.rsc",
        routeMatches: { slug: "first" },
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._body).toBe("seeded-concrete-rsc");
      expect(localHandlerInvoker).not.toHaveBeenCalled();
    });

    it("404s a fallback:false path not in the prerendered set", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((p: string) => p === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        strictDynamicRoutes: [{ pageRegex: /^\/blog\/([^/]+?)(?:\/)?$/ }],
        prerenderedPaths: new Set(["/blog/first", "/blog/[first]"]),
        buildIdForData: "test123",
      });

      // Non-generated path → 404, handler never invoked.
      const res404 = mockRes();
      await dispatcher.dispatch(mockReq("/blog/nope"), res404 as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "nope" },
        resolvedHeaders: undefined,
      });
      expect(res404._status).toBe(404);
      expect(localHandlerInvoker).not.toHaveBeenCalled();

      // Generated path → dispatched to the handler.
      const resOk = mockRes();
      await dispatcher.dispatch(mockReq("/blog/first"), resOk as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "first" },
        resolvedHeaders: undefined,
      });
      expect(localHandlerInvoker).toHaveBeenCalledOnce();

      // Generated data paths may contain encoded literal brackets. Manifest
      // keys are decoded, so the strict-route guard must compare like-for-like.
      const resEncoded = mockRes();
      await dispatcher.dispatch(
        mockReq("/_next/data/test123/blog/%5Bfirst%5D.json"),
        resEncoded as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { slug: "[first]" },
          resolvedHeaders: undefined,
        },
      );
      expect(resEncoded._status).not.toBe(404);
      expect(localHandlerInvoker).toHaveBeenCalledTimes(2);
    });

    it("does NOT 404 a dynamic path that matches no strict route (fallback:blocking / dynamicParams:true)", async () => {
      // App has a fallback:false route (/blog/[slug]) but the request is for a
      // DIFFERENT dynamic route (/shop/[id]) that is fallback:blocking — it must
      // be served on-demand, never 404'd by the strict check.
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((p: string) => p === "/shop/[id]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        strictDynamicRoutes: [{ pageRegex: /^\/blog\/([^/]+?)(?:\/)?$/ }],
        prerenderedPaths: new Set(["/blog/first"]),
        buildIdForData: "test123",
      });
      const res = mockRes();
      await dispatcher.dispatch(mockReq("/shop/anything"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/shop/[id]",
        routeMatches: { id: "anything" },
        resolvedHeaders: undefined,
      });
      expect(res._status).not.toBe(404);
      expect(localHandlerInvoker).toHaveBeenCalledOnce();
    });

    it("does NOT 404 anything when there are no strict dynamic routes", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        // strictDynamicRoutes omitted → no gating
      });
      const res = mockRes();
      await dispatcher.dispatch(
        mockReq("/blog/never-generated"),
        res as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { slug: "never-generated" },
          resolvedHeaders: undefined,
        },
      );
      expect(res._status).not.toBe(404);
      expect(localHandlerInvoker).toHaveBeenCalledOnce();
    });

    it("applies the fallback:false 404 check to the internal invocation path", async () => {
      // A middleware rewrite lands on a fallback:false dynamic route that was
      // never generated → 404, evaluated against the rewritten path without
      // exposing that internal path through the public request URL.
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((p: string) => p === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        strictDynamicRoutes: [{ pageRegex: /^\/blog\/([^/]+?)(?:\/)?$/ }],
        prerenderedPaths: new Set(["/blog/first"]),
        buildIdForData: "test123",
      });
      const res = mockRes();
      // Request /rw, but middleware rewrote it to /blog/never (via invokePath).
      await dispatcher.dispatch(mockReq("/rw"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "never" },
        resolvedHeaders: undefined,
        invokePath: "/blog/never",
      });
      expect(res._status).toBe(404);
      expect(localHandlerInvoker).not.toHaveBeenCalled();
    });

    it("preserves the public request URL and passes a rewrite as invocation metadata", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
      });
      const req = mockReq("/blog-post-1?visible=yes");
      const res = mockRes();

      await dispatcher.dispatch(req, res, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[post]",
        routeMatches: { post: "post-1" },
        resolvedHeaders: undefined,
        invokePath: "/blog/post-1?post=post-1&hello=world",
      });

      expect(req.url).toBe("/blog-post-1?visible=yes");
      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          invocationPath: "/blog/post-1?post=post-1&hello=world",
          routeMatches: { post: "post-1" },
        }),
      );
    });

    it("returns 500 (Internal Server Error) for the error kind >= 500", async () => {
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });
      const res = mockRes();
      await dispatcher.dispatch(mockReq("/boom"), res as unknown as ServerResponse, {
        kind: "error",
        status: 500,
      });
      expect(res._status).toBe(500);
      expect(res._body).toContain("Internal Server Error");
    });

    // M10: the strict-dynamic-route 404 bypass requires a VERIFIED preview credential —
    // upstream Next validates x-prerender-revalidate and the __prerender_bypass cookie
    // against the build's random previewModeId (loaded as __NEXT_PREVIEW_MODE_ID).
    describe("strict-route preview bypass credentials (M10)", () => {
      const PREVIEW_ID = "build-preview-id";
      let previousPreviewId: string | undefined;

      function makeStrictDispatcher(localHandlerInvoker: ReturnType<typeof vi.fn>) {
        return createDispatcher({
          handlerLoader: {
            load: vi.fn().mockResolvedValue(vi.fn()),
            has: vi.fn((p: string) => p === "/blog/[slug]"),
            get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
          } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
          localHandlerInvoker,
          strictDynamicRoutes: [{ pageRegex: /^\/blog\/([^/]+?)(?:\/)?$/ }],
          prerenderedPaths: new Set(["/blog/first"]),
          buildIdForData: "test123",
        });
      }

      const strictResolution: ResolveResult = {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "nope" },
        resolvedHeaders: undefined,
      };

      beforeEach(() => {
        previousPreviewId = process.env.__NEXT_PREVIEW_MODE_ID;
      });

      afterEach(() => {
        if (previousPreviewId === undefined) delete process.env.__NEXT_PREVIEW_MODE_ID;
        else process.env.__NEXT_PREVIEW_MODE_ID = previousPreviewId;
      });

      it("lets a VERIFIED preview/revalidate request through a fallback:false route", async () => {
        process.env.__NEXT_PREVIEW_MODE_ID = PREVIEW_ID;
        const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
        const dispatcher = makeStrictDispatcher(localHandlerInvoker);

        // On-demand revalidation: header value equals the build's previewModeId.
        const resRevalidate = mockRes();
        await dispatcher.dispatch(
          mockReq("/blog/nope", { "x-prerender-revalidate": PREVIEW_ID }),
          resRevalidate as unknown as ServerResponse,
          strictResolution,
        );
        expect(localHandlerInvoker).toHaveBeenCalledOnce();

        // Draft mode: the bypass cookie's value equals the previewModeId — exactly
        // what Next's setDraftMode writes into the cookie.
        const resDraft = mockRes();
        await dispatcher.dispatch(
          mockReq("/blog/nope", { cookie: `__prerender_bypass=${PREVIEW_ID}` }),
          resDraft as unknown as ServerResponse,
          strictResolution,
        );
        expect(localHandlerInvoker).toHaveBeenCalledTimes(2);
      });

      it("RED TEAM: forged preview credentials do NOT bypass a fallback:false 404", async () => {
        process.env.__NEXT_PREVIEW_MODE_ID = PREVIEW_ID;
        const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
        const dispatcher = makeStrictDispatcher(localHandlerInvoker);

        // Presence alone proves nothing — every forged credential must still 404.
        for (const headers of [
          { "x-prerender-revalidate": "1" },
          { "x-prerender-revalidate": `${PREVIEW_ID}-typo` },
          { cookie: "__prerender_bypass=forged" },
          // A lookalike cookie name must not satisfy the check either.
          { cookie: `x__prerender_bypass=${PREVIEW_ID}` },
        ]) {
          const res = mockRes();
          await dispatcher.dispatch(
            mockReq("/blog/nope", headers),
            res as unknown as ServerResponse,
            strictResolution,
          );
          expect(res._status).toBe(404);
        }
        expect(localHandlerInvoker).not.toHaveBeenCalled();
      });

      it("never honors a preview bypass when the build has no preview identity", async () => {
        delete process.env.__NEXT_PREVIEW_MODE_ID;
        const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
        const dispatcher = makeStrictDispatcher(localHandlerInvoker);

        const res = mockRes();
        await dispatcher.dispatch(
          mockReq("/blog/nope", {
            "x-prerender-revalidate": PREVIEW_ID,
            cookie: `__prerender_bypass=${PREVIEW_ID}`,
          }),
          res as unknown as ServerResponse,
          strictResolution,
        );
        expect(res._status).toBe(404);
        expect(localHandlerInvoker).not.toHaveBeenCalled();
      });
    });

    it("routes a prerender through the handler when one exists (ISR/draft/revalidate semantics)", async () => {
      writeFileSync(path.join(tmpDir, "stale.html"), "<html>stale build file</html>");

      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const handler = vi.fn();
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/isr-page",
            filePath: "stale.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
            revalidate: 60,
          },
        ],
        localHandlerInvoker,
      });

      const req = mockReq("/isr-page");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/isr-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledOnce();
      expect(res._body).not.toContain("stale build file");
    });

    it("bypasses a concrete prerender seed when preview mode is active", async () => {
      writeFileSync(path.join(tmpDir, "seed.html"), "<html>non-preview seed</html>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "PAGES" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        outputIds: ["/blog/[slug]"],
        staticAssets: [
          {
            pathname: "/blog/first",
            filePath: "seed.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
            revalidate: 60,
          },
        ],
        localHandlerInvoker,
      });
      const res = mockRes();

      await dispatcher.dispatch(
        mockReq("/blog/first", { cookie: "__prerender_bypass=preview-token" }),
        res,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/first",
          routeMatches: { slug: "first" },
          resolvedHeaders: undefined,
        },
      );

      expect(localHandlerInvoker).toHaveBeenCalledOnce();
      expect(res._body).not.toContain("non-preview seed");
    });

    it("serves a handler-less prerender from the manifest file (pages SSG emits no function)", async () => {
      writeFileSync(path.join(tmpDir, "ssg.html"), "<html>ssg</html>");

      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          get: vi.fn(),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/ssg-page",
            filePath: "ssg.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
            status: 200,
          },
        ],
      });

      const req = mockReq("/ssg-page");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/ssg-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._body).toContain("ssg");
    });

    it("returns 405 for POST to a handler-less prerender", async () => {
      writeFileSync(path.join(tmpDir, "ssg.html"), "<html>ssg</html>");
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          get: vi.fn(),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/ssg-page",
            filePath: "ssg.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
      });
      const req = mockReq("/ssg-page");
      req.method = "POST";
      const res = mockRes();

      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/ssg-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(405);
      expect(res._headers.allow).toBe("GET, HEAD");
      expect(res._body).toBe("");
    });

    it("normalizes origin cache headers on a prerender artifact for the Valkey-owned cache", async () => {
      writeFileSync(path.join(tmpDir, "ssg.html"), "<html>ssg</html>");
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          get: vi.fn(),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/ssg-page",
            filePath: "ssg.html",
            cacheControl: "public, max-age=0, must-revalidate",
            headers: {
              "cache-control": "s-maxage=60, stale-while-revalidate=31535940",
              "cache-tag": "must-not-reach-cdn",
              "x-next-cache-tags": "internal-route-tag",
            },
            prerender: true,
          },
        ],
      });
      const res = mockRes();

      await dispatcher.dispatch(mockReq("/ssg-page"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/ssg-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
      expect(res._headers["cache-tag"]).toBeUndefined();
      expect(res._headers["x-next-cache-tags"]).toBeUndefined();
    });

    it("invokes the dynamic handler for a seeded Pages data request instead of serving HTML", async () => {
      writeFileSync(path.join(tmpDir, "first.html"), "<html>wrong protocol</html>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        buildIdForData: "test123",
        outputIds: ["/blog/[slug]"],
        staticAssets: [
          {
            pathname: "/blog/first",
            filePath: "first.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
            revalidate: 60,
          },
        ],
        localHandlerInvoker,
      });
      const res = mockRes();

      await dispatcher.dispatch(
        mockReq("/_next/data/test123/blog/first.json"),
        res as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/first",
          routeMatches: { slug: "first" },
          resolvedHeaders: undefined,
        },
      );

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({ matchedPathname: "/blog/[slug]" }),
      );
      expect(res._body).not.toContain("wrong protocol");
    });

    it("serves the emitted Pages fallback shell for an unseeded fallback:true document", async () => {
      writeFileSync(path.join(tmpDir, "fallback.html"), "<html><p>fallback</p></html>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/blog/[slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/blog/[slug]",
            filePath: "fallback.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
        emulatePlatformCache: true,
      });
      const res = mockRes();

      await dispatcher.dispatch(mockReq("/blog/unseeded"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "unseeded" },
        resolvedHeaders: undefined,
      });

      expect(res._body).toContain("fallback");
      expect(localHandlerInvoker).not.toHaveBeenCalled();

      await dispatcher.dispatch(mockReq("/blog/unseeded"), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { slug: "unseeded" },
        resolvedHeaders: undefined,
      });
      expect(localHandlerInvoker).toHaveBeenCalledOnce();

      await dispatcher.dispatch(
        mockReq("/blog/crawler", {
          "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
        }),
        mockRes(),
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { slug: "crawler" },
          resolvedHeaders: undefined,
        },
      );
      expect(localHandlerInvoker).toHaveBeenCalledTimes(2);
    });

    it("lets POST fall through to the handler instead of 405ing (server actions)", async () => {
      writeFileSync(path.join(tmpDir, "page.html"), "<html>static</html>");

      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/action-page",
            filePath: "page.html",
            cacheControl: "public, max-age=0",
            prerender: true,
          },
        ],
        localHandlerInvoker,
      });

      const req = mockReq("/action-page");
      (req as any).method = "POST";
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/action-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).not.toBe(405);
      expect(localHandlerInvoker).toHaveBeenCalledOnce();
    });

    it("returns 405 for a handler-backed Pages prerender without relying on response headers", async () => {
      writeFileSync(path.join(tmpDir, "page.html"), "<html>static</html>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "PAGES" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/pages-ssg",
            filePath: "page.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
      });
      const req = mockReq("/pages-ssg");
      req.method = "POST";
      const res = mockRes();

      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/pages-ssg",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(405);
      expect(localHandlerInvoker).not.toHaveBeenCalled();
    });

    it("marks handler-backed Pages prerenders for client-facing cache normalization", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "PAGES" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/pages-isr",
            filePath: "page.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
      });

      await dispatcher.dispatch(mockReq("/pages-isr"), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/pages-isr",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({ normalizePrerenderCacheControl: true }),
      );
    });

    it("does not infer POST 405 from an App response cache header", async () => {
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        innerRes.setHeader("x-nextjs-cache", "HIT");
        innerRes.setHeader("x-next-cache-tags", "internal-route-tag");
        innerRes.end("static page");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const req = mockReq("/static-page");
      req.method = "POST";
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/static-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(handler).toHaveBeenCalledOnce();
      // Non-minimal App entrypoints can emit x-nextjs-cache on a valid Server Action response.
      // Pages prerender POSTs are rejected earlier from output metadata, so this header is not a
      // safe method classifier at the generic invoker boundary.
      expect(res._status).toBe(200);
      expect(res._body).toBe("static page");
      expect(res._headers["x-next-cache-tags"]).toBeUndefined();
    });

    it("does not return 405 when the real invoker sees a dynamic response to POST", async () => {
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        innerRes.statusCode = 201;
        innerRes.end("action response");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const req = mockReq("/action-page");
      req.method = "POST";
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/action-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(res._status).toBe(201);
      expect(res._body).toBe("action response");
    });

    it("waits for entrypoint work registered from the response close event", async () => {
      let backgroundComplete = false;
      const handler = vi.fn(
        (_req: IncomingMessage, innerRes: ServerResponse, ctx: { waitUntil: Function }) => {
          // This mirrors App Router's after() integration: it does not register the task until
          // the response lifecycle fires close.
          innerRes.on("close", () => {
            ctx.waitUntil(
              new Promise<void>((resolve) => {
                setTimeout(() => {
                  backgroundComplete = true;
                  resolve();
                }, 5);
              }),
            );
          });
          innerRes.end("action response");
        },
      );
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/action-page"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/action-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._body).toBe("action response");
      expect(backgroundComplete).toBe(true);
    });

    it("lets Next's filesystem cache own prerenders only in platform-cache emulation", async () => {
      writeFileSync(path.join(tmpDir, "app-static.html"), "<html>seed</html>");
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const options = {
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [
          {
            pathname: "/app-static",
            filePath: "app-static.html",
            cacheControl: "public, max-age=0, must-revalidate",
            prerender: true,
          },
        ],
        localHandlerInvoker,
      };
      const dispatcher = createDispatcher({
        ...options,
        emulatePlatformCache: true,
      });

      const resolution = {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/app-static",
        routeMatches: null,
        resolvedHeaders: undefined,
      } as const;
      await dispatcher.dispatch(mockReq("/app-static"), mockRes(), resolution);
      expect(localHandlerInvoker).toHaveBeenLastCalledWith(
        expect.objectContaining({ minimalMode: false }),
      );

      (options.handlerLoader.get as any).mockReturnValue({
        runtime: "nodejs",
        type: "PAGES",
      });
      localHandlerInvoker.mockClear();
      await createDispatcher({ ...options, emulatePlatformCache: true }).dispatch(
        mockReq("/app-static"),
        mockRes(),
        resolution,
      );
      expect(localHandlerInvoker).toHaveBeenLastCalledWith(
        expect.objectContaining({ minimalMode: false }),
      );

      (options.handlerLoader.get as any).mockReturnValue({
        runtime: "nodejs",
        type: "APP_ROUTE",
      });
      localHandlerInvoker.mockClear();
      await createDispatcher({ ...options, emulatePlatformCache: true }).dispatch(
        mockReq("/app-static"),
        mockRes(),
        resolution,
      );
      expect(localHandlerInvoker).toHaveBeenLastCalledWith(
        expect.objectContaining({ minimalMode: false }),
      );

      (options.handlerLoader.get as any).mockReturnValue({
        runtime: "nodejs",
        type: "APP_PAGE",
      });
      localHandlerInvoker.mockClear();
      await createDispatcher(options).dispatch(mockReq("/app-static"), mockRes(), resolution);
      expect(localHandlerInvoker).toHaveBeenLastCalledWith(
        expect.objectContaining({ minimalMode: true }),
      );
    });

    it("waits for an entrypoint-owned asynchronous response stream", async () => {
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        setTimeout(() => {
          innerRes.setHeader("content-type", "application/json");
          innerRes.end('{"ok":true}');
        }, 5);
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/api/proxy"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/api/proxy",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(res._status).toBe(200);
      expect(res._body).toBe('{"ok":true}');
    });

    it("passes the route template and concrete rewrite separately in request metadata", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const res = mockRes();
      await dispatcher.dispatch(
        mockReq("/public-post", { host: "deployment.test:4321" }),
        res as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { nxtPslug: "post-1" },
          resolvedHeaders: undefined,
          invokePath: "/blog/post-1?draft=1",
        },
      );

      expect(requestMeta).toMatchObject({
        matchedPathname: "/blog/[slug]",
        outputId: "/blog/[slug]",
        resolvedPathname: "/blog/post-1",
        rewrittenPathname: "/blog/post-1",
        initURL: "http://deployment.test:4321/public-post",
        query: { draft: "1" },
        params: { slug: "post-1" },
      });
    });

    it("does not inject the ordinary-request initURL into the Server Action protocol", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const req = mockReq("/action", {
        host: "deployment.test:4321",
        "next-action": "action-id",
      });
      req.method = "POST";
      await dispatcher.dispatch(req, mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/action",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(requestMeta).not.toHaveProperty("initURL");
    });

    it("passes a concrete resolved pathname for a direct dynamic route", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      await dispatcher.dispatch(
        mockReq("/blog/post-1?draft=1"),
        mockRes() as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { nxtPslug: "post-1" },
          resolvedHeaders: undefined,
        },
      );

      expect(requestMeta).toMatchObject({
        matchedPathname: "/blog/[slug]",
        resolvedPathname: "/blog/post-1",
        params: { slug: "post-1" },
      });
      expect(requestMeta).not.toHaveProperty("rewrittenPathname");
    });

    it("decodes an encoded slash once inside an ordinary dynamic param", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      await dispatcher.dispatch(
        mockReq("/timestamp/key/%2Fnodejs%2Froute"),
        mockRes() as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/timestamp/key/[key]",
          routeMatches: { nxtPkey: "%2Fnodejs%2Froute" },
          resolvedHeaders: undefined,
        },
      );

      expect(requestMeta).toMatchObject({ params: { key: "/nodejs/route" } });
    });

    it("does not expose a trailing-slash delimiter as an empty catch-all param", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      await dispatcher.dispatch(
        mockReq("/product/shirts/mens-polo/1327037/"),
        mockRes() as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/product/[...product-params]",
          routeMatches: {
            "1": "shirts/mens-polo/1327037",
            // @next/routing removes punctuation in its internal nxtP alias.
            nxtPproductparams: "shirts/mens-polo/1327037",
          },
          resolvedHeaders: undefined,
        },
      );

      expect(requestMeta).toMatchObject({
        params: { "product-params": ["shirts", "mens-polo", "1327037"] },
      });
    });

    it("recovers a specialized root param missing from routing matches", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      await dispatcher.dispatch(
        mockReq("/with-root-param/en/posts/1?_rsc=abc", { rsc: "1" }),
        mockRes(),
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/with-root-param/[lang]/posts/[id]",
          routeMatches: { id: "1" },
          resolvedHeaders: undefined,
        },
      );

      expect(requestMeta).toMatchObject({ params: { lang: "en", id: "1" } });
    });

    it("recovers params through interception markers on an RSC output", async () => {
      let requestMeta: Record<string, unknown> | undefined;
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse, ctx: any) => {
        requestMeta = ctx.requestMeta;
        innerRes.end("ok");
      });
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(handler),
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      await dispatcher.dispatch(mockReq("/foo/p/1?_rsc=probe", { rsc: "1" }), mockRes(), {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/[locale]/(.)[username]/p/[id].rsc",
        routeMatches: { username: "foo", id: "1" },
        resolvedHeaders: undefined,
        invokePath: "/en/foo/p/1?_rsc=probe",
      });

      expect(requestMeta).toMatchObject({
        resolvedPathname: "/en/foo/p/1",
        params: { locale: "en", username: "foo", id: "1" },
      });
    });

    it("passes the concrete locale-prefixed prerender path to the dynamic handler", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has: vi.fn((pathname: string) => pathname === "/en/[...slug]"),
          get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "PAGES" }),
        } as any,
        poolName: "default",
        buildId: "test123",
        staticAssets: [],
        outputIds: ["/en/[...slug]"],
        localHandlerInvoker,
      });

      await dispatcher.dispatch(mockReq("/"), mockRes(), {
        kind: "route",
        pool: "default",
        matchedPathname: "/en/company/about-us",
        routeMatches: { nextInternalLocale: "en" },
        resolvedHeaders: undefined,
        invokePath: "/company/about-us?nextInternalLocale=en",
        invocationQuery: { nextInternalLocale: "en" },
      });

      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          matchedPathname: "/en/[...slug]",
          invocationPath: "/company/about-us?nextInternalLocale=en",
          routeParamPathname: "/en/company/about-us",
        }),
      );
    });

    it("falls back to the parent page handler for .rsc output ids", async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const has = vi.fn((p: string) => p === "/page");
      const dispatcher = createDispatcher({
        handlerLoader: {
          load: vi.fn().mockResolvedValue(vi.fn()),
          has,
          get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
        } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
        rscConfig: { header: "rsc", suffix: ".rsc" },
      });

      const req = mockReq("/page", { rsc: "1" });
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/page.rsc",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(localHandlerInvoker).toHaveBeenCalledOnce();
      expect(localHandlerInvoker.mock.calls[0][0].matchedPathname).toBe("/page");
    });

    it("forwards middleware redirect response headers (NextResponse.redirect with headers)", async () => {
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const headers = new Headers({ "x-redirect-header": "hi", location: "/target" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      const req = mockReq("/old");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "redirect",
        url: new URL("http://localhost/target"),
        status: 307,
        resolvedHeaders: headers,
      });

      expect(res._status).toBe(307);
      expect(res._headers["location"]).toBe("/target");
      expect(res._headers["x-redirect-header"]).toBe("hi");
      expect(res._headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    });

    // N15: RSC redirects keep the REAL 3xx — measured against `next start` 16.3.0-canary.84:
    //   curl -H 'RSC: 1' /redirect/source?_rsc=abc123
    //   → 308 + `location: /redirect/dest?_rsc=abc123` + `Refresh: 0;url=…`, no
    //     x-nextjs-redirect anywhere. The App Router flight client follows it
    //     (fetch-server-response.ts reads response.redirected); x-nextjs-redirect is a
    //     PAGES-router protocol (written under isNextDataRequest in server/web/adapter.ts,
    //     read only by shared/lib/router/router.ts).
    it("keeps the real 3xx on an RSC redirect (next start parity)", async () => {
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });
      const res = mockRes();

      await dispatcher.dispatch(mockReq("/old?_rsc=abc", { rsc: "1" }), res, {
        kind: "redirect",
        url: new URL("http://localhost/target"),
        status: 307,
        resolvedHeaders: new Headers({ location: "/target" }),
      });

      expect(res._status).toBe(307);
      expect(res._headers["location"]).toBe("/target");
      expect(res._headers["x-nextjs-redirect"]).toBeUndefined();
      // 307 carries no Refresh — only 308 does (measured).
      expect(res._headers["Refresh"]).toBeUndefined();
    });

    // `next start` sets `Refresh: 0;url=<location>` for the PERMANENT redirect status only
    // (router-server.ts: `if (statusCode === RedirectStatusCode.PermanentRedirect)`), and ends
    // the response with the location string as the body.
    it("adds Refresh on a 308 redirect only, and echoes the location as the body", async () => {
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const res308 = mockRes();
      await dispatcher.dispatch(mockReq("/old", { rsc: "1" }), res308, {
        kind: "redirect",
        url: new URL("http://localhost/target"),
        status: 308,
        resolvedHeaders: new Headers({ location: "/target" }),
      });
      expect(res308._status).toBe(308);
      expect(res308._headers["location"]).toBe("/target");
      expect(res308._headers["Refresh"]).toBe("0;url=/target");

      for (const status of [301, 302, 303, 307]) {
        const res = mockRes();
        await dispatcher.dispatch(mockReq("/old"), res, {
          kind: "redirect",
          url: new URL("http://localhost/target"),
          status,
          resolvedHeaders: new Headers({ location: "/target" }),
        });
        expect(res._status).toBe(status);
        expect(res._headers["Refresh"]).toBeUndefined();
      }
    });

    // L2: middlewareRedirectLocation consumes client-supplied x-forwarded-host/-proto.
    // Only well-formed values may influence the relative-vs-absolute Location decision.
    describe("middleware redirect Location with forwarded headers (L2)", () => {
      function makeRedirectDispatcher() {
        return createDispatcher({
          handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
          poolName: "ssr",
          buildId: "test123",
          staticAssets: [],
        });
      }

      async function dispatchRedirect(headers: Record<string, string>, target: string) {
        const res = mockRes();
        await makeRedirectDispatcher().dispatch(
          mockReq("/old", headers),
          res as unknown as ServerResponse,
          {
            kind: "redirect",
            url: new URL(target),
            status: 307,
            resolvedHeaders: new Headers({ location: "/target" }),
          },
        );
        return res;
      }

      it("honors a well-formed x-forwarded-host and x-forwarded-proto", async () => {
        const res = await dispatchRedirect(
          { "x-forwarded-host": "app.example.com:8443", "x-forwarded-proto": "https" },
          "https://app.example.com:8443/target",
        );
        expect(res._status).toBe(307);
        // Same origin as the forwarded host → relative Location.
        expect(res._headers["location"]).toBe("/target");
      });

      it("RED TEAM: ignores a malformed x-forwarded-host and falls back to Host", async () => {
        const res = await dispatchRedirect(
          { "x-forwarded-host": "http://evil.example/" },
          "http://localhost/target",
        );
        expect(res._status).toBe(307);
        // The malformed value must not win — Host (localhost) decides → relative.
        expect(res._headers["location"]).toBe("/target");
      });

      it("RED TEAM: a spoofed non-http(s) x-forwarded-proto falls back to http", async () => {
        const res = await dispatchRedirect(
          { "x-forwarded-proto": "javascript:alert(1)" },
          "http://localhost/target",
        );
        expect(res._status).toBe(307);
        expect(res._headers["location"]).toBe("/target");
      });

      it("RED TEAM: an out-of-range forwarded port never throws into a 500", async () => {
        const res = await dispatchRedirect(
          { "x-forwarded-host": "localhost:99999" },
          "http://localhost/target",
        );
        expect(res._status).toBe(307);
        // URL construction fails defensively → absolute target, still a valid Location.
        expect(res._headers["location"]).toBe("http://localhost/target");
      });
    });

    it("returns 400 for the error resolution kind (malformed percent-encoding)", async () => {
      const dispatcher = createDispatcher({
        handlerLoader: { load: vi.fn(), has: vi.fn(), get: vi.fn() } as any,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
      });

      const res = mockRes();
      await dispatcher.dispatch(mockReq("/%zz"), res as unknown as ServerResponse, {
        kind: "error",
        status: 400,
      });

      expect(res._status).toBe(400);
      expect(res._ended).toBe(true);
    });

    it("falls through to handler when pathname is not in static manifest", async () => {
      const handler = vi.fn();
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const handlerLoader = {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn().mockReturnValue(true),
        get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
      };

      const dispatcher = createDispatcher({
        handlerLoader,
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        localHandlerInvoker,
      });

      const req = mockReq("/dynamic-page");
      const res = mockRes();
      await dispatcher.dispatch(req, res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/dynamic-page",
        routeMatches: null,
        resolvedHeaders: undefined,
      });

      expect(handlerLoader.load).toHaveBeenCalledWith("/dynamic-page");
      expect(localHandlerInvoker).toHaveBeenCalledWith(
        expect.objectContaining({
          handler,
          matchedPathname: "/dynamic-page",
        }),
      );
    });
  });
});

// REGRESSION: getContentType — the map that was extended to fix sitemap
// (application/xml), font, and asset content-types surfacing in e2e. A missing
// entry silently serves the wrong type (e.g. sitemap.xml as octet-stream).
describe("getContentType", () => {
  const cases: [string, string][] = [
    ["/sitemap.xml", "application/xml"],
    ["/robots.txt", "text/plain; charset=utf-8"],
    ["/a.html", "text/html; charset=utf-8"],
    ["/a.json", "application/json; charset=utf-8"],
    ["/a.js", "application/javascript; charset=utf-8"],
    ["/a.css", "text/css; charset=utf-8"],
    ["/a.rsc", "text/x-component"],
    ["/img.png", "image/png"],
    ["/img.webp", "image/webp"],
    ["/img.avif", "image/avif"],
    ["/img.svg", "image/svg+xml"],
    ["/f.woff2", "font/woff2"],
    ["/f.woff", "font/woff"],
    ["/app.wasm", "application/wasm"],
    ["/site.webmanifest", "application/manifest+json"],
    ["/", "text/html; charset=utf-8"],
    ["/about", "text/html; charset=utf-8"],
    ["/mystery.xyz", "application/octet-stream"],
  ];
  for (const [p, expected] of cases) {
    it(`${p} -> ${expected}`, () => {
      expect(getContentType(p)).toBe(expected);
    });
  }
});
