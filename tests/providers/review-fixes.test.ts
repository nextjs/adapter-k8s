// Fixes from the second external review of the multi-provider work. Each case is the failure the
// review described, written so it fails if the fix regresses.
import { describe, it, expect } from "vitest";
import { resolveProvider } from "../../src/providers/index.js";
import { renderNetworkPolicies } from "../../src/emit/templates/network-policy.js";
import { buildDockerCommands } from "../../src/cli/deploy.js";
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../../src/types.js";

const pools = new Map<string, PoolDefinition>([
  ["default", { name: "default", outputs: [], config: { routes: ["appPages"] } }],
]);
const routingManifest = { pathnames: ["/"], buildId: "b1" } as unknown as RoutingManifest;
const HOSTS = [{ hostname: "app.example.com", tls: { enabled: false } }];
const genericCfg = (over: Record<string, unknown> = {}) =>
  ({
    pools: {},
    provider: { generic: { gateway: { hosts: HOSTS }, ...over } },
  }) as unknown as K8sAdapterConfig;

describe("review fix 1: the proxy selector needs BOTH halves of the gateway identity", () => {
  it("includes owning-gateway-namespace, not just the name", () => {
    // With the name alone, a Gateway of the SAME name in another application namespace produces
    // proxy pods whose labels match in the shared proxy namespace — so another tenant's proxies
    // would be admitted to this release's ext_proc port. Reachability to that port IS the
    // internal dispatch secret, so this is a cross-tenant credential exposure, not a tidiness
    // issue.
    const cfg = genericCfg();
    const sel = resolveProvider(cfg).strictIngressSources({
      releaseName: "my-app",
      pools,
      routingManifest,
      config: cfg,
    }).podSelectors[0]!;
    expect(sel.labels["gateway.envoyproxy.io/owning-gateway-name"]).toBe("my-app-gateway");
    expect(sel.labels["gateway.envoyproxy.io/owning-gateway-namespace"]).toBeTruthy();
  });

  it("ALSO admits the class-owned MERGED proxy (EnvoyProxy mergeGateways)", () => {
    // Under `mergeGateways` — how Phase-2 lanes share one data plane — proxy pods are owned by
    // the GatewayCLASS, not any Gateway: their labels are `owning-gatewayclass: <class>` and
    // NEITHER owning-gateway-name nor -namespace exists. The per-gateway peer therefore never
    // matches, and on a netpol-enforcing CNI (k3s enforces even on flannel) every proxy→pool
    // and proxy→ext_proc connection is REFUSED: measured on k3d, pods Ready while Envoy got
    // connection-refused, gate timed out at 503 for 180s, fail-closed 500s after.
    // TENANCY TRADE, stated: the merged proxy is shared by every release on the class, so
    // admitting it admits the shared data plane to this release's ext_proc port. That is
    // inherent to choosing merged gateways — per-release proxy identity does not exist there.
    const cfg = genericCfg();
    const sels = resolveProvider(cfg).strictIngressSources({
      releaseName: "my-app",
      pools,
      routingManifest,
      config: cfg,
    }).podSelectors;
    const merged = sels.find(
      (s) => s.labels["gateway.envoyproxy.io/owning-gatewayclass"] !== undefined,
    );
    expect(merged).toBeDefined();
    expect(merged!.labels["gateway.envoyproxy.io/owning-gatewayclass"]).toBe("eg");
    expect(merged!.labels["app.kubernetes.io/name"]).toBe("envoy");
    // The per-gateway peer must REMAIN — single-gateway (non-merged) deployments still rely
    // on it, and peers are OR'd.
    expect(
      sels.some((s) => s.labels["gateway.envoyproxy.io/owning-gateway-name"] === "my-app-gateway"),
    ).toBe(true);
  });

  it("renders the namespace label through helm, since only helm knows the release namespace", () => {
    const cfg = genericCfg();
    const np = renderNetworkPolicies({
      releaseName: "my-app",
      poolNames: ["default"],
      ingressSources: resolveProvider(cfg).strictIngressSources({
        releaseName: "my-app",
        pools,
        routingManifest,
        config: cfg,
      }),
    });
    expect(np).toContain("gateway.envoyproxy.io/owning-gateway-namespace");
    expect(np).toContain("{{ .Release.Namespace }}");
  });

  it("still rejects an arbitrary helm expression in a selector value", () => {
    // The release-namespace expression is a single-item allowlist. Anything looser would let a
    // config-supplied value inject template directives into the rendered chart.
    expect(() =>
      renderNetworkPolicies({
        releaseName: "my-app",
        poolNames: ["default"],
        ingressSources: {
          cidrs: [],
          podSelectors: [{ labels: { evil: "{{ .Values.anything }}" } }],
        },
      }),
    ).toThrow(/Invalid ingress selector label/);
  });
});

describe("review fix 8: registry auth must not assume Google", () => {
  const base = {
    pools: ["ssr"],
    buildId: "b1",
    outputDir: "out",
    containerStrategy: "traced-assets" as const,
  };

  it("does NOT run gcloud for a non-Google registry", () => {
    // A Harbor/ECR/ACR deploy with working credentials died before building anything, because
    // every push plan began with `gcloud auth configure-docker` — on a machine with no reason to
    // have gcloud at all.
    const cmds = buildDockerCommands({ ...base, registry: "harbor.example.com/ns" });
    expect(cmds.some((c) => c.command === "gcloud")).toBe(false);
    expect(cmds.some((c) => c.args.includes("build"))).toBe(true);
  });

  it("still configures auth for Artifact Registry", () => {
    const cmds = buildDockerCommands({
      ...base,
      registry: "us-central1-docker.pkg.dev/proj/repo",
    });
    expect(cmds.some((c) => c.command === "gcloud" && c.args.includes("configure-docker"))).toBe(
      true,
    );
  });

  it("still configures auth for gcr.io", () => {
    const cmds = buildDockerCommands({ ...base, registry: "gcr.io/proj" });
    expect(cmds.some((c) => c.command === "gcloud")).toBe(true);
  });
});
