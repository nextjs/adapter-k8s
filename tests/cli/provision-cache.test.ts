import { describe, expect, it } from "vitest";
import {
  buildDeleteMemorystoreCommand,
  cacheInstanceName,
} from "../../src/cli/provision-cache.js";
import { buildReleaseScopedGcpResources } from "../../src/cli/destroy.js";

describe("cacheInstanceName", () => {
  it("derives a deterministic per-release instance name", () => {
    expect(cacheInstanceName("test-app")).toBe("test-app-cache");
  });
});

describe("buildDeleteMemorystoreCommand", () => {
  it("builds a region-scoped delete", () => {
    const cmd = buildDeleteMemorystoreCommand("test-app", "us-central1", "proj");
    expect(cmd.command).toBe("gcloud");
    expect(cmd.args).toEqual([
      "redis",
      "instances",
      "delete",
      "test-app-cache",
      "--region",
      "us-central1",
      "--project",
      "proj",
      "--quiet",
    ]);
  });
});

describe("buildReleaseScopedGcpResources (cache teardown)", () => {
  it("omits the Memorystore delete when no region is given", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "proj");
    expect(resources.some((r) => r.desc.includes("Memorystore"))).toBe(false);
  });

  it("includes a region-scoped Memorystore delete when region is given", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "proj", "us-central1");
    const cache = resources.find((r) => r.desc.includes("Memorystore"));
    expect(cache).toBeDefined();
    expect(cache?.args).toContain("my-app-cache");
    expect(cache?.args).toContain("--region=us-central1");
  });
});
