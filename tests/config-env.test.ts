// Runtime environment variables for deployed apps.
//
// Found by the cluster topology 2026-07-29: upstream's middleware-general declares
// `env: { ANOTHER_MIDDLEWARE_TEST: 'asdf2', ... }` in nextTestSetup and both
// "allows to access env variables" cases failed with `undefined` on GKE. The pod template
// emitted a fixed five-variable env block and there was no config surface at all — so a
// deployed app had NO path to runtime environment, since adapter.ts:1763 also (deliberately)
// refuses to stage `.env` files into any image. That comment already named the intended
// mechanism — "Env is supplied to running containers via Kubernetes (ConfigMap/Secret +
// envFrom)" — it was simply never built.
//
// Verified before designing this: the build DID have the variables (the harness forwards
// nextTestSetup's `env` to the deploy script) and the edge middleware still read `undefined`,
// so Next does not inline them into the edge bundle — the sandbox reads process.env live.
// Pod env is therefore the correct and sufficient mechanism.
import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/config.js";
import type { K8sAdapterConfig } from "../src/types.js";

const base = (over: Partial<K8sAdapterConfig> = {}): K8sAdapterConfig =>
  ({
    pools: { default: { routes: ["appPages"] } },
    provider: {
      gke: {
        gateway: {
          type: "gateway-api",
          className: "gke-l7-global-external-managed",
          hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
        },
      },
    },
    ...over,
  }) as K8sAdapterConfig;

describe("env config validation", () => {
  it("accepts literal, secretKeyRef and configMapKeyRef values", () => {
    expect(() =>
      validateConfig(
        base({
          env: {
            API_URL: "https://api.example.com",
            API_KEY: { secret: "app-secrets", key: "api-key" },
            FLAGS: { configMap: "app-config", key: "flags" },
          },
          envFrom: [{ secret: "app-secrets" }, { configMap: "app-config", prefix: "CFG_" }],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts per-pool env", () => {
    expect(() =>
      validateConfig(
        base({
          env: { SHARED: "1" },
          pools: { default: { routes: ["appPages"], env: { POOL_SPECIFIC: "2" } } },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects NEXT_PUBLIC_* because it is inlined at build time and would silently do nothing", () => {
    expect(() => validateConfig(base({ env: { NEXT_PUBLIC_API: "https://x" } }))).toThrow(
      /NEXT_PUBLIC_/,
    );
  });

  it.each([
    "NODE_ENV",
    "NEXT_BUILD_ID",
    "POOL_NAME",
    "RELEASE_NAME",
    "INTERNAL_HEADER_SECRET",
    "VALKEY_URL",
  ])("rejects the reserved name %s", (name) => {
    // Shadowing NEXT_BUILD_ID in particular would corrupt blue/green: the pool derives its
    // identity, and its Valkey cache namespace, from it.
    expect(() => validateConfig(base({ env: { [name]: "x" } }))).toThrow(/reserved/i);
  });

  it("rejects a reserved name set on a POOL, not just at the top level", () => {
    expect(() =>
      validateConfig(
        base({ pools: { default: { routes: ["appPages"], env: { POOL_NAME: "x" } } } }),
      ),
    ).toThrow(/reserved/i);
  });

  it.each(["lower-case", "1LEADING_DIGIT", "HAS SPACE", "HAS=EQUALS", ""])(
    "rejects the invalid variable name %j",
    (name) => {
      expect(() => validateConfig(base({ env: { [name]: "x" } }))).toThrow(/environment variable/i);
    },
  );

  it("rejects a reference with no key", () => {
    expect(() =>
      validateConfig(base({ env: { API_KEY: { secret: "app-secrets" } as never } })),
    ).toThrow(/key/i);
  });

  it("rejects a non-string literal, which YAML would render as something unintended", () => {
    // A number or boolean in JS becomes an unquoted YAML scalar; Kubernetes requires env
    // values to be strings and rejects the manifest at apply time.
    expect(() => validateConfig(base({ env: { PORT_NUMBER: 8080 as never } }))).toThrow(/string/i);
  });
});
