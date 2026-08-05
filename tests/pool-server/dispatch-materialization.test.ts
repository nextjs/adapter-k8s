// The PPR materialization layer: the platform (dispatch) reads its cache entries through the
// Valkey-backed classic handler and REGENERATES them through the canonical revalidation
// request, because the generated entrypoints cache nothing on a plain dynamic render.
//
// Measured chain (k3d, resume-data-cache / partial-fallback-shell-upgrade /
// sub-shell-generation-middleware): after a tag revalidation the document correctly fell to
// a live render, but nothing ever wrote a REGENERATED entry — Valkey held no APP_PAGE entry
// at all — so segment prefetches kept serving the build artifact forever and no MISS→HIT
// transition could exist. `next start` regenerates through its response-cache background
// revalidation; the platform equivalent is a minimal-mode GET with
// `x-prerender-revalidate: <previewModeId>` whose COMPLETED entry arrives at onCacheEntryV2
// (the documented callback the pool already registers) and is then written back through the
// platform cache.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../../src/pool-server/dispatch.js";
import type { IncomingMessage, ServerResponse } from "node:http";

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
    _ended: false,
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string | string[]) {
      res._headers[key.toLowerCase()] = value;
      return res;
    },
    getHeaderNames() {
      return Object.keys(res._headers);
    },
    removeHeader(key: string) {
      delete res._headers[key.toLowerCase()];
    },
    write(chunk: Buffer | string) {
      res._body += chunk.toString();
      return true;
    },
    end(body?: Buffer | string) {
      if (body) res._body += body.toString();
      res._ended = true;
    },
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

function handlerLoaderFor(pathname: string) {
  return {
    load: vi.fn().mockResolvedValue({}),
    has: vi.fn((p: string) => p === pathname),
    get: vi.fn().mockReturnValue({ runtime: "nodejs", type: "APP_PAGE", filePath: "x.js" }),
  } as any;
}

const dir = mkdtempSync(path.join(os.tmpdir(), "ppr-mat-"));
const shellFile = path.join(dir, "shell.html");
writeFileSync(shellFile, "<html>build shell</html>");

const pprRoutes = {
  "/ppr-page": { postponedState: "build-token", fallbackFilePath: shellFile },
};

function baseOptions(over: Record<string, unknown> = {}) {
  return {
    handlerLoader: handlerLoaderFor("/ppr-page"),
    poolName: "ssr",
    buildId: "b1",
    staticAssets: [],
    pprRoutes,
    incrementalCacheShared: true,
    ...over,
  } as any;
}

const route = {
  kind: "route",
  pool: "ssr",
  matchedPathname: "/ppr-page",
  routeMatches: null,
} as any;

describe("PPR serve ladder reads the platform cache", () => {
  it("serves a materialized POSTPONED entry's html and injects ITS postponed token", async () => {
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>regenerated shell</html>",
              postponed: "fresh-token",
              headers: {},
              status: 200,
            },
          }),
          write: async () => {},
        },
      }),
    );
    const req = mockReq("/ppr-page");
    await dispatcher.dispatch(req, mockRes(), route);
    expect(calls).toHaveLength(1);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).toBe("fresh-token");
    expect(calls[0].responsePrefix?.content?.toString()).toContain("regenerated shell");
    expect(calls[0].minimalMode).toBe(true);
  });

  it("serves a materialized COMPLETE entry outright without invoking the handler", async () => {
    const invoker = vi.fn();
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: invoker as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>complete page</html>",
              headers: { "x-custom": "1" },
              status: 200,
            },
          }),
          write: async () => {},
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/ppr-page"), res, route);
    expect(invoker).not.toHaveBeenCalled();
    expect(res._body).toContain("complete page");
    expect(res._status).toBe(200);
  });

  it("strips internal cache headers when serving a COMPLETE entry directly", async () => {
    // The normal loopback path deletes x-next-cache-tags before the public response
    // (it exposes route/tag structure; `next start` never forwards it). The stored-entry
    // direct serve bypasses that path, so it must sanitize on its own.
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: vi.fn() as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>complete page</html>",
              headers: { "x-next-cache-tags": "_N_T_/layout,_N_T_/ppr-page", "x-custom": "1" },
              status: 200,
            },
          }),
          write: async () => {},
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/ppr-page"), res, route);
    expect(res._body).toContain("complete page");
    expect(res._headers["x-next-cache-tags"]).toBeUndefined();
    expect(res._headers["x-custom"]).toBe("1");
  });

  it("uses the STORED entry's headers and status for the injected shell prefix, not the build's", async () => {
    // A materialized entry carries the regeneration's headers/status; the build-time
    // initialHeaders/initialStatus belong to the disk shell only.
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {
          "/ppr-page": {
            postponedState: "build-token",
            fallbackFilePath: shellFile,
            initialHeaders: { "x-build-era": "old" },
            initialStatus: 200,
          },
        },
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>regenerated shell</html>",
              postponed: "fresh-token",
              headers: { "x-entry-era": "new", "x-next-cache-tags": "_N_T_/x" },
              status: 203,
            },
          }),
          write: async () => {},
        },
      }),
    );
    await dispatcher.dispatch(mockReq("/ppr-page"), mockRes(), route);
    expect(calls).toHaveLength(1);
    const prefix = calls[0].responsePrefix;
    expect(prefix?.content?.toString()).toContain("regenerated shell");
    expect(prefix?.headers?.["x-entry-era"]).toBe("new");
    expect(prefix?.headers?.["x-build-era"]).toBeUndefined();
    expect(prefix?.headers?.["x-next-cache-tags"]).toBeUndefined();
    expect(prefix?.status).toBe(203);
  });

  it("runs a DYNAMIC RSC request non-minimal WITHOUT injecting the postponed token", async () => {
    // A dynamic RSC request (rsc: 1, not a prefetch) resolved with minimal+inject returns
    // only the RESUME TAIL — but the values the client needs live in the STATIC part
    // (resume-data-cache: seed-era dynamic RSC lacked the shell's number, measured on a
    // virgin keyspace). next start runs these NON-minimal: the entrypoint itself does
    // incrementalCache.get(resolvedPathname) and threads entry.postponed's RDC into the
    // full dynamic render (app-page-runtime.ts:1352-1391) — self-contained given the
    // shared handler, no injection wanted.
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>seed shell</html>",
              postponed: "seed-token",
              headers: {},
              status: 200,
            },
          }),
          readStored: async () => null,
        },
      }),
    );
    const req = mockReq("/ppr-page", { rsc: "1" });
    await dispatcher.dispatch(req, mockRes(), route);
    expect(calls).toHaveLength(1);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).toBeUndefined();
    expect(calls[0].minimalMode).toBe(false);
  });

  it("strips the rsc-variant suffix from the INVOCATION PATH for a dynamic RSC request", async () => {
    // The rsc-negotiation rewrite resolves a dynamic RSC request to the `.rsc` OUTPUT id
    // (matched "/index.rsc"), and the invoker turns invocationPath into
    // requestMeta.resolvedPathname. The entrypoint's RDC branch then does
    // incrementalCache.get(resolvedPathname) and prerenderManifest.routes[resolvedPathname]
    // (app-page-runtime.ts:1373) — both keyed by the PAGE path ("/"), so handing it
    // "/index.rsc" misses everything and the render loses the RDC (measured: rdc stayed
    // 3/5 under the exclusion alone).
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        handlerLoader: handlerLoaderFor("/ppr-page"),
        pprRoutes,
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        rscConfig: { header: "rsc", suffix: ".rsc" },
        platformCache: { read: async () => null, readStored: async () => null },
      }),
    );
    const req = mockReq("/ppr-page", { rsc: "1" });
    await dispatcher.dispatch(req, mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/ppr-page.rsc",
      invokePath: "/ppr-page.rsc",
      routeMatches: null,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].invocationPath).toBe("/ppr-page");
    expect(calls[0].minimalMode).toBe(false);
  });

  it("keeps minimal+inject for a full-page PREFETCH RSC request", async () => {
    // Prefetch flights are the static shell — injection is exactly right for them.
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>seed shell</html>",
              postponed: "seed-token",
              headers: {},
              status: 200,
            },
          }),
          readStored: async () => null,
        },
      }),
    );
    const req = mockReq("/ppr-page", { rsc: "1", "next-router-prefetch": "1" });
    await dispatcher.dispatch(req, mockRes(), route);
    expect(calls).toHaveLength(1);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).toBe("seed-token");
    expect(calls[0].minimalMode).toBe(true);
  });

  it("serves a segment prefetch from the entry's segmentData", async () => {
    const invoker = vi.fn();
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: invoker as any,
        platformCache: {
          read: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>x</html>",
              postponed: "tok",
              headers: {},
              status: 200,
              segmentData: new Map([["/__PAGE__", Buffer.from("segment-flight-bytes")]]),
            },
          }),
          write: async () => {},
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(
      mockReq("/ppr-page", {
        rsc: "1",
        "next-router-prefetch": "1",
        "next-router-segment-prefetch": "/__PAGE__",
      }),
      res,
      route,
    );
    expect(invoker).not.toHaveBeenCalled();
    expect(res._body).toBe("segment-flight-bytes");
    expect(res._status).toBe(200);
  });

  it("derives the concrete read key from the REWRITE destination, not the public URL", async () => {
    // Next keys cache writes by the resolved invocation pathname (requestMeta.resolvedPathname
    // = the rewrite destination). Reading by the public URL means `/alias -> /posts/1` writes
    // under /posts/1 but reads under /alias: permanent misses + duplicate regenerations.
    const keys: string[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {
          "/posts/[id]": { postponedState: "build-token", fallbackFilePath: shellFile },
        },
        handlerLoader: handlerLoaderFor("/posts/[id]"),
        localHandlerInvoker: (async () => {}) as any,
        platformCache: {
          read: async (key: string) => {
            keys.push(`read:${key}`);
            return null;
          },
          readStored: async (key: string) => {
            keys.push(`stored:${key}`);
            if (key !== "/posts/1") return null;
            return {
              lastModified: Date.now(),
              value: {
                kind: "APP_PAGE",
                html: "<html>materialized post 1</html>",
                headers: {},
                status: 200,
              },
            };
          },
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/alias"), res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/posts/[id]",
      invokePath: "/posts/1",
      routeMatches: { id: "1" },
    } as any);
    expect(keys).toContain("stored:/posts/1");
    expect(res._body).toContain("materialized post 1");
  });

  it("never serves a STORED entry from the TEMPLATE key (sibling-sharing guard)", async () => {
    // Stored entries are written under concrete request paths; the template key exists only
    // for route-keyed fallback SHELLS in the build seed. A stored entry under the template
    // (however it got there) served to every sibling path is exactly the cross-request
    // poisoning the concrete-key fix eliminated (/es/2 receiving /es/1's layout).
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {
          "/posts/[id]": { postponedState: "build-token", fallbackFilePath: shellFile },
        },
        handlerLoader: handlerLoaderFor("/posts/[id]"),
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async () => null,
          readStored: async (key: string) =>
            key === "/posts/[id]"
              ? {
                  lastModified: Date.now(),
                  value: {
                    kind: "APP_PAGE",
                    html: "<html>poisoned sibling</html>",
                    postponed: "poisoned-token",
                    headers: {},
                    status: 200,
                  },
                }
              : null,
        },
      }),
    );
    const req = mockReq("/posts/2");
    const res = mockRes();
    await dispatcher.dispatch(req, res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/posts/[id]",
      invokePath: "/posts/2",
      routeMatches: { id: "2" },
    } as any);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).not.toBe("poisoned-token");
    expect(res._body ?? "").not.toContain("poisoned sibling");
  });

  it("reads the TEMPLATE key seed-only (readSeed) for route-keyed fallback shells", async () => {
    // The template rung exists for fs-mirror fallback shells. It must go through the
    // seed-only read — read() is stored-first and would reintroduce template-stored serving.
    const keys: string[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {
          "/posts/[id]": { postponedState: "build-token", fallbackFilePath: shellFile },
        },
        handlerLoader: handlerLoaderFor("/posts/[id]"),
        localHandlerInvoker: (async () => {}) as any,
        platformCache: {
          read: async (key: string) => {
            keys.push(`read:${key}`);
            return null;
          },
          readStored: async (key: string) => {
            keys.push(`stored:${key}`);
            return null;
          },
          readSeed: async (key: string) => {
            keys.push(`seed:${key}`);
            return null;
          },
        },
      }),
    );
    await dispatcher.dispatch(mockReq("/posts/2"), mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/posts/[id]",
      invokePath: "/posts/2",
      routeMatches: { id: "2" },
    } as any);
    expect(keys).toContain("seed:/posts/[id]");
    expect(keys).not.toContain("stored:/posts/[id]");
    expect(keys).not.toContain("read:/posts/[id]");
  });

  it("serves the Pages fallback SKELETON (not a blocking render) in production", async () => {
    // fallback-route-params: `getStaticPaths { paths: [], fallback: true }`. next start
    // serves the build skeleton (query {} in __NEXT_DATA__, router.isFallback) and lets the
    // client's data fetch materialize the page. Our production path blocking-rendered with
    // resolved params instead — the skeleton assertions got `{slug:"first"}`.
    const invoker = vi.fn();
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {},
        staticAssets: [
          {
            pathname: "/[slug]",
            filePath: shellFile,
            prerender: true,
            cacheControl: "public, max-age=0, must-revalidate",
          },
        ],
        handlerLoader: handlerLoaderFor("/[slug]"),
        localHandlerInvoker: invoker as any,
        platformCache: {
          read: async () => null,
          readStored: async () => null,
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/first"), res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/[slug]",
      routeMatches: { slug: "first" },
    } as any);
    expect(invoker).not.toHaveBeenCalled();
    expect(res._body).toContain("build shell");
  });

  it("serves the MATERIALIZED page over the Pages fallback skeleton once it exists", async () => {
    // After the data fetch materializes the concrete entry, documents must serve it —
    // otherwise the skeleton would be served forever.
    const invoker = vi.fn();
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {},
        staticAssets: [
          {
            pathname: "/[slug]",
            filePath: shellFile,
            prerender: true,
            cacheControl: "public, max-age=0, must-revalidate",
          },
        ],
        handlerLoader: handlerLoaderFor("/[slug]"),
        localHandlerInvoker: invoker as any,
        platformCache: {
          read: async () => null,
          readStored: async (key: string) =>
            key === "/first"
              ? {
                  lastModified: Date.now(),
                  value: {
                    kind: "PAGES",
                    html: "<html>materialized first</html>",
                    pageData: {},
                    headers: { "x-next-cache-tags": "strip-me" },
                    status: 200,
                  },
                }
              : null,
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/first"), res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/[slug]",
      routeMatches: { slug: "first" },
    } as any);
    expect(invoker).not.toHaveBeenCalled();
    expect(res._body).toContain("materialized first");
    expect(res._headers["x-next-cache-tags"]).toBeUndefined();
  });

  it("serves a STORED (revalidated) entry in preference to the build seed for a non-PPR prerender", async () => {
    // revalidate-reason: res.revalidate() renders with reason 'on-demand' and persists the
    // fresh entry through the registered handler — but the concrete-seed rung kept serving
    // the BUILD artifact (whose build render had no reason at all). A stored entry written
    // after deploy supersedes the seed; the seed remains the cold-start answer only.
    const invoker = vi.fn();
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {},
        staticAssets: [
          {
            pathname: "/isr-page",
            filePath: shellFile,
            prerender: true,
            cacheControl: "public, max-age=0, must-revalidate",
            revalidate: 60,
          },
        ],
        localHandlerInvoker: invoker as any,
        handlerLoader: handlerLoaderFor("/isr-page"),
        platformCache: {
          read: async () => null,
          readStored: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "PAGES",
              html: "<html>revalidated content</html>",
              pageData: {},
              headers: { "x-next-cache-tags": "_N_T_/isr-page" },
              status: 200,
            },
          }),
          write: async () => {},
        },
      }),
    );
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/isr-page"), res, {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/isr-page",
      routeMatches: null,
    } as any);
    expect(invoker).not.toHaveBeenCalled();
    expect(res._body).toContain("revalidated content");
    expect(res._status).toBe(200);
    // The direct serve bypasses the loopback pipe's stripping — it must sanitize itself.
    expect(res._headers["x-next-cache-tags"]).toBeUndefined();
  });

  it("serves a STORED regenerated entry when the build seed is tag-stale (post-revalidation SWR)", async () => {
    // After a revalidation regenerates the entry, a stale-seed request must serve the
    // STORED entry (its html + fresh postponed token) rather than falling to a live render
    // forever — getStored applies the handler's own tag staleness, so a stale stored entry
    // still degrades to the live path.
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        checkShellStale: async () => true,
        pprRoutes: {
          "/ppr-page": {
            postponedState: "build-token",
            fallbackFilePath: shellFile,
            tags: ["t1"],
          },
        },
        platformCache: {
          read: async () => null,
          readStored: async () => ({
            lastModified: Date.now(),
            value: {
              kind: "APP_PAGE",
              html: "<html>regenerated shell</html>",
              postponed: "regen-token",
              headers: {},
              status: 200,
            },
          }),
          write: async () => {},
        },
      }),
    );
    const req = mockReq("/ppr-page");
    await dispatcher.dispatch(req, mockRes(), route);
    expect(calls).toHaveLength(1);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).toBe("regen-token");
    expect(calls[0].minimalMode).toBe(true);
    expect(calls[0].responsePrefix?.content?.toString()).toContain("regenerated shell");
  });

  it("reads the CONCRETE key first, then falls back to the ROUTE-TEMPLATE key", async () => {
    // Route-keyed fallback shells live under the TEMPLATE (`/[lang]/[slug]`) in the
    // fs-mirror seed, while materialized entries are per-URL. Reading only the concrete
    // path missed every template shell and fell back to the generic disk shell — measured
    // as cache-components-prerender-matrix regressing 3/60 -> 13/60 (wrong layout region
    // values). Try concrete first (a materialized entry wins), then the template — which
    // is SEED-only (readSeed): a stored entry under the template would be one sibling's
    // page served to the whole route.
    const seen: string[] = [];
    const calls: any[] = [];
    const dispatcher = createDispatcher(
      baseOptions({
        pprRoutes: {
          "/[lang]/[slug]": { postponedState: "build-token", fallbackFilePath: shellFile },
        },
        handlerLoader: handlerLoaderFor("/[lang]/[slug]"),
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
        }) as any,
        platformCache: {
          read: async (key: string) => {
            seen.push(key);
            return null;
          },
          readStored: async () => null,
          readSeed: async (key: string) => {
            seen.push(key);
            if (key !== "/[lang]/[slug]") return null;
            return {
              lastModified: Date.now(),
              value: {
                kind: "APP_PAGE",
                html: "<html>template shell</html>",
                postponed: "template-token",
                headers: {},
                status: 200,
              },
            };
          },
        },
      }),
    );
    const req = mockReq("/es/2");
    await dispatcher.dispatch(req, mockRes(), {
      kind: "route",
      pool: "ssr",
      matchedPathname: "/[lang]/[slug]",
      routeMatches: null,
    } as any);
    expect(seen).toEqual(["/es/2", "/[lang]/[slug]"]);
    const meta = (req as any)[Symbol.for("NextInternalRequestMeta")];
    expect(meta?.postponed).toBe("template-token");
  });

  it("serves a STALE stored entry WITHOUT self-regenerating (entrypoint owns PPR regen)", async () => {
    // The x-prerender-revalidate re-entry hard-errors for cache-components routes
    // ("uncached or runtime data during prerendering") and its failed render holds the
    // single-flight lock to TTL — starving the entrypoint's own WORKING revalidation
    // (forceStaticRender). Dispatch serves the stale entry and leaves regeneration to the
    // next non-minimal dynamic-RSC/action request's entrypoint read.
    process.env.__NEXT_PREVIEW_MODE_ID = "pmid-xyz";
    try {
      const revalidations: any[] = [];
      const dispatcher = createDispatcher(
        baseOptions({
          localHandlerInvoker: vi.fn() as any,
          revalidate: (cfg: any) => {
            revalidations.push(cfg);
            return Promise.resolve();
          },
          platformCache: {
            read: async () => null,
            readStored: async () => ({
              lastModified: Date.now() - 120_000,
              isStale: true,
              value: {
                kind: "APP_PAGE",
                html: "<html>stale but served</html>",
                headers: {},
                status: 200,
              },
            }),
          },
        }),
      );
      const res = mockRes();
      await dispatcher.dispatch(mockReq("/ppr-page"), res, route);
      expect(res._body).toContain("stale but served");
      expect(revalidations).toHaveLength(0);
    } finally {
      delete process.env.__NEXT_PREVIEW_MODE_ID;
    }
  });

  it("a DYNAMIC RSC request on a stale shell never self-regenerates (rdc stale-forever)", async () => {
    // Traced live 2026-08-04 (rdc consistency tests): the suite's post-revalidateTag flow
    // is ALL dynamic-RSC, and each request's scheduleRegen() fired an x-prerender-revalidate
    // render that (a) CANNOT succeed for cache-components routes — patch-fetch skips every
    // fetch-cache read under workStore.isOnDemandRevalidate (patch-fetch.ts:1019), so the
    // render live-fetches under the prerender's abort signal and dies with "uncached or
    // runtime data" — and (b) WINS the single-flight revalidate lock first, so the
    // entrypoint's read milliseconds later is told FRESH and its WORKING background
    // revalidation (forceStaticRender, isOnDemandRevalidate=false) never schedules:
    // measured zero "Error revalidating the page in the background" lines while the regen
    // failed 6 times. Dynamic RSC runs non-minimal and the ENTRYPOINT owns regeneration.
    process.env.__NEXT_PREVIEW_MODE_ID = "pmid-xyz";
    try {
      const revalidations: any[] = [];
      const dispatcher = createDispatcher(
        baseOptions({
          localHandlerInvoker: vi.fn() as any,
          checkShellStale: async () => true,
          pprRoutes: {
            "/ppr-page": {
              postponedState: "build-token",
              fallbackFilePath: shellFile,
              tags: ["t1"],
            },
          },
          revalidate: (cfg: any) => {
            revalidations.push(cfg);
            return Promise.resolve();
          },
          platformCache: { read: async () => null, write: async () => {} },
        }),
      );
      await dispatcher.dispatch(mockReq("/ppr-page", { rsc: "1" }), mockRes(), route);
      // Let any wrongly-scheduled regen fire before asserting.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(revalidations).toHaveLength(0);
    } finally {
      delete process.env.__NEXT_PREVIEW_MODE_ID;
    }
  });

  it("on a STALE shell falls to the live render AND schedules ONE regeneration via revalidate()", async () => {
    // The regeneration rides the pool's own res.revalidate() re-entry (N33 boundary):
    // a mocked-request loopback carrying x-prerender-revalidate, which dispatch verifies
    // and runs NON-minimal as an on-demand revalidation — Next itself persists the fresh
    // entry through the registered cache handler, like next start's response cache.
    process.env.__NEXT_PREVIEW_MODE_ID = "pmid-xyz";
    try {
      const calls: any[] = [];
      const revalidations: any[] = [];
      let resolveRegen: () => void;
      const regenerated = new Promise<void>((r) => (resolveRegen = r));
      let releaseRegen: () => void;
      const holdRegen = new Promise<void>((r) => (releaseRegen = r));
      const dispatcher = createDispatcher(
        baseOptions({
          localHandlerInvoker: (async (a: any) => {
            calls.push(a);
          }) as any,
          checkShellStale: async () => true,
          pprRoutes: {
            "/ppr-page": {
              postponedState: "build-token",
              fallbackFilePath: shellFile,
              tags: ["t1"],
            },
          },
          revalidate: (cfg: any) => {
            revalidations.push(cfg);
            resolveRegen();
            // Stay in-flight until released — the dedupe is per-key WHILE pending.
            return holdRegen;
          },
          platformCache: { read: async () => null, write: async () => {} },
        }),
      );
      await dispatcher.dispatch(mockReq("/ppr-page"), mockRes(), route);
      await dispatcher.dispatch(mockReq("/ppr-page"), mockRes(), route);
      await regenerated;

      // Both foreground invocations are the non-minimal live render (unusable shell path).
      expect(calls).toHaveLength(2);
      for (const c of calls) expect(c.minimalMode).toBe(false);

      // Exactly one regeneration, deduped in flight, canonical header shape.
      expect(revalidations).toHaveLength(1);
      expect(revalidations[0].urlPath).toBe("/ppr-page");
      expect(revalidations[0].headers["x-prerender-revalidate"]).toBe("pmid-xyz");
      releaseRegen!();
    } finally {
      delete process.env.__NEXT_PREVIEW_MODE_ID;
    }
  });
});
