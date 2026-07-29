// tests/pool-server/ssrf-address-filter.test.ts
//
// S23 (SECURITY). The /_next/image SSRF filter's address classifier. It had NO test coverage:
// nothing under tests/ mentioned 169.254 or called isPrivateAddress/hostResolvesToPublicOnly,
// and index.smoke.test.ts advertised "/_next/image SSRF/XSS guards" while asserting only about
// corrupt images and redirects. That absence is why the IPv6 gaps survived — the predicate
// matched string PREFIXES and knew IPv4-mapped addresses only in their dotted spelling, while
// the WHATWG URL parser normalizes them to hex (`::ffff:169.254.169.254` → `::ffff:a9fe:a9fe`).
import { describe, it, expect } from "vitest";
import { isPrivateAddress } from "../../src/pool-server/index.js";

const BLOCKED = [
  // IPv4
  ["169.254.169.254", "GCE metadata server"],
  ["127.0.0.1", "loopback"],
  ["0.0.0.0", "this host"],
  ["10.1.2.3", "RFC1918 /8"],
  ["172.16.0.1", "RFC1918 /12"],
  ["172.31.255.254", "RFC1918 /12 upper bound"],
  ["192.168.1.1", "RFC1918 /16"],
  ["100.64.0.1", "CGNAT"],
  ["224.0.0.1", "multicast"],
  // IPv6 — the forms the old prefix matcher missed
  ["::ffff:a9fe:a9fe", "IPv4-mapped metadata, HEX form (what URL parsing produces)"],
  ["::ffff:169.254.169.254", "IPv4-mapped metadata, dotted form"],
  ["0:0:0:0:0:ffff:a9fe:a9fe", "IPv4-mapped metadata, fully expanded"],
  ["::ffff:7f00:1", "IPv4-mapped loopback, hex"],
  ["::ffff:127.0.0.1", "IPv4-mapped loopback, dotted"],
  ["::a9fe:a9fe", "IPv4-compatible metadata"],
  ["64:ff9b::a9fe:a9fe", "NAT64 well-known prefix — routes wherever DNS64/NAT64 exists"],
  ["2002:a9fe:a9fe::", "6to4 embedding the metadata address"],
  ["fe80::1", "link-local"],
  ["fe90::1", "link-local — fe80::/10, not just the fe80 prefix"],
  ["febf::1", "link-local upper bound"],
  ["fc00::1", "unique-local"],
  ["fd12:3456::1", "unique-local"],
  ["ff02::1", "multicast"],
  ["::1", "loopback"],
  ["::", "unspecified"],
  ["fe80::1%eth0", "zone id must not defeat the check"],
] as const;

const ALLOWED = [
  ["8.8.8.8", "public IPv4"],
  ["1.1.1.1", "public IPv4"],
  ["93.184.216.34", "public IPv4"],
  ["2606:2800:220:1:248:1893:25c8:1946", "public IPv6"],
  ["2001:4860:4860::8888", "public IPv6"],
  ["64:ff9b::808:808", "NAT64 wrapping a PUBLIC address stays allowed"],
] as const;

describe("isPrivateAddress (S23)", () => {
  for (const [ip, why] of BLOCKED) {
    it(`blocks ${ip} — ${why}`, () => {
      expect(isPrivateAddress(ip)).toBe(true);
    });
  }

  for (const [ip, why] of ALLOWED) {
    it(`allows ${ip} — ${why}`, () => {
      expect(isPrivateAddress(ip)).toBe(false);
    });
  }

  it("treats anything unparseable as unsafe", () => {
    for (const junk of ["", "not-an-ip", "::ffff:999.1.1.1", "1.2.3", "gg::1", "1::2::3"]) {
      expect(isPrivateAddress(junk)).toBe(true);
    }
  });

  it("classifies the hex and dotted spellings of one address identically", () => {
    // The old predicate did not: URL normalization produces the hex form, so the dotted-only
    // branch was dead on anything that arrived through a URL.
    for (const [hex, dotted] of [
      ["::ffff:a9fe:a9fe", "::ffff:169.254.169.254"],
      ["::ffff:7f00:1", "::ffff:127.0.0.1"],
      ["::ffff:808:808", "::ffff:8.8.8.8"],
    ] as const) {
      expect(isPrivateAddress(hex)).toBe(isPrivateAddress(dotted));
    }
  });
});
