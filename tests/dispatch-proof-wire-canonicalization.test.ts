// tests/dispatch-proof-wire-canonicalization.test.ts
//
// A0-DP-2 / A0-DP-3 / A0-DP-5. The dispatch proof across the TIER BOUNDARY, over a real socket.
//
// tests/routing-common.dispatch-proof.test.ts pins the transcript's construction; the two tier
// test files pin each side's signing and verifying against synthetic requests. Neither could see
// the defect this file exists for, because both sides were handed the same JS STRING:
//
//   • the ext_proc edge materialized covered values by decoding Envoy's `raw_value` as UTF-8,
//   • the pool reads Node's `req.headers`, which llhttp decodes as LATIN1,
//   • and `updateProofField` then encoded whichever string it was given as UTF-8.
//
// So one request's wire octets produced two different transcripts as soon as any covered value
// carried a byte above 0x7F: the proof never verified, the pool stripped the dispatch vocabulary,
// and middleware ran a second time on every such request — permanently and silently.
//
// Every test here therefore drives the REAL edge handler, applies its mutation response the way
// Envoy does, puts the result on a REAL socket, and verifies through the REAL pool trust boundary.
// A canonicalization that is only self-consistent within one tier cannot pass.
//
// The A0-DP-5 block at the bottom uses the same shape for the two properties that are about a
// TRANSMISSION rather than a tuple — the freshness window and the cross-pool body binding — since
// both are only meaningful against a request that really crossed a socket.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { once } from "node:events";
import { createRequestHandler } from "../src/routing-service/handler.js";
import {
  applyIncomingRequestTrustBoundary,
  enforceDispatchBodyBinding,
} from "../src/pool-server/server.js";
import { mockRouting } from "./helpers/mock-outputs.js";
import {
  buildProofHeaderNames,
  computeDispatchProof,
  DISPATCH_PROOF_MAX_AGE_MS,
  dispatchProofInputsFromRequest,
  INTERNAL_DISPATCH_PROOF_HEADER,
} from "../src/routing-common.js";
import type { RoutingManifest, MiddlewareMatcher } from "../src/types.js";
import type { HeaderValue } from "../src/routing-service/ext-proc-types.js";

vi.mock("@next/routing", async (importOriginal) => {
  const mocked = {
    ...(await importOriginal<typeof import("@next/routing")>()),
    resolveRoutes: vi.fn(),
  };
  return { ...mocked, default: mocked };
});

import { resolveRoutes } from "@next/routing";

const SECRET = "s3cr3t";
const AUTHORITY = "app.example.com";

/**
 * A build whose middleware `matcher` gates on a cookie, so `cookie` is in this build's covered set
 * (`matcherProofHeaderNames`) — the ordinary-traffic route into the defect: a covered cookie value
 * is entirely client-controlled and routinely carries non-ASCII bytes.
 */
function makeManifest(matchers?: MiddlewareMatcher[]): RoutingManifest {
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
    middleware: matchers ? ({ matchers } as never) : null,
    poolAssignments: { "/": "ssr", "/about": "ssr", "/api/hello": "api" },
    pprRoutes: {},
    nextVersion: "16.2.0",
  } as RoutingManifest;
}

/** The ext_proc request-header list Envoy delivers. `bytes` entries model `raw_value`. */
function extProcHeaders(
  target: string,
  extra: Iterable<readonly [string, Buffer | string]> = [],
): HeaderValue[] {
  const entries: HeaderValue[] = [
    { key: ":path", value: target },
    { key: ":method", value: "GET" },
    { key: ":scheme", value: "https" },
    { key: ":authority", value: AUTHORITY },
    { key: "host", value: AUTHORITY },
  ];
  for (const [key, value] of extra) {
    // Envoy delivers header values in `raw_value` (bytes) whenever it has them, and `raw_value`
    // is the ONLY field that can carry an octet that is not valid UTF-8 — `value` is a proto3
    // string. src/routing-service/server.ts carries both across, so model both.
    entries.push(
      Buffer.isBuffer(value) ? { key, rawValue: value } : ({ key, value } as HeaderValue),
    );
  }
  return entries;
}

/**
 * Apply an ext_proc header-mutation response the way Envoy does, and serialize the result to the
 * exact octets Envoy writes on the upstream HTTP/1.1 request.
 *
 * The two encodings here are the whole point of the test: a client's own header keeps its wire
 * octets verbatim, while a value this response SET travels as the UTF-8 encoding of the proto3
 * `string` Envoy was handed.
 */
function envoyUpstreamBytes(
  entries: HeaderValue[],
  mutation: {
    setHeaders?: { header: { key?: string; value?: string } }[];
    removeHeaders?: string[];
  },
  method = "GET",
): Buffer {
  const removed = new Set((mutation.removeHeaders ?? []).map((name) => name.toLowerCase()));
  const set = new Map<string, Buffer>();
  for (const entry of mutation.setHeaders ?? []) {
    set.set(entry.header.key!.toLowerCase(), Buffer.from(entry.header.value ?? "", "utf8"));
  }
  const target =
    entries.find((h) => h.key === ":path")?.value ??
    entries.find((h) => h.key === ":path")?.rawValue?.toString("latin1") ??
    "/";

  const lines: Buffer[] = [Buffer.from(`${method} ${target} HTTP/1.1\r\n`, "latin1")];
  const emit = (name: string, value: Buffer) => {
    lines.push(Buffer.from(`${name}: `, "latin1"), value, Buffer.from("\r\n", "latin1"));
  };
  for (const entry of entries) {
    if (entry.key.startsWith(":")) continue;
    const lower = entry.key.toLowerCase();
    if (removed.has(lower) || set.has(lower)) continue;
    emit(entry.key, entry.rawValue ?? Buffer.from(entry.value ?? "", "utf8"));
  }
  for (const [name, value] of set) emit(name, value);
  lines.push(Buffer.from("connection: close\r\n\r\n", "latin1"));
  return Buffer.concat(lines);
}

/**
 * A bare TCP listener that records the request head Node's HTTP client wrote and emits
 * `"captured"` — the only way to see the OCTETS rather than Node's own re-decoding of them.
 */
function createRawServer(into: Buffer[]): ReturnType<typeof createNetServer> {
  const server = createNetServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      into.push(chunk);
      if (Buffer.concat(into).includes("\r\n\r\n")) {
        socket.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        server.emit("captured");
      }
    });
    socket.on("error", () => undefined);
  });
  return server;
}

/** Whatever the pool's trust boundary decided for the request that reached it. */
interface PoolVerdict {
  trusted: boolean;
  /** `x-mw-evaluated` as it survived the boundary — absent means the strip fired. */
  mwEvaluated: string | undefined;
}

/**
 * Run raw request octets through a real Node HTTP server and the real pool trust boundary. The
 * socket is the point: it is what turns the edge's UTF-8 view of a value into the pool's latin1
 * view of the same octets, which no in-process test of either tier can reproduce.
 */
async function throughPoolBoundary(
  raw: Buffer,
  proofHeaderNames: readonly string[],
): Promise<PoolVerdict> {
  let verdict: PoolVerdict | undefined;
  const server = createServer((req, res) => {
    const trusted = applyIncomingRequestTrustBoundary(req, {
      internalSecret: SECRET,
      proofHeaderNames,
    });
    verdict = { trusted, mwEvaluated: req.headers["x-mw-evaluated"] as string | undefined };
    res.writeHead(204).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const socket = connect(port, "127.0.0.1");
    await once(socket, "connect");
    // Drain the response: without a reader the socket never processes the server's FIN, so
    // "close" would never fire.
    socket.resume();
    socket.write(raw);
    await once(socket, "close");
  } finally {
    server.close();
    await once(server, "close");
  }
  if (!verdict) throw new Error("the pool server never saw a request");
  return verdict;
}

/** Mint a proof through the real edge handler and hand the result to the real pool boundary. */
async function edgeToPool(args: {
  target: string;
  matchers?: MiddlewareMatcher[];
  wireHeaders?: Iterable<readonly [string, Buffer | string]>;
  resolution?: Record<string, unknown>;
}): Promise<PoolVerdict & { proof: string | undefined }> {
  const manifest = makeManifest(args.matchers);
  const proofHeaderNames = buildProofHeaderNames(manifest);
  vi.mocked(resolveRoutes).mockResolvedValue(
    (args.resolution ?? {
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    }) as never,
  );
  const entries = extProcHeaders(args.target, args.wireHeaders ?? []);
  const response = await createRequestHandler(manifest, null)(entries);
  const mutation = response.requestHeaders!.response!.headerMutation!;
  const proof = mutation.setHeaders?.find((h) => h.header.key === INTERNAL_DISPATCH_PROOF_HEADER)
    ?.header.value;
  const verdict = await throughPoolBoundary(
    envoyUpstreamBytes(entries, mutation),
    proofHeaderNames,
  );
  return { ...verdict, proof };
}

const COOKIE_MATCHER: MiddlewareMatcher[] = [
  { regexp: "^/.*$", has: [{ type: "cookie", key: "session" }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTERNAL_HEADER_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.INTERNAL_HEADER_SECRET;
});

describe("A0-DP-2 — the two tiers canonicalize the same wire octets (edge → pool)", () => {
  it("verifies a covered cookie whose value carries a multi-byte UTF-8 sequence", async () => {
    // The reproduced case: `cookie` is covered (the matcher has a cookie condition) and the value
    // carries `c3 a9`, the UTF-8 encoding of "é". Pre-fix the edge signed the 2-byte form while
    // the pool signed the 4-byte UTF-8 encoding of the latin1 mojibake "Ã©" — no verification,
    // ever, for any client holding such a cookie.
    const cookie = Buffer.concat([Buffer.from("session=caf", "latin1"), Buffer.from([0xc3, 0xa9])]);
    const result = await edgeToPool({
      target: "/about",
      matchers: COOKIE_MATCHER,
      wireHeaders: [["cookie", cookie]],
    });
    expect(result.proof).toBeDefined();
    expect(result.trusted).toBe(true);
    expect(result.mwEvaluated).toBeDefined();
  });

  it("verifies when the EDGE authors the non-ASCII value (x-invoke-query from a rewrite)", async () => {
    // The always-covered half: `x-invoke-query` is built from percent-DECODED query values via
    // JSON.stringify, which does not \u-escape non-ASCII — so a plain `/posts/café` diverged with
    // no unusual client header involved at all. This value is authored HERE and crosses as the
    // UTF-8 encoding of a proto3 string, which is why a `string` proof field means UTF-8 while a
    // Node tier's own strings mean latin1.
    const result = await edgeToPool({
      target: "/posts/caf%C3%A9",
      resolution: {
        resolvedPathname: "/about",
        invocationTarget: { pathname: "/about", query: { slug: "café" } },
      },
    });
    expect(result.trusted).toBe(true);
  });

  it("still refuses a tampered covered value (the byte-level rule is not a weakening)", async () => {
    const manifest = makeManifest(COOKIE_MATCHER);
    const proofHeaderNames = buildProofHeaderNames(manifest);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as never);
    const entries = extProcHeaders("/about", [["cookie", Buffer.from([0xc3, 0xa9])]]);
    const response = await createRequestHandler(manifest, null)(entries);
    const mutation = response.requestHeaders!.response!.headerMutation!;
    // One octet of the covered cookie flipped in transit ("é" → "è").
    const tampered = extProcHeaders("/about", [["cookie", Buffer.from([0xc3, 0xa8])]]);
    const verdict = await throughPoolBoundary(
      envoyUpstreamBytes(tampered, mutation),
      proofHeaderNames,
    );
    expect(verdict.trusted).toBe(false);
    expect(verdict.mwEvaluated).toBeUndefined();
  });
});

describe("A0-DP-3 — repeated covered headers coalesce the way Node really does", () => {
  it("verifies when a client sends a covered SINGLETON header twice", async () => {
    // Envoy forwards both field lines upstream; Node's parser keeps only the FIRST and discards
    // the rest. The `", "` join therefore made the edge sign "first/1.0, second/2.0" against the
    // pool's "first/1.0" — no verification, for any build whose matcher gates on such a name.
    const result = await edgeToPool({
      target: "/about",
      matchers: [{ regexp: "^/.*$", has: [{ type: "header", key: "user-agent" }] }],
      wireHeaders: [
        ["user-agent", "first/1.0"],
        ["user-agent", "second/2.0"],
      ],
    });
    expect(result.trusted).toBe(true);
    expect(result.mwEvaluated).toBeDefined();
  });

  it("verifies when a client sends a covered JOINED header twice", async () => {
    // The other half of the rule, unchanged: `cookie` really is joined, with "; ".
    const result = await edgeToPool({
      target: "/about",
      matchers: COOKIE_MATCHER,
      wireHeaders: [
        ["cookie", "a=1"],
        ["cookie", "session=b"],
      ],
    });
    expect(result.trusted).toBe(true);
  });
});

describe("A0-DP-2 — the cross-pool hop is self-consistent (pool → pool)", () => {
  /**
   * The hop `proxyToPool` / the WS tunnel make: a pool signs over the outbound header record it is
   * about to hand Node's HTTP client, and the receiving pool verifies over its own `req.headers`.
   * Both ends are Node, so this hop only works if the signing encoding is the exact inverse of
   * Node's codec in BOTH directions — MEASURED here rather than assumed: Node's client writes an
   * outgoing value as latin1 (`"é"` → `e9`) and llhttp reads it back as latin1.
   */
  async function hop(
    headers: Record<string, string | string[]>,
    proofHeaderNames: readonly string[],
    target = "/about",
  ): Promise<PoolVerdict> {
    let verdict: PoolVerdict | undefined;
    const server = createServer((req: IncomingMessage, res) => {
      const trusted = applyIncomingRequestTrustBoundary(req, {
        internalSecret: SECRET,
        proofHeaderNames,
      });
      verdict = { trusted, mwEvaluated: req.headers["x-mw-evaluated"] as string | undefined };
      res.writeHead(204).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as { port: number };
      const outbound: Record<string, string | string[]> = { ...headers, host: AUTHORITY };
      outbound[INTERNAL_DISPATCH_PROOF_HEADER] = computeDispatchProof(
        SECRET,
        dispatchProofInputsFromRequest({
          method: "GET",
          target,
          headers: outbound,
          proofHeaderNames,
        }),
      );
      const req = httpRequest({ host: "127.0.0.1", port, path: target, headers: outbound });
      req.end();
      await once(req, "response");
    } finally {
      server.close();
      await once(server, "close");
    }
    if (!verdict) throw new Error("the receiving pool never saw a request");
    return verdict;
  }

  it("verifies a relayed covered value whose octets are above 0x7F", async () => {
    // "Ã©" — the latin1 string a pool holds after parsing the edge's UTF-8 `c3 a9`. Relaying it
    // must put the SAME two octets back on the wire, and the hop must sign those octets.
    const verdict = await hop({ cookie: "session=cafÃ©", "x-mw-evaluated": "ran" }, ["cookie"]);
    expect(verdict.trusted).toBe(true);
    expect(verdict.mwEvaluated).toBe("ran");
  });

  it("verifies a covered value carrying an octet that is not valid UTF-8 at all", async () => {
    // obs-text: a lone `0xe9`, which no UTF-8 decoder can represent. A latin1 round-trip carries
    // it exactly; the UTF-8 round-trip the proof used to do replaced it with U+FFFD (3 bytes).
    // Exercised on THIS hop rather than the edge→pool one because the ext_proc handler rejects a
    // non-UTF-8 header before the proof is minted at all — `new Headers()` on the decoded
    // U+FFFD throws a ByteString error, which is a separate (pre-existing, fail-open) behavior of
    // that tier and not something the proof gets a say in.
    const verdict = await hop(
      { cookie: Buffer.from([0xe9]).toString("latin1"), "x-mw-evaluated": "ran" },
      ["cookie"],
    );
    expect(verdict.trusted).toBe(true);
  });

  it("signs the exact octets Node's HTTP client writes for the value it authored", async () => {
    // The measurement the hop's correctness rests on, pinned in CI rather than assumed. Both hops
    // that sign here (`proxyToPool` and the WS tunnel) are Node writing to Node, so the two ends
    // agree under ANY fixed encoding — which is precisely why a wrong one is invisible from the
    // hop alone, and why the edge→pool tests above are the ones that catch a divergence. What
    // makes latin1 the RIGHT rule (rather than a rule that merely happens to close over itself) is
    // that it reproduces the octets Node actually emits: this test captures those octets off a raw
    // socket and compares them to the ones the signer fed the transcript.
    const captured: Buffer[] = [];
    const raw = createRawServer(captured);
    raw.listen(0, "127.0.0.1");
    await once(raw, "listening");
    const { port } = raw.address() as { port: number };
    // A hop-authored query value, percent-DECODED: `/posts/caf%C3%A9` → `{"slug":"café"}`.
    const authored = JSON.stringify({ slug: "café" });
    try {
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/about",
        headers: { host: AUTHORITY, "x-invoke-query": authored },
      });
      req.on("error", () => undefined);
      req.end();
      await once(raw, "captured");
    } finally {
      raw.close();
      await once(raw, "close");
    }
    const head = Buffer.concat(captured);
    const line = `x-invoke-query: ${authored}`;
    // Node wrote latin1: "é" is the single octet e9, not the UTF-8 pair c3 a9.
    expect(head.includes(Buffer.from(line, "latin1"))).toBe(true);
    expect(head.includes(Buffer.from(line, "utf8"))).toBe(false);
    // And that is exactly what the signer signed.
    const signed = dispatchProofInputsFromRequest({
      method: "GET",
      target: "/about",
      headers: { host: AUTHORITY, "x-invoke-query": authored },
    }).headers["x-invoke-query"];
    expect(Buffer.isBuffer(signed) && signed.equals(Buffer.from(authored, "latin1"))).toBe(true);
  });
});

describe("A0-DP-5 — the pool enforces the body binding and the freshness window", () => {
  /**
   * A real cross-pool hop, end to end: sign a POST the way `proxyToPool` does, send it with Node's
   * HTTP client, and run BOTH halves of the receiving pool's check — the header-phase trust
   * boundary and, once the body has been read, `enforceDispatchBodyBinding` (which index.ts calls
   * at its single body-buffering point). `sentBody` is what actually goes on the wire, so a test
   * can sign one body and transmit another, which is the replay this closes.
   */
  async function crossPoolPost(args: {
    signedBody: Buffer;
    sentBody?: Buffer;
    issuedAtMs?: number;
  }): Promise<{ trusted: boolean; bodyBound: boolean; mwEvaluated: string | undefined }> {
    const sentBody = args.sentBody ?? args.signedBody;
    let result:
      | { trusted: boolean; bodyBound: boolean; mwEvaluated: string | undefined }
      | undefined;
    const server = createServer((req, res) => {
      const trusted = applyIncomingRequestTrustBoundary(req, { internalSecret: SECRET });
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const bodyBound = enforceDispatchBodyBinding(req, Buffer.concat(chunks));
        result = {
          trusted,
          bodyBound,
          mwEvaluated: req.headers["x-mw-evaluated"] as string | undefined,
        };
        res.writeHead(204).end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as { port: number };
      const outbound: Record<string, string> = {
        host: AUTHORITY,
        "x-mw-evaluated": "ran",
        "x-output-id": "/api/submit",
        "content-length": String(sentBody.length),
      };
      outbound[INTERNAL_DISPATCH_PROOF_HEADER] = computeDispatchProof(
        SECRET,
        dispatchProofInputsFromRequest(
          { method: "POST", target: "/api/submit", headers: outbound },
          { body: args.signedBody, ...(args.issuedAtMs ? { issuedAtMs: args.issuedAtMs } : {}) },
        ),
      );
      const req = httpRequest({
        host: "127.0.0.1",
        port,
        path: "/api/submit",
        method: "POST",
        headers: outbound,
      });
      req.end(sentBody);
      await once(req, "response");
    } finally {
      server.close();
      await once(server, "close");
    }
    if (!result) throw new Error("the receiving pool never completed a request");
    return result;
  }

  it("accepts a body-bound cross-pool POST whose body is the one that was signed", async () => {
    const body = Buffer.from("formData=honest");
    const result = await crossPoolPost({ signedBody: body });
    expect(result.trusted).toBe(true);
    expect(result.bodyBound).toBe(true);
    // Trust survives, so the sibling pool honors the upstream middleware verdict.
    expect(result.mwEvaluated).toBe("ran");
  });

  it("revokes trust when the body does not match the one the proof bound", async () => {
    // The replay: an observed proof re-sent with attacker-chosen bytes. The MAC still verifies —
    // it covers headers and the DECLARED digest — so the header boundary cannot see it; the
    // body check does, and strips the dispatch vocabulary so the request re-resolves locally
    // (middleware runs against the real body).
    const result = await crossPoolPost({
      signedBody: Buffer.from("formData=honest"),
      sentBody: Buffer.from("formData=attack"),
    });
    expect(result.trusted).toBe(true);
    expect(result.bodyBound).toBe(false);
    expect(result.mwEvaluated).toBeUndefined();
  });

  it("refuses a credential minted outside the freshness window", async () => {
    const body = Buffer.from("formData=honest");
    const result = await crossPoolPost({
      signedBody: body,
      issuedAtMs: Date.now() - DISPATCH_PROOF_MAX_AGE_MS - 60_000,
    });
    expect(result.trusted).toBe(false);
    expect(result.mwEvaluated).toBeUndefined();
  });

  it("still accepts one minted a moment ago", async () => {
    const body = Buffer.from("formData=honest");
    const result = await crossPoolPost({ signedBody: body, issuedAtMs: Date.now() - 1_000 });
    expect(result.trusted).toBe(true);
    expect(result.bodyBound).toBe(true);
  });

  it("refuses a stale credential on the edge→pool path too", async () => {
    // The edge binds ABSENT for the body, so the mint time is the ONLY thing bounding a captured
    // ext_proc exchange — which is exactly the observer in the PR's threat model.
    const manifest = makeManifest();
    const proofHeaderNames = buildProofHeaderNames(manifest);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: "/about",
      invocationTarget: { pathname: "/about", query: {} },
    } as never);
    const entries = extProcHeaders("/about");
    const response = await createRequestHandler(manifest, null)(entries);
    const mutation = response.requestHeaders!.response!.headerMutation!;
    const raw = envoyUpstreamBytes(entries, mutation);
    // Fresh, it verifies.
    expect((await throughPoolBoundary(raw, proofHeaderNames)).trusted).toBe(true);
    // Replayed a day later — the identical octets — it does not.
    // Only Date is faked: the real socket/server below still needs real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 86_400_000);
      const replayed = await throughPoolBoundary(raw, proofHeaderNames);
      expect(replayed.trusted).toBe(false);
      expect(replayed.mwEvaluated).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
