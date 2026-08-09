// The routing pod must mount a PER-BUILD manifest ConfigMap, not the stable mutable one.
//
// Found live on GKE 2026-07-30: five consecutive deploys failed because helm rewrote the
// stable `<release>-routing-manifest` CM and the new routing pod started seconds later —
// kubelet handed it the PRE-write content (ConfigMap update propagation lagged minutes on a
// degraded cluster; the design races it on EVERY deploy), the manifest-match guard correctly
// refused to serve middleware verdicts from a manifest the image was not built with, and the
// progress deadline condemned the rollout. Meanwhile pool pods — whose config is per-build
// resources referenced BY NAME — started fine all day: kubelet's lag affects updates to
// watched objects, never the first GET of a never-seen name.
//
// Fix, mirroring the N87 per-build dispatch Secret: the chart itself renders the per-build
// snapshot CM (the same `routingManifestSnapshotName` the retention machinery already uses)
// and the Deployment mounts THAT name. A new build's pods mount their own manifest with no
// propagation window; the guard becomes structurally satisfied; rollback re-points to the
// previous build's snapshot, which its retained render already names.
import { describe, it, expect } from "vitest";
import {
  renderRoutingManifestSnapshotConfigMap,
  routingManifestSnapshotName,
} from "../../src/emit/templates/routing-manifest-configmap.js";
import { renderRoutingServiceDeployment } from "../../src/emit/templates/routing-service-deployment.js";

const MANIFEST = JSON.stringify({ buildId: "bms7test1", routeGraph: {}, pathnames: [] });

describe("per-build routing manifest ConfigMap", () => {
  it("renders the snapshot CM under the retention naming scheme", () => {
    const yaml = renderRoutingManifestSnapshotConfigMap({
      releaseName: "test-app",
      buildId: "bms7test1",
      routingManifestJson: MANIFEST,
    });
    expect(yaml).toContain(`name: ${routingManifestSnapshotName("test-app", "bms7test1")}`);
    expect(yaml).toContain('app.kubernetes.io/name: "test-app"');
    expect(yaml).toContain('app.kubernetes.io/component: "routing-manifest-snapshot"');
    expect(yaml).toContain('helm.sh/resource-policy: "keep"');
    expect(yaml).toContain("routing-manifest.json");
  });

  it("the routing Deployment mounts the per-build snapshot, not the stable CM", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "test-app",
      buildId: "bms7test1",
      imageRegistry: "localhost:5511/adapter-e2e",
    });
    expect(yaml).toContain(`name: ${routingManifestSnapshotName("test-app", "bms7test1")}`);
    // The stable name must no longer be the mount source — mounting a mutable CM is the race.
    expect(yaml).not.toContain("name: test-app-routing-manifest");
  });

  it("two builds mount two different ConfigMaps", () => {
    const a = renderRoutingServiceDeployment({
      releaseName: "test-app",
      buildId: "bms7aaa",
      imageRegistry: "r/x",
    });
    const b = renderRoutingServiceDeployment({
      releaseName: "test-app",
      buildId: "bms7bbb",
      imageRegistry: "r/x",
    });
    const name = (y: string) => y.match(/configMap:\s*\n(?:\s*#[^\n]*\n)*\s*name: (\S+)/)?.[1];
    expect(name(a)).toBeTruthy();
    expect(name(a)).not.toBe(name(b));
  });
});
