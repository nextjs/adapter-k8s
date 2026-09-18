import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileTarget,
  defineTarget,
  envoyGatewayIngressSources,
  envoyNativeRouting,
  gatewayApiExposure,
  kubernetesCluster,
} from "../../src/target/index.js";
import { inspectNativePoolRouting } from "../../src/cli/native-pool-routing.js";
import { buildHelmUpgradeArgs } from "../../src/cli/deploy.js";
import { execCapture } from "../../src/cli/exec.js";
import type { AdapterState } from "../../src/cli/state.js";

vi.mock("../../src/cli/exec.js");

const plan = compileTarget(
  defineTarget({
    cluster: kubernetesCluster(),
    exposure: gatewayApiExposure({
      className: "eg",
      hosts: [{ hostname: "example.invalid", tls: { enabled: false } }],
      ingressSources: envoyGatewayIngressSources({
        namespace: "envoy-system",
        gatewayClasses: ["eg"],
      }),
    }),
    routing: envoyNativeRouting(),
  }),
  {
    releaseName: "site",
    namespace: "apps",
    buildId: "new",
    imageRegistry: "registry.invalid/app",
    pools: ["web", "api"],
    defaultPool: "web",
    failurePolicy: "closed",
  },
).plan;

function model(name: string, component: string) {
  const labels = {
    "app.kubernetes.io/name": "site",
    "app.kubernetes.io/component": component,
    "app.kubernetes.io/version": "old",
  };
  const podName = `old-${component}`;
  const uid = `${podName}-uid`;
  return {
    service: {
      metadata: {
        name,
        namespace: "apps",
        uid: `${name}-uid`,
        deletionTimestamp: null as string | null,
      },
      spec: { selector: { ...labels }, ports: [{ port: 3000, targetPort: 3000 }] },
    },
    pod: {
      metadata: { name: podName, uid, labels: { ...labels } },
      status: {
        podIPs: [{ ip: component === "web" ? "10.0.0.1" : "10.0.0.2" }],
        conditions: [{ type: "Ready", status: "True" }],
      },
    },
    slice: {
      metadata: {
        labels: { "kubernetes.io/service-name": name },
        ownerReferences: [{ kind: "Service", uid: `${name}-uid` }],
      },
      ports: [{ port: 3000 }],
      endpoints: [
        {
          addresses: [component === "web" ? "10.0.0.1" : "10.0.0.2"],
          conditions: { ready: true, terminating: false },
          targetRef: { kind: "Pod", name: podName, uid },
        },
      ],
    },
  };
}

let origin: ReturnType<typeof model>;
let api: ReturnType<typeof model>;
let state: AdapterState;
function inspect(overrides: Partial<Parameters<typeof inspectNativePoolRouting>[0]> = {}) {
  return inspectNativePoolRouting({
    plan,
    state,
    previousBuildId: "old",
    pools: ["web", "api"],
    defaultPool: "web",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  origin = model("site-origin", "web");
  api = model("site-api", "api");
  state = {
    buildId: "old",
    previousBuildId: null,
    poolTopologies: { old: ["api", "web"] },
    defaultPools: { old: "web" },
  };
  vi.mocked(execCapture).mockImplementation(async (cmd, args) => {
    expect(cmd).toBe("kubectl");
    expect(args.slice(-4)).toEqual(["-n", "apps", "-o", "json"]);
    const fixture =
      args.includes("site-api") ||
      args.some((arg) => arg.includes("=api") || arg.endsWith("=site-api"))
        ? api
        : origin;
    const value =
      args[1] === "service"
        ? fixture.service
        : {
            items: [args[1] === "pods" ? fixture.pod : fixture.slice],
          };
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
  });
});

describe("native owning-pool enablement", () => {
  it("requires existing ready Services for the same committed pool topology", async () => {
    expect(await inspect()).toEqual({
      enabled: true,
      reason: expect.stringContaining("ready stable"),
    });
    expect(execCapture).toHaveBeenCalledTimes(6);
  });

  it.each(["first", "unknown", "stale", "added", "removed", "default", "dry-run"])(
    "uses origin routing without cluster reads for %s predecessor evidence",
    async (scenario) => {
      const overrides: Partial<Parameters<typeof inspectNativePoolRouting>[0]> = {};
      if (scenario === "first") overrides.previousBuildId = null;
      if (scenario === "unknown") overrides.state = null;
      if (scenario === "stale") state.buildId = "different-active-build";
      if (scenario === "added") state.poolTopologies = { old: ["web"] };
      if (scenario === "removed") state.poolTopologies = { old: ["web", "api", "removed"] };
      if (scenario === "default") state.defaultPools = { old: "api" };
      if (scenario === "dry-run") overrides.dryRun = true;
      expect((await inspect(overrides)).enabled).toBe(false);
      expect(execCapture).not.toHaveBeenCalled();
    },
  );

  it("does not infer predecessor topology from an incoming build", async () => {
    delete state.poolTopologies;
    expect((await inspect()).enabled).toBe(false);
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("falls back when a stable Service cannot be read", async () => {
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "not found" });
    expect(await inspect()).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("could not verify"),
    });
  });

  it.each([
    [
      "terminating Service",
      () => {
        api.service.metadata.deletionTimestamp = "2026-09-18T15:00:00Z";
      },
    ],
    [
      "previous version mismatch",
      () => {
        api.service.spec.selector["app.kubernetes.io/version"] = "stale";
      },
    ],
    [
      "fallback selector after rollback",
      () => {
        api.service.spec.selector["app.kubernetes.io/component"] = "web";
      },
    ],
    [
      "empty endpoints",
      () => {
        api.slice.endpoints = [];
      },
    ],
    [
      "unready endpoint",
      () => {
        api.slice.endpoints[0]!.conditions.ready = false;
      },
    ],
    [
      "terminating endpoint",
      () => {
        api.slice.endpoints[0]!.conditions.terminating = true;
      },
    ],
    [
      "wrong endpoint Service",
      () => {
        api.slice.metadata.labels["kubernetes.io/service-name"] = "other";
      },
    ],
    [
      "stale Service owner",
      () => {
        api.slice.metadata.ownerReferences[0]!.uid = "deleted-service";
      },
    ],
    [
      "wrong endpoint port",
      () => {
        api.slice.ports[0]!.port = 8080;
      },
    ],
    [
      "wrong target port",
      () => {
        api.service.spec.ports[0]!.targetPort = 8080;
      },
    ],
    [
      "stale endpoint pod",
      () => {
        api.slice.endpoints[0]!.targetRef.uid = "deleted-pod";
      },
    ],
    [
      "wrong endpoint address",
      () => {
        api.slice.endpoints[0]!.addresses = ["10.0.0.99"];
      },
    ],
    [
      "unready pod",
      () => {
        api.pod.status.conditions[0]!.status = "False";
      },
    ],
    [
      "wrong pod build",
      () => {
        api.pod.metadata.labels["app.kubernetes.io/version"] = "new";
      },
    ],
  ] as const)("retains origin routing for %s", async (_name, change) => {
    change();
    expect((await inspect()).enabled).toBe(false);
  });

  it("explicitly clears a prior Helm enablement on every ineligible deploy", () => {
    const options = {
      releaseName: "site",
      chartPath: "/chart",
      buildId: "new",
      registry: "registry.invalid/app",
      previousBuildId: "old",
    };
    expect(buildHelmUpgradeArgs(options)).toContain("nativePoolRouting=false");
    expect(buildHelmUpgradeArgs({ ...options, nativePoolRouting: false })).toContain(
      "nativePoolRouting=false",
    );
    expect(buildHelmUpgradeArgs({ ...options, nativePoolRouting: true })).toContain(
      "nativePoolRouting=true",
    );
  });
});
