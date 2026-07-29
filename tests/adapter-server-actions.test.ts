// Regression tests from the sibling-adapter survey (plans/lessons-from-sibling-adapters.md,
// Tier 1 #1): Server Actions behind a proxy tier.
//
// Next's Server Action CSRF check compares the request `Origin` against the host Next
// believes it is serving. Behind Envoy + Cloud CDN the pool sees the pod/service host, so
// browser POSTs from the public hostname 403 in production while passing in `emulate`.
// Both reference adapters fix this in modifyConfig: aws (adapter.ts:164-197) and bun
// (adapter.ts:457-521) inject the deployment host into `serverActions.allowedOrigins`,
// and aws additionally sets `experimental.trustHostHeader` so Pages `res.revalidate()`
// (router-server-methods) and absolute-URL derivation trust x-forwarded-host.
//
// This adapter already KNOWS the public hostnames — the gateway config declares them — so
// unlike aws there is no first-deploy chicken-and-egg: merge every configured gateway
// hostname, plus an optional ADAPTER_K8S_DEPLOYMENT_HOST override, into allowedOrigins.
import { afterEach, describe, expect, it } from "vitest";
import { createK8sAdapter } from "../src/adapter.js";
import type { K8sAdapterConfig } from "../src/types.js";

function adapterWithHosts(hostnames: string[]) {
  const config: K8sAdapterConfig = {
    pools: { ssr: { routes: ["appPages"] } },
    provider: {
      gke: {
        gateway: {
          type: "gateway-api",
          className: "gke",
          hosts: hostnames.map((hostname) => ({ hostname, tls: { enabled: true } })),
        },
      },
    },
  };
  return createK8sAdapter(config);
}

interface ModifiedConfig {
  experimental?: {
    trustHostHeader?: boolean;
    serverActions?: { allowedOrigins?: string[] };
  };
}

async function modify(
  adapter: ReturnType<typeof createK8sAdapter>,
  nextConfig: Record<string, unknown> = {},
): Promise<ModifiedConfig> {
  return (await adapter.modifyConfig!(nextConfig as any, {} as any)) as ModifiedConfig;
}

afterEach(() => {
  delete process.env.ADAPTER_K8S_DEPLOYMENT_HOST;
});

describe("modifyConfig Server Action origin trust (survey Tier 1 #1)", () => {
  it("does NOT set experimental.trustHostHeader (unneeded here; build-baked, unmeasured benefit)", async () => {
    // trustHostHeader is baked into the BUILD via define-env.ts, so its blast radius is the
    // whole compiled output, not just the api-resolver paths it helps. The res.revalidate()
    // invariant it exists for (adapter-aws sets it) is already satisfied here by the pool's
    // requestMeta.revalidate channel — the full suite passes 3,342/0 without the flag
    // (2026-07-28, canary 63375cd1). Absent a measured need, a build-wide define stays out.
    // (A 2026-07-28 bisect briefly blamed it for middleware-rewrites failures; that was
    // disproven — those were a Next-ref artifact — but the flag remains unjustified.)
    const modified = await modify(adapterWithHosts(["example.com"]));
    expect(modified.experimental?.trustHostHeader).toBeUndefined();
  });

  it("allows Server Action POSTs from every configured gateway hostname", async () => {
    const modified = await modify(adapterWithHosts(["app.example.com", "www.example.com"]));
    expect(modified.experimental?.serverActions?.allowedOrigins).toEqual(
      expect.arrayContaining(["app.example.com", "www.example.com"]),
    );
  });

  it("merges with user-configured allowedOrigins instead of replacing them, without duplicates", async () => {
    const modified = await modify(adapterWithHosts(["app.example.com"]), {
      experimental: {
        serverActions: { allowedOrigins: ["preview.example.com", "app.example.com"] },
      },
    });
    const origins = modified.experimental?.serverActions?.allowedOrigins ?? [];
    expect(origins).toEqual(expect.arrayContaining(["preview.example.com", "app.example.com"]));
    expect(origins.filter((o) => o === "app.example.com")).toHaveLength(1);
  });

  it("normalizes ADAPTER_K8S_DEPLOYMENT_HOST (scheme and path stripped, lowercased) into allowedOrigins", async () => {
    process.env.ADAPTER_K8S_DEPLOYMENT_HOST = "https://Staging.Example.com/some/path";
    const modified = await modify(adapterWithHosts(["app.example.com"]));
    expect(modified.experimental?.serverActions?.allowedOrigins).toEqual(
      expect.arrayContaining(["staging.example.com", "app.example.com"]),
    );
  });
});
