import { describe, it, expect } from "vitest";
import { renderRouteExtUpdateJob } from "../../../src/emit/templates/route-ext-update-job.js";
import { renderRouteExtConfigMap } from "../../../src/emit/templates/route-ext-configmap.js";

describe("renderRouteExtUpdateJob", () => {
  it("renders a Helm hook Job using import command", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    expect(yaml).toContain("kind: Job");
    // Not a Helm hook — runs as a regular Job so it doesn't block deploys
    expect(yaml).toContain("kind: Job");
    expect(yaml).toContain("gcloud service-extensions lb-route-extensions import");
    expect(yaml).toContain("my-app-route-ext");
    expect(yaml).toContain("route-extension.yaml");
  });
});

describe("renderRouteExtConfigMap", () => {
  it("renders a ConfigMap with route extension YAML spec", () => {
    const chainJson = JSON.stringify([
      {
        name: "nextjs-routing",
        matchCondition: { celExpression: "true" },
        extensions: [
          {
            name: "routing-service",
            authority: "my-app-routing-service.default.svc.cluster.local",
            service:
              "projects/my-project/locations/us-central1/backendServices/my-app-routing-service",
            timeout: "5s",
            supportedEvents: ["REQUEST_HEADERS"],
            failOpen: true,
          },
        ],
      },
    ]);

    const yaml = renderRouteExtConfigMap({
      releaseName: "my-app",
      extensionChainJson: chainJson,
      projectId: "my-project",
      region: "us-central1",
    });

    expect(yaml).toContain("kind: ConfigMap");
    expect(yaml).toContain("route-extension.yaml");
    expect(yaml).toContain("loadBalancingScheme: EXTERNAL_MANAGED");
    expect(yaml).toContain("my-app-route-ext");
    expect(yaml).toContain("nextjs-routing");
  });
});
