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
