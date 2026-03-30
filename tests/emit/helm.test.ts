// tests/emit/helm.test.ts
import { describe, it, expect } from "vitest";
import { generateHelmChart } from "../../src/emit/helm.js";
import { sanitizeK8sName } from "../../src/emit/templates/utils.js";
import type { PoolDefinition, K8sAdapterConfig, RoutingManifest } from "../../src/types.js";

const mockManifest: RoutingManifest = {
  routeGraph: { rsc: {} } as any,
  pathnames: [],
  i18n: null,
  buildId: "abc123",
  basePath: "",
  middleware: null,
  poolAssignments: {},
  pprRoutes: {},
  nextVersion: "16.2.0",
};

describe("generateHelmChart", () => {
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
    expect(result["templates/ssr-deployment.yaml"]).toBeDefined();
    expect(result["templates/ssr-service.yaml"]).toBeDefined();
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
});
