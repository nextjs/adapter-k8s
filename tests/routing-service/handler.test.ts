import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRequestHandler } from "../../src/routing-service/handler.js";
import { mockRouting } from "../helpers/mock-outputs.js";
import type { RoutingManifest } from "../../src/types.js";
import type { HeaderValue } from "../../src/routing-service/ext-proc-types.js";

vi.mock("@next/routing", () => ({
  resolveRoutes: vi.fn(),
  responseToMiddlewareResult: vi.fn(),
}));

import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";

function makeManifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  const routing = mockRouting();
  return {
    routeGraph: {
      beforeMiddleware: routing.beforeMiddleware,
      beforeFiles: routing.beforeFiles,
      afterFiles: routing.afterFiles,
      dynamicRoutes: routing.dynamicRoutes,
      onMatch: routing.onMatch,
      fallback: routing.fallback,
      shouldNormalizeNextData: routing.shouldNormalizeNextData,
      rsc: routing.rsc,
    },
    pathnames: ["/", "/about", "/api/hello"],
    i18n: null,
    buildId: "test123",
    basePath: "",
    middleware: null,
    poolAssignments: { "/": "ssr", "/about": "ssr", "/api/hello": "api" },
    pprRoutes: {},
    nextVersion: "16.2.0",
    ...overrides,
  };
}

function makeHeaders(path: string): HeaderValue[] {
  return [
    { key: ":path", value: path },
    { key: ":method", value: "GET" },
    { key: ":scheme", value: "https" },
    { key: ":authority", value: "app.example.com" },
    { key: "host", value: "app.example.com" },
  ];
}

describe("createRequestHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns header mutations for a normal route", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders("/about"));
    expect(response.requestHeaders).toBeDefined();
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const poolHeader = setHeaders.find((h) => h.header.key === "x-upstream-pool");
    expect(poolHeader!.header.value).toBe("ssr");
    const matchedHeader = setHeaders.find((h) => h.header.key === "x-matched-pathname");
    expect(matchedHeader!.header.value).toBe("/about");
  });

  it("returns immediate response for redirect", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      redirect: { url: new URL("https://app.example.com/new"), status: 301 },
    } as any);

    const response = await handler(makeHeaders("/old"));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(301);
  });

  it("emits a redirect when middleware sets a Location via resolvedHeaders + redirect status", async () => {
    // Middleware/afterFiles redirects surface as a Location in resolvedHeaders plus a
    // redirect status — NOT as resolution.redirect. Must become an immediate response,
    // not leak Location through as a request-header mutation (which would serve the page 200).
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "https://app.example.com/login" }),
      status: 307,
    } as any);

    const response = await handler(makeHeaders("/protected"));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(307);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    const loc = setHeaders.find((h) => h.header.key === "location");
    expect(loc!.header.value).toBe("https://app.example.com/login");
    // And it must NOT fall through to the normal dispatch path.
    expect(response.requestHeaders).toBeUndefined();
  });

  it("resolves a relative middleware redirect Location against the request URL", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "/login" }),
      status: 308,
    } as any);

    const response = await handler(makeHeaders("/protected"));
    expect(response.immediateResponse!.status!.code).toBe(308);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    const loc = setHeaders.find((h) => h.header.key === "location");
    expect(loc!.header.value).toBe("https://app.example.com/login");
  });

  it("returns 502 for external rewrites", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      externalRewrite: new URL("https://external.com/api"),
    } as any);

    const response = await handler(makeHeaders("/proxy"));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(502);
    expect(response.immediateResponse!.body).toContain("External rewrites");
  });

  it("sets x-nextjs-ppr header for PPR routes", async () => {
    const manifest = makeManifest({
      pprRoutes: {
        "/dashboard": { postponedState: "abc", fallbackFilePath: "/dist/dashboard.html" },
      },
      poolAssignments: { "/dashboard": "ssr" },
      pathnames: ["/dashboard"],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/dashboard",
      invocationTarget: { pathname: "/dashboard", query: {} },
    } as any);

    const response = await handler(makeHeaders("/dashboard"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const pprHeader = setHeaders.find((h) => h.header.key === "x-nextjs-ppr");
    expect(pprHeader).toBeDefined();
    expect(pprHeader!.header.value).toBe("1");
  });
});

describe("createRequestHandler middleware invocation (Fix A)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("invokes a web-adapter-shaped middleware with { handler, request, page } (not the wrong { request } shape)", async () => {
    // Web-adapter module: default is the adapter fn, `middleware` is the handler fn.
    const adapterFn = vi.fn().mockResolvedValue({ response: new Response("ok") });
    const handlerFn = vi.fn();
    const middlewareModule = { default: adapterFn, middleware: handlerFn };

    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about", query: {} },
      } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({} as any);

    const handler = createRequestHandler(makeManifest(), middlewareModule);
    await handler(makeHeaders("/about"));

    // Web-adapter path must be taken: adapter called with handler + page, not { request } only.
    expect(adapterFn).toHaveBeenCalledTimes(1);
    const arg = adapterFn.mock.calls[0]![0] as any;
    expect(arg.handler).toBe(handlerFn);
    expect(arg.page).toBe("middleware");
    expect(arg.request).toBeDefined();
    expect(arg.request.url).toContain("/about");
    // Because path 1 produced a Response, the direct-handler fallback (path 3) must not run.
    expect(handlerFn).not.toHaveBeenCalled();
  });
});

describe("createRequestHandler method gate backstop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeHeadersMethod(path: string, method: string): HeaderValue[] {
    return [
      { key: ":path", value: path },
      { key: ":method", value: method },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "app.example.com" },
      { key: "host", value: "app.example.com" },
    ];
  }

  it("strips internal dispatch headers on a non-GET/HEAD request when middleware exists (no resolveRoutes, no secret)", async () => {
    const middlewareModule = { default: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule as any);

    const response = await handler(makeHeadersMethod("/api/submit", "POST"));

    // resolveRoutes must not run — the pool re-resolves Phase-1 with the real body.
    expect(vi.mocked(resolveRoutes)).not.toHaveBeenCalled();
    expect(response.requestHeaders).toBeDefined();
    expect(response.requestHeaders!.response!.status).toBe("CONTINUE");
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders ?? [];
    // No dispatch headers set → pool falls to Phase 1.
    expect(setHeaders.find((h) => h.header.key === "x-output-id")).toBeUndefined();
    expect(setHeaders.find((h) => h.header.key === "x-upstream-pool")).toBeUndefined();
    expect(setHeaders.find((h) => h.header.key === "x-internal-secret")).toBeUndefined();
    // ...and any client-spoofed dispatch headers are actively removed so they can't reach the pool.
    const removeHeaders = response.requestHeaders!.response!.headerMutation!.removeHeaders ?? [];
    expect(removeHeaders).toContain("x-output-id");
    expect(removeHeaders).toContain("x-upstream-pool");
    expect(removeHeaders).toContain("x-route-matches");
    expect(removeHeaders).toContain("x-nextjs-ppr");
    expect(removeHeaders).toContain("x-resolved-headers");
    expect(removeHeaders).toContain("x-internal-secret");
  });

  it("still resolves a non-GET/HEAD request at the edge when there is NO middleware", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/api/data",
      invocationTarget: { pathname: "/api/data", query: {} },
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeadersMethod("/api/data", "POST"));

    expect(vi.mocked(resolveRoutes)).toHaveBeenCalledTimes(1);
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-output-id")).toBeDefined();
  });

  it("evaluates GET requests with middleware normally (gate does not fire)", async () => {
    const middlewareModule = { default: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule as any);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      resolvedHeaders: undefined,
    } as any);

    await handler(makeHeadersMethod("/about", "GET"));
    expect(vi.mocked(resolveRoutes)).toHaveBeenCalledTimes(1);
  });
});

describe("createRequestHandler internal-header hygiene & forwarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_HEADER_SECRET;
  });

  it("removes conditional dispatch headers it did not set (no route matches, no PPR)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    // These weren't produced by this resolution, so a client-spoofed value must be removed.
    expect(mutation.removeHeaders).toContain("x-route-matches");
    expect(mutation.removeHeaders).toContain("x-nextjs-ppr");
    expect(mutation.removeHeaders).toContain("x-resolved-headers");
    // ...but the ones it DID set are not in removeHeaders.
    expect(mutation.removeHeaders).not.toContain("x-output-id");
    expect(mutation.removeHeaders).not.toContain("x-upstream-pool");
  });

  it("serializes next.config/middleware response headers into x-resolved-headers (not individual request mutations)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    const resolvedHeaders = new Headers();
    resolvedHeaders.set("content-security-policy", "default-src 'self'");
    resolvedHeaders.append("set-cookie", "a=1; Path=/");
    resolvedHeaders.append("set-cookie", "b=2; Path=/");
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      resolvedHeaders,
    } as any);

    const response = await handler(makeHeaders("/about"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    // The CSP header must NOT leak into the upstream request under its real name.
    expect(setHeaders.find((h) => h.header.key === "content-security-policy")).toBeUndefined();
    const serialized = setHeaders.find((h) => h.header.key === "x-resolved-headers");
    expect(serialized).toBeDefined();
    const parsed = JSON.parse(serialized!.header.value!);
    expect(parsed["content-security-policy"]).toBe("default-src 'self'");
    // Repeated Set-Cookie survives as an array.
    expect(parsed["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("adds the internal secret when INTERNAL_HEADER_SECRET is set", async () => {
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const secret = mutation.setHeaders!.find((h) => h.header.key === "x-internal-secret");
    expect(secret!.header.value).toBe("s3cr3t");
    expect(mutation.removeHeaders).not.toContain("x-internal-secret");
  });

  it("removes x-internal-secret when none is configured (client cannot spoof it)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    expect(mutation.setHeaders!.find((h) => h.header.key === "x-internal-secret")).toBeUndefined();
    expect(mutation.removeHeaders).toContain("x-internal-secret");
  });

  it("maps an RSC request to the .rsc output variant in x-output-id", async () => {
    const manifest = makeManifest({
      poolAssignments: { "/about": "ssr", "/about.rsc": "ssr" },
      pathnames: ["/about"],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const headers: HeaderValue[] = [
      { key: ":path", value: "/about" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "app.example.com" },
      { key: "host", value: "app.example.com" },
      { key: "rsc", value: "1" },
    ];
    const response = await handler(headers);
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-output-id")!.header.value).toBe("/about.rsc");
    expect(setHeaders.find((h) => h.header.key === "x-matched-pathname")!.header.value).toBe(
      "/about.rsc",
    );
    // Pool is still looked up on the base pathname (same pool as the page).
    expect(setHeaders.find((h) => h.header.key === "x-upstream-pool")!.header.value).toBe("ssr");
  });
});

describe("createRequestHandler pool lookup (Fix B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("strips the i18n locale prefix when selecting a pool", async () => {
    const manifest = makeManifest({
      i18n: { locales: ["en", "fr"], defaultLocale: "en" } as any,
      poolAssignments: { "/about": "content" },
      pathnames: ["/about"],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/en/about",
      invocationTarget: { pathname: "/en/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/en/about"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const poolHeader = setHeaders.find((h) => h.header.key === "x-upstream-pool");
    expect(poolHeader!.header.value).toBe("content");
  });

  it("matches a pool via trailing-slash normalization", async () => {
    const manifest = makeManifest({
      poolAssignments: { "/about": "content" },
      pathnames: ["/about"],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about/",
      invocationTarget: { pathname: "/about/", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about/"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const poolHeader = setHeaders.find((h) => h.header.key === "x-upstream-pool");
    expect(poolHeader!.header.value).toBe("content");
  });
});

describe("createRequestHandler middleware Set-Cookie passthrough (Fix C)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards multiple Set-Cookie headers from a middleware immediate response", async () => {
    const mwHeaders = new Headers();
    mwHeaders.append("set-cookie", "a=1; Path=/");
    mwHeaders.append("set-cookie", "b=2; Path=/");
    const mwResponse = new Response("body", { status: 200, headers: mwHeaders });

    const middlewareModule = {
      default: vi.fn().mockResolvedValue({ response: mwResponse }),
    };

    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return { middlewareResponded: true } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({} as any);

    const handler = createRequestHandler(makeManifest(), middlewareModule);
    const response = await handler(makeHeaders("/about"));

    expect(response.immediateResponse).toBeDefined();
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    const cookies = setHeaders
      .filter((h) => h.header.key === "set-cookie")
      .map((h) => h.header.value);
    expect(cookies).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});
