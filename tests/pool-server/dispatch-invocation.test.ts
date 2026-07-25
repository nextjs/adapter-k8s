// tests/pool-server/dispatch-invocation.test.ts
// Regression tests for the handler-invocation boundary (loopback invocation +
// response relay), covering the live-deploy regressions:
//  1. requestMeta.initURL must carry the real public scheme (x-forwarded-proto) —
//     a hardcoded http:// made every absolute App Route redirect escape to http.
//  2. A rewrite's invocation target must NOT become the loopback request URL. Generated
//     entrypoints derive `req.url` / `request.nextUrl` / `resolvedAsPath` from
//     `new URL(innerReq.url, initURL)`, and `next start` hands them the PUBLIC url
//     (BaseServer: `request.url = initURL.pathname + initURL.search`), carrying the
//     rewrite target only through requestMeta. Passing the destination made req.url,
//     router.asPath and usePathname all report the rewrite destination. The single
//     exception is an App ROUTE handler, whose search params have no requestMeta
//     channel at all — the rewrite query folds onto the PUBLIC pathname there.
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

function handlerLoaderFor(pathname: string, handler: NodeHandler, type = "APP_ROUTE") {
  return {
    load: vi.fn().mockResolvedValue(handler),
    has: vi.fn((p: string) => p === pathname),
    get: vi.fn().mockReturnValue({ runtime: "nodejs", type, filePath: "x.js" }),
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

describe("public request URL vs rewrite invocation target", () => {
  // Empirically pinned against `next start` (Next 16.2.10) on the upstream fixtures:
  //   /blog-post-2 -> /blog/post-2?hello=world   req.url + asPath = "/blog-post-2",
  //                                              resolvedUrl = "/blog/post-2",
  //                                              query = { post, hello }
  //   /rewrite-source/foo -> /rewrite-target     req.url + asPath = "/rewrite-source/foo"
  //   /rewritten-use-pathname -> /hooks/...      usePathname() = "/rewritten-use-pathname"
  // The destination must therefore stay OUT of the loopback URL for Pages/App PAGE
  // entries; it travels through requestMeta.query / .params / .resolvedPathname.
  function captureInvocation(type: string) {
    const seen: { innerUrl?: string; initURL?: string; meta?: any } = {};
    const handler: NodeHandler = (req, res, ctx) => {
      seen.innerUrl = req.url;
      seen.initURL = ctx.requestMeta.initURL;
      seen.meta = ctx.requestMeta;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
    const dispatcher = createDispatcher({
      handlerLoader: handlerLoaderFor("/api/echo", handler, type),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });
    return { seen, dispatcher };
  }

  it("keeps the public URL byte-exact for a rewritten Pages request", async () => {
    const { seen, dispatcher } = captureInvocation("PAGES");
    await dispatcher.dispatch(
      mockReq("/rewrite-source/foo", { "x-forwarded-proto": "https" }),
      mockRes(),
      routeResolution({
        invokePath: "/api/echo?path=foo",
        invocationQuery: { path: "foo" },
      }),
    );
    // `next start`: req.url / asPath stay on the source; the destination reaches the
    // entry as requestMeta.resolvedPathname + requestMeta.query only.
    expect(seen.innerUrl).toBe("/rewrite-source/foo");
    expect(seen.initURL).toBe("https://app.example.com/rewrite-source/foo");
    expect(seen.meta.resolvedPathname).toBe("/api/echo");
    expect(seen.meta.rewrittenPathname).toBe("/api/echo");
    expect(seen.meta.query).toEqual({ path: "foo" });
  });

  it("keeps the public URL for a rewritten App PAGE request (usePathname parity)", async () => {
    const { seen, dispatcher } = captureInvocation("APP_PAGE");
    await dispatcher.dispatch(
      mockReq("/rewritten-use-pathname"),
      mockRes(),
      routeResolution({ invokePath: "/api/echo" }),
    );
    expect(seen.innerUrl).toBe("/rewritten-use-pathname");
  });

  it("does not let a rewrite-added query leak into a Pages loopback URL", async () => {
    const { seen, dispatcher } = captureInvocation("PAGES");
    await dispatcher.dispatch(
      mockReq("/blog-post-2"),
      mockRes(),
      routeResolution({
        invokePath: "/api/echo?hello=world",
        invocationQuery: { hello: "world" },
      }),
    );
    expect(seen.innerUrl).toBe("/blog-post-2");
    expect(seen.meta.query).toEqual({ hello: "world" });
  });

  it("folds the rewrite query onto the PUBLIC pathname for an App ROUTE handler", async () => {
    const { seen, dispatcher } = captureInvocation("APP_ROUTE");
    await dispatcher.dispatch(
      mockReq("/rewrite-query-array?cb=1", { "x-forwarded-proto": "https" }),
      mockRes(),
      routeResolution({
        invokePath: "/api/echo?item=one&item=two&cb=1",
        invocationQuery: { item: ["one", "two"], cb: "1" },
      }),
    );
    // A route handler reads search params from the request URL only (NextRequestAdapter),
    // so repeated destination keys must ride the PUBLIC pathname — never the destination
    // pathname, which would still be visible via request.nextUrl.pathname.
    expect(seen.innerUrl).toBe("/rewrite-query-array?item=one&item=two&cb=1");
    expect(seen.initURL).toBe("https://app.example.com/rewrite-query-array?cb=1");
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

  it("does not fold query into the URL for an App ROUTE without a rewrite", async () => {
    const { seen, dispatcher } = captureInvocation("APP_ROUTE");
    await dispatcher.dispatch(
      mockReq("/api/echo?a=1"),
      mockRes(),
      routeResolution({ invocationQuery: { a: "1" } }),
    );
    expect(seen.innerUrl).toBe("/api/echo?a=1");
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

  // N16: a PPR-capable route whose build emitted NO fallback shell (`fallback: null`) is absent
  // from pprRoutes, so the old `!!handlerPprInfo` gate left it in minimal mode — the entrypoint
  // then answered with a truncated postponed shell (measured 1705 B + `x-nextjs-postponed: 1`,
  // no `$RC(` resume) instead of `next start`'s 7973 B complete document. pprCapableRoutes
  // carries those templates so they run NON-minimal and Next owns shell lookup + resume — but
  // ONLY the ROOT-param flavour. A shell-less PPR route with NO unresolved root params (no
  // Suspense boundary above the params access) is rendered dynamically by upstream; running it
  // non-minimal made Next resume a fallback shell upstream deliberately skips
  // (app-dir/fallback-shells: 5 tests, `x-nextjs-postponed: 1` + a buildtime root layout).
  describe("pprCapableRoutes: PPR with no build-emitted shell (N16)", () => {
    const rscConfig = { header: "rsc", suffix: ".rsc" } as any;

    it("runs non-minimal for a document request when only pprCapableRoutes knows the route", async () => {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/x/[id]", vi.fn(), "APP_PAGE"),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {},
        pprCapableRoutes: { "/x/[id]": { rootParams: ["lang"] } },
        incrementalCacheShared: true,
        rscConfig,
        localHandlerInvoker: invoker as any,
      });
      await dispatcher.dispatch(
        mockReq("/x/1"),
        mockRes(),
        routeResolution({ matchedPathname: "/x/[id]" }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(false);
      // No build-emitted shell exists, so nothing may be injected or prepended.
      expect(calls[0].responsePrefix).toBeUndefined();
    });

    // LOAD-BEARING: an RSC request's matched output id carries the `.rsc` suffix, so the base
    // route must be recovered via rscParentCandidates before the pprCapableRoutes lookup.
    // Without that rung the document request was fixed but the flight request still truncated.
    it("runs non-minimal for a .rsc flight output whose BASE route is PPR-capable", async () => {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/x/[id]", vi.fn(), "APP_PAGE"),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {},
        pprCapableRoutes: { "/x/[id]": { rootParams: ["lang"] } },
        entrypointOwnsPprShell: true,
        rscConfig,
        localHandlerInvoker: invoker as any,
      });
      await dispatcher.dispatch(
        mockReq("/x/1", { rsc: "1" }),
        mockRes(),
        routeResolution({ matchedPathname: "/x/[id].rsc" }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(false);
    });

    // The regression this split fixes: shell-less with NO unresolved root params. Upstream does
    // a plain dynamic render for these, so the pool must stay MINIMAL.
    it("stays minimal for a shell-less PPR route with no unresolved root params", async () => {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/x/[id]", vi.fn(), "APP_PAGE"),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {},
        pprCapableRoutes: { "/x/[id]": { rootParams: [] } },
        incrementalCacheShared: true,
        rscConfig,
        localHandlerInvoker: invoker as any,
      });
      await dispatcher.dispatch(
        mockReq("/x/1"),
        mockRes(),
        routeResolution({ matchedPathname: "/x/[id]" }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(true);
    });

    it("stays minimal for a route absent from BOTH pprRoutes and pprCapableRoutes", async () => {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/x/[id]", vi.fn(), "APP_PAGE"),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {},
        pprCapableRoutes: { "/other/[id]": { rootParams: ["lang"] } },
        incrementalCacheShared: true,
        rscConfig,
        localHandlerInvoker: invoker as any,
      });
      await dispatcher.dispatch(
        mockReq("/x/1"),
        mockRes(),
        routeResolution({ matchedPathname: "/x/[id]" }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(true);
    });

    // The gate is still conditioned on someone owning the shell cache: with neither
    // incrementalCacheShared nor entrypointOwnsPprShell there is no resume owner, so
    // pprCapableRoutes alone must not flip minimal mode.
    it("stays minimal when no cache owner is configured", async () => {
      const { calls, invoker } = invokerCapture();
      const dispatcher = createDispatcher({
        handlerLoader: handlerLoaderFor("/x/[id]", vi.fn(), "APP_PAGE"),
        poolName: "ssr",
        buildId: "test123",
        staticAssets: [],
        pprRoutes: {},
        pprCapableRoutes: { "/x/[id]": { rootParams: ["lang"] } },
        incrementalCacheShared: false,
        entrypointOwnsPprShell: false,
        rscConfig,
        localHandlerInvoker: invoker as any,
      });
      await dispatcher.dispatch(
        mockReq("/x/1"),
        mockRes(),
        routeResolution({ matchedPathname: "/x/[id]" }),
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].minimalMode).toBe(true);
    });
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

// N13: NEXT_ENABLE_ADAPTER harness only. A concrete path served through an SSG/ISR app
// template has no build artifact of its own, so minimal mode made the entrypoint
// re-render it every request and emit NO x-nextjs-cache — the harness (which stands
// Next's filesystem cache in for the platform cache) never saw the MISS→HIT transition
// `next start` reports. Production is unaffected: Valkey + Cloud CDN own cache status.
describe("emulated platform cache: SSG app templates", () => {
  const staticAssets = [
    {
      pathname: "/rewrite/foo",
      filePath: ".next/server/app/rewrite/foo.html",
      cacheControl: "public, max-age=0, must-revalidate",
      prerender: true,
    },
  ] as any;

  function capture() {
    const calls: any[] = [];
    const invoker = vi.fn(async (args: any) => {
      calls.push(args);
    });
    return { calls, invoker };
  }

  const base = {
    poolName: "ssr",
    buildId: "test123",
    staticAssets,
    outputIds: ["/rewrite/[slug]"],
  };

  it("runs a concrete path under an SSG template NON-minimal so Next reports cache status", async () => {
    const { calls, invoker } = capture();
    const dispatcher = createDispatcher({
      ...base,
      handlerLoader: handlerLoaderFor("/rewrite/[slug]", vi.fn(), "APP_PAGE"),
      emulatePlatformCache: true,
      localHandlerInvoker: invoker as any,
    } as any);

    await dispatcher.dispatch(
      mockReq("/rewrite/not-broken"),
      mockRes(),
      routeResolution({ matchedPathname: "/rewrite/not-broken" }),
    );

    expect(calls[0].minimalMode).toBe(false);
  });

  it("stays minimal without the platform-cache emulation (production)", async () => {
    const { calls, invoker } = capture();
    const dispatcher = createDispatcher({
      ...base,
      handlerLoader: handlerLoaderFor("/rewrite/[slug]", vi.fn(), "APP_PAGE"),
      localHandlerInvoker: invoker as any,
    } as any);

    await dispatcher.dispatch(
      mockReq("/rewrite/not-broken"),
      mockRes(),
      routeResolution({ matchedPathname: "/rewrite/not-broken" }),
    );

    expect(calls[0].minimalMode).toBe(true);
  });

  // This emulation is for PLAIN SSG/ISR only. A PPR template also owns concrete
  // generateStaticParams prerenders whose assets carry no `ppr` flag (only outputs with a
  // postponed state get one), so they are indistinguishable from SSG instances here. Flipping
  // them non-minimal made Next resume a fallback shell upstream does not resume — that is the
  // second, independent cause of the app-dir/fallback-shells regression (narrowing the N16 gate
  // alone left all 5 failures in place). pprCapableRoutes membership is the PPR marker.
  it("stays minimal for a concrete path under a PPR template (pprCapableRoutes)", async () => {
    const { calls, invoker } = capture();
    const dispatcher = createDispatcher({
      ...base,
      handlerLoader: handlerLoaderFor("/rewrite/[slug]", vi.fn(), "APP_PAGE"),
      emulatePlatformCache: true,
      pprCapableRoutes: { "/rewrite/[slug]": { rootParams: [] } },
      localHandlerInvoker: invoker as any,
    } as any);

    await dispatcher.dispatch(
      mockReq("/rewrite/not-broken"),
      mockRes(),
      routeResolution({ matchedPathname: "/rewrite/not-broken" }),
    );

    expect(calls[0].minimalMode).toBe(true);
  });
});
