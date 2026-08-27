// tests/pool-server/forwarded-proto.test.ts
// S25: x-forwarded-proto is the pool's ONLY witness of the client-facing scheme (TLS terminates at
// the load balancer, so the pool's own socket is always plain http). It decides middleware's
// request URL, the relative-vs-absolute middleware redirect comparison, and — since WebSocket
// support landed — the same-origin authority a browser's `Origin` is compared against. The parse
// had no test of its own, so nothing pinned which element of a multi-hop chain wins.
//
// The pinned answer is the LEFTMOST element: append conventions are client-first (RFC 7239 §4
// orders elements client-first; `X-Forwarded-For` does the same), so the TLS-terminating outer hop
// contributes the leftmost element and an appending inner hop — which only ever saw the plaintext
// leg — contributes the rightmost. See S25 in src/pool-server/dispatch.ts.
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
    // The topology this ordering exists for: a TLS-terminating outer LB writes https, an appending
    // inner hop adds its own plaintext observation. Reading the rightmost element here derives
    // http and 403s every browser wss:// handshake against the app's own origin.
    ["https,http", "https", "leftmost hop wins: the TLS terminator is the outermost hop"],
    ["https, http", "https", "Node joins repeated header instances into one comma list"],
    ["http,https", "http", "leftmost hop wins: the client-facing leg was plaintext"],
    [["https", "http"], "https", "array shape (repeated instances) is joined, not indexed"],
    [["http"], "http", "single-element array shape"],
    ["https,", "https", "trailing empty element is skipped, not treated as garbage"],
    [",https", "https", "leading empty element"],
    ["", undefined, "empty header value carries no witness"],
    ["   ", undefined, "whitespace-only header value carries no witness"],
    ["javascript", undefined, "not one of the two real schemes"],
    ["wss", undefined, "the handshake's URL scheme is not a forwarding witness"],
    ["httpsx", undefined, "no prefix matching"],
    // Garbage in the client-facing position must NOT fall through to the element on its right:
    // that element belongs to a hop which only ever saw the plaintext leg, so it cannot stand in
    // as a witness of the client's scheme.
    ["javascript,https", undefined, "garbage leftmost element does not fall further right"],
    ["https;q=1,https", undefined, "parameters are not part of this field's grammar"],
    ["https,javascript", "https", "junk appended by an inner hop cannot demote the outer hop"],
  ] as const)("%j → %s (%s)", (value, expected) => {
    expect(validatedForwardedProtocol(withHeader(value as string | string[] | undefined))).toBe(
      expected,
    );
  });
});
