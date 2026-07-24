import { describe, it, expect } from "vitest";
import { renderGateway, renderHTTPRoute } from "../../../src/emit/templates/gateway.js";
import type { PoolDefinition, HostConfig, RoutingManifest } from "../../../src/types.js";

function makePools(count: number): Map<string, PoolDefinition> {
  const pools = new Map<string, PoolDefinition>();
  for (let i = 0; i < count; i++) {
    const name = `pool${i}`;
    pools.set(name, { name, outputs: [], config: { routes: ["appPages"] } });
  }
  return pools;
}

const hosts: HostConfig[] = [{ hostname: "app.example.com", tls: { enabled: false } }];

function makeManifest(poolAssignments: Record<string, string>): RoutingManifest {
  return {
    routeGraph: { rsc: {} } as any,
    pathnames: [],
    i18n: null,
    buildId: "abc123",
    builtAt: "2026-01-01T00:00:00.000Z",
    basePath: "",
    middleware: null,
    poolAssignments,
    pprRoutes: {},
    nextVersion: "16.2.0",
  };
}

describe("renderHTTPRoute rule cap", () => {
  it("never emits more than 16 rules, keeping every pool header rule and the catch-all", () => {
    const pools = makePools(8); // pool0..pool7 — pool0 is the default
    // Many distinct path prefixes assigned to a NON-default pool so all are candidates.
    const poolAssignments: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      poolAssignments[`/p${i}/page`] = "pool1";
    }
    // A dynamic catch-all route
    poolAssignments["/[slug]"] = "pool2";

    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest(poolAssignments),
    });

    const ruleCount = (yaml.match(/- matches:/g) ?? []).length;
    expect(ruleCount).toBeLessThanOrEqual(16);

    // Every pool's header rule must survive.
    for (let i = 0; i < 8; i++) {
      expect(yaml).toContain(`value: pool${i}`);
    }
    // The catch-all rule must survive.
    expect(yaml).toContain('value: "/"');
  });

  it("keeps all path-prefix rules when they fit under the total cap", () => {
    const pools = makePools(2);
    const poolAssignments: Record<string, string> = {
      "/dashboard/page": "pool1",
      "/settings/page": "pool1",
    };
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest(poolAssignments),
    });
    const ruleCount = (yaml.match(/- matches:/g) ?? []).length;
    // 2 path-prefix + 2 header + 1 catch-all
    expect(ruleCount).toBe(5);
    expect(yaml).toContain('value: "/dashboard"');
    expect(yaml).toContain('value: "/settings"');
  });

  it("does not burn rule slots on _next/_middleware/error-page/root-template prefixes", () => {
    const pools = makePools(2);
    const poolAssignments: Record<string, string> = {
      "/_next/static/chunk.js": "pool0",
      "/_next/data/build/about.json": "pool0",
      "/_middleware": "pool0",
      "/404": "pool0",
      "/500": "pool0",
      "/_not-found": "pool0",
      "/_error": "pool0",
      "/[slug]": "pool1",
      "/[...rest]": "pool1",
      "/dashboard/page": "pool1",
    };
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest(poolAssignments),
    });
    // Only the real app prefix gets a path rule (1 path + 2 header + 1 catch-all).
    const ruleCount = (yaml.match(/- matches:/g) ?? []).length;
    expect(ruleCount).toBe(4);
    expect(yaml).toContain('value: "/dashboard"');
    for (const junk of [
      "/_next",
      "/_middleware",
      "/404",
      "/500",
      "/_not-found",
      "/_error",
      "/[slug]",
      "/[...rest]",
    ]) {
      expect(yaml).not.toContain(`value: "${junk}"`);
    }
  });

  it("rejects a manifest pathname that would break the quoted YAML scalar", () => {
    const pools = makePools(1);
    expect(() =>
      renderHTTPRoute({
        releaseName: "nextjs",
        hosts,
        pools,
        routingManifest: makeManifest({ '/evil"path/page': "pool0" }),
      }),
    ).toThrow(/Unsafe pathname/);
  });
});

describe("renderHTTPRoute CDN filter injection", () => {
  it("attaches the ExtensionRef filter to every rule when cdnFilterName is set", () => {
    const pools = makePools(2);
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
      cdnFilterName: "nextjs-cdn",
    });

    const ruleCount = (yaml.match(/- matches:/g) ?? []).length;
    const filterCount = (yaml.match(/type: ExtensionRef/g) ?? []).length;
    expect(ruleCount).toBeGreaterThan(0);
    expect(filterCount).toBe(ruleCount);
    expect(yaml).toContain("kind: GCPHTTPFilter");
    expect(yaml).toContain("group: networking.gke.io");
    expect(yaml).toContain("name: nextjs-cdn");
  });

  it("attaches a ResponseHeaderModifier with CDN diagnostic variables per rule", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
      cdnFilterName: "nextjs-cdn",
    });
    const ruleCount = (yaml.match(/- matches:/g) ?? []).length;
    const modifierCount = (yaml.match(/type: ResponseHeaderModifier/g) ?? []).length;
    expect(modifierCount).toBe(ruleCount);
    expect(yaml).toContain("name: x-cache-status");
    expect(yaml).toContain('value: "{cdn_cache_status}"');
    expect(yaml).toContain("name: x-cache-id");
    expect(yaml).toContain('value: "{cdn_cache_id}"');
  });

  it("emits no filters block when cdnFilterName is unset", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
    });
    expect(yaml).not.toContain("filters:");
    expect(yaml).not.toContain("GCPHTTPFilter");
  });
});

describe("renderHTTPRoute HTTP->HTTPS redirect (M8)", () => {
  const tlsHosts: HostConfig[] = [{ hostname: "app.example.com", tls: { enabled: true } }];

  it("pins the app route to the https listener and adds a RequestRedirect route when TLS is on", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts: tlsHosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
    });

    // Two HTTPRoute documents: the app route and the redirect route.
    const routeDocs = yaml.match(/kind: HTTPRoute/g) ?? [];
    expect(routeDocs).toHaveLength(2);

    // The app route attaches ONLY to the https listener (no plaintext service).
    expect(yaml).toMatch(
      /name: nextjs-routes\nspec:\n  parentRefs:\n    - name: nextjs-gateway\n      sectionName: https/,
    );

    // The redirect route attaches to the http listener and 302-upgrades to https:443.
    expect(yaml).toContain("name: nextjs-http-redirect");
    expect(yaml).toMatch(
      /name: nextjs-http-redirect\nspec:\n  parentRefs:\n    - name: nextjs-gateway\n      sectionName: http/,
    );
    expect(yaml).toContain("type: RequestRedirect");
    expect(yaml).toMatch(/requestRedirect:\n\s+scheme: https\n\s+port: 443\n\s+statusCode: 302/);
    // Same hostnames on the redirect route.
    const redirectDoc = yaml.slice(yaml.indexOf("name: nextjs-http-redirect"));
    expect(redirectDoc).toContain('"app.example.com"');
  });

  it("emits no redirect route and no sectionName when TLS is off", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts, // tls disabled
      pools: makePools(2),
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
    });

    const routeDocs = yaml.match(/kind: HTTPRoute/g) ?? [];
    expect(routeDocs).toHaveLength(1);
    expect(yaml).not.toContain("RequestRedirect");
    expect(yaml).not.toContain("sectionName");
    expect(yaml).not.toContain("http-redirect");
  });
});

describe("releaseName validation in gateway templates", () => {
  it("renderGateway rejects an unsafe releaseName", () => {
    expect(() => renderGateway({ releaseName: 'foo";rm -rf /;"', hosts })).toThrow(
      /Invalid releaseName/,
    );
  });

  it("renderHTTPRoute rejects an unsafe releaseName", () => {
    expect(() =>
      renderHTTPRoute({
        releaseName: "foo$(whoami)",
        hosts,
        pools: makePools(1),
        routingManifest: makeManifest({}),
      }),
    ).toThrow(/Invalid releaseName/);
  });
});
