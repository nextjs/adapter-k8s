import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PINNED_NEXT_CANARY,
  SUPPORTED_NEXT_RELEASE_LINE,
  assertSupportedNextVersion,
  checkSupportedNextVersion,
} from "../../src/next-runtime/version.js";

describe("supported Next.js runtime release line", () => {
  it.each(["16.3.0", "16.3.7"])("accepts %s", (version) => {
    expect(checkSupportedNextVersion(version)).toEqual({ supported: true, prerelease: false });
    expect(() => assertSupportedNextVersion(version, "test manifest")).not.toThrow();
  });

  it("accepts the pinned 16.3 canary conformance lane deliberately", () => {
    expect(checkSupportedNextVersion(PINNED_NEXT_CANARY)).toEqual({
      supported: true,
      prerelease: true,
    });
  });

  it.each<unknown>([
    "16.2.10",
    "16.4.0",
    "17.0.0",
    "canary",
    "16.3",
    "16.3.0-beta.1",
    "16.3.0-canary.96",
    "16.3.0-canary.98",
    "16.3.1-canary.1",
    "016.3.0",
    undefined,
    null,
  ])("rejects %s", (version) => {
    expect(() => assertSupportedNextVersion(version, "test manifest")).toThrow(
      new RegExp(SUPPORTED_NEXT_RELEASE_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  it("keeps the package and user-facing requirement on the same bounded line", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8")) as {
      peerDependencies: { next: string };
      engines: { node: string };
    };
    const readme = readFileSync(`${root}/README.md`, "utf8");

    expect(pkg.peerDependencies.next).toBe(SUPPORTED_NEXT_RELEASE_LINE);
    expect(pkg.engines.node).toBe(">=20.16.0 <21 || >=22.3.0");
    expect(readme).toContain("Next.js >= 16.3.0 and < 16.4.0");
    expect(readme).toContain("Node.js >= 20.16.0 on Node 20, or >= 22.3.0");
  });
});
