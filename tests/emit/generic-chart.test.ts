// Assembles a COMPLETE generic chart and asserts what must and must not be in it.
//
// Every provider-level test before this one exercised a single method in isolation, and that is
// exactly how three silent-failure bugs got through: an invalid `hostnames` field on Gateway, an
// EnvoyExtensionPolicy targeting a route name that is never emitted, and a chart that still
// carried GKE-only CRDs. None of those are visible from one template; all of them are obvious
// the moment the whole chart is rendered together.
import { describe, it, expect } from "vitest";
import { generateHelmChart } from "../../src/emit/helm.js";
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../../src/types.js";

const routingManifest = {
  routeGraph: {
    beforeMiddleware: [],
    beforeFiles: [],
    afterFiles: [],
    dynamicRoutes: [],
    onMatch: [],
    fallback: [],
    shouldNormalizeNextData: false,
    rsc: {},
  },
  pathnames: ["/"],
  i18n: null,
  buildId: "b1",
  basePath: "",
  middleware: { filePath: "middleware.js" },
  poolAssignments: { "/": "default" },
  pprRoutes: {},
  nextVersion: "16.3.0",
} as unknown as RoutingManifest;

const pools = new Map<string, PoolDefinition>([
  ["default", { name: "default", outputs: [], config: { routes: ["appPages"] } }],
]);

function genericChart(over: Record<string, unknown> = {}): Record<string, string> {
  const config = {
    pools: {},
    provider: {
      generic: {
        gateway: { hosts: [{ hostname: "app.example.com", tls: { enabled: false } }] },
      },
    },
    ...over,
  } as unknown as K8sAdapterConfig;

  return generateHelmChart({
    pools,
    buildId: "b1",
    nextVersion: "16.3.0",
    config,
    imageRegistry: "registry.example.com/ns",
    routingManifest,
    releaseName: "my-app",
    internalSecret: "s".repeat(64),
    // A generic cluster has NO GCP infrastructure. That is the normal case, not an error.
  });
}

// Merged-gateway lane support (Phase 2, 2026-07-30): with EnvoyProxy `mergeGateways`, every
// Gateway's listeners land in ONE data plane, and Gateway API requires the
// (port, protocol, hostname) tuple to be unique across them. A hostname-LESS listener (this
// template's default) therefore conflicts with every other release's — measured on k3d: the
// oldest Gateway kept the slot, every lane's HTTPRoute reported "no ready listeners", and
// Envoy 404'd all lane traffic while the stability gate (which tolerates 404) waved it
// through. A single-host release stamps its hostname on the listener — distinct across
// lanes, and the listener KEEPS the name `http`, so `sectionName: http` route attachment
// (which per-host listener NAMES broke, see below) is untouched.
import { renderGenericGateway } from "../../src/emit/templates/generic-gateway.js";

// Escaped-slash parity (Phase-2 pilot, 2026-07-30). Envoy Gateway's default is Envoy's
// UnescapeAndRedirect: a request for /a%2Fb is 307-redirected to /a/b BEFORE the app sees it
// — measured on k3d (`location: /probe/path`), and it is why upstream's
// next-after-app-deploy (8/8) and segment-cache/encoded-slash-params failed: both encode a
// slash INSIDE a route param, which `next start` preserves. The chart must pin
// escapedSlashesAction: KeepUnchanged so the generic edge matches next start.
describe("generic client traffic policy: escaped-slash parity", () => {
  it("emits a ClientTrafficPolicy pinning KeepUnchanged, targeting the release gateway", () => {
    const files = genericChart();
    const ctp = files["templates/client-traffic-policy.yaml"];
    expect(ctp).toBeTruthy();
    expect(ctp).toContain("kind: ClientTrafficPolicy");
    expect(ctp).toContain("escapedSlashesAction: KeepUnchanged");
    expect(ctp).toContain("name: my-app-gateway");
  });
});

describe("generic gateway listeners under merged gateways", () => {
  it("stamps the hostname on the listener for a single-host release", () => {
    const yaml = renderGenericGateway({
      releaseName: "e2e-lane1",
      className: "eg",
      hosts: [{ hostname: "lane1.localhost", tls: { enabled: false } }],
    } as never);
    expect(yaml).toMatch(/- name: http\n\s+hostname: "lane1\.localhost"/);
  });

  it("keeps the hostname-less listener for multi-host releases (sectionName contract)", () => {
    const yaml = renderGenericGateway({
      releaseName: "multi",
      className: "eg",
      hosts: [
        { hostname: "a.example.com", tls: { enabled: false } },
        { hostname: "b.example.com", tls: { enabled: false } },
      ],
    } as never);
    expect(yaml).not.toContain("hostname:");
  });
});

describe("generic provider — complete chart", () => {
  it("emits the ext_proc routing tier even with no GCP infrastructure", () => {
    // The routing tier IS the adapter's middleware story. Emitting a chart without it means
    // every request silently falls back to pool-local middleware — the app still serves, so
    // nothing looks broken, but the edge tier this adapter exists for is simply absent.
    const files = genericChart();
    expect(Object.keys(files)).toContain("templates/routing-service-deployment.yaml");
    expect(Object.keys(files)).toContain("templates/routing-service-service.yaml");
    expect(Object.keys(files)).toContain("templates/envoy-extension-policy.yaml");
  });

  it("contains NO GKE-only API groups anywhere in the chart", () => {
    // k3s/EKS/AKS reject the whole chart if any document references a CRD they do not have,
    // so one stray GKE resource fails the entire install rather than degrading.
    const all = Object.values(genericChart()).join("\n---\n");
    expect(all).not.toContain("networking.gke.io");
    expect(all).not.toContain("cloud.google.com/neg");
    expect(all).not.toContain("HealthCheckPolicy");
    expect(all).not.toContain("GCPHTTPFilter");
  });

  it("emits no gcloud registration Job or its ServiceAccount", () => {
    const files = genericChart();
    expect(files["templates/route-ext-update-job.yaml"]).toBeUndefined();
    expect(files["templates/deploy-service-account.yaml"]).toBeUndefined();
    expect(files["templates/route-ext-config.yaml"]).toBeUndefined();
  });

  it("the EnvoyExtensionPolicy targets an HTTPRoute the chart actually emits", () => {
    const files = genericChart();
    const routeDoc = files["templates/http-route.yaml"]!;
    const policy = files["templates/envoy-extension-policy.yaml"]!;
    const emitted = [...routeDoc.matchAll(/kind: HTTPRoute\nmetadata:\n  name: (\S+)/g)].map(
      (m) => m[1],
    );
    const targeted = /kind: HTTPRoute\n      name: (\S+)/.exec(policy)?.[1];
    expect(emitted).toContain(targeted);
  });

  it("the HTTPRoute's parent listeners exist on the emitted Gateway", () => {
    // A sectionName that names no listener means the route never attaches: the Gateway
    // programs, the policy attaches to the route, and nothing serves.
    const files = genericChart({
      provider: {
        generic: {
          gateway: {
            hosts: [
              { hostname: "a.example.com", tls: { enabled: true } },
              { hostname: "b.example.com", tls: { enabled: true } },
            ],
            tlsSecretName: "app-tls",
          },
        },
      },
    });
    const gw = files["templates/gateway.yaml"]!;
    const listeners = [...gw.matchAll(/^\s+- name: (\S+)/gm)].map((m) => m[1]);
    const route = files["templates/http-route.yaml"]!;
    for (const [, section] of route.matchAll(/sectionName: (\S+)/g)) {
      expect(listeners).toContain(section);
    }
  });

  it("REFUSES tls.enabled without a cert Secret rather than serving plaintext", () => {
    // This previously asserted a silent downgrade to HTTP. That is the worst available outcome:
    // the deploy succeeds, every resource reports healthy, and the app serves credentials in the
    // clear for a config that explicitly asked for TLS. Refuse instead — at the RENDERER, since a
    // direct generateHelmChart caller never passes through validateConfig.
    expect(() =>
      genericChart({
        provider: {
          generic: {
            gateway: { hosts: [{ hostname: "a.example.com", tls: { enabled: true } }] },
          },
        },
      }),
    ).toThrow(/tlsSecretName/);
  });
});

describe("generic provider — NetworkPolicy", () => {
  it("admits the release's own Envoy proxies, not Google CIDRs", () => {
    // The h2c hop is only safe because of this policy: the ext_proc reply carries
    // INTERNAL_HEADER_SECRET, so anything that can reach :8443 can obtain the credential that
    // makes a pool trust dispatch headers.
    const np = genericChart()["templates/network-policy.yaml"]!;
    expect(np).not.toContain("35.191.0.0/16");
    expect(np).not.toContain("130.211.0.0/22");
    expect(np).toContain("gateway.envoyproxy.io/owning-gateway-name");
    expect(np).toContain("my-app-gateway");
    expect(np).toContain('kubernetes.io/metadata.name: "envoy-gateway-system"');
  });

  it("selects the Envoy data plane, not the controller", () => {
    const np = genericChart()["templates/network-policy.yaml"]!;
    expect(np).toContain('app.kubernetes.io/name: "envoy"');
    expect(np).not.toContain('app.kubernetes.io/name: "envoy-gateway"');
  });
});

describe("generic provider — callout policy matches the server's", () => {
  it("propagates fail-open so the filter and the server agree", () => {
    // The routing Deployment already got ROUTING_FAIL_OPEN; the Envoy filter hardcoded
    // fail-closed. An app configured `failureMode: "open"` would then have the server willing
    // to proceed while Envoy blocked the request — two verdicts for one request.
    const files = generateHelmChart({
      pools,
      buildId: "b1",
      nextVersion: "16.3.0",
      config: {
        pools: {},
        routingService: { requestTimeoutMs: 2500 },
        provider: {
          generic: { gateway: { hosts: [{ hostname: "a.example.com", tls: { enabled: false } }] } },
        },
      } as unknown as K8sAdapterConfig,
      imageRegistry: "registry.example.com/ns",
      routingManifest,
      releaseName: "my-app",
      internalSecret: "s".repeat(64),
      routingFailOpen: true,
    });
    const policy = files["templates/envoy-extension-policy.yaml"]!;
    expect(policy).toContain("failOpen: true");
    expect(policy).toContain("messageTimeout: 3s"); // 2500ms rounds to whole seconds
  });

  it("declares h2c transport on the routing Deployment", () => {
    // The image bakes TLS_CERT_FILE/TLS_KEY_FILE, so without an explicit transport the service
    // self-signs and serves h2 TLS while Envoy Gateway dials h2c — health stays green on :8081
    // while every callout fails.
    expect(genericChart()["templates/routing-service-deployment.yaml"]).toContain(
      "name: ROUTING_TRANSPORT",
    );
    expect(genericChart()["templates/routing-service-deployment.yaml"]).toContain('value: "h2c"');
  });
});
