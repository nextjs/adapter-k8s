// tests/emit/dockerignore.test.ts
import { describe, it, expect } from "vitest";
import { generateDockerignore } from "../../src/emit/dockerignore.js";

describe("generateDockerignore", () => {
  it("excludes .env and all .env.* variants so secrets never reach image layers", () => {
    const result = generateDockerignore();
    expect(result).toContain("**/.env\n");
    expect(result).toContain("**/.env.*");
  });

  it("re-includes .env.example so non-secret sample files survive", () => {
    const result = generateDockerignore();
    expect(result).toContain("!**/.env.example");
    // The negation must come after the broad .env.* exclusion to take effect.
    const lines = result.split("\n");
    expect(lines.indexOf("!**/.env.example")).toBeGreaterThan(lines.indexOf("**/.env.*"));
  });
});
