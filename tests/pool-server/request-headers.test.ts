import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { requestHeaders } from "../../src/pool-server/index.js";

describe("application request headers", () => {
  it("keeps decoded dispatch metadata out of the Web Headers view", () => {
    const req = {
      headers: {
        "x-output-id": "/🎉",
        "x-invoke-query": JSON.stringify({ label: "日本語" }),
        "x-public": "visible",
      },
    } as unknown as IncomingMessage;

    expect(() => requestHeaders(req)).not.toThrow();
    const headers = requestHeaders(req);
    expect(headers.get("x-public")).toBe("visible");
    expect(headers.has("x-output-id")).toBe(false);
    expect(headers.has("x-invoke-query")).toBe(false);
  });
});
