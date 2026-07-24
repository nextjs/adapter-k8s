// tests/emit/helm.test.ts
import { describe, it, expect } from "vitest";
import { generateHelmChart, SECRET_CHART_FILES } from "../../src/emit/helm.js";
import { sanitizeK8sName } from "../../src/emit/templates/utils.js";
import type { PoolDefinition, K8sAdapterConfig, RoutingManifest } from "../../src/types.js";

const mockManifest: RoutingManifest = {
  routeGraph: { rsc: {} } as any,
  pathnames: [],
  i18n: null,
  buildId: "abc123",
  builtAt: "2026-01-01T00:00:00.000Z",
  basePath: "",
  middleware: null,
  poolAssignments: {},
  pprRoutes: {},
  nextVersion: "16.2.0",
};

describe("generateHelmChart", () => {
  it("translates flat pool resource settings into Kubernetes requests and limits", () => {
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [],
          config: {
            routes: ["appPages"],
            resources: {
              cpu: "500m",
              memory: "768Mi",
              cpuLimit: "2",
              memoryLimit: "1Gi",
            },
          },
        },
      ],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });
    const values = JSON.parse(result["values.yaml"].slice(result["values.yaml"].indexOf("{")));

    expect(values.pools.ssr.resources).toEqual({
      requests: { cpu: "500m", memory: "768Mi" },
      limits: { cpu: "2", memory: "1Gi" },
    });
  });

  it("generates chart with correct structure", () => {
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [],
          config: {
            routes: ["appPages"],
            scaling: { min: 2, max: 10, targetCPU: 70 },
          },
        },
      ],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });

    expect(result["Chart.yaml"]).toContain("name:");
    expect(result["Chart.yaml"]).toContain("version:");
    expect(result["values.yaml"]).toContain("abc123");
    expect(result["values.yaml"]).toContain('"activeBuildId": "abc123"');
    expect(result["templates/ssr-deployment.yaml"]).toBeDefined();
    expect(result["templates/ssr-service.yaml"]).toBeDefined();
    expect(result["templates/ssr-active-service.yaml"]).toContain(
      'app.kubernetes.io/version: "{{ .Values.activeBuildId }}"',
    );
    expect(result["templates/ssr-hpa.yaml"]).toBeDefined();
    expect(result["templates/routing-manifest-configmap.yaml"]).toBeDefined();
    expect(result["templates/http-route.yaml"]).toBeDefined();
    expect(result["templates/gateway.yaml"]).toBeDefined();
    expect(result["templates/gateway.yaml"]).toContain("type: NamedAddress");
    expect(result["templates/gateway.yaml"]).toContain("value: nextjs-ip");

    const deploymentContent = result["templates/ssr-deployment.yaml"];
    const expectedName = sanitizeK8sName("nextjs-ssr-abc123");
    expect(deploymentContent).toContain(`name: ${expectedName}`);
  });

  it("renders the internal-header Secret and wires it into pool + routing-service deployments", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: { gateway: { type: "gateway-api", hosts: [{ hostname: "app.example.com" }] } },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      extensionChainJson: "[]",
      internalSecret: "deadbeef",
    });

    const secretFile = result["templates/internal-secret.yaml"];
    expect(secretFile).toBeDefined();
    expect(secretFile).toContain("kind: Secret");
    expect(secretFile).toContain("name: nextjs-internal-header-secret");
    expect(secretFile).toContain('secret: "deadbeef"');

    // Both deployments must read INTERNAL_HEADER_SECRET from that Secret via secretKeyRef.
    for (const file of [
      "templates/ssr-deployment.yaml",
      "templates/routing-service-deployment.yaml",
    ]) {
      const content = result[file];
      expect(content).toContain("name: INTERNAL_HEADER_SECRET");
      expect(content).toContain("secretKeyRef:");
      expect(content).toContain("name: nextjs-internal-header-secret");
      expect(content).toContain("key: secret");
    }
  });

  it("generates a random internal secret when none is supplied", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const args = {
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    };
    const a = generateHelmChart(args)["templates/internal-secret.yaml"];
    const b = generateHelmChart(args)["templates/internal-secret.yaml"];
    expect(a).not.toEqual(b); // random per render
  });

  it("generates header-based HTTPRoute rules for pools", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });

    const httpRoute = result["templates/http-route.yaml"];
    expect(httpRoute).toContain("x-upstream-pool");
  });

  it("includes routing service templates when extensionChainJson provided", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      extensionChainJson: JSON.stringify([
        {
          name: "nextjs-routing",
          matchCondition: { celExpression: "true" },
          extensions: [
            {
              name: "routing-service",
              authority: "nextjs-routing-service.default.svc.cluster.local",
              service:
                "projects/my-project/locations/us-central1/backendServices/nextjs-routing-service",
              timeout: "5s",
              supportedEvents: ["REQUEST_HEADERS"],
              failOpen: true,
            },
          ],
        },
      ]),
      infrastructure: { projectId: "my-project", region: "us-central1" },
    });

    expect(result["templates/routing-service-deployment.yaml"]).toBeDefined();
    expect(result["templates/routing-service-service.yaml"]).toBeDefined();
    expect(result["templates/routing-service-hpa.yaml"]).toBeDefined();
    expect(result["templates/route-ext-config.yaml"]).toBeDefined();
    expect(result["templates/route-ext-update-job.yaml"]).toBeDefined();
  });

  it("generates one deployment per pool", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
      ["api", { name: "api", outputs: [], config: { routes: ["appRoutes"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] }, api: { routes: ["appRoutes"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });

    expect(result["templates/ssr-deployment.yaml"]).toBeDefined();
    expect(result["templates/api-deployment.yaml"]).toBeDefined();
  });

  it("emits the CDN filter and wires it into the HTTPRoute when cdn.enabled", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            cdn: { enabled: true, bucket: "" },
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });

    const filter = result["templates/cdn-http-filter.yaml"];
    expect(filter).toBeDefined();
    expect(filter).toContain("kind: GCPHTTPFilter");
    expect(filter).toContain("cacheMode: USE_ORIGIN_HEADERS");

    const httpRoute = result["templates/http-route.yaml"];
    expect(httpRoute).toContain("type: ExtensionRef");
    expect(httpRoute).toContain("name: nextjs-cdn");
    // every rule carries the filter
    const ruleCount = (httpRoute.match(/- matches:/g) ?? []).length;
    const filterCount = (httpRoute.match(/type: ExtensionRef/g) ?? []).length;
    expect(filterCount).toBe(ruleCount);
  });

  it("emits no CDN artifacts when cdn is disabled or absent, leaving the chart unchanged", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const baseArgs = {
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    };
    const gateway = {
      type: "gateway-api",
      className: "gke-l7-global-external-managed",
      hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
    };

    const absent = generateHelmChart({
      ...baseArgs,
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { gateway } },
      } as K8sAdapterConfig,
    });
    const disabled = generateHelmChart({
      ...baseArgs,
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { gateway, cdn: { enabled: false, bucket: "" } } },
      } as K8sAdapterConfig,
    });

    for (const chart of [absent, disabled]) {
      expect(chart["templates/cdn-http-filter.yaml"]).toBeUndefined();
      expect(chart["templates/http-route.yaml"]).not.toContain("filters:");
      expect(chart["templates/http-route.yaml"]).not.toContain("GCPHTTPFilter");
    }
    // cdn.enabled: false is byte-identical to cdn absent, excluding the generated timestamp.
    const withoutTimestamp = (chart: Record<string, string>) => ({
      ...chart,
      "values.yaml": chart["values.yaml"].replace(/^# Generated: .*$/m, "# Generated: <time>"),
    });
    expect(withoutTimestamp(disabled)).toEqual(withoutTimestamp(absent));
  });

  it("emits no CDN artifacts without gateway hosts (unreachable via validated config)", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { cdn: { enabled: true, bucket: "" } } },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });
    expect(result["templates/cdn-http-filter.yaml"]).toBeUndefined();
    expect(result["templates/http-route.yaml"]).toBeUndefined();
  });

  it("always emits the NetworkPolicy template (helm-gated) with an empty podCidrs default", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
    });

    // The template is always in the chart; the helm `if` guard renders nothing until the
    // deploy CLI sets global.networkPolicy.podCidrs.
    const netpol = result["templates/network-policy.yaml"];
    expect(netpol).toBeDefined();
    expect(netpol).toContain("{{- if .Values.global.networkPolicy.podCidrs }}");
    expect(netpol).toContain("kind: NetworkPolicy");

    // values.yaml carries the empty default the CLI overrides with --set.
    const values = JSON.parse(result["values.yaml"].slice(result["values.yaml"].indexOf("{")));
    expect(values.global.networkPolicy).toEqual({ podCidrs: [] });
  });

  it("marks the secret-bearing templates for mode-0600 writes (M4)", () => {
    // adapter.ts writes chart files and MUST create these with mode 0600 — the set is
    // the single source of truth, kept next to the files' generation.
    expect(SECRET_CHART_FILES.has("templates/internal-secret.yaml")).toBe(true);
    expect(SECRET_CHART_FILES.has("templates/valkey-secret.yaml")).toBe(true);
    expect(SECRET_CHART_FILES.size).toBe(2);
  });

  it("throws a helpful error when the routing manifest exceeds the ConfigMap size limit", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    // Build a manifest whose serialized form is well over ~950 KiB.
    const bigPoolAssignments: Record<string, string> = {};
    for (let i = 0; i < 40000; i++) {
      bigPoolAssignments[`/some/reasonably/long/route/path/number/${i}`] = "ssr";
    }
    const oversizedManifest: RoutingManifest = {
      ...mockManifest,
      poolAssignments: bigPoolAssignments,
    };

    expect(() =>
      generateHelmChart({
        pools,
        buildId: "abc123",
        nextVersion: "16.2.0",
        config: {
          pools: { ssr: { routes: ["appPages"] } },
          provider: { gke: {} },
        } as K8sAdapterConfig,
        imageRegistry: "gcr.io/my-project",
        routingManifest: oversizedManifest,
      }),
    ).toThrow(/too large to embed in a ConfigMap/);
  });
});
