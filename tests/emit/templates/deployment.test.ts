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
});
