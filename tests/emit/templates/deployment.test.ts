import { describe, expect, it } from "vitest";
import { renderDeployment } from "../../../src/emit/templates/deployment.js";

describe("renderDeployment", () => {
  it("renders a retained build with the canonical pod template", () => {
    const yaml = renderDeployment({
      poolName: "ssr",
      buildId: "old123",
      releaseName: "my-app",
      imageTag: "old123",
      replicas: 3,
    });

    expect(yaml).toContain("replicas: 3");
    expect(yaml).toContain("NEXT_BUILD_ID");
    expect(yaml).toContain('value: "old123"');
    expect(yaml).toContain("RELEASE_NAME");
    expect(yaml).toContain(':old123"');
    expect(yaml).toContain("resources:");
    expect(yaml).toContain('.resources.requests.cpu }}"');
    expect(yaml).toContain('.resources.limits.memory }}"');
  });

  it("omits Valkey env when cache is disabled (default)", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).not.toContain("VALKEY_URL");
    expect(yaml).not.toContain("VALKEY_AUTH");
  });

  it("injects optional Valkey env from the release secret when cache is enabled", () => {
    const yaml = renderDeployment({
      poolName: "ssr",
      buildId: "b1",
      releaseName: "my-app",
      cacheEnabled: true,
    });
    expect(yaml).toContain("name: VALKEY_URL");
    expect(yaml).toContain("name: VALKEY_AUTH");
    expect(yaml).toContain("name: my-app-valkey");
    // optional so a missing secret never blocks pod startup
    expect(yaml).toContain("optional: true");
  });
});
