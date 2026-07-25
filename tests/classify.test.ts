// tests/classify.test.ts
import { describe, it, expect, vi } from "vitest";
import { classifyIntoPools } from "../src/classify.js";
import {
  mockAppPage,
  mockAppRoute,
  mockOutputs,
  mockPage,
  mockPagesApi,
} from "./helpers/mock-outputs.js";
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

  it("classifies pages and pagesApi outputs by type name", () => {
    // REGRESSION: OUTPUT_TYPE_KEYS covers pages/pagesApi but they were untested —
    // a dropped key would silently route Pages Router apps into "not assigned" or
    // glob-only classification.
    const outputs = mockOutputs({
      pages: [mockPage({ pathname: "/" }), mockPage({ pathname: "/about" })],
      pagesApi: [mockPagesApi({ pathname: "/api/hello" })],
      appPages: [mockAppPage({ pathname: "/app-only" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        pages: { routes: ["pages", "pagesApi"] },
        app: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(
      pools
        .get("pages")!
        .outputs.map((o) => o.pathname)
        .sort(),
    ).toEqual(["/", "/about", "/api/hello"]);
    expect(pools.get("app")!.outputs).toHaveLength(1);
  });

  it("glob patterns match across all four output types", () => {
    const outputs = mockOutputs({
      pages: [mockPage({ pathname: "/docs/guide" })],
      pagesApi: [mockPagesApi({ pathname: "/api/v1/users" })],
      appRoutes: [mockAppRoute({ pathname: "/api/v2/users" })],
      appPages: [mockAppPage({ pathname: "/" })],
    });
    const config: K8sAdapterConfig = {
      pools: {
        api: { routes: ["/api/**"] },
        docs: { routes: ["/docs/**"] },
        rest: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(
      pools
        .get("api")!
        .outputs.map((o) => o.pathname)
        .sort(),
    ).toEqual(["/api/v1/users", "/api/v2/users"]);
    expect(pools.get("docs")!.outputs[0]!.pathname).toBe("/docs/guide");
  });

  it("warns loudly about a zero-output pool, naming the unmatched route patterns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outputs = mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] });
    const config: K8sAdapterConfig = {
      pools: {
        ssr: { routes: ["appPages"] },
        ghost: { routes: ["/dashbord/*", "pagesApi"] }, // typo + a type with no outputs
      },
      provider: { gke: {} },
    };
    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("ghost")!.outputs).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain('Pool "ghost" matched no outputs');
    expect(msg).toContain('"/dashbord/*"');
    expect(msg).toContain('"pagesApi"');
    warn.mockRestore();
  });

  it("does not warn for a pool with matched outputs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const outputs = mockOutputs({ appPages: [mockAppPage({ pathname: "/" })] });
    const config: K8sAdapterConfig = {
      pools: { ssr: { routes: ["appPages"] } },
      provider: { gke: {} },
    };
    classifyIntoPools(outputs, config);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
