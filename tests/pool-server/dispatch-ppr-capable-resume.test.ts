// Shell-less PPR template resume — spec rev 4 "Option D"
// (docs/superpowers/specs/2026-07-26-ppr-resume-shell-less-templates.md).
//
// The class: routes in `pprCapableRoutes` with `rootParams: []` run MINIMAL (correctly — the
// fallback-shells `without-io` flavour must stay minimal), but when such a render POSTPONES,
// Next writes only the shell + `x-nextjs-postponed: 1` and expects the PLATFORM to finish.
// Upstream defines the two facts that killed the earlier attempts (measured + code-read):
//   • `onCacheEntryV2` returning false under minimal mode ALWAYS yields the truncated shell
//     (app-page.ts:1979 short-circuits on isMinimalMode; the inline resume at :2038 is
//     unreachable) — so "capture and let the response complete" cannot work;
//   • merely registering the callback globally flips supportsDynamicResponse for every
//     minimal HTML render (app-page.ts:554-567) — the ~30-test regression. The callback must
//     therefore be passed ONLY for this eligible route class.
// The working platform half (proven in the App Hosting ext_proc PoC, serve.ts): capture the
// postponed state from the live render, then fire Next's canonical resume — POST, same URL,
// `next-resume: 1`, state as the raw body (base-server.ts:1106-1135 / app-page.ts:384-406,
// gated on header+method, NOT on minimal mode) — and append the resumed stream after the
// shell. Runtime discrimination replaces the build-time signal rev 3 proved does not exist:
// a render that does not postpone is never touched.
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

function handlerLoaderFor(pathname: string, handler: NodeHandler, type = "APP_PAGE") {
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
    matchedPathname: "/novel/early-span",
    routeMatches: null,
    resolvedHeaders: undefined,
    ...overrides,
  } as ResolveResult;
}

interface SeenInvocation {
  method: string | undefined;
  nextResume: string | undefined;
  matchedPath: string | undefined;
  body: string;
  hadCaptureCallback: boolean;
}

/**
 * A fake generated entrypoint for a postponing PARTIALLY_STATIC route:
 *  - first (render) invocation: hands the completed cache entry (carrying `postponed`) to
 *    `requestMeta.onCacheEntryV2` exactly like app-page.ts:1770-1791, then writes the shell
 *    with `x-nextjs-postponed: 1` — the truncated minimal-mode output;
 *  - a canonical resume invocation (POST + next-resume: 1): reads the state from the body and
 *    streams the resumed tail.
 */
function postponingHandler(seen: SeenInvocation[], opts: { resumeStatus?: number } = {}) {
  const handler: NodeHandler = async (req, res, ctx) => {
    const record: SeenInvocation = {
      method: req.method,
      nextResume: req.headers["next-resume"] as string | undefined,
      matchedPath: req.headers["x-matched-path"] as string | undefined,
      body: "",
      hadCaptureCallback: typeof ctx?.requestMeta?.onCacheEntryV2 === "function",
    };
    if (typeof (req as any).on === "function" && req.method === "POST") {
      record.body = await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString()));
        req.on("error", () => resolve(""));
      });
    }
    seen.push(record);

    if (record.nextResume === "1" && record.method === "POST") {
      res.writeHead(opts.resumeStatus ?? 200, { "content-type": "text/html" });
      res.end("<resumed-tail>");
      return;
    }
    // Render invocation: report the entry to the platform, then emit the truncated shell.
    await ctx?.requestMeta?.onCacheEntryV2?.(
      { value: { kind: "APP_PAGE", postponed: "PPR-STATE-TOKEN", html: "<shell>" } },
      { url: "https://app.example.com/novel/early-span" },
    );
    res.writeHead(200, {
      "content-type": "text/html",
      "x-nextjs-postponed": "1",
      "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
    });
    res.end("<shell>");
  };
  return handler;
}

const ELIGIBLE = { "/novel/early-span": { rootParams: [] as string[] } };

function makeDispatcher(handler: NodeHandler, options: Record<string, unknown> = {}) {
  return createDispatcher({
    handlerLoader: handlerLoaderFor("/novel/early-span", handler),
    poolName: "ssr",
    buildId: "test123",
    staticAssets: [],
    pprCapableRoutes: ELIGIBLE,
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shell-less PPR capable route: live postpone → canonical resume → appended tail", () => {
  it("completes a postponed document by POSTing the captured state back with next-resume and appending the tail", async () => {
    const seen: SeenInvocation[] = [];
    const dispatcher = makeDispatcher(postponingHandler(seen));
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span"), res, routeResolution());

    expect(seen).toHaveLength(2);
    expect(seen[0]!.hadCaptureCallback).toBe(true);
    expect(seen[1]!.method).toBe("POST");
    expect(seen[1]!.nextResume).toBe("1");
    expect(seen[1]!.body).toBe("PPR-STATE-TOKEN");
    expect(res._status).toBe(200);
    expect(res._body).toBe("<shell><resumed-tail>");
  });

  it("leaves a render that does NOT postpone completely alone (the without-io flavour)", async () => {
    const seen: SeenInvocation[] = [];
    const plainDynamic: NodeHandler = (req, res, ctx) => {
      seen.push({
        method: req.method,
        nextResume: req.headers["next-resume"] as string | undefined,
        matchedPath: undefined,
        body: "",
        hadCaptureCallback: typeof ctx?.requestMeta?.onCacheEntryV2 === "function",
      });
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<complete-dynamic-document>");
    };
    const dispatcher = makeDispatcher(plainDynamic);
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span"), res, routeResolution());

    expect(seen).toHaveLength(1);
    expect(res._body).toBe("<complete-dynamic-document>");
  });

  it("never resumes a route OUTSIDE the eligible class, even when it emits the postpone header", async () => {
    // A non-PPR APP_PAGE can emit x-nextjs-postponed (dispatch-streaming pins one); it must
    // not be resumed. NOTE the inert `onCacheEntryV2: async () => false` stub that dispatch
    // passes to EVERY invocation today stays exactly as-is for ineligible routes — its
    // presence is part of the measured 3,370-green baseline (app-page.ts:554-567 reads the
    // callback's existence), so eligibility must only ever swap the stub's BODY, never add or
    // remove the callback.
    const seen: SeenInvocation[] = [];
    const dispatcher = makeDispatcher(postponingHandler(seen), { pprCapableRoutes: {} });
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span"), res, routeResolution());

    expect(seen).toHaveLength(1);
    expect(res._body).toBe("<shell>");
  });

  it("never resumes a root-params template (those run non-minimal already)", async () => {
    const seen: SeenInvocation[] = [];
    const dispatcher = makeDispatcher(postponingHandler(seen), {
      pprCapableRoutes: { "/novel/early-span": { rootParams: ["lang"] } },
    });
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span"), res, routeResolution());

    expect(seen).toHaveLength(1);
    expect(res._body).toBe("<shell>");
  });

  it("resumes RSC requests too — a truncated Flight payload is the same bug (spec test plan #3)", async () => {
    const seen: SeenInvocation[] = [];
    const dispatcher = makeDispatcher(postponingHandler(seen), {
      rscConfig: { header: "rsc", suffix: ".rsc" },
    });
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span", { rsc: "1" }), res, routeResolution());

    expect(seen).toHaveLength(2);
    expect(seen[1]!.nextResume).toBe("1");
    expect(res._body).toBe("<shell><resumed-tail>");
  });

  it("serves the shell alone when the resume invocation fails — never the error body", async () => {
    const seen: SeenInvocation[] = [];
    const dispatcher = makeDispatcher(postponingHandler(seen, { resumeStatus: 500 }));
    const res = mockRes();
    await dispatcher.dispatch(mockReq("/novel/early-span"), res, routeResolution());

    expect(seen).toHaveLength(2);
    expect(res._status).toBe(200);
    expect(res._body).toBe("<shell>");
  });
});
