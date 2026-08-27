import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build input provenance", () => {
  it("pins every remote Buf input to an immutable commit", () => {
    const config = readFileSync(new URL("../buf.gen.yaml", import.meta.url), "utf8");
    const remoteInputs = [...config.matchAll(/^\s*- module: (buf\.build\/\S+)$/gm)].map(
      (match) => match[1]!,
    );
    expect(remoteInputs).toHaveLength(3);
    for (const input of remoteInputs) {
      expect(input).toMatch(/^buf\.build\/[a-z0-9-]+\/[a-z0-9-]+:[0-9a-f]{32}$/);
    }
    expect(config).not.toContain(":main");
  });
});
