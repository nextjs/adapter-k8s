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

  it("treats Next.js dynamic route segments literally inside route selectors", () => {
    const outputs = mockOutputs({
      appPages: [
        mockAppPage({ pathname: "/blog/[slug]" }),
        mockAppPage({ pathname: "/blog/s" }),
        mockAppPage({ pathname: "/[locale]/lab/[view]" }),
        mockAppPage({ pathname: "/l/lab/report" }),
        mockAppPage({ pathname: "/docs/[...slug]" }),
        mockAppPage({ pathname: "/docs/." }),
        mockAppPage({ pathname: "/shop/[[...slug]]" }),
      ],
    });
    const config: K8sAdapterConfig = {
      pools: {
        dynamic: {
          routes: ["/blog/[slug]", "/[locale]/lab/**", "/docs/[...slug]", "/shop/[[...slug]]"],
        },
        static: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };

    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("dynamic")!.outputs.map((output) => output.pathname)).toEqual([
      "/blog/[slug]",
      "/[locale]/lab/[view]",
      "/docs/[...slug]",
      "/shop/[[...slug]]",
    ]);
    expect(pools.get("static")!.outputs.map((output) => output.pathname)).toEqual([
      "/blog/s",
      "/l/lab/report",
      "/docs/.",
    ]);
  });

  it("treats interception-prefixed dynamic segments literally without claiming static decoys", () => {
    const outputs = mockOutputs({
      appPages: [
        // Real App Router output shape from fixtures/interception.
        mockAppPage({ pathname: "/[locale]/(.)[username]/p/[id]" }),
        mockAppPage({ pathname: "/[locale]/(.)u/p/[id]" }),
        mockAppPage({ pathname: "/feed/(..)[...slug]" }),
        mockAppPage({ pathname: "/feed/(..)s" }),
        mockAppPage({ pathname: "/root/(...)[[...slug]]" }),
        mockAppPage({ pathname: "/root/(...)s" }),
        mockAppPage({ pathname: "/nested/(..)(..)[slug]" }),
        mockAppPage({ pathname: "/nested/(..)(..)s" }),
      ],
    });
    const config: K8sAdapterConfig = {
      pools: {
        intercepted: {
          routes: [
            "/[locale]/(.)[username]/p/[id]",
            "/feed/(..)[...slug]",
            "/root/(...)[[...slug]]",
            "/nested/(..)(..)[slug]",
          ],
        },
        static: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };

    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("intercepted")!.outputs.map((output) => output.pathname)).toEqual([
      "/[locale]/(.)[username]/p/[id]",
      "/feed/(..)[...slug]",
      "/root/(...)[[...slug]]",
      "/nested/(..)(..)[slug]",
    ]);
    expect(pools.get("static")!.outputs.map((output) => output.pathname)).toEqual([
      "/[locale]/(.)u/p/[id]",
      "/feed/(..)s",
      "/root/(...)s",
      "/nested/(..)(..)s",
    ]);
  });

  it("keeps minimatch syntax for ordinary static route globs", () => {
    const outputs = mockOutputs({
      appPages: [
        mockAppPage({ pathname: "/reports/2025/weekly" }),
        mockAppPage({ pathname: "/reports/2026/monthly" }),
        mockAppPage({ pathname: "/api/v1/users" }),
        mockAppPage({ pathname: "/api/v3/users" }),
      ],
    });
    const config: K8sAdapterConfig = {
      pools: {
        selected: { routes: ["/reports/{2025,2026}/**", "/api/v[12]/**"] },
        rest: { routes: ["appPages"] },
      },
      provider: { gke: {} },
    };

    const pools = classifyIntoPools(outputs, config);
    expect(pools.get("selected")!.outputs.map((output) => output.pathname)).toEqual([
      "/reports/2025/weekly",
      "/reports/2026/monthly",
      "/api/v1/users",
    ]);
    expect(pools.get("rest")!.outputs.map((output) => output.pathname)).toEqual(["/api/v3/users"]);
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
