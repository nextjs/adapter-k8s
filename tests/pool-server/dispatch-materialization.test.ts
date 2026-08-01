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

const route = { kind: "route", pool: "ssr", matchedPathname: "/ppr-page", routeMatches: null } as any;

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
              headers: {},
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
