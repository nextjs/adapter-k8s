// tests/pool-server/route-matches-sanitization.test.ts
//
// The `x-route-matches` sentinel-sanitization contract, pinned from the CONSUMER side.
//
// Why this file exists: the two resolver tiers do not agree on where routeMatches is
// sanitized. Phase 1 (pool-server/resolve.ts) runs its private `sanitizeRouteMatches` before
// returning a resolution; Phase 2 (routing-service/handler.ts) stamps
// `x-route-matches: JSON.stringify(resolution.routeMatches)` with no sanitization at all.
// That asymmetry is currently harmless ONLY because dispatch.ts's `extractRouteParams`
// re-filters per value — so if that filter is ever narrowed, Phase 2 starts leaking
// @next/routing's internal `$nxtP<param>` sentinel into requestMeta.params. These tests are
// the tripwire for that, and the precondition for moving the sanitizer into the shared
// routing-common.ts helper (where both tiers can call it).
//
// The sentinel: @next/routing represents a dynamic capture it could not resolve as the
// literal `$nxtP<param>`. It is a routing artifact, never a value a handler should see —
// routing-common.ts guards against it in two other places (computeRewriteInvocation and
// computeRewriteSignalHeaders) for exactly that reason.
import { describe, expect, it } from "vitest";
import { extractRouteParams } from "../../src/pool-server/dispatch.js";

describe("extractRouteParams sentinel filtering (the Phase-2 compensation)", () => {
  it("drops a sentinel value and leaves the rest of the params alone", () => {
    expect(extractRouteParams("/[lang]/posts/[id]", { nxtPlang: "en", nxtPid: "$nxtPid" })).toEqual(
      { lang: "en" },
    );
  });

  it("reads BOTH the bare name and the nxtP-prefixed transport key", () => {
    expect(extractRouteParams("/posts/[id]", { id: "7" })).toEqual({ id: "7" });
    expect(extractRouteParams("/posts/[id]", { nxtPid: "7" })).toEqual({ id: "7" });
  });

  it("is STRICTLY BROADER than Phase 1's sanitizer — the property the asymmetry rests on", () => {
    // resolve.ts's sanitizeRouteMatches matches /^\$nxtP[^/]*$/ (anchored, no slash);
    // extractRouteParams matches /^\$nxtP/ (unanchored tail). Every value Phase 1 would have
    // removed is therefore also removed here, which is why an UNSANITIZED Phase-2 header
    // cannot produce params Phase 1 would not have produced.
    const phase1Drops = (value: string) => /^\$nxtP[^/]*$/.test(value);
    const consumerDrops = (value: string) => value.startsWith("$nxtP");
    for (const value of [
      "$nxtPid",
      "$nxtPslug",
      "$nxtP",
      "$nxtPslug/nested", // Phase 1 KEEPS this one (it contains a slash); the consumer drops it
      "$nxtPa/b/c",
    ]) {
      if (phase1Drops(value)) expect(consumerDrops(value)).toBe(true);
    }
    expect(phase1Drops("$nxtPslug/nested")).toBe(false);
    expect(consumerDrops("$nxtPslug/nested")).toBe(true);
    // …and the consumer really does drop it end to end (no params at all, not a param whose
    // value is the sentinel).
    expect(extractRouteParams("/[...rest]", { nxtPrest: "$nxtPslug/nested" })).toBeUndefined();
  });

  it("treats a PERCENT-ENCODED sentinel as an ordinary value — which is correct, not a hole", () => {
    // The filter runs on the RAW transport value and the decode happens after it, so
    // `%24nxtPid` survives and lands in params as the literal `$nxtPid`.
    //
    // That is deliberate parity, not an oversight. The real @next/routing 16.2.10 produces
    // this shape only when the CLIENT literally asks for that path — verified directly
    // against the module: resolveRoutes for `/p/[id]` with
    // `sourceRegex: "^/p/(?<nxtPid>[^/]+?)(?:/)?$"` and url `/p/%24nxtPid` returns
    // `routeMatches: { "1": "%24nxtPid", nxtPid: "%24nxtPid" }`. `next start` answers the
    // same request with `params.id === "$nxtPid"`, so decoding it here is what parity
    // requires. A truly unresolved optional catch-all is a different shape entirely: for
    // `/[[...slug]]` at `/`, the real module returns `routeMatches: {}` and puts the
    // sentinel only in resolvedQuery.
    expect(extractRouteParams("/p/[id]", { nxtPid: "%24nxtPid" })).toEqual({ id: "$nxtPid" });
    expect(extractRouteParams("/[...rest]", { nxtPrest: "%24nxtPrest" })).toEqual({
      rest: ["$nxtPrest"],
    });
  });

  it("never lets a hostile KEY become a param key (only template names are read)", () => {
    // The lookup keys come from the route TEMPLATE, never from the header, so extra keys —
    // including `__proto__`/`constructor`, which JSON.parse creates as ordinary own
    // properties — are inert, and no prototype can be polluted through this path.
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":"x","nxtPid":"7","unrelated":"z"}',
    ) as Record<string, string>;
    expect(extractRouteParams("/posts/[id]", hostile)).toEqual({ id: "7" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });

  it("ignores every key the template does not declare", () => {
    expect(
      extractRouteParams("/posts/[id]", {
        nxtPid: "7",
        nxtPlang: "en",
        _rsc: "1",
        nextInternalLocale: "en",
      }),
    ).toEqual({ id: "7" });
  });

  it("returns undefined for a static template regardless of what the header carries", () => {
    expect(extractRouteParams("/about", { nxtPid: "$nxtPid", anything: "x" })).toBeUndefined();
  });

  it("KNOWN GAP: a non-string value is not shape-checked and throws for a catch-all", () => {
    // index.ts JSON.parses `x-route-matches` without validating the shape, so a buggy (or
    // compromised) routing extension holding the internal secret can deliver an array value.
    // A single dynamic param survives it as type confusion; a catch-all reaches
    // `value.split("/")` and throws, which surfaces as a 500. Not client-reachable — the
    // header is stripped from any request that fails the internal-secret compare — and pinned
    // here so the fix (a shape guard at the JSON.parse in index.ts, or in the shared
    // sanitizer) has something to flip.
    const arrayValue = { nxtPid: ["a", "b"] } as unknown as Record<string, string>;
    expect(extractRouteParams("/posts/[id]", arrayValue)).toEqual({ id: "a,b" });
    expect(() =>
      extractRouteParams("/[...rest]", { nxtPrest: ["a", "b"] } as unknown as Record<
        string,
        string
      >),
    ).toThrow(TypeError);
  });
});
