import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoutingServer } from "../../src/routing-service/server.js";
import type { ProcessingResponse } from "../../src/routing-service/ext-proc-types.js";

describe("createRoutingServer", () => {
  let server: ReturnType<typeof createRoutingServer> | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("creates a gRPC server that can start and stop", async () => {
    const handler = vi.fn().mockResolvedValue({
      requestHeaders: {
        response: { headerMutation: { setHeaders: [] }, status: "CONTINUE" },
      },
    } as ProcessingResponse);

    server = createRoutingServer({ handler, port: 0 });
    const address = await server.start();
    expect(address.port).toBeGreaterThan(0);
    await server.stop();
    server = null;
  });
});
