// tests/cli/infrastructure-validation.test.ts
//
// S13 (SECURITY). `deploy` and `init` validated the infrastructure.json values that reach a
// subprocess argv; `destroy`, `describe`, `doctor`, `tail` and `rollback` did not. On POSIX
// that is inert (execFile with shell:false), but on Windows `gcloud` resolves to `gcloud.cmd`
// and a `.cmd` shim can re-parse metacharacters — so a poisoned checkout plus an operator
// running one of the READ-ONLY commands was command execution under their GCP credentials.
// Those are exactly the commands you reach for first, and exactly the ones that skipped the
// check `deploy` would have applied to the same file.
import { describe, it, expect } from "vitest";
import { assertSafeInfrastructure } from "../../src/cli/infrastructure-validation.js";

describe("assertSafeInfrastructure", () => {
  it("accepts a well-formed file", () => {
    expect(() =>
      assertSafeInfrastructure({
        projectId: "my-project-123",
        region: "us-central1",
        namespace: "default",
        containerRegistry: "us-central1-docker.pkg.dev/my-project-123/nextjs",
        gcsBucket: "my-project-123-assets",
        cacheRegion: "us-central1",
        clusterName: "my-app-cluster",
      }),
    ).not.toThrow();
  });

  it("tolerates a partial file (these commands degrade rather than fail)", () => {
    expect(() => assertSafeInfrastructure({})).not.toThrow();
    expect(() => assertSafeInfrastructure(null)).not.toThrow();
    expect(() => assertSafeInfrastructure(undefined)).not.toThrow();
  });

  it("rejects shell metacharacters in every argv-bound field", () => {
    const bad = [
      ["projectId", "x&calc"],
      ["region", "us-central1&calc"],
      ["containerRegistry", 'gcr.io/p"&calc'],
      ["gcsBucket", "bucket&calc"],
      ["cacheRegion", "us&calc"],
      ["clusterName", "cluster&calc"],
    ] as const;
    for (const [field, value] of bad) {
      expect(() => assertSafeInfrastructure({ [field]: value })).toThrow();
    }
  });

  it("rejects a value that could be read as a flag or a traversal", () => {
    expect(() => assertSafeInfrastructure({ gcsBucket: "--format=json" })).toThrow();
    expect(() => assertSafeInfrastructure({ clusterName: "../../etc" })).toThrow();
    expect(() => assertSafeInfrastructure({ projectId: "--project" })).toThrow();
  });
});
