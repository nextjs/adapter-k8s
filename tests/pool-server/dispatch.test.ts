// tests/pool-server/dispatch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDispatcher, getContentType } from "../../src/pool-server/dispatch.js";
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
    // Proxy will fail with connection error in test env → 502 with error message
    expect(res._status).toBe(502);
    expect(res._body).toContain("External rewrite failed");
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

    const req = mockReq("/about", { cookie: "a=1" });
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

      const req = mockReq("/");
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

    it("lets a preview (__prerender_bypass) request through a fallback:false route", async () => {
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
      await dispatcher.dispatch(
        mockReq("/blog/nope", { cookie: "__prerender_bypass=xyz" }),
        res as unknown as ServerResponse,
        {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { slug: "nope" },
          resolvedHeaders: undefined,
        },
      );
      expect(localHandlerInvoker).toHaveBeenCalledOnce();
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

    it("returns 405 when the real invoker sees a cached response to POST", async () => {
      const handler = vi.fn((_req: IncomingMessage, innerRes: ServerResponse) => {
        innerRes.setHeader("x-nextjs-cache", "HIT");
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
      expect(res._status).toBe(405);
      expect(res._body).toBe("static page");
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
      await dispatcher.dispatch(mockReq("/public-post"), res as unknown as ServerResponse, {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/blog/[slug]",
        routeMatches: { nxtPslug: "post-1" },
        resolvedHeaders: undefined,
        invokePath: "/blog/post-1?draft=1",
      });

      expect(requestMeta).toMatchObject({
        matchedPathname: "/blog/[slug]",
        outputId: "/blog/[slug]",
        resolvedPathname: "/blog/post-1",
        rewrittenPathname: "/blog/post-1",
        query: { draft: "1" },
        params: { slug: "post-1" },
      });
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
      expect(res._headers["location"]).toBe("http://localhost/target");
      expect(res._headers["x-redirect-header"]).toBe("hi");
      expect(res._headers["set-cookie"]).toEqual(["a=1", "b=2"]);
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
