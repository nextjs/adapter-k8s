import { describe, expect, it } from "vitest";
// The cross-cutting half of the review: AGENTS.md says "Validate at the point of
// consumption … even if it was validated upstream", and the convention was applied in only
// 5 of 15 template modules. These are defence-in-depth assertions — one per module that had
// NO guard at all — so the convention cannot silently regress module by module.
import { renderChartYaml } from "../../../src/emit/templates/chart-yaml.js";
import { renderConfigMap } from "../../../src/emit/templates/configmap.js";
import { renderDeployServiceAccount } from "../../../src/emit/templates/deploy-service-account.js";
import { renderHPA } from "../../../src/emit/templates/hpa.js";
import { renderRoutingServiceService } from "../../../src/emit/templates/routing-service-service.js";
import { renderRoutingServiceHPA } from "../../../src/emit/templates/routing-service-hpa.js";
import { renderRoutingManifestConfigMap } from "../../../src/emit/templates/routing-manifest-configmap.js";

describe("chart-yaml.ts", () => {
  it("validates the release name and the chart version (both bare YAML scalars)", () => {
    expect(() => renderChartYaml({ name: "my-app", version: "0.1.0-b1" })).not.toThrow();
    expect(() => renderChartYaml({ name: 'x"\nfoo: bar', version: "0.1.0" })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderChartYaml({ name: "my-app", version: "not-semver" })).toThrow(
      /Invalid chart version/,
    );
    expect(() => renderChartYaml({ name: "my-app", version: '0.1.0"\nfoo: bar' })).toThrow(
      /Invalid chart version/,
    );
  });
});

describe("configmap.ts", () => {
  it("validates the release name and every data key", () => {
    expect(() =>
      renderConfigMap({ name: "cfg", releaseName: "BAD", data: { "a.json": "{}" } }),
    ).toThrow(/Invalid releaseName/);
    expect(() =>
      renderConfigMap({ name: "cfg", releaseName: "my-app", data: { "a b": "{}" } }),
    ).toThrow(/Invalid ConfigMap data key/);
  });

  it("routes the composed name through sanitizeK8sName", () => {
    const yaml = renderConfigMap({ name: "cfg", releaseName: "my-app", data: { k: "v" } });
    expect(yaml).toContain("name: my-app-cfg");
  });

  it("keeps the routing-manifest ConfigMap name byte-identical to routingManifestConfigMapName", () => {
    // rollback patches the routing Deployment's volume to this exact name.
    const yaml = renderRoutingManifestConfigMap({
      releaseName: "my-app",
      routingManifestJson: "{}",
    });
    expect(yaml).toContain("name: my-app-routing-manifest");
  });
});

describe("deploy-service-account.ts", () => {
  it("validates releaseName AND projectId (the Workload Identity binding target)", () => {
    expect(() =>
      renderDeployServiceAccount({ releaseName: "my-app", projectId: "my-project" }),
    ).not.toThrow();
    expect(() =>
      renderDeployServiceAccount({ releaseName: "my-app", projectId: 'p"\nfoo: bar' }),
    ).toThrow(/Invalid projectId/);
    expect(() =>
      renderDeployServiceAccount({ releaseName: "-bad-", projectId: "my-project" }),
    ).toThrow(/Invalid releaseName/);
  });
});

describe("hpa.ts", () => {
  it("validates releaseName, poolName and buildId", () => {
    expect(() =>
      renderHPA({ poolName: "ssr", buildId: "b1", releaseName: "my-app" }),
    ).not.toThrow();
    expect(() => renderHPA({ poolName: "ssr", buildId: "b1", releaseName: "BAD" })).toThrow(
      /Invalid releaseName/,
    );
    expect(() => renderHPA({ poolName: "on-", buildId: "b1", releaseName: "my-app" })).toThrow(
      /Invalid pool name/,
    );
    expect(() => renderHPA({ poolName: "ssr", buildId: 'a"x', releaseName: "my-app" })).toThrow(
      /Invalid buildId/,
    );
  });

  it("labels each autoscaler with its adapter ownership, release, pool, build, and manager", () => {
    const yaml = renderHPA({ poolName: "ssr", buildId: "123-build", releaseName: "my-app" });
    expect(yaml).toContain('adapter-k8s.dev/release: "my-app"');
    expect(yaml).toContain('app.kubernetes.io/name: "my-app"');
    expect(yaml).toContain('app.kubernetes.io/component: "ssr"');
    expect(yaml).toContain('app.kubernetes.io/version: "b-123-build"');
    expect(yaml).toContain("app.kubernetes.io/managed-by: Helm");
  });
});

describe("routing-service-service.ts", () => {
  it("validates releaseName (it lands in a JSON-in-YAML NEG annotation)", () => {
    expect(() => renderRoutingServiceService({ releaseName: "my-app" })).not.toThrow();
    expect(() => renderRoutingServiceService({ releaseName: 'x"}}\nfoo: bar' })).toThrow(
      /Invalid releaseName/,
    );
  });
});

describe("routing-service-hpa.ts", () => {
  it("N60: validates the three bare-scalar scaling numbers", () => {
    expect(() => renderRoutingServiceHPA({ releaseName: "my-app" })).not.toThrow();
    expect(() =>
      renderRoutingServiceHPA({
        releaseName: "my-app",
        minReplicas: "2\n  INJECTED: yes" as unknown as number,
      }),
    ).toThrow(/routingService\.scaling\.min/);
    expect(() => renderRoutingServiceHPA({ releaseName: "my-app", targetCPU: 0 })).toThrow(
      /routingService\.scaling\.targetCPU/,
    );
    expect(() => renderRoutingServiceHPA({ releaseName: "my-app", maxReplicas: 2.5 })).toThrow(
      /routingService\.scaling\.max/,
    );
  });

  it("rejects min > max (the API server would reject the HPA)", () => {
    expect(() =>
      renderRoutingServiceHPA({ releaseName: "my-app", minReplicas: 5, maxReplicas: 2 }),
    ).toThrow(/greater than/);
  });

  it("validates releaseName", () => {
    expect(() => renderRoutingServiceHPA({ releaseName: "Bad" })).toThrow(/Invalid releaseName/);
  });
});
