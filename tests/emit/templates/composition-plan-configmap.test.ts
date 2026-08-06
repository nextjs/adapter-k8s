import { describe, expect, it } from "vitest";
import {
  compileTarget,
  defineTarget,
  kubernetesCluster,
  manualExposure,
} from "../../../src/target/index.js";
import { renderCompositionPlanConfigMap } from "../../../src/emit/templates/composition-plan-configmap.js";

describe("renderCompositionPlanConfigMap", () => {
  it("retains an immutable, digest-labelled plan snapshot", () => {
    const { plan } = compileTarget(
      defineTarget({
        cluster: kubernetesCluster(),
        exposure: manualExposure({
          hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
        }),
      }),
      {
        releaseName: "app",
        namespace: "apps",
        buildId: "build-1",
        imageRegistry: "ghcr.io/example/app",
        pools: ["default"],
        defaultPool: "default",
        failurePolicy: "closed",
      },
    );
    const yaml = renderCompositionPlanConfigMap(plan);
    expect(yaml).toContain("name: app-composition-build-1");
    expect(yaml).toContain("helm.sh/resource-policy: keep");
    expect(yaml).toContain("immutable: true");
    expect(yaml).toMatch(/adapter-k8s\.dev\/composition-digest: "sha256:[a-f0-9]{64}"/);
    expect(yaml).toContain('"minimumVersion":"1.33.0"');
  });
});
