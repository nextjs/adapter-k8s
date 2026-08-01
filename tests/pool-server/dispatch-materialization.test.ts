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

  it("on a STALE shell falls to the live render AND schedules ONE canonical regeneration", async () => {
    const calls: any[] = [];
    const written: any[] = [];
    let resolveWrite: () => void;
    const wrote = new Promise<void>((r) => (resolveWrite = r));
    const dispatcher = createDispatcher(
      baseOptions({
        localHandlerInvoker: (async (a: any) => {
          calls.push(a);
          if (a.captureCacheEntry) {
            a.captureCacheEntry({
              value: { kind: "APP_PAGE", html: "<html>fresh</html>", postponed: "p2" },
              cacheControl: { revalidate: 60 },
            });
          }
        }) as any,
        // The shell's baked tag has been revalidated — the injection path must not use it.
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
          write: async (key: string, value: any, ctx: any) => {
            written.push({ key, value, ctx });
            resolveWrite();
          },
          previewModeId: "preview-123",
        },
      }),
    );
    await dispatcher.dispatch(mockReq("/ppr-page"), mockRes(), route);
    await dispatcher.dispatch(mockReq("/ppr-page"), mockRes(), route);
    await wrote;

    // Both foreground invocations are the non-minimal live render (unusable shell path).
    const foreground = calls.filter((c) => !c.discardResponse);
    expect(foreground).toHaveLength(2);
    for (const c of foreground) expect(c.minimalMode).toBe(false);

    // Exactly one background regeneration: minimal, discard, canonical revalidate header.
    const regen = calls.filter((c) => c.discardResponse);
    expect(regen).toHaveLength(1);
    expect(regen[0].minimalMode).toBe(true);
    expect(regen[0].invocationHeaders?.["x-prerender-revalidate"]).toBe("preview-123");

    // The captured entry landed in the platform cache.
    expect(written).toHaveLength(1);
    expect(written[0].key).toBe("/ppr-page");
    expect(written[0].value.postponed).toBe("p2");
    expect(written[0].ctx.cacheControl).toEqual({ revalidate: 60 });
  });
});
