import { describe, it, expect } from "vitest";
import {
  gkeVersionAtLeast,
  parseGkeVersion,
  MIN_GKE_VERSION_FOR_CDN,
} from "../../src/cli/gke-version.js";

describe("gkeVersionAtLeast", () => {
  it("compares the semver part before the gke build number", () => {
    expect(gkeVersionAtLeast("1.35.5-gke.1057002", MIN_GKE_VERSION_FOR_CDN)).toBe(true);
    expect(gkeVersionAtLeast("1.36.0-gke.1", MIN_GKE_VERSION_FOR_CDN)).toBe(true);
    expect(gkeVersionAtLeast("1.34.9-gke.9999999", MIN_GKE_VERSION_FOR_CDN)).toBe(false);
  });

  it("compares the gke build number when the semver part is equal", () => {
    expect(gkeVersionAtLeast("1.35.2-gke.1751000", MIN_GKE_VERSION_FOR_CDN)).toBe(true);
    expect(gkeVersionAtLeast("1.35.2-gke.1751001", MIN_GKE_VERSION_FOR_CDN)).toBe(true);
    expect(gkeVersionAtLeast("1.35.2-gke.1750999", MIN_GKE_VERSION_FOR_CDN)).toBe(false);
  });

  it("returns null for unparseable versions", () => {
    expect(gkeVersionAtLeast("garbage", MIN_GKE_VERSION_FOR_CDN)).toBeNull();
    expect(gkeVersionAtLeast("1.35.2", MIN_GKE_VERSION_FOR_CDN)).toBeNull();
  });
});

describe("parseGkeVersion", () => {
  it("parses a standard GKE version string", () => {
    expect(parseGkeVersion("1.35.2-gke.1751000")).toEqual({
      major: 1,
      minor: 35,
      patch: 2,
      build: 1751000,
    });
  });

  it("tolerates trailing suffixes", () => {
    expect(parseGkeVersion("1.35.2-gke.1751000-rc1")?.build).toBe(1751000);
  });
});
