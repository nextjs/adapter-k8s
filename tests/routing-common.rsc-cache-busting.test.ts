// tests/routing-common.rsc-cache-busting.test.ts
//
// N18 (SECURITY): the `_rsc` cache-busting param that authenticates an RSC request's headers.
// Next validates it and 307s a mismatch — but only when `!this.minimalMode`, and this adapter
// invokes every entrypoint in minimal mode, so the platform (us) owns the check. Mirroring the
// hash INPUTS wrongly would be worse than having no check (it would mark real traffic
// unvalidated), so every expectation below is RECORDED GROUND TRUTH, not a re-derivation.
//
// How the table was produced (2026-07-24):
//   • App: Next's own `test/e2e/app-dir/segment-cache/cdn-cache-busting` fixture (app +
//     components, `experimental.validateRSCRequestHeaders: true`), copied to a scratch dir —
//     never edited in place — built and served with `next start`, Next 16.3.0-canary.84.
//   • For each header tuple the expected `_rsc` was computed by NEXT'S OWN module
//     (`next/dist/shared/lib/router/utils/cache-busting-search-param`), then five request
//     variants were sent: `_rsc` absent / bare `?_rsc` / valid modern / valid legacy / forged.
//   • Recorded upstream behavior, identical for all 13 tuples:
//       valid modern  → 200 text/x-component, `cache-control: s-maxage=31536000`
//       valid legacy  → 200 (upstream accepts the pre-secure-context 5-char form)
//       forged/absent → 307, empty body, no cache-control,
//                       `location: <path>?_rsc=<expected>` (bare `?_rsc` when expected is "")
//     The 200 case is the poisoning primitive this check exists for: a SHARED-CACHEABLE
//     response whose body depends on headers a CDN may ignore.
//   • The modern/legacy pairs asserted below are those recorded values verbatim.
//   • Cross-checked with a real browser (playwright-chromium against `next start`, Next
//     16.2.10): 5 segment-prefetch requests + 1 non-prefetch navigation (percent-encoded
//     `next-router-state-tree`, percent-encoded query) — all 6 validate here, none is
//     mistaken for a forgery. See the `rscCacheBustingUnvalidated` doc comment.
import { describe, it, expect } from "vitest";
import {
  computeLegacyRscCacheBustingParam,
  computeRscCacheBustingParam,
  rscCacheBustingUnvalidated,
  validateRscCacheBustingParam,
} from "../src/routing-common.js";

type Inputs = Parameters<typeof computeRscCacheBustingParam>;

// [name, (prefetch, segmentPrefetch, stateTree, nextUrl), modern, legacy]
const RECORDED: Array<[string, Inputs, string, string]> = [
  ["no inputs (plain RSC)", [undefined, undefined, undefined, undefined], "", ""],
  [
    "state tree only",
    [undefined, undefined, "%5B%22%22%2C%7B%7D%5D", undefined],
    "OxBCQ2sR9P8GlKR3",
    "1tccy",
  ],
  ["prefetch 1 + segment", ["1", "/_tree", undefined, undefined], "_i_aeImnuN6u1u1r", "1r34m"],
  ["prefetch 2 (runtime)", ["2", undefined, undefined, undefined], "gO6pH-93hUwkIF31", "wy5si"],
  ["prefetch 3", ["3", undefined, undefined, undefined], "Ui4g2KKTT-CAh2it", "1ib2f"],
  ["next-url only", [undefined, undefined, undefined, "/target-page"], "LgaoQchCjWSozsRb", "1bs4l"],
  [
    "all four inputs",
    ["1", "/_tree", "%5B%22%22%2C%7B%7D%5D", "/target-page"],
    "stkXvdhGvVgUptcw",
    "1uas4",
  ],
  // Presence is `=== undefined`, NOT truthiness: an EMPTY state tree is a present input.
  ["empty state tree", [undefined, undefined, "", undefined], "zQUEjFlcUuTSVaR0", "y55m5"],
];

describe("_rsc cache-busting hash (recorded `next start` ground truth)", () => {
  for (const [name, inputs, modern, legacy] of RECORDED) {
    it(`matches upstream for: ${name}`, () => {
      expect(computeRscCacheBustingParam(...inputs)).toBe(modern);
      expect(computeLegacyRscCacheBustingParam(...inputs)).toBe(legacy);
    });
  }

  it("emits a 16-char base64url digest (upstream: 12 bytes of SHA-256, unpadded)", () => {
    const hash = computeRscCacheBustingParam("1", "/_tree", "x", "/y");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it("distinguishes the known colliding RSC variants (upstream app-validation test)", () => {
    const stateTree = "%5B%22%22%2C%7B%7D%5D";
    const full = computeRscCacheBustingParam(undefined, undefined, stateTree, undefined);
    const prefetch = computeRscCacheBustingParam("1", "/_tree", stateTree, "/pcsta0");
    expect(full).toHaveLength(16);
    expect(prefetch).toHaveLength(16);
    expect(full).not.toBe(prefetch);
  });

  it("joins a repeated header with commas, exactly as upstream normalizes it", () => {
    expect(computeRscCacheBustingParam(undefined, undefined, ["a", "b"], undefined)).toBe(
      computeRscCacheBustingParam(undefined, undefined, "a,b", undefined),
    );
  });

  it("treats a prefetch value of `0` as absent (upstream's null-input rule)", () => {
    expect(computeRscCacheBustingParam("0", undefined, undefined, undefined)).toBe("");
    expect(computeLegacyRscCacheBustingParam("0", undefined, undefined, undefined)).toBe("");
  });
});

function verdict(
  headers: Record<string, string | string[] | undefined>,
  search: string,
): ReturnType<typeof validateRscCacheBustingParam> {
  return validateRscCacheBustingParam({
    header: (name) => headers[name],
    searchParams: new URL(`http://x/p${search}`).searchParams,
  });
}

function unvalidated(
  headers: Record<string, string | string[] | undefined>,
  search: string,
): boolean {
  return rscCacheBustingUnvalidated({
    header: (name) => headers[name],
    searchParams: new URL(`http://x/p${search}`).searchParams,
  });
}

describe("validateRscCacheBustingParam (per-request verdict)", () => {
  it("is inert for a non-RSC request, whatever `_rsc` says", () => {
    // Recorded: `next start` serves the document 200 text/html for a forged `_rsc` with no
    // `rsc` header, and for `rsc: 0`. Document requests must never be touched by this check.
    for (const headers of [{}, { rsc: "0" }, { rsc: ["1", "1"] as string[] }]) {
      expect(verdict(headers, "?_rsc=DEADBEEFdeadbeef").isRscRequest).toBe(false);
      expect(unvalidated(headers, "?_rsc=DEADBEEFdeadbeef")).toBe(false);
    }
  });

  it("accepts the bare `?_rsc` form when no hash inputs are present", () => {
    // Recorded: `rsc: 1` + `?_rsc` → 200; `rsc: 1` with NO `_rsc` at all → 307.
    expect(unvalidated({ rsc: "1" }, "?_rsc")).toBe(false);
    expect(unvalidated({ rsc: "1" }, "")).toBe(true);
    expect(verdict({ rsc: "1" }, "").expected).toBe("");
  });

  it("accepts both the modern and the legacy hash for the same request", () => {
    const headers = { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D" };
    expect(unvalidated(headers, "?_rsc=OxBCQ2sR9P8GlKR3")).toBe(false);
    expect(unvalidated(headers, "?_rsc=1tccy")).toBe(false);
    expect(unvalidated(headers, "?_rsc=DEADBEEFdeadbeef")).toBe(true);
  });

  it("rejects a hash bound to a DIFFERENT header set (the poisoning attempt)", () => {
    // Same URL + same `_rsc`, one header flipped: the hash no longer authenticates the
    // headers, so the response must not be storable under that URL.
    const legit = {
      rsc: "1",
      "next-router-prefetch": "1",
      "next-router-segment-prefetch": "/_tree",
    };
    expect(unvalidated(legit, "?_rsc=_i_aeImnuN6u1u1r")).toBe(false);
    expect(
      unvalidated(
        { ...legit, "next-router-segment-prefetch": "/_index" },
        "?_rsc=_i_aeImnuN6u1u1r",
      ),
    ).toBe(true);
    expect(unvalidated({ ...legit, "next-url": "/elsewhere" }, "?_rsc=_i_aeImnuN6u1u1r")).toBe(
      true,
    );
  });

  it("hashes an unrecognized prefetch value as absent, like upstream", () => {
    // Recorded: `next-router-prefetch: 9` behaves exactly like no prefetch header —
    // `?_rsc` → 200, forged → 307 to `?_rsc`.
    expect(unvalidated({ rsc: "1", "next-router-prefetch": "9" }, "?_rsc")).toBe(false);
    expect(unvalidated({ rsc: "1", "next-router-prefetch": "0" }, "?_rsc")).toBe(false);
  });

  it("hashes an EMPTY segment-prefetch as absent but an EMPTY state tree as present", () => {
    // base-server uses `||` for the segment header and `=== undefined` for the state tree.
    // Recorded: empty segment-prefetch → `?_rsc` accepted; empty state tree → `?_rsc` 307s.
    expect(unvalidated({ rsc: "1", "next-router-segment-prefetch": "" }, "?_rsc")).toBe(false);
    expect(unvalidated({ rsc: "1", "next-router-state-tree": "" }, "?_rsc")).toBe(true);
    expect(unvalidated({ rsc: "1", "next-router-state-tree": "" }, "?_rsc=zQUEjFlcUuTSVaR0")).toBe(
      false,
    );
  });

  it("survives extra query params and preserves the percent-encoded ones", () => {
    // A real navigation captured from Chromium: `/target-page?q=a%20b&_rsc=<hash>`.
    const headers = { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D" };
    expect(unvalidated(headers, "?q=a%20b&_rsc=OxBCQ2sR9P8GlKR3")).toBe(false);
  });

  it("honors a build's custom RSC / segment-prefetch header names from the manifest", () => {
    const rsc = {
      header: "RSC",
      suffix: ".rsc",
      prefetchSegmentHeader: "X-Segment",
    };
    // Manifest names are lowercased before lookup (Node lowercases req.headers keys).
    const headers = { rsc: "1", "x-segment": "/_tree", "next-router-prefetch": "1" };
    expect(
      rscCacheBustingUnvalidated({
        header: (name) => headers[name as keyof typeof headers],
        searchParams: new URL("http://x/p?_rsc=_i_aeImnuN6u1u1r").searchParams,
        rsc,
      }),
    ).toBe(false);
  });

  it("FAILS SAFE to `unvalidated` when the verdict cannot be computed", () => {
    // The unsafe direction is "validated" — anything unexpected must land on uncacheable,
    // which costs cache hit rate and never correctness.
    expect(
      rscCacheBustingUnvalidated({
        header: () => {
          throw new Error("boom");
        },
        searchParams: new URLSearchParams(),
      }),
    ).toBe(true);
  });
});
