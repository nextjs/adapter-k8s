// tests/emit/metadata.test.ts
import { describe, it, expect } from "vitest";
import { generateBuildMetadata } from "../../src/emit/metadata.js";

const base = {
  buildId: "b12345",
  nextVersion: "16.2.0",
  provider: "generic",
  namespace: "apps",
  targetPlatform: "linux/arm64" as const,
  poolNames: ["ssr"],
  defaultPool: "ssr",
  generatedAt: "2026-01-01T00:00:00.000Z",
  containerStrategy: "traced-assets" as const,
  hasMiddleware: true,
  failureModeAllow: false,
  cacheEnabled: true,
  cacheManaged: true,
  incrementalCacheHandler: true,
};

describe("generateBuildMetadata", () => {
  it("serializes exactly what it is given (no local defaults to drift)", () => {
    expect(JSON.parse(generateBuildMetadata(base))).toEqual({
      buildId: "b12345",
      nextVersion: "16.2.0",
      provider: "generic",
      namespace: "apps",
      targetPlatform: "linux/arm64",
      pools: ["ssr"],
      defaultPool: "ssr",
      generatedAt: "2026-01-01T00:00:00.000Z",
      containerStrategy: "traced-assets",
      hasMiddleware: true,
      failureModeAllow: false,
      cacheEnabled: true,
      cacheManaged: true,
      incrementalCacheHandler: true,
    });
  });

  // N50 (review, Medium): `failureModeAllow ?? true` defaulted to fail-OPEN — the
  // middleware-BYPASS direction — in the file that records the fail-closed decision
  // (invariant 2). The field is required now, so an omission is a compile error rather
  // than a silent inversion. containerStrategy/cacheEnabled had the same shape and
  // duplicated config.ts applyDefaults.
  it("has no fail-open default: a fail-closed build records failureModeAllow false", () => {
    const closed = JSON.parse(generateBuildMetadata({ ...base, failureModeAllow: false }));
    expect(closed.failureModeAllow).toBe(false);
    // …and an explicitly fail-open build is still recorded faithfully.
    const open = JSON.parse(generateBuildMetadata({ ...base, failureModeAllow: true }));
    expect(open.failureModeAllow).toBe(true);
    // The field can never be absent (required at the type level), so `undefined` can no
    // longer be coerced to the bypass direction.
    expect("failureModeAllow" in closed).toBe(true);
  });

  it("records incrementalCacheHandler:false when the shared ISR handler was skipped", () => {
    const meta = JSON.parse(
      generateBuildMetadata({ ...base, cacheEnabled: true, incrementalCacheHandler: false }),
    );
    // cacheEnabled stays true: the managed cache is still provisioned and still backs
    // `use cache` (V2 handler, registered at runtime via the global symbol) — only the
    // INCREMENTAL (ISR/PPR-shell) handler is absent.
    expect(meta.cacheEnabled).toBe(true);
    expect(meta.incrementalCacheHandler).toBe(false);
  });

  it("omits cacheMemorystore when absent and includes it when supplied", () => {
    expect(JSON.parse(generateBuildMetadata(base)).cacheMemorystore).toBeUndefined();
    expect(
      JSON.parse(generateBuildMetadata({ ...base, cacheMemorystore: { region: "us-central1" } }))
        .cacheMemorystore,
    ).toEqual({ region: "us-central1" });
  });

  it("records the shared pool image layout only when the build emitted it", () => {
    expect(JSON.parse(generateBuildMetadata(base)).poolImageLayout).toBeUndefined();
    expect(
      JSON.parse(generateBuildMetadata({ ...base, poolImageLayout: "shared-base-v1" }))
        .poolImageLayout,
    ).toBe("shared-base-v1");
  });
});
