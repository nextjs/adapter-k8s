// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { validateConfig, applyDefaults } from "../src/config.js";
import type { K8sAdapterConfig } from "../src/types.js";

describe("validateConfig", () => {
  it("throws error if pools is missing", () => {
    const config = { provider: { gke: {} } } as any;
    expect(() => validateConfig(config)).toThrow(/pools is required/);
  });

  it("throws error if pools is empty", () => {
    const config = { pools: {}, provider: { gke: {} } } as any;
    expect(() => validateConfig(config)).toThrow(/at least one pool must be defined/);
  });

  it("throws error if provider is missing", () => {
    const config = { pools: { ssr: { routes: ["appPages"] } } } as any;
    expect(() => validateConfig(config)).toThrow(/provider is required/);
  });

  it("throws error if a pool has no routes", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: [] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow(/pool "ssr" must have at least one route/);
  });

  it("throws error if hosts is missing or empty", () => {
    const config = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: { gke: { gateway: { hosts: [] } } },
    } as any;
    expect(() => validateConfig(config)).toThrow(/provider.gke.gateway.hosts is required/);
  });

  it("allows wildcard hostnames (Certificate Manager supports them)", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            hosts: [{ hostname: "*.example.com", tls: { enabled: true, managedCert: true } }],
          },
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("passes for a valid config with multiple hosts", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            hosts: [
              { hostname: "app.example.com", tls: { enabled: true, managedCert: true } },
              { hostname: "api.example.com", tls: { enabled: true, managedCert: true } },
            ],
          },
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });

  it.each([
    ["cache", { cache: { enabled: true, provider: "valkey" } }],
    ["image optimizer", { imageOptimizer: { enabled: true, mode: "sidecar" } }],
    ["skew protection", { skewProtection: { enabled: true, duration: "5m" } }],
    ["Wasm routing", { routeExtension: { mode: "wasm" } }],
  ])("rejects the unimplemented %s option", (_name, extra) => {
    const config = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
      ...extra,
    } as K8sAdapterConfig;

    expect(() => validateConfig(config)).toThrow(/not implemented/);
  });
});

describe("applyDefaults", () => {
  it("applies default containerStrategy and provider settings", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
    };
    const result = applyDefaults(config);
    expect(result.containerStrategy).toBe("traced-assets");
    expect(result.provider.gke.cdn?.enabled).toBe(false);
    expect(result.cache?.enabled).toBe(false);
    expect(result.skewProtection?.enabled).toBe(false);
    expect(result.routeExtension?.mode).toBe("auto");
  });
});
