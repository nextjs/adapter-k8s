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
