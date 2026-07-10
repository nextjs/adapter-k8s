import { describe, expect, it } from "vitest";
import { createK8sAdapter } from "../src/adapter.js";
import type { K8sAdapterConfig } from "../src/types.js";

const validConfig: K8sAdapterConfig = {
  pools: { ssr: { routes: ["appPages"] } },
  provider: {
    gke: {
      gateway: {
        type: "gateway-api",
        className: "gke",
        hosts: [{ hostname: "example.com", tls: { enabled: true } }],
      },
    },
  },
};

describe("createK8sAdapter config normalization", () => {
  it("validates a directly supplied config", async () => {
    const adapter = createK8sAdapter({
      ...validConfig,
      pools: { Bad_Name: { routes: ["appPages"] } },
    });

    await expect(adapter.modifyConfig!({} as any, {} as any)).rejects.toThrow(/pool name/);
  });

  it("applies defaults to a directly supplied config", async () => {
    const adapter = createK8sAdapter(validConfig);
    await adapter.modifyConfig!({} as any, {} as any);

    expect((adapter as any).config.containerStrategy).toBe("traced-assets");
    expect((adapter as any).config.provider.gke.cdn.enabled).toBe(false);
  });
});
