import { describe, it, expect } from "vitest";
import { generateExtensionChain, determineFailureMode } from "../src/extension-chain.js";
import { mockOutputs } from "./helpers/mock-outputs.js";

describe("determineFailureMode", () => {
  it("returns false (fail closed) when middleware exists", () => {
    const outputs = mockOutputs({
      middleware: {
        id: "middleware",
        filePath: "/dist/server/middleware.js",
        pathname: "/middleware",
        type: 8 as any,
        config: {},
      } as any,
    });
    expect(determineFailureMode(outputs)).toBe(false);
  });

  it("returns true (fail open) when no middleware", () => {
    const outputs = mockOutputs();
    expect(determineFailureMode(outputs)).toBe(true);
  });

  it("honors an explicit failureMode override", () => {
    const withMw = mockOutputs({ middleware: { id: "m", type: 8 } as any });
    // "auto" mirrors the middleware heuristic
    expect(determineFailureMode(withMw, "auto")).toBe(false);
    // explicit overrides win regardless of middleware
    expect(determineFailureMode(withMw, "open")).toBe(true);
    expect(determineFailureMode(mockOutputs(), "closed")).toBe(false);
  });
});

describe("generateExtensionChain", () => {
  it("generates valid extension chain JSON", () => {
    const chain = generateExtensionChain({
      celExpression: "!(request.path.startsWith('/_next/static/'))",
      releaseName: "my-app",
      namespace: "default",
      projectId: "my-project",
      region: "us-central1",
      timeout: "5s",
      failureModeAllow: false,
    });
    const parsed = JSON.parse(chain);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("nextjs-routing");
    expect(parsed[0].matchCondition.celExpression).toContain("/_next/static/");
    expect(parsed[0].extensions[0].name).toBe("routing-service");
    expect(parsed[0].extensions[0].timeout).toBe("5s");
    expect(parsed[0].extensions[0].supportedEvents).toEqual(["REQUEST_HEADERS"]);
  });

  it("includes failureModeAllow in output", () => {
    const chain = generateExtensionChain({
      celExpression: "true",
      releaseName: "my-app",
      namespace: "default",
      projectId: "my-project",
      region: "us-central1",
      timeout: "5s",
      failureModeAllow: true,
    });
    const parsed = JSON.parse(chain);
    expect(parsed[0].extensions[0].failOpen).toBe(true);
  });
});
