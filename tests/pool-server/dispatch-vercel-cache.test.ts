// x-vercel-cache synthesis — plans/prerender-matrix-catchup.md Phase 1.
// Upstream's cache-components-prerender-matrix (a live adapter CI gate at canary.97)
// asserts the platform cache status via `x-vercel-cache` with NO x-nextjs-cache fallback:
// PRERENDER = a build fallback artifact answered an unseen key; HIT = a stored entry
// answered; MISS = blocking generation with no servable fallback. The pool is the platform
// in both the deploy harness and production, so it stamps the verdict at the serve sites
// that already know it. This file pins the four unambiguous mappings; per-cell refinement
// iterates against the suite's expected-vs-received diffs.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";

type NodeHandler = (req: IncomingMessage, res: ServerResponse, ctx: any) => unknown;

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "app.example.com", ...headers },
    pipe: vi.fn(),
  } as unknown as IncomingMessage;
}

function mockRes() {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string | string[]>,
    _body: "",
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
    },
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

function makeDispatcher(handler: NodeHandler, options: Record<string, unknown> = {}) {
  return createDispatcher({
    handlerLoader: {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn((p: string) => p === "/route"),
      get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
    } as any,
    poolName: "ssr",
    buildId: "test123",
    staticAssets: [],
    ...options,
  });
}

const resolution = () =>
  ({
    kind: "route",
    pool: "ssr",
    matchedPathname: "/route",
    routeMatches: null,
    resolvedHeaders: undefined,
  }) as any;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("x-vercel-cache synthesis (prerender-matrix Phase 1)", () => {
  it("stamps HIT when Next's cache answered (x-nextjs-cache: HIT)", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-cache": "HIT" });
      res.end("<p>cached</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("HIT");
  });

  it("stamps HIT for STALE (a stored entry was served)", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-cache": "STALE" });
      res.end("<p>stale</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("HIT");
  });

  it("stamps MISS for a blocking minimal render with no fallback involved", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>blocking render</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("MISS");
  });

  it("never overrides a verdict the entrypoint already set", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-vercel-cache": "HIT" });
      res.end("<p>upstream said hit</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("HIT");
  });
});

describe("x-vercel-cache iteration 2: build-fallback-backed first renders are PRERENDER", () => {
  // Non-empty-shell matrix cells run NON-minimal in the harness (the entrypoint owns the
  // shell), so Next renders the first request itself and reports x-nextjs-cache: MISS —
  // but a BUILD fallback artifact backs the route, and upstream's contract calls that
  // serve PRERENDER, never MISS (matrix iter-1: 12× "expected PRERENDER, received MISS").
  it("maps x-nextjs-cache MISS to PRERENDER when the route has a build fallback shell", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-cache": "MISS" });
      res.end("<p>first render over a build fallback</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler, {
      pprRoutes: {
        "/route": { postponedState: "s", fallbackFilePath: "does-not-matter.html" },
      },
      // Simulate the harness/production case where the entrypoint owns the shell (no
      // adapter-side prefix injection): non-minimal, Next serves internally.
      incrementalCacheShared: true,
    }).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("PRERENDER");
  });

  it("keeps plain MISS for routes with no build fallback", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-cache": "MISS" });
      res.end("<p>no fallback</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("MISS");
  });
});

describe("x-vercel-cache iteration 3: postponed fallback-backed serves are PRERENDER", () => {
  // Measured on the live matrix fixture (debug pool, fresh keys): a fallback-backed
  // template's first serve carries `x-nextjs-postponed: 1` and NO x-nextjs-cache at all —
  // the fallback shell answered and the dynamic tail resumed. That is PRERENDER. Ordering
  // matters: a CACHED ppr entry re-serves with the postponed marker AND x-nextjs-cache:
  // HIT, and must stay HIT (pinned by the HIT test above running before this mapping).
  it("maps a postponed serve with no cache verdict to PRERENDER when a build fallback backs the route", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-postponed": "1" });
      res.end("<p>shell+resume over the build fallback</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler, {
      pprRoutes: { "/route": { postponedState: "s", fallbackFilePath: "f.html" } },
      incrementalCacheShared: true,
    }).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("PRERENDER");
  });

  it("keeps HIT when the postponed marker rides a cached entry", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html",
        "x-nextjs-postponed": "1",
        "x-nextjs-cache": "HIT",
      });
      res.end("<p>cached ppr entry</p>");
    };
    const res = mockRes();
    await makeDispatcher(handler, {
      pprRoutes: { "/route": { postponedState: "s", fallbackFilePath: "f.html" } },
      incrementalCacheShared: true,
    }).dispatch(mockReq("/route"), res, resolution());
    expect(res._headers["x-vercel-cache"]).toBe("HIT");
  });
});

describe("x-vercel-cache iteration 4: platform seen-key registry (same-entry HIT)", () => {
  // The matrix's same-entry cells prove entry sharing THROUGH the header: after priming a
  // key, a request mutating an EXCLUDED param (not in allowQuery) must be HIT — even when
  // the entry contributes zero bytes. A partition-param mutation mints a new key and stays
  // PRERENDER/MISS. Keys = template + allowQuery-param values, remembered per pool process.
  function pprDispatcher(seen: string[] = []) {
    const handler: NodeHandler = (_req, res) => {
      seen.push("render");
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-postponed": "1" });
      res.end("<p>shell+resume</p>");
    };
    return createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn((p: string) => p === "/m/[lang]/[id]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprRoutes: {
        "/m/[lang]/[id]": {
          postponedState: "s",
          fallbackFilePath: "f.html",
          allowQuery: ["lang"],
        },
      },
      incrementalCacheShared: true,
    } as any);
  }
  const matchRes = (lang: string, id: string) =>
    ({
      kind: "route",
      pool: "ssr",
      matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang, id },
      resolvedHeaders: undefined,
    }) as any;

  it("stamps HIT on the second serve of the same key (excluded param mutated)", async () => {
    const d = pprDispatcher();
    const r1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), r1, matchRes("en", "one"));
    expect(r1._headers["x-vercel-cache"]).toBe("PRERENDER");
    const r2 = mockRes();
    await d.dispatch(mockReq("/m/en/two"), r2, matchRes("en", "two"));
    expect(r2._headers["x-vercel-cache"]).toBe("HIT");
  });

  it("a partition-param mutation mints a NEW key and stays PRERENDER", async () => {
    const d = pprDispatcher();
    const r1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), r1, matchRes("en", "one"));
    const r2 = mockRes();
    await d.dispatch(mockReq("/m/fr/one"), r2, matchRes("fr", "one"));
    expect(r2._headers["x-vercel-cache"]).toBe("PRERENDER");
  });

  it("routes without an allowQuery declaration never enter the registry", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>plain</p>");
    };
    const d = makeDispatcher(handler);
    const r1 = mockRes();
    await d.dispatch(mockReq("/route"), r1, resolution());
    const r2 = mockRes();
    await d.dispatch(mockReq("/route"), r2, resolution());
    expect(r2._headers["x-vercel-cache"]).toBe("MISS");
  });
});

describe("x-vercel-cache iteration 5: real-build allowQuery shapes", () => {
  // Measured on the matrix fixture build: allowQuery carries nxtP-PREFIXED param names
  // (["nxtPlang","nxtPcategory"]) while extracted route params are bare ("lang"). Without
  // normalization every partition value read undefined and all keys per template collapsed
  // — 4 different-entry probes wrongly reported HIT.
  it("partition params match through the nxtP prefix (mutation mints a new key)", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "x-nextjs-postponed": "1" });
      res.end("<p>x</p>");
    };
    const d = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn((p: string) => p === "/m/[lang]/[id]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprRoutes: {
        "/m/[lang]/[id]": {
          postponedState: "s",
          fallbackFilePath: "f.html",
          allowQuery: ["nxtPlang"],
        },
      },
      incrementalCacheShared: true,
    } as any);
    const res1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), res1, {
      kind: "route", pool: "ssr", matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang: "en", id: "one" }, resolvedHeaders: undefined,
    } as any);
    const res2 = mockRes();
    await d.dispatch(mockReq("/m/fr/one"), res2, {
      kind: "route", pool: "ssr", matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang: "fr", id: "one" }, resolvedHeaders: undefined,
    } as any);
    expect(res2._headers["x-vercel-cache"]).toBe("PRERENDER");
  });

  it("pprCapableRoutes templates participate in the registry too (with-root same-entry HIT)", async () => {
    const handler: NodeHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>blocking</p>");
    };
    const d = createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn((p: string) => p === "/m/[lang]/[id]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprCapableRoutes: {
        "/m/[lang]/[id]": { rootParams: ["lang"], allowQuery: ["nxtPlang"] },
      },
    } as any);
    const res1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), res1, {
      kind: "route", pool: "ssr", matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang: "en", id: "one" }, resolvedHeaders: undefined,
    } as any);
    expect(res1._headers["x-vercel-cache"]).toBe("MISS");
    const res2 = mockRes();
    await d.dispatch(mockReq("/m/en/two"), res2, {
      kind: "route", pool: "ssr", matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang: "en", id: "two" }, resolvedHeaders: undefined,
    } as any);
    expect(res2._headers["x-vercel-cache"]).toBe("HIT");
  });
});

describe("x-vercel-cache iteration 7: platform response store for fully-keyed entries", () => {
  // fully-static-param cells ("serves the whole document from the cache"): when allowQuery
  // covers EVERY template param, the entry is fully static and the PLATFORM must replay the
  // stored bytes on a seen key (on Vercel that replay lives in the edge cache, not the
  // lambda LRU — which the per-request x-invocation-id correctly scopes away). Partial keys
  // ('nothing'/partial regions) must keep re-rendering.
  function storeDispatcher(bodyCounter: { n: number }, allowQuery: string[]) {
    const handler: NodeHandler = (_req, res) => {
      bodyCounter.n++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p>render-${bodyCounter.n}</p>`);
    };
    return createDispatcher({
      handlerLoader: {
        load: vi.fn().mockResolvedValue(handler),
        has: vi.fn((p: string) => p === "/m/[lang]/[id]"),
        get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
      } as any,
      poolName: "ssr",
      buildId: "test123",
      staticAssets: [],
      pprCapableRoutes: { "/m/[lang]/[id]": { rootParams: [], allowQuery } },
    } as any);
  }
  const matchRes = (lang: string, id: string) =>
    ({
      kind: "route", pool: "ssr", matchedPathname: "/m/[lang]/[id]",
      routeMatches: { lang, id }, resolvedHeaders: undefined,
    }) as any;

  it("replays the stored bytes for a seen fully-keyed entry (no re-render)", async () => {
    const counter = { n: 0 };
    const d = storeDispatcher(counter, ["nxtPlang", "nxtPid"]); // covers ALL params
    const r1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), r1, matchRes("en", "one"));
    const r2 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), r2, matchRes("en", "one"));
    expect(r1._body).toBe("<p>render-1</p>");
    expect(r2._body).toBe("<p>render-1</p>"); // replayed, not re-rendered
    expect(counter.n).toBe(1); // handler invoked once
    expect(r2._headers["x-vercel-cache"]).toBe("HIT");
  });

  it("keeps re-rendering when the key excludes a param (partial region)", async () => {
    const counter = { n: 0 };
    const d = storeDispatcher(counter, ["nxtPlang"]); // id excluded → entry not fully static
    const r1 = mockRes();
    await d.dispatch(mockReq("/m/en/one"), r1, matchRes("en", "one"));
    const r2 = mockRes();
    await d.dispatch(mockReq("/m/en/two"), r2, matchRes("en", "two"));
    expect(counter.n).toBe(2); // re-rendered
    expect(r2._headers["x-vercel-cache"]).toBe("HIT"); // sharing still visible via header
    expect(r2._body).toBe("<p>render-2</p>");
  });
});
