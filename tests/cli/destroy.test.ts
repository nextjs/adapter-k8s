// tests/cli/destroy.test.ts
import { describe, it, expect } from "vitest";
import { buildReleaseScopedGcpResources, isAlreadyGoneError } from "../../src/cli/destroy.js";

describe("isAlreadyGoneError", () => {
  it("treats genuine not-found errors as already deleted", () => {
    expect(isAlreadyGoneError('Error from server (NotFound): configmaps "x" not found')).toBe(true);
    expect(isAlreadyGoneError("Error: release: not found")).toBe(true);
    expect(isAlreadyGoneError("The bucket you tried to delete does not exist.")).toBe(true);
    expect(isAlreadyGoneError("ERROR: (gcloud) Service account ... was not found.")).toBe(true);
    expect(isAlreadyGoneError("HTTPError 404: Not Found")).toBe(true);
  });

  it("does NOT treat auth/permission/network failures as already deleted", () => {
    expect(
      isAlreadyGoneError("ERROR: (gcloud) PERMISSION_DENIED: caller does not have permission"),
    ).toBe(false);
    expect(isAlreadyGoneError("Error: could not connect to the server: dial tcp timeout")).toBe(
      false,
    );
    expect(isAlreadyGoneError("Error: forbidden: user cannot delete resource")).toBe(false);
    expect(isAlreadyGoneError("Unauthorized")).toBe(false);
    expect(isAlreadyGoneError("")).toBe(false);
  });
});

describe("buildReleaseScopedGcpResources", () => {
  it("deletes the health check created by init", () => {
    const resources = buildReleaseScopedGcpResources("my-app", "my-project");
    const healthCheck = resources.find((resource) => resource.desc.includes("health check"));

    expect(healthCheck?.args).toContain("my-app-routing-hc");
    expect(healthCheck?.args).not.toContain("my-app-routing-tcp");
  });
});
