// tests/pool-server/dispatch-invocation.test.ts
// Regression tests for the handler-invocation boundary (loopback invocation +
// response relay), covering the live-deploy regressions:
//  1. requestMeta.initURL must carry the real public scheme (x-forwarded-proto) —
//     a hardcoded http:// made every absolute App Route redirect escape to http.
//  2. A rewrite's invocation target (path + query, repeated keys included) must be
//     the LOOPBACK REQUEST URL, or generated entrypoints (which derive request.url
//     from `new URL(innerReq.url, initURL)`) never see rewrite-added query params.
//  3. The same HTTP field must not be forwarded twice: on a shared-cache miss the
//     generated app-page template appends captured entry headers onto a response
//     whose streaming render already set them (duplicate identical `link` doubled
//     React's reactMaxHeadersLength budget at the client).
//  4. `x-nextjs-prerender`-marked responses must get the adapter's CDN cache policy —
//     an s-maxage=31536000 leak was stored untagged by Cloud CDN for a year and
//     tag-based cutover invalidation could never purge it (M13, stamping side).
//  5. PPR routes with a registered classic cacheHandler (incrementalCacheShared)
//     must run NON-minimal so Next itself joins shell + resume via the shared
//     cache — minimal mode served bare postponed shells that nothing resumed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ResolveResult } from "../../src/pool-server/resolve.js";

type NodeHandler = (req: IncomingMessage, res: ServerResponse, ctx: any) => unknown;

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "app.example.com", ...headers },
    pipe: vi.fn(),
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string | string[]>;
  _body: string;
  _ended: boolean;
} {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string | string[]>,
    _body: "",
    _ended: false,
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    write(chunk: Buffer | string) {
      res._body += chunk.toString();
      return true;
    },
    end(body?: Buffer | string) {
      if (body) res._body += body.toString();
      res._ended = true;
    },
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

function handlerLoaderFor(pathname: string, handler: NodeHandler) {
  return {
    load: vi.fn().mockResolvedValue(handler),
    has: vi.fn((p: string) => p === pathname),
    get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_ROUTE", filePath: "x.js" }),
  } as any;
}

function routeResolution(overrides: Partial<Extract<ResolveResult, { kind: "route" }>> = {}) {
  return {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/api/echo",
    routeMatches: null,
    resolvedHeaders: undefined,
    ...overrides,
  } as ResolveResult;
}

function makeDispatcher(handler: NodeHandler, options: Record<string, unknown> = {}) {
  return createDispatcher({
    handlerLoader: handlerLoaderFor("/api/echo", handler),
    poolName: "ssr",
    buildId: "test123",
    staticAssets: [],
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestMeta.initURL public scheme", () => {
  it("derives the initURL scheme from a validated x-forwarded-proto", async () => {
    let initURL: string | undefined;
    const handler: NodeHandler = (_req, res, ctx) => {
      initURL = ctx.requestMeta.initURL;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    };
    const dispatcher = makeDispatcher(handler);
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/api/echo", { "x-forwarded-proto": "https" }),
      res,
      routeResolution(),
    );
    expect(initURL).toBe("https://app.example.com/api/echo");
    expect(res._status).toBe(200);
  });

  it("falls back to http for a spoofed/garbage x-forwarded-proto", async () => {
    let initURL: string | undefined;
    const handler: NodeHandler = (_req, res, ctx) => {
      initURL = ctx.requestMeta.initURL;
      res.writeHead(200, {});
      res.end("ok");
    };
    const dispatcher = makeDispatcher(handler);
    await dispatcher.dispatch(
      mockReq("/api/echo", { "x-forwarded-proto": "javascript:" }),
      mockRes(),
      routeResolution(),
    );
    expect(initURL).toBe("http://app.example.com/api/echo");
  });
});

describe("rewrite invocation URL reaches the entrypoint", () => {
  it("uses invokePath (path + repeated-key query) as the loopback request URL", async () => {
    let innerUrl: string | undefined;
    let initURL: string | undefined;
    const handler: NodeHandler = (req, res, ctx) => {
      innerUrl = req.url;
      initURL = ctx.requestMeta.initURL;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    const dispatcher = makeDispatcher(handler);
    await dispatcher.dispatch(
      mockReq("/rewrite-source?cb=1", { "x-forwarded-proto": "https" }),
      mockRes(),
      routeResolution({
        invokePath: "/api/echo?item=one&item=two&cb=1",
        invocationQuery: { item: ["one", "two"], cb: "1" },
      }),
    );
    // The entrypoint derives request.url from `new URL(innerReq.url, initURL)` — the
    // rewritten query must be in innerReq.url, while initURL keeps the public origin.
    expect(innerUrl).toBe("/api/echo?item=one&item=two&cb=1");
    expect(initURL).toBe("https://app.example.com/rewrite-source?cb=1");
  });

  it("keeps the public req.url when there is no rewrite", async () => {
    let innerUrl: string | undefined;
    const handler: NodeHandler = (req, res) => {
      innerUrl = req.url;
      res.writeHead(200, {});
      res.end("ok");
    };
    const dispatcher = makeDispatcher(handler);
    await dispatcher.dispatch(mockReq("/api/echo?a=1"), mockRes(), routeResolution());
    expect(innerUrl).toBe("/api/echo?a=1");
  });
});

describe("duplicate identical response headers are collapsed", () => {
  it("forwards a link header emitted twice with identical values only once", async () => {
    const linkValue = '</font-00.woff2>; rel=preload; as="font", </font-01.woff2>; rel=preload';
    const handler: NodeHandler = (_req, res) => {
      // Two raw `link` fields with the same value — the shared-cache-miss shape where the
      // template appends captured entry headers after the streaming render already set them.
      res.setHeader("link", [linkValue, linkValue]);
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>x</p>");
    };
    const dispatcher = makeDispatcher(handler);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/api/echo"), res, routeResolution());
    expect(res._headers["link"]).toBe(linkValue);
  });

  it("preserves distinct repeated values and set-cookie lists", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.setHeader("link", ["</a.css>; rel=preload", "</b.css>; rel=preload"]);
      res.setHeader("set-cookie", ["a=1; Path=/", "a=1; Path=/"]);
      res.writeHead(200, {});
      res.end("ok");
    };
    const dispatcher = makeDispatcher(handler);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/api/echo"), res, routeResolution());
    // Node folds distinct link values into a comma list — both survive.
    expect(res._headers["link"]).toContain("</a.css>");
    expect(res._headers["link"]).toContain("</b.css>");
    // set-cookie is never collapsed, even when identical.
    expect(res._headers["set-cookie"]).toEqual(["a=1; Path=/", "a=1; Path=/"]);
  });
});

describe("x-nextjs-prerender cache-control normalization (M13 stamping side)", () => {
  it("rewrites a cacheable s-maxage leak on a prerender-marked response", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, {
        "x-nextjs-prerender": "1",
        "cache-control": "s-maxage=31536000",
        "cache-tag": "stale-tag",
        "content-type": "text/html",
      });
      res.end("<p>page</p>");
    };
    const dispatcher = makeDispatcher(handler);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/api/echo"), res, routeResolution());
    expect(res._headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(res._headers["cache-tag"]).toBeUndefined();
  });

  it("keeps a stricter uncacheable verdict on PPR-style prerender responses", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, {
        "x-nextjs-prerender": "1",
        "x-nextjs-postponed": "1",
        "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
      });
      res.end("shell");
    };
    const dispatcher = makeDispatcher(handler);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/api/echo"), res, routeResolution());
    expect(res._headers["cache-control"]).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });
});

describe("PPR minimal-mode gate with a registered classic cacheHandler", () => {
  const pprRoutes = {
    "/ppr-page": {
      postponedState: "token",
      fallbackFilePath: ".next/server/app/ppr-page.html",
    },
  };

  function invokerCapture() {
    const calls: any[] = [];
    const invoker = vi.fn(async (args: any) => {
      calls.push(args);
    });
    return { calls, invoker };
  }

  it("invokes PPR handlers non-minimal when incrementalCacheShared owns the shell", async () => {
    const { calls, invoker } = invokerCapture();
    const dispatcher = createDispatcher({
      handlerLoader: handlerLoaderFor("/ppr-page", vi.fn()),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprRoutes,
      incrementalCacheShared: true,
      localHandlerInvoker: invoker as any,
    });
    await dispatcher.dispatch(
      mockReq("/ppr-page"),
      mockRes(),
      routeResolution({ matchedPathname: "/ppr-page" }),
    );
    expect(calls).toHaveLength(1);
    // Non-minimal: Next itself performs the shell lookup + resume join through the
    // shared incremental cache; minimal mode returned a bare postponed shell that
    // nothing resumed (live PPR documents were served with unfilled dynamic holes).
    expect(calls[0].minimalMode).toBe(false);
    // The entry owns the shell — the build-time token/prefix must NOT be injected.
    expect(calls[0].responsePrefix).toBeUndefined();
  });

  it("keeps non-PPR handlers minimal when incrementalCacheShared is set", async () => {
    const { calls, invoker } = invokerCapture();
    const dispatcher = createDispatcher({
      handlerLoader: handlerLoaderFor("/api/echo", vi.fn()),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprRoutes,
      incrementalCacheShared: true,
      localHandlerInvoker: invoker as any,
    });
    await dispatcher.dispatch(mockReq("/api/echo"), mockRes(), routeResolution());
    expect(calls).toHaveLength(1);
    expect(calls[0].minimalMode).toBe(true);
  });

  it("still injects the build token for PPR when NO cache handler owns the shell", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-shell-"));
    const shellFile = path.join(dir, "ppr-page.html");
    writeFileSync(shellFile, "<html>shell</html>");
    try {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/ppr-page", vi.fn()),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {
          "/ppr-page": { postponedState: "token", fallbackFilePath: shellFile },
        },
        incrementalCacheShared: false,
        localHandlerInvoker: invoker as any,
      });
      const req = mockReq("/ppr-page");
      await dispatcher.dispatch(req, mockRes(), routeResolution({ matchedPathname: "/ppr-page" }));
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(true);
      const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
      expect(meta?.postponed).toBe("token");
      // Document requests get the persisted shell prepended to the resume stream.
      expect(calls[0].responsePrefix?.filePath).toBe(shellFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
