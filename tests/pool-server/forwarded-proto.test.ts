// tests/pool-server/forwarded-proto.test.ts
// S25: x-forwarded-proto is the pool's ONLY witness of the client-facing scheme (TLS terminates at
// the load balancer, so the pool's own socket is always plain http). It decides middleware's
// request URL, the relative-vs-absolute middleware redirect comparison, and — since WebSocket
// support landed — the same-origin authority a browser's `Origin` is compared against. The parse
// had no test of its own, so nothing pinned which element of a multi-hop chain wins.
import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { validatedForwardedProtocol } from "../../src/pool-server/dispatch.js";

function withHeader(value: string | string[] | undefined): IncomingMessage {
  return {
    headers: value === undefined ? {} : { "x-forwarded-proto": value },
  } as IncomingMessage;
}

describe("validatedForwardedProtocol", () => {
  it.each([
    // [x-forwarded-proto, expected, why]
    [undefined, undefined, "absent: the caller falls back to http (or socket.encrypted)"],
    ["https", "https", "single value stamped by the trusted edge"],
    ["http", "http", "single plaintext value"],
    ["HTTPS", "https", "URI schemes are case-insensitive (RFC 3986 §3.1)"],
    ["  Https  ", "https", "optional whitespace around a list element"],
    ["http,https", "https", "rightmost hop wins: the edge appended https"],
    // The spoof case. Leftmost parsing returned "https" here — a client-supplied value overriding
    // the trusted edge's own witness.
    ["https,http", "http", "rightmost hop wins: the client prepended https, the edge said http"],
    ["https, http", "http", "Node joins repeated header instances into one comma list"],
    [["https", "http"], "http", "array shape (repeated instances) is joined, not indexed"],
    [["http"], "http", "single-element array shape"],
    ["https,", "https", "trailing empty element is skipped, not treated as garbage"],
    [",https", "https", "leading empty element"],
    ["", undefined, "empty header value carries no witness"],
    ["   ", undefined, "whitespace-only header value carries no witness"],
    ["javascript", undefined, "not one of the two real schemes"],
    ["wss", undefined, "the handshake's URL scheme is not a forwarding witness"],
    ["httpsx", undefined, "no prefix matching"],
    // Garbage on the right must NOT fall back to the element on its left: that would let a client
    // promote its own value past the trusted edge's by appending junk.
    ["https,javascript", undefined, "garbage rightmost element does not fall further left"],
    ["https,http;q=1", undefined, "parameters are not part of this field's grammar"],
  ] as const)("%j → %s (%s)", (value, expected) => {
    expect(validatedForwardedProtocol(withHeader(value as string | string[] | undefined))).toBe(
      expected,
    );
  });
});
