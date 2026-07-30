// ADAPTER_K8S_CONFIG selects a config VARIANT so one project can target several clusters at
// once. Swapping a single adapter.config.mjs / infrastructure.json between targets makes the
// file that decides WHERE a deploy goes into mutable global state — and forgetting to restore it
// is silent until something deploys somewhere unintended (a GKE deploy pushing to a Scaleway
// registry, say).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  infrastructurePath,
  outputDirName,
  stateFileName,
} from "../src/cli/infrastructure-validation.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "variant-"));
  mkdirSync(path.join(dir, ".k8s-adapter"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe("infrastructurePath — config variants", () => {
  it("uses the plain file when no variant is requested", () => {
    const dir = project({ ".k8s-adapter/infrastructure.json": "{}" });
    delete process.env.ADAPTER_K8S_CONFIG;
    expect(infrastructurePath(dir)).toBe(path.join(dir, ".k8s-adapter", "infrastructure.json"));
  });

  it("prefers the variant file when one is requested and present", () => {
    const dir = project({
      ".k8s-adapter/infrastructure.json": "{}",
      ".k8s-adapter/infrastructure.scaleway.json": "{}",
    });
    process.env.ADAPTER_K8S_CONFIG = "scaleway";
    expect(infrastructurePath(dir)).toBe(
      path.join(dir, ".k8s-adapter", "infrastructure.scaleway.json"),
    );
  });

  it("REFUSES a requested variant whose infrastructure file is missing", () => {
    // This previously fell back to the default infrastructure.json — which cross-wires targets:
    // the adapter loads adapter.config.<variant>.mjs while the CLI reads the DEFAULT
    // infrastructure, so a half-present variant builds one cluster's config against another
    // cluster's registry and release identity, with nothing in the output saying so. A requested
    // variant must be complete.
    const dir = project({ ".k8s-adapter/infrastructure.json": "{}" });
    process.env.ADAPTER_K8S_CONFIG = "nosuch";
    expect(() => infrastructurePath(dir)).toThrow(/nosuch/);
  });

  it("rejects a variant that is a PATH rather than a name", () => {
    // The value is interpolated into a filename; a path would let it escape .k8s-adapter and read
    // arbitrary JSON as deployment configuration. Throwing beats silently ignoring: the operator
    // asked for something specific and must not get a different target instead.
    const dir = project({ ".k8s-adapter/infrastructure.json": "{}" });
    process.env.ADAPTER_K8S_CONFIG = "../../etc/passwd";
    expect(() => infrastructurePath(dir)).toThrow(/not a valid variant name/);
  });

  it("scopes the state file to the variant", () => {
    // Sharing state across targets lets a higher generation from one cluster supply another
    // cluster's activeBuildId, repointing its Services at a build that never existed there.
    process.env.ADAPTER_K8S_CONFIG = "scaleway";
    expect(stateFileName()).toBe("state.scaleway.json");
    delete process.env.ADAPTER_K8S_CONFIG;
    expect(stateFileName()).toBe("state.json");
  });
});

describe("outputDirName — the chart is only valid for its target", () => {
  it("scopes the output directory to the variant", () => {
    // The routing tier's registry is baked into its Deployment at BUILD time, so a shared output
    // directory meant `--skip-build` deployed whichever target built last. MEASURED: a Scaleway
    // deploy reused a GKE chart and its routing pods went ImagePullBackOff with a 403 against
    // Artifact Registry, after helm had already applied.
    process.env.ADAPTER_K8S_CONFIG = "scaleway";
    expect(outputDirName()).toBe("output.scaleway");
    delete process.env.ADAPTER_K8S_CONFIG;
    expect(outputDirName()).toBe("output");
  });

  it("ignores a path-shaped variant for the output directory too", () => {
    process.env.ADAPTER_K8S_CONFIG = "../evil";
    expect(outputDirName()).toBe("output");
  });
});
