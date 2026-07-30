// The generic provider's contract, as a whole. The individual templates have their own tests;
// this pins the things that only show up when the provider is assembled — chiefly that NOTHING
// GKE-specific leaks into a chart destined for a cluster where those APIs do not exist.
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../../src/providers/index.js";
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
  middleware: null,
  poolAssignments: { "/": "default" },
  pprRoutes: {},
  nextVersion: "16.3.0",
} as unknown as RoutingManifest;

const pools = new Map<string, PoolDefinition>([
  ["default", { name: "default", outputs: [], config: { routes: ["appPages"] } }],
]);

const cfg = (generic: unknown): K8sAdapterConfig =>
  ({ pools: {}, provider: { generic } }) as unknown as K8sAdapterConfig;

const ctx = (config: K8sAdapterConfig) => ({
  releaseName: "my-app",
  pools,
  routingManifest,
  config,
});

const HOSTS = [{ hostname: "app.example.com", tls: { enabled: false } }];

describe("generic provider", () => {
  const provider = () => resolveProvider(cfg({ gateway: { hosts: HOSTS } }));

  it("resolves and declares the envoy-gateway ext_proc strategy", () => {
    expect(provider().name).toBe("generic");
    expect(provider().extProcStrategy).toBe("envoy-gateway");
  });

  it("emits a Gateway and an HTTPRoute", () => {
    const files = provider().emitIngressTemplates(ctx(cfg({ gateway: { hosts: HOSTS } })));
    expect(Object.keys(files)).toEqual(["templates/gateway.yaml", "templates/http-route.yaml"]);
  });

  it("emits NO Cloud CDN filter — that is a GKE concept", () => {
    // A generic cluster puts a CDN in FRONT of the gateway; GCPHTTPFilter does not exist and
    // would fail the install.
    const files = provider().emitIngressTemplates(ctx(cfg({ gateway: { hosts: HOSTS } })));
    expect(files["templates/cdn-http-filter.yaml"]).toBeUndefined();
    expect(JSON.stringify(files)).not.toContain("GCPHTTPFilter");
  });

  it("replaces the privileged registration Job with a single namespaced policy", () => {
    // This is the security win, not just a portability one: no gcloud, no Workload Identity,
    // no project-scoped IAM, no credential-bearing Job that any namespace pod-creator can
    // assume.
    const files = provider().emitExtProcTemplates({
      ...ctx(cfg({ gateway: { hosts: HOSTS } })),
      buildId: "b1",
      routeExtDocumentDigest: () => "digest",
    });
    expect(Object.keys(files)).toEqual(["templates/envoy-extension-policy.yaml"]);
    expect(files["templates/envoy-extension-policy.yaml"]).toContain("EnvoyExtensionPolicy");
    const all = JSON.stringify(files);
    expect(all).not.toContain("route-ext-update-job");
    expect(all).not.toContain("ServiceAccount");
    expect(all).not.toContain("gcloud");
  });

  it("emits no Google NEG annotation on the routing Service", () => {
    expect(provider().routingServiceAnnotations(ctx(cfg({ gateway: { hosts: HOSTS } })))).toEqual(
      {},
    );
  });

  it("declares that it does NOT use the GKE HealthCheckPolicy CRD", () => {
    // A chart containing an unknown API group is rejected whole, so one stray GKE document
    // fails the entire install rather than degrading.
    expect(provider().emitsHealthCheckPolicyCrd).toBe(false);
  });

  it("restricts the dataplane by POD SELECTOR, not Google CIDRs", () => {
    const sources = provider().strictIngressSources(ctx(cfg({ gateway: { hosts: HOSTS } })));
    expect(sources.cidrs).toEqual([]);
    expect(sources.podSelectors.length).toBeGreaterThan(0);
  });

  it("selects the Envoy DATA PLANE, not the controller", () => {
    // VERIFIED against a running Envoy Gateway v1.5.4 proxy: data-plane pods carry
    // `app.kubernetes.io/name: envoy`, while `envoy-gateway` is the CONTROLLER deployment.
    // Selecting the controller denies every real request while admitting the one workload
    // that never sends any — and it fails CLOSED, so it looks like a routing bug, not a
    // policy bug.
    const sel = provider().strictIngressSources(ctx(cfg({ gateway: { hosts: HOSTS } })))
      .podSelectors[0]!;
    expect(sel.labels["app.kubernetes.io/name"]).toBe("envoy");
    expect(sel.namespace).toBe("envoy-gateway-system");
  });

  it("scopes the selector to THIS release's Gateway", () => {
    // Reachability to :8443 IS the internal dispatch secret — the ext_proc reply carries it —
    // so a second release's proxies in the same cluster must not be admitted.
    const sel = provider().strictIngressSources(ctx(cfg({ gateway: { hosts: HOSTS } })))
      .podSelectors[0]!;
    expect(sel.labels["gateway.envoyproxy.io/owning-gateway-name"]).toBe("my-app-gateway");
  });

  it("honours a custom gateway namespace", () => {
    const c = cfg({ gateway: { hosts: HOSTS }, gatewayNamespace: "eg-prod" });
    expect(resolveProvider(c).strictIngressSources(ctx(c)).podSelectors[0]!.namespace).toBe(
      "eg-prod",
    );
  });

  it("contributes nothing when no gateway is configured", () => {
    const p = resolveProvider(cfg({}));
    expect(p.emitIngressTemplates(ctx(cfg({})))).toEqual({});
    expect(
      p.emitExtProcTemplates({ ...ctx(cfg({})), buildId: "b1", routeExtDocumentDigest: () => "d" }),
    ).toEqual({});
  });

  it("defaults the GatewayClass to Envoy Gateway's", () => {
    const files = provider().emitIngressTemplates(ctx(cfg({ gateway: { hosts: HOSTS } })));
    expect(files["templates/gateway.yaml"]).toContain("gatewayClassName: eg");
  });

  it("honours an explicit GatewayClass", () => {
    const c = cfg({ gateway: { hosts: HOSTS, className: "custom-eg" } });
    const files = resolveProvider(c).emitIngressTemplates(ctx(c));
    expect(files["templates/gateway.yaml"]).toContain("gatewayClassName: custom-eg");
  });
});

describe("generic provider — policy/route coupling", () => {
  // REGRESSION: the policy first targeted `${releaseName}-route` while renderHTTPRoute emits
  // `${releaseName}-routes`. Envoy Gateway accepts a policy whose targetRef names a
  // non-existent route, so the failure is SILENT: the Gateway programs, traffic flows, and the
  // ext_proc callout never fires — middleware simply does not run. Unit-testing each template
  // in isolation cannot catch that; the coupling must be asserted directly.
  it("targets the HTTPRoute name that is actually emitted", () => {
    const config = {
      pools: {},
      provider: { generic: { gateway: { hosts: HOSTS } } },
    } as unknown as K8sAdapterConfig;
    const provider = resolveProvider(config);
    const base = { releaseName: "my-app", pools, routingManifest, config };

    const route = provider.emitIngressTemplates(base)["templates/http-route.yaml"]!;
    const policy = provider.emitExtProcTemplates({
      ...base,
      buildId: "b1",
      routeExtDocumentDigest: () => "d",
    })["templates/envoy-extension-policy.yaml"]!;

    // The name the HTTPRoute document actually declares.
    const emitted = /kind: HTTPRoute\nmetadata:\n  name: (\S+)/.exec(route)?.[1];
    expect(emitted).toBeTruthy();

    // The name the policy points at.
    const targeted = /kind: HTTPRoute\n      name: (\S+)/.exec(policy)?.[1];
    expect(targeted).toBe(emitted);
  });
});
