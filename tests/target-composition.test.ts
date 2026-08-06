import { describe, expect, it } from "vitest";
import {
  compileTarget,
  defineExposureComponent,
  defineResourceComponent,
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeNativeRouting,
  ingressExposure,
  kubernetesCluster,
  manualExposure,
  targetForConfig,
} from "../src/target/index.js";
import type { K8sAdapterConfig } from "../src/types.js";
import type { TargetBuildContext } from "../src/target/types.js";

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

  it("rejects an Envoy policy targeting a Gateway in another namespace", () => {
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
    expect(() =>
      compileTarget(
        defineTarget({
          cluster: kubernetesCluster(),
          exposure,
          routing: envoyNativeRouting(),
        }),
        context(),
      ),
    ).toThrow(/cannot target Gateway "edge-system\/shared-edge".*namespace-local/i);
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
