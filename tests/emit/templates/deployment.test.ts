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

  it("ships the hardened pod/container security posture", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    // Pod level: non-root uid 1000 (the node user), seccomp, no SA token (the pool
    // never calls the Kubernetes API).
    expect(yaml).toContain("automountServiceAccountToken: false");
    expect(yaml).toContain("runAsNonRoot: true");
    expect(yaml).toContain("runAsUser: 1000");
    expect(yaml).toContain("fsGroup: 1000");
    expect(yaml).toContain("seccompProfile:");
    expect(yaml).toContain("type: RuntimeDefault");
    // Container level: no privilege escalation, read-only root FS, all caps dropped.
    expect(yaml).toContain("allowPrivilegeEscalation: false");
    expect(yaml).toContain("readOnlyRootFilesystem: true");
    expect(yaml).toContain('drop: ["ALL"]');
    // A writable /tmp (emptyDir) backs the read-only root filesystem.
    expect(yaml).toMatch(/volumeMounts:[\s\S]*?name: tmp\n\s+mountPath: \/tmp/);
    expect(yaml).toMatch(/volumes:[\s\S]*?name: tmp\n\s+emptyDir: \{\}/);
    // .next/cache stays writable for Next's filesystem-cache fallback when no shared
    // Valkey handler is wired (otherwise renders fail with EROFS).
    expect(yaml).toMatch(/name: next-cache\n\s+mountPath: \/app\/\.next\/cache/);
    expect(yaml).toMatch(/name: next-cache\n\s+emptyDir: \{\}/);
  });

  it("does NOT set TRUST_INTERNAL_HEADERS — the legacy bypass must not ship in the chart", () => {
    const yaml = renderDeployment({ poolName: "ssr", buildId: "b1", releaseName: "my-app" });
    expect(yaml).not.toContain("TRUST_INTERNAL_HEADERS");
  });
});
