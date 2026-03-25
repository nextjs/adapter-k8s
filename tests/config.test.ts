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
            host: "app.example.com",
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow(
      /pool "ssr" must have at least one route/,
    );
  });

  it("throws error if gke host is missing", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: { gke: { gateway: { host: "" } } } as any,
    };
    expect(() => validateConfig(config)).toThrow(
      /provider.gke.gateway.host is required/,
    );
  });

  it("passes for a valid config", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            host: "app.example.com",
          },
        },
      },
    };
    expect(() => validateConfig(config)).not.toThrow();
  });
});

describe("applyDefaults", () => {
  it("applies default containerStrategy and provider settings", () => {
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: {
        gke: { gateway: { type: "gateway-api", className: "gke", host: "test.com" } },
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
