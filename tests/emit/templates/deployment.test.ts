import { describe, expect, it } from "vitest";
import { renderDeployment } from "../../../src/emit/templates/deployment.js";

describe("renderDeployment WebSocket drain", () => {
  it("emits a grace period, preStop NEG-deprogram sleep, and DRAIN_SECONDS env by default", () => {
    const yaml = renderDeployment({ poolName: "ws", buildId: "b1", releaseName: "app" });
    // default drainSeconds 25 + preStop 10 + buffer 5 = 40
    expect(yaml).toContain("terminationGracePeriodSeconds: 40");
    expect(yaml).toContain("preStop:");
    expect(yaml).toContain('sleep 10"');
    expect(yaml).toContain("name: DRAIN_SECONDS");
    expect(yaml).toContain('value: "25"');
  });

  it("threads a custom drainSeconds into the grace period and env", () => {
    const yaml = renderDeployment({
      poolName: "ws",
      buildId: "b1",
      releaseName: "app",
      drainSeconds: 120,
    });
    expect(yaml).toContain("terminationGracePeriodSeconds: 135"); // 120 + 10 + 5
    expect(yaml).toContain('value: "120"');
  });
});

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
