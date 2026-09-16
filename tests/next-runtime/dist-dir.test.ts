import { describe, expect, it } from "vitest";
import { normalizeNextDistDir, resolveNextDistDir } from "../../src/next-runtime/dist-dir.js";

describe("Next distDir runtime contract", () => {
  it("defaults retained manifests to .next", () => {
    expect(normalizeNextDistDir(undefined)).toBe(".next");
  });

  it("resolves a validated project-relative directory", () => {
    expect(resolveNextDistDir("/app", "build/output")).toEqual({
      relative: "build/output",
      absolute: "/app/build/output",
    });
  });

  it.each([".", "../escape", "/absolute", "C:\\escape", "build/../../escape", ""])(
    "rejects unsafe distDir %j",
    (distDir) => {
      expect(() => normalizeNextDistDir(distDir)).toThrow(/distDir/);
    },
  );
});
