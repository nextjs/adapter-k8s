// tests/classify.test.ts
import { describe, it, expect } from "vitest";
import { classifyIntoPools } from "../src/classify.js";
import { mockAppPage, mockAppRoute, mockOutputs } from "./helpers/mock-outputs.js";
import type { K8sAdapterConfig } from "../src/types.js";

describe("classifyIntoPools", () => {
  it("classifies by output type name", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" }), mockAppPage({ pathname: "/about" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        ssr: { routes: ["appPages"] },
        api: { routes: ["appRoutes"] },
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("ssr")!.outputs).toHaveLength(2);
    expect(pools.get("api")!.outputs).toHaveLength(1);
  });

  it("classifies by glob pattern", () => {
    const outputs = mockOutputs({
      appRoutes: [
        mockAppRoute({ pathname: "/api/hello" }),
        mockAppRoute({ pathname: "/api/heavy/report" }),
      ],
    });
    const config: K8sAdapterConfig = {
      pools: {
        heavy: { routes: ["/api/heavy/*"] },
        api: { routes: ["/api/hello"] }, // Use direct route to assign hello
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("heavy")!.outputs).toHaveLength(1);
    expect(pools.get("heavy")!.outputs[0]!.pathname).toBe("/api/heavy/report");
    // /api/hello was not matched by heavy, so it falls to api pool
    expect(pools.get("api")!.outputs).toHaveLength(1);
    expect(pools.get("api")!.outputs[0]!.pathname).toBe("/api/hello");
  });

  it("uses first-match-wins — earlier pool takes precedence", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/dashboard" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        special: { routes: ["/dashboard"] },
        ssr: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("special")!.outputs).toHaveLength(1);
    expect(pools.get("ssr")!.outputs).toHaveLength(0);
  });

  it("handles single catch-all pool", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/" })],
      appRoutes: [mockAppRoute({ pathname: "/api/hello" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        default: { routes: ["appPages", "appRoutes", "pagesApi"] },
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("default")!.outputs).toHaveLength(2);
  });

  it("throws error if an output is not assigned to any pool", () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: "/unmatched" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        api: { routes: ["appRoutes"] },
      },
      provider: { gke: {} },
    };
    expect(() => classifyIntoPools(outputs, config)).toThrow(
      /Output "\/app\/unmatched" is not assigned to any pool/,
    );
  });
});
