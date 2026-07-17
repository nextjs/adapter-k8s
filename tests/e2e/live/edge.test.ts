import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_EDGE_BASE_URL?.replace(/\/$/, "");

describe.skipIf(!BASE)("deployed Edge invocation fixture", () => {
  it("reconstructs optional catch-all params", async () => {
    const response = await fetch(`${BASE}/edge-catchall/one/two/three`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: ["one", "two", "three"] });
  });

  it("reconstructs dynamic params after a rewrite", async () => {
    const response = await fetch(`${BASE}/edge-rewrite/rewritten/param`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: ["rewritten", "param"] });
  });
});
