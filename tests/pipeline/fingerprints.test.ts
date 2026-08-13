// tests/pipeline/fingerprints.test.ts
//
// Direct unit coverage for the pipeline-safe build-identity guards (deploy inventory
// A2 + B2) extracted into src/pipeline/fingerprints.ts for GitOps PR1. Both runDeploy
// and runEmit call these functions, so the cases pinned here hold for the imperative
// and the GitOps path at once — that shared-module property is the reason the file
// exists (plans/gitops-deployment-strategies.md principle 2). The incident-derived
// cases (N14 deploymentId, N62 self-collision, the 63-char truncation collision) are
// named as such.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  assertBuildIdChangedSinceServing,
  assertDeployablePoolTopology,
  assertNoCrossBuildNameCollision,
  assertNoSelfNameCollision,
  assertTargetFingerprint,
  resolveBuiltTargetPlatform,
} from "../../src/pipeline/fingerprints.js";

const REGISTRY = "us-central1-docker.pkg.dev/my-project/nextjs";

describe("resolveBuiltTargetPlatform (A2: the artifact's platform is authoritative)", () => {
  const envBefore = process.env.ADAPTER_K8S_TARGET_PLATFORM;
  beforeEach(() => {
    delete process.env.ADAPTER_K8S_TARGET_PLATFORM;
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env.ADAPTER_K8S_TARGET_PLATFORM;
    else process.env.ADAPTER_K8S_TARGET_PLATFORM = envBefore;
  });

  it("defaults an OLD artifact (no recorded platform) to amd64 — those always staged amd64 Sharp", () => {
    expect(resolveBuiltTargetPlatform({})).toBe("linux/amd64");
  });

  it("returns the artifact's recorded platform", () => {
    expect(resolveBuiltTargetPlatform({ targetPlatform: "linux/arm64" })).toBe("linux/arm64");
  });

  it("rejects an unsupported recorded platform, naming the source", () => {
    expect(() => resolveBuiltTargetPlatform({ targetPlatform: "linux/riscv64" })).toThrow(
      /build-metadata\.json targetPlatform/,
    );
  });

  it("REFUSES a deploy-time env override that contradicts the artifact (Sharp + nodeSelector are fixed at build time)", () => {
    process.env.ADAPTER_K8S_TARGET_PLATFORM = "linux/arm64";
    expect(() => resolveBuiltTargetPlatform({ targetPlatform: "linux/amd64" })).toThrow(
      /--skip-build/,
    );
  });

  it("accepts an env override that AGREES with the artifact", () => {
    process.env.ADAPTER_K8S_TARGET_PLATFORM = "linux/arm64";
    expect(resolveBuiltTargetPlatform({ targetPlatform: "linux/arm64" })).toBe("linux/arm64");
  });
});

describe("assertTargetFingerprint (A2: output on disk vs. the target being deployed)", () => {
  const base = {
    outputDirRelative: ".k8s-adapter/output",
    deployRegistry: REGISTRY,
    deployNamespace: "default",
  };

  it("passes when registry and namespace both match", () => {
    expect(() =>
      assertTargetFingerprint({
        ...base,
        metadata: { containerRegistry: REGISTRY, namespace: "default" },
      }),
    ).not.toThrow();
  });

  it("MEASURED incident: a chart built for another registry is refused before helm ever runs", () => {
    expect(() =>
      assertTargetFingerprint({
        ...base,
        metadata: { containerRegistry: "rg.fr-par.scw.cloud/other", namespace: "default" },
      }),
    ).toThrow(/was emitted for registry/);
  });

  it("a chart built for another namespace is refused (ext_proc authority is namespace-qualified)", () => {
    expect(() =>
      assertTargetFingerprint({
        ...base,
        metadata: { containerRegistry: REGISTRY, namespace: "staging" },
      }),
    ).toThrow(/was emitted for namespace/);
  });

  it("metadata predating namespace support targets the historical default namespace", () => {
    expect(() =>
      assertTargetFingerprint({ ...base, metadata: { containerRegistry: REGISTRY } }),
    ).not.toThrow();
    expect(() =>
      assertTargetFingerprint({
        ...base,
        metadata: { containerRegistry: REGISTRY },
        deployNamespace: "staging",
      }),
    ).toThrow(/was emitted for namespace "default"/);
  });
});

describe("assertDeployablePoolTopology", () => {
  it("accepts a valid topology and narrows defaultPool", () => {
    expect(() => assertDeployablePoolTopology(["ssr", "api"], "ssr")).not.toThrow();
  });

  it("rejects metadata without a pools array", () => {
    expect(() => assertDeployablePoolTopology(undefined as never, "ssr")).toThrow(
      /missing a "pools" array/,
    );
  });

  it("rejects an unsafe pool name before any composed name is derived from it", () => {
    expect(() => assertDeployablePoolTopology(["ssr", "Bad_Pool"], "ssr")).toThrow();
  });

  it("rejects a defaultPool that names no pool", () => {
    expect(() => assertDeployablePoolTopology(["ssr"], "api")).toThrow(/defaultPool/);
    expect(() => assertDeployablePoolTopology(["ssr"], undefined)).toThrow(/defaultPool/);
  });
});

describe("assertBuildIdChangedSinceServing (N14: deploymentId pins the build id)", () => {
  it("refuses an IDENTICAL build id, naming the deploymentId cause", () => {
    expect(() => assertBuildIdChangedSinceServing("build1", "build1")).toThrow(
      /IDENTICAL to the currently-serving build/,
    );
    expect(() => assertBuildIdChangedSinceServing("build1", "build1")).toThrow(/deploymentId/);
  });

  it("passes differing ids and a first deploy (null previous)", () => {
    expect(() => assertBuildIdChangedSinceServing("build2", "build1")).not.toThrow();
    expect(() => assertBuildIdChangedSinceServing("build1", null)).not.toThrow();
  });
});

describe("assertNoCrossBuildNameCollision (composed 63-char truncation, not bare ids)", () => {
  // 40-char release + "-" + 10-char pool + "-" = 52 chars of prefix; only 11 chars of
  // the build id survive the 63-char Deployment-name truncation. These ids differ at
  // char 12 — well inside their own charset limits — so comparing bare ids would pass.
  const LONG_RELEASE = "a".repeat(40);
  const POOL = "p".repeat(10);
  const ID_A = "b".repeat(11) + "1";
  const ID_B = "b".repeat(11) + "2";

  it("refuses when truncation erases the ids' difference in the COMPOSED name", () => {
    expect(() =>
      assertNoCrossBuildNameCollision(
        LONG_RELEASE,
        { buildId: ID_A, pools: [POOL] },
        { buildId: ID_B, pools: [POOL] },
      ),
    ).toThrow(/collides with the currently-serving build/);
  });

  it("refuses ids that differ only by case — sanitization lowercases them into one name", () => {
    expect(() =>
      assertNoCrossBuildNameCollision(
        "my-app",
        { buildId: "build2abc", pools: ["ssr"] },
        { buildId: "Build2abc", pools: ["ssr"] },
      ),
    ).toThrow(/collides with the currently-serving build/);
  });

  it("passes builds whose composed names stay distinct", () => {
    expect(() =>
      assertNoCrossBuildNameCollision(
        "my-app",
        { buildId: "build2abc", pools: ["ssr"] },
        { buildId: "build1xyz", pools: ["ssr"] },
      ),
    ).not.toThrow();
  });
});

describe("assertNoSelfNameCollision (N62: collisions WITHIN one build)", () => {
  it("refuses a pool named `<otherPool>-<buildId>` — its stable name equals the other pool's versioned name", () => {
    expect(() => assertNoSelfNameCollision("rel", ["api", "api-v2"], "v2")).toThrow(
      /applied TWICE/,
    );
  });

  it("passes a topology with distinct emitted names", () => {
    expect(() => assertNoSelfNameCollision("rel", ["ssr", "api"], "build2abc")).not.toThrow();
  });
});
