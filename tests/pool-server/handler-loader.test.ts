// tests/pool-server/handler-loader.test.ts
import { describe, it, expect, vi } from "vitest";
import {
  resolveRouteHandlerExport,
  createHandlerLoader,
} from "../../src/pool-server/handler-loader.js";

describe("resolveRouteHandlerExport", () => {
  it("resolves module.handler", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ handler: fn });
    expect(handler).toBe(fn);
  });

  it("resolves module.default when it is a function", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: fn });
    expect(handler).toBe(fn);
  });

  it("resolves module.default.handler", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: { handler: fn } });
    expect(handler).toBe(fn);
  });

  it("resolves module.default.fetch", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ default: { fetch: fn } });
    expect(handler).toBe(fn);
  });

  it("resolves module.fetch", () => {
    const fn = () => {};
    const handler = resolveRouteHandlerExport({ fetch: fn });
    expect(handler).toBe(fn);
  });

  it("throws when no handler found", () => {
    expect(() => resolveRouteHandlerExport({ foo: "bar" })).toThrow(/handler/i);
  });
});

describe("createHandlerLoader", () => {
  it("loads and caches handler modules", async () => {
    const mockHandler = () => {};
    const loadModule = vi.fn().mockResolvedValue({ handler: mockHandler });

    const manifest = {
      buildId: "test123",
      poolName: "ssr",
      outputs: {
        "/": {
          id: "/app/page",
          filePath: "/app/.next/server/app/page.js",
          pathname: "/",
          type: "APP_PAGE",
        },
      },
    } as any;

    const loader = createHandlerLoader(manifest, loadModule);

    const handler1 = await loader.load("/");
    expect(handler1).toBe(mockHandler);
    expect(loadModule).toHaveBeenCalledTimes(1);

    // Second call uses cache
    const handler2 = await loader.load("/");
    expect(handler2).toBe(mockHandler);
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it("throws for unknown output ID", async () => {
    const manifest = { buildId: "test123", poolName: "ssr", outputs: {} } as any;
    const loader = createHandlerLoader(manifest, vi.fn());
    await expect(loader.load("unknown")).rejects.toThrow(/unknown/i);
  });
});
