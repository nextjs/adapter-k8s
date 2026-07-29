// tests/routing-common.tier-parity.test.ts
//
// Phase-1 / Phase-2 PARITY. `src/routing-common.ts` exists so the two resolvers cannot
// diverge — the ext_proc edge (routing-service/handler.ts, "Phase 2") and the pool's local
// resolver (pool-server/resolve.ts, "Phase 1"). The pool nevertheless carried PRIVATE COPIES
// of mergeInvocationQuery / restoreRepeatedRewriteQuery / filterInternalQuery /
// buildQueryString plus a hand-mirrored copy of computeRewriteInvocation's body, and the edge
// carried a hand-mirrored (and drifted) copy of the output-pathname resolution.
//
// These tests exercise the SHARED helpers through BOTH tiers' real entry points
// (createLocalResolver().resolve and createRequestHandler()(…)) and assert byte-identical
// results, so a future re-divergence fails here rather than in production. The static guard at
// the bottom fails if either tier re-declares one of the shared helpers locally.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRouting } from "./helpers/mock-outputs.js";
import type { RoutingManifest } from "../src/types.js";
import type { HeaderValue } from "../src/routing-service/ext-proc-types.js";

vi.mock("@next/routing", async (importOriginal) => {
  // routing-common.ts imports the CJS default and destructures detect*; expose a
  // `default` alongside the named exports so both import styles resolve.
  const mocked = {
    ...(await importOriginal<typeof import("@next/routing")>()),
    resolveRoutes: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

import { resolveRoutes } from "@next/routing";
import { createLocalResolver } from "../src/pool-server/resolve.js";
import { createRequestHandler } from "../src/routing-service/handler.js";
import {
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_SECRET_HEADER,
  parseRequestUrl,
} from "../src/routing-common.js";

const ORIGIN = "http://app.example.com";

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
  } as RoutingManifest;
}

/** A next.config rewrite whose destination repeats a query key. @next/routing applies
 * destinations with URLSearchParams.set() (collapsing to the last value), so both tiers must
 * restore the repetition from the route metadata — the shared restoreRepeatedRewriteQuery. */
function withRewrite(manifest: RoutingManifest, destination: string): RoutingManifest {
  manifest.routeGraph.afterFiles = [
    {
      source: "/rewrite-source",
      sourceRegex: "^\\/rewrite-source(?:\\/)?$",
      destination,
    },
  ] as never;
  return manifest;
}

interface TierInvocation {
  invokePath: string | undefined;
  invocationQuery: Record<string, string | string[]> | undefined;
  outputId: string | undefined;
  // N19: the client-facing App Router rewrite signal. Phase 1 puts it straight on the
  // resolution's response headers; Phase 2 has no response phase (the ext_proc filter only
  // mutates the REQUEST), so it rides inside the secret-gated `x-resolved-headers` JSON that
  // the pool applies to the response. Both must produce the same two values.
  rewrittenPath: string | null | undefined;
  rewrittenQuery: string | null | undefined;
}

/**
 * Run one request through BOTH tiers against the same manifest and the same mocked
 * `resolveRoutes` verdict, and return each tier's view of the invocation target.
 */
async function bothTiers(args: {
  manifest: RoutingManifest;
  target: string;
  headers?: Record<string, string>;
  resolution: Record<string, unknown>;
}): Promise<{ phase1: TierInvocation; phase2: TierInvocation }> {
  const { manifest, target, resolution } = args;
  const extra = args.headers ?? {};
  vi.mocked(resolveRoutes).mockResolvedValue(resolution as never);

  // --- Phase 1: the pool's local resolver -------------------------------------
  const p1 = await createLocalResolver(manifest).resolve(
    new URL(`${ORIGIN}${target}`),
    new Headers({ host: "app.example.com", ...extra }),
    "GET",
    new ReadableStream<Uint8Array>(),
  );
  if (p1.kind !== "route") throw new Error(`Phase 1 did not route: ${JSON.stringify(p1)}`);

  // --- Phase 2: the ext_proc edge ---------------------------------------------
  const requestHeaders: HeaderValue[] = [
    { key: ":path", value: target },
    { key: ":method", value: "GET" },
    { key: ":scheme", value: "http" },
    { key: ":authority", value: "app.example.com" },
    { key: "host", value: "app.example.com" },
    ...Object.entries(extra).map(([key, value]) => ({ key, value })),
  ] as HeaderValue[];
  const p2 = await createRequestHandler(manifest, null)(requestHeaders);
  const setHeaders = p2.requestHeaders?.response?.headerMutation?.setHeaders ?? [];
  const dispatch = (key: string): string | undefined =>
    setHeaders.find((h) => h.header?.key === key)?.header?.value;
  const rawQuery = dispatch("x-invoke-query");

  const rawResolvedHeaders = dispatch("x-resolved-headers");
  const p2ResolvedHeaders: Record<string, string | string[]> = rawResolvedHeaders
    ? JSON.parse(rawResolvedHeaders)
    : {};
  const p2Header = (name: string): string | undefined => {
    const value = p2ResolvedHeaders[name];
    return Array.isArray(value) ? value.join(", ") : value;
  };

  return {
    phase1: {
      invokePath: p1.invokePath,
      invocationQuery: p1.invocationQuery,
      outputId: p1.matchedPathname,
      rewrittenPath: p1.resolvedHeaders?.get("x-nextjs-rewritten-path"),
      rewrittenQuery: p1.resolvedHeaders?.get("x-nextjs-rewritten-query"),
    },
    phase2: {
      invokePath: dispatch("x-invoke-path"),
      invocationQuery: rawQuery ? JSON.parse(rawQuery) : undefined,
      outputId: dispatch("x-output-id"),
      rewrittenPath: p2Header("x-nextjs-rewritten-path"),
      rewrittenQuery: p2Header("x-nextjs-rewritten-query"),
    },
  };
}

/**
 * Assert the two tiers derived the SAME invocation target. One documented wire-shape
 * allowance: Phase 2 only stamps `x-invoke-query` when the record is non-empty (an empty
 * object carries no information and would cost a header on every request), so Phase 1's `{}`
 * is equivalent to Phase 2's absent header. Everything else must be identical.
 */
function expectTiersAgree(r: { phase1: TierInvocation; phase2: TierInvocation }): void {
  const normalize = (q: Record<string, string | string[]> | undefined) =>
    q && Object.keys(q).length === 0 ? undefined : q;
  expect(r.phase2.invokePath).toEqual(r.phase1.invokePath);
  expect(normalize(r.phase2.invocationQuery)).toEqual(normalize(r.phase1.invocationQuery));
  expect(r.phase2.outputId).toEqual(r.phase1.outputId);
  // N19. Phase 1 reads an absent header as `null` (Headers.get) while Phase 2 reads an absent
  // JSON key as `undefined`; both mean "not emitted". Everything else must match byte for byte.
  const signal = (v: string | null | undefined) => v ?? undefined;
  expect(signal(r.phase2.rewrittenPath)).toEqual(signal(r.phase1.rewrittenPath));
  expect(signal(r.phase2.rewrittenQuery)).toEqual(signal(r.phase1.rewrittenQuery));
}

// ---------------------------------------------------------------------------------------
// MIDDLEWARE-AWARE PARITY (N40)
//
// The block above drives both tiers with middleware ABSENT, which is why four Phase-2-only
// middleware defects survived it. Everything below invokes real middleware through both real
// entry points, with the REAL `responseToMiddlewareResult` (only `resolveRoutes` is mocked).
// ---------------------------------------------------------------------------------------

/**
 * The shape of a real Next 16.2 Node-middleware artifact, as measured on a built fixture
 * (`node --input-type=module -e "await import('.next/server/middleware.js')"`):
 *
 *   { default: { default: <legacy adapter wrapper>, handler: <generated handler> } }
 *
 * `default` is an OBJECT, so `typeof middlewareModule.default === "function"` is false and the
 * web-adapter path (the only Phase-2 path that used to pass `manifestNextConfig`) can never
 * fire for it. `handler` is the documented entrypoint and the one whose wrapper bakes the
 * build's own basePath/i18n into `request.nextUrl`.
 */
function realArtifact(response: () => Response) {
  const calls: { path: string; url: string; nextConfig?: unknown }[] = [];
  const handler = vi.fn(async (request: Request) => {
    calls.push({ path: "generatedHandler", url: request.url });
    return response();
  });
  const legacy = vi.fn(async ({ request }: any) => {
    calls.push({ path: "legacy", url: request.url, nextConfig: request.nextConfig });
    return { response: response() };
  });
  return { module: { default: { default: legacy, handler } }, calls, handler, legacy };
}

/** A legacy-ONLY artifact: no `handler` anywhere, so both tiers must fall to path 2 — which is
 * where the missing `nextConfig` mattered. */
function legacyOnlyArtifact(response: () => Response) {
  const calls: { path: string; url: string; nextConfig?: unknown }[] = [];
  const legacy = vi.fn(async ({ request }: any) => {
    calls.push({ path: "legacy", url: request.url, nextConfig: request.nextConfig });
    return { response: response() };
  });
  return { module: { default: { default: legacy } }, calls, legacy };
}

/** `NextResponse.next({ request: { headers } })` on the wire: the control headers Next's own
 * adapter emits, transcribed from a measured 16.2.10 response. `responseToMiddlewareResult`
 * turns these into the middleware's final REQUEST header set. */
function nextWithRequestHeaders(overrides: Record<string, string>, keep: string[]): Response {
  const headers = new Headers({ "x-middleware-next": "1" });
  headers.set("x-middleware-override-headers", [...keep, ...Object.keys(overrides)].join(","));
  for (const name of keep) headers.set(`x-middleware-request-${name}`, `kept-${name}`);
  for (const [name, value] of Object.entries(overrides)) {
    headers.set(`x-middleware-request-${name}`, value);
  }
  return new Response(null, { status: 200, headers });
}

/** Drive one request through BOTH tiers with a middleware module, and report every
 * middleware-derived value each tier produced. */
async function bothTiersWithMiddleware(args: {
  manifest: RoutingManifest;
  target: string;
  headers?: Record<string, string>;
  method?: string;
  /** Fresh module per tier — a shared spy would hide a tier that never invoked it. */
  makeModule: () => {
    module: Record<string, unknown>;
    calls: { path: string; url: string; nextConfig?: unknown }[];
  };
  /** Resolution to report AFTER invokeMiddleware runs; may consume the middleware result. */
  resolution: (mwResult: Record<string, unknown>) => Record<string, unknown>;
}) {
  const { manifest, target, method = "GET" } = args;
  const extra = args.headers ?? {};

  const install = () =>
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      const mwResult = await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      return args.resolution(mwResult ?? {}) as never;
    });

  // --- Phase 1 ---------------------------------------------------------------
  // The pool's TRUST BOUNDARY is pool-server/server.ts, which deletes every
  // INTERNAL_DISPATCH_HEADER from a request that did not prove the internal secret — so the
  // local resolver is entitled to assume a sanitized header set. The edge does its own strip
  // inside the handler (it IS the boundary). Model that here, or the harness would report a
  // divergence that the deployment does not have.
  install();
  const m1 = args.makeModule();
  const p1Headers = new Headers({ host: "app.example.com", ...extra });
  for (const name of [...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER]) {
    p1Headers.delete(name);
  }
  const p1 = await createLocalResolver(manifest, m1.module, null, null, undefined).resolve(
    new URL(`${ORIGIN}${target}`),
    p1Headers,
    method,
    new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  );

  // --- Phase 2 ---------------------------------------------------------------
  install();
  const m2 = args.makeModule();
  const requestHeaders: HeaderValue[] = [
    { key: ":path", value: target },
    { key: ":method", value: method },
    { key: ":scheme", value: "http" },
    { key: ":authority", value: "app.example.com" },
    { key: "host", value: "app.example.com" },
    ...Object.entries(extra).map(([key, value]) => ({ key, value })),
  ] as HeaderValue[];
  const p2 = await createRequestHandler(manifest, m2.module)(requestHeaders);

  const setHeaders = p2.requestHeaders?.response?.headerMutation?.setHeaders ?? [];
  const dispatch = (key: string): string | undefined =>
    setHeaders.find((h) => h.header?.key === key)?.header?.value;
  const parseMap = (raw: string | undefined): Record<string, string | string[]> | undefined =>
    raw ? JSON.parse(raw) : undefined;

  return {
    phase1: {
      result: p1,
      calls: m1.calls,
      /** The mutated request-header set, as a plain object for comparison. */
      mwRequestHeaders:
        p1.kind === "route" && p1.middlewareRequestHeaders
          ? Object.fromEntries(p1.middlewareRequestHeaders.entries())
          : undefined,
    },
    phase2: {
      response: p2,
      calls: m2.calls,
      dispatch,
      removeHeaders: p2.requestHeaders?.response?.headerMutation?.removeHeaders ?? [],
      mwRequestHeaders: parseMap(dispatch("x-mw-request-headers")),
      resolvedHeaders: parseMap(dispatch("x-resolved-headers")),
    },
  };
}

describe("Phase 1 / Phase 2 middleware request-header parity (N40 / finding #5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transports the middleware's mutated request headers on BOTH tiers", async () => {
    // THE BUG THIS PINS: `responseToMiddlewareResult` MUTATES the Headers it is handed into the
    // middleware's final request-header set. Phase 1 captured it and pool-server/dispatch.ts
    // installs it as a REPLACEMENT for req.headers; Phase 2 constructed the object inline and
    // threw it away, and the dispatch vocabulary had no transport for it — so
    // `NextResponse.next({ request: { headers } })` was a total no-op in production while
    // `x-mw-evaluated: ran` told the pool the middleware stage was already complete. Probed on
    // a real built fixture: a middleware that strips a spoofed `x-user-id` and sets
    // `x-authenticated-user` accomplished NEITHER at the edge, and the spoofed header reached
    // getServerSideProps.
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/about",
      headers: { "x-user-id": "spoofed-evil" },
      makeModule: () =>
        realArtifact(() =>
          // Keeps `host`, ADDS x-authenticated-user, and — by omitting it from the override
          // list — DELETES the client's x-user-id.
          nextWithRequestHeaders({ "x-authenticated-user": "alice" }, ["host"]),
        ),
      resolution: () => ({
        resolvedPathname: "/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/about", query: {} },
      }),
    });

    // Both tiers derived the same replacement set …
    expect(r.phase2.mwRequestHeaders).toEqual(r.phase1.mwRequestHeaders);
    // … the spoofed header is GONE on both …
    expect(r.phase1.mwRequestHeaders).not.toHaveProperty("x-user-id");
    expect(r.phase2.mwRequestHeaders).not.toHaveProperty("x-user-id");
    // … and the authenticated identity is present on both.
    expect(r.phase1.mwRequestHeaders!["x-authenticated-user"]).toBe("alice");
    expect(r.phase2.mwRequestHeaders!["x-authenticated-user"]).toBe("alice");
    // The transport is inside the secret-gated vocabulary, so a client cannot forge it.
    expect(INTERNAL_DISPATCH_HEADERS as readonly string[]).toContain("x-mw-request-headers");
  });

  it("never lets a client-spoofed x-mw-request-headers survive the extension", async () => {
    // The header is authoritative for the pool, so a client-supplied copy must never reach it —
    // `setHeaders` only overwrites the keys it lists, which is why the handler starts from a
    // full clear set. Two paths to cover.

    // (a) No middleware at all ⇒ nothing authors a header set, so it must be REMOVED.
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      resolvedQuery: {},
      invocationTarget: { pathname: "/about", query: {} },
    } as never);
    const noMw = await createRequestHandler(
      makeManifest(),
      null,
    )([
      { key: ":path", value: "/about" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "http" },
      { key: ":authority", value: "app.example.com" },
      { key: "x-mw-request-headers", value: '{"x-user-id":"spoofed"}' },
    ] as HeaderValue[]);
    const noMwSet = noMw.requestHeaders!.response!.headerMutation!.setHeaders ?? [];
    expect(noMwSet.find((h) => h.header.key === "x-mw-request-headers")).toBeUndefined();
    expect(noMw.requestHeaders!.response!.headerMutation!.removeHeaders).toContain(
      "x-mw-request-headers",
    );

    // (b) Middleware DID run ⇒ the value is the tier's own derivation, and the spoofed content
    // is nowhere in it (the handler strips the whole vocabulary on ingress, so the spoof never
    // even reaches ctx.headers or middleware).
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/about",
      headers: { "x-mw-request-headers": '{"x-user-id":"spoofed"}' },
      makeModule: () => realArtifact(() => new Response(null, { status: 200 })),
      resolution: () => ({
        resolvedPathname: "/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/about", query: {} },
      }),
    });
    expect(r.phase2.mwRequestHeaders).toEqual(r.phase1.mwRequestHeaders);
    expect(r.phase2.mwRequestHeaders).not.toHaveProperty("x-user-id");
    expect(r.phase2.mwRequestHeaders).not.toHaveProperty("x-mw-request-headers");
    expect(r.phase1.mwRequestHeaders).not.toHaveProperty("x-mw-request-headers");
  });
});

/**
 * N40b. The i18n TRAILING-SLASH RETRY is a continuation of a request whose middleware verdict is
 * already in hand: both tiers refuse to invoke middleware a second time (Phase 1
 * `middlewareAlreadyRan`, Phase 2 `retry.middlewareAlreadyRan`). That makes the first pass's
 * mutated request headers UNREPRODUCIBLE on the retry — and both tiers used to drop them while
 * still telling the pool the middleware stage was complete (Phase 2 stamps a trusted
 * `x-mw-evaluated: ran`; Phase 1 simply skips its own middleware). The handler therefore ran with
 * the CLIENT's headers: an auth middleware's header deletion and credential injection undone by a
 * trailing-slash retry, which is the exact bypass class N40 exists to close.
 *
 * Driven through both real entry points with the REAL `responseToMiddlewareResult`.
 */
async function bothTiersThroughRetry(args: {
  manifest: RoutingManifest;
  /** Public (unprefixed) request target — the locale prefix is added internally. */
  target: string;
  /** Where the spurious internal redirect points (locale-prefixed `target`). */
  retryTarget: string;
  headers?: Record<string, string>;
  makeModule: () => {
    module: Record<string, unknown>;
    calls: { path: string; url: string; nextConfig?: unknown }[];
  };
}) {
  const { manifest, target, retryTarget } = args;
  const extra = args.headers ?? {};

  // Pass 1 returns the spurious internal redirect (locale-stripped target == request path,
  // status 308 ⇒ normalizeResolvedRedirect answers `retry`); pass 2 routes normally. The mock
  // invokes middleware on BOTH passes, exactly as the real resolveRoutes does — so each tier's
  // own single-pass guard is what keeps middleware from running twice.
  const install = () => {
    const state = { passes: 0 };
    vi.mocked(resolveRoutes).mockImplementation(async (params: any) => {
      await params.invokeMiddleware({
        url: params.url,
        headers: params.headers,
        requestBody: params.requestBody,
      });
      state.passes += 1;
      if (state.passes === 1) {
        return { redirect: { url: new URL(`${ORIGIN}${retryTarget}`), status: 308 } } as never;
      }
      return {
        resolvedPathname: retryTarget,
        resolvedQuery: {},
        invocationTarget: { pathname: retryTarget, query: {} },
      } as never;
    });
    return state;
  };

  // --- Phase 1 ---------------------------------------------------------------
  const s1 = install();
  const m1 = args.makeModule();
  const p1Headers = new Headers({ host: "app.example.com", ...extra });
  for (const name of [...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER]) p1Headers.delete(name);
  const p1 = await createLocalResolver(manifest, m1.module, null, null, undefined).resolve(
    new URL(`${ORIGIN}${target}`),
    p1Headers,
    "GET",
    new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
  );

  // --- Phase 2 ---------------------------------------------------------------
  const s2 = install();
  const m2 = args.makeModule();
  const p2 = await createRequestHandler(
    manifest,
    m2.module,
  )([
    { key: ":path", value: target },
    { key: ":method", value: "GET" },
    { key: ":scheme", value: "http" },
    { key: ":authority", value: "app.example.com" },
    { key: "host", value: "app.example.com" },
    ...Object.entries(extra).map(([key, value]) => ({ key, value })),
  ] as HeaderValue[]);
  const setHeaders = p2.requestHeaders?.response?.headerMutation?.setHeaders ?? [];
  const dispatch = (key: string): string | undefined =>
    setHeaders.find((h) => h.header?.key === key)?.header?.value;
  const raw = dispatch("x-mw-request-headers");

  return {
    phase1: {
      result: p1,
      passes: s1.passes,
      calls: m1.calls,
      mwRequestHeaders:
        p1.kind === "route" && p1.middlewareRequestHeaders
          ? Object.fromEntries(p1.middlewareRequestHeaders.entries())
          : undefined,
    },
    phase2: {
      response: p2,
      passes: s2.passes,
      calls: m2.calls,
      dispatch,
      mwRequestHeaders: raw ? (JSON.parse(raw) as Record<string, string | string[]>) : undefined,
    },
  };
}

describe("Phase 1 / Phase 2 trailing-slash retry parity (N40b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const retryManifest = () =>
    makeManifest({
      i18n: { locales: ["en", "fr"], defaultLocale: "en" } as never,
      pathnames: ["/about", "/en/about"],
      poolAssignments: { "/about": "ssr", "/en/about": "ssr" },
    });

  it("carries the middleware's mutated request headers THROUGH the retry on BOTH tiers", async () => {
    const r = await bothTiersThroughRetry({
      manifest: retryManifest(),
      target: "/about",
      retryTarget: "/en/about",
      headers: { "x-user-id": "spoofed-evil" },
      makeModule: () =>
        realArtifact(() =>
          // Keeps `host`, ADDS x-authenticated-user, and — by omitting it from the override
          // list — DELETES the client's spoofed x-user-id.
          nextWithRequestHeaders({ "x-authenticated-user": "alice" }, ["host"]),
        ),
    });

    // The retry really happened on both tiers (two resolveRoutes passes each) …
    expect(r.phase1.passes).toBe(2);
    expect(r.phase2.passes).toBe(2);
    // … middleware still ran exactly ONCE per tier (the single-pass contract) …
    expect(r.phase1.calls).toHaveLength(1);
    expect(r.phase2.calls).toHaveLength(1);

    // … and the header set that survived is the MIDDLEWARE's, not the client's, on both tiers.
    expect(r.phase2.mwRequestHeaders).toEqual(r.phase1.mwRequestHeaders);
    expect(r.phase1.mwRequestHeaders).toBeDefined();
    expect(r.phase1.mwRequestHeaders).not.toHaveProperty("x-user-id");
    expect(r.phase2.mwRequestHeaders).not.toHaveProperty("x-user-id");
    expect(r.phase1.mwRequestHeaders!["x-authenticated-user"]).toBe("alice");
    expect(r.phase2.mwRequestHeaders!["x-authenticated-user"]).toBe("alice");

    // Phase 2 pairs it with the trusted verdict — which is precisely why losing the set is a
    // bypass and not a cosmetic loss: `ran` tells the pool not to re-derive it.
    expect(r.phase2.dispatch("x-mw-evaluated")).toBe("ran");
    // Phase 1 needs no verdict header: it IS the pool, and the set rides on the resolution.
    expect(r.phase1.result.kind).toBe("route");
  });
});

describe("Phase 1 / Phase 2 middleware invocation-path parity (N40 / finding #6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const i18nBasePathManifest = () =>
    makeManifest({
      basePath: "/docs",
      i18n: { locales: ["en", "nl-NL"], defaultLocale: "en" } as never,
      pathnames: ["/docs/about", "/docs/en/about"],
      poolAssignments: { "/docs/about": "ssr", "/docs/en/about": "ssr" },
    });

  it("invokes the GENERATED HANDLER on both tiers for the real 16.2 artifact shape", async () => {
    // THE BUG THIS PINS: for `{ default: { default, handler } }`, `middlewareModule.default` is
    // an object, so Phase 2's path 1 — the only one that passed `manifestNextConfig` — was
    // UNREACHABLE and every request fell to the legacy path with NO config at all. Measured on
    // a real built fixture with `basePath: '/docs'` + i18n: middleware saw
    // `nextUrl.pathname = '/docs/about'`, `locale = ''` at the edge versus `/about` / `en` in
    // the pool and under `next start`, so a `pathname === '/admin'` gate silently failed to
    // fire in production only.
    const r = await bothTiersWithMiddleware({
      manifest: i18nBasePathManifest(),
      target: "/docs/about",
      makeModule: () => realArtifact(() => new Response(null, { status: 200 })),
      resolution: () => ({
        resolvedPathname: "/docs/en/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/docs/en/about", query: {} },
      }),
    });
    expect(r.phase1.calls.map((c) => c.path)).toEqual(["generatedHandler"]);
    expect(r.phase2.calls.map((c) => c.path)).toEqual(["generatedHandler"]);
    // Same URL handed to the same entrypoint ⇒ the same nextUrl normalization on both tiers.
    expect(r.phase2.calls[0]!.url).toBe(r.phase1.calls[0]!.url);
  });

  it("passes the build's nextConfig on the LEGACY path on both tiers", async () => {
    // A legacy-only artifact has no `handler`, so both tiers land on path 2. Phase 1 didn't
    // pass `nextConfig` there either, so this class was reachable on BOTH tiers for that shape.
    // MEASURED on the real 16.2.10 legacy wrapper: without `nextConfig` the middleware sees
    // `/docs/about` / locale ""; with it, `/about` / locale "en" / basePath "/docs" —
    // byte-identical to the generated handler.
    const r = await bothTiersWithMiddleware({
      manifest: i18nBasePathManifest(),
      target: "/docs/about",
      makeModule: () => legacyOnlyArtifact(() => new Response(null, { status: 200 })),
      resolution: () => ({
        resolvedPathname: "/docs/en/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/docs/en/about", query: {} },
      }),
    });
    expect(r.phase1.calls.map((c) => c.path)).toEqual(["legacy"]);
    expect(r.phase2.calls.map((c) => c.path)).toEqual(["legacy"]);
    const expected = {
      basePath: "/docs",
      i18n: { locales: ["en", "nl-NL"], defaultLocale: "en" },
      trailingSlash: undefined,
    };
    expect(r.phase1.calls[0]!.nextConfig).toEqual(expected);
    expect(r.phase2.calls[0]!.nextConfig).toEqual(expected);
  });

  it("keeps the three invocation paths separate and ordered (hard invariant)", () => {
    // A behavioral test can only catch the shapes its fixtures cover. This one catches the ACT
    // of collapsing the ladder, which is the change that has repeatedly broken middleware
    // invocation: each tier must still name every path.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
    for (const tier of ["pool-server/resolve.ts", "routing-service/handler.ts"]) {
      const src = read(tier);
      for (const marker of [
        "generatedHandler",
        "adapterFn",
        "legacyMiddlewareFn",
        "handlerFn",
        "Path 1",
        "Path 2",
        "Path 3",
      ]) {
        expect(src, `${tier} lost ${marker}`).toContain(marker);
      }
    }
  });
});

describe("Phase 1 / Phase 2 middleware response parity (N40 / findings #16, #35, binary body)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the request query onto a rule redirect even when middleware ran (#35)", async () => {
    // THE BUG THIS PINS: both tiers passed `middlewareResponse != null` as `middlewareAuthored`,
    // which is TRUE for a plain `NextResponse.next()`. Since a typical matcher covers `/(.*)`,
    // the N15 request-query carry was inert for every app with middleware — and the App Router
    // flight client REQUIRES `_rsc` to survive the hop. Measured against `next start` on a
    // built fixture: `GET /docs/redirect-src?foo=1` → `location: /docs/about?foo=1`.
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/redirect-src?foo=1",
      makeModule: () =>
        // A plain next() — no `location`, so it is NOT a middleware-authored redirect.
        realArtifact(
          () => new Response(null, { status: 200, headers: { "x-middleware-next": "1" } }),
        ),
      resolution: () => ({
        // The shape @next/routing reports for a header-only `redirects()` rule.
        status: 307,
        resolvedHeaders: new Headers({ location: "/about" }),
      }),
    });
    if (r.phase1.result.kind !== "redirect") {
      throw new Error(`Phase 1 did not redirect: ${JSON.stringify(r.phase1.result)}`);
    }
    expect(r.phase1.result.url.pathname + r.phase1.result.url.search).toBe("/about?foo=1");
    const p2Headers = r.phase2.response.immediateResponse!.headers!.setHeaders!;
    expect(p2Headers.find((h) => h.header.key === "location")!.header.value).toBe("/about?foo=1");
  });

  it("does NOT carry the request query onto a MIDDLEWARE-authored redirect (either tier)", async () => {
    // The other half of the discriminator: a middleware `Location` is authoritative. An
    // unguarded carry here broke e2e/middleware-redirects with ERR_TOO_MANY_REDIRECTS.
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/gated?foo=1",
      makeModule: () =>
        realArtifact(() => new Response(null, { status: 307, headers: { location: "/login" } })),
      resolution: (mw) => ({
        status: 307,
        resolvedHeaders: new Headers({ location: "/login" }),
        ...mw,
      }),
    });
    if (r.phase1.result.kind !== "redirect") {
      throw new Error(`Phase 1 did not redirect: ${JSON.stringify(r.phase1.result)}`);
    }
    expect(r.phase1.result.url.pathname + r.phase1.result.url.search).toBe("/login");
    const p2Headers = r.phase2.response.immediateResponse!.headers!.setHeaders!;
    expect(p2Headers.find((h) => h.header.key === "location")!.header.value).toBe("/login");
  });

  it("hands an external rewrite to the pool on the edge instead of a 502 (#16)", async () => {
    // Phase 1 returns `external-rewrite` and pool-server/dispatch.ts proxies it — matching
    // `next start`, which was measured proxying a `https://example.com/probe` rewrite (the
    // response carried example.com's own body and `server: cloudflare`). The edge authored a
    // 502 instead, and the CEL is `!(…)` whenever middleware exists, so the route worked in the
    // pool-only e2e harness and 502'd in production.
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/ext-rewrite",
      makeModule: () =>
        realArtifact(
          () => new Response(null, { status: 200, headers: { "x-middleware-next": "1" } }),
        ),
      resolution: () => ({ externalRewrite: new URL("https://example.com/probe") }),
    });
    expect(r.phase1.result.kind).toBe("external-rewrite");
    // The edge must NOT author a response the pool would have proxied …
    expect(r.phase2.response.immediateResponse).toBeUndefined();
    // … and must clear the WHOLE vocabulary (plus the secret) so the pool re-resolves untrusted.
    expect(r.phase2.dispatch("x-mw-evaluated")).toBeUndefined();
    expect(new Set(r.phase2.removeHeaders)).toEqual(
      new Set([...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER]),
    );
  });

  it("keeps a binary middleware-authored body byte-exact on both tiers", async () => {
    // THE BUG THIS PINS: the edge forwarded `await mwRes.text()`, which server.ts re-encoded as
    // UTF-8 — every byte >= 0x80 became U+FFFD (3 bytes). Measured with an 8-byte PNG
    // signature: 10 bytes on the wire, against a forwarded `content-length: 8`. Phase 1 streams
    // the real body.
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = await bothTiersWithMiddleware({
      manifest: makeManifest(),
      target: "/icon",
      makeModule: () =>
        realArtifact(
          () =>
            new Response(PNG, {
              status: 200,
              headers: { "content-type": "image/png", "content-length": String(PNG.length) },
            }),
        ),
      resolution: () => ({ middlewareResponded: true }),
    });
    if (r.phase1.result.kind !== "middleware-response") {
      throw new Error(`Phase 1 shape: ${JSON.stringify(r.phase1.result)}`);
    }
    const p1Bytes = new Uint8Array(await r.phase1.result.response.clone().arrayBuffer());
    const p2Body = r.phase2.response.immediateResponse!.body;
    expect(p2Body).toBeInstanceOf(Uint8Array);
    expect([...(p2Body as Uint8Array)]).toEqual([...p1Bytes]);
    expect([...(p2Body as Uint8Array)]).toEqual([...PNG]);
    // The middleware's own content-length is never forwarded: the edge re-frames the body and a
    // stale length makes Envoy send a truncated or stalled response. (The redirect branch
    // already skipped it; this one didn't.)
    const p2Headers = r.phase2.response.immediateResponse!.headers!.setHeaders!;
    expect(p2Headers.map((h) => h.header.key.toLowerCase())).not.toContain("content-length");
  });
});

describe("Phase 1 / Phase 2 malformed-authority parity (N40)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The pool reaches parseRequestUrl in pool-server/index.ts (→ 400); the edge now reaches the
  // same shared function. Both must REJECT an authority that is not a bare host — it feeds
  // detectDomainLocale, `has: { type: "host" }` matcher gating and the redirect same-origin
  // test, and the edge used to splice it in verbatim.
  for (const authority of ["evil.com/foo", "evil.com/foo?x=1", "user@evil.com", "evil.com#f"]) {
    it(`rejects :authority ${JSON.stringify(authority)} on both tiers`, async () => {
      expect(() => parseRequestUrl("/about", authority)).toThrow();

      vi.mocked(resolveRoutes).mockResolvedValue({
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about", query: {} },
      } as never);
      const p2 = await createRequestHandler(
        makeManifest(),
        null,
      )([
        { key: ":path", value: "/about" },
        { key: ":method", value: "GET" },
        { key: ":scheme", value: "https" },
        { key: ":authority", value: authority },
      ] as HeaderValue[]);
      expect(p2.immediateResponse!.status!.code).toBe(400);
      // Never resolved — the malformed authority must not reach routing or middleware.
      expect(resolveRoutes).not.toHaveBeenCalled();
    });
  }

  it("keeps a legitimate host:port authority working (and keeps the https scheme)", async () => {
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as never);
    const p2 = await createRequestHandler(
      makeManifest(),
      null,
    )([
      { key: ":path", value: "/about?q=1" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "app.example.com:8443" },
    ] as HeaderValue[]);
    expect(p2.immediateResponse).toBeUndefined();
    const url = (vi.mocked(resolveRoutes).mock.calls[0]![0] as { url: URL }).url;
    expect(url.origin).toBe("https://app.example.com:8443");
    expect(url.pathname + url.search).toBe("/about?q=1");
  });

  it("308s a protocol-relative request target instead of adopting its authority", async () => {
    // N10 regression guard, now exercised through the edge too: `//evil.example/x` must stay a
    // PATH so the shared repeated-slash 308 normalizes it, exactly as `next start` does.
    const p2 = await createRequestHandler(
      makeManifest(),
      null,
    )([
      { key: ":path", value: "//evil.example/x" },
      { key: ":method", value: "GET" },
      { key: ":scheme", value: "https" },
      { key: ":authority", value: "app.example.com" },
    ] as HeaderValue[]);
    expect(p2.immediateResponse!.status!.code).toBe(308);
    const loc = p2.immediateResponse!.headers!.setHeaders!.find((h) => h.header.key === "location")!
      .header.value;
    expect(loc).toBe("https://app.example.com/evil.example/x");
  });
});

describe("Phase 1 / Phase 2 rewrite-invocation parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restores repeated rewrite-destination query keys identically in both tiers", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?item=one&item=two"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        // Collapsed query — what @next/routing currently reports for the destination above.
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBe("/api/hello?item=one&item=two");
    expect(r.phase1.invocationQuery).toEqual({ item: ["one", "two"] });
  });

  it("filters @next/routing internal capture params ($nxtP*, _rsc) identically", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?keep=1"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: {
          // dropped: internal capture KEY
          nxtPslug: "hello",
          // dropped: unmatched optional catch-all SENTINEL VALUE
          rest: "$nxtPrest",
          // dropped: the RSC union query
          _rsc: "abc12",
          keep: "1",
        },
        invocationTarget: { pathname: "/api/hello", query: { keep: "1" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invocationQuery).toEqual({ keep: "1" });
    expect(r.phase1.invokePath).toBe("/api/hello?keep=1");
  });

  it("percent-encodes invocation query values identically (and keeps repeats)", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?q=caf%C3%A9&q=au%20lait"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { q: "au lait", plus: "a+b", slash: "x/y", amp: "a&b" },
        invocationTarget: { pathname: "/api/hello", query: { q: "au lait" } },
      },
    });
    expectTiersAgree(r);
    // URLSearchParams form-encoding: space -> "+", "+" -> "%2B", "/" -> "%2F", "&" -> "%26".
    expect(r.phase1.invokePath).toBe(
      "/api/hello?q=caf%C3%A9&q=au+lait&plus=a%2Bb&slash=x%2Fy&amp=a%26b",
    );
    expect(r.phase1.invocationQuery).toEqual({
      q: ["café", "au lait"],
      plus: "a+b",
      slash: "x/y",
      amp: "a&b",
    });
  });

  it("keeps a percent-encoded rewrite target pathname byte-identical in both tiers", async () => {
    const manifest = withRewrite(
      makeManifest({
        pathnames: ["/", "/blog/[slug]"],
        poolAssignments: { "/": "ssr", "/blog/[slug]": "ssr" },
      }),
      "/blog/caf%C3%A9",
    );
    const r = await bothTiers({
      manifest,
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/blog/[slug]",
        resolvedQuery: {},
        invocationTarget: { pathname: "/blog/caf%C3%A9", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBe("/blog/caf%C3%A9");
  });

  it("emits an invokePath with NO query string when the invocation query is empty", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: {},
        invocationTarget: { pathname: "/api/hello", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBe("/api/hello");
    // No "?" — an empty query must not produce a bare question mark on either tier.
    expect(r.phase2.invokePath).not.toContain("?");
  });

  it("merges the request query with the destination query identically (destination wins)", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?item=one&item=two"),
      target: "/rewrite-source?foo=1&item=client",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { foo: "1", item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { foo: "1", item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invocationQuery).toEqual({ foo: "1", item: ["one", "two"] });
    expect(r.phase1.invokePath).toBe("/api/hello?foo=1&item=one&item=two");
  });

  it("derives NO invocation target when routing did not rewrite (both tiers)", async () => {
    const r = await bothTiers({
      manifest: makeManifest(),
      target: "/about?foo=1",
      resolution: {
        resolvedPathname: "/about",
        resolvedQuery: { foo: "1" },
        invocationTarget: { pathname: "/about", query: { foo: "1" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBeUndefined();
    expect(r.phase2.invokePath).toBeUndefined();
  });

  it("derives NO invocation target for an RSC request (client reconciles via headers)", async () => {
    const manifest = withRewrite(makeManifest(), "/api/hello?item=one&item=two");
    const rscHeader = manifest.routeGraph.rsc?.header ?? "rsc";
    const r = await bothTiers({
      manifest,
      target: "/rewrite-source",
      headers: { [rscHeader]: "1" },
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBeUndefined();
    // The query record is still derived (and restored) on both tiers — only the path is
    // withheld — so the pool/client see the same rewrite query either way.
    expect(r.phase1.invocationQuery).toEqual({ item: ["one", "two"] });
  });

  it("derives NO invocation target for a Pages /_next/data request", async () => {
    const manifest = withRewrite(
      makeManifest({ pathnames: ["/", "/about", "/api/hello", "/rewrite-source"] }),
      "/api/hello?item=one&item=two",
    );
    const r = await bothTiers({
      manifest,
      target: "/_next/data/test123/rewrite-source.json",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBeUndefined();
  });

  it("treats an unresolved optional-catch-all sentinel as a non-target on both tiers", async () => {
    // Shape transcribed from the empirically recorded one in
    // tests/pool-server/resolve.test.ts ("does not expose unresolved optional catch-all
    // sentinels"): the target arrives PERCENT-ENCODED ("/%24nxtPslug").
    const manifest = makeManifest({
      pathnames: ["/[[...slug]]"],
      poolAssignments: { "/[[...slug]]": "ssr" },
    });
    const r = await bothTiers({
      manifest,
      target: "/",
      resolution: {
        resolvedPathname: "/[[...slug]]",
        resolvedQuery: { nxtPslug: "$nxtPslug" },
        invocationTarget: { pathname: "/%24nxtPslug", query: { nxtPslug: "$nxtPslug" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBeUndefined();
    expect(r.phase1.outputId).toBe("/[[...slug]]");
  });

  it("strips an internally-added i18n locale from the invocation path on both tiers", async () => {
    const manifest = withRewrite(
      makeManifest({
        i18n: { locales: ["en", "fr"], defaultLocale: "en" } as never,
        pathnames: ["/", "/rewritten"],
        poolAssignments: { "/": "ssr", "/rewritten": "ssr" },
      }),
      "/rewritten?item=one&item=two",
    );
    const r = await bothTiers({
      manifest,
      target: "/rewrite-source",
      resolution: {
        // prefixRequestLocale prefixed the internal URL, so routing reports locale-prefixed
        // internals; the handler must be invoked with the UNPREFIXED path.
        resolvedPathname: "/en/rewritten",
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/en/rewritten", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.invokePath).toBe("/rewritten?item=one&item=two");
  });
});

/**
 * N19. `x-nextjs-rewritten-path` / `x-nextjs-rewritten-query` — the BROWSER-FACING App Router
 * rewrite signal (upstream `client/route-params.ts` getRenderedPathname/getRenderedSearch read
 * them off the RSC fetch `Response`; `build/generate-routes-manifest.ts` declares both names to
 * adapters as `rewriteHeaders`).
 *
 * THE BUG THESE PIN: upstream emits the signal from two layers — `server/web/adapter.ts` for
 * middleware rewrites (which lands in the middleware response headers both tiers already
 * transport) and `server/lib/router-utils/resolve-routes.ts` for next.config rewrites (the
 * router-server layer this adapter replaces). Only Phase 1 re-emitted the second class, so a
 * next.config rewrite lost its client signalling on the PRODUCTION path (Envoy → ext_proc →
 * pool) while looking perfect in the e2e harness, which starts the pool alone. Verified live
 * against `next start`: `/rewrite-query-array` answered p=/api/rewrite-query-array
 * q=item=one&item=two on `next start` and Phase 1, and NOTHING through the edge.
 */
describe("Phase 1 / Phase 2 client rewrite-signal parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** RSC-request variant of bothTiers: the signal is RSC-only on both tiers (mirroring the
   * `isRSCRequest` / `isRSCRequestHeader` guards at both upstream emission sites). */
  const rscTiers = (args: Parameters<typeof bothTiers>[0]) => {
    const rscHeader = args.manifest.routeGraph.rsc?.header ?? "rsc";
    return bothTiers({ ...args, headers: { [rscHeader]: "1", ...(args.headers ?? {}) } });
  };

  it("emits the rewrite signal for a next.config rewrite on BOTH tiers (repeated query keys)", async () => {
    const r = await rscTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?item=one&item=two"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        // Collapsed query — what @next/routing reports for the destination above.
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBe("/api/hello");
    // No leading "?" — upstream slices it off before setting the header.
    expect(r.phase1.rewrittenQuery).toBe("item=one&item=two");
    expect(r.phase2.rewrittenPath).toBe("/api/hello");
    expect(r.phase2.rewrittenQuery).toBe("item=one&item=two");
  });

  it("filters internal capture params ($nxtP*, _rsc) out of the signalled query on both tiers", async () => {
    const r = await rscTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?keep=1"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: {
          nxtPslug: "hello", // internal capture KEY
          rest: "$nxtPrest", // unmatched optional catch-all SENTINEL VALUE
          _rsc: "abc12", // the RSC union query
          keep: "1",
        },
        invocationTarget: { pathname: "/api/hello", query: { keep: "1" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenQuery).toBe("keep=1");
  });

  it("percent-encodes the signalled query identically on both tiers", async () => {
    const r = await rscTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?q=caf%C3%A9&q=au%20lait"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { q: "au lait", plus: "a+b", slash: "x/y", amp: "a&b" },
        invocationTarget: { pathname: "/api/hello", query: { q: "au lait" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenQuery).toBe("q=caf%C3%A9&q=au+lait&plus=a%2Bb&slash=x%2Fy&amp=a%26b");
  });

  it("keeps a percent-encoded rewrite target pathname byte-identical in the signal", async () => {
    const r = await rscTiers({
      manifest: withRewrite(
        makeManifest({
          pathnames: ["/", "/blog/[slug]"],
          poolAssignments: { "/": "ssr", "/blog/[slug]": "ssr" },
        }),
        "/blog/caf%C3%A9",
      ),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/blog/[slug]",
        resolvedQuery: {},
        invocationTarget: { pathname: "/blog/caf%C3%A9", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBe("/blog/caf%C3%A9");
    expect(r.phase1.rewrittenQuery).toBeFalsy();
  });

  it("strips the internally-added i18n locale from the signalled path on both tiers", async () => {
    const r = await rscTiers({
      manifest: withRewrite(
        makeManifest({
          i18n: { locales: ["en", "fr"], defaultLocale: "en" } as never,
          pathnames: ["/", "/rewritten"],
          poolAssignments: { "/": "ssr", "/rewritten": "ssr" },
        }),
        "/rewritten",
      ),
      target: "/rewrite-source",
      resolution: {
        // prefixRequestLocale prefixed the internal URL; the CLIENT must never see /en.
        resolvedPathname: "/en/rewritten",
        resolvedQuery: {},
        invocationTarget: { pathname: "/en/rewritten", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBe("/rewritten");
  });

  it("signals a query-only rewrite (path unchanged ⇒ no path header) on both tiers", async () => {
    const manifest = makeManifest({
      pathnames: ["/", "/rewrite-source"],
      poolAssignments: { "/": "ssr", "/rewrite-source": "ssr" },
    });
    const r = await rscTiers({
      manifest: withRewrite(manifest, "/rewrite-source?key=value"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/rewrite-source",
        resolvedQuery: { key: "value" },
        invocationTarget: { pathname: "/rewrite-source", query: { key: "value" } },
      },
    });
    expectTiersAgree(r);
    // Upstream compares each component independently (requestURL.pathname !==
    // destination.pathname / requestURL.search !== destination.search).
    expect(r.phase1.rewrittenPath).toBeFalsy();
    expect(r.phase1.rewrittenQuery).toBe("key=value");
  });

  it("emits NO signal for a document (non-RSC) request even though it IS rewritten", async () => {
    const r = await bothTiers({
      manifest: withRewrite(makeManifest(), "/api/hello?item=one&item=two"),
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/api/hello",
        resolvedQuery: { item: "two" },
        invocationTarget: { pathname: "/api/hello", query: { item: "two" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBeFalsy();
    expect(r.phase1.rewrittenQuery).toBeFalsy();
    // A document request is instead served through the rewritten INVOCATION path.
    expect(r.phase1.invokePath).toBe("/api/hello?item=one&item=two");
  });

  it("emits NO signal when routing did not rewrite (both tiers)", async () => {
    const r = await rscTiers({
      manifest: makeManifest(),
      target: "/about?foo=1",
      resolution: {
        resolvedPathname: "/about",
        resolvedQuery: { foo: "1" },
        invocationTarget: { pathname: "/about", query: { foo: "1" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBeFalsy();
    expect(r.phase1.rewrittenQuery).toBeFalsy();
  });

  it("never signals an unresolved optional-catch-all sentinel to the client", async () => {
    // `/%24nxtPslug` is a @next/routing sentinel, not a public URL. Sending it as
    // x-nextjs-rewritten-path hands the client router a pathname whose segment count does not
    // match the route tree — the exact failure upstream's client/route-params.ts documents.
    const r = await rscTiers({
      manifest: makeManifest({
        pathnames: ["/[[...slug]]"],
        poolAssignments: { "/[[...slug]]": "ssr" },
      }),
      target: "/",
      resolution: {
        resolvedPathname: "/[[...slug]]",
        resolvedQuery: { nxtPslug: "$nxtPslug" },
        invocationTarget: { pathname: "/%24nxtPslug", query: { nxtPslug: "$nxtPslug" } },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.rewrittenPath).toBeFalsy();
    expect(r.phase1.rewrittenQuery).toBeFalsy();
  });
});

describe("Phase 1 / Phase 2 output-key parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the concrete rewrite destination over a dynamic template on BOTH tiers", async () => {
    // This is the drift the shared resolveOutputPathname fixed: a rewrite `/rewrite-source ->
    // /gssp` where a `/[slug]` dynamic route also matches the destination. @next/routing
    // reports resolvedPathname `/[slug]` with invocationTarget `/gssp` — the real page. The
    // pool consulted the INVOCATION TARGET; the edge only ever consulted the PUBLIC pathname
    // (which is a rewrite source, not an output), so it dispatched the `[slug]` template.
    const manifest = withRewrite(
      makeManifest({
        pathnames: ["/", "/gssp", "/[slug]"],
        poolAssignments: { "/gssp": "ssr", "/[slug]": "ssr" },
      }),
      "/gssp",
    );
    const r = await bothTiers({
      manifest,
      target: "/rewrite-source",
      resolution: {
        resolvedPathname: "/[slug]",
        resolvedQuery: {},
        invocationTarget: { pathname: "/gssp", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.outputId).toBe("/gssp");
    expect(r.phase2.outputId).toBe("/gssp");
  });

  it("does not let a filesystem sibling undo a beforeFiles rewrite on either tier", async () => {
    // `/featured` is a real output AND a rewrite source pointing at `/some-team`. Preferring
    // the public pathname's concrete output would silently undo the rewrite.
    const manifest = makeManifest({
      pathnames: ["/featured", "/some-team", "/[teamSlug]"],
      poolAssignments: { "/featured": "ssr", "/some-team": "ssr", "/[teamSlug]": "ssr" },
    });
    manifest.routeGraph.beforeFiles = [
      { source: "/featured", sourceRegex: "^\\/featured(?:\\/)?$", destination: "/some-team" },
    ] as never;
    const r = await bothTiers({
      manifest,
      target: "/featured",
      resolution: {
        resolvedPathname: "/[teamSlug]",
        resolvedQuery: {},
        invocationTarget: { pathname: "/some-team", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.outputId).toBe("/some-team");
  });

  it("maps an RSC request to the .rsc output variant on both tiers", async () => {
    const manifest = makeManifest({
      pathnames: ["/", "/about"],
      poolAssignments: { "/": "ssr", "/about": "ssr", "/about.rsc": "ssr" },
    });
    const rscHeader = manifest.routeGraph.rsc?.header ?? "rsc";
    const r = await bothTiers({
      manifest,
      target: "/about",
      headers: { [rscHeader]: "1" },
      resolution: {
        resolvedPathname: "/about",
        resolvedQuery: {},
        invocationTarget: { pathname: "/about", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.outputId).toBe("/about.rsc");
  });

  it("prefers a concrete output over a dynamic template for a NON-rewritten request", async () => {
    const manifest = makeManifest({
      pathnames: ["/sticks & stones", "/[slug]"],
      poolAssignments: { "/sticks & stones": "ssr", "/[slug]": "ssr" },
    });
    const r = await bothTiers({
      manifest,
      target: "/sticks%20%26%20stones",
      resolution: {
        resolvedPathname: "/[slug]",
        resolvedQuery: {},
        invocationTarget: { pathname: "/sticks%20%26%20stones", query: {} },
      },
    });
    expectTiersAgree(r);
    expect(r.phase1.outputId).toBe("/sticks & stones");
  });
});

// A behavioral test can only catch a re-divergence that the fixtures happen to cover. This
// one catches the ACT of re-declaring a shared helper in either tier, which is how the drift
// happened the first time (four private copies that were byte-identical until they weren't).
describe("no tier re-declares a shared routing helper", () => {
  const SHARED = [
    "mergeInvocationQuery",
    "restoreRepeatedRewriteQuery",
    "filterInternalQuery",
    "buildQueryString",
    "queryFromUrl",
    "computeRewriteInvocation",
    // N19: the client-facing rewrite signal. Phase 2 had NO derivation at all (the bug); a
    // private copy in either tier is the drift that would silently un-fix it.
    "computeRewriteSignalHeaders",
    "applyRewriteSignalHeaders",
    "stripAddedLocale",
    "isRscRequest",
    "resolveOutputPathname",
    "normalizeMatchedPathname",
    "preferConcreteOutput",
    "getRscConfig",
    // N40. Each of these was a tier divergence:
    //  - middlewareAuthoredRedirect: both tiers spelled the discriminator as
    //    `middlewareResponse != null`, which is true for a plain NextResponse.next() (#35).
    //  - serializeHeaderMap: the edge had a private serializer for `x-resolved-headers`; the
    //    same wire shape now also carries `x-mw-request-headers`, and the pool reads both.
    //  - parseRequestUrl: the edge spliced `:authority` verbatim instead (malformed-authority).
    //  - grantsSharedCacheFreshness / assertValidRoutingManifest: single derivations that both
    //    tiers' consumers depend on.
    "middlewareAuthoredRedirect",
    "serializeHeaderMap",
    "parseRequestUrl",
    "grantsSharedCacheFreshness",
    "assertValidRoutingManifest",
  ];
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

  for (const tier of ["pool-server/resolve.ts", "routing-service/handler.ts"]) {
    it(`${tier} declares none of them locally`, () => {
      const src = read(tier);
      const redeclared = SHARED.filter((name) =>
        new RegExp(
          `^\\s*(?:export\\s+)?(?:async\\s+)?(?:function|const|let)\\s+${name}\\b`,
          "m",
        ).test(src),
      );
      expect(redeclared).toEqual([]);
    });
  }

  it("routing-common.ts exports all of them", () => {
    const src = read("routing-common.ts");
    const missing = SHARED.filter(
      (name) => !new RegExp(`^export function ${name}\\b`, "m").test(src),
    );
    expect(missing).toEqual([]);
  });
});
