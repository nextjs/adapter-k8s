// tests/cli/scaffold.test.ts
import { describe, it, expect } from "vitest";
import { generateAdapterConfig } from "../../src/cli/scaffold.js";

describe("generateAdapterConfig", () => {
  it("generates a valid adapter.config.ts template", () => {
    const result = generateAdapterConfig({
      projectId: "my-project",
      region: "us-central1",
      hosts: ["app.example.com"],
      bucket: "my-project-nextjs-static",
      registry: "us-central1-docker.pkg.dev/my-project/nextjs",
    });

    expect(result).toContain("import { createK8sAdapter }");
    expect(result).toContain("app.example.com");
    expect(result).toContain("my-project-nextjs-static");
    expect(result).toContain("appPages");
    expect(result).toContain("appRoutes");
    expect(result).toContain("export default createK8sAdapter");
  });
});
