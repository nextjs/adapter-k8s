// tests/emit/dockerignore.test.ts
import { describe, it, expect } from "vitest";
import { generateDockerignore } from "../../src/emit/dockerignore.js";

describe("generateDockerignore", () => {
  it("excludes .env and all .env.* variants so secrets never reach image layers", () => {
    const result = generateDockerignore();
    expect(result).toContain("**/.env\n");
    expect(result).toContain("**/.env.*");
  });

  it("does NOT re-include .env.example — no env file variant belongs in an image", () => {
    const result = generateDockerignore();
    // The broad `**/.env.*` exclusion must stand with no negation punching a hole in it:
    // example files can drift into real-looking credentials and would be baked into
    // pushed image layers.
    expect(result).not.toContain("!**/.env.example");
    expect(result).not.toMatch(/^!/m);
  });
});
