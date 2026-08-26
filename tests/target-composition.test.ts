import { describe, expect, it } from "vitest";
import {
  compileTarget,
  defineClusterComponent,
  defineExposureComponent,
  defineResourceComponent,
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeNativeRouting,
  httpRouteExposure,
  ingressExposure,
  kubernetesCluster,
  manualExposure,
  targetForConfig,
} from "../src/target/index.js";
import type { K8sAdapterConfig } from "../src/types.js";
import type { TargetBuildContext } from "../src/target/types.js";
import type { TelemetrySource } from "../src/composition-plan/index.js";

const hosts = [{ hostname: "app.example.com", tls: { enabled: false } }];

function context(overrides: Partial<TargetBuildContext> = {}): TargetBuildContext {
  return {
    releaseName: "test-app",
    namespace: "apps",
    buildId: "build-123",
    imageRegistry: "ghcr.io/davidilie/test-app",
    pools: ["default", "api"],
    defaultPool: "default",
    failurePolicy: "closed",
    ...overrides,
  };
}

function nginxTelemetrySource(
  id = "provider.nginx-ingress",
  metricName = "nginx_ingress_controller_requests",
): TelemetrySource {
  return {
    id,
    producer: { kind: "ingress-controller", name: "nginx-ingress" },
    owner: "operator",
    activation: {
      kind: "otel-operator",
      instrumentation: {
        apiVersion: "opentelemetry.io/v1alpha1",
        resource: "instrumentations",
        name: "nginx-ingress",
        namespace: "apps",
      },
    },
    protocols: ["prometheus"],
    propagation: ["tracecontext"],
    signals: [{ kind: "metric", name: metricName, instrument: "counter", unit: "{request}" }],
    workloads: [
      {
        kind: "kubernetes-object",
        object: {
          apiVersion: "apps/v1",
          resource: "deployments",
          name: "ingress-nginx-controller",
          namespace: "apps",
        },
      },
    ],
    attributes: { "adapter_k8s.provider.name": "nginx-ingress" },
  };
}

describe("Kubernetes target composition", () => {
  it("defaults to portable pool-local routing and a stable origin backend", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: manualExposure({ hosts }),
    });
    const compiled = compileTarget(target, context());
    expect(compiled.plan.operations.routing).toEqual({
      protocol: "pool-local-v1",
      failurePolicy: "closed",
      dataplane: {
        kind: "portable-http-origin",
        service: { name: "test-app-origin", namespace: "apps", port: 3000 },
        targetPool: "default",
        readiness: [
          {
            kind: "kubernetes-service-endpoints",
            service: { name: "test-app-origin", namespace: "apps", port: 3000 },
            minimumReady: 1,
          },
        ],
      },
    });
    expect(compiled.routingTier.enabled).toBe(false);
    expect(compiled.defaultPool).toBe("default");
    expect(compiled.plan.operations.resources.objects).toEqual([]);
    expect(compiled.plan.operations.cleanup.external).toEqual([]);
    expect(compiled.plan.operations.cleanup.retained).toEqual([]);
    expect(compiled.plan.operations.diagnostics).toEqual([]);
    expect(compiled.plan.operations.telemetry).toEqual([
      expect.objectContaining({
        id: "adapter.pool",
        workloads: [
          { kind: "adapter-pool", pool: "default" },
          { kind: "adapter-pool", pool: "api" },
        ],
        attributes: expect.objectContaining({ "adapter_k8s.provider.name": "portable" }),
      }),
    ]);
    expect(JSON.stringify(compiled.plan)).not.toContain("envoy");
    expect(JSON.stringify(compiled.plan)).not.toContain("gcp-");
  });

  it("records an explicit portable origin pool independently of declaration order", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
      }),
      context({ defaultPool: "api" }),
    );
    expect(compiled.defaultPool).toBe("api");
    expect(compiled.plan.operations.routing).toMatchObject({
      dataplane: { kind: "portable-http-origin", targetPool: "api" },
    });
    expect(compiled.plan.target.fingerprint).not.toBe(
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
        }),
        context({ defaultPool: "default" }),
      ).plan.target.fingerprint,
    );
  });

  it("changes target identity when exposure or routing composition changes", () => {
    const manual = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
      }),
      context(),
    );
    const gateway = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({ className: "eg", hosts }),
        routing: envoyNativeRouting({ escapedSlashes: "external" }),
      }),
      context(),
    );
    expect(gateway.plan.target.fingerprint).not.toBe(manual.plan.target.fingerprint);
    expect(
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
        }),
        context({ buildId: "another-build" }),
      ).plan.target.fingerprint,
    ).toBe(manual.plan.target.fingerprint);
  });

  it("emits typed Gateway API objects targeting the origin Service", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({ className: "example", hosts }),
      }),
      context(),
    );
    const route = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "HTTPRoute",
    );
    expect(route?.apiVersion).toBe("gateway.networking.k8s.io/v1");
    expect(route?.resource).toBe("httproutes");
    expect(JSON.stringify(route?.body)).toContain('"name":"test-app-origin"');
    expect(compiled.plan.requirements.kubernetes.resources).toContainEqual({
      apiVersion: "gateway.networking.k8s.io/v1",
      resource: "gateways",
      optional: false,
    });
  });

  it("emits a networking.k8s.io/v1 Ingress targeting the origin Service", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: ingressExposure({ className: "nginx", hosts }),
      }),
      context(),
    );
    const ingress = compiled.plan.operations.resources.objects[0];
    expect(ingress).toMatchObject({
      apiVersion: "networking.k8s.io/v1",
      kind: "Ingress",
      resource: "ingresses",
    });
    expect(JSON.stringify(ingress?.body)).toContain('"name":"test-app-origin"');
  });

  it("emits a cert-manager Certificate for a TLS gatewayApiExposure with certManager", () => {
    const tlsHosts = [
      { hostname: "app.example.com", tls: { enabled: true } },
      { hostname: "www.example.com", tls: { enabled: true } },
    ];
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({
          className: "eg",
          hosts: tlsHosts,
          certManager: { issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" } },
        }),
      }),
      context(),
    );
    const certificate = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "Certificate",
    );
    expect(certificate).toMatchObject({
      apiVersion: "cert-manager.io/v1",
      resource: "certificates",
      metadata: { name: "test-app-tls", namespace: "apps" },
    });
    expect(certificate?.body).toEqual({
      spec: {
        secretName: "test-app-tls",
        dnsNames: ["app.example.com", "www.example.com"],
        issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
      },
    });
    // The derived Secret name is what the HTTPS listener terminates from.
    const gateway = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "Gateway",
    );
    expect(JSON.stringify(gateway?.body)).toContain(
      '"certificateRefs":[{"kind":"Secret","name":"test-app-tls"}]',
    );
    // The cert-manager CRD joins preflight requirements; Certificate Ready joins readiness.
    expect(compiled.plan.requirements.kubernetes.resources).toContainEqual({
      apiVersion: "cert-manager.io/v1",
      resource: "certificates",
      optional: false,
    });
    expect(compiled.plan.operations.resources.readiness).toContainEqual({
      kind: "kubernetes-condition",
      object: {
        apiVersion: "cert-manager.io/v1",
        resource: "certificates",
        name: "test-app-tls",
        namespace: "apps",
      },
      conditionsAt: { kind: "object" },
      condition: {
        type: "Ready",
        status: "True",
        observedGeneration: "must-equal-metadata-generation",
      },
      timeoutSeconds: 600,
    });
  });

  it("uses tlsSecretName as the Certificate's secretName when both are set", () => {
    const tlsHosts = [{ hostname: "app.example.com", tls: { enabled: true } }];
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({
          className: "eg",
          hosts: tlsHosts,
          tlsSecretName: "app-wildcard-tls",
          certManager: {
            issuerRef: { name: "vault-issuer", kind: "Issuer", group: "cert-manager.io" },
          },
        }),
      }),
      context(),
    );
    const certificate = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "Certificate",
    );
    expect(certificate?.metadata.name).toBe("app-wildcard-tls");
    expect(certificate?.body).toEqual({
      spec: {
        secretName: "app-wildcard-tls",
        dnsNames: ["app.example.com"],
        issuerRef: { name: "vault-issuer", kind: "Issuer", group: "cert-manager.io" },
      },
    });
  });

  it("emits a cert-manager Certificate for a TLS ingressExposure with certManager", () => {
    const tlsHosts = [{ hostname: "app.example.com", tls: { enabled: true } }];
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: ingressExposure({
          className: "nginx",
          hosts: tlsHosts,
          certManager: { issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" } },
        }),
      }),
      context(),
    );
    const certificate = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "Certificate",
    );
    expect(certificate?.metadata.name).toBe("test-app-tls");
    expect(certificate?.body).toEqual({
      spec: {
        secretName: "test-app-tls",
        dnsNames: ["app.example.com"],
        issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
      },
    });
    // The Ingress spec.tls references the derived Secret even without tlsSecretName.
    const ingress = compiled.plan.operations.resources.objects.find(
      (object) => object.kind === "Ingress",
    );
    expect(JSON.stringify(ingress?.body)).toContain('"secretName":"test-app-tls"');
    expect(compiled.plan.requirements.kubernetes.resources).toContainEqual({
      apiVersion: "cert-manager.io/v1",
      resource: "certificates",
      optional: false,
    });
    expect(compiled.plan.operations.resources.readiness).toContainEqual(
      expect.objectContaining({
        kind: "kubernetes-condition",
        object: expect.objectContaining({ resource: "certificates", name: "test-app-tls" }),
        condition: expect.objectContaining({ type: "Ready" }),
      }),
    );
  });

  it("emits no Certificate, requirement, or readiness without certManager", () => {
    const tlsHosts = [{ hostname: "app.example.com", tls: { enabled: true } }];
    for (const exposure of [
      gatewayApiExposure({ className: "eg", hosts: tlsHosts, tlsSecretName: "app-tls" }),
      ingressExposure({ className: "nginx", hosts: tlsHosts, tlsSecretName: "app-tls" }),
    ]) {
      const compiled = compileTarget(
        defineTarget({ cluster: kubernetesCluster(), exposure }),
        context(),
      );
      expect(JSON.stringify(compiled.plan)).not.toContain("cert-manager.io");
    }
  });

  it("validates certManager options eagerly", () => {
    const tlsHosts = [{ hostname: "app.example.com", tls: { enabled: true } }];
    const clusterIssuer = {
      issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" as const },
    };
    // issuerRef.name must be K8s-safe (asserted verbatim, never sanitized).
    expect(() =>
      gatewayApiExposure({
        className: "eg",
        hosts: tlsHosts,
        certManager: { issuerRef: { name: "Bad Issuer", kind: "ClusterIssuer" } },
      }),
    ).toThrow(/invalid certManager issuerRef name/i);
    expect(() =>
      ingressExposure({
        className: "nginx",
        hosts: tlsHosts,
        certManager: { issuerRef: { name: "-bad", kind: "Issuer" } },
      }),
    ).toThrow(/invalid certManager issuerRef name/i);
    expect(() =>
      gatewayApiExposure({
        className: "eg",
        hosts: tlsHosts,
        certManager: { issuerRef: { name: "ok", kind: "SomethingElse" as never } },
      }),
    ).toThrow(/invalid certManager issuerRef kind/i);
    expect(() =>
      gatewayApiExposure({
        className: "eg",
        hosts: tlsHosts,
        certManager: {
          issuerRef: { name: "ok", kind: "ClusterIssuer", group: "Bad Group" },
        },
      }),
    ).toThrow(/invalid certManager issuerRef group/i);
    // certManager with tls.enabled: false is an error: nothing would reference the cert.
    expect(() =>
      gatewayApiExposure({ className: "eg", hosts, certManager: clusterIssuer }),
    ).toThrow(/requires at least one host with tls.enabled/i);
    expect(() =>
      ingressExposure({ className: "nginx", hosts, certManager: clusterIssuer }),
    ).toThrow(/requires at least one host with tls.enabled/i);
    // Two certificate managers for one listener is a config conflict.
    expect(() =>
      gatewayApiExposure({
        className: "eg",
        hosts: tlsHosts,
        controllerManagedTls: true,
        certManager: clusterIssuer,
      }),
    ).toThrow(/cannot combine certManager with controllerManagedTls/i);
    // certManager satisfies the TLS-source rule on its own (no tlsSecretName needed).
    expect(() =>
      gatewayApiExposure({ className: "eg", hosts: tlsHosts, certManager: clusterIssuer }),
    ).not.toThrow();
    expect(() =>
      ingressExposure({ className: "nginx", hosts: tlsHosts, certManager: clusterIssuer }),
    ).not.toThrow();
  });

  it("requires Envoy-native routing to attach to a Gateway API HTTPRoute", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: ingressExposure({ className: "nginx", hosts }),
      routing: envoyNativeRouting(),
    });
    expect(() => compileTarget(target, context())).toThrow(/requires Gateway API class "eg"/i);
  });

  it("requires the configured GatewayClass for native routing", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: gatewayApiExposure({ className: "traefik", hosts }),
      routing: envoyNativeRouting({ gatewayClassName: "eg" }),
    });
    expect(() => compileTarget(target, context())).toThrow(/requires Gateway API class "eg"/i);
  });

  it("emits Envoy APIs only when Envoy-native routing is explicit", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({ className: "eg", hosts }),
        routing: envoyNativeRouting(),
      }),
      context(),
    );
    expect(compiled.plan.operations.routing.protocol).toBe("envoy-ext-proc-v3");
    expect(compiled.plan.operations.resources.objects).toContainEqual(
      expect.objectContaining({
        apiVersion: "gateway.envoyproxy.io/v1alpha1",
        kind: "EnvoyExtensionPolicy",
      }),
    );
    expect(compiled.plan.operations.telemetry).toContainEqual(
      expect.objectContaining({
        id: "adapter.routing.envoy-native",
        producer: { kind: "adapter-runtime", name: "routing-service" },
        attributes: expect.objectContaining({ "adapter_k8s.provider.name": "envoy-native" }),
      }),
    );
    expect(compiled.plan.operations.resources.objects).toContainEqual(
      expect.objectContaining({
        apiVersion: "gateway.envoyproxy.io/v1alpha1",
        kind: "ClientTrafficPolicy",
      }),
    );
  });

  it("binds native routing to exposure-provided object identities", () => {
    const exposure = defineExposureComponent({
      name: "shared-gateway-route",
      hosts,
      build(ctx) {
        return {
          ingressSources: { cidrs: [], podSelectors: [] },
          capabilities: [
            {
              kind: "gateway-api",
              className: "eg",
              gateway: {
                apiVersion: "gateway.networking.k8s.io/v1",
                resource: "gateways",
                name: "shared-edge",
                namespace: ctx.namespace,
              },
              applicationRoutes: [
                {
                  apiVersion: "gateway.networking.k8s.io/v1",
                  resource: "httproutes",
                  name: "custom-app-route",
                  namespace: ctx.namespace,
                },
              ],
            },
          ],
        };
      },
    });
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure,
        routing: envoyNativeRouting({ escapedSlashes: "external" }),
      }),
      context(),
    );
    const policy = compiled.plan.operations.resources.objects.find(
      (entry) => entry.kind === "EnvoyExtensionPolicy",
    );
    expect(policy?.body).toMatchObject({
      spec: { targetRefs: [{ name: "custom-app-route" }] },
    });
    expect(
      compiled.plan.operations.resources.objects.some(
        (entry) => entry.kind === "ClientTrafficPolicy",
      ),
    ).toBe(false);
  });

  it("allows a cross-namespace Gateway and suppresses the ClientTrafficPolicy", () => {
    const exposure = defineExposureComponent({
      name: "shared-gateway",
      hosts,
      build() {
        return {
          ingressSources: { cidrs: [], podSelectors: [] },
          capabilities: [
            {
              kind: "gateway-api",
              className: "eg",
              gateway: {
                apiVersion: "gateway.networking.k8s.io/v1",
                resource: "gateways",
                name: "shared-edge",
                namespace: "edge-system",
              },
              applicationRoutes: [
                {
                  apiVersion: "gateway.networking.k8s.io/v1",
                  resource: "httproutes",
                  name: "custom-app-route",
                  namespace: "apps",
                },
              ],
            },
          ],
        };
      },
    });
    // Default escapedSlashes (would be "policy" locally) is suppressed cross-namespace:
    // a ClientTrafficPolicy targets the Gateway namespace-locally and cannot reach it.
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure,
        routing: envoyNativeRouting(),
      }),
      context(),
    );
    expect(
      compiled.plan.operations.resources.objects.some(
        (entry) => entry.kind === "ClientTrafficPolicy",
      ),
    ).toBe(false);
    expect(
      compiled.plan.operations.resources.objects.find(
        (entry) => entry.kind === "EnvoyExtensionPolicy",
      )?.body,
    ).toMatchObject({ spec: { targetRefs: [{ name: "custom-app-route" }] } });

    // An EXPLICIT "policy" against a cross-namespace Gateway is a build error naming it.
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure,
          routing: envoyNativeRouting({ escapedSlashes: "policy" }),
        }),
        context(),
      ),
    ).toThrow(/"edge-system\/shared-edge".*namespace-local/i);
  });

  it("rejects an Envoy policy targeting an HTTPRoute in another namespace", () => {
    const exposure = defineExposureComponent({
      name: "shared-route",
      hosts,
      build() {
        return {
          ingressSources: { cidrs: [], podSelectors: [] },
          capabilities: [
            {
              kind: "gateway-api",
              className: "eg",
              gateway: {
                apiVersion: "gateway.networking.k8s.io/v1",
                resource: "gateways",
                name: "shared-edge",
                namespace: "apps",
              },
              applicationRoutes: [
                {
                  apiVersion: "gateway.networking.k8s.io/v1",
                  resource: "httproutes",
                  name: "custom-app-route",
                  namespace: "edge-system",
                },
              ],
            },
          ],
        };
      },
    });
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure,
          routing: envoyNativeRouting(),
        }),
        context(),
      ),
    ).toThrow(/cannot target HTTPRoute "edge-system\/custom-app-route".*namespace-local/i);
  });

  it("attaches an HTTPRoute to existing shared Gateways via verbatim parentRefs", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: httpRouteExposure({
          className: "envoy",
          parentRefs: [
            { name: "envoy-external", namespace: "network", sectionName: "https" },
            { name: "envoy-internal", namespace: "network" },
          ],
          hosts,
        }),
      }),
      context(),
    );
    const objects = compiled.plan.operations.resources.objects;
    expect(objects).toHaveLength(1);
    const route = objects[0]!;
    expect(route).toMatchObject({
      apiVersion: "gateway.networking.k8s.io/v1",
      kind: "HTTPRoute",
      resource: "httproutes",
      metadata: { name: "test-app-routes", namespace: "apps" },
    });
    expect(route.body).toMatchObject({
      spec: {
        parentRefs: [
          { name: "envoy-external", namespace: "network", sectionName: "https" },
          { name: "envoy-internal", namespace: "network" },
        ],
        hostnames: ["app.example.com"],
        rules: [
          {
            matches: [{ path: { type: "PathPrefix", value: "/" } }],
            backendRefs: [{ name: "test-app-origin", port: 3000 }],
          },
        ],
      },
    });
    // No Gateway is emitted or required — attaching to the fleet's shared Gateway is
    // the whole point; a Gateway requirement or object would be a regression.
    expect(objects.some((entry) => entry.kind === "Gateway")).toBe(false);
    expect(compiled.plan.requirements.kubernetes.resources).toContainEqual({
      apiVersion: "gateway.networking.k8s.io/v1",
      resource: "httproutes",
      optional: false,
    });
    expect(
      compiled.plan.requirements.kubernetes.resources.some(
        (entry) => entry.resource === "gateways",
      ),
    ).toBe(false);
    // Failure output shows the shared gateways' programmed addresses.
    expect(compiled.plan.operations.diagnostics).toEqual([
      {
        kind: "kubernetes-gateway-address",
        gateway: {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "gateways",
          name: "envoy-external",
          namespace: "network",
        },
      },
      {
        kind: "kubernetes-gateway-address",
        gateway: {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "gateways",
          name: "envoy-internal",
          namespace: "network",
        },
      },
    ]);
  });

  it("gates httpRouteExposure readiness on Accepted and ResolvedRefs from every named parent", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: httpRouteExposure({
          className: "envoy",
          parentRefs: [
            { name: "envoy-external", namespace: "network", sectionName: "https" },
            { name: "envoy-internal", namespace: "network" },
          ],
          hosts,
        }),
      }),
      context(),
    );
    const routeRef = {
      apiVersion: "gateway.networking.k8s.io/v1",
      resource: "httproutes",
      name: "test-app-routes",
      namespace: "apps",
    };
    // Default portable routing contributes its own service-endpoints entry; the
    // exposure's contribution is exactly the two route conditions.
    const routeReadiness = compiled.plan.operations.resources.readiness.filter(
      (entry) => entry.kind === "kubernetes-condition",
    );
    expect(routeReadiness).toEqual(
      (["Accepted", "ResolvedRefs"] as const).map((type) => ({
        kind: "kubernetes-condition",
        object: routeRef,
        // minimumCount = parentRefs.length: a nonexistent parent Gateway reports NO
        // status.parents entry, which must not let the others pass readiness.
        conditionsAt: { kind: "parents", minimumCount: 2 },
        condition: {
          type,
          status: "True",
          observedGeneration: "must-equal-metadata-generation",
        },
        timeoutSeconds: 600,
      })),
    );
  });

  it("binds envoyNativeRouting to the httpRouteExposure route without any ClientTrafficPolicy", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: httpRouteExposure({
          className: "eg",
          parentRefs: [{ name: "envoy-external", namespace: "network" }],
          hosts,
        }),
        routing: envoyNativeRouting(),
      }),
      context(),
    );
    const policy = compiled.plan.operations.resources.objects.find(
      (entry) => entry.kind === "EnvoyExtensionPolicy",
    );
    expect(policy?.body).toMatchObject({
      spec: { targetRefs: [{ kind: "HTTPRoute", name: "test-app-routes" }] },
    });
    // Suppressed by default (not only under an explicit "external"): the CTP cannot
    // target the shared Gateway in ns "network", and the fleet may already run one.
    expect(
      compiled.plan.operations.resources.objects.some(
        (entry) => entry.kind === "ClientTrafficPolicy",
      ),
    ).toBe(false);
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: httpRouteExposure({
            className: "eg",
            parentRefs: [{ name: "envoy-external", namespace: "network" }],
            hosts,
          }),
          routing: envoyNativeRouting({ escapedSlashes: "policy" }),
        }),
        context(),
      ),
    ).toThrow(/"network\/envoy-external".*namespace-local/i);
  });

  it("keeps httpRouteExposure fingerprints distinct and stable", () => {
    const httpRoute = () =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: httpRouteExposure({
            className: "eg",
            parentRefs: [{ name: "envoy-external", namespace: "network" }],
            hosts,
          }),
        }),
        context(),
      );
    const gateway = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: gatewayApiExposure({ className: "eg", hosts }),
      }),
      context(),
    );
    const manual = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
      }),
      context(),
    );
    const compiled = httpRoute();
    expect(compiled.plan.target.fingerprint).not.toBe(gateway.plan.target.fingerprint);
    expect(compiled.plan.target.fingerprint).not.toBe(manual.plan.target.fingerprint);
    expect(
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: httpRouteExposure({
            className: "eg",
            parentRefs: [{ name: "envoy-external", namespace: "network" }],
            hosts,
          }),
        }),
        context({ buildId: "another-build" }),
      ).plan.target.fingerprint,
    ).toBe(compiled.plan.target.fingerprint);
  });

  it("validates httpRouteExposure options eagerly", () => {
    const valid = {
      className: "eg",
      parentRefs: [{ name: "envoy-external", namespace: "network" }],
      hosts,
    };
    expect(() => httpRouteExposure({ ...valid, parentRefs: [] })).toThrow(
      /at least one parentRef/i,
    );
    expect(() => httpRouteExposure({ ...valid, hosts: [] })).toThrow(/at least one host/i);
    expect(() => httpRouteExposure({ ...valid, className: "Bad_Class" })).toThrow(
      /invalid gatewayclass name/i,
    );
    expect(() =>
      httpRouteExposure({
        ...valid,
        parentRefs: [{ name: "envoy-external", sectionName: "HTTPS listener" }],
      }),
    ).toThrow(/invalid parentRef sectionName/i);
    expect(() => httpRouteExposure({ ...valid, parentRefs: [{ name: "-bad-gateway" }] })).toThrow(
      /invalid parentRef Gateway name/i,
    );
    expect(() =>
      httpRouteExposure({
        ...valid,
        parentRefs: [{ name: "envoy-external", namespace: "Bad Namespace" }],
      }),
    ).toThrow(/invalid namespace/i);
    expect(() => httpRouteExposure({ ...valid, escapedSlashes: "policy" as never })).toThrow(
      /only supports escapedSlashes: "external"/i,
    );
  });

  it("passes httpRouteExposure ingressSources through to the compiled target", () => {
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: httpRouteExposure({
          className: "envoy",
          parentRefs: [{ name: "envoy-external", namespace: "network" }],
          hosts,
          ingressSources: {
            cidrs: [],
            podSelectors: [
              {
                namespace: "network",
                labels: {
                  "app.kubernetes.io/name": "envoy",
                  "gateway.envoyproxy.io/owning-gateway-name": "envoy-external",
                  "gateway.envoyproxy.io/owning-gateway-namespace": "network",
                },
              },
            ],
          },
        }),
      }),
      context(),
    );
    expect(compiled.ingressSources).toEqual({
      cidrs: [],
      podSelectors: [
        {
          namespace: "network",
          labels: {
            "app.kubernetes.io/name": "envoy",
            "gateway.envoyproxy.io/owning-gateway-name": "envoy-external",
            "gateway.envoyproxy.io/owning-gateway-namespace": "network",
          },
        },
      ],
    });
  });

  it("keeps GKE-native routing explicit and derives release resource names without sentinels", () => {
    const tlsHosts = [{ hostname: "app.example.com", tls: { enabled: true } }];
    const compiled = compileTarget(
      defineTarget({
        cluster: gkeCluster(),
        exposure: gatewayApiExposure({
          className: "gke-l7-global-external-managed",
          hosts: tlsHosts,
          controllerManagedTls: true,
          controllerManagedCertificate: {
            annotation: "networking.gke.io/certmap",
            nameSuffix: "-certmap",
          },
          releaseAddresses: [{ type: "NamedAddress", nameSuffix: "-ip" }],
        }),
        routing: gkeNativeRouting(),
      }),
      context({ infrastructure: { projectId: "sample-project", region: "us-central1" } }),
    );
    expect(compiled.routingTier.registration).toBe("gke-traffic-extension");
    expect(compiled.plan.target.registry).toMatchObject({
      authentication: { kind: "ambient-credentials" },
      digestLookup: { kind: "oci-distribution" },
    });
    expect(JSON.stringify(compiled.plan)).not.toContain("PLACEHOLDER");
    expect(JSON.stringify(compiled.plan)).toContain("test-app-certmap");
    expect(JSON.stringify(compiled.plan)).toContain("test-app-ip");
    expect(compiled.plan.operations.cleanup.external).toEqual([
      {
        kind: "gcp-traffic-extension",
        projectId: "sample-project",
        name: "test-app-traffic-ext",
        location: "global",
      },
      {
        kind: "gcp-backend-service",
        projectId: "sample-project",
        name: "test-app-routing-service",
        scope: "global",
      },
      {
        kind: "gcp-health-check",
        projectId: "sample-project",
        name: "test-app-routing-hc",
        scope: "global",
      },
      { kind: "gcp-global-address", projectId: "sample-project", name: "test-app-ip" },
    ]);
    expect(compiled.plan.operations.cleanup.retained).toEqual([
      {
        kind: "gke-cluster",
        projectId: "sample-project",
        clusterName: "test-app-cluster",
        location: { kind: "region", name: "us-central1" },
      },
    ]);
    expect(compiled.plan.operations.diagnostics).toEqual([
      { kind: "gcp-auth", projectId: "sample-project" },
      {
        kind: "gcp-global-address",
        projectId: "sample-project",
        name: "test-app-ip",
      },
      {
        kind: "gcp-traffic-extension",
        projectId: "sample-project",
        extensionName: "test-app-traffic-ext",
        addressName: "test-app-ip",
      },
      {
        kind: "gcp-backend-service-shape",
        projectId: "sample-project",
        name: "test-app-routing-service",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        requireBackend: true,
      },
      {
        kind: "gcp-health-check-shape",
        projectId: "sample-project",
        name: "test-app-routing-hc",
        expectedType: "TCP",
      },
    ]);
  });
});

describe("open build-time hooks", () => {
  it("lets an NGINX ingress component contribute telemetry and fingerprints the contract", () => {
    const nginxExposure = (metricName: string) =>
      defineExposureComponent({
        name: "nginx-ingress",
        hosts,
        build(ctx) {
          const exposure = ingressExposure({ className: "nginx", hosts }).build(ctx);
          return {
            ...exposure,
            telemetry: [nginxTelemetrySource("provider.nginx-ingress", metricName)],
          };
        },
      });
    const compile = (metricName: string) =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: nginxExposure(metricName),
        }),
        context(),
      );

    const compiled = compile("nginx_ingress_controller_requests");
    expect(compiled.plan.operations.telemetry).toContainEqual(nginxTelemetrySource());
    expect(compiled.plan.target.fingerprint).not.toBe(
      compile("nginx_ingress_controller_request_duration_seconds").plan.target.fingerprint,
    );
  });

  it("rejects reserved and duplicate provider telemetry source ids", () => {
    const resource = (name: string, source: TelemetrySource) =>
      defineResourceComponent({ name, build: () => ({ telemetry: [source] }) });

    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
          resources: [resource("bad-telemetry", nginxTelemetrySource("adapter.injected"))],
        }),
        context(),
      ),
    ).toThrow(/reserved "adapter\." prefix/i);

    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
          resources: [
            resource("telemetry-one", nginxTelemetrySource()),
            resource("telemetry-two", nginxTelemetrySource()),
          ],
        }),
        context(),
      ),
    ).toThrow(/duplicate telemetry source id/i);
  });

  it("accepts a custom cluster without a provider key", () => {
    const cluster = defineClusterComponent({
      name: "home-cluster",
      build(ctx) {
        return {
          identity: {
            kind: "kubernetes-namespace-uid",
            namespace: "kube-system",
            uid: "cluster-uid",
          },
          access: { kind: "kubeconfig-context", context: "home" },
          registry: {
            repository: ctx.imageRegistry,
            authentication: { kind: "ambient-credentials" },
            digestLookup: { kind: "oci-distribution" },
          },
          network: {
            podCidrs: { kind: "kubernetes-node-pod-cidrs" },
            nodeCidrs: {
              kind: "kubernetes-node-addresses",
              addressTypes: ["InternalIP"],
            },
            missingSourcePolicy: "fail",
          },
          managedCache: "none",
        };
      },
    });
    const compiled = compileTarget(
      defineTarget({ cluster, exposure: ingressExposure({ className: "traefik", hosts }) }),
      context(),
    );

    expect(compiled.plan.target).toMatchObject({
      identity: { kind: "kubernetes-namespace-uid", uid: "cluster-uid" },
      access: { kind: "kubeconfig-context", context: "home" },
      registry: {
        repository: "ghcr.io/davidilie/test-app",
        authentication: { kind: "ambient-credentials" },
        digestLookup: { kind: "oci-distribution" },
      },
    });
    expect(compiled.plan.operations.network).toEqual({
      podCidrs: { kind: "kubernetes-node-pod-cidrs" },
      nodeCidrs: { kind: "kubernetes-node-addresses", addressTypes: ["InternalIP"] },
      missingSourcePolicy: "fail",
    });
    expect(JSON.stringify(compiled.plan)).not.toContain("gcp-");
    expect(compiled.plan.target.fingerprint).not.toBe(
      compileTarget(
        defineTarget({ cluster, exposure: ingressExposure({ className: "traefik", hosts }) }),
        context({ imageRegistry: "registry.example.com/team/test-app" }),
      ).plan.target.fingerprint,
    );
  });

  it("validates custom cluster component names", () => {
    expect(() =>
      defineClusterComponent({
        name: "Home Cluster",
        build: () => kubernetesCluster().build(context()),
      }),
    ).toThrow(/invalid target component name/i);
  });

  it("accepts typed objects, API requirements, and readiness", () => {
    const resource = defineResourceComponent({
      name: "metrics",
      build(ctx) {
        return {
          objects: [
            {
              apiVersion: "monitoring.coreos.com/v1",
              kind: "ServiceMonitor",
              resource: "servicemonitors",
              metadata: { name: `${ctx.releaseName}-metrics`, namespace: ctx.namespace },
              body: { spec: { selector: { matchLabels: { app: ctx.releaseName } } } },
            },
          ],
          requirements: [
            {
              apiVersion: "monitoring.coreos.com/v1",
              resource: "servicemonitors",
              optional: false,
            },
          ],
        };
      },
    });
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
        resources: [resource],
      }),
      context(),
    );
    expect(compiled.plan.operations.resources.objects[0]).toMatchObject({
      kind: "ServiceMonitor",
      metadata: { labels: { "adapter-k8s.dev/release": "test-app" } },
    });
  });

  it("accepts typed cleanup and diagnostics from custom components", () => {
    const resource = defineResourceComponent({
      name: "external-lifecycle",
      build() {
        return {
          externalCleanup: [
            {
              kind: "gcp-global-address",
              projectId: "sample-project",
              name: "custom-address",
            },
          ],
          retained: [
            {
              kind: "gcp-certificate-manager",
              projectId: "sample-project",
              releasePrefix: "test-app",
            },
          ],
          diagnostics: [
            {
              kind: "gcp-global-address",
              projectId: "sample-project",
              name: "custom-address",
            },
          ],
        };
      },
    });
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
        resources: [resource],
      }),
      context(),
    );
    expect(compiled.plan.operations.cleanup.external).toHaveLength(1);
    expect(compiled.plan.operations.cleanup.retained).toHaveLength(1);
    expect(compiled.plan.operations.diagnostics).toHaveLength(1);
  });

  it("rejects ownership-label overrides", () => {
    const resource = defineResourceComponent({
      name: "foreign-owner",
      build(ctx) {
        return {
          objects: [
            {
              apiVersion: "example.com/v1",
              kind: "Thing",
              resource: "things",
              metadata: {
                name: "owned-elsewhere",
                namespace: ctx.namespace,
                labels: { "adapter-k8s.dev/release": "another-release" },
              },
              body: {},
            },
          ],
        };
      },
    });
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
          resources: [resource],
        }),
        context(),
      ),
    ).toThrow(/overrides reserved label/i);
  });

  it("accepts ordinary pod commands but rejects non-JSON manifest values", () => {
    const deployment = defineResourceComponent({
      name: "worker",
      build(ctx) {
        return {
          objects: [
            {
              apiVersion: "apps/v1",
              kind: "Deployment",
              resource: "deployments",
              metadata: { name: "worker", namespace: ctx.namespace },
              body: {
                spec: {
                  template: {
                    spec: { containers: [{ name: "worker", command: ["node", "worker.js"] }] },
                  },
                },
              },
            },
          ],
        };
      },
    });
    const compiled = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
        resources: [deployment],
      }),
      context(),
    );
    expect(JSON.stringify(compiled.plan)).toContain('"command":["node","worker.js"]');

    const nonJson = defineResourceComponent({
      name: "non-json",
      build(ctx) {
        return {
          objects: [
            {
              apiVersion: "example.com/v1",
              kind: "Thing",
              resource: "things",
              metadata: { name: "bad", namespace: ctx.namespace },
              body: { spec: { callback: (() => undefined) as never } },
            },
          ],
        };
      },
    });
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure: manualExposure({ hosts }),
          resources: [nonJson],
        }),
        context(),
      ),
    ).toThrow(/expected an object/i);
  });

  it("rejects duplicate object identities", () => {
    const duplicateExposure = defineExposureComponent({
      name: "duplicate",
      hosts,
      build(ctx) {
        const object = {
          apiVersion: "example.com/v1",
          kind: "Thing",
          resource: "things",
          metadata: { name: "same", namespace: ctx.namespace },
          body: {},
        };
        return {
          objects: [object, { ...object }],
          ingressSources: { cidrs: [], podSelectors: [] },
          capabilities: [{ kind: "manual" }],
        };
      },
    });
    expect(() =>
      compileTarget(
        defineTarget({ cluster: kubernetesCluster(), exposure: duplicateExposure }),
        context(),
      ),
    ).toThrow(/duplicate Kubernetes object/i);
  });

  it("rejects unknown target and contribution fields", () => {
    expect(() =>
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({ hosts }),
        provider: "gke",
      } as never),
    ).toThrow(/unknown defineTarget field/i);

    const exposure = defineExposureComponent({
      name: "unknown-output",
      hosts,
      build() {
        return {
          objects: [],
          ingressSources: { cidrs: [], podSelectors: [] },
          capabilities: [],
          yaml: "kind: Service",
        } as never;
      },
    });
    expect(() =>
      compileTarget(defineTarget({ cluster: kubernetesCluster(), exposure }), context()),
    ).toThrow(/unknown field.*yaml/i);
  });
});

describe("legacy provider translation", () => {
  const base = { pools: { default: { routes: ["appPages"] } } };

  it("translates generic and GKE blocks without a provider registry", () => {
    const generic = targetForConfig({
      ...base,
      provider: {
        generic: {
          gateway: { className: "eg", hosts },
        },
      },
    } as K8sAdapterConfig);
    expect(generic.routing.name).toBe("envoy-native");

    const gke = targetForConfig({
      ...base,
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            hosts,
          },
        },
      },
    } as K8sAdapterConfig);
    expect(gke.routing.name).toBe("gke-native");
  });

  it("rejects target/provider conflicts and unknown legacy providers", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: manualExposure({ hosts }),
    });
    expect(() =>
      targetForConfig({ ...base, target, provider: { generic: {} } } as K8sAdapterConfig),
    ).toThrow(/target or legacy provider, not both/i);
    expect(() =>
      targetForConfig({ ...base, provider: { traefik: {} } } as unknown as K8sAdapterConfig),
    ).toThrow(/unknown legacy provider/i);
  });
});
