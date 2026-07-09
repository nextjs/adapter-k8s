// tests/pool-server/dispatch.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
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
      }),
    );
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
