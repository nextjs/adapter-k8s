import { describe, it, expect } from "vitest";
import {
  renderCdnFilter,
  DEFAULT_CDN_CACHE_KEY_HEADERS,
  NEXTJS_VARY_HEADERS,
} from "../../../src/emit/templates/gcp-http-filter.js";
import { INTERNAL_DISPATCH_HEADERS } from "../../../src/routing-common.js";

describe("renderCdnFilter", () => {
  const yaml = renderCdnFilter({ releaseName: "nextjs" });

  it("emits a GCPHTTPFilter with the verified schema fields", () => {
    expect(yaml).toContain("apiVersion: networking.gke.io/v1");
    expect(yaml).toContain("kind: GCPHTTPFilter");
    expect(yaml).toContain("name: nextjs-cdn");
    expect(yaml).toContain("cacheMode: USE_ORIGIN_HEADERS");
    expect(yaml).toContain("requestCoalescing: true");
    expect(yaml).toContain("negativeCaching: false");
    // Field name verified via kubectl explain against a live ≥1.35 cluster:
    // it is includedHeaderNames, NOT the includeHttpHeaders the docs excerpt suggested.
    expect(yaml).toContain("includedHeaderNames:");
    expect(yaml).not.toContain("includeHttpHeaders");
  });

  it("keys on the Next.js public Vary set and the dispatch verdict", () => {
    for (const header of NEXTJS_VARY_HEADERS) {
      expect(yaml).toContain(`- ${header}`);
    }
    for (const header of INTERNAL_DISPATCH_HEADERS) {
      if (header === "x-matched-pathname") continue;
      expect(yaml).toContain(`- ${header}`);
    }
  });

  it("omits x-matched-pathname (duplicates x-output-id) and never keys the secret", () => {
    expect(yaml).not.toContain("x-matched-pathname");
    expect(yaml).not.toContain("x-internal-secret");
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain("x-internal-secret");
    expect(DEFAULT_CDN_CACHE_KEY_HEADERS).not.toContain("x-matched-pathname");
  });

  it("rejects a cache-key list containing the internal secret header", () => {
    expect(() =>
      renderCdnFilter({ releaseName: "nextjs", cacheKeyHeaders: ["RSC", "X-Internal-Secret"] }),
    ).toThrow(/never be part of the CDN cache key/);
  });

  it("rejects cache-key header names with unsafe characters", () => {
    expect(() =>
      renderCdnFilter({ releaseName: "nextjs", cacheKeyHeaders: ["bad header\nname"] }),
    ).toThrow(/Invalid CDN cache-key header/);
  });

  it("rejects an unsafe releaseName", () => {
    expect(() => renderCdnFilter({ releaseName: 'foo";rm -rf /;"' })).toThrow(
      /Invalid releaseName/,
    );
  });

  it("sanitizes the filter name", () => {
    const out = renderCdnFilter({ releaseName: "0-weird" });
    expect(out).toContain("name: b-0-weird-cdn");
  });
});
