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
