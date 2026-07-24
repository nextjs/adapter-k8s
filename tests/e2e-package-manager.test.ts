import { describe, expect, it } from "vitest";
import { packageManagerFamily, prepareFixturePackage } from "../scripts/e2e-package-manager.mjs";

describe("E2E fixture package-manager selection", () => {
  it("honors an explicit npm declaration even when pnpm is installed", () => {
    expect(packageManagerFamily({ packageManager: "npm@10.9.2" })).toBe("npm");
  });

  it("keeps the fast pnpm path for explicit and undeclared pnpm fixtures", () => {
    expect(packageManagerFamily({ packageManager: "pnpm@10.0.0" })).toBe("pnpm");
    expect(packageManagerFamily({})).toBe("auto");
  });

  it("rewrites only the harness post-build suffix for an npm fixture", () => {
    const prepared = prepareFixturePackage(
      {
        packageManager: "npm@10.9.2",
        scripts: { build: "next build && pnpm post-build" },
        devDependencies: { typescript: "latest" },
      },
      "@next-community/adapter-k8s",
      "/tmp/adapter.tgz",
    );

    expect(prepared.scripts.build).toBe("next build && npm run post-build");
    expect(prepared.devDependencies.typescript).toBe("^6");
    expect(prepared.dependencies["@next-community/adapter-k8s"]).toBe("file:/tmp/adapter.tgz");
  });
});
