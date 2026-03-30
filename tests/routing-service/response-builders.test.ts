import { describe, it, expect } from "vitest";
import {
  buildImmediateResponse,
  buildHeaderMutationResponse,
} from "../../src/routing-service/response-builders.js";

describe("buildImmediateResponse", () => {
  it("builds a redirect response", () => {
    const resp = buildImmediateResponse(301, { location: "https://example.com/new" });
    expect(resp.immediateResponse).toBeDefined();
    expect(resp.immediateResponse!.status!.code).toBe(301);
    const locationHeader = resp.immediateResponse!.headers!.setHeaders!.find(
      (h) => h.header.key === "location",
    );
    expect(locationHeader).toBeDefined();
    expect(locationHeader!.header.value).toBe("https://example.com/new");
  });

  it("builds a response with body", () => {
    const resp = buildImmediateResponse(
      502,
      { "content-type": "text/plain" },
      "External rewrites not supported",
    );
    expect(resp.immediateResponse!.status!.code).toBe(502);
    expect(resp.immediateResponse!.body).toBe("External rewrites not supported");
  });
});

describe("buildHeaderMutationResponse", () => {
  it("builds header mutations", () => {
    const resp = buildHeaderMutationResponse([
      { key: "x-upstream-pool", value: "ssr" },
      { key: "x-output-id", value: "/app/page" },
    ]);
    expect(resp.requestHeaders).toBeDefined();
    const setHeaders = resp.requestHeaders!.response!.headerMutation!.setHeaders!;
    expect(setHeaders).toHaveLength(2);
    expect(setHeaders[0]!.header.key).toBe("x-upstream-pool");
    expect(setHeaders[0]!.header.value).toBe("ssr");
  });

  it("returns empty response for no mutations", () => {
    const resp = buildHeaderMutationResponse([]);
    expect(resp.requestHeaders!.response!.headerMutation!.setHeaders).toHaveLength(0);
  });
});
