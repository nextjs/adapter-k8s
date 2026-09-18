import { describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredRetention,
  RETENTION_EXPIRY_ANNOTATION,
  type ClusterObject,
  type CleanupApi,
} from "../src/retention-expiry.js";
import { renderRetentionCleanup } from "../src/emit/templates/retention-cleanup.js";

function cluster() {
  const state = {
    buildId: "new",
    previousBuildId: "old",
    generation: 2,
    poolTopologies: { new: ["web"], old: ["web"] },
  };
  const deployment: ClusterObject = {
    metadata: {
      name: "rel-web-old",
      uid: "old-uid",
      resourceVersion: "10",
      labels: {
        "app.kubernetes.io/name": "rel",
        "app.kubernetes.io/component": "web",
        "app.kubernetes.io/version": "old",
      },
      annotations: {
        [RETENTION_EXPIRY_ANNOTATION]: JSON.stringify({ buildId: "old", expiresAt: 1000 }),
      },
    },
    spec: { replicas: 1 },
  };
  const services: ClusterObject[] = [
    { metadata: { name: "rel-web" }, spec: { selector: { "app.kubernetes.io/version": "new" } } },
  ];
  const hpas: ClusterObject[] = [];
  let beforePatch = () => {};
  let beforeStateRead = () => {};
  const api: CleanupApi = {
    get: vi.fn(async (path: string) => {
      if (path.includes("/configmaps/")) {
        beforeStateRead();
        return {
          metadata: { name: "rel-adapter-state" },
          data: { "state.json": JSON.stringify(state) },
        };
      }
      if (path.includes("/deployments?"))
        return { metadata: { name: "" }, items: [structuredClone(deployment)] };
      if (path.includes("/services?")) return { metadata: { name: "" }, items: services };
      if (path.includes("/horizontalpodautoscalers?"))
        return { metadata: { name: "" }, items: hpas };
      throw new Error(`Unexpected path ${path}`);
    }),
    patch: vi.fn(async (path, operations) => {
      beforePatch();
      expect(path).toBe("/apis/apps/v1/namespaces/ns/deployments/rel-web-old/scale");
      for (const op of operations as { op: string; path: string; value: unknown }[]) {
        if (op.op === "test") {
          const field = op.path.split("/").at(-1)! as "uid" | "resourceVersion";
          if (deployment.metadata[field] !== op.value)
            throw Object.assign(new Error("conflict"), { status: 409 });
        }
      }
      deployment.spec!.replicas = 0;
      deployment.metadata.resourceVersion = "11";
    }),
  };
  return {
    api,
    state,
    deployment,
    services,
    hpas,
    onPatch(fn: () => void) {
      beforePatch = fn;
    },
    onStateRead(fn: () => void) {
      beforeStateRead = fn;
    },
  };
}

describe("retention expiry", () => {
  it("scales an expired standby once and preserves its rollback resources", async () => {
    const c = cluster();
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 1000)).toBe(1);
    expect(c.deployment.spec!.replicas).toBe(0);
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 1001)).toBe(0);
    expect(c.api.patch).toHaveBeenCalledTimes(1);
    expect(c.deployment.metadata.annotations![RETENTION_EXPIRY_ANNOTATION]).toBeDefined();
  });
  it("waits until the deadline", async () => {
    const c = cluster();
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 999)).toBe(0);
    expect(c.api.patch).not.toHaveBeenCalled();
  });
  it("does not retire a still-active build after an interrupted preparation", async () => {
    const c = cluster();
    c.state.buildId = "old";
    c.state.previousBuildId = "new";
    c.services[0]!.spec!.selector!["app.kubernetes.io/version"] = "old";
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
    expect(c.api.patch).not.toHaveBeenCalled();
  });
  it.each([undefined, "warm-up", "old"])(
    "refuses selector disagreement or overlap: %s",
    async (version) => {
      const c = cluster();
      c.services[0]!.spec!.selector!["app.kubernetes.io/version"] = version;
      expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
      expect(c.api.patch).not.toHaveBeenCalled();
    },
  );
  it("checks the portable origin too", async () => {
    const c = cluster();
    c.services.push({
      metadata: { name: "rel-origin" },
      spec: { selector: { "app.kubernetes.io/version": "old" } },
    });
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
  });
  it("does not fight an HPA", async () => {
    const c = cluster();
    c.hpas.push({
      metadata: { name: "custom" },
      spec: { scaleTargetRef: { name: "rel-web-old" } },
    });
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
  });
  it.each(["bad", '{"buildId":"old","expiresAt":null}', '{"buildId":"../old","expiresAt":1}'])(
    "refuses invalid markers: %s",
    async (raw) => {
      const c = cluster();
      c.deployment.metadata.annotations![RETENTION_EXPIRY_ANNOTATION] = raw;
      expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
    },
  );
  it("abandons a snapshot after the deploy state changes", async () => {
    const c = cluster();
    let reads = 0;
    c.onStateRead(() => {
      if (++reads === 2) c.state.generation++;
    });
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
    expect(c.api.patch).not.toHaveBeenCalled();
  });
  it("cannot scale a rollback target after its expiry marker is renewed", async () => {
    const c = cluster();
    c.onPatch(() => {
      c.deployment.metadata.annotations![RETENTION_EXPIRY_ANNOTATION] = JSON.stringify({
        buildId: "old",
        expiresAt: 3_600_000,
      });
      c.deployment.metadata.resourceVersion = "20";
      c.deployment.spec!.replicas = 2;
    });
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
    expect(c.deployment.spec!.replicas).toBe(2);
  });
  it("cannot scale a Deployment recreated under the same name", async () => {
    const c = cluster();
    c.onPatch(() => {
      c.deployment.metadata.uid = "replacement";
      c.deployment.spec!.replicas = 2;
    });
    expect(await cleanupExpiredRetention(c.api, "rel", "ns", 5000)).toBe(0);
    expect(c.deployment.spec!.replicas).toBe(2);
  });
  it("keeps capacity when the API cannot prove state", async () => {
    const c = cluster();
    vi.mocked(c.api.get).mockRejectedValueOnce(new Error("unavailable"));
    await expect(cleanupExpiredRetention(c.api, "rel", "ns", 5000)).rejects.toThrow("unavailable");
    expect(c.api.patch).not.toHaveBeenCalled();
  });
  it("does not treat an RBAC failure as successful cleanup", async () => {
    const c = cluster();
    vi.mocked(c.api.patch).mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    await expect(cleanupExpiredRetention(c.api, "rel", "ns", 5000)).rejects.toThrow("forbidden");
    expect(c.deployment.spec!.replicas).toBe(1);
  });
});

it("renders a bounded, credential-isolated cleanup job using the pinned pool image", () => {
  const yaml = renderRetentionCleanup({
    releaseName: "rel",
    buildId: "new",
    poolName: "web",
    nodeArchitecture: "arm64",
    imageDigest: "sha256:" + "a".repeat(64),
    pullSecrets: ["registry-auth"],
  });
  expect(yaml).toContain("kind: CronJob");
  expect(yaml).toContain("concurrencyPolicy: Forbid");
  expect(yaml).toContain("activeDeadlineSeconds: 90");
  expect(yaml).toContain("/app/retention-cleanup.cjs");
  expect(yaml).toContain("image.repository }}@sha256:");
  expect(yaml).toContain("registry-auth");
  expect(yaml).not.toContain('resources: ["secrets"]');
  expect(yaml).toContain('resources: ["deployments/scale"]');
  expect(yaml).toContain("readOnlyRootFilesystem: true");
});
