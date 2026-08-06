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
    expect(() => validateConfig(config)).toThrow(/target is required/);
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

  it.each([0, -1, 1.5, 86_401, Number.NaN])(
    "rejects invalid pool response-head timeout %s",
    (timeout) => {
      const config = {
        pools: { ssr: { routes: ["appPages"], timeout } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke",
              hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
            },
          },
        },
      } as K8sAdapterConfig;
      expect(() => validateConfig(config)).toThrow(/timeout must be an integer from 1 to 86400/);
    },
  );

  it("throws error if hosts is missing or empty", () => {
    const config = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: { gke: { gateway: { hosts: [] } } },
    } as any;
    expect(() => validateConfig(config)).toThrow(/at least one host/);
  });

  it("rejects a hostname that would break out of the quoted YAML scalar", () => {
    // The hostname is interpolated into gateway.ts as "- "<hostname>"" — a quote+newline
    // injects arbitrary chart YAML. validateConfig must reject it at the boundary.
    const makeConfig = (hostname: string): K8sAdapterConfig =>
      ({
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke",
              hosts: [{ hostname, tls: { enabled: true } }],
            },
          },
        },
      }) as K8sAdapterConfig;

    expect(() => validateConfig(makeConfig('app.example.com"\nmalicious: true'))).toThrow(
      /Invalid hostname/,
    );
    expect(() => validateConfig(makeConfig("app.example.com;rm -rf /"))).toThrow(
      /Invalid hostname/,
    );
    expect(() => validateConfig(makeConfig("UPPER.example.com"))).toThrow(/Invalid hostname/);
    expect(() => validateConfig(makeConfig("app.example.com"))).not.toThrow();
    expect(() => validateConfig(makeConfig("localhost"))).not.toThrow();
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

  it("caps the pool count at 15 (HTTPRoute 16-rule budget)", () => {
    // Gateway API caps an HTTPRoute at 16 rules; the generated route reserves one
    // header rule per pool plus the catch-all. 16 pools can't be routed at all.
    const pools = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`pool-${i}`, { routes: ["appPages"] }]),
    );
    const config: K8sAdapterConfig = {
      pools,
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
    expect(() => validateConfig(config)).toThrow(/16 pools.*maximum is 15|maximum is 15/);
    expect(() => validateConfig(config)).toThrow(/16 rules/);

    // 15 pools is the (degenerate but valid) ceiling.
    const atCap: K8sAdapterConfig = {
      ...config,
      pools: Object.fromEntries(
        Array.from({ length: 15 }, (_, i) => [`pool-${i}`, { routes: ["appPages"] }]),
      ),
    };
    expect(() => validateConfig(atCap)).not.toThrow();
  });

  it("caps pool-name length at 40 chars (K8s 63-char resource-name budget)", () => {
    const makeConfig = (name: string): K8sAdapterConfig => ({
      pools: { [name]: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
    });
    expect(() => validateConfig(makeConfig("a".repeat(41)))).toThrow(/too long.*max 40/);
    expect(() => validateConfig(makeConfig("a".repeat(40)))).not.toThrow();
  });

  it("reserves the pool name 'routing-service' for the routing tier", () => {
    // The chart renders the routing tier's Service as `${release}-routing-service` —
    // exactly the active-Service name a pool called "routing-service" would get: two
    // same-named Services in one chart. Mirrors the deploy-time reservation
    // (assertSafePoolName in cli/deploy.ts).
    const config: K8sAdapterConfig = {
      pools: { "routing-service": { routes: ["appPages"] } },
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
    expect(() => validateConfig(config)).toThrow(/reserved for the routing tier/);
  });

  it("reserves the pool name 'origin' for the portable entrypoint", () => {
    const config: K8sAdapterConfig = {
      pools: { origin: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: false } }],
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow(/reserved for the portable entrypoint/);
  });

  it("requires defaultPool to name a configured pool", () => {
    const config: K8sAdapterConfig = {
      pools: { web: { routes: ["appPages"] } },
      defaultPool: "missing",
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: false } }],
          },
        },
      },
    };
    expect(() => validateConfig(config)).toThrow(/defaultPool.*configured pool/);
  });

  it("enforces the combined release+pool budget when the release name is known", () => {
    // sanitizeK8sName truncates `${release}-${pool}-${buildId}` to 63 (59 for the
    // -hpa/-hcp variants): at least 8 build-id chars must survive, i.e.
    // release + 1 + pool + 1 + 8 <= 59. Two individually-valid 40-char names
    // together truncate the build id away ENTIRELY — guaranteed blue/green collision.
    const makeConfig = (name: string): K8sAdapterConfig => ({
      pools: { [name]: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
    });

    // 40 + 1 + 40 + 1 = 82 — no build-id chars survive.
    expect(() => validateConfig(makeConfig("p".repeat(40)), "r".repeat(40))).toThrow(
      /leave too little room for the build id/,
    );
    // The error states the arithmetic.
    expect(() => validateConfig(makeConfig("p".repeat(40)), "r".repeat(40))).toThrow(
      /40 \+ 1 \+ 40 \+ 1 = 82/,
    );
    // Exactly at the boundary: 40 + 1 + 9 + 1 + 8 = 59 — allowed.
    expect(() => validateConfig(makeConfig("p".repeat(9)), "r".repeat(40))).not.toThrow();
    // One char over the boundary — rejected.
    expect(() => validateConfig(makeConfig("p".repeat(10)), "r".repeat(40))).toThrow(
      /leave too little room for the build id/,
    );
    // Normal-length combinations pass.
    expect(() => validateConfig(makeConfig("ssr"), "my-app")).not.toThrow();
    // Without a release name (not derivable yet) only the per-field caps apply.
    expect(() => validateConfig(makeConfig("p".repeat(40)))).not.toThrow();
  });
});

describe("cache config", () => {
  const withCache = (cache: K8sAdapterConfig["cache"]): K8sAdapterConfig =>
    ({
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
      cache,
    }) as K8sAdapterConfig;

  it("accepts cache.enabled with managed provisioning (no url)", () => {
    expect(() => validateConfig(withCache({ enabled: true }))).not.toThrow();
  });

  it("accepts a valid BYO redis:// or rediss:// url", () => {
    expect(() =>
      validateConfig(withCache({ enabled: true, url: "redis://cache:6379" })),
    ).not.toThrow();
    expect(() =>
      validateConfig(withCache({ enabled: true, url: "rediss://cache:6380" })),
    ).not.toThrow();
  });

  it("rejects a non-redis cache.url", () => {
    expect(() => validateConfig(withCache({ enabled: true, url: "http://cache:6379" }))).toThrow(
      /redis:\/\//,
    );
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

// ---------------------------------------------------------------------------
// N60 (SECURITY) — resource/scaling validation. Nothing under `pools.*.resources`,
// `pools.*.scaling`, `routingService.resources` or `routingService.scaling` was validated:
// not here, not in the templates. VERIFIED by rendering — a memoryLimit of
// `512Mi"\n      hostNetwork: true\n      …` produced VALID YAML with `hostNetwork: true`
// on the pod, which per N19 (network-policy.ts) voids BOTH NetworkPolicy postures.
// ---------------------------------------------------------------------------
describe("N60: resource and scaling validation", () => {
  const withPool = (pool: Record<string, unknown>): K8sAdapterConfig =>
    ({
      pools: { ssr: { routes: ["appPages"], ...pool } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
    }) as K8sAdapterConfig;

  const withRoutingService = (routingService: Record<string, unknown>): K8sAdapterConfig =>
    ({ ...withPool({}), routingService }) as K8sAdapterConfig;

  const POD_SPEC_INJECTION =
    '512Mi"\n      hostNetwork: true\n      shareProcessNamespace: true\n      _pad: "';

  it("rejects the verified pod-spec injection payload in every pool resource field", () => {
    for (const field of ["cpu", "memory", "cpuLimit", "memoryLimit"]) {
      expect(() =>
        validateConfig(withPool({ resources: { [field]: POD_SPEC_INJECTION } })),
      ).toThrow(/Invalid Kubernetes quantity/);
      expect(() =>
        validateConfig(withPool({ resources: { [field]: POD_SPEC_INJECTION } })),
      ).toThrow(new RegExp(`pool "ssr"\\.resources\\.${field}`));
    }
  });

  it("rejects the UNQUOTED routing-tier sink payload (needed no quote-escaping at all)", () => {
    expect(() =>
      validateConfig(
        withRoutingService({ resources: { cpu: "250m\n              INJECTED: yes" } }),
      ),
    ).toThrow(/routingService\.resources\.cpu/);
    for (const field of ["memory", "cpuLimit", "memoryLimit"]) {
      expect(() =>
        validateConfig(withRoutingService({ resources: { [field]: POD_SPEC_INJECTION } })),
      ).toThrow(/Invalid Kubernetes quantity/);
    }
  });

  it("accepts the quantity forms an operator actually writes", () => {
    expect(() =>
      validateConfig(
        withPool({
          resources: { cpu: "250m", memory: "512Mi", cpuLimit: "2", memoryLimit: "1Gi" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      validateConfig(withRoutingService({ resources: { cpu: "1.5", memory: "2Gi" } })),
    ).not.toThrow();
  });

  it("requires integer scaling values (the HPA sink is a bare YAML scalar)", () => {
    expect(() =>
      validateConfig(withPool({ scaling: { min: "1\n  INJECTED: yes", max: 3, targetCPU: 80 } })),
    ).toThrow(/pool "ssr"\.scaling\.min/);
    expect(() =>
      validateConfig(withPool({ scaling: { min: 1.5, max: 3, targetCPU: 80 } })),
    ).toThrow(/scaling\.min/);
    expect(() => validateConfig(withPool({ scaling: { min: 1, max: 3, targetCPU: 0 } }))).toThrow(
      /scaling\.targetCPU/,
    );
    // >100 is VALID: averageUtilization is a percentage of REQUESTED cpu, so a pool that
    // requests 250m and runs happily at 500m targets 200. The old cap rejected working configs.
    expect(() =>
      validateConfig(withRoutingService({ scaling: { min: 2, max: 10, targetCPU: 150 } })),
    ).not.toThrow();
    expect(() =>
      validateConfig(withRoutingService({ scaling: { min: 2, max: 10, targetCPU: 10_001 } })),
    ).toThrow(/routingService\.scaling\.targetCPU/);
    expect(() =>
      validateConfig(withPool({ scaling: { min: 2, max: 10, targetCPU: 70 } })),
    ).not.toThrow();
  });

  it("rejects scaling.min > scaling.max (the API server would reject the HPA)", () => {
    expect(() => validateConfig(withPool({ scaling: { min: 5, max: 2, targetCPU: 80 } }))).toThrow(
      /scaling\.min \(5\) is greater than pool "ssr"\.scaling\.max \(2\)/,
    );
    expect(() =>
      validateConfig(withRoutingService({ scaling: { min: 9, max: 3, targetCPU: 70 } })),
    ).toThrow(/routingService\.scaling\.min \(9\) is greater than/);
  });
});

// ---------------------------------------------------------------------------
// N61 — pool-name charset.
// ---------------------------------------------------------------------------
describe("N61: pool-name charset", () => {
  const withName = (name: string): K8sAdapterConfig =>
    ({
      pools: { [name]: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke",
            hosts: [{ hostname: "test.com", tls: { enabled: true } }],
          },
        },
      },
    }) as K8sAdapterConfig;

  it("rejects a leading or trailing hyphen (invalid K8s label value)", () => {
    // The old /^[a-z0-9-]+$/ accepted both.
    expect(() => validateConfig(withName("-api"))).toThrow(/Invalid pool name/);
    expect(() => validateConfig(withName("api-"))).toThrow(/Invalid pool name/);
  });

  it("still accepts YAML-boolean-looking names — the TEMPLATES quote them (N61)", () => {
    // Tightening the charset to exclude "on"/"no"/"true" would break real configs for no
    // reason; the fix is that every interpolation of a pool name is now quoted, which is
    // what the apiserver decode path actually requires.
    for (const n of ["on", "no", "y", "off", "true"]) {
      expect(() => validateConfig(withName(n))).not.toThrow();
    }
  });

  it("keeps the informative 40-char budget message ahead of the charset check", () => {
    expect(() => validateConfig(withName("a".repeat(41)))).toThrow(/too long.*max 40/);
  });
});
