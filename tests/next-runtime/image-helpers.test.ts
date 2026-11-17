import { describe, expect, it, vi } from "vitest";
import { loadImageHashHelpers, loadImageSharp } from "../../src/next-runtime/image-helpers.js";

describe("app-local image helper compatibility", () => {
  it.each([false, true])("uses the app's helpers with split modules=%s", (split) => {
    const helpers = { getHash: vi.fn(() => "hash"), extractEtag: vi.fn(() => "etag") };
    const sharp = { getSharp: vi.fn(() => "native-sharp") };
    const appRequire = vi.fn((id: string): unknown => {
      if (id === "next/dist/server/image-optimizer") return split ? {} : { ...helpers, ...sharp };
      if (split && id === "next/dist/server/image-optimizer/extract-etag") return helpers;
      if (split && id === "next/dist/server/image-optimizer/transform") return sharp;
      throw new Error(`Unexpected module: ${id}`);
    });
    const loaded = loadImageHashHelpers(appRequire);
    expect(loaded.getHash(["build", 1])).toBe("hash");
    expect(loaded.extractEtag(null, Buffer.from("image"))).toBe("etag");
    expect(loadImageSharp(appRequire, 2, false)).toBe("native-sharp");
    expect(sharp.getSharp).toHaveBeenCalledWith(2, false);
    if (!split)
      expect(appRequire.mock.calls.every(([id]) => id === "next/dist/server/image-optimizer")).toBe(
        true,
      );
  });

  it("preserves native-loader failures for the existing unavailable-image response", () => {
    const failure = new Error("native module unavailable");
    const appRequire = (id: string): unknown => {
      if (id === "next/dist/server/image-optimizer") return {};
      throw failure;
    };
    expect(() => loadImageSharp(appRequire, null, null)).toThrow(failure);
  });
});
