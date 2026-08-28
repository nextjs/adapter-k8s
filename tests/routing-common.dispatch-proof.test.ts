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
import { describe, it, expect, vi } from "vitest";
import {
  buildProofHeaderNames,
  coalesceWireHeaderBytes,
  computeDispatchProof,
  dispatchBodyDigest,
  DISPATCH_PROOF_MAX_AGE_MS,
  DISPATCH_PROOF_MAX_SKEW_MS,
  dispatchProofBodyMatches,
  dispatchProofInputsFromRequest,
  encodeNodeOutgoingDispatchHeader,
  encodeNodeOutgoingDispatchHeaders,
  INTERNAL_DISPATCH_HEADERS,
  matcherProofHeaderNames,
  NODE_SINGLETON_REQUEST_HEADERS,
  parseDispatchProof,
  PROOF_COVERED_CONTEXT_HEADERS,
  proofCoveredHeaderNames,
  rscProofHeaderNames,
  verifyDispatchProof,
  type DispatchProofInputs,
} from "../src/routing-common.js";

const SECRET = "an-internal-dispatch-secret";

/** A wire-octet proof field as a readable latin1 string (Buffer in, `undefined` preserved). */
const octets = (value: Buffer | string | undefined): string | undefined =>
  value === undefined ? undefined : Buffer.isBuffer(value) ? value.toString("latin1") : value;

/** A fixed mint time, so a transcript is reproducible (A0-DP-5 binds the issued-at). */
const ISSUED_AT = 1_800_000_000_000;

const baseInputs = (over: Partial<DispatchProofInputs> = {}): DispatchProofInputs => ({
  method: "GET",
  target: "/about?x=1",
  authority: "app.example.com",
  issuedAtMs: ISSUED_AT,
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

  it("A0-DP-2: canonicalizes WIRE OCTETS, so the two tiers' JS strings converge", () => {
    // The defect: `updateProofField` took a `string` and UTF-8-encoded it at both tiers, but the
    // tiers hold DIFFERENT strings for one request's octets — the edge decoded Envoy's raw_value
    // as UTF-8, the pool reads Node's latin1-decoded req.headers. For the two octets `c3 a9` that
    // is "é" at the edge and "Ã©" at the pool, and the old rule signed 2 bytes against 4.
    const wire = Buffer.from([0xc3, 0xa9]);
    const edgeView = wire.toString("utf-8"); // "é"      — what the ext_proc tier held
    const poolView = wire.toString("latin1"); // "Ã©"     — what Node's parser hands the pool
    expect(edgeView).not.toBe(poolView);

    const withCookie = (value: Buffer) =>
      computeDispatchProof(
        SECRET,
        baseInputs({
          headers: { ...baseInputs().headers, cookie: value },
          proofHeaderNames: ["cookie"],
        }),
      );
    // Both tiers reach the same octets from their own representation, so the same transcript.
    expect(withCookie(Buffer.from(edgeView, "utf8"))).toBe(
      withCookie(Buffer.from(poolView, "latin1")),
    );
    // …and the octets are still what is signed: a different value is still a different proof.
    expect(withCookie(Buffer.from([0xc3, 0xa8]))).not.toBe(withCookie(wire));
  });

  it("encodes a pool-authored dispatch value to the UTF-8 bytes Node must send", () => {
    const semantic = "/🎉/日本語";
    const nodeValue = encodeNodeOutgoingDispatchHeader(semantic);
    expect(Buffer.from(nodeValue, "latin1")).toEqual(Buffer.from(semantic, "utf8"));
  });

  it("encodes the dispatch fields in an outgoing header record and leaves client fields alone", () => {
    const headers: Record<string, string | string[] | undefined> = {
      "x-output-id": "/🎉/日本語",
      "x-route-matches": ["café", "日本語"],
      cookie: "theme=日本語",
    };

    encodeNodeOutgoingDispatchHeaders(headers);

    expect(Buffer.from(headers["x-output-id"] as string, "latin1").toString("utf8")).toBe(
      "/🎉/日本語",
    );
    expect(
      (headers["x-route-matches"] as string[]).map((value) =>
        Buffer.from(value, "latin1").toString("utf8"),
      ),
    ).toEqual(["café", "日本語"]);
    expect(headers.cookie).toBe("theme=日本語");
  });

  it("A0-DP-2: applies the same rule to the target and the authority", () => {
    const targetOctets = Buffer.from("/posts/cafÃ©", "latin1");
    expect(proofOf({ target: targetOctets })).toBe(
      proofOf({ target: Buffer.from("/posts/café", "utf8") }),
    );
    const authorityOctets = Buffer.from("cafÃ©.example.com", "latin1");
    expect(proofOf({ authority: authorityOctets })).toBe(
      proofOf({ authority: Buffer.from("café.example.com", "utf8") }),
    );
    // The authority is still ASCII-case-folded (both tiers route on the lowercased hostname), and
    // ONLY ASCII: a high octet is not touched, so it cannot be normalized into a different host.
    expect(proofOf({ authority: Buffer.from("APP.Example.com", "latin1") })).toBe(
      proofOf({ authority: "app.example.com" }),
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

  it("excludes the W3C trace headers, which the routing tier overwrites AFTER minting the proof", () => {
    // A5-X3. These are the one covered-set entry a matcher can pull in on its own — they are in
    // neither INTERNAL_DISPATCH_HEADERS nor PROOF_COVERED_CONTEXT_HEADERS. An OTel-enabled
    // routing tier injects them with OVERWRITE_IF_EXISTS_OR_ADD after handler() has already
    // signed the request (routing-service/server.ts injectTraceHeaders), so binding them would
    // compare the edge's pre-injection bytes against the pool's post-injection value and fail
    // EVERY proof for that build — silently: trusted dispatch permanently off, middleware run
    // twice per request, nothing logged.
    expect(
      matcherProofHeaderNames([
        {
          regexp: "^/a$",
          has: [
            { type: "header", key: "traceparent" },
            { type: "header", key: "TraceState" },
          ],
        },
      ]),
    ).toEqual([]);
    // Not a blanket ban on the surrounding matcher: real names alongside them still bind.
    expect(
      matcherProofHeaderNames([
        {
          regexp: "^/a$",
          has: [
            { type: "header", key: "traceparent" },
            { type: "cookie", key: "session" },
          ],
        },
      ]),
    ).toEqual(["cookie"]);
    expect(
      buildProofHeaderNames({
        middleware: {
          matchers: [{ regexp: "^/a$", has: [{ type: "header", key: "tracestate" }] }],
        },
      }),
    ).toEqual([]);
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
    // A0-DP-2: a Node tier's inputs are WIRE OCTETS, produced with latin1 — the exact inverse of
    // Node's own header codec on both the read and the write side.
    expect(octets(inputs.authority)).toBe("app.example.com");
    // Node's parser and Envoy both join repeated Cookie with "; " and everything else with ", ".
    expect(octets(inputs.headers["cookie"])).toBe("a=1; b=2");
    expect(octets(inputs.headers["x-forwarded-proto"])).toBe("https, http");
    expect(octets(inputs.headers["x-output-id"])).toBe("/about");
  });

  it("A0-DP-3: mirrors Node's SINGLETON headers — first value wins, no join", () => {
    // The claim the ", " join rested on was that "one rule serves both sides". It does not: Node's
    // parser keeps only the FIRST value for a fixed set of names, so the edge (which sees both
    // Envoy entries) signed "A, B" while the pool read "A" and refused every such request.
    // `matcherProofHeaderNames` admits any non-excluded name, so a matcher gating on `user-agent`
    // or `authorization` plus a client sending it twice is all it takes.
    for (const name of ["user-agent", "authorization", "referer", "content-type"]) {
      expect(coalesceWireHeaderBytes(name, [Buffer.from("A"), Buffer.from("B")])).toEqual(
        Buffer.from("A"),
      );
      expect(NODE_SINGLETON_REQUEST_HEADERS.has(name)).toBe(true);
    }
    // Case-insensitive on the name — the edge reads `User-Agent` off the wire as it was sent.
    expect(coalesceWireHeaderBytes("User-Agent", [Buffer.from("A"), Buffer.from("B")])).toEqual(
      Buffer.from("A"),
    );
    // Everything else keeps the delimiter Node actually uses.
    expect(coalesceWireHeaderBytes("cookie", [Buffer.from("a=1"), Buffer.from("b=2")])).toEqual(
      Buffer.from("a=1; b=2"),
    );
    expect(coalesceWireHeaderBytes("x-tenant", [Buffer.from("a"), Buffer.from("b")])).toEqual(
      Buffer.from("a, b"),
    );
    // A single value is untouched whatever the name, and an empty list is ABSENT.
    expect(coalesceWireHeaderBytes("user-agent", [Buffer.from("only")])).toEqual(
      Buffer.from("only"),
    );
    expect(coalesceWireHeaderBytes("user-agent", [])).toBeUndefined();
  });

  it("A0-DP-3: a signer seeing both entries and a pool seeing one produce the same proof", () => {
    // The two sides of the divergence, end to end: the edge's ext_proc list carries both field
    // lines, while Node's `req.headers` carries only the first. Both must reach one transcript.
    const proofHeaderNames = ["user-agent"];
    const asEdge = computeDispatchProof(
      SECRET,
      baseInputs({
        headers: {
          ...baseInputs().headers,
          "user-agent": coalesceWireHeaderBytes("user-agent", [
            Buffer.from("first/1.0"),
            Buffer.from("second/2.0"),
          ]),
        },
        proofHeaderNames,
      }),
    );
    const asPool = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(
        {
          method: "GET",
          target: "/about?x=1",
          headers: {
            host: "app.example.com",
            "user-agent": "first/1.0",
            "x-output-id": "/about",
            "x-matched-pathname": "/about",
            "x-mw-evaluated": "ran",
            "x-upstream-pool": "ssr",
            "x-forwarded-proto": "https",
          },
          proofHeaderNames,
        },
        { issuedAtMs: ISSUED_AT },
      ),
    );
    expect(asPool).toBe(asEdge);
  });

  it("defaults a missing method/target the same way the pool boundary does", () => {
    const inputs = dispatchProofInputsFromRequest({ headers: {} });
    expect(inputs.method).toBe("GET");
    expect(octets(inputs.target)).toBe("/");
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
    ).toEqual({ trusted: true, bodyDigest: undefined });
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
    ).toEqual({ trusted: false, reason: "mismatch" });
    // A garbage credential of the same length is rejected without throwing (constant-time compare
    // needs equal-length buffers) — as malformed, since it is not even the credential shape.
    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        "0".repeat(proof.length),
      ),
    ).toEqual({ trusted: false, reason: "malformed" });
    // So is one of a different length, and the empty string.
    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        "",
      ),
    ).toEqual({ trusted: false, reason: "malformed" });
    // A well-formed credential whose MAC is wrong is a MISMATCH, not malformed — the reason is
    // what an operator reads off the rejection metric, so the two must not blur.
    const [, issuedAt, digest] = proof.split(".") as [string, string, string];
    expect(
      verifyDispatchProof(
        SECRET,
        { method: "GET", target: "/about", headers: wire, proofHeaderNames },
        `v3.${issuedAt}.${digest}.${"0".repeat(64)}`,
      ),
    ).toEqual({ trusted: false, reason: "mismatch" });
  });
});

describe("A0-DP-5 — a proof is bound to a transmission, not just to an input tuple", () => {
  const wire = (): Record<string, string | string[] | undefined> => ({
    host: "app.example.com",
    "x-forwarded-proto": "https",
    "x-output-id": "/api/submit",
    "x-mw-evaluated": "ran",
  });
  const request = { method: "POST", target: "/api/submit", headers: wire() };

  it("binds a SHA-256 of the body on a hop that has it, and refuses a swapped body", () => {
    // The cross-pool hop's replay: the proof authenticated the header tuple only, so an observer
    // of a POST hop could re-send it with arbitrary bytes and the sibling pool would honor
    // `x-mw-evaluated: ran` for a body middleware never saw.
    const body = Buffer.from("formData=honest");
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { body, issuedAtMs: ISSUED_AT }),
    );
    const verdict = verifyDispatchProof(SECRET, request, proof, { nowMs: ISSUED_AT });
    expect(verdict.trusted).toBe(true);

    // The MAC alone cannot see a swapped body — the digest travels in the credential — so the
    // verdict carries the DECLARED digest and the caller checks the bytes it received.
    expect(verdict.trusted && dispatchProofBodyMatches(verdict.bodyDigest, body)).toBe(true);
    expect(
      verdict.trusted &&
        dispatchProofBodyMatches(verdict.bodyDigest, Buffer.from("formData=attacker")),
    ).toBe(false);
    // …and one byte is enough.
    expect(
      verdict.trusted &&
        dispatchProofBodyMatches(verdict.bodyDigest, Buffer.from("formData=hones")),
    ).toBe(false);
    // An empty body is a bound state of its own, not "no body".
    expect(verdict.trusted && dispatchProofBodyMatches(verdict.bodyDigest, Buffer.alloc(0))).toBe(
      false,
    );
  });

  it("cannot have its declared digest rewritten to match a different body", () => {
    // The digest is carried in the credential so the header-phase verifier can reproduce the
    // transcript without the body — which only works because the digest is INSIDE the MAC.
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, {
        body: Buffer.from("honest"),
        issuedAtMs: ISSUED_AT,
      }),
    );
    const parts = proof.split(".") as [string, string, string, string];
    const attackerDigest = dispatchBodyDigest(Buffer.from("attacker")).toString("hex");
    const swapped = `v3.${parts[1]}.${attackerDigest}.${parts[3]}`;
    expect(verifyDispatchProof(SECRET, request, swapped, { nowMs: ISSUED_AT })).toEqual({
      trusted: false,
      reason: "mismatch",
    });
  });

  it("keeps a bound body distinct from an ABSENT one, and ABSENT unconstrained", () => {
    const bound = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { body: Buffer.alloc(0), issuedAtMs: ISSUED_AT }),
    );
    const absent = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    expect(bound).not.toBe(absent);
    // ABSENT is what the ext_proc edge must bind (a header-phase callout has no body). It is an
    // accepted residual, documented on verifyDispatchProof: no body constrains it.
    const verdict = verifyDispatchProof(SECRET, request, absent, { nowMs: ISSUED_AT });
    expect(verdict.trusted).toBe(true);
    expect(verdict.trusted && verdict.bodyDigest).toBeUndefined();
    expect(dispatchProofBodyMatches(undefined, Buffer.from("anything"))).toBe(true);
  });

  it("refuses a declared digest on a read method, which no signer produces", () => {
    const readRequest = { method: "GET", target: "/about", headers: wire() };
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(readRequest, {
        body: Buffer.from("x"),
        issuedAtMs: ISSUED_AT,
      }),
    );
    expect(verifyDispatchProof(SECRET, readRequest, proof, { nowMs: ISSUED_AT })).toEqual({
      trusted: false,
      reason: "body-unexpected",
    });
  });

  it("expires: the same credential stops verifying once the freshness window closes", () => {
    // Before this, the proof was a deterministic HMAC over the input tuple with no nonce,
    // timestamp or body binding — so a captured trusted exchange replayed verbatim FOREVER.
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    expect(verifyDispatchProof(SECRET, request, proof, { nowMs: ISSUED_AT }).trusted).toBe(true);
    // Inside the window (an in-flight request across one or two hops).
    expect(
      verifyDispatchProof(SECRET, request, proof, {
        nowMs: ISSUED_AT + DISPATCH_PROOF_MAX_AGE_MS,
      }).trusted,
    ).toBe(true);
    // Past it — refused, with the reason an operator will read off the metric.
    expect(
      verifyDispatchProof(SECRET, request, proof, {
        nowMs: ISSUED_AT + DISPATCH_PROOF_MAX_AGE_MS + 1,
      }),
    ).toEqual({ trusted: false, reason: "stale" });
    // A day later, which is the replay this closes.
    expect(verifyDispatchProof(SECRET, request, proof, { nowMs: ISSUED_AT + 86_400_000 })).toEqual({
      trusted: false,
      reason: "stale",
    });
  });

  it("tolerates clock skew as wide as the max age, and still bounds it", () => {
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    // The future bound is an AVAILABILITY trade, not a defence, so it is the same width as the
    // max age. `issuedAtMs` is inside the transcript (the next test pins that re-stamping it
    // yields `mismatch`), so no attacker can mint a future-dated credential — the only party that
    // can is a legitimate signer whose clock runs fast, and the extra validity such a signer's
    // proofs enjoy is bounded by its clock error whether or not this check exists. At the original
    // 30s, a routing-service pod on a node 45s fast (routine on the self-managed clusters the
    // `generic` provider supports) turned EVERY minted proof into `premature`: trusted dispatch
    // off cluster-wide and middleware running twice per request, with no env knob to escape it.
    expect(DISPATCH_PROOF_MAX_SKEW_MS).toBe(DISPATCH_PROOF_MAX_AGE_MS);
    // A signer a minute ahead of this pool is still trusted, where before it was not.
    expect(verifyDispatchProof(SECRET, request, proof, { nowMs: ISSUED_AT - 60_000 }).trusted).toBe(
      true,
    );
    expect(
      verifyDispatchProof(SECRET, request, proof, {
        nowMs: ISSUED_AT - DISPATCH_PROOF_MAX_SKEW_MS,
      }).trusted,
    ).toBe(true);
    // Still finite: a proof dated past the window is refused, with the reason that tells an
    // operator "clock offset" rather than "transit".
    expect(
      verifyDispatchProof(SECRET, request, proof, {
        nowMs: ISSUED_AT - DISPATCH_PROOF_MAX_SKEW_MS - 1,
      }),
    ).toEqual({ trusted: false, reason: "premature" });
  });

  it("reports `mismatch` for every rejection a peer WITHOUT the secret can construct", () => {
    // The rejection metric and the throttled warn line are the signal that distinguishes "a
    // client sent a bogus credential" from "this build's two tiers disagree". Checking freshness
    // and body shape ahead of the MAC let any in-cluster peer that can reach a pool on :3000 pick
    // the label with no knowledge of the secret — a loop of far-future credentials manufactures a
    // `premature` clock-skew incident, and either shape buries a real `mismatch` in noise. The MAC
    // now runs first, so every reason but `malformed`/`mismatch` is AUTHENTICATED.
    const zeroMac = "0".repeat(64);
    const getRequest = { method: "GET", target: "/about", headers: wire() };
    const forgedDigest = dispatchBodyDigest(Buffer.from("anything")).toString("hex");
    const forged = [
      // Would have reported `premature`.
      `v3.${ISSUED_AT + 86_400_000}.-.${zeroMac}`,
      // Would have reported `stale`.
      `v3.${ISSUED_AT - 86_400_000}.-.${zeroMac}`,
      // Would have reported `body-unexpected` (a declared digest on a read method).
      `v3.${ISSUED_AT}.${forgedDigest}.${zeroMac}`,
    ];
    for (const credential of forged) {
      expect(verifyDispatchProof(SECRET, getRequest, credential, { nowMs: ISSUED_AT })).toEqual({
        trusted: false,
        reason: "mismatch",
      });
    }
    // Same for a credential minted with the WRONG secret — a different build's edge, which the
    // per-build secret makes the ordinary cross-build case — whatever its policy shape.
    const wrongSecret = computeDispatchProof(
      "not-this-builds-secret",
      dispatchProofInputsFromRequest(getRequest, { issuedAtMs: ISSUED_AT + 86_400_000 }),
    );
    expect(verifyDispatchProof(SECRET, getRequest, wrongSecret, { nowMs: ISSUED_AT })).toEqual({
      trusted: false,
      reason: "mismatch",
    });
    // And the authenticated reasons still reach an operator: a credential this build's secret
    // really did mint reports the policy reason, not `mismatch`.
    const authentic = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    expect(
      verifyDispatchProof(SECRET, request, authentic, {
        nowMs: ISSUED_AT + DISPATCH_PROOF_MAX_AGE_MS + 1,
      }),
    ).toEqual({ trusted: false, reason: "stale" });
  });

  it("anchors the freshness window on the operator-tunable per-hop budget", async () => {
    // The window's job is to cover the MINT-TO-VERIFY delay, which ingress queueing dominates: a
    // burst pending in Envoy while an HPA scale-up brings pods Ready, with the whole-response
    // route timeout switched off entirely on the `generic` provider. A hardcoded 120s therefore
    // pointed the wrong way — raising ADAPTER_K8S_HANDLER_TIMEOUT_MS to 600s left the proof
    // window where it was, so every queued request arrived `stale`, lost trusted dispatch and
    // paid a second middleware pass exactly when the cluster was already saturated.
    //
    // Both constants are read at module load (the dispatch.ts style for this kind of knob), so
    // this re-imports the module under a stubbed env rather than mutating a live value.
    const load = async (env: Record<string, string | undefined>) => {
      vi.resetModules();
      vi.stubEnv("ADAPTER_K8S_HANDLER_TIMEOUT_MS", env["ADAPTER_K8S_HANDLER_TIMEOUT_MS"]);
      vi.stubEnv(
        "ADAPTER_K8S_DISPATCH_PROOF_MAX_AGE_MS",
        env["ADAPTER_K8S_DISPATCH_PROOF_MAX_AGE_MS"],
      );
      try {
        const mod = await import("../src/routing-common.js");
        return { age: mod.DISPATCH_PROOF_MAX_AGE_MS, skew: mod.DISPATCH_PROOF_MAX_SKEW_MS };
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    };
    // Default: the original 120s, unchanged.
    expect(await load({})).toEqual({ age: 120_000, skew: 120_000 });
    // It moves with the handler budget an operator raises for a slow cluster…
    expect(await load({ ADAPTER_K8S_HANDLER_TIMEOUT_MS: "600000" })).toEqual({
      age: 1_200_000,
      skew: 1_200_000,
    });
    // …but never shrinks below the 120s floor when that budget is lowered.
    expect(await load({ ADAPTER_K8S_HANDLER_TIMEOUT_MS: "5000" })).toEqual({
      age: 120_000,
      skew: 120_000,
    });
    // An explicit override wins outright, in either direction — the escape hatch a cluster with a
    // known clock offset or a known queueing profile needs.
    expect(
      await load({
        ADAPTER_K8S_HANDLER_TIMEOUT_MS: "600000",
        ADAPTER_K8S_DISPATCH_PROOF_MAX_AGE_MS: "30000",
      }),
    ).toEqual({ age: 30_000, skew: 30_000 });
    // Garbage or a non-positive value falls back rather than disabling the window.
    for (const bad of ["not-a-number", "0", "-1", ""]) {
      expect(await load({ ADAPTER_K8S_DISPATCH_PROOF_MAX_AGE_MS: bad })).toEqual({
        age: 120_000,
        skew: 120_000,
      });
    }
  });

  it("binds the mint time itself, so it cannot be pushed forward to extend the window", () => {
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    const parts = proof.split(".") as [string, string, string, string];
    const restamped = `v3.${ISSUED_AT + 86_400_000}.${parts[2]}.${parts[3]}`;
    expect(
      verifyDispatchProof(SECRET, request, restamped, { nowMs: ISSUED_AT + 86_400_000 }),
    ).toEqual({ trusted: false, reason: "mismatch" });
  });

  it("parses only the credential shape it minted", () => {
    const proof = computeDispatchProof(
      SECRET,
      dispatchProofInputsFromRequest(request, { issuedAtMs: ISSUED_AT }),
    );
    expect(parseDispatchProof(proof)).toEqual({ issuedAtMs: ISSUED_AT, bodyDigest: undefined });
    // A bare v2-shaped hex MAC, a wrong version tag, a non-numeric time, a short MAC and a
    // malformed digest are all refused rather than coerced.
    for (const bad of [
      "0".repeat(64),
      `v2.${ISSUED_AT}.-.${"a".repeat(64)}`,
      `v3.later.-.${"a".repeat(64)}`,
      `v3.${ISSUED_AT}.-.${"a".repeat(63)}`,
      `v3.${ISSUED_AT}.zz.${"a".repeat(64)}`,
      `v3.${ISSUED_AT}.-.${"a".repeat(64)}.extra`,
    ]) {
      expect(parseDispatchProof(bad)).toBeUndefined();
    }
  });
});
