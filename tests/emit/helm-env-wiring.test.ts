// Wiring test: adapter config `env`/`envFrom` must actually reach the rendered pod template.
// tests/emit/deployment-env.test.ts covers the renderer in isolation, which would stay green
// even if generateHelmChart never passed the values through — this closes that gap, and
// covers the per-pool merge, which only exists in helm.ts.
import { describe, it, expect } from "vitest";
import { generateHelmChart } from "../../src/emit/helm.js";
import type { PoolDefinition, K8sAdapterConfig, RoutingManifest } from "../../src/types.js";

const manifest = {
  routeGraph: { rsc: {} },
  pathnames: [],
  i18n: null,
  buildId: "bms6abc",
  builtAt: "2026-01-01T00:00:00.000Z",
  basePath: "",
  middleware: null,
  poolAssignments: {},
  pprRoutes: {},
  pprCapableRoutes: {},
} as unknown as RoutingManifest;

const CHAIN = JSON.stringify([
  {
    name: "nextjs-routing",
    matchCondition: { celExpression: "true" },
    extensions: [
      {
        name: "routing-service",
        authority: "nextjs-routing-service.default.svc.cluster.local",
        service: "projects/p-123456/global/backendServices/nextjs-routing-service",
        timeout: "5s",
        supportedEvents: ["REQUEST_HEADERS"],
        failOpen: false,
      },
    ],
  },
]);

function render(config: Partial<K8sAdapterConfig>): Record<string, string> {
  const pools = new Map<string, PoolDefinition>([
    ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ["api", { name: "api", outputs: [], config: { routes: ["pagesApi"] } }],
  ]);
  return generateHelmChart({
    pools,
    buildId: "bms6abc",
    nextVersion: "16.2.0",
    config: {
      pools: { ssr: { routes: ["appPages"] }, api: { routes: ["pagesApi"] } },
      provider: {
        gke: { gateway: { type: "gateway-api", hosts: [{ hostname: "app.example.com" }] } },
      },
      ...config,
    } as K8sAdapterConfig,
    imageRegistry: "gcr.io/my-project",
    routingManifest: manifest,
    extensionChainJson: CHAIN,
    infrastructure: { projectId: "my-project", region: "us-central1" },
    internalSecret: "a".repeat(64),
  });
}

describe("adapter config env reaches the rendered chart", () => {
  it("puts a shared env value into EVERY pool's deployment", () => {
    const files = render({ env: { API_URL: "https://api.example.com" } });
    for (const pool of ["ssr", "api"]) {
      expect(files[`templates/${pool}-deployment.yaml`]).toContain("- name: API_URL");
    }
  });

  it("merges per-pool env over the shared map", () => {
    const files = render({
      env: { TIER: "shared" },
      pools: {
        ssr: { routes: ["appPages"], env: { TIER: "ssr-override" } },
        api: { routes: ["pagesApi"] },
      },
    });
    expect(files["templates/ssr-deployment.yaml"]).toContain('value: "ssr-override"');
    expect(files["templates/ssr-deployment.yaml"]).not.toContain('value: "shared"');
    expect(files["templates/api-deployment.yaml"]).toContain('value: "shared"');
  });

  it("appends per-pool envFrom after the shared sources", () => {
    const files = render({
      envFrom: [{ secret: "shared-secrets" }],
      pools: {
        ssr: { routes: ["appPages"], envFrom: [{ configMap: "ssr-config" }] },
        api: { routes: ["pagesApi"] },
      },
    });
    const ssr = files["templates/ssr-deployment.yaml"]!;
    expect(ssr.indexOf("shared-secrets")).toBeLessThan(ssr.indexOf("ssr-config"));
    expect(files["templates/api-deployment.yaml"]).not.toContain("ssr-config");
  });

  it("emits no envFrom key at all when nothing is configured", () => {
    const files = render({});
    expect(files["templates/ssr-deployment.yaml"]).not.toContain("envFrom:");
  });
});
