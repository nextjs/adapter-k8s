import { describe, expect, it, vi } from "vitest";
import {
  detectNodeMiddlewareEntrypoint,
  invokeNodeMiddleware,
} from "../../src/next-runtime/middleware-entrypoint.js";

const request = () => ({
  url: new URL("https://app.example.com/docs/about"),
  headers: new Headers({ cookie: "session=ok" }),
  method: "GET",
  requestBody: new ReadableStream<Uint8Array>(),
  nextConfig: { basePath: "/docs" },
  logBackgroundError: vi.fn(),
});

describe("Next 16.3 Node middleware entrypoints", () => {
  it("selects the generated handler from the installed 16.3 artifact shape", async () => {
    // Dynamic import() of Next 16.3's CJS middleware artifact exposes the CJS namespace as
    // `default`, with the documented handler and backwards-compatible adapter nested inside.
    // This is the measured shape already used by the tier-parity fixture.
    const generated = vi.fn(
      async () => new Response(null, { headers: { "x-middleware-next": "1" } }),
    );
    const backwardsCompatibleAdapter = vi.fn();
    const module = { default: { default: backwardsCompatibleAdapter, handler: generated } };

    expect(detectNodeMiddlewareEntrypoint(module)).toMatchObject({ kind: "generated" });

    const result = await invokeNodeMiddleware(module, request());

    expect(result).toMatchObject({ kind: "response", entrypoint: "generated" });
    expect(generated).toHaveBeenCalledTimes(1);
    expect(backwardsCompatibleAdapter).not.toHaveBeenCalled();
  });

  it("returns an explicit unsupported result for an unknown module shape", async () => {
    const result = await invokeNodeMiddleware({ default: { routeModule: {} } }, request());

    expect(result.kind).toBe("unsupported");
    if (result.kind === "unsupported") {
      expect(result.error.message).toMatch(/no supported Next\.js middleware entrypoint/i);
    }
  });

  it("does not fall through to another callable when the selected entrypoint is malformed", async () => {
    const generated = vi.fn(async () => undefined);
    const legacy = vi.fn(async () => ({
      response: new Response(null, { headers: { "x-middleware-next": "1" } }),
    }));
    const module = { default: { handler: generated, default: legacy } };

    const result = await invokeNodeMiddleware(module, request());

    expect(result.kind).toBe("invalid-result");
    expect(generated).toHaveBeenCalledTimes(1);
    expect(legacy).not.toHaveBeenCalled();
  });

  it("normalizes a direct userland void return to NextResponse.next()", async () => {
    const direct = vi.fn(async () => undefined);

    const result = await invokeNodeMiddleware({ proxy: direct }, request());

    expect(result.kind).toBe("response");
    if (result.kind === "response") {
      expect(result.response.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
