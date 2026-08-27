import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { createRequestHandler } from "../../src/routing-service/handler.js";
import { createProcessHandler, plainResponseToProto } from "../../src/routing-service/server.js";
import {
  ProcessingRequestSchema,
  CommonResponse_ResponseStatus,
  type ProcessingRequest,
  type ProcessingResponse as ProtoProcessingResponse,
} from "../../src/routing-service/protos/envoy/service/ext_proc/v3/external_processor_pb.js";
import { mockRouting } from "../helpers/mock-outputs.js";
import {
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_DISPATCH_PROOF_HEADER,
  INTERNAL_SECRET_HEADER,
  buildProofHeaderNames,
  UNTRUSTED_NEXT_REQUEST_HEADERS,
  verifyDispatchProof,
} from "../../src/routing-common.js";
import type { RoutingManifest } from "../../src/types.js";
import type { HeaderValue } from "../../src/routing-service/ext-proc-types.js";

vi.mock("@next/routing", async (importOriginal) => {
  // routing-common.ts imports the CJS default and destructures detect*; expose a
  // `default` alongside the named exports so both import styles resolve.
  const mocked = {
    ...(await importOriginal<typeof import("@next/routing")>()),
    resolveRoutes: vi.fn(),
    responseToMiddlewareResult: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

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
    builtAt: "2026-01-01T00:00:00.000Z",
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

/**
 * The header set the POOL sees after Envoy applies this response's mutation: the stamped dispatch
 * headers, `Host` written from `:authority`, plus whatever of the client's own request survived
 * (the caller passes any context/matcher headers it put on the wire). This is the shape
 * verifyDispatchProof is handed at the pool's trust boundary, so verifying it here checks the two
 * tiers agree on the whole covered set rather than restating the signing side's own arithmetic.
 */
function poolViewOf(
  mutation: { setHeaders?: { header: { key?: string; value?: string } }[] },
  wireHeaders: Record<string, string> = {},
): Record<string, string> {
  const atPool: Record<string, string> = { host: "app.example.com", ...wireHeaders };
  for (const h of mutation.setHeaders ?? []) {
    if ((INTERNAL_DISPATCH_HEADERS as readonly string[]).includes(h.header.key!)) {
      atPool[h.header.key!] = h.header.value!;
    }
  }
  return atPool;
}

/** This build's covered request-header names, exactly as the pool would derive them. */
const PROOF_NAMES = buildProofHeaderNames(makeManifest());

/** Verify a stamped proof the way the pool's trust boundary does: over the arriving request. */
function verifyAsPool(
  proof: string,
  request: {
    method?: string;
    target: string;
    headers: Record<string, string | undefined>;
    proofHeaderNames?: readonly string[];
  },
  secret = "s3cr3t",
): boolean {
  return verifyDispatchProof(
    secret,
    {
      method: request.method ?? "GET",
      target: request.target,
      headers: request.headers,
      proofHeaderNames: request.proofHeaderNames ?? PROOF_NAMES,
    },
    proof,
  ).trusted;
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

  it("stamps x-mw-evaluated=none when the app has no middleware", async () => {
    // Defense-in-depth: the pool skips its own middleware only on a positive, trusted
    // x-mw-evaluated verdict. With no middleware module, the handler must POSITIVELY assert
    // `none` (not omit it) so the pool can tell "no middleware" apart from "ext_proc broken /
    // absent" — absence is what makes the pool fail safe and re-evaluate.
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders("/about"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const mw = setHeaders.find((h) => h.header.key === "x-mw-evaluated");
    expect(mw).toBeDefined();
    expect(mw!.header.value).toBe("none");
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
    // N15: same-origin Locations are RELATIVIZED so the edge matches both the pool
    // (middlewareRedirectLocation) and `next start`, which reports a relative path.
    expect(loc!.header.value).toBe("/login");
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
    expect(loc!.header.value).toBe("/login");
    // `next start` pairs a 308 with `Refresh: 0;url=<location>` (router-server.ts).
    expect(setHeaders.find((h) => h.header.key === "Refresh")!.header.value).toBe("0;url=/login");
  });

  it("hands an external rewrite to the pool instead of authoring a 502 (N40)", async () => {
    // N40. This tier used to answer 502 ("External rewrites are not supported in adapter-k8s
    // v1"). Phase 1 returns `external-rewrite` and pool-server/dispatch.ts PROXIES it —
    // measured against `next start`, which proxies too (a `/ext-rewrite` →
    // `https://example.com/probe` rewrite returned example.com's own page and
    // `server: cloudflare`). Because the CEL is `!(…)` whenever the app has middleware, the
    // 502 fired in production for a route that worked in the e2e harness. Never author a
    // status the other tier doesn't: CONTINUE with the dispatch vocabulary cleared and NO
    // secret, exactly like the body-request backstop, so the pool re-resolves and owns it.
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      externalRewrite: new URL("https://external.com/api"),
    } as any);

    const response = await handler(makeHeaders("/proxy"));
    expect(response.immediateResponse).toBeUndefined();
    const mutation = response.requestHeaders!.response!.headerMutation!;
    expect(mutation.setHeaders ?? []).toEqual([]);
    // Every internal dispatch header AND the secret must be removed, or a client could
    // smuggle a spoofed x-output-id past the extension on this path.
    expect(new Set(mutation.removeHeaders)).toEqual(
      new Set([
        ...INTERNAL_DISPATCH_HEADERS,
        ...UNTRUSTED_NEXT_REQUEST_HEADERS,
        INTERNAL_SECRET_HEADER,
        INTERNAL_DISPATCH_PROOF_HEADER,
      ]),
    );
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
    let backgroundComplete = false;
    const adapterFn = vi.fn(async ({ request }: any) => {
      request.waitUntil(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            backgroundComplete = true;
            resolve();
          }, 5);
        }),
      );
      return { response: new Response("ok") };
    });
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
    expect(backgroundComplete).toBe(true);
    // Because path 1 produced a Response, the direct-handler fallback (path 3) must not run.
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it("does not mark a middleware module with no callable export as evaluated", async () => {
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

    const handler = createRequestHandler(makeManifest(), {});
    const response = await handler(makeHeaders("/about"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const mw = setHeaders.find((h) => h.header.key === "x-mw-evaluated");

    expect(mw?.header.value).toBe("error");
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

  it("stamps a per-request dispatch PROOF when INTERNAL_HEADER_SECRET is set — never the raw secret", async () => {
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    // The raw secret must NEVER be on the wire (it is actively removed instead)…
    expect(mutation.setHeaders!.find((h) => h.header.key === "x-internal-secret")).toBeUndefined();
    expect(mutation.removeHeaders).toContain("x-internal-secret");
    // …the proof is — and it verifies against the request as the POOL will see it: the same
    // method and target, `Host` carrying what arrived as `:authority`, plus the stamped set.
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof");
    expect(proof).toBeDefined();
    expect(mutation.removeHeaders).not.toContain("x-internal-dispatch-proof");
    expect(
      verifyAsPool(proof!.header.value!, { target: "/about", headers: poolViewOf(mutation) }),
    ).toBe(true);
    // And it is genuinely per-request: another path yields a different proof.
    const other = await handler(makeHeaders("/proxy"));
    const otherProof = other.requestHeaders!.response!.headerMutation!.setHeaders!.find(
      (h) => h.header.key === "x-internal-dispatch-proof",
    );
    expect(otherProof).toBeDefined();
    expect(otherProof!.header.value).not.toBe(proof!.header.value);
  });

  it("the proof rejects a single swapped or edited covered header (no transplant/replay)", async () => {
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof")!
      .header.value!;
    const atPool = poolViewOf(mutation);
    // Swapping the dispatch target…
    expect(
      verifyAsPool(proof, {
        target: "/about",
        headers: { ...atPool, "x-output-id": "/admin" },
      }),
    ).toBe(false);
    // …or replaying the proof onto a different path…
    expect(verifyAsPool(proof, { target: "/admin", headers: atPool })).toBe(false);
    // …or onto a different method…
    expect(verifyAsPool(proof, { method: "POST", target: "/about", headers: atPool })).toBe(false);
    // …or guessing from the wrong secret…
    expect(verifyAsPool(proof, { target: "/about", headers: atPool }, "wrong")).toBe(false);
  });

  it("binds :authority and the scheme witness — a proof for one host/scheme does not verify for another", async () => {
    // REVIEW (PR #61): the first cut of the proof covered only (method, target, dispatch
    // headers), so a verdict resolved for one host — or for the https request — verified for
    // another. The authority is bound directly; the scheme is bound through the pool's only
    // witness of it, `x-forwarded-proto` (TLS terminates at the LB, so the pool's own socket is
    // always plain http).
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler([
      ...makeHeaders("/about"),
      { key: "x-forwarded-proto", value: "https" },
    ] as HeaderValue[]);
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof")!
      .header.value!;
    const atPool = poolViewOf(mutation, { "x-forwarded-proto": "https" });

    // The honest request verifies…
    expect(verifyAsPool(proof, { target: "/about", headers: atPool })).toBe(true);
    // …a different tenant host does not…
    expect(
      verifyAsPool(proof, {
        target: "/about",
        headers: { ...atPool, host: "tenant-b.example.com" },
      }),
    ).toBe(false);
    // …nor the same request with the scheme witness downgraded…
    expect(
      verifyAsPool(proof, {
        target: "/about",
        headers: { ...atPool, "x-forwarded-proto": "http" },
      }),
    ).toBe(false);
    // …nor with it stripped entirely: ABSENT is its own covered value, not "any value".
    const { "x-forwarded-proto": _proto, ...withoutProto } = atPool;
    expect(verifyAsPool(proof, { target: "/about", headers: withoutProto })).toBe(false);
    // Host CASE is normalized, though — both tiers route on the lowercased hostname, so a case
    // flip must not degrade a real deployment to untrusted.
    expect(
      verifyAsPool(proof, { target: "/about", headers: { ...atPool, host: "APP.example.com" } }),
    ).toBe(true);
  });

  it("binds the RSC negotiation headers that choose the dispatched output id", async () => {
    // `resolveRscOutput` reads the RSC header to pick `/about.rsc` over `/about`, and the pool
    // dispatches that output id verbatim. Unbound, the flight request's proof would verify with
    // the RSC header stripped: the pool serves a flight body while deriving its cache verdict for
    // a document request.
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const manifest = makeManifest({
      poolAssignments: { "/about": "ssr", "/about.rsc": "ssr" },
      pathnames: ["/about"],
    });
    expect(buildProofHeaderNames(manifest)).toContain("rsc");
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler([
      ...makeHeaders("/about"),
      { key: "rsc", value: "1" },
    ] as HeaderValue[]);
    const mutation = response.requestHeaders!.response!.headerMutation!;
    expect(mutation.setHeaders!.find((h) => h.header.key === "x-output-id")!.header.value).toBe(
      "/about.rsc",
    );
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof")!
      .header.value!;
    const atPool = poolViewOf(mutation, { rsc: "1" });

    expect(verifyAsPool(proof, { target: "/about", headers: atPool })).toBe(true);
    // Strip the header that made this a flight request: the `.rsc` dispatch is no longer trusted.
    const { rsc: _rsc, ...asDocument } = atPool;
    expect(verifyAsPool(proof, { target: "/about", headers: asDocument })).toBe(false);
  });

  it("binds the middleware-matcher inputs, so a skip-nomatch proof does not transfer", async () => {
    // The matcher `missing: [{type:"cookie", key:"session"}]` makes the ANONYMOUS request the one
    // that legitimately earns the trusted `skip-nomatch` verdict. Unbound, that proof would carry
    // over to a request that DOES present the cookie — a middleware stage the pool then skips
    // although middleware never ran for that request.
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const manifest = makeManifest({
      middleware: {
        filePath: "middleware.js",
        matchers: [{ regexp: "^/about$", missing: [{ type: "cookie", key: "session" }] }],
      } as RoutingManifest["middleware"],
    });
    const proofHeaderNames = buildProofHeaderNames(manifest);
    // The matcher's cookie input alongside this build's RSC negotiation header.
    expect(proofHeaderNames).toEqual(["cookie", "rsc"]);

    // No middleware MODULE: the manifest's matchers still define the covered set, and a
    // module-less build stamps `x-mw-evaluated: none`.
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof")!
      .header.value!;
    const atPool = poolViewOf(mutation);

    expect(verifyAsPool(proof, { target: "/about", headers: atPool, proofHeaderNames })).toBe(true);
    // The same verdict presented WITH the cookie the matcher gates on: rejected.
    expect(
      verifyAsPool(proof, {
        target: "/about",
        headers: { ...atPool, cookie: "session=alice" },
        proofHeaderNames,
      }),
    ).toBe(false);
    // A pool verifying with the WRONG covered set (no matcher inputs) rejects it too — the
    // covered-name count is signed, so two builds' transcripts cannot collide.
    expect(verifyAsPool(proof, { target: "/about", headers: atPool })).toBe(false);
  });

  it("signs the ORIGINAL wire target across the trailing-slash/i18n retry", async () => {
    // N40c. The retry recurses into handleRequest with `:path` replaced by the retried,
    // locale-prefixed URL so resolution runs against the real target — but the mutation response
    // never mutates `:path` (the public target is preserved for the client; the rewrite rides in
    // `x-invoke-path`), so Envoy forwards the ORIGINAL target upstream and the pool verifies with
    // `req.url` = that original. Signing the recursion's own `:path` made EVERY retried request
    // fail verification: the pool silently stripped the whole dispatch vocabulary and re-resolved
    // locally, running middleware a SECOND time — the exact double execution the retry's
    // `middlewareAlreadyRan` plumbing exists to prevent, on every i18n build in production.
    process.env.INTERNAL_HEADER_SECRET = "s3cr3t";
    const manifest = makeManifest({
      i18n: { locales: ["en"], defaultLocale: "en" } as any,
      poolAssignments: { "/about": "ssr" },
      pathnames: ["/about"],
    });
    const proofHeaderNames = buildProofHeaderNames(manifest);
    let call = 0;
    vi.mocked(resolveRoutes).mockImplementation(async () => {
      call++;
      if (call === 1) {
        // Pure internal trailing-slash artifact: locale-stripped target == request path and
        // status 308 → normalizeResolvedRedirect returns kind "retry".
        return {
          redirect: { url: new URL("https://app.example.com/en/about"), status: 308 },
        } as any;
      }
      return {
        resolvedPathname: "/en/about",
        invocationTarget: { pathname: "/en/about", query: {} },
      } as any;
    });

    const handler = createRequestHandler(manifest, null);
    const response = await handler(makeHeaders("/about?x=1"));
    // The retry really happened (two resolution passes) …
    expect(call).toBe(2);
    const mutation = response.requestHeaders!.response!.headerMutation!;
    // … and no hop rewrote the public target, so the pool will read `/about?x=1` as `req.url`.
    expect(mutation.setHeaders!.find((h) => h.header.key === ":path")).toBeUndefined();
    const proof = mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof")!
      .header.value!;
    const atPool = poolViewOf(mutation);

    expect(verifyAsPool(proof, { target: "/about?x=1", headers: atPool, proofHeaderNames })).toBe(
      true,
    );
    // And NOT against the retried path, which never reaches the wire — the transcript that used
    // to be signed here.
    expect(
      verifyAsPool(proof, { target: "/en/about?x=1", headers: atPool, proofHeaderNames }),
    ).toBe(false);
  });

  it("removes x-internal-secret AND the proof when none is configured (client cannot spoof either)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler(makeHeaders("/about"));
    const mutation = response.requestHeaders!.response!.headerMutation!;
    expect(mutation.setHeaders!.find((h) => h.header.key === "x-internal-secret")).toBeUndefined();
    expect(mutation.removeHeaders).toContain("x-internal-secret");
    expect(
      mutation.setHeaders!.find((h) => h.header.key === "x-internal-dispatch-proof"),
    ).toBeUndefined();
    expect(mutation.removeHeaders).toContain("x-internal-dispatch-proof");
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

describe("createRequestHandler ingress hygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.INTERNAL_HEADER_SECRET;
  });

  it("strips client-spoofed internal dispatch headers before resolveRoutes sees them", async () => {
    // Egress mutations only overwrite the keys they set — without ingress stripping,
    // a client-sent x-output-id / x-mw-evaluated would flow into resolveRoutes and
    // middleware as attacker-controlled input.
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    await handler([
      ...makeHeaders("/about"),
      { key: "x-output-id", value: "/../../etc" },
      { key: "x-matched-pathname", value: "/spoofed" },
      { key: "x-route-matches", value: "{}" },
      { key: "x-mw-evaluated", value: "ran" },
      { key: "x-resolved-headers", value: "{}" },
      { key: "x-internal-secret", value: "guessed" },
      { key: "x-internal-dispatch-proof", value: "guessed-proof" },
      { key: "x-upstream-pool", value: "api" },
      { key: "x-nextjs-ppr", value: "1" },
    ]);

    const seenHeaders = vi.mocked(resolveRoutes).mock.calls[0]![0].headers as Headers;
    for (const key of [
      "x-output-id",
      "x-matched-pathname",
      "x-route-matches",
      "x-mw-evaluated",
      "x-resolved-headers",
      "x-internal-secret",
      "x-internal-dispatch-proof",
      "x-upstream-pool",
      "x-nextjs-ppr",
    ]) {
      expect(seenHeaders.get(key), key).toBeNull();
    }
    // …while legitimate client headers pass through untouched.
    expect(seenHeaders.get("host")).toBe("app.example.com");
  });

  it("strips client-supplied Next resume headers before routing and forwarding", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    const response = await handler([
      ...makeHeaders("/about"),
      { key: "next-resume", value: "1" },
      { key: "x-next-resume-state-length", value: "32" },
    ]);

    const seenHeaders = vi.mocked(resolveRoutes).mock.calls[0]![0].headers as Headers;
    expect(seenHeaders.get("next-resume")).toBeNull();
    expect(seenHeaders.get("x-next-resume-state-length")).toBeNull();

    const removeHeaders = response.requestHeaders!.response!.headerMutation!.removeHeaders ?? [];
    expect(removeHeaders).toContain("next-resume");
    expect(removeHeaders).toContain("x-next-resume-state-length");
  });

  it("never leaks the :path query string into the dispatch fallback pathname", async () => {
    // resolveRoutes returning nothing -> the fallback must be the PARSED pathname;
    // the raw :path carries "?query", which would corrupt x-output-id/x-upstream-pool.
    const manifest = makeManifest({
      poolAssignments: { "/about": "ssr" },
      pathnames: ["/about"],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({} as any);

    const response = await handler(makeHeaders("/about?x=1"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-output-id")!.header.value).toBe("/about");
    expect(setHeaders.find((h) => h.header.key === "x-output-id")!.header.value).not.toContain(
      "x=1",
    );
  });

  it("deletes x-nextjs-data for non-data requests (pool resolver parity)", async () => {
    // The header is a client hint, not proof of the /_next/data protocol — the pool
    // resolver deletes it for non-data requests (resolve.ts); the edge must match.
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    await handler([...makeHeaders("/about"), { key: "x-nextjs-data", value: "1" }]);
    const seenHeaders = vi.mocked(resolveRoutes).mock.calls[0]![0].headers as Headers;
    expect(seenHeaders.get("x-nextjs-data")).toBeNull();
  });

  it("keeps x-nextjs-data for genuine /_next/data requests", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as any);

    await handler([
      ...makeHeaders("/_next/data/test123/about.json"),
      { key: "x-nextjs-data", value: "1" },
    ]);
    const seenHeaders = vi.mocked(resolveRoutes).mock.calls[0]![0].headers as Headers;
    expect(seenHeaders.get("x-nextjs-data")).toBe("1");
  });
});

describe("createRequestHandler shed signal (timeout wiring)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the middleware request signal when the per-request budget expires", async () => {
    // The withTimeout shed (server.ts) rejects the response on timeout; the signal
    // handed to middleware must abort too, so middleware awaiting a slow upstream is
    // cancelled instead of racing detached. A never-aborted controller was the bug.
    let capturedSignal: AbortSignal | undefined;
    const adapterFn = vi.fn(async ({ request }: any) => {
      capturedSignal = request.signal;
      await new Promise<void>((resolve) => {
        request.signal.addEventListener("abort", () => resolve());
      });
      return { response: new Response("ok") };
    });
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
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

    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10 });
    await handler(makeHeaders("/about"));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(true);
  });

  it("aborts Path 3 (direct handler) middleware via the Request signal when the budget expires", async () => {
    // Path 3 builds a real Request — previously without `signal:`, so middleware on
    // this path kept running detached after the server-side shed. The three-path
    // split itself is a hard invariant; only the signal wiring changed.
    let captured: AbortSignal | undefined;
    const handlerFn = vi.fn(async (req: Request) => {
      captured = req.signal;
      await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve()));
      return new Response("ok");
    });
    // No `default` export → Path 1 skipped; no default.default → Path 2 skipped;
    // `middleware` export → Path 3 runs.
    const middlewareModule = { middleware: handlerFn };
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

    const handler = createRequestHandler(makeManifest(), middlewareModule as any, {
      timeoutMs: 10,
    });
    await handler(makeHeaders("/about"));
    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
  });

  it("aborts Path 2 (legacy default.default) middleware via request.signal when the budget expires", async () => {
    // Next's legacy adapter (dist/server/web/adapter.js) forwards params.request.signal
    // into the NextRequest init — the shed budget must reach legacy middleware too.
    let captured: AbortSignal | undefined;
    const legacyFn = vi.fn(async ({ request }: any) => {
      captured = request.signal;
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve()),
      );
      return { response: new Response("ok") };
    });
    // `default` is an OBJECT (not callable) → Path 1 skipped; default.default → Path 2.
    const middlewareModule = { default: { default: legacyFn } };
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

    const handler = createRequestHandler(makeManifest(), middlewareModule as any, {
      timeoutMs: 10,
    });
    await handler(makeHeaders("/about"));
    expect(legacyFn).toHaveBeenCalledTimes(1);
    expect(captured).toBeDefined();
    expect(captured!.aborted).toBe(true);
  });

  it("does not mint a fresh timeout budget on the trailing-slash retry, and runs middleware ONCE", async () => {
    // The i18n trailing-slash retry recurses into handleRequest while the
    // server-side withTimeout keeps the ORIGINAL clock — a fresh
    // AbortSignal.timeout would hand the retried pass a full new window.
    //
    // N40: this test used to assert the middleware saw the SAME signal on BOTH passes
    // (`signals` length 2). Re-invoking middleware on the retry is itself the bug — it is the
    // same request with the same verdict, so a second pass duplicates Set-Cookie, duplicates
    // waitUntil/after() side effects and doubles the latency inside the ext_proc budget.
    // pool-server/resolve.ts refuses for exactly this reason (`middlewareAlreadyRan`), so the
    // edge now refuses too: middleware runs ONCE. The no-fresh-budget property is pinned
    // directly instead, by counting AbortSignal.timeout calls across the recursion.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const signals: AbortSignal[] = [];
    const adapterFn = vi.fn(async ({ request }: any) => {
      signals.push(request.signal);
      return { response: new Response("ok") };
    });
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    let call = 0;
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      call++;
      if (call === 1) {
        // Pure internal trailing-slash artifact: locale-stripped target == request
        // path, status 308 → normalizeResolvedRedirect returns kind "retry".
        return {
          redirect: { url: new URL("https://app.example.com/en/about"), status: 308 },
        } as any;
      }
      return {
        resolvedPathname: "/en/about",
        invocationTarget: { pathname: "/en/about", query: {} },
      } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({} as any);

    const manifest = makeManifest({
      i18n: { locales: ["en"], defaultLocale: "en" } as any,
      poolAssignments: { "/about": "ssr" },
      pathnames: ["/about"],
    });
    const handler = createRequestHandler(manifest, middlewareModule, { timeoutMs: 5000 });
    await handler(makeHeaders("/about"));
    // The retry DID happen (two resolveRoutes passes) …
    expect(call).toBe(2);
    // … middleware ran exactly once across it …
    expect(signals).toHaveLength(1);
    expect(adapterFn).toHaveBeenCalledTimes(1);
    // … and no second budget was minted: one AbortSignal.timeout for the whole recursion,
    // which is the signal middleware observed.
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(signals[0]).toBe(timeoutSpy.mock.results[0]!.value);
    timeoutSpy.mockRestore();
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

// REGRESSION: ext_proc parity with the pool resolver for the two riskiest
// middleware changes — matcher gating and fail-closed. These run in production
// (routing service) and are not exercised by the single-pool e2e path.
describe("createRequestHandler middleware matcher + fail-closed (ext_proc parity)", () => {
  beforeEach(() => {
    vi.mocked(resolveRoutes).mockReset();
    vi.mocked(responseToMiddlewareResult).mockReset();
  });

  it("skips middleware invocation when the config.matcher does not match", async () => {
    const mw = vi.fn().mockResolvedValue({ response: new Response(null) });
    const middlewareModule = { default: mw, middleware: vi.fn() };
    let mwResult: any;
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      mwResult = await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about", query: {} },
      } as any;
    });
    const manifest = makeManifest({
      middleware: {
        filePath: "middleware.js",
        matchers: [{ regexp: "^\\/only-here$", originalSource: "/only-here" }],
      },
    });
    const handler = createRequestHandler(manifest, middlewareModule);
    await handler(makeHeaders("/about")); // /about does not match /only-here
    expect(mwResult).toEqual({});
    expect(mw).not.toHaveBeenCalled();
  });

  it("invokes middleware when the config.matcher matches", async () => {
    const adapterFn = vi.fn().mockResolvedValue({ response: new Response("ok") });
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return {
        resolvedPathname: "/only-here",
        invocationTarget: { pathname: "/only-here", query: {} },
      } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({} as any);
    const manifest = makeManifest({
      pathnames: ["/only-here"],
      poolAssignments: { "/only-here": "ssr" },
      middleware: {
        filePath: "middleware.js",
        matchers: [{ regexp: "^\\/only-here$", originalSource: "/only-here" }],
      },
    });
    const handler = createRequestHandler(manifest, middlewareModule);
    await handler(makeHeaders("/only-here"));
    expect(adapterFn).toHaveBeenCalledTimes(1);
  });

  it("runs middleware (never a trusted skip) when the matcher regexp cannot compile", async () => {
    // CRITICAL: an uncompilable matcher used to be skipped → matchesMiddleware false →
    // mwEvaluated "skip-nomatch" (a TRUSTED verdict) → the pool skipped its own
    // middleware too. Fail-safe: treat it as matched, run middleware, stamp "ran".
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapterFn = vi.fn().mockResolvedValue({ response: new Response("ok") });
      const middlewareModule = { default: adapterFn, middleware: vi.fn() };
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
      const manifest = makeManifest({
        middleware: {
          filePath: "middleware.js",
          // Compiles on a Node-24 build machine, not in an older serving runtime —
          // stand-in here is a regexp invalid everywhere.
          matchers: [{ regexp: "(?i:handler-level-bad", originalSource: "/x" }],
        },
      });
      const handler = createRequestHandler(manifest, middlewareModule);
      const response = await handler(makeHeaders("/about"));
      expect(adapterFn).toHaveBeenCalledTimes(1);
      const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
      const mw = setHeaders.find((h) => h.header.key === "x-mw-evaluated");
      expect(mw!.header.value).toBe("ran");
    } finally {
      warn.mockRestore();
    }
  });

  it("fails CLOSED with a 500 when a genuine middleware exception occurs while the shed signal is live but unaborted", async () => {
    // With a timeout budget configured (shedSignal exists but has NOT fired), a real
    // crash must still take the unconditional fail-closed 500 — the abort-rethrow
    // classification must not widen to ordinary errors just because a signal is present.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing = vi.fn().mockRejectedValue(new TypeError("boom"));
      const middlewareModule = { default: throwing, middleware: vi.fn() };
      vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
        const r = await params.invokeMiddleware({
          url: params.url,
          headers: params.headers,
          requestBody: params.requestBody,
        });
        expect(r).toEqual({ bodySent: true });
        return { middlewareResponded: true } as any;
      });
      const manifest = makeManifest({ middleware: { filePath: "middleware.js" } });
      const handler = createRequestHandler(manifest, middlewareModule, { timeoutMs: 60_000 });
      const res = (await handler(makeHeaders("/about"))) as any;
      expect(res.immediateResponse?.status?.code).toBe(500);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("fails CLOSED with a 500 when middleware throws", async () => {
    const throwing = vi.fn().mockRejectedValue(new Error("boom"));
    const middlewareModule = { default: throwing, middleware: vi.fn() };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      const r = await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      // fail-closed surfaces as bodySent (short-circuit), never "{}".
      expect(r).toEqual({ bodySent: true });
      return { middlewareResponded: true } as any;
    });
    const manifest = makeManifest({ middleware: { filePath: "middleware.js" } });
    const handler = createRequestHandler(manifest, middlewareModule);
    const res = (await handler(makeHeaders("/about"))) as any;
    // buildImmediateResponse(500,...) — assert the exact status code is carried.
    expect(res.immediateResponse?.status?.code).toBe(500);
  });
});

// P2 fix: a shed-abort (the per-request budget expiring while signal-aware middleware
// is in flight) is NOT a middleware crash. The middleware catch rethrows abort-shaped
// errors so the rejection crosses resolveRoutes (which awaits invokeMiddleware bare) →
// handleRequest → createProcessHandler (server.ts), where the configured failOpen
// policy decides CONTINUE vs 500. Previously the abort was classified as a crash and
// answered with an unconditional 500, making `failOpen: true` a no-op for the most
// common timeout shape. Genuine middleware exceptions keep the fail-closed 500.
describe("createRequestHandler shed-abort → server fail policy (P2)", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let errSpy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  function calloutFor(headers: HeaderValue[]): ProcessingRequest {
    return create(ProcessingRequestSchema, {
      request: {
        case: "requestHeaders",
        value: {
          headers: {
            headers: headers.map((h) => ({ key: h.key, rawValue: enc.encode(h.value ?? "") })),
          },
        },
      },
    });
  }

  async function* once<T>(value: T): AsyncGenerator<T> {
    yield value;
  }

  async function first(
    gen: AsyncGenerator<ProtoProcessingResponse>,
  ): Promise<ProtoProcessingResponse> {
    for await (const r of gen) return r;
    throw new Error("stream yielded no response");
  }

  // Mirrors the real @next/routing resolveRoutes: invokeMiddleware is awaited BARE
  // (no try/catch — verified against dist/index.js `const L=await i({...})`), so a
  // rejection from the invoke closure rejects the resolveRoutes promise, which
  // rejects handleRequest, which is the promise createProcessHandler observes.
  function propagatingResolveRoutes() {
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
  }

  // Signal-aware middleware: rejects with the abort reason when the shed fires —
  // the same shape a signal-respecting fetch()/NextResponse produces.
  const rejectOnAbort = (signal: AbortSignal) =>
    new Promise<never>((_, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason));
    });

  const wasLoggedAsMiddlewareCrash = () =>
    errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("Middleware execution failed"));

  it("Path 1 (web adapter): shed-abort + failOpen:true → CONTINUE, not an immediate 500", async () => {
    propagatingResolveRoutes();
    const adapterFn = vi.fn(async ({ request }: any) => rejectOnAbort(request.signal));
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10 });
    const proc = createProcessHandler(handler, true, 0);

    const response = await first(proc(once(calloutFor(makeHeaders("/about")))));
    expect(response.response.case).toBe("requestHeaders");
    if (response.response.case !== "requestHeaders") throw new Error("wrong case");
    expect(response.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
    expect(adapterFn).toHaveBeenCalledTimes(1);
    // ...and it was NOT classified as a middleware crash.
    expect(wasLoggedAsMiddlewareCrash()).toBe(false);
  });

  it("Path 1 (web adapter): shed-abort + failOpen:false → the SERVER's policy 500, not the middleware 500", async () => {
    propagatingResolveRoutes();
    const adapterFn = vi.fn(async ({ request }: any) => rejectOnAbort(request.signal));
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10 });
    const proc = createProcessHandler(handler, false, 0);

    const response = await first(proc(once(calloutFor(makeHeaders("/about")))));
    expect(response.response.case).toBe("immediateResponse");
    if (response.response.case !== "immediateResponse") throw new Error("wrong case");
    expect(response.response.value.status!.code).toBe(500);
    // Distinguish the paths: the server's internalError500 carries the body
    // "Internal routing error" and no content-type header; the middleware 500
    // (buildImmediateResponse) sets content-type text/plain and an empty body.
    expect(dec.decode(response.response.value.body)).toBe("Internal routing error");
    const ct = (response.response.value.headers?.setHeaders ?? []).find(
      (h) => h.header!.key === "content-type",
    );
    expect(ct).toBeUndefined();
    expect(wasLoggedAsMiddlewareCrash()).toBe(false);
  });

  it("Path 3 (direct handler): shed-abort + failOpen:true → CONTINUE", async () => {
    propagatingResolveRoutes();
    // No callable `default` → Path 1 skipped; no default.default → Path 2 skipped.
    const handlerFn = vi.fn(async (req: Request) => rejectOnAbort(req.signal));
    const middlewareModule = { middleware: handlerFn };
    const handler = createRequestHandler(makeManifest(), middlewareModule as any, {
      timeoutMs: 10,
    });
    const proc = createProcessHandler(handler, true, 0);

    const response = await first(proc(once(calloutFor(makeHeaders("/about")))));
    expect(response.response.case).toBe("requestHeaders");
    if (response.response.case !== "requestHeaders") throw new Error("wrong case");
    expect(response.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
    expect(handlerFn).toHaveBeenCalledTimes(1);
    expect(wasLoggedAsMiddlewareCrash()).toBe(false);
  });

  it("Path 2 (legacy default.default): shed-abort + failOpen:true → CONTINUE", async () => {
    propagatingResolveRoutes();
    const legacyFn = vi.fn(async ({ request }: any) => rejectOnAbort(request.signal));
    // `default` is an OBJECT (not callable) → Path 1 skipped; default.default → Path 2.
    const middlewareModule = { default: { default: legacyFn } };
    const handler = createRequestHandler(makeManifest(), middlewareModule as any, {
      timeoutMs: 10,
    });
    const proc = createProcessHandler(handler, true, 0);

    const response = await first(proc(once(calloutFor(makeHeaders("/about")))));
    expect(response.response.case).toBe("requestHeaders");
    if (response.response.case !== "requestHeaders") throw new Error("wrong case");
    expect(response.response.value.response!.status).toBe(CommonResponse_ResponseStatus.CONTINUE);
    expect(legacyFn).toHaveBeenCalledTimes(1);
    expect(wasLoggedAsMiddlewareCrash()).toBe(false);
  });

  it("rejects the handler promise with the TimeoutError abort reason (not a resolved 500)", async () => {
    propagatingResolveRoutes();
    const adapterFn = vi.fn(async ({ request }: any) => rejectOnAbort(request.signal));
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10 });
    // AbortSignal.timeout() aborts with a DOMException named "TimeoutError".
    await expect(handler(makeHeaders("/about"))).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rethrows an abort wrapped one level deep in `cause` (no shed signal configured)", async () => {
    propagatingResolveRoutes();
    const wrapped = new Error("upstream fetch failed", {
      cause: new DOMException("This operation was aborted", "AbortError"),
    });
    const adapterFn = vi.fn().mockRejectedValue(wrapped);
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule);
    await expect(handler(makeHeaders("/about"))).rejects.toThrow("upstream fetch failed");
    expect(wasLoggedAsMiddlewareCrash()).toBe(false);
  });

  it("rethrows a non-abort-shaped error raised after the shed signal actually fired", async () => {
    // Middleware that reacts to the abort by throwing its own error: the shed signal
    // itself reporting aborted routes it to the server policy — the request budget is
    // already blown, so the failure mode belongs to the shed, not the middleware.
    propagatingResolveRoutes();
    const adapterFn = vi.fn(async ({ request }: any) => {
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve()),
      );
      throw new Error("upstream died mid-shed");
    });
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10 });
    await expect(handler(makeHeaders("/about"))).rejects.toThrow("upstream died mid-shed");
  });

  it("a plain TypeError still gets the unconditional middleware 500 even under failOpen:true", async () => {
    propagatingResolveRoutes();
    const adapterFn = vi.fn().mockRejectedValue(new TypeError("boom"));
    const middlewareModule = { default: adapterFn, middleware: vi.fn() };
    const handler = createRequestHandler(makeManifest(), middlewareModule, { timeoutMs: 10_000 });
    const proc = createProcessHandler(handler, true, 0);

    const response = await first(proc(once(calloutFor(makeHeaders("/about")))));
    expect(response.response.case).toBe("immediateResponse");
    if (response.response.case !== "immediateResponse") throw new Error("wrong case");
    expect(response.response.value.status!.code).toBe(500);
    // The middleware-500 marker: content-type is set by buildImmediateResponse.
    const ct = (response.response.value.headers?.setHeaders ?? []).find(
      (h) => h.header!.key === "content-type",
    );
    expect(ct).toBeDefined();
    expect(wasLoggedAsMiddlewareCrash()).toBe(true);
  });
});

describe("rewrite invocation transport (x-invoke-path / x-invoke-query)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function rewriteManifest(): RoutingManifest {
    const manifest = makeManifest({
      pathnames: ["/", "/about", "/api/hello", "/rewrite-source"],
      poolAssignments: { "/": "ssr", "/about": "ssr", "/api/hello": "api" },
    });
    // next.config rewrite whose destination carries a REPEATED query key. @next/routing
    // applies destinations with URLSearchParams.set (collapses to the last value), so the
    // handler must restore the repetition before stamping the transport header.
    manifest.routeGraph.afterFiles = [
      {
        source: "/rewrite-source",
        sourceRegex: "^\\/rewrite-source(?:\\/)?$",
        destination: "/api/hello?item=one&item=two",
      },
    ] as any;
    return manifest;
  }

  it("stamps the rewritten invocation target with repeated destination keys restored", async () => {
    const handler = createRequestHandler(rewriteManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/api/hello",
      // Collapsed query — what @next/routing currently reports for the destination above.
      invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders("/rewrite-source"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const invokePath = setHeaders.find((h) => h.header.key === "x-invoke-path");
    expect(invokePath!.header.value).toBe("/api/hello?item=one&item=two");
    const invokeQuery = setHeaders.find((h) => h.header.key === "x-invoke-query");
    expect(JSON.parse(invokeQuery!.header.value!)).toEqual({ item: ["one", "two"] });
    // Stamped keys must not simultaneously be cleared.
    const removeHeaders = response.requestHeaders!.response!.headerMutation!.removeHeaders ?? [];
    expect(removeHeaders).not.toContain("x-invoke-path");
    expect(removeHeaders).not.toContain("x-invoke-query");
  });

  it("clears (never stamps) the invocation transport when routing did not rewrite", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders("/about"));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-invoke-path")).toBeUndefined();
    expect(setHeaders.find((h) => h.header.key === "x-invoke-query")).toBeUndefined();
    // A client-smuggled value must be actively removed on the way in.
    const removeHeaders = response.requestHeaders!.response!.headerMutation!.removeHeaders ?? [];
    expect(removeHeaders).toContain("x-invoke-path");
    expect(removeHeaders).toContain("x-invoke-query");
  });

  it("does not stamp an invocation target for RSC requests (client reconciles via headers)", async () => {
    const manifest = rewriteManifest();
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/api/hello",
      invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const rscHeader = manifest.routeGraph.rsc?.header ?? "rsc";
    const response = await handler([
      ...makeHeaders("/rewrite-source"),
      { key: rscHeader, value: "1" },
    ]);
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-invoke-path")).toBeUndefined();
  });
});

// N15: RSC redirects keep the real 3xx (next start parity).
//
// Measured against `next start` (Next 16.3.0-canary.84, app-dir/rsc-query-routing fixture):
//   curl -H 'RSC: 1' '/redirect/source?_rsc=abc123'
//     → HTTP/1.1 308 Permanent Redirect
//       location: /redirect/dest?_rsc=abc123
//       Refresh: 0;url=/redirect/dest?_rsc=abc123
//   — no `x-nextjs-redirect` on ANY response, RSC or not. `x-nextjs-redirect` is a PAGES-router
//   protocol: written only at server/web/adapter.ts under `if (isNextDataRequest)`, read only by
//   shared/lib/router/router.ts. The App Router flight client follows the real redirect
//   (client/components/router-reducer/fetch-server-response.ts reads response.redirected /
//   response.url), so emitting a 200 + x-nextjs-redirect stranded it into a document load.
describe("RSC redirects keep the real 3xx (next start parity)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function rscHeaders(path: string): HeaderValue[] {
    return [...makeHeaders(path), { key: "rsc", value: "1" }];
  }

  it("answers a same-origin header-only redirect with the real 3xx and a RELATIVE location", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "https://app.example.com/rewritten" }),
      status: 307,
    } as any);

    const response = await handler(rscHeaders("/rsc-redirect-origin?_rsc=probe"));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(307);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-nextjs-redirect")).toBeUndefined();
    // Same-origin target → RELATIVE path, exactly like `next start`; and the request query is
    // carried onto the query-less target so `_rsc` survives the hop.
    expect(setHeaders.find((h) => h.header.key === "location")!.header.value).toBe(
      "/rewritten?_rsc=probe",
    );
  });

  it("keeps an absolute location for a cross-origin redirect", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "https://other.example.com/away" }),
      status: 307,
    } as any);

    const response = await handler(rscHeaders("/rsc-redirect-origin"));
    expect(response.immediateResponse!.status!.code).toBe(307);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "location")!.header.value).toBe(
      "https://other.example.com/away",
    );
    expect(setHeaders.find((h) => h.header.key === "x-nextjs-redirect")).toBeUndefined();
  });

  it("keeps rule redirects on the real 3xx for RSC requests, with Refresh on 308", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      redirect: { url: new URL("https://app.example.com/new"), status: 308 },
    } as any);

    const response = await handler(rscHeaders("/old"));
    expect(response.immediateResponse!.status!.code).toBe(308);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "x-nextjs-redirect")).toBeUndefined();
    expect(setHeaders.find((h) => h.header.key === "location")!.header.value).toBe("/new");
    expect(setHeaders.find((h) => h.header.key === "Refresh")!.header.value).toBe("0;url=/new");
  });

  it("treats a non-RSC redirect identically (no RSC special-case remains)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "https://app.example.com/rewritten" }),
      status: 307,
    } as any);

    const response = await handler(makeHeaders("/rsc-redirect-origin"));
    expect(response.immediateResponse!.status!.code).toBe(307);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    expect(setHeaders.find((h) => h.header.key === "location")!.header.value).toBe("/rewritten");
    expect(setHeaders.find((h) => h.header.key === "x-nextjs-redirect")).toBeUndefined();
  });

  it("preserves middleware Set-Cookie on the RSC redirect response", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    const resolvedHeaders = new Headers({ location: "https://app.example.com/rewritten" });
    resolvedHeaders.append("set-cookie", "session=abc; Path=/");
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders,
      status: 307,
    } as any);

    const response = await handler(rscHeaders("/rsc-redirect-origin"));
    expect(response.immediateResponse!.status!.code).toBe(307);
    const setHeaders = response.immediateResponse!.headers!.setHeaders!;
    const cookie = setHeaders.find((h) => h.header.key === "set-cookie");
    expect(cookie!.header.value).toBe("session=abc; Path=/");
  });
});

// N18 (SECURITY): the ext_proc tier authors two response classes that never touch a pool — a
// middleware-authored body and a rule/middleware redirect — and copies their headers verbatim
// from the middleware `Response` / next.config `headers()` verdict. If such a response carries a
// shared-cacheable Cache-Control while the request's `_rsc` does not authenticate its RSC
// headers, it becomes exactly the poisonable entry Next's own check exists to prevent. The pool
// enforces the invariant for every other response (pool-server/cache-policy.ts).
//
// Narrow by design: only a Cache-Control that grants a shared cache an unrevalidated window is
// downgraded. Cloud CDN runs USE_ORIGIN_HEADERS (nothing is stored without an explicit
// directive), so we never stamp `no-store` where there was no Cache-Control at all.
describe("N18: ext_proc immediate responses and the `_rsc` cache-busting param", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Recorded hash (see tests/routing-common.rsc-cache-busting.test.ts): for `rsc: 1` alone the
  // expected `_rsc` is the EMPTY string, i.e. the bare `?_rsc` form.
  function rscReq(path: string, extra: Record<string, string> = {}): HeaderValue[] {
    return [
      ...makeHeaders(path),
      { key: "rsc", value: "1" },
      ...Object.entries(extra).map(([key, value]) => ({ key, value })),
    ];
  }

  function headerValue(
    response: Awaited<ReturnType<ReturnType<typeof createRequestHandler>>>,
    key: string,
  ) {
    return response.immediateResponse!.headers!.setHeaders!.find(
      (h) => h.header.key.toLowerCase() === key,
    )?.header.value;
  }

  // A middleware module that answers the request itself with a shared-cacheable directive,
  // wired the way the other middleware tests here do (resolveRoutes must actually invoke it).
  function cacheableMiddlewareHandler() {
    const middlewareModule = {
      default: vi.fn().mockResolvedValue({
        response: new Response("gated", {
          status: 200,
          headers: { "cache-control": "public, s-maxage=600", "content-type": "text/plain" },
        }),
      }),
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
    return createRequestHandler(makeManifest(), middlewareModule);
  }

  it("downgrades a shared-cacheable middleware response for an unvalidated RSC request", async () => {
    const response = await cacheableMiddlewareHandler()(rscReq("/gated"));
    expect(response.immediateResponse!.status!.code).toBe(200);
    expect(headerValue(response, "cache-control")).toBe("no-store");
  });

  // S4 (SECURITY). These two used to assert that `public, s-maxage=600` was PRESERVED once
  // the N18 RSC check did not apply — i.e. they pinned the vulnerability. A middleware-authored
  // body is a middleware-covered response by definition, and the extension is post-cache on the
  // GXLB, so a shared-cacheable one is served to other users with the callout never running
  // (a cookie-dependent body then leaks for the whole freshness window). The pool already
  // refuses this via explicitCacheControlWins → grantsSharedCacheFreshness; the edge now does
  // too. `no-cache`, not `no-store`: storable-but-revalidated still reaches the extension on
  // every use, and it is what the pool's forced default uses. The N18 distinction the two tests
  // exist to draw is intact — unvalidated RSC is the stronger `no-store` (above).
  it("downgrades the SAME middleware response to no-cache when `_rsc` validates", async () => {
    const response = await cacheableMiddlewareHandler()(rscReq("/gated?_rsc"));
    expect(headerValue(response, "cache-control")).toBe("no-cache");
  });

  it("downgrades a DOCUMENT request too — middleware coverage is not RSC-scoped", async () => {
    const response = await cacheableMiddlewareHandler()(
      makeHeaders("/gated?_rsc=DEADBEEFdeadbeef"),
    );
    expect(headerValue(response, "cache-control")).toBe("no-cache");
  });

  it("keeps a middleware response that already forbids shared freshness verbatim", async () => {
    // Only a directive that actually grants an unrevalidated shared window is replaced —
    // an app expressing `public, max-age=0, must-revalidate` (service-worker shape) or
    // `private` keeps middleware in the loop on every request and is honored as written.
    for (const cc of ["public, max-age=0, must-revalidate", "private, max-age=600", "no-store"]) {
      const middlewareModule = {
        default: vi.fn().mockResolvedValue({
          response: new Response("gated", { status: 200, headers: { "cache-control": cc } }),
        }),
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
      const response = await createRequestHandler(
        makeManifest(),
        middlewareModule,
      )(makeHeaders("/gated"));
      expect(headerValue(response, "cache-control")).toBe(cc);
    }
  });

  it("downgrades a shared-cacheable redirect verdict for an unvalidated RSC request", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({
        location: "https://app.example.com/rewritten",
        "cache-control": "public, max-age=3600",
      }),
      status: 307,
    } as any);
    const response = await handler(rscReq("/old?_rsc=DEADBEEFdeadbeef"));
    expect(response.immediateResponse!.status!.code).toBe(307);
    expect(headerValue(response, "cache-control")).toBe("no-store");
    // The redirect itself is untouched.
    expect(headerValue(response, "location")).toBe("/rewritten?_rsc=DEADBEEFdeadbeef");
  });

  it("never invents a Cache-Control where the verdict had none", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({ location: "https://app.example.com/rewritten" }),
      status: 307,
    } as any);
    const response = await handler(rscReq("/old"));
    expect(response.immediateResponse!.status!.code).toBe(307);
    expect(headerValue(response, "cache-control")).toBeUndefined();
  });

  it("keeps an already-uncacheable directive verbatim (no gratuitous rewriting)", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedHeaders: new Headers({
        location: "https://app.example.com/rewritten",
        "cache-control": "private, max-age=0, must-revalidate",
      }),
      status: 307,
    } as any);
    const response = await handler(rscReq("/old"));
    expect(headerValue(response, "cache-control")).toBe("private, max-age=0, must-revalidate");
  });
});

describe("N40: edge-only defects the pool-only e2e harness could never see", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a malformed :authority with 400 instead of splicing it into the URL", async () => {
    // The edge used to interpolate `:authority` verbatim into a template string, so
    // `evil.com/foo` injected attacker path segments into the URL that feeds
    // detectDomainLocale, `has: { type: "host" }` matcher gating and the redirect same-origin
    // test. The pool has run everything through parseRequestUrl since N10; the comment there
    // CLAIMED this tier already did, which was true only for the `//evil/x` path half.
    const handler = createRequestHandler(makeManifest(), null);
    const response = await handler([
      { key: ":path", value: "/about" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "evil.com/foo" },
    ]);
    expect(response.immediateResponse!.status!.code).toBe(400);
    expect(resolveRoutes).not.toHaveBeenCalled();
  });

  it("rejects an absolute-form :path instead of adopting its authority", async () => {
    const handler = createRequestHandler(makeManifest(), null);
    const response = await handler([
      { key: ":path", value: "http://evil.example/about" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "app.example.com" },
    ]);
    expect(response.immediateResponse!.status!.code).toBe(400);
    expect(resolveRoutes).not.toHaveBeenCalled();
  });

  it("keeps the middleware body's bytes and drops its content-length", async () => {
    // `await mwRes.text()` + server.ts's TextEncoder turned every byte >= 0x80 into U+FFFD
    // (3 bytes): an 8-byte PNG signature measured 10 bytes on the wire, against a forwarded
    // `content-length: 8`.
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const middlewareModule = {
      default: vi.fn(async () => ({
        response: new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(PNG.length) },
        }),
      })),
      middleware: vi.fn(),
    };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return { middlewareResponded: true } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({ bodySent: true } as any);

    const response = await createRequestHandler(
      makeManifest(),
      middlewareModule as any,
    )(makeHeaders("/icon"));
    const body = response.immediateResponse!.body;
    expect(body).toBeInstanceOf(Uint8Array);
    expect([...(body as Uint8Array)]).toEqual([...PNG]);
    expect(
      response.immediateResponse!.headers!.setHeaders!.map((h) => h.header.key.toLowerCase()),
    ).not.toContain("content-length");
  });

  it("keeps a text middleware body byte-identical through the proto boundary", async () => {
    // The proto conversion (server.ts toBytes) must handle BOTH body kinds — a string body is
    // still encoded, a byte body passes through.
    const middlewareModule = {
      default: vi.fn(async () => ({ response: new Response("héllo", { status: 403 }) })),
      middleware: vi.fn(),
    };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return { middlewareResponded: true } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockReturnValue({ bodySent: true } as any);

    const plain = await createRequestHandler(
      makeManifest(),
      middlewareModule as any,
    )(makeHeaders("/gated"));
    const proto = plainResponseToProto(plain as any);
    if (proto.response.case !== "immediateResponse") throw new Error("wrong case");
    expect(new TextDecoder().decode(proto.response.value.body)).toBe("héllo");
    expect([...proto.response.value.body]).toEqual([...new TextEncoder().encode("héllo")]);
  });
});

// ---------------------------------------------------------------------------------------
// N40b: the transport header must not push a request past the POOL's header parser.
//
// `x-mw-request-headers` serializes the middleware's COMPLETE final request-header set while the
// client's originals stay on the wire (the pool reads those originals itself, before dispatch
// installs the replacement set), so the set is duplicated. Node's default `http.maxHeaderSize` is
// 16 KiB and pool-server/server.ts takes the default, so a request with ~8 KiB of cookies/auth
// crossed the limit only AFTER ext_proc processing — and Node answers 431 from the PARSER, so the
// pool never gets to read the transport header at all. These tests drive a real
// `createServer()` (hermetic, localhost, default options — the pool's own configuration) with the
// exact header block Envoy would write, so the limit is MEASURED rather than assumed.
// ---------------------------------------------------------------------------------------
describe("N40b: pool header-budget guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Status line code for a raw request whose header block is `block`, served by a default
   * `createServer()` — i.e. exactly what a pool pod would answer. 0 = no response at all. */
  async function statusForBlock(block: [string, string][]): Promise<number> {
    const { createServer } = await import("node:http");
    const net = await import("node:net");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const wire = `GET /about HTTP/1.1\r\n${block.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    const code = await new Promise<number>((resolve) => {
      const sock = net.connect(address.port, "127.0.0.1", () => sock.write(wire));
      let buf = "";
      const finish = (value: number) => {
        sock.destroy();
        resolve(value);
      };
      // Resolve on the status line rather than on socket close: a 200 keeps the connection
      // alive (keepAliveTimeout would make every case take 5s).
      sock.on("data", (d) => {
        buf += d.toString();
        if (buf.includes("\r\n")) finish(Number(buf.split(" ")[1] ?? 0));
      });
      sock.on("close", () => resolve(Number(buf.split(" ")[1] ?? 0)));
      sock.on("error", () => finish(0));
    });
    await new Promise<void>((r) => server.close(() => r()));
    return code;
  }

  /** The upstream header block Envoy writes after applying a header-mutation response:
   * pseudo-headers become the request line, `removeHeaders` are dropped and `setHeaders` are
   * OVERWRITE_IF_EXISTS_OR_ADD. */
  function upstreamBlock(client: HeaderValue[], response: any): [string, string][] {
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const set: [string, string][] = (mutation.setHeaders ?? []).map((h: any) => [
      h.header.key,
      h.header.value,
    ]);
    const removed = new Set<string>([
      ...(mutation.removeHeaders ?? []).map((k: string) => k.toLowerCase()),
      ...set.map(([k]) => k.toLowerCase()),
    ]);
    return [
      ...client
        .filter((h) => !h.key.startsWith(":") && !removed.has(h.key.toLowerCase()))
        .map((h) => [h.key, h.value ?? ""] as [string, string]),
      ...set,
    ];
  }

  /** A realistic cookie-heavy browser request: `bytes` of cookie plus the usual furniture. */
  function heavyRequest(bytes: number): HeaderValue[] {
    return [
      ...makeHeaders("/about"),
      {
        key: "user-agent",
        value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML) Safari",
      },
      { key: "accept", value: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      { key: "accept-language", value: "en-US,en;q=0.9" },
      { key: "cookie", value: `session=${"c".repeat(bytes - 8)}` },
      { key: "authorization", value: `Bearer ${"t".repeat(400)}` },
      { key: "x-user-id", value: "spoofed-evil" },
    ];
  }

  /** Middleware that mutates the request-header set (strips the spoof, adds the identity) and
   * returns `next()`, so the handler captures a final set to transport. */
  function mutatingMiddlewareHandler() {
    const middlewareModule = {
      default: vi.fn(async () => ({ response: new Response(null, { status: 200 }) })),
      middleware: vi.fn(),
    };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return {
        resolvedPathname: "/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/about", query: {} },
      } as any;
    });
    vi.mocked(responseToMiddlewareResult).mockImplementation(((
      _res: Response,
      reqHeaders: Headers,
    ) => {
      reqHeaders.delete("x-user-id");
      reqHeaders.set("x-authenticated-user", "alice");
      return {};
    }) as any);
    return createRequestHandler(makeManifest(), middlewareModule as any);
  }

  it("MEASUREMENT: the naive full-set stamp makes an 8 KiB-cookie request 431 at the pool", async () => {
    // The pre-fix wire shape: every client header still present, plus the whole final set again
    // as JSON. This is the defect — a request that worked before the N40 transport stops working.
    const client = heavyRequest(8 * 1024);
    const clientBlock = client
      .filter((h) => !h.key.startsWith(":"))
      .map((h) => [h.key, h.value ?? ""] as [string, string]);
    expect(await statusForBlock(clientBlock)).toBe(200);

    const finalSet = Object.fromEntries(
      clientBlock.filter(([k]) => k !== "x-user-id").concat([["x-authenticated-user", "alice"]]),
    );
    const naive: [string, string][] = [
      ...clientBlock,
      ["x-mw-request-headers", JSON.stringify(finalSet)],
      ["x-mw-evaluated", "ran"],
      ["x-output-id", "/about"],
      ["x-matched-pathname", "/about"],
      ["x-upstream-pool", "ssr"],
    ];
    expect(await statusForBlock(naive)).toBe(431);
  });

  it("hands an over-budget request to the pool UNTRUSTED instead of stamping a 431 into it", async () => {
    const client = heavyRequest(8 * 1024);
    const response = await mutatingMiddlewareHandler()(client);

    // No dispatch header is stamped, no secret is added, and the whole vocabulary is cleared —
    // the same fail-safe the body-request / external-rewrite backstops use, so the pool treats
    // the request as untrusted and re-resolves it locally (running middleware itself).
    const mutation = response.requestHeaders!.response!.headerMutation!;
    expect(mutation.setHeaders ?? []).toHaveLength(0);
    for (const name of [
      ...INTERNAL_DISPATCH_HEADERS,
      ...UNTRUSTED_NEXT_REQUEST_HEADERS,
      INTERNAL_SECRET_HEADER,
      INTERNAL_DISPATCH_PROOF_HEADER,
    ]) {
      expect(mutation.removeHeaders).toContain(name);
    }
    // Nothing is silently lost: without `x-mw-evaluated` the pool cannot skip its own
    // middleware, so the header mutation is re-derived in-process where no wire budget applies.
    expect(mutation.setHeaders?.find((h) => h.header.key === "x-mw-evaluated")).toBeUndefined();

    // And the request the pool actually receives is SMALLER than the one the client sent, so it
    // still parses — the property the 431 above violated.
    expect(await statusForBlock(upstreamBlock(client, response))).toBe(200);
  });

  it("still stamps the full dispatch set (transport included) for an ordinary request", async () => {
    // The guard must not fire on normal traffic: a 1 KiB cookie leaves plenty of budget.
    const client = heavyRequest(1024);
    const response = await mutatingMiddlewareHandler()(client);
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const dispatch = (key: string) => setHeaders.find((h) => h.header.key === key)?.header.value;
    expect(dispatch("x-mw-evaluated")).toBe("ran");
    const transported = dispatch("x-mw-request-headers");
    expect(transported).toBeDefined();
    const parsed = JSON.parse(transported!);
    expect(parsed["x-authenticated-user"]).toBe("alice");
    expect(parsed).not.toHaveProperty("x-user-id");
    expect(await statusForBlock(upstreamBlock(client, response))).toBe(200);
  });
});
