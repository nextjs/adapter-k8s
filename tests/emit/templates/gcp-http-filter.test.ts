import { describe, it, expect } from "vitest";
import {
  renderCdnFilter,
  assertCacheKeyClassification,
  DEFAULT_CDN_CACHE_KEY_HEADERS,
  KEYED_DISPATCH_HEADERS,
  NEVER_KEYED_DISPATCH_HEADERS,
  NEXTJS_VARY_HEADERS,
} from "../../../src/emit/templates/gcp-http-filter.js";
import { INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER } from "../../../src/routing-common.js";

describe("renderCdnFilter", () => {
  const yaml = renderCdnFilter({ releaseName: "nextjs" });

  it("emits a GCPHTTPFilter with the verified schema fields", () => {
    expect(yaml).toContain("apiVersion: networking.gke.io/v1");
    expect(yaml).toContain("kind: GCPHTTPFilter");
    expect(yaml).toContain("name: nextjs-cdn");
    expect(yaml).toContain("cacheMode: USE_ORIGIN_HEADERS");
    expect(yaml).toContain("requestCoalescing: true");
    expect(yaml).toContain("negativeCaching: false");
    // Field name verified via kubectl explain against a live ≥1.35 cluster:
    // it is includedHeaderNames, NOT the includeHttpHeaders the docs excerpt suggested.
    expect(yaml).toContain("includedHeaderNames:");
    expect(yaml).not.toContain("includeHttpHeaders");
  });

  it("keys on the Next.js public Vary set and the dispatch verdict", () => {
    for (const header of NEXTJS_VARY_HEADERS) {
      expect(yaml).toContain(`- ${header}`);
    }
    for (const header of KEYED_DISPATCH_HEADERS) {
      expect(yaml).toContain(`- ${header}`);
    }
  });

  it("omits the duplicate/per-user dispatch headers and never keys the secret", () => {
    expect(yaml).not.toContain("x-matched-pathname");
    expect(yaml).not.toContain("x-internal-secret");
    // N40: x-mw-request-headers carries the middleware's whole final request-header set as
    // JSON, INCLUDING `cookie`. Keying on it would make the cache key per-user and shatter
    // the hit rate; it is safe to omit because the header only exists when middleware ran and
    // a middleware-covered response is forced `no-cache` by the pool (invariant 2).
    expect(yaml).not.toContain("x-mw-request-headers");
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain("x-internal-secret");
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain("x-matched-pathname");
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain("x-mw-request-headers");
  });

  it("rejects a cache-key list containing the internal secret header", () => {
    expect(() =>
      renderCdnFilter({ releaseName: "nextjs", cacheKeyHeaders: ["RSC", "X-Internal-Secret"] }),
    ).toThrow(/never be part of the CDN cache key/);
  });

  it("rejects cache-key header names with unsafe characters", () => {
    expect(() =>
      renderCdnFilter({ releaseName: "nextjs", cacheKeyHeaders: ["bad header\nname"] }),
    ).toThrow(/Invalid CDN cache-key header/);
  });

  it("rejects an unsafe releaseName", () => {
    expect(() => renderCdnFilter({ releaseName: 'foo";rm -rf /;"' })).toThrow(
      /Invalid releaseName/,
    );
  });

  it("sanitizes the filter name", () => {
    const out = renderCdnFilter({ releaseName: "0-weird" });
    expect(out).toContain("name: b-0-weird-cdn");
  });

  // -------------------------------------------------------------------------
  // N40b — the cache-key classification must be exhaustive, and it must be an
  // ALLOWLIST. The derivation used to be `INTERNAL_DISPATCH_HEADERS.filter(h => h !==
  // "x-matched-pathname")`, so a dispatch header added in routing-common.ts entered the
  // Cloud CDN cache key automatically — which is how `x-mw-request-headers` (the
  // middleware's entire final request-header set, cookie included) got in. These
  // assertions are deliberately GENERAL rather than naming that one header: the list is
  // derived and will grow again.
  // -------------------------------------------------------------------------
  it("classifies EVERY internal dispatch header exactly once (a new one fails loudly)", () => {
    expect(() => assertCacheKeyClassification()).not.toThrow();
    const classified = [...KEYED_DISPATCH_HEADERS, ...NEVER_KEYED_DISPATCH_HEADERS].sort();
    expect(classified).toEqual([...INTERNAL_DISPATCH_HEADERS].sort());
    // Disjoint.
    for (const h of KEYED_DISPATCH_HEADERS) {
      expect(NEVER_KEYED_DISPATCH_HEADERS).not.toContain(h);
    }
  });

  it("keys NOTHING whose name says it carries request-scoped data", () => {
    // A durable guard rather than a per-header one: any header naming a request, cookie,
    // credential, or session cannot be part of a SHARED cache key — it would partition the
    // cache per user (hit rate collapse) or, worse, let one user's entry be served to
    // another if the value ever became forgeable.
    const REQUEST_SCOPED =
      /(^|-)(request|cookie|authorization|auth|token|secret|session|user)(-|$)/i;
    for (const header of DEFAULT_CDN_CACHE_KEY_HEADERS) {
      expect(header, `${header} must not be part of the CDN cache key`).not.toMatch(REQUEST_SCOPED);
    }
    // And the shared secret specifically — keying it would put a credential in a cache key.
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS.map((h) => h.toLowerCase())).not.toContain(
      INTERNAL_SECRET_HEADER,
    );
  });

  it("emits the keyed headers in INTERNAL_DISPATCH_HEADERS order (stable rendered chart)", () => {
    const emitted = [...yaml.matchAll(/^ {8}- (\S+)$/gm)].map((m) => m[1]!);
    expect(emitted).toEqual(DEFAULT_CDN_CACHE_KEY_HEADERS);
    const dispatchPart = emitted.slice(NEXTJS_VARY_HEADERS.length);
    expect(dispatchPart).toEqual(
      INTERNAL_DISPATCH_HEADERS.filter((h) =>
        (KEYED_DISPATCH_HEADERS as readonly string[]).includes(h),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// S10 (SECURITY) — no dispatch header may be in the CDN cache key.
//
// They used to be, justified by a comment claiming the extension mutates them before the cache
// lookup. This repo's own definitive findings doc proves the opposite on the GXLB: the cache
// lookup happens after edge extensions, traffic extensions run last, and "cached key + gate →
// 200" was measured live. So at lookup time those headers carry whatever the CLIENT sent —
// letting any anonymous client mint unbounded distinct entries for one URL (evicting hot
// entries, forcing an origin fetch per request) while partitioning nothing.
// ---------------------------------------------------------------------------
describe("S10: the cache key holds no dispatch header", () => {
  it("keys ONLY the Next.js Vary headers", () => {
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).toEqual([...NEXTJS_VARY_HEADERS]);
  });

  it("excludes every internal dispatch header by name", () => {
    for (const h of INTERNAL_DISPATCH_HEADERS) {
      expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain(h);
    }
    expect(KEYED_DISPATCH_HEADERS).toEqual([]);
  });

  it("still forces an explicit decision on any NEW dispatch header", () => {
    // The classification guard is what keeps this from silently regressing: a header added to
    // routing-common.ts and classified nowhere must fail the render, not default into the key.
    expect(() => assertCacheKeyClassification()).not.toThrow();
    for (const h of INTERNAL_DISPATCH_HEADERS) {
      expect(NEVER_KEYED_DISPATCH_HEADERS).toContain(h);
    }
  });

  it("the rendered filter carries no dispatch header either", () => {
    const yaml = renderCdnFilter({ releaseName: "my-app" });
    for (const h of INTERNAL_DISPATCH_HEADERS) {
      expect(yaml).not.toContain(`- ${h}`);
    }
    expect(yaml).toContain("- RSC");
  });
});
