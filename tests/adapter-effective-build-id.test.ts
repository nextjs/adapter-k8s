// When next.config.deploymentId is set, Next pins the BUILD ID to the literal constant
// 'build-TfctsWXpff2fKS' (getBuildId, next/src/build/index.ts) — every build of every app
// collides. The adapter derives blue/green resource names, image tags, the CDN cutover
// cache-tag, and the Valkey namespace from the build id, so it must substitute something
// unique: the deploymentId itself (skew protection's own uniqueness contract). Before this,
// the e2e harness simply disabled deployment ids on cluster (ADAPTER_K8S_SET_DEPLOYMENT_ID=0)
// and the whole family failed: `?dpl=` asset URLs (next-image-legacy, 9 tests), web-worker
// NEXT_DEPLOYMENT_ID, and both deployment-skew suites (their next.config REFUSES to build
// without one).
import { describe, it, expect } from "vitest";
import { effectiveBuildId } from "../src/adapter.js";

const CONSTANT = "build-TfctsWXpff2fKS";

describe("effectiveBuildId", () => {
  it("passes a normal build id through untouched", () => {
    expect(effectiveBuildId("bms94qvpbx6x81x", undefined)).toBe("bms94qvpbx6x81x");
    expect(effectiveBuildId("bms94qvpbx6x81x", "ignored")).toBe("bms94qvpbx6x81x");
  });

  it("substitutes a docker/k8s-safe deploymentId verbatim for the pinned constant", () => {
    expect(effectiveBuildId(CONSTANT, "k8s-3f9a12bc45de")).toBe("k8s-3f9a12bc45de");
  });

  it("sanitizes an unsafe deploymentId deterministically and keeps it unique", () => {
    const a = effectiveBuildId(CONSTANT, "my deploy/v2!");
    const b = effectiveBuildId(CONSTANT, "my deploy/v3!");
    expect(a).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
    expect(effectiveBuildId(CONSTANT, "my deploy/v2!")).toBe(a);
  });

  it("throws when the constant appears with NO deploymentId to substitute", () => {
    expect(() => effectiveBuildId(CONSTANT, undefined)).toThrow(/deploymentId/);
  });
});
