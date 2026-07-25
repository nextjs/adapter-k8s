// tests/cli/scaffold.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { generateAdapterConfig } from "../../src/cli/scaffold.js";

const VALID = {
  projectId: "my-project",
  region: "us-central1",
  hosts: ["app.example.com"],
  bucket: "my-project-nextjs-static",
  registry: "us-central1-docker.pkg.dev/my-project/nextjs",
};

// Import the generated config for real (with a stubbed adapter entry point) — a
// toContain-only assertion can't catch unbalanced braces, bad quoting, or a broken
// hosts join, all of which would surface only when the operator's next build loads
// adapter.config.mjs.
async function importGeneratedConfig(options: typeof VALID): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-scaffold-test-"));
  try {
    writeFileSync(
      path.join(dir, "stub.mjs"),
      "export function createK8sAdapter(config) { return { __config: config }; }\n",
    );
    const rewritten = generateAdapterConfig(options).replace(
      "from '@next-community/adapter-k8s'",
      "from './stub.mjs'",
    );
    expect(rewritten).not.toContain("@next-community/adapter-k8s");
    const configPath = path.join(dir, "adapter.config.mjs");
    writeFileSync(configPath, rewritten);
    const mod = (await import(pathToFileURL(configPath).href)) as {
      default: { __config: Record<string, unknown> };
    };
    return mod.default.__config;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("generateAdapterConfig", () => {
  it("generates a valid adapter.config.ts template", () => {
    const result = generateAdapterConfig(VALID);

    expect(result).toContain("import { createK8sAdapter }");
    expect(result).toContain("app.example.com");
    expect(result).toContain("my-project-nextjs-static");
    expect(result).toContain("appPages");
    expect(result).toContain("appRoutes");
    expect(result).toContain("export default createK8sAdapter");
  });

  it("generates a parseable, importable config with the expected shape", async () => {
    const config = (await importGeneratedConfig(VALID)) as {
      pools: { default: { routes: string[] } };
      containerStrategy: string;
      provider: {
        gke: {
          cdn: { enabled: boolean; bucket: string };
          gateway: { type: string; hosts: { hostname: string }[] };
        };
      };
    };

    expect(config.pools.default.routes).toEqual(["appPages", "appRoutes", "pagesApi"]);
    expect(config.containerStrategy).toBe("traced-assets");
    expect(config.provider.gke.cdn).toEqual({ enabled: true, bucket: VALID.bucket });
    expect(config.provider.gke.gateway.type).toBe("gateway-api");
    expect(config.provider.gke.gateway.hosts).toEqual([
      { hostname: "app.example.com", tls: { enabled: true, managedCert: true } },
    ]);
  });

  it("parses correctly with multiple hosts (the hosts join is generated code)", async () => {
    const config = (await importGeneratedConfig({
      ...VALID,
      hosts: ["app.example.com", "api.example.com"],
    })) as { provider: { gke: { gateway: { hosts: { hostname: string }[] } } } };

    expect(config.provider.gke.gateway.hosts.map((h) => h.hostname)).toEqual([
      "app.example.com",
      "api.example.com",
    ]);
  });
});
