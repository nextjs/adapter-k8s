// tests/pool-server/dispatch-hardening.test.ts
// Regression tests for the review-hardening batch: locale-prefixed strict 404s,
// build-time seed anchoring, header hygiene, and bounded bookkeeping.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDispatcher,
  mergeResolvedHeadersIntoHeadersArg,
  mergeResponseHeaders,
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

function noopHandlerLoader(has: (p: string) => boolean = () => false) {
  return {
    load: vi.fn().mockResolvedValue(vi.fn()),
    has: vi.fn(has),
    get: vi.fn().mockReturnValue({ runtime: "nodejs" }),
  } as any;
}

describe("locale-prefixed strict-dynamic 404 (fallback:false)", () => {
  const strictResolution: ResolveResult = {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/blog/[slug]",
    routeMatches: { slug: "not-generated" },
    resolvedHeaders: undefined,
  };

  function makeDispatcher(localHandlerInvoker: ReturnType<typeof vi.fn>) {
    return createDispatcher({
      handlerLoader: noopHandlerLoader((p) => p === "/blog/[slug]"),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      localHandlerInvoker,
      strictDynamicRoutes: [{ pageRegex: /^\/blog\/([^/]+?)(?:\/)?$/ }],
      prerenderedPaths: new Set(["/blog/generated"]),
      buildIdForData: "test123",
      i18nLocales: ["en", "fr"],
    });
  }

  it("404s an explicit-locale request for a non-generated path", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeDispatcher(localHandlerInvoker);

    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/en/blog/not-generated"),
      res as unknown as ServerResponse,
      strictResolution,
    );

    expect(res._status).toBe(404);
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("404s an explicit-locale DATA request for a non-generated path", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeDispatcher(localHandlerInvoker);

    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/_next/data/test123/en/blog/not-generated.json"),
      res as unknown as ServerResponse,
      strictResolution,
    );

    expect(res._status).toBe(404);
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("still serves a generated path under an explicit locale prefix", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeDispatcher(localHandlerInvoker);

    const res = mockRes();
    await dispatcher.dispatch(mockReq("/en/blog/generated"), res as unknown as ServerResponse, {
      ...strictResolution,
      routeMatches: { slug: "generated" },
    });

    expect(res._status).not.toBe(404);
    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });

  it("does not strip a first segment that is not a configured locale", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeDispatcher(localHandlerInvoker);

    // /de/... is not a configured locale → path stays prefixed → the unprefixed
    // strict regex can't match → NOT a strict 404 (same as an unknown route).
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/de/blog/not-generated"),
      res as unknown as ServerResponse,
      strictResolution,
    );

    expect(res._status).not.toBe(404);
    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });
});

describe("ISR seed freshness anchored to build time", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-seed-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "seed.html"), "<html>seed</html>");
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSeedDispatcher(localHandlerInvoker: ReturnType<typeof vi.fn>, builtAt?: string) {
    return createDispatcher({
      handlerLoader: noopHandlerLoader((p) => p === "/blog/[slug]"),
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
      ...(builtAt ? { builtAt } : {}),
    });
  }

  const seedResolution: ResolveResult = {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/blog/first",
    routeMatches: { slug: "first" },
    resolvedHeaders: undefined,
  };

  it("serves the seed when the build is still within its revalidate window", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeSeedDispatcher(localHandlerInvoker, new Date().toISOString());

    const res = mockRes();
    await dispatcher.dispatch(mockReq("/blog/first"), res as unknown as ServerResponse, {
      ...seedResolution,
    });

    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("regenerates when the BUILD (not the pod) is older than the revalidate window", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    // Built two hours ago; revalidate is 60s. A pod started seconds ago must NOT
    // re-serve the stale seed for another full window.
    const dispatcher = makeSeedDispatcher(
      localHandlerInvoker,
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    );

    const res = mockRes();
    await dispatcher.dispatch(mockReq("/blog/first"), res as unknown as ServerResponse, {
      ...seedResolution,
    });

    expect(res._body).not.toContain("seed");
    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });

  it("falls back to pod-start anchoring when the manifest has no builtAt", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const dispatcher = makeSeedDispatcher(localHandlerInvoker);

    const res = mockRes();
    await dispatcher.dispatch(mockReq("/blog/first"), res as unknown as ServerResponse, {
      ...seedResolution,
    });

    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });
});

describe("static-serve header hygiene", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-hdr-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "page.html"), "<html>page</html>");
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes cache-tag / x-next-cache-tags from manifest headers case-insensitively", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: noopHandlerLoader(),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/page",
          filePath: "page.html",
          cacheControl: "public, max-age=3600",
          prerender: true,
          // Build-time casing — a literal lowercase delete would leak both.
          headers: {
            "Cache-Tag": "stale-tag",
            "X-Next-Cache-Tags": "_N_T_/page",
          },
        },
      ],
    });

    const res = mockRes();
    await dispatcher.dispatch(mockReq("/page"), res as unknown as ServerResponse, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/page",
      routeMatches: null,
      resolvedHeaders: undefined,
    });

    expect(res._status).toBe(200);
    for (const key of Object.keys(res._headers)) {
      expect(["cache-tag", "x-next-cache-tags"]).not.toContain(key.toLowerCase());
    }
  });

  it("augments Vary using the CONFIGURED rsc header name", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: noopHandlerLoader(),
      poolName: "ssr",
      buildId: "test123",
      rscConfig: { header: "x-custom-rsc", suffix: ".rsc" },
      staticAssets: [
        {
          pathname: "/page",
          filePath: "page.html",
          cacheControl: "public, max-age=3600",
        },
      ],
    });

    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/page", { "x-custom-rsc": "1" }),
      res as unknown as ServerResponse,
      {
        kind: "route",
        pool: "ssr",
        matchedPathname: "/page",
        routeMatches: null,
        resolvedHeaders: undefined,
      },
    );

    expect(res._status).toBe(200);
    expect(res._headers["vary"]).toContain("x-custom-rsc");
    expect(res._headers["vary"]).toContain("next-router-state-tree");
  });
});

describe("mergeResponseHeaders", () => {
  it("appends set-cookie from shell and resume instead of replacing", () => {
    const merged = mergeResponseHeaders(
      { "Set-Cookie": ["shell=1; Path=/"], Link: "</shell.css>" },
      { "set-cookie": ["resume=2; Path=/", "resume2=3; Path=/"], link: "</resume.css>" },
    );

    expect(merged["set-cookie"]).toEqual([
      "shell=1; Path=/",
      "resume=2; Path=/",
      "resume2=3; Path=/",
    ]);
    // Non-cookie headers keep the replace rule (and case-fold).
    expect(merged["link"]).toBe("</resume.css>");
  });

  it("keeps a lone set-cookie source intact", () => {
    const merged = mergeResponseHeaders(undefined, { "set-cookie": "a=1; Path=/" });
    expect(merged["set-cookie"]).toBe("a=1; Path=/");
  });
});

describe("mergeResolvedHeadersIntoHeadersArg", () => {
  // The dispatch writeHead wrapper merges the routing verdict into whatever headers
  // shape the serve site passed. Node accepts object, tuple-array, AND flat-array
  // forms; the array forms previously fell into Object.keys (yielding indices) so
  // middleware headers were silently lost.
  const resolved = () =>
    new Headers({
      "x-from-middleware": "present",
      "cache-control": "private",
      "set-cookie": "mw=1; Path=/",
    });

  it("merges into the object form (replace non-cookie, append set-cookie)", () => {
    const out = mergeResolvedHeadersIntoHeadersArg(resolved(), {
      "Cache-Control": "public, max-age=60",
      "set-cookie": "app=2; Path=/",
      "content-type": "text/html",
    }) as Record<string, string | string[]>;
    expect(out["cache-control"]).toBe("private");
    expect(out["Cache-Control"]).toBeUndefined();
    expect(out["x-from-middleware"]).toBe("present");
    expect(out["content-type"]).toBe("text/html");
    expect(out["set-cookie"]).toEqual(["app=2; Path=/", "mw=1; Path=/"]);
  });

  it("merges into the tuple-array form", () => {
    const out = mergeResolvedHeadersIntoHeadersArg(resolved(), [
      ["Cache-Control", "public, max-age=60"],
      ["content-type", "text/html"],
      ["set-cookie", "app=2; Path=/"],
    ]) as [string, string][];
    const names = out.map(([n]) => n.toLowerCase());
    expect(names.filter((n) => n === "cache-control")).toHaveLength(1);
    expect(out.find(([n]) => n.toLowerCase() === "cache-control")?.[1]).toBe("private");
    expect(out.find(([n]) => n === "x-from-middleware")?.[1]).toBe("present");
    expect(out.find(([n]) => n === "content-type")?.[1]).toBe("text/html");
    const cookies = out.filter(([n]) => n.toLowerCase() === "set-cookie").map(([, v]) => v);
    expect(cookies).toEqual(["app=2; Path=/", "mw=1; Path=/"]);
  });

  it("merges into the FLAT array form (pairwise, not Object.keys indices)", () => {
    const out = mergeResolvedHeadersIntoHeadersArg(resolved(), [
      "Cache-Control",
      "public, max-age=60",
      "content-type",
      "text/html",
      "set-cookie",
      "app=2; Path=/",
    ]) as [string, string][];
    // Normalized back to tuples for Node.
    expect(Array.isArray(out[0])).toBe(true);
    expect(out.find(([n]) => n.toLowerCase() === "cache-control")?.[1]).toBe("private");
    expect(out.find(([n]) => n === "x-from-middleware")?.[1]).toBe("present");
    const cookies = out.filter(([n]) => n.toLowerCase() === "set-cookie").map(([, v]) => v);
    expect(cookies).toEqual(["app=2; Path=/", "mw=1; Path=/"]);
  });

  it("leaves undefined/null untouched (writeHead(status) keeps its behavior)", () => {
    expect(mergeResolvedHeadersIntoHeadersArg(resolved(), undefined)).toBeUndefined();
    expect(mergeResolvedHeadersIntoHeadersArg(resolved(), null)).toBeNull();
  });
});

describe("servedFallbackShells bound", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-cap-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "fallback.html"), "<html>fallback</html>");
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    "caps the fallback-shell marker set with eviction instead of unbounded growth",
    { timeout: 60_000 },
    async () => {
      const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
      const dispatcher = createDispatcher({
        handlerLoader: noopHandlerLoader((p) => p === "/blog/[slug]"),
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

      const dispatchUrl = (slug: string) =>
        dispatcher.dispatch(mockReq(`/blog/${slug}`), mockRes() as unknown as ServerResponse, {
          kind: "route",
          pool: "ssr",
          matchedPathname: "/blog/[slug]",
          routeMatches: { slug },
          resolvedHeaders: undefined,
        });

      // 10k distinct URLs fill the cap; one more evicts the oldest entry.
      for (let i = 0; i < 10_001; i++) {
        await dispatchUrl(`u${i}`);
      }
      expect(localHandlerInvoker).not.toHaveBeenCalled();

      // The oldest marker was evicted → its URL is treated as a fresh miss again
      // (shell re-served, handler NOT called)...
      await dispatchUrl("u0");
      expect(localHandlerInvoker).not.toHaveBeenCalled();

      // ...while a still-tracked URL materializes through the handler.
      await dispatchUrl("u10000");
      expect(localHandlerInvoker).toHaveBeenCalledOnce();
    },
  );
});

// N31: HEAD on a manifest-served asset wrote no length and then `res.end(undefined)`. Node marks
// a HEAD response body-less and emits NEITHER Content-Length NOR Transfer-Encoding, so the client
// learned nothing about the size — where `next start` answers HEAD with the real Content-Length
// (measured 2026-07-25: 13 for a public file, 309404 for a build chunk). Third instance of the
// bug the image optimizer already documents and fixed.
describe("manifest static serve reports Content-Length", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-len-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "asset.txt"), "twelve bytes");
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function assetDispatcher() {
    return createDispatcher({
      handlerLoader: noopHandlerLoader(),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [
        {
          pathname: "/asset.txt",
          filePath: "asset.txt",
          cacheControl: "public, max-age=0, must-revalidate",
        },
      ],
    });
  }

  const assetResolution: ResolveResult = {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/asset.txt",
    routeMatches: null,
    resolvedHeaders: undefined,
  };

  it("stamps content-length on a GET", async () => {
    const res = mockRes();
    await dispatcher200(assetDispatcher(), res, "GET");
    expect(res._headers["content-length"]).toBe("12");
    expect(res._body).toBe("twelve bytes");
  });

  it("stamps content-length on a HEAD and sends no body", async () => {
    const res = mockRes();
    await dispatcher200(assetDispatcher(), res, "HEAD");
    expect(res._headers["content-length"]).toBe("12");
    expect(res._body).toBe("");
  });

  async function dispatcher200(
    dispatcher: ReturnType<typeof createDispatcher>,
    res: ReturnType<typeof mockRes>,
    method: string,
  ) {
    const req = mockReq("/asset.txt");
    (req as { method: string }).method = method;
    await dispatcher.dispatch(req, res as unknown as ServerResponse, assetResolution);
    expect(res._status).toBe(200);
  }
});

// N38 (SECURITY): `(req.headers.cookie ?? "").includes("__prerender_bypass=")` — an UNAUTHENTICATED
// substring — disabled the concrete-prerender-seed fast path and the Pages fallback-shell path.
// Any client could send `Cookie: __prerender_bypass=` and force a full render per request: cheap
// CPU amplification, and a way to keep a shared cache seed from ever being used. The timing-safe
// verifier for exactly these two credentials (isVerifiedPreviewRequest) already lived ~400 lines
// above in the same file; upstream's scheme is an exact match against the build's random
// previewModeId, which is what it implements.
describe("prerender seed bypass requires a VERIFIED preview credential", () => {
  let tmpDir: string;
  const origCwd = process.cwd;
  const savedPreviewId = process.env.__NEXT_PREVIEW_MODE_ID;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-preview-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "seed.html"), "<html>seed</html>");
    process.env.__NEXT_PREVIEW_MODE_ID = "the-real-preview-id";
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedPreviewId === undefined) delete process.env.__NEXT_PREVIEW_MODE_ID;
    else process.env.__NEXT_PREVIEW_MODE_ID = savedPreviewId;
  });

  function makeDispatcher(localHandlerInvoker: ReturnType<typeof vi.fn>) {
    return createDispatcher({
      handlerLoader: noopHandlerLoader((p) => p === "/blog/[slug]"),
      poolName: "ssr",
      buildId: "test123",
      outputIds: ["/blog/[slug]"],
      staticAssets: [
        {
          pathname: "/blog/first",
          filePath: "seed.html",
          cacheControl: "public, max-age=0, must-revalidate",
          prerender: true,
          revalidate: 3600,
        },
      ],
      localHandlerInvoker,
      builtAt: new Date().toISOString(),
    });
  }

  const seedResolution: ResolveResult = {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/blog/first",
    routeMatches: { slug: "first" },
    resolvedHeaders: undefined,
  };

  async function dispatchWithCookie(cookie: string | undefined) {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    const res = mockRes();
    await makeDispatcher(localHandlerInvoker).dispatch(
      mockReq("/blog/first", cookie ? { cookie } : {}),
      res as unknown as ServerResponse,
      seedResolution,
    );
    return { res, localHandlerInvoker };
  }

  it("RED TEAM: a bare `__prerender_bypass=` cookie does NOT bypass the seed", async () => {
    const { res, localHandlerInvoker } = await dispatchWithCookie("__prerender_bypass=");
    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("RED TEAM: a wrong-value bypass cookie of the same length does NOT bypass the seed", async () => {
    const { res, localHandlerInvoker } = await dispatchWithCookie(
      "__prerender_bypass=the-real-preview-XX",
    );
    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("RED TEAM: the substring in an unrelated cookie name does NOT bypass the seed", async () => {
    const { res, localHandlerInvoker } = await dispatchWithCookie(
      "not__prerender_bypass=whatever; other=1",
    );
    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });

  it("an authentic bypass cookie DOES render fresh instead of serving the seed", async () => {
    const { res, localHandlerInvoker } = await dispatchWithCookie(
      "__prerender_bypass=the-real-preview-id",
    );
    expect(res._body).not.toContain("seed");
    expect(localHandlerInvoker).toHaveBeenCalledOnce();
  });

  it("serves the seed when there is no cookie at all", async () => {
    const { res, localHandlerInvoker } = await dispatchWithCookie(undefined);
    expect(res._body).toContain("seed");
    expect(localHandlerInvoker).not.toHaveBeenCalled();
  });
});

// N39: `x-next-cache-tags` is Next's internal transport between an entrypoint and the incremental
// cache. It exposes route/tag structure and `next start` removes it before the public response.
// dispatch deleted it on two boundaries with an explicit "never forward it to clients" comment,
// but every web-`Response` boundary — edge routes, `Response`-returning handlers,
// render404/renderError, and the middleware-response case — passed it straight through.
describe("x-next-cache-tags never reaches a client on the web-Response boundaries", () => {
  it("strips it from a middleware-authored Response", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: noopHandlerLoader(),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/anything"),
      res as unknown as ServerResponse,
      {
        kind: "middleware-response",
        response: new Response("mw body", {
          status: 200,
          headers: {
            "x-next-cache-tags": "_N_T_/blog/secret,_N_T_/internal",
            "x-keep-me": "1",
          },
        }),
      } as unknown as ResolveResult,
    );
    expect(res._headers["x-next-cache-tags"]).toBeUndefined();
    expect(res._headers["x-keep-me"]).toBe("1");
  });

  it("strips it from a redirect's resolved headers", async () => {
    const dispatcher = createDispatcher({
      handlerLoader: noopHandlerLoader(),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
    });
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/go"),
      res as unknown as ServerResponse,
      {
        kind: "redirect",
        status: 307,
        url: new URL("http://localhost/dest"),
        resolvedHeaders: new Headers({
          location: "/dest",
          "x-next-cache-tags": "_N_T_/secret",
        }),
      } as unknown as ResolveResult,
    );
    expect(res._status).toBe(307);
    expect(res._headers["x-next-cache-tags"]).toBeUndefined();
  });
});

// N43: the PPR document-vs-flight test hardcoded `req.headers.rsc` while every neighbouring check
// uses the build-pinned `rscConfig.header`. An app with a custom RSC header name would have the
// HTML shell prepended to a flight stream — a corrupt payload, not a degraded one.
describe("PPR document detection uses the configured RSC header", () => {
  let tmpDir: string;
  const origCwd = process.cwd;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `dispatch-rsc-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    process.cwd = () => tmpDir;
    writeFileSync(path.join(tmpDir, "shell.html"), "<html>shell</html>");
  });

  afterEach(() => {
    process.cwd = origCwd;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeDispatcher(localHandlerInvoker: ReturnType<typeof vi.fn>) {
    return createDispatcher({
      handlerLoader: noopHandlerLoader((p) => p === "/ppr"),
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      rscConfig: { header: "x-custom-rsc", suffix: ".rsc" },
      pprRoutes: { "/ppr": { postponedState: "state", fallbackFilePath: "shell.html" } },
      localHandlerInvoker,
    });
  }

  const pprResolution: ResolveResult = {
    kind: "route",
    pool: "ssr",
    matchedPathname: "/ppr",
    routeMatches: null,
    resolvedHeaders: undefined,
  };

  it("does NOT prepend the shell to a flight request that uses the custom header", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    await makeDispatcher(localHandlerInvoker).dispatch(
      mockReq("/ppr", { "x-custom-rsc": "1" }),
      mockRes() as unknown as ServerResponse,
      pprResolution,
    );
    expect(localHandlerInvoker).toHaveBeenCalledOnce();
    expect(localHandlerInvoker.mock.calls[0]![0].responsePrefix).toBeUndefined();
  });

  it("still prepends the shell to a real document request", async () => {
    const localHandlerInvoker = vi.fn().mockResolvedValue(undefined);
    await makeDispatcher(localHandlerInvoker).dispatch(
      mockReq("/ppr"),
      mockRes() as unknown as ServerResponse,
      pprResolution,
    );
    expect(localHandlerInvoker.mock.calls[0]![0].responsePrefix?.filePath).toContain("shell.html");
  });
});
