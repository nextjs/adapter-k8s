import { describe, it, expect } from "vitest";
import {
  sanitizeK8sName,
  assertSafeReleaseName,
  assertSafeProjectId,
  assertSafeRegion,
} from "../../../src/emit/templates/utils.js";

describe("sanitizeK8sName", () => {
  it("never emits a name ending in a hyphen when truncation lands on one", () => {
    // 62 'a's + '-' + 10 'z's = 73 chars. Truncating to 63 lands exactly on the hyphen.
    const input = "a".repeat(62) + "-" + "z".repeat(10);
    const result = sanitizeK8sName(input);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result.endsWith("-")).toBe(false);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
    expect(/^[a-z]/.test(result)).toBe(true);
  });

  it("strips trailing hyphens introduced by the 63-char boundary", () => {
    const result = sanitizeK8sName("valid-name-" + "x".repeat(60) + "-suffix");
    expect(result.length).toBeLessThanOrEqual(63);
    expect(/-$/.test(result)).toBe(false);
  });

  it("handles all-special-character input", () => {
    const result = sanitizeK8sName("!!!@@@###");
    expect(result.length).toBeGreaterThan(0);
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
    expect(result.endsWith("-")).toBe(false);
  });

  it("handles empty input", () => {
    const result = sanitizeK8sName("");
    expect(result.length).toBeGreaterThan(0);
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(/[a-z0-9]$/.test(result)).toBe(true);
  });

  it("prepends a letter when the name starts with a digit", () => {
    const result = sanitizeK8sName("123abc");
    expect(/^[a-z]/.test(result)).toBe(true);
    expect(result).toContain("123abc");
  });

  it("produces the `b-` prefixed version label the blue/green cutover depends on", () => {
    // REGRESSION: the deploy.ts cutover patches the active Service's
    // app.kubernetes.io/version selector to sanitizeK8sName(buildId), and pods carry
    // the same value as their label. A build id starting with a digit MUST get the
    // `b-` prefix in BOTH places — a cutover copy that omitted it selected zero pods,
    // draining the Service to no endpoints and 503'ing the site. Pin the exact value.
    expect(sanitizeK8sName("7s_BTPTfkofoG2MRK25lK")).toBe("b-7s-btptfkofog2mrk25lk");
  });

  it("passes through a normal name unchanged", () => {
    expect(sanitizeK8sName("nextjs-ssr")).toBe("nextjs-ssr");
  });
});

describe("assertSafeReleaseName", () => {
  it("accepts safe release names", () => {
    expect(() => assertSafeReleaseName("nextjs")).not.toThrow();
    expect(() => assertSafeReleaseName("my-app-1")).not.toThrow();
  });

  it("rejects release names with shell metacharacters", () => {
    expect(() => assertSafeReleaseName('foo";rm -rf /;"')).toThrow(/Invalid releaseName/);
    expect(() => assertSafeReleaseName("foo$(whoami)")).toThrow(/Invalid releaseName/);
    expect(() => assertSafeReleaseName("Upper")).toThrow(/Invalid releaseName/);
  });
});

describe("assertSafeProjectId", () => {
  it("accepts valid GCP project ids", () => {
    expect(() => assertSafeProjectId("my-project")).not.toThrow();
    expect(() => assertSafeProjectId("proj123")).not.toThrow();
  });

  it("rejects project ids with injection payloads", () => {
    expect(() => assertSafeProjectId('a";curl evil"')).toThrow(/Invalid projectId/);
    expect(() => assertSafeProjectId("bad")).toThrow(/Invalid projectId/); // too short
  });
});

describe("assertSafeRegion", () => {
  it("accepts valid regions", () => {
    expect(() => assertSafeRegion("us-central1")).not.toThrow();
  });

  it("rejects regions with metacharacters", () => {
    expect(() => assertSafeRegion("us-central1;reboot")).toThrow(/Invalid region/);
  });
});
