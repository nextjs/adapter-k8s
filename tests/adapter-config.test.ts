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

describe("buildId validation at build time (H2)", () => {
  // The finalized buildId flows into helm --set values, K8s names/labels, image tags and
  // chart YAML — an unsafe one (e.g. a git branch from a custom generateBuildId) must
  // fail the build at the source, before any artifact is emitted.
  it.each([
    ['feature/foo";rm', "YAML/shell breakout"],
    ["foo,bar=baz", "helm --set metacharacters"],
    ["foo\\bar", "helm --set escape char"],
    ["line1\nline2", "newline"],
  ])("rejects an unsafe buildId (%s)", async (buildId) => {
    const adapter = createK8sAdapter(validConfig);
    await expect(
      adapter.onBuildComplete!({
        buildId,
        routing: {},
        outputs: {},
        projectDir: "/nonexistent",
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).rejects.toThrow(/Invalid buildId/);
  });

  it("mentions the generateBuildId contract in the error", async () => {
    const adapter = createK8sAdapter(validConfig);
    await expect(
      adapter.onBuildComplete!({
        buildId: "bad,id",
        routing: {},
        outputs: {},
        projectDir: "/nonexistent",
        config: {},
        nextVersion: "16.2.0",
      } as any),
    ).rejects.toThrow(/generateBuildId/);
  });
});
