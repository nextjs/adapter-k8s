import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PINNED_NEXT_CANARY,
  NEXT_VERSION_OVERRIDE_ENV,
  SUPPORTED_NEXT_RELEASE_LINE,
  TESTED_NEXT_RELEASE_LINE,
  assertSupportedNextVersion,
  checkSupportedNextVersion,
} from "../../src/next-runtime/version.js";

describe("supported Next.js runtime release line", () => {
  beforeEach(() => {
    vi.stubEnv(NEXT_VERSION_OVERRIDE_ENV, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["17.0.0", "16.4.0-canary.1", "16.3.2", "invalid", undefined])(
    "turns rejection of %s into a visible warning with the explicit override",
    (version) => {
      vi.stubEnv(NEXT_VERSION_OVERRIDE_ENV, "1");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // The policy check still reports the incompatibility; only enforcement is overridden.
      expect(checkSupportedNextVersion(version).supported).toBe(false);
      expect(assertSupportedNextVersion(version, "test manifest")).toMatchObject({
        supported: true,
        prerelease: version === "16.4.0-canary.1",
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(`Continuing because ${NEXT_VERSION_OVERRIDE_ENV}=1`),
      );
    },
  );

  it.each(["0", "true", "yes", ""])("keeps enforcement for override value %j", (value) => {
    vi.stubEnv(NEXT_VERSION_OVERRIDE_ENV, value);
    expect(() => assertSupportedNextVersion("17.0.0", "test manifest")).toThrow(
      /outside the supported Next.js release line/,
    );
  });

  it.each(["16.3.3", "16.3.4", "16.3.7"])("accepts %s", (version) => {
    expect(checkSupportedNextVersion(version)).toEqual({ supported: true, prerelease: false });
    expect(() => assertSupportedNextVersion(version, "test manifest")).not.toThrow();
  });

  it.each(["16.4.0", "16.4.1", "16.5.0", "16.99.0+build.1"])(
    "warns but accepts untested stable %s",
    (version) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(assertSupportedNextVersion(version, "test manifest")).toMatchObject({
          supported: true,
          prerelease: false,
        });
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining(`outside the tested Next.js range ${TESTED_NEXT_RELEASE_LINE}`),
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("accepts the pinned 16.3 canary conformance lane deliberately", () => {
    expect(checkSupportedNextVersion(PINNED_NEXT_CANARY)).toEqual({
      supported: true,
      prerelease: true,
    });
  });

  it.each<unknown>([
    "16.2.10",
    "16.3.0",
    "16.3.1",
    "16.3.2",
    "16.4.0-canary.1",
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
    expect(readme).toContain("Next.js >= 16.3.3 and < 17.0.0");
    expect(readme).toContain("Node.js >= 20.16.0 on Node 20, or >= 22.3.0");
  });
});
