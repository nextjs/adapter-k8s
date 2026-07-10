import { describe, it, expect } from "vitest";
import {
  renderRouteExtUpdateJob,
  routeExtJobName,
} from "../../../src/emit/templates/route-ext-update-job.js";
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
    expect(yaml).toContain("gcloud service-extensions lb-traffic-extensions import");
    expect(yaml).toContain("my-app-traffic-ext");
    expect(yaml).toContain("route-extension.yaml");
    // Attaches the standalone routing NEG to the ext_proc backend service
    expect(yaml).toContain("my-app-routing-neg");
    expect(yaml).toContain("add-backend");
  });

  it("renders the exact job name from routeExtJobName (deploy cleanup matches this)", () => {
    const buildId = "jpY1GCvqshOHB9PiQlgyf";
    const name = routeExtJobName("my-app", buildId);
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId,
    });
    // The rendered Job name MUST equal routeExtJobName's output — deploy.ts skips the
    // current job by exact name, and any drift deletes the running job mid-registration.
    expect(yaml).toContain(`name: ${name}`);
    // Regression: the name uses a 10-char build-id slice; deploy's old 12-char substring
    // match failed to skip it and deleted it.
    expect(name).toBe("my-app-route-ext-jpy1gcvqsh");
  });

  it("attaches to ALL forwarding rules and fails loudly (no http:// bypass, no false success)", () => {
    const yaml = renderRouteExtUpdateJob({
      releaseName: "my-app",
      projectId: "my-project",
      region: "us-central1",
      buildId: "abc123",
    });
    // P1: must NOT select a single/HTTPS-only forwarding rule — that leaves http:// traffic
    // bypassing the extension (middleware auth/rewrite bypass). Expand every FR.
    expect(yaml).not.toContain("--limit=1");
    expect(yaml).not.toContain("targetHttpsProxies");
    expect(yaml).toContain("FORWARDING_RULE_PLACEHOLDER");
    expect(yaml).toContain("fr_list");
    // P2: fail loudly (exit 1) when FR/NEG are absent — never silently "succeed" unregistered.
    expect(yaml).toContain("exit 1");
    expect(yaml).not.toContain("Skipping traffic extension");
    expect(yaml).toContain("only ${ATTACHED:-0}/$ZC zonal NEG(s) attached");
  });

  it("rejects a releaseName containing shell metacharacters", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: 'foo";rm -rf /;"',
        projectId: "my-project",
        region: "us-central1",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid releaseName/);
  });

  it("rejects a projectId containing an injection payload", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: "my-app",
        projectId: 'p";curl evil"',
        region: "us-central1",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid projectId/);
  });

  it("rejects a region containing shell metacharacters", () => {
    expect(() =>
      renderRouteExtUpdateJob({
        releaseName: "my-app",
        projectId: "my-project",
        region: "us-central1;reboot",
        buildId: "abc123",
      }),
    ).toThrow(/Invalid region/);
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
    expect(yaml).toContain("my-app-traffic-ext");
    expect(yaml).toContain("nextjs-routing");
  });
});
