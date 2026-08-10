// tests/cli/envoy-gateway-preflight.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import { execCapture } from "../../src/cli/exec.js";
import {
  ENVOY_GATEWAY_VERIFIED_RANGE,
  detectEnvoyGatewayVersion,
  evaluateEnvoyGatewayPreflight,
  isWithinVerifiedRange,
  parseEnvoyGatewayImageVersion,
  planRequiresEnvoyGateway,
  type EnvoyGatewayPlanSlice,
} from "../../src/cli/envoy-gateway-preflight.js";

function plan(apiVersions: string[]): EnvoyGatewayPlanSlice {
  return {
    requirements: {
      kubernetes: { resources: apiVersions.map((apiVersion) => ({ apiVersion })) },
    },
  };
}

const ENVOY_PLAN = plan(["gateway.networking.k8s.io/v1", "gateway.envoyproxy.io/v1alpha1"]);

/** Stub kubectl: controller-image listing + ListenerSet CRD existence. */
function stubKubectl(options: { images?: string; crd?: string; fail?: boolean }): void {
  vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
    if (options.fail) return { exitCode: 1, stdout: "", stderr: "forbidden" };
    if (args.includes("crd")) return { exitCode: 0, stdout: options.crd ?? "", stderr: "" };
    if (args.includes("deployments") || args.includes("deployment")) {
      return { exitCode: 0, stdout: options.images ?? "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }) as never);
}

beforeEach(() => {
  vi.mocked(execCapture).mockReset();
});

describe("parseEnvoyGatewayImageVersion", () => {
  it("parses the controller image with and without the v prefix", () => {
    expect(parseEnvoyGatewayImageVersion("docker.io/envoyproxy/gateway:v1.8.3")).toEqual({
      major: 1,
      minor: 8,
      patch: 3,
    });
    expect(parseEnvoyGatewayImageVersion("envoyproxy/gateway:1.5.4")).toEqual({
      major: 1,
      minor: 5,
      patch: 4,
    });
  });

  it("parses a digest-pinned tag", () => {
    expect(
      parseEnvoyGatewayImageVersion(`docker.io/envoyproxy/gateway:v1.8.3@sha256:${"a".repeat(64)}`),
    ).toEqual({ major: 1, minor: 8, patch: 3 });
  });

  it("never mistakes the data-plane envoy image for the controller", () => {
    // The verification run's cluster ran both images side by side; matching the
    // proxy would report the wrong component's version.
    expect(
      parseEnvoyGatewayImageVersion("docker.io/envoyproxy/envoy:distroless-v1.38.3"),
    ).toBeNull();
  });

  it("returns null for non-semver tags rather than guessing", () => {
    expect(parseEnvoyGatewayImageVersion("envoyproxy/gateway:latest")).toBeNull();
    expect(parseEnvoyGatewayImageVersion("envoyproxy/gateway:v1.9.0-rc.1")).toBeNull();
    expect(parseEnvoyGatewayImageVersion("envoyproxy/gateway")).toBeNull();
    expect(parseEnvoyGatewayImageVersion("")).toBeNull();
    // A lookalike repository must not match the anchored path.
    expect(parseEnvoyGatewayImageVersion("evil/not-envoyproxy/gateway:v1.8.3")).toBeNull();
  });
});

describe("isWithinVerifiedRange", () => {
  it.each([
    [{ major: 1, minor: 5, patch: 4 }, true], // floor, verified live
    [{ major: 1, minor: 5, patch: 5 }, true],
    [{ major: 1, minor: 6, patch: 0 }, true], // interpolated, inside range
    [{ major: 1, minor: 8, patch: 3 }, true], // verified live
    [{ major: 1, minor: 8, patch: 99 }, true],
    [{ major: 1, minor: 5, patch: 3 }, false], // below floor
    [{ major: 1, minor: 4, patch: 9 }, false],
    [{ major: 1, minor: 9, patch: 0 }, false], // above ceiling
    [{ major: 2, minor: 0, patch: 0 }, false],
    [{ major: 0, minor: 9, patch: 9 }, false],
  ])("%o -> %s (range %s)", (version, expected) => {
    expect(isWithinVerifiedRange(version)).toBe(expected);
  });

  it("documents the range constant the messages cite", () => {
    expect(ENVOY_GATEWAY_VERIFIED_RANGE).toBe(">=1.5.4 <1.9");
  });
});

describe("planRequiresEnvoyGateway", () => {
  it("is true only when the plan requires gateway.envoyproxy.io APIs", () => {
    expect(planRequiresEnvoyGateway(ENVOY_PLAN)).toBe(true);
    expect(planRequiresEnvoyGateway(plan(["gateway.networking.k8s.io/v1", "v1"]))).toBe(false);
    expect(planRequiresEnvoyGateway(plan([]))).toBe(false);
  });
});

describe("detectEnvoyGatewayVersion", () => {
  it("reads the controller version from the labelled Deployment's image", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v1.8.3\n" });
    await expect(detectEnvoyGatewayVersion()).resolves.toEqual({
      version: { major: 1, minor: 8, patch: 3 },
      image: "docker.io/envoyproxy/gateway:v1.8.3",
    });
  });

  it("returns null when no controller image is detectable (RBAC failure, no install)", async () => {
    stubKubectl({ fail: true });
    await expect(detectEnvoyGatewayVersion()).resolves.toBeNull();
    stubKubectl({ images: "" });
    await expect(detectEnvoyGatewayVersion()).resolves.toBeNull();
  });

  it("skips unparseable images and picks the controller among containers", async () => {
    stubKubectl({
      images: "docker.io/envoyproxy/ratelimit:master\ndocker.io/envoyproxy/gateway:v1.5.5\n",
    });
    await expect(detectEnvoyGatewayVersion()).resolves.toEqual({
      version: { major: 1, minor: 5, patch: 5 },
      image: "docker.io/envoyproxy/gateway:v1.5.5",
    });
  });
});

describe("evaluateEnvoyGatewayPreflight", () => {
  it("is silent for plans that do not use Envoy Gateway", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v0.6.0\n" });
    await expect(evaluateEnvoyGatewayPreflight(plan(["networking.gke.io/v1"]))).resolves.toEqual(
      [],
    );
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("is silent when no controller version is detectable (absent = no warn)", async () => {
    stubKubectl({ images: "envoyproxy/gateway:latest\n" });
    await expect(evaluateEnvoyGatewayPreflight(ENVOY_PLAN)).resolves.toEqual([]);
  });

  it("passes inside the verified range and, below 1.8, never probes the ListenerSet CRD", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v1.5.4\n" });
    const checks = await evaluateEnvoyGatewayPreflight(ENVOY_PLAN);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "Envoy Gateway version", status: "pass" });
    expect(checks[0]!.message).toContain(">=1.5.4 <1.9");
    const crdCalls = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => (args as string[]).includes("crd"));
    expect(crdCalls).toHaveLength(0);
  });

  it("WARNs (never fails) outside the verified range", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v1.9.0\n", crd: "" });
    const checks = await evaluateEnvoyGatewayPreflight(ENVOY_PLAN);
    const version = checks.find((c) => c.name === "Envoy Gateway version");
    expect(version).toMatchObject({ status: "warn" });
    expect(version!.message).toContain("outside the live-verified range >=1.5.4 <1.9");
    expect(version!.message).toContain("unverified, not known-broken");
    expect(checks.every((c) => c.status !== "fail")).toBe(true);
  });

  it("WARNs below the 1.5.4 floor", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v1.4.2\n" });
    const checks = await evaluateEnvoyGatewayPreflight(ENVOY_PLAN);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "Envoy Gateway version", status: "warn" });
  });

  it("adds a ListenerSet CRD pass line on 1.8+ when the CRD exists", async () => {
    stubKubectl({
      images: "docker.io/envoyproxy/gateway:v1.8.3\n",
      crd: "customresourcedefinition.apiextensions.k8s.io/listenersets.gateway.networking.k8s.io\n",
    });
    const checks = await evaluateEnvoyGatewayPreflight(ENVOY_PLAN);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toMatchObject({ name: "ListenerSet CRD", status: "pass" });
  });

  it("WARNs on 1.8+ when the ListenerSet CRD is absent, citing the helm CRD trap and its fix", async () => {
    stubKubectl({ images: "docker.io/envoyproxy/gateway:v1.8.3\n", crd: "" });
    const checks = await evaluateEnvoyGatewayPreflight(ENVOY_PLAN);
    const crd = checks.find((c) => c.name === "ListenerSet CRD");
    expect(crd).toMatchObject({ status: "warn" });
    expect(crd!.message).toContain("helm never upgrades the chart's crds/ subchart");
    expect(crd!.fix).toContain("kubectl apply --server-side --force-conflicts");
    expect(crd!.fix).toContain("--version v1.8.3");
  });
});
