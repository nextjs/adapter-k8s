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

  it("always injects the optional Valkey env from the release secret", () => {
    // Emitted unconditionally (optional:true) so toggling cache.enabled never rolls the retained
    // previous deployment; the pool only registers the handler when VALKEY_URL is actually set.
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).toContain("name: VALKEY_URL");
    expect(yaml).toContain("name: VALKEY_AUTH");
    expect(yaml).toContain("name: my-app-valkey");
    // optional so a missing secret never blocks pod startup
    expect(yaml).toContain("optional: true");
  });
});
