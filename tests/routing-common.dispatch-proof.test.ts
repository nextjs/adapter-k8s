// tests/routing-common.dispatch-proof.test.ts
//
// The dispatch proof's CONSTRUCTION, tested at the level the two tiers share it: which routing
// inputs it binds, and whether two different input tuples can ever produce the same transcript.
// The tier-level tests (tests/routing-service/handler.test.ts, tests/pool-server/server.test.ts)
// cover the signing and verifying sides against real requests; this file is the canonical-form
// contract underneath them.
//
// REVIEW HISTORY (PR #61). The first cut of the proof covered (method, target,
// INTERNAL_DISPATCH_HEADERS) and nothing else:
//   • `:scheme` and `:authority` were unbound, so one host's — or one scheme's — routing verdict
//     verified for any other request the same build served.
//   • the middleware `matcher` has/missing inputs were unbound, so the TRUSTED `skip-nomatch`
//     verdict an anonymous request legitimately earns was liftable onto a request the matcher
//     does cover: the pool skips middleware for a request whose middleware never ran.
//   • absent covered headers were SKIPPED rather than signed, so `name: ""` and no `name` at all
//     signed identical bytes, and a value containing a newline could restate the `\n`-joined
//     `name\nvalue` framing of a following pair.
import { describe, it, expect } from "vitest";
import {
  buildProofHeaderNames,
  computeDispatchProof,
  dispatchProofInputsFromRequest,
  INTERNAL_DISPATCH_HEADERS,
  matcherProofHeaderNames,
  PROOF_COVERED_CONTEXT_HEADERS,
  proofCoveredHeaderNames,
  rscProofHeaderNames,
  verifyDispatchProof,
  type DispatchProofInputs,
} from "../src/routing-common.js";

const SECRET = "an-internal-dispatch-secret";

const baseInputs = (over: Partial<DispatchProofInputs> = {}): DispatchProofInputs => ({
  method: "GET",
  target: "/about?x=1",
  authority: "app.example.com",
  headers: {
    "x-output-id": "/about",
    "x-matched-pathname": "/about",
    "x-mw-evaluated": "ran",
    "x-upstream-pool": "ssr",
    "x-forwarded-proto": "https",
  },
  ...over,
});

const proofOf = (over: Partial<DispatchProofInputs> = {}) =>
  computeDispatchProof(SECRET, baseInputs(over));

describe("dispatch proof — the covered input set", () => {
  it("covers the dispatch vocabulary, the context witnesses and the matcher inputs, sorted", () => {
    const names = proofCoveredHeaderNames(["cookie", "x-tenant"]);
    for (const name of [
      ...INTERNAL_DISPATCH_HEADERS,
      ...PROOF_COVERED_CONTEXT_HEADERS,
      "cookie",
      "x-tenant",
    ]) {
      expect(names).toContain(name);
    }
    expect(names).toEqual([...names].sort());
    // Deduped: a matcher naming a context header must not double-count it.
    expect(proofCoveredHeaderNames(["x-forwarded-proto"])).toEqual(proofCoveredHeaderNames());
  });

  it("changes when ANY covered input changes", () => {
    const proof = proofOf();
    // Method, target, authority.
    expect(proofOf({ method: "POST" })).not.toBe(proof);
    expect(proofOf({ target: "/about?x=2" })).not.toBe(proof);
    expect(proofOf({ authority: "tenant-b.example.com" })).not.toBe(proof);
    expect(proofOf({ authority: undefined })).not.toBe(proof);
    // Every dispatch header, one at a time.
    for (const name of INTERNAL_DISPATCH_HEADERS) {
      const headers = { ...baseInputs().headers, [name]: "tampered" };
      expect(computeDispatchProof(SECRET, baseInputs({ headers }))).not.toBe(proof);
    }
    // Every context witness.
    for (const name of PROOF_COVERED_CONTEXT_HEADERS) {
      const headers = { ...baseInputs().headers, [name]: "tampered" };
      expect(computeDispatchProof(SECRET, baseInputs({ headers }))).not.toBe(proof);
    }
    // The secret itself.
    expect(computeDispatchProof("another-secret", baseInputs())).not.toBe(proof);
  });

  it("normalizes only what both tiers normalize: method case and host case", () => {
    const proof = proofOf();
    expect(proofOf({ method: "get" })).toBe(proof);
    expect(proofOf({ authority: "APP.Example.com" })).toBe(proof);
    // The target is NOT case-normalized — paths are case-sensitive and both tiers see the same
    // raw bytes.
    expect(proofOf({ target: "/ABOUT?x=1" })).not.toBe(proof);
  });

  it("signs the covered-name COUNT, so one build's transcript is never another's prefix", () => {
    const headers = baseInputs().headers;
    const withMatcher = computeDispatchProof(
      SECRET,
      baseInputs({ headers, proofHeaderNames: ["cookie"] }),
    );
    expect(withMatcher).not.toBe(computeDispatchProof(SECRET, baseInputs({ headers })));
  });
});

describe("dispatch proof — canonicalization has no ambiguity", () => {
  it("keeps an ABSENT covered header distinct from a present empty one", () => {
    const present = { ...baseInputs().headers, "x-route-matches": "" };
    const { "x-route-matches": _absent, ...missing } = present;
    expect(computeDispatchProof(SECRET, baseInputs({ headers: present }))).not.toBe(
      computeDispatchProof(SECRET, baseInputs({ headers: missing })),
    );
    // …and an explicit `undefined` is the same thing as missing, not a third state.
    expect(
      computeDispatchProof(
        SECRET,
        baseInputs({ headers: { ...missing, "x-route-matches": undefined } }),
      ),
    ).toBe(computeDispatchProof(SECRET, baseInputs({ headers: missing })));
  });

  it("cannot be confused by a covered value that impersonates the framing", () => {
    // Under a `\n`-joined transcript, a value ending in "\nx-mw-evaluated\nran" restated the next
    // pair. Length-prefixed fields make the bytes unforgeable regardless of content.
    const injected = {
      ...baseInputs().headers,
      "x-mw-evaluated": "none",
      "x-invoke-path": "/about\nx-mw-evaluated\nran",
    };
    const honest = {
      ...baseInputs().headers,
      "x-mw-evaluated": "ran",
      "x-invoke-path": "/about",
    };
    expect(computeDispatchProof(SECRET, baseInputs({ headers: injected }))).not.toBe(
      computeDispatchProof(SECRET, baseInputs({ headers: honest })),
    );
  });

  it("cannot be confused by a value that spans the method/target/authority boundary", () => {
    expect(proofOf({ method: "GET", target: "/a", authority: "b" })).not.toBe(
      proofOf({ method: "GET", target: "/ab", authority: undefined }),
    );
  });

  it("counts BYTES, not UTF-16 code units, when framing a multi-byte value", () => {
    // A length prefix measured in string length would let a multi-byte value under-declare its
    // own framing. Both values are 2 code units; one is 4 bytes.
    expect(proofOf({ target: "/é" })).not.toBe(proofOf({ target: "/aa" }));
  });
});

describe("the build-derived covered names (matcherProofHeaderNames / buildProofHeaderNames)", () => {
  it("derives header and cookie inputs, ignores query/host, and sorts", () => {
    expect(
      matcherProofHeaderNames([
        {
          regexp: "^/a$",
          has: [
            { type: "header", key: "X-Tenant" },
            { type: "query", key: "preview" },
          ],
          missing: [
            { type: "cookie", key: "session" },
            { type: "host", value: "admin.example.com" },
          ],
        },
        { regexp: "^/b$", has: [{ type: "header", key: "authorization" }] },
      ]),
      // `query` and `host` read url.searchParams / url.hostname, already bound by the target and
      // the authority. A cookie condition contributes the `cookie` HEADER, not the cookie name.
    ).toEqual(["authorization", "cookie", "x-tenant"]);
  });

  it("returns nothing for a build with no matchers", () => {
    expect(matcherProofHeaderNames(undefined)).toEqual([]);
    expect(matcherProofHeaderNames([])).toEqual([]);
    expect(matcherProofHeaderNames([{ regexp: "^/a$" }])).toEqual([]);
  });

  it("is unioned with the RSC negotiation headers by buildProofHeaderNames", () => {
    // The other build-derived routing input: `resolveRscOutput` reads these to choose the
    // `.rsc` / segment-prefetch output id the pool then dispatches verbatim.
    expect(
      rscProofHeaderNames({
        header: "RSC",
        suffix: ".rsc",
        prefetchSegmentHeader: "Next-Router-Segment-Prefetch",
      }),
    ).toEqual(["next-router-segment-prefetch", "rsc"]);
    expect(rscProofHeaderNames(undefined)).toEqual([]);

    expect(
      buildProofHeaderNames({
        middleware: {
          matchers: [{ regexp: "^/a$", has: [{ type: "cookie", key: "session" }] }],
        },
        routeGraph: { rsc: { header: "RSC", suffix: ".rsc" } },
      }),
    ).toEqual(["cookie", "rsc"]);
    // A build with neither contributes nothing beyond the fixed vocabulary.
    expect(buildProofHeaderNames({})).toEqual([]);
  });

  it("never admits a name whose wire value differs across the hop", () => {
    // The dispatch vocabulary is covered explicitly; `host` is covered as the authority; and the
    // UNTRUSTED_NEXT_REQUEST_HEADERS are rewritten between the tiers (the edge evaluates matchers
    // with its own `x-nextjs-data` and clears the whole list on egress), so a wire value for them
    // would compare the edge's pre-strip bytes against the pool's post-clear absence.
    expect(
      matcherProofHeaderNames([
        {
          regexp: "^/a$",
          has: [
            { type: "header", key: "x-nextjs-data" },
            { type: "header", key: "x-matched-path" },
            { type: "header", key: "x-output-id" },
            { type: "header", key: "Host" },
            { type: "header", key: "x-internal-dispatch-proof" },
            { type: "header", key: "x-real-one" },
          ],
        },
      ]),
    ).toEqual(["x-real-one"]);
  });
});

describe("dispatchProofInputsFromRequest / verifyDispatchProof", () => {
  it("reads the authority off Host and coalesces a repeated covered header", () => {
    const inputs = dispatchProofInputsFromRequest({
      method: "get",
      target: "/about",
      headers: {
        host: "app.example.com",
        cookie: ["a=1", "b=2"],
        "x-forwarded-proto": ["https", "http"],
        "x-output-id": "/about",
      },
      proofHeaderNames: ["cookie"],
    });
    expect(inputs.authority).toBe("app.example.com");
    // Node's parser and Envoy both join repeated Cookie with "; " and everything else with ", ".
    expect(inputs.headers["cookie"]).toBe("a=1; b=2");
    expect(inputs.headers["x-forwarded-proto"]).toBe("https, http");
    expect(inputs.headers["x-output-id"]).toBe("/about");
  });

  it("defaults a missing method/target the same way the pool boundary does", () => {
    const inputs = dispatchProofInputsFromRequest({ headers: {} });
    expect(inputs.method).toBe("GET");
    expect(inputs.target).toBe("/");
    expect(inputs.authority).toBeUndefined();
  });

  it("round-trips: a proof computed from one wire state verifies against it and nothing else", () => {
    const wire: Record<string, string | string[] | undefined> = {
      host: "app.example.com",
      "x-forwarded-proto": "https",
      "x-output-id": "/about",
      "x-mw-evaluated": "skip-nomatch",
      cookie: "theme=dark",
    };
    const proofHeaderNames = ["cookie"];
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest({
        method: "GET",
        target: "/about",
        headers: wire,
        proofHeaderNames,
      }),
    );

    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        proof,
      ),
    ).toBe(true);
    // One matcher input changed ⇒ a different matcher verdict ⇒ no trust.
    expect(
      verifyDispatchProof(
        SECRET,
        {
          method: "GET",
          target: "/about",
          headers: { ...wire, cookie: "theme=dark; session=alice" },
          proofHeaderNames,
        },
        proof,
      ),
    ).toBe(false);
    // A garbage proof of the same length is rejected without throwing (constant-time compare
    // needs equal-length buffers).
    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        "0".repeat(proof.length),
      ),
    ).toBe(false);
    // So is one of a different length.
    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        "",
      ),
    ).toBe(false);
  });
});
