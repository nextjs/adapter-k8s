import { describe, expect, it } from "vitest";
import { decodeNextPathname } from "../../src/next-runtime/pathname.js";

describe("decodeNextPathname", () => {
  it.each([
    ["/%F0%9F%8E%89", "/🎉"],
    ["/a/%2F", "/a/%2F"],
    ["/a/%252F", "/a/%252F"],
    ["/a/%23", "/a/%23"],
    ["/a/%3F", "/a/%3F"],
    ["/a/%5C", "/a/\\"],
    ["/a/%255C", "/a/%255C"],
    ["/a/%25", "/a/%"],
    ["/a/%2525", "/a/%25"],
  ])("maps %s to %s", (pathname, expected) => {
    expect(decodeNextPathname(pathname)).toBe(expected);
  });

  it("leaves the whole pathname encoded when one segment is malformed", () => {
    expect(decodeNextPathname("/%F0%9F%8E%89/%ZZ")).toBe("/%F0%9F%8E%89/%ZZ");
  });
});
