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
      // N61: the header match value is QUOTED (an unquoted "on"/"no"/"123" pool name
      // would render a YAML boolean/int the apiserver refuses as an HTTPHeaderMatch value).
      expect(yaml).toContain(`value: "pool${i}"`);
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
  it("leaves provider timeout behavior untouched unless explicitly disabled", () => {
    const common = {
      releaseName: "nextjs",
      hosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/dashboard/page": "pool1" }),
    };
    expect(renderHTTPRoute(common)).not.toContain("request: 0s");

    const portable = renderHTTPRoute({ ...common, disableRequestTimeout: true });
    const ruleCount = (portable.match(/- matches:/g) ?? []).length;
    expect((portable.match(/request: 0s/g) ?? []).length).toBe(ruleCount);
  });

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

    // The redirect route attaches to the http listener and 302-upgrades to https.
    expect(yaml).toContain("name: nextjs-http-redirect");
    expect(yaml).toMatch(
      /name: nextjs-http-redirect\nspec:\n  parentRefs:\n    - name: nextjs-gateway\n      sectionName: http/,
    );
    expect(yaml).toContain("type: RequestRedirect");
    expect(yaml).toMatch(/requestRedirect:\n\s+scheme: https\n\s+statusCode: 302/);
    // `port` must stay omitted: the GKE Gateway controller rejects it (GWCER104) and one
    // invalid route blocks reconciliation of the whole Gateway (no-error-isolation), which
    // stalls NEG programming for every subsequent backend change. https implies 443.
    expect(yaml).not.toContain("port: 443");
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

// ---------------------------------------------------------------------------
// N74 — catchAllPool must be a function of manifest CONTENT, not key order.
// ---------------------------------------------------------------------------
describe("N74: deterministic catch-all pool selection", () => {
  it("prefers the pool owning the ROOT DYNAMIC template over the /_not-found pool", () => {
    const pools = makePools(3); // pool0 (default), pool1, pool2
    // The two candidates in BOTH insertion orders. Previously the first key to match won,
    // so every unmatched request landed on whichever of the two classification inserted
    // first — and they routinely live in different pools.
    const notFoundFirst = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/_not-found": "pool1", "/[slug]": "pool2" }),
    });
    const dynamicFirst = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/[slug]": "pool2", "/_not-found": "pool1" }),
    });
    // Same emitted route either way — and it is the root-dynamic owner, which is what
    // actually serves arbitrary unmatched paths (/_not-found only serves the 404).
    expect(notFoundFirst).toBe(dynamicFirst);
    const catchAll = notFoundFirst.slice(notFoundFirst.lastIndexOf('value: "/"'));
    expect(catchAll).toContain("name: nextjs-pool2");
  });

  it("falls back to the /_not-found pool when there is no root dynamic template", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(3),
      routingManifest: makeManifest({ "/about": "pool1", "/_not-found": "pool1" }),
    });
    const catchAll = yaml.slice(yaml.lastIndexOf('value: "/"'));
    expect(catchAll).toContain("name: nextjs-pool1");
  });

  it("picks deterministically among MULTIPLE root dynamic templates (sorted, not insertion order)", () => {
    const a = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(3),
      routingManifest: makeManifest({ "/[slug]": "pool1", "/[...rest]": "pool2" }),
    });
    const b = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(3),
      routingManifest: makeManifest({ "/[...rest]": "pool2", "/[slug]": "pool1" }),
    });
    expect(a).toBe(b);
    // "/[...rest]" sorts before "/[slug]", so pool2 wins in both orders.
    expect(a.slice(a.lastIndexOf('value: "/"'))).toContain("name: nextjs-pool2");
  });

  it("falls back to the first pool when the manifest names no catch-all candidate", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/about": "pool1" }),
    });
    expect(yaml.slice(yaml.lastIndexOf('value: "/"'))).toContain("name: nextjs-pool0");
  });
});

// ---------------------------------------------------------------------------
// N76 — the 16-rule budget must not depend on manifest key order.
// ---------------------------------------------------------------------------
describe("N76: sortedPrefixes is a total order", () => {
  it("emits the same rules for the same prefixes in a different key order", () => {
    // 20 equal-length prefixes, so length alone leaves them in insertion order: which ones
    // survived the budget used to depend on manifest ORDERING rather than content.
    const names = Array.from({ length: 20 }, (_, i) => `/p${String(i).padStart(2, "0")}`);
    const forward: Record<string, string> = {};
    const reverse: Record<string, string> = {};
    for (const n of names) forward[`${n}/page`] = "pool1";
    for (const n of [...names].reverse()) reverse[`${n}/page`] = "pool1";

    const a = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(3),
      routingManifest: makeManifest(forward),
    });
    const b = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(3),
      routingManifest: makeManifest(reverse),
    });
    expect(a).toBe(b);
    // Lexicographic tie-break: the lowest-numbered prefixes survive.
    expect(a).toContain('value: "/p00"');
    expect(a).not.toContain('value: "/p19"');
  });

  it("still puts longer prefixes first (Gateway API precedence)", () => {
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools: makePools(2),
      routingManifest: makeManifest({ "/a/x": "pool1", "/longer/y": "pool1" }),
    });
    expect(yaml.indexOf('value: "/longer"')).toBeLessThan(yaml.indexOf('value: "/a"'));
  });
});

describe("hostname validation at the consumption point", () => {
  it("renderGateway and renderHTTPRoute both reject an unsafe hostname", () => {
    const bad: HostConfig[] = [{ hostname: 'x"\n  foo: bar', tls: { enabled: false } }];
    expect(() => renderGateway({ releaseName: "nextjs", hosts: bad })).toThrow(/Invalid hostname/);
    expect(() =>
      renderHTTPRoute({
        releaseName: "nextjs",
        hosts: bad,
        pools: makePools(1),
        routingManifest: makeManifest({}),
      }),
    ).toThrow(/Invalid hostname/);
  });

  it("renderHTTPRoute rejects an unsafe pool name (it is a header match value)", () => {
    const pools = new Map<string, PoolDefinition>([
      ["-bad", { name: "-bad", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    expect(() =>
      renderHTTPRoute({ releaseName: "nextjs", hosts, pools, routingManifest: makeManifest({}) }),
    ).toThrow(/Invalid pool name/);
  });
});

describe("renderHTTPRoute path-prefix encoding", () => {
  // Full-run v4 (interception-dynamic-single-segment 9/9, non-ascii-cache-tags 6/6,
  // prerender-encoding 1/1 — 16 tests): Gateway API restricts Exact/PathPrefix values to
  // ^(?:[-A-Za-z0-9/._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+$, and helm's server-side apply
  // rejected the whole HTTPRoute for any app with a non-ASCII or space-containing first
  // segment — the deploy failed wholesale. On the wire clients percent-encode exactly those
  // bytes, so emitting the ENCODED form is also the form that actually matches requests.
  const GATEWAY_PATH_RE = /^(?:[-A-Za-z0-9/._~!$&'()*+,;=:@]|%[0-9a-fA-F]{2})+$/;

  const pathValues = (yaml: string): string[] =>
    [...yaml.matchAll(/path: \{ type: \w+, value: "([^"]*)" \}/g)].map((m) => m[1]!);

  it("percent-encodes a non-ASCII prefix so the apiserver accepts it and the wire form matches", () => {
    const pools = makePools(1);
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/产品/page": "pool0" }),
    });
    for (const v of pathValues(yaml)) expect(v).toMatch(GATEWAY_PATH_RE);
    expect(yaml).toContain(`value: "/%E4%BA%A7%E5%93%81"`);
  });

  it("percent-encodes a space-containing prefix", () => {
    const pools = makePools(1);
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/hello world/page": "pool0" }),
    });
    for (const v of pathValues(yaml)) expect(v).toMatch(GATEWAY_PATH_RE);
    expect(yaml).toContain(`value: "/hello%20world"`);
  });

  it("leaves already-legal prefixes exactly as-is (no double encoding, no drift)", () => {
    const pools = makePools(1);
    const yaml = renderHTTPRoute({
      releaseName: "nextjs",
      hosts,
      pools,
      routingManifest: makeManifest({ "/products(v2)/page": "pool0", "/a.b~c/page": "pool0" }),
    });
    expect(yaml).toContain(`value: "/products(v2)"`);
    expect(yaml).toContain(`value: "/a.b~c"`);
  });
});
