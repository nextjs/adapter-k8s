// tests/cli/rollback.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
// Only the two state FUNCTIONS are mocked (same shape as deploy-orchestration.test.ts), so
// the N69 suite below can swap the REAL writeState back in and exercise its generation
// arithmetic through rollback's actual call site.
vi.mock("../../src/cli/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/state.js")>();
  return { ...actual, readState: vi.fn(), writeState: vi.fn() };
});
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("node:fs");

import {
  classifyLocalRollbackComposition,
  planRollbackCapacity,
  readRoutingServingConfig,
  revertRoutingServiceToBuild,
  retainLiveRoutingManifest,
  runRollback,
  ROLLBACK_MIN_REPLICAS,
  SNAPSHOT_BUILD_ID_ANNOTATION,
} from "../../src/cli/rollback.js";
import type { LoadedCompositionPlan } from "../../src/cli/composition-plan.js";
import { execCapture, execCaptureStdin, execOrThrow } from "../../src/cli/exec.js";
import { readState, writeState } from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { routingManifestSnapshotName } from "../../src/emit/templates/routing-manifest-configmap.js";
import { poolResourceNames } from "../../src/emit/templates/utils.js";
import { renderHPA } from "../../src/emit/templates/hpa.js";
import {
  internalSecretName,
  legacyInternalSecretName,
} from "../../src/emit/templates/internal-secret.js";

const PROJECT = "/proj";
const RELEASE = "rel";
// Retained routing-manifest snapshot names (hashed — derive, never hardcode).
const SNAP_M = routingManifestSnapshotName(RELEASE, "buildm");
const SNAP_N = routingManifestSnapshotName(RELEASE, "buildn");
const infraPath = path.join(PROJECT, ".k8s-adapter", "infrastructure.json");
const metaPath = path.join(PROJECT, ".k8s-adapter", "output", "build-metadata.json");
const POOL_TOPOLOGIES = { buildn: ["ssr"], buildm: ["ssr"] };
const cdnFilter = path.join(
  PROJECT,
  ".k8s-adapter",
  "output",
  "chart",
  "templates",
  "cdn-http-filter.yaml",
);

const PLAN_DIGEST_N = `sha256:${"a".repeat(64)}` as const;
const PLAN_DIGEST_M = `sha256:${"b".repeat(64)}` as const;
const TARGET_FINGERPRINT = `sha256:${"c".repeat(64)}` as const;

function loadedComposition(buildId: string, digest: `sha256:${string}`): LoadedCompositionPlan {
  return {
    digest,
    source: `/plans/${buildId}.json`,
    plan: {
      metadata: {
        version: 1,
        releaseName: RELEASE,
        namespace: "default",
        buildId,
      },
      target: { fingerprint: TARGET_FINGERPRINT },
    } as LoadedCompositionPlan["plan"],
  };
}

describe("classifyLocalRollbackComposition", () => {
  const compositionPlans = {
    buildn: { digest: PLAN_DIGEST_N, targetFingerprint: TARGET_FINGERPRINT },
    buildm: { digest: PLAN_DIGEST_M, targetFingerprint: TARGET_FINGERPRINT },
  };

  it("accepts the rollback target artifact after state has swapped", () => {
    expect(
      classifyLocalRollbackComposition({
        local: loadedComposition("buildn", PLAN_DIGEST_N),
        state: { buildId: "buildm", previousBuildId: "buildn", compositionPlans },
        releaseName: RELEASE,
        namespace: "default",
      }),
    ).toBe("target");
  });

  it("accepts the current artifact for states that predate plan anchors", () => {
    expect(
      classifyLocalRollbackComposition({
        local: loadedComposition("buildm", PLAN_DIGEST_M),
        state: { buildId: "buildm", previousBuildId: "buildn" },
        releaseName: RELEASE,
        namespace: "default",
      }),
    ).toBe("current");
  });

  it("rejects an unanchored target artifact", () => {
    expect(() =>
      classifyLocalRollbackComposition({
        local: loadedComposition("buildn", PLAN_DIGEST_N),
        state: { buildId: "buildm", previousBuildId: "buildn" },
        releaseName: RELEASE,
        namespace: "default",
      }),
    ).toThrow(/no trust anchor/i);
  });

  it("rejects artifacts outside the two retained builds", () => {
    expect(() =>
      classifyLocalRollbackComposition({
        local: loadedComposition("buildx", PLAN_DIGEST_N),
        state: { buildId: "buildm", previousBuildId: "buildn", compositionPlans },
        releaseName: RELEASE,
        namespace: "default",
      }),
    ).toThrow(/only recognizes current build buildm and target build buildn/i);
  });

  it("rejects a retained build artifact that does not match its committed anchor", () => {
    expect(() =>
      classifyLocalRollbackComposition({
        local: loadedComposition("buildn", PLAN_DIGEST_M),
        state: { buildId: "buildm", previousBuildId: "buildn", compositionPlans },
        releaseName: RELEASE,
        namespace: "default",
      }),
    ).toThrow(/does not match committed deploy state/i);
  });
});

/** execCapture stub: success everywhere except optionally the service selector patch. */
function capture(patchFails: boolean) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    if (args.includes("deployments"))
      return { exitCode: 0, stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2", stderr: "" };
    if (args.includes("patch") && args.includes("service"))
      return { exitCode: patchFails ? 1 : 0, stdout: "", stderr: patchFails ? "denied" : "" };
    // Serving gate: one previous-build pool pod that answers /healthz.
    if (args.includes("pods")) return { exitCode: 0, stdout: "rel-ssr-buildm-abc\n", stderr: "" };
    if (args.includes("exec")) return { exitCode: 0, stdout: "", stderr: "" };
    // Routing deployment reads return empty stdout → treated as "no routing tier".
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

describe("runRollback — state and CDN invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation(
      (p) => p === infraPath || p === metaPath || p === cdnFilter,
    );
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("invalidates the rolled-away-from build (currentBuildId) on a successful switch", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(invalidateCdnBuildTag).toHaveBeenCalledTimes(1);
    expect(invalidateCdnBuildTag).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildn", releaseName: RELEASE, projectId: "proj-12345" }),
    );
  });

  it("M13: passes the rolled-away-from build's RECORDED tag and carries cdnTags in the swapped state", async () => {
    // Each build's tag is recorded at ITS deploy; rollback must hand the recorded value
    // to invalidation (never re-derive) and preserve the map — both builds stay in play.
    const cdnTags = { buildn: `build-${"ef".repeat(32)}`, buildm: `build-${"0a".repeat(32)}` };
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      cdnTags,
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(invalidateCdnBuildTag).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildn", recordedTag: cdnTags.buildn }),
    );
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      // N69: rollback passes the generation it READ as writeState's floor.
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        cdnTags,
        poolTopologies: POOL_TOPOLOGIES,
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("M13: legacy state without cdnTags rolls back with no recordedTag (full-purge fallback)", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(invalidateCdnBuildTag).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildn", recordedTag: undefined }),
    );
    // No cdnTags key invented for the swapped state.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        poolTopologies: POOL_TOPOLOGIES,
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("preserves per-build provenance across two-way rollbacks while clearing readiness", async () => {
    const digestN = `sha256:${"a".repeat(64)}`;
    const digestM = `sha256:${"b".repeat(64)}`;
    const cdnTags = { buildn: `build-${"ef".repeat(32)}`, buildm: `build-${"0a".repeat(32)}` };
    const routingImageDigests = { buildn: digestN, buildm: digestM };
    const unretainedManifestBuilds = ["buildm"];
    let state = {
      buildId: "buildn",
      previousBuildId: "buildm",
      generation: 7,
      readinessPathSupported: true,
      cdnTags,
      routingImageDigests,
      unretainedManifestBuilds,
      poolTopologies: POOL_TOPOLOGIES,
    };
    vi.mocked(readState).mockImplementation(async () => state as never);
    vi.mocked(writeState).mockImplementation(async (_projectDir, next) => {
      const { basedOnGeneration: _basedOnGeneration, ...body } = next;
      state = { ...body, generation: state.generation + 1 } as typeof state;
    });
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as never);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath)
        return JSON.stringify({
          projectId: "proj-12345",
          region: "us-central1",
          containerRegistry: "gcr.io/p",
        });
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });

    vi.mocked(execCapture).mockImplementation(async (_cmd, args) => {
      const joined = args.join(" ");
      if (args.includes("deployments")) {
        return {
          exitCode: 0,
          stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2",
          stderr: "",
        };
      }
      if (joined.includes("get deployment rel-routing-service") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: "routing-service",
                      image: `gcr.io/p/routing-service:${state.buildId}`,
                      env: [{ name: "NEXT_BUILD_ID", value: state.buildId }],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (joined.includes("get deployment rel-routing-service")) {
        return { exitCode: 0, stdout: "deployment.apps/rel-routing-service\n", stderr: "" };
      }
      if (joined.includes("get configmap rel-rm-")) {
        return { exitCode: 0, stdout: "configmap/snapshot\n", stderr: "" };
      }
      if (joined.includes("get configmap rel-routing-manifest") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ data: { "routing-manifest.json": "{}" } }),
          stderr: "",
        };
      }
      if (args.includes("pods")) {
        return {
          exitCode: 0,
          stdout: `rel-ssr-${state.previousBuildId}-abc\n`,
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });
    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const writes = vi.mocked(writeState).mock.calls.map((call) => call[1]);
    expect(writes).toEqual([
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        cdnTags,
        routingImageDigests,
        unretainedManifestBuilds,
        poolTopologies: POOL_TOPOLOGIES,
        basedOnGeneration: 7,
      },
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        cdnTags,
        routingImageDigests,
        unretainedManifestBuilds,
        poolTopologies: POOL_TOPOLOGIES,
        basedOnGeneration: 8,
      },
    ]);

    const edgePatches = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => args.includes("patch") && args.includes("deployment"))
      .map(([, args]) => args[args.length - 1] as string);
    expect(edgePatches).toHaveLength(2);
    expect(edgePatches[0]).toContain(`routing-service@${digestM}`);
    expect(edgePatches[0]).not.toContain("routing-service:buildm");
    expect(edgePatches[1]).toContain(`routing-service@${digestN}`);
    expect(edgePatches[1]).not.toContain("routing-service:buildn");
  });

  it("does NOT invalidate anything when the selector switch fails", async () => {
    vi.mocked(execCapture).mockImplementation(capture(true) as never);

    // A failed selector patch aborts with process.exit(1) BEFORE the invalidation call.
    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
  });

  it("L13: dry-run prints the plan without touching the cluster or the kubeconfig", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE, dryRun: true });

    // Absolutely no cluster interaction: not even get-credentials (it mutates the
    // operator's kubeconfig) or a ConfigMap read (context may point anywhere).
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
    // State came from the LOCAL file only.
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT, RELEASE, {
      localOnly: true,
      namespace: "default",
    });
    // No mutations of any kind.
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
    // The plan was printed.
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("[dry-run] Rollback plan: buildn → buildm");
    expect(printed).toContain("[dry-run] Would scale up previous build: rel-ssr-buildm");
    expect(printed).toContain("[dry-run] Would scale down current build: rel-ssr-buildn");
    expect(printed).toContain("[dry-run] Would patch active Service selectors");
    expect(printed).toContain(
      "[dry-run] Would revert the routing service to image routing-service:buildm",
    );
    expect(printed).toContain(SNAP_M);
    expect(printed).toContain("[dry-run] Would swap state: buildId=buildm, previousBuildId=buildn");
  });

  it("dry-run with no local previous build explains the local-only read instead of 'only one deploy'", async () => {
    vi.mocked(readState).mockResolvedValue({ buildId: "buildn" } as never);

    await expect(
      runRollback({ projectDir: PROJECT, releaseName: RELEASE, dryRun: true }),
    ).rejects.toThrow(/reads local state only.*cluster's deploy-state\s+ConfigMap/s);
    // The non-dry-run wording must not appear — the cluster was never consulted.
    await expect(
      runRollback({ projectDir: PROJECT, releaseName: RELEASE, dryRun: true }),
    ).rejects.toThrow(/LOCAL state file/);
  });
});

describe("runRollback — HPA names past the 59-char truncation boundary", () => {
  // 30-char release + "-ssr-" + 30-char build ids: the composed base is 65 chars, so
  // the Deployment name truncates at 63 but the HPA name (suffix reserved INSIDE the
  // cap, hpa.ts) truncates its base at 59. The old `${deployment}-hpa` reconstruction
  // was a DIFFERENT, invalid 67-char name: the existence probe missed the retained
  // HPA (or `kubectl autoscale` failed on the invalid name), and the scale-down left
  // the former-current build's HPA alive to rescale the parked build.
  const LONG_RELEASE = "r".repeat(30);
  const PREV = "buildm" + "x".repeat(24);
  const CURR = "buildn" + "x".repeat(24);
  const prevNames = poolResourceNames(LONG_RELEASE, "ssr", PREV);
  const currNames = poolResourceNames(LONG_RELEASE, "ssr", CURR);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: CURR,
      previousBuildId: PREV,
      poolTopologies: { [CURR]: ["ssr"], [PREV]: ["ssr"] },
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployments"))
        return {
          exitCode: 0,
          stdout: `${prevNames.deployment}|2\n${currNames.deployment}|2`,
          stderr: "",
        };
      // Serving gate: one previous-build pool pod that answers /healthz.
      if (args.includes("pods"))
        return { exitCode: 0, stdout: `${prevNames.deployment}-abc\n`, stderr: "" };
      if (args.includes("exec")) return { exitCode: 0, stdout: "", stderr: "" };
      // Everything else (incl. the `get hpa` existence probe → empty → recreate, and
      // the routing deployment read → empty → no routing tier) succeeds vacuously.
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("probes, recreates, and deletes HPAs by the template-derived name, never `${deployment}-hpa`", async () => {
    // Fixture premise: this IS the divergent case.
    expect(`${prevNames.deployment}-hpa`).not.toBe(prevNames.hpa);
    // The helper matches what renderHPA actually stamps as metadata.name.
    const renderedHpaName = renderHPA({
      poolName: "ssr",
      buildId: PREV,
      releaseName: LONG_RELEASE,
    }).match(/^\s*name: (\S+)/m)![1];
    expect(prevNames.hpa).toBe(renderedHpaName);

    await runRollback({ projectDir: PROJECT, releaseName: LONG_RELEASE });

    // Existence probe looked for the HPA the template rendered. (N26 also probes the
    // CURRENT build's HPA for its live capacity, so match the target's name explicitly.)
    const getHpa = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a[0] === "get" && a[1] === "hpa" && a.includes(prevNames.hpa));
    expect(getHpa?.[1]).toContain(prevNames.hpa);
    // Recreation targeted the previous Deployment and named the HPA like the template.
    const autoscale = vi.mocked(execOrThrow).mock.calls.find(([, a]) => a[0] === "autoscale");
    expect(autoscale?.[1]).toContain(prevNames.deployment);
    expect(autoscale?.[1]).toContain(`--name=${prevNames.hpa}`);
    // Scale-down deleted the former-current build's REAL HPA.
    const hpaDelete = vi
      .mocked(execOrThrow)
      .mock.calls.find(([, a]) => a[0] === "delete" && a[1] === "hpa");
    expect(hpaDelete?.[1]).toContain(currNames.hpa);
    // No call anywhere used the invalid 67-char concatenations.
    const allArgs = [
      ...vi.mocked(execCapture).mock.calls,
      ...vi.mocked(execOrThrow).mock.calls,
    ].flatMap(([, a]) => a as string[]);
    expect(allArgs).not.toContain(`${prevNames.deployment}-hpa`);
    expect(allArgs).not.toContain(`${currNames.deployment}-hpa`);
    // The rollback completed: state swapped to the previous build.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: PREV,
        previousBuildId: CURR,
        poolTopologies: { [PREV]: ["ssr"], [CURR]: ["ssr"] },
        basedOnGeneration: null,
      },
      LONG_RELEASE,
      "default",
    );
  });
});

describe("runRollback — N70: build-scoped pool topology", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: { buildn: ["api"], buildm: ["legacy"] },
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("restores a removed pool and redirects stale Gateway backends before parking the new pool", async () => {
    const servicePatches: { service: string; body: string }[] = [];
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployments")) {
        return {
          exitCode: 0,
          stdout: "rel-legacy-buildm|0\nrel-api-buildn|2\n",
          stderr: "",
        };
      }
      if (args.includes("pods")) {
        return { exitCode: 0, stdout: "rel-legacy-buildm-abc\n", stderr: "" };
      }
      if (args.includes("exec")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "get" && args[1] === "service") {
        const service = args[2]!;
        const pool = service === "rel-legacy" ? "legacy" : "api";
        const version = service === "rel-legacy" ? "buildm" : "buildn";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              selector: {
                "app.kubernetes.io/name": "rel",
                "app.kubernetes.io/component": pool,
                "app.kubernetes.io/version": version,
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "patch" && args[1] === "service") {
        servicePatches.push({ service: args[2]!, body: args[args.length - 1]! });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // No routing tier; no target HPA; live-capacity reads intentionally fall back to the
      // configured floor. None of those absences makes the topology ambiguous.
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(servicePatches.map((patch) => patch.service)).toEqual(["rel-legacy", "rel-api"]);
    expect(servicePatches[1]!.body).toContain(
      '"path":"/spec/selector/app.kubernetes.io~1component","value":"legacy"',
    );
    expect(servicePatches[1]!.body).toContain(
      '"path":"/spec/selector/app.kubernetes.io~1version","value":"buildm"',
    );
    const mutatingArgs = vi.mocked(execOrThrow).mock.calls.map(([, args]) => args.join(" "));
    expect(mutatingArgs.some((args) => args.includes("deployment/rel-legacy-buildm"))).toBe(true);
    expect(
      mutatingArgs.some(
        (args) => args.includes("deployment/rel-api-buildn") && args.includes("--replicas=0"),
      ),
    ).toBe(true);
    expect(mutatingArgs.some((args) => args.includes("delete hpa rel-api-buildn-hpa"))).toBe(true);
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        poolTopologies: { buildm: ["legacy"], buildn: ["api"] },
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("restores exact live selectors when a topology-changing patch only partly succeeds", async () => {
    const servicePatches: { service: string; body: string }[] = [];
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployments")) {
        return {
          exitCode: 0,
          stdout: "rel-legacy-buildm|0\nrel-api-buildn|2\n",
          stderr: "",
        };
      }
      if (args.includes("pods")) {
        return { exitCode: 0, stdout: "rel-legacy-buildm-abc\n", stderr: "" };
      }
      if (args.includes("exec")) return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "get" && args[1] === "service") {
        const service = args[2]!;
        const pool = service === "rel-legacy" ? "legacy" : "api";
        const version = service === "rel-legacy" ? "buildm" : "buildn";
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              selector: {
                "app.kubernetes.io/name": "rel",
                "app.kubernetes.io/component": pool,
                "app.kubernetes.io/version": version,
                "example.com/operator-selector": "preserve-me",
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "patch" && args[1] === "service") {
        const patch = { service: args[2]!, body: args[args.length - 1]! };
        servicePatches.push(patch);
        if (patch.service === "rel-api" && patch.body.includes('"value":"buildm"')) {
          return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(servicePatches.map((patch) => patch.service)).toEqual([
      "rel-legacy",
      "rel-api",
      "rel-legacy",
    ]);
    const restore = JSON.parse(servicePatches[2]!.body) as { value: Record<string, string> }[];
    expect(restore).toEqual([
      {
        op: "replace",
        path: "/spec/selector",
        value: {
          "app.kubernetes.io/name": "rel",
          "app.kubernetes.io/component": "legacy",
          "app.kubernetes.io/version": "buildm",
          "example.com/operator-selector": "preserve-me",
        },
      },
    ]);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(
      vi.mocked(execOrThrow).mock.calls.some(([, args]) => args.includes("--replicas=0")),
    ).toBe(false);
  });
});

describe("runRollback — state read ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCapture).mockImplementation(capture(false) as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("pins the kubectl context BEFORE reading deploy state from the cluster", async () => {
    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const credOrder = vi.mocked(execCapture).mock.invocationCallOrder[0]!;
    const stateOrder = vi.mocked(readState).mock.invocationCallOrder[0]!;
    expect(vi.mocked(execCapture).mock.calls[0]![1]).toContain("get-credentials");
    expect(stateOrder).toBeGreaterThan(credOrder);
    // Non-dry-run reads may hit the cluster ConfigMap (no localOnly flag).
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT, RELEASE, {
      namespace: "default",
    });
  });
});

describe("runRollback — routing service revert", () => {
  const REGISTRY = "us-central1-docker.pkg.dev/proj/nextjs";

  function routingCapture(opts: {
    targetSnapshotExists: boolean;
    liveArchitecture?: "amd64" | "arm64";
  }) {
    return vi.fn(async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      if (args.includes("deployments"))
        return { exitCode: 0, stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2", stderr: "" };
      if (j.includes("get deployment rel-routing-service") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  nodeSelector: {
                    "kubernetes.io/arch": opts.liveArchitecture ?? "arm64",
                  },
                  containers: [
                    {
                      name: "routing-service",
                      image: `${REGISTRY}/routing-service:buildn`,
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (j.includes("get deployment rel-routing-service")) {
        // the --ignore-not-found existence probe
        return { exitCode: 0, stdout: "deployment.apps/rel-routing-service\n", stderr: "" };
      }
      if (j.includes(`get configmap ${SNAP_M}`)) {
        return opts.targetSnapshotExists
          ? { exitCode: 0, stdout: `configmap/${SNAP_M}\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      if (j.includes("get configmap rel-routing-manifest") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ data: { "routing-manifest.json": "{}" } }),
          stderr: "",
        };
      }
      if (args.includes("pods")) return { exitCode: 0, stdout: "rel-ssr-buildm-abc\n", stderr: "" };
      if (args.includes("exec")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
      targetPlatforms: { buildn: "linux/arm64", buildm: "linux/amd64" },
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath)
        return JSON.stringify({
          projectId: "proj-12345",
          region: "us-central1",
          containerRegistry: REGISTRY,
        });
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("retains the rolled-away-from build's manifest, then reverts image AND volume before flipping pool traffic", async () => {
    vi.mocked(execCapture).mockImplementation(
      routingCapture({ targetSnapshotExists: true }) as never,
    );

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    // 1. The current build's manifest was snapshotted for the symmetric roll-forward.
    expect(vi.mocked(execCaptureStdin)).toHaveBeenCalledTimes(1);
    const applyArgs = vi.mocked(execCaptureStdin).mock.calls[0]!;
    expect(applyArgs[1].join(" ")).toContain("apply");
    const appliedDoc = JSON.parse(applyArgs[2] as string);
    expect(appliedDoc.metadata.name).toBe(SNAP_N);
    expect(appliedDoc.metadata.labels["app.kubernetes.io/managed-by"]).toBe("adapter-k8s");

    // 2. The routing Deployment was patched to the previous build's image + manifest.
    const deployPatch = vi
      .mocked(execCapture)
      .mock.calls.find(([, args]) => args.includes("patch") && args.includes("deployment"));
    expect(deployPatch).toBeDefined();
    const patchBody = deployPatch![1][deployPatch![1].length - 1]!;
    expect(patchBody).toContain(`"image":"${REGISTRY}/routing-service:buildm"`);
    expect(patchBody).toContain(`"configMap":{"name":"${SNAP_M}"}`);
    expect(patchBody).toContain('"kubernetes.io/arch":"amd64"');

    // 3. ...and its rollout was awaited. Through execCapture, not execOrThrow: the exit code
    // is needed, because a failed rollout must RESTORE the edge rather than throw with the
    // Deployment already patched (which left the tiers split — observed live).
    const rolloutArgs = vi.mocked(execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(
      rolloutArgs.some((a) => a.includes("rollout status deployment/rel-routing-service")),
    ).toBe(true);
    // The wait is long enough that a timeout means "stuck", not "busy" — a real Autopilot
    // rollout logged several `1 of 2 updated` cycles before converging.
    expect(rolloutArgs.some((a) => a.includes("--timeout=300s"))).toBe(true);

    // 4. The edge revert happens BEFORE any pool Service selector patch.
    const patchOrder = deployPatch![0]
      ? vi.mocked(execCapture).mock.invocationCallOrder[
          vi.mocked(execCapture).mock.calls.indexOf(deployPatch!)
        ]
      : 0;
    const svcPatchIdx = vi
      .mocked(execCapture)
      .mock.calls.findIndex(([, args]) => args.includes("patch") && args.includes("service"));
    const svcOrder = vi.mocked(execCapture).mock.invocationCallOrder[svcPatchIdx]!;
    expect(patchOrder).toBeLessThan(svcOrder);
  });

  it("degrades to an image-only revert (with a warning) when the target manifest snapshot is missing", async () => {
    vi.mocked(execCapture).mockImplementation(
      routingCapture({ targetSnapshotExists: false }) as never,
    );

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const deployPatch = vi
      .mocked(execCapture)
      .mock.calls.find(([, args]) => args.includes("patch") && args.includes("deployment"));
    expect(deployPatch).toBeDefined();
    const patchBody = deployPatch![1][deployPatch![1].length - 1]!;
    expect(patchBody).toContain(`"image":"${REGISTRY}/routing-service:buildm"`);
    expect(patchBody).not.toContain("volumes");
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.some((c) => String(c[0]).includes("No retained routing manifest")),
    ).toBe(true);
    // The rollback still completes the pool switch.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        poolTopologies: POOL_TOPOLOGIES,
        targetPlatforms: { buildn: "linux/arm64", buildm: "linux/amd64" },
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("moves an amd64 routing edge to arm64 and preserves both platform records", async () => {
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
      targetPlatforms: { buildn: "linux/amd64", buildm: "linux/arm64" },
    } as never);
    vi.mocked(execCapture).mockImplementation(
      routingCapture({ targetSnapshotExists: true, liveArchitecture: "amd64" }) as never,
    );

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const deployPatch = vi
      .mocked(execCapture)
      .mock.calls.find(([, args]) => args.includes("patch") && args.includes("deployment"))!;
    expect(deployPatch[1].at(-1)).toContain('"kubernetes.io/arch":"arm64"');
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildm",
        previousBuildId: "buildn",
        poolTopologies: POOL_TOPOLOGIES,
        targetPlatforms: { buildn: "linux/amd64", buildm: "linux/arm64" },
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("skips the routing revert entirely when the release has no routing tier", async () => {
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(
      vi
        .mocked(execCapture)
        .mock.calls.some(([, args]) => args.includes("patch") && args.includes("deployment")),
    ).toBe(false);
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
    expect(vi.mocked(writeState)).toHaveBeenCalled();
  });
});

describe("runRollback — partial selector-patch failure rolls the edge forward", () => {
  const REGISTRY = "us-central1-docker.pkg.dev/proj/nextjs";

  // Two pools; the ssr Service patch to the previous build succeeds, the api one
  // fails. The routing tier exists and serves buildn from the stable ConfigMap.
  function partialFailCapture(opts: { edgeForwardFails?: boolean; portableOrigin?: boolean } = {}) {
    return vi.fn(async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (args.includes("deployments"))
        return ok("rel-ssr-buildm|2\nrel-ssr-buildn|2\nrel-api-buildm|2\nrel-api-buildn|2");
      if (j.includes("get deployment rel-routing-service") && args.includes("json")) {
        return ok(
          JSON.stringify({
            spec: {
              template: {
                spec: {
                  nodeSelector: { "kubernetes.io/arch": "arm64" },
                  containers: [
                    { name: "routing-service", image: `${REGISTRY}/routing-service:buildn` },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
        );
      }
      if (j.includes("get deployment rel-routing-service")) {
        return ok("deployment.apps/rel-routing-service\n"); // existence probe
      }
      if (j.includes(`get configmap ${SNAP_M}`)) {
        return ok(`configmap/${SNAP_M}\n`); // target snapshot exists
      }
      if (j.includes(`get configmap ${SNAP_N}`)) {
        return ok(""); // no snapshot for the current build yet (retention writes it)
      }
      if (j.includes("get configmap rel-routing-manifest") && args.includes("json")) {
        return ok(JSON.stringify({ data: { "routing-manifest.json": "{}" } }));
      }
      if (j.includes("get service rel-origin") && args.includes("--ignore-not-found")) {
        return ok(opts.portableOrigin ? "service/rel-origin\n" : "");
      }
      if (j.includes("get service rel-origin") && args.includes("json")) {
        return ok(
          JSON.stringify({
            spec: {
              selector: {
                "app.kubernetes.io/name": "rel",
                "app.kubernetes.io/component": "api",
                "app.kubernetes.io/version": "buildn",
                "example.com/operator-selector": "preserve-me",
              },
            },
          }),
        );
      }
      if (args.includes("patch") && args.includes("service")) {
        const svc = args[args.indexOf("service") + 1]!;
        const body = args[args.length - 1]!;
        // Forward patch (to the previous build) fails for the api pool only.
        if (svc === "rel-api" && body.includes('"value":"buildm"')) {
          return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
        }
        return ok();
      }
      if (args.includes("patch") && args.includes("deployment")) {
        const body = args[args.length - 1]!;
        if (opts.edgeForwardFails && body.includes("routing-service:buildn")) {
          return { exitCode: 1, stdout: "", stderr: "field manager conflict" };
        }
        return ok();
      }
      if (args.includes("pods")) return ok("rel-ssr-buildm-abc\nrel-api-buildm-def\n");
      if (args.includes("exec")) return ok();
      return ok();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: { buildn: ["ssr", "api"], buildm: ["ssr", "api"] },
      targetPlatforms: { buildn: "linux/arm64", buildm: "linux/amd64" },
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath)
        return JSON.stringify({
          projectId: "proj-12345",
          region: "us-central1",
          containerRegistry: REGISTRY,
        });
      if (p === metaPath) return '{"pools":["ssr","api"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  function errorOutput(): string {
    return vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
  }

  it("rolls the routing tier forward to the current build AFTER restoring the patched Services", async () => {
    vi.mocked(execCapture).mockImplementation(partialFailCapture() as never);

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(
      errorOutput()
        .split("\n")
        .filter((line) => line.includes("Service selector patch(es) failed")),
    ).toHaveLength(1);

    const calls = vi.mocked(execCapture).mock.calls;
    // The ssr Service was restored to the CURRENT build after the api patch failed...
    const svcRestoreIdx = calls.findIndex(
      ([, a]) =>
        a.includes("patch") &&
        a.includes("service") &&
        a[a.indexOf("service") + 1] === "rel-ssr" &&
        a[a.length - 1]!.includes('"value":"buildn"'),
    );
    expect(svcRestoreIdx).toBeGreaterThanOrEqual(0);
    // ...and only AFTER that was the edge rolled forward to the current build's image.
    const edgeForwardIdx = calls.findIndex(
      ([, a]) =>
        a.includes("patch") &&
        a.includes("deployment") &&
        a[a.length - 1]!.includes("routing-service:buildn"),
    );
    expect(edgeForwardIdx).toBeGreaterThan(svcRestoreIdx);
    const edgePatches = calls
      .filter(([, a]) => a.includes("patch") && a.includes("deployment"))
      .map(([, a]) => a.at(-1)!);
    expect(edgePatches[0]).toContain('"kubernetes.io/arch":"amd64"');
    expect(edgePatches.at(-1)).toContain('"kubernetes.io/arch":"arm64"');

    const out = errorOutput();
    expect(out).toContain("ROLLBACK FAILED");
    expect(out).toContain("The routing edge (image + manifest) was restored to the current build.");
    // The messaging no longer overclaims while the edge is reverted.
    expect(out).not.toContain("still serving build buildm's middleware");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
  });

  it("prints a loud, accurate message when the edge roll-forward ALSO fails", async () => {
    vi.mocked(execCapture).mockImplementation(
      partialFailCapture({ edgeForwardFails: true }) as never,
    );

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    const out = errorOutput();
    expect(out).toContain("could not roll the routing edge forward to the current build");
    // States exactly which build's middleware/manifest the edge serves vs the pools.
    expect(out).toContain("still serving build buildm's middleware");
    expect(out).toContain("pools serving buildn");
    // ...and how to recover.
    expect(out).toContain("re-running the rollback");
    expect(out).toContain("kubectl -n default set image deployment/rel-routing-service");
    expect(out).not.toContain(
      "The routing edge (image + manifest) was restored to the current build.",
    );
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("restores the portable origin's exact selector after a partial rollback", async () => {
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: { buildn: ["ssr", "api"], buildm: ["ssr", "api"] },
      defaultPools: { buildn: "api", buildm: "ssr" },
      targetPlatforms: { buildn: "linux/arm64", buildm: "linux/amd64" },
    } as never);
    vi.mocked(execCapture).mockImplementation(
      partialFailCapture({ portableOrigin: true }) as never,
    );

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    const originPatches = vi
      .mocked(execCapture)
      .mock.calls.filter(
        ([, args]) => args[0] === "patch" && args[1] === "service" && args[2] === "rel-origin",
      )
      .map(([, args]) => JSON.parse(args.at(-1)!) as Array<Record<string, unknown>>);
    expect(originPatches).toHaveLength(2);
    expect(originPatches[0]).toContainEqual(
      expect.objectContaining({
        path: "/spec/selector/app.kubernetes.io~1component",
        value: "ssr",
      }),
    );
    expect(originPatches[1]).toEqual([
      {
        op: "replace",
        path: "/spec/selector",
        value: {
          "app.kubernetes.io/name": "rel",
          "app.kubernetes.io/component": "api",
          "app.kubernetes.io/version": "buildn",
          "example.com/operator-selector": "preserve-me",
        },
      },
    ]);
  });
});

describe("retainLiveRoutingManifest — snapshot overwrite protection", () => {
  const REGISTRY = "us-central1-docker.pkg.dev/proj/nextjs";

  function retainCapture(opts: { existingSnapshotAnnotation?: string | null }) {
    // null → snapshot exists WITHOUT the annotation (legacy); undefined → no snapshot.
    return vi.fn(async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (j.includes("get deployment rel-routing-service") && args.includes("json")) {
        return ok(
          JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    { name: "routing-service", image: `${REGISTRY}/routing-service:buildn` },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
        );
      }
      if (j.includes(`get configmap ${SNAP_N}`) && args.includes("json")) {
        if (opts.existingSnapshotAnnotation === undefined) return ok(""); // not found
        return ok(
          JSON.stringify({
            metadata: {
              name: SNAP_N,
              ...(opts.existingSnapshotAnnotation === null
                ? {}
                : {
                    annotations: {
                      [SNAPSHOT_BUILD_ID_ANNOTATION]: opts.existingSnapshotAnnotation,
                    },
                  }),
            },
            data: { "routing-manifest.json": "{}" },
          }),
        );
      }
      if (j.includes("get configmap rel-routing-manifest") && args.includes("json")) {
        return ok(JSON.stringify({ data: { "routing-manifest.json": "{}" } }));
      }
      return ok();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("refuses to overwrite an existing snapshot stamped with a DIFFERENT build id", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: "other-build" }) as never,
    );

    await expect(retainLiveRoutingManifest("rel")).rejects.toThrow(
      new RegExp(`Refusing to overwrite routing-manifest snapshot ConfigMap ${SNAP_N}`),
    );
    // Nothing was applied.
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N30: reports no-routing-tier distinctly from a FAILURE (deploy's abort depends on it)", async () => {
    // Both used to be `null`, so deploy could only warn — while a failed retention
    // permanently destroys the rollback target's manifest once helm overwrites the stable
    // ConfigMap.
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    await expect(retainLiveRoutingManifest("rel", "prod")).resolves.toEqual({
      status: "no-routing-tier",
    });
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N68: absence is proven by --ignore-not-found, not by an empty/failed read", async () => {
    // The ONE machine-readable absence signal: with --ignore-not-found a genuinely absent
    // routing Deployment exits 0 with empty stdout, so every other outcome is a failure.
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);

    await expect(retainLiveRoutingManifest("rel")).resolves.toEqual({
      status: "no-routing-tier",
    });
    const read = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("deployment") && a.includes("rel-routing-service"))!;
    expect(read[1]).toContain("--ignore-not-found");
  });

  it("N68: a routing Deployment that cannot be READ is a failure, NOT 'no routing tier'", async () => {
    // The read error used to collapse into the same `null` as genuine absence, so deploy
    // classified it as no-routing-tier, treated retention as "nothing to retain", and let
    // helm overwrite the stable routing-manifest ConfigMap — destroying the rollback
    // snapshot the fail-closed retention guard exists to protect.
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployment") && args.includes("rel-routing-service")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'deployments.apps "rel-routing-service" is forbidden',
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    const result = await retainLiveRoutingManifest("rel");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("is forbidden") });
    // Nothing was snapshotted, and nothing was invented.
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N68: unparseable routing-Deployment JSON is a failure", async () => {
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployment") && args.includes("rel-routing-service")) {
        return { exitCode: 0, stdout: "<html>proxy error</html>", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    const result = await retainLiveRoutingManifest("rel");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("not valid JSON") });
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N68: a routing Deployment missing its container/manifest volume is a failure", async () => {
    // Present but unrecognizable: the snapshot cannot be named (no image tag) or sourced
    // (no mounted ConfigMap), which is a retention failure — never "nothing to retain".
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployment") && args.includes("rel-routing-service")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: { template: { spec: { containers: [{ name: "sidecar" }], volumes: [] } } },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    const result = await retainLiveRoutingManifest("rel");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({
      reason: expect.stringContaining("rel-routing-service"),
    });
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N68: a readable routing tier is retained", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: undefined }) as never,
    );

    await expect(retainLiveRoutingManifest("rel", "prod")).resolves.toEqual({
      status: "retained",
      snapshotName: SNAP_N,
    });
  });

  it("retains a chart-owned live snapshot before the next Helm upgrade", async () => {
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (j.includes("get deployment rel-routing-service") && args.includes("json")) {
        return ok(
          JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    { name: "routing-service", image: `${REGISTRY}/routing-service:buildn` },
                  ],
                  volumes: [{ name: "routing-manifest", configMap: { name: SNAP_N } }],
                },
              },
            },
          }),
        );
      }
      return ok();
    }) as never);

    await expect(retainLiveRoutingManifest("rel", "prod")).resolves.toEqual({
      status: "retained",
      snapshotName: SNAP_N,
    });

    const calls = vi.mocked(execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(calls).toContain(
      `annotate configmap ${SNAP_N} -n prod helm.sh/resource-policy=keep --overwrite`,
    );
    expect(calls).toContain(
      `label configmap ${SNAP_N} -n prod app.kubernetes.io/name=rel app.kubernetes.io/component=routing-manifest-snapshot --overwrite`,
    );
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("N30: reports a failed apply as failed, with a reason", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: undefined }) as never,
    );
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "etcdserver: request is too large",
    } as never);

    const result = await retainLiveRoutingManifest("rel");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("too large") });
  });

  it("N30: reports a failure when the live routing-manifest ConfigMap is unreadable", async () => {
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      if (j.includes("get deployment rel-routing-service") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    { name: "routing-service", image: `${REGISTRY}/routing-service:buildn` },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (j.includes("get configmap rel-routing-manifest")) {
        return { exitCode: 1, stdout: "", stderr: "configmaps is forbidden" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    const result = await retainLiveRoutingManifest("rel");
    expect(result.status).toBe("failed");
    expect(result).toMatchObject({ reason: expect.stringContaining("forbidden") });
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
  });

  it("overwrites a snapshot stamped with the SAME build id (idempotent re-retention)", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: "buildn" }) as never,
    );

    await expect(retainLiveRoutingManifest("rel")).resolves.toEqual({
      status: "retained",
      snapshotName: SNAP_N,
    });
    expect(vi.mocked(execCaptureStdin)).toHaveBeenCalledTimes(1);
  });

  it("overwrites a legacy unstamped snapshot and stamps the build-id annotation on the new one", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: null }) as never,
    );

    await expect(retainLiveRoutingManifest("rel")).resolves.toEqual({
      status: "retained",
      snapshotName: SNAP_N,
    });
    const applied = JSON.parse(vi.mocked(execCaptureStdin).mock.calls[0]![2] as string);
    expect(applied.metadata.annotations[SNAPSHOT_BUILD_ID_ANNOTATION]).toBe("buildn");
    expect(applied.metadata.annotations["helm.sh/resource-policy"]).toBe("keep");
    expect(applied.metadata.labels["app.kubernetes.io/managed-by"]).toBe("adapter-k8s");
  });
});

describe("runRollback — serving gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries through failures and proceeds once the previous build serves /healthz", async () => {
    let podAttempts = 0;
    let execAttempts = 0;
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployments"))
        return { exitCode: 0, stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2", stderr: "" };
      if (args.includes("pods")) {
        podAttempts++;
        // Attempt 1: no pods yet. Later: the pod exists.
        return podAttempts === 1
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: "rel-ssr-buildm-abc\n", stderr: "" };
      }
      if (args.includes("exec")) {
        execAttempts++;
        // First healthz probe fails, the next succeeds.
        return execAttempts === 1
          ? { exitCode: 1, stdout: "", stderr: "connection refused" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    vi.useFakeTimers();
    const run = runRollback({ projectDir: PROJECT, releaseName: RELEASE });
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await run;

    expect(podAttempts).toBeGreaterThanOrEqual(3);
    expect(execAttempts).toBeGreaterThanOrEqual(2);
    // Traffic did switch.
    expect(
      vi
        .mocked(execCapture)
        .mock.calls.some(([, args]) => args.includes("patch") && args.includes("service")),
    ).toBe(true);
    expect(vi.mocked(writeState)).toHaveBeenCalled();
  });

  it("exhausts the bounded budget and aborts BEFORE touching traffic or state", async () => {
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args.includes("deployments"))
        return { exitCode: 0, stdout: "rel-ssr-buildm|2\nrel-ssr-buildn|2", stderr: "" };
      if (args.includes("pods")) return { exitCode: 0, stdout: "", stderr: "" }; // never appears
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    vi.useFakeTimers();
    const run = runRollback({ projectDir: PROJECT, releaseName: RELEASE });
    const assertion = expect(run).rejects.toThrow(/did not pass \/healthz within 2 minutes/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const calls = vi.mocked(execCapture).mock.calls.map(([, args]) => args);
    expect(calls.some((a) => a.includes("patch"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(invalidateCdnBuildTag).not.toHaveBeenCalled();
  });
});

describe("planRollbackCapacity — N26: a rollback comes back at the capacity that was serving", () => {
  const CHART_DEFAULTS = { min: 1, max: 3, targetCPU: 80 };

  it("never returns fewer than the historical floor", () => {
    expect(
      planRollbackCapacity(
        { specReplicas: 1, readyReplicas: 1, hpaDesired: null, hpaMax: 3 },
        CHART_DEFAULTS,
      ),
    ).toEqual({ replicas: ROLLBACK_MIN_REPLICAS, min: ROLLBACK_MIN_REPLICAS, max: 3 });
  });

  it("matches a build serving 20 under load, and lifts the HPA ceiling with it", () => {
    // The finding: rollback scaled the target to a hardcoded 2 with an HPA capped at the
    // chart default max 3 — self-inflicted overload during an incident.
    const plan = planRollbackCapacity(
      { specReplicas: 20, readyReplicas: 20, hpaDesired: 20, hpaMax: 30 },
      CHART_DEFAULTS,
    );
    expect(plan).toEqual({ replicas: 20, min: 20, max: 30 });
  });

  it("uses the HPA's desired count when .spec.replicas lags behind it", () => {
    const plan = planRollbackCapacity(
      { specReplicas: 4, readyReplicas: 4, hpaDesired: 11, hpaMax: 12 },
      CHART_DEFAULTS,
    );
    expect(plan.replicas).toBe(11);
    expect(plan.max).toBeGreaterThanOrEqual(12);
  });

  it("degrades to the configured floor when nothing could be read", () => {
    const plan = planRollbackCapacity(
      { specReplicas: null, readyReplicas: null, hpaDesired: null, hpaMax: null },
      { min: 4, max: 8, targetCPU: 60 },
    );
    expect(plan).toEqual({ replicas: 4, min: 4, max: 8 });
  });
});

describe("runRollback — N26: scales the target to the current build's live capacity", () => {
  /** Cluster where the CURRENT build (buildn) runs 9 pods with an HPA desiring 9, max 12. */
  function loadedCluster(opts: { hpaExists?: boolean; capacityReadFails?: boolean } = {}) {
    return vi.fn(async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (args.includes("deployments")) return ok("rel-ssr-buildm|0\nrel-ssr-buildn|9");
      if (j.includes("jsonpath={.metadata.name}|{.spec.replicas}|{.status.readyReplicas}")) {
        if (opts.capacityReadFails) return { exitCode: 1, stdout: "", stderr: "forbidden" };
        return ok("rel-ssr-buildn|9|9");
      }
      if (j.includes("jsonpath={.metadata.name}|{.status.desiredReplicas}|{.spec.maxReplicas}")) {
        if (opts.capacityReadFails) return { exitCode: 1, stdout: "", stderr: "forbidden" };
        return ok("rel-ssr-buildn-hpa|9|12");
      }
      // The rollback target's HPA existence probe (`-o name`).
      if (args[0] === "get" && args[1] === "hpa") {
        return ok(opts.hpaExists ? "horizontalpodautoscaler.autoscaling/rel-ssr-buildm-hpa\n" : "");
      }
      if (args.includes("pods")) return ok("rel-ssr-buildm-abc\n");
      if (args.includes("exec")) return ok();
      return ok();
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("scales up to 9 (not 2) and creates the HPA with min 9 / max 12, BEFORE any selector flip", async () => {
    vi.mocked(execCapture).mockImplementation(loadedCluster() as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const scale = vi
      .mocked(execOrThrow)
      .mock.calls.find(([, a]) => a[0] === "scale" && a[1] === "deployment/rel-ssr-buildm");
    expect(scale?.[1]).toContain("--replicas=9");
    const autoscale = vi.mocked(execOrThrow).mock.calls.find(([, a]) => a[0] === "autoscale");
    expect(autoscale?.[1]).toContain("--min=9");
    expect(autoscale?.[1]).toContain("--max=12");
    // Capacity is restored before traffic arrives.
    const scaleOrder =
      vi.mocked(execOrThrow).mock.invocationCallOrder[
        vi.mocked(execOrThrow).mock.calls.indexOf(scale!)
      ]!;
    const svcPatchIdx = vi
      .mocked(execCapture)
      .mock.calls.findIndex(([, a]) => a.includes("patch") && a.includes("service"));
    expect(vi.mocked(execCapture).mock.invocationCallOrder[svcPatchIdx]!).toBeGreaterThan(
      scaleOrder,
    );
  });

  it("WIDENS an existing HPA on the rollback target instead of leaving it at min 1 / max 3", async () => {
    vi.mocked(execCapture).mockImplementation(loadedCluster({ hpaExists: true }) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const patch = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("patch") && a.includes("hpa"));
    expect(patch).toBeDefined();
    expect(patch![1][patch![1].length - 1]).toContain('"minReplicas":9');
    expect(patch![1][patch![1].length - 1]).toContain('"maxReplicas":12');
    // No autoscale create when one already exists.
    expect(vi.mocked(execOrThrow).mock.calls.some(([, a]) => a[0] === "autoscale")).toBe(false);
  });

  it("still rolls back (with a warning) when the live capacity cannot be read", async () => {
    // Aborting here would strand the operator on a broken build — the opposite trade-off
    // from deploy's scale-DOWN probe, which must abort.
    vi.mocked(execCapture).mockImplementation(loadedCluster({ capacityReadFails: true }) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    const scale = vi
      .mocked(execOrThrow)
      .mock.calls.find(([, a]) => a[0] === "scale" && a[1] === "deployment/rel-ssr-buildm");
    expect(scale?.[1]).toContain(`--replicas=${ROLLBACK_MIN_REPLICAS}`);
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.some((c) =>
          String(c[0]).includes("Could not read the current build's live capacity"),
        ),
    ).toBe(true);
    expect(vi.mocked(writeState)).toHaveBeenCalled();
  });
});

describe("runRollback — N69: the generation floor travels through rollback's state write", () => {
  const STATE_CM = `${RELEASE}-adapter-state`;
  const localStatePath = path.join(PROJECT, ".k8s-adapter", "state.json");

  /**
   * A rollback that cuts over cleanly and THEN loses the cluster: the deploy-state
   * ConfigMap can no longer be read (or written). Everything else succeeds.
   */
  function clusterOutageOnStateWrite() {
    return vi.fn(async (_cmd: string, args: string[]) => {
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      if (args.includes("configmap") && args.includes(STATE_CM)) {
        return { exitCode: 1, stdout: "", stderr: "Unable to connect to the server" };
      }
      if (args.includes("deployments")) return ok("rel-ssr-buildm|2\nrel-ssr-buildn|2");
      if (args.includes("pods")) return ok("rel-ssr-buildm-abc\n");
      if (args.includes("exec")) return ok();
      return ok();
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // The REAL writeState, driven through rollback's own call site.
    const realState =
      await vi.importActual<typeof import("../../src/cli/state.js")>("../../src/cli/state.js");
    vi.mocked(writeState).mockImplementation(realState.writeState);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Unable to connect to the server",
    } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    // A FRESH CI CHECKOUT: `.k8s-adapter/` is gitignored, so there is no local state file to
    // carry the generation forward — the payload's floor is the only thing that can.
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj-12345","region":"us-central1"}';
      if (p === metaPath) return '{"pools":["ssr"]}';
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => vi.restoreAllMocks());

  it("records a generation ABOVE the state it read when the cluster write fails", async () => {
    // Deploy passes the generation it read as writeState's floor; rollback did NOT, so the
    // local file was stamped generation 1 while the stale cluster record sat at 7 — and
    // readState prefers the HIGHER generation, so the next operation read the stale cluster
    // record and pointed traffic back at a build this rollback had already switched away
    // from (the re-drain hazard the generation mechanism exists to prevent).
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      generation: 7,
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(execCapture).mockImplementation(clusterOutageOnStateWrite() as never);

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    // The local file (written atomically via <state.json>.tmp) carries the swapped builds
    // AND a generation above the one that was read.
    const write = vi
      .mocked(writeFileSync)
      .mock.calls.find(([p]) => String(p) === `${localStatePath}.tmp`)!;
    const written = JSON.parse(String(write[1]));
    expect(written).toMatchObject({ buildId: "buildm", previousBuildId: "buildn" });
    expect(written.generation).toBeGreaterThan(7);
    // The operator was told the cluster copy is stale, not that the rollback was clean.
    expect(
      vi
        .mocked(console.error)
        .mock.calls.map((c) => String(c[0]))
        .join("\n"),
    ).toContain("persisting state failed");
  });

  it("still stamps a generation with no prior state generation (legacy state)", async () => {
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: POOL_TOPOLOGIES,
    } as never);
    vi.mocked(execCapture).mockImplementation(clusterOutageOnStateWrite() as never);

    await expect(runRollback({ projectDir: PROJECT, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    const write = vi
      .mocked(writeFileSync)
      .mock.calls.find(([p]) => String(p) === `${localStatePath}.tmp`)!;
    expect(JSON.parse(String(write[1])).generation).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The routing tier's BUILD ID names the retained manifest snapshot. Reading it out of the image
// reference broke when images became digest-pinned: `…/routing-service@sha256:<hex>` sliced
// after the last colon yields the DIGEST HEX, so the snapshot was named after the digest while
// rollback and cleanup looked for snapshots named after state build ids — a later failed deploy
// or rollback then could not restore the target manifest, and pairing the old image with the
// newer manifest now makes the routing pod fail its startup parity check.
// ---------------------------------------------------------------------------
describe("readRoutingServingConfig — build id source", () => {
  function deploymentJson(image: string, opts: { env?: boolean } = {}) {
    return JSON.stringify({
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: "routing-service",
                image,
                ...(opts.env === false ? {} : { env: [{ name: "NEXT_BUILD_ID", value: "b-42" }] }),
              },
            ],
            volumes: [{ name: "routing-manifest", configMap: { name: "rel-routing-manifest" } }],
          },
        },
      },
    });
  }

  function mockKubectl(stdout: string) {
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout, stderr: "" } as never);
  }

  it("reads NEXT_BUILD_ID, not the digest, for a digest-pinned image", async () => {
    mockKubectl(deploymentJson(`gcr.io/p/routing-service@sha256:${"a".repeat(64)}`));
    const read = await readRoutingServingConfig("rel");
    expect(read.status).toBe("read");
    expect(read.status === "read" && read.config.imageTag).toBe("b-42");
  });

  it("falls back to the tag for a pre-digest Deployment (no env)", async () => {
    mockKubectl(deploymentJson("gcr.io/p/routing-service:legacy-build", { env: false }));
    const read = await readRoutingServingConfig("rel");
    expect(read.status === "read" && read.config.imageTag).toBe("legacy-build");
  });

  it("prefers the IMAGE TAG over the env — the image is what actually runs", async () => {
    // VERIFIED ON THE LIVE CLUSTER as data corruption, which is why the order is pinned here.
    // `rollback` patches the routing Deployment's image; before this fix it left NEXT_BUILD_ID
    // at whatever the last `helm upgrade` stamped. Reading the env first therefore reported the
    // rolled-AWAY-from build as "currently serving", so the next rollback's retention step
    // copied the mounted manifest into a snapshot named for the WRONG build — overwriting that
    // build's rollback target. The routing pod then failed assertManifestMatchesImage and
    // crash-looped (which is how it surfaced instead of silently serving mismatched routes).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockKubectl(deploymentJson("gcr.io/p/routing-service:actually-serving-this"));
    const read = await readRoutingServingConfig("rel");
    expect(read.status === "read" && read.config.imageTag).toBe("actually-serving-this");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/disagree/));
    warn.mockRestore();
  });

  it("never treats a digest as a build id, even with no env to fall back to", async () => {
    mockKubectl(
      deploymentJson(`gcr.io/p/routing-service@sha256:${"b".repeat(64)}`, { env: false }),
    );
    const read = await readRoutingServingConfig("rel");
    // Unidentifiable is a FAILURE — retention must not proceed under a wrong name.
    expect(read.status).toBe("failed");
  });
});

// The revert must move NEXT_BUILD_ID WITH the image, so the env never describes a build the
// pod is not running. See the corruption chain in readRoutingServingConfig's tests above.
describe("revertRoutingServiceToBuild — env stays truthful", () => {
  it("patches NEXT_BUILD_ID alongside the image", async () => {
    const patches: string[] = [];
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args[0] === "patch") {
        const i = args.findIndex((a) => a === "-p" || a === "--patch");
        if (i !== -1 && args[i + 1]) patches.push(args[i + 1]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "get" && args[1] === "deployment") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: "routing-service",
                      image: "gcr.io/p/routing-service:current",
                      env: [{ name: "NEXT_BUILD_ID", value: "current" }],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      // snapshot lookup + everything else succeeds
      return { exitCode: 0, stdout: "configmap/rel-rm-target", stderr: "" };
    }) as never);

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: "target-build",
      registry: "gcr.io/p",
    });

    const body = patches.join("\n");
    expect(body).toContain("routing-service:target-build");
    expect(body).toContain("NEXT_BUILD_ID");
    expect(body).toContain("target-build");
  });

  it("does not snapshot an uncertain edge during deploy recovery", async () => {
    vi.clearAllMocks();
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    } as never);
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "deployment") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: "routing-service",
                      image: "gcr.io/p/routing-service:uncertain",
                      env: [{ name: "NEXT_BUILD_ID", value: "uncertain" }],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "get" && args[1] === "configmap") {
        return { exitCode: 0, stdout: `configmap/${args[2]}\n`, stderr: "" };
      }
      if (args[0] === "get" && args[1] === "secret") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: "target-build",
      registry: "gcr.io/p",
      retainCurrentManifest: false,
    });

    const configMapReads = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => args[0] === "get" && args[1] === "configmap")
      .map(([, args]) => args[2]);
    expect(configMapReads).toEqual([routingManifestSnapshotName("rel", "target-build")]);
    expect(execCaptureStdin).not.toHaveBeenCalled();
  });
});

// N87 (SECURITY). The internal dispatch secret is per BUILD, so the edge's secretKeyRef has to
// move with the image for the same reason NEXT_BUILD_ID does: a reverted edge still presenting
// the rolled-away-from build's secret is rejected by the rolled-back pools, which then re-resolve
// every request locally — fail-safe (invariant 1), but middleware runs TWICE per request for as
// long as the rollback lasts.
describe("revertRoutingServiceToBuild — the dispatch secret moves with the image", () => {
  const TARGET = "target-build";
  const TARGET_SECRET = internalSecretName("rel", TARGET);
  const LEGACY_SECRET = legacyInternalSecretName("rel");

  /** `existingSecrets` = the Secret names `kubectl get secret --ignore-not-found` finds. */
  function mockCluster(opts: { existingSecrets: string[]; liveSecretRef?: string | null }) {
    const patches: string[] = [];
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "secret") {
        const name = args[2]!;
        return opts.existingSecrets.includes(name)
          ? { exitCode: 0, stdout: `secret/${name}\n`, stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "get" && args[1] === "deployment" && args.includes("json")) {
        const liveRef = opts.liveSecretRef === undefined ? LEGACY_SECRET : opts.liveSecretRef;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: "routing-service",
                      image: "gcr.io/p/routing-service:current",
                      env: [
                        { name: "NEXT_BUILD_ID", value: "current" },
                        ...(liveRef
                          ? [
                              {
                                name: "INTERNAL_HEADER_SECRET",
                                valueFrom: { secretKeyRef: { name: liveRef, key: "secret" } },
                              },
                            ]
                          : []),
                      ],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "patch") {
        patches.push(args[args.length - 1]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "configmap/rel-rm-target", stderr: "" };
    }) as never);
    return patches;
  }

  it("repoints the secretKeyRef at the TARGET build's Secret", async () => {
    const patches = mockCluster({ existingSecrets: [TARGET_SECRET, LEGACY_SECRET] });

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: TARGET,
      registry: "gcr.io/p",
    });

    const body = patches.join("\n");
    expect(body).toContain("INTERNAL_HEADER_SECRET");
    expect(body).toContain(TARGET_SECRET);
  });

  it("falls back to the LEGACY stable name for a build deployed before per-build names", async () => {
    // deploy preserves that Secret (`helm.sh/resource-policy: keep`), and it is the one a
    // pre-N87 target build's pods actually hold.
    const patches = mockCluster({
      existingSecrets: [LEGACY_SECRET],
      liveSecretRef: "rel-ihs-newer",
    });

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: TARGET,
      registry: "gcr.io/p",
    });

    expect(patches.join("\n")).toContain(LEGACY_SECRET);
  });

  it("leaves the env alone (with a warning) when the target has no Secret at all", async () => {
    // Pointing a container at a missing Secret is CreateContainerConfigError — that would turn
    // a degraded edge into a dead one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const patches = mockCluster({ existingSecrets: [] });

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: TARGET,
      registry: "gcr.io/p",
    });

    expect(patches.join("\n")).not.toContain("INTERNAL_HEADER_SECRET");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/No internal dispatch Secret found for build/);
  });

  it("restores the PRIOR secretKeyRef when the reverted rollout fails", async () => {
    // The revert may already have moved the ref; restoring the image without it would leave the
    // edge on a secret the (unchanged) pools do not share.
    const patches: string[] = [];
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      if (args[0] === "get" && args[1] === "secret") {
        return { exitCode: 0, stdout: `secret/${args[2]}\n`, stderr: "" };
      }
      if (args[0] === "get" && args[1] === "deployment" && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      name: "routing-service",
                      image: "gcr.io/p/routing-service:current",
                      env: [
                        { name: "NEXT_BUILD_ID", value: "current" },
                        {
                          name: "INTERNAL_HEADER_SECRET",
                          valueFrom: { secretKeyRef: { name: "rel-ihs-current", key: "secret" } },
                        },
                      ],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "rollout") {
        return { exitCode: 1, stdout: "", stderr: "timed out waiting for the condition" };
      }
      if (args[0] === "patch") {
        patches.push(args[args.length - 1]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "configmap/rel-rm-target", stderr: "" };
    }) as never);

    await expect(
      revertRoutingServiceToBuild({
        releaseName: "rel",
        targetBuildId: TARGET,
        registry: "gcr.io/p",
      }),
    ).rejects.toThrow(/did not roll out/);

    expect(patches.at(-1)).toContain("rel-ihs-current");
  });

  it("does not patch the ref to itself when it is already correct", async () => {
    const patches = mockCluster({
      existingSecrets: [TARGET_SECRET],
      liveSecretRef: TARGET_SECRET,
    });

    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: TARGET,
      registry: "gcr.io/p",
    });

    expect(patches.join("\n")).not.toContain("INTERNAL_HEADER_SECRET");
  });
});

// ---------------------------------------------------------------------------
// A failed routing rollout must not leave the tiers split.
//
// OBSERVED LIVE: the revert patched the Deployment, `rollout status` timed out, and the
// function threw — leaving the pools on one build and the edge rolled (or half-rolled) to
// another. The site stayed up only because maxUnavailable 0 keeps the old ReplicaSet serving;
// with `failureMode: closed` a routing outage in that window is 500s on every request.
// ---------------------------------------------------------------------------
describe("revertRoutingServiceToBuild — failed rollout restores the edge", () => {
  const PRIOR_IMAGE = `gcr.io/p/routing-service@sha256:${"a".repeat(64)}`;

  function mockCluster(opts: {
    rolloutFails: boolean;
    restoreFails?: boolean;
    priorNodeArchitecture?: "arm64" | null;
  }) {
    let patches = 0;
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      if (j.includes("get deployment") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  ...(opts.priorNodeArchitecture === null
                    ? {}
                    : {
                        nodeSelector: {
                          "kubernetes.io/arch": opts.priorNodeArchitecture ?? "arm64",
                          "topology.kubernetes.io/zone": "zone-a",
                        },
                      }),
                  containers: [
                    {
                      name: "routing-service",
                      image: PRIOR_IMAGE,
                      env: [{ name: "NEXT_BUILD_ID", value: "prior-build" }],
                    },
                  ],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "rollout") {
        return opts.rolloutFails
          ? { exitCode: 1, stdout: "", stderr: "timed out waiting for the condition" }
          : { exitCode: 0, stdout: "successfully rolled out", stderr: "" };
      }
      if (args[0] === "patch") {
        patches++;
        // patch #1 is the revert; patch #2 is the restore
        if (patches === 2 && opts.restoreFails) {
          return { exitCode: 1, stdout: "", stderr: "conflict" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "configmap/rel-rm-target", stderr: "" };
    }) as never);
    return () => patches;
  }

  it("restores the PRIOR spec verbatim and says the tiers still agree", async () => {
    mockCluster({ rolloutFails: true });
    await expect(
      revertRoutingServiceToBuild({
        releaseName: "rel",
        targetBuildId: "target",
        registry: "gcr.io/p",
        targetPlatform: "linux/amd64",
      }),
    ).rejects.toThrow(/did not roll out.*restored to what it was serving before/s);

    // The restore reproduces the literal reference — reconstructing it from the build id
    // would silently downgrade a digest-pinned edge to a tag.
    const restore = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch")
      .at(-1)!;
    const body = restore[1][restore[1].length - 1]!;
    expect(body).toContain(PRIOR_IMAGE);
    expect(body).toContain("prior-build");
    const patchBodies = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch")
      .map(([, a]) => a.at(-1)!)
      .slice(-2);
    expect(patchBodies[0]).toContain('"kubernetes.io/arch":"amd64"');
    expect(patchBodies.at(-1)).toContain('"kubernetes.io/arch":"arm64"');
    // Only the architecture key is patched; strategic merge preserves unrelated selectors.
    expect(patchBodies.at(-1)).not.toContain("topology.kubernetes.io/zone");
  });

  it("removes the architecture key when a failed revert started without one", async () => {
    mockCluster({ rolloutFails: true, priorNodeArchitecture: null });
    await expect(
      revertRoutingServiceToBuild({
        releaseName: "rel",
        targetBuildId: "target",
        registry: "gcr.io/p",
        targetPlatform: "linux/arm64",
      }),
    ).rejects.toThrow(/did not roll out/);

    const restoreBody = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch")
      .at(-1)![1]
      .at(-1)!;
    expect(restoreBody).toContain('"kubernetes.io/arch":null');
  });

  it("does not touch the selector while restoring a failed legacy-platform revert", async () => {
    mockCluster({ rolloutFails: true });
    await expect(
      revertRoutingServiceToBuild({
        releaseName: "rel",
        targetBuildId: "legacy-target",
        registry: "gcr.io/p",
      }),
    ).rejects.toThrow(/did not roll out/);

    const patchBodies = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch")
      .map(([, a]) => a.at(-1)!)
      .slice(-2);
    expect(patchBodies).toHaveLength(2);
    expect(patchBodies.every((body) => !body.includes("nodeSelector"))).toBe(true);
  });

  it("says so explicitly when the restore ALSO fails — that is a different situation", async () => {
    mockCluster({ rolloutFails: true, restoreFails: true });
    await expect(
      revertRoutingServiceToBuild({
        releaseName: "rel",
        targetBuildId: "target",
        registry: "gcr.io/p",
        targetPlatform: "linux/amd64",
      }),
    ).rejects.toThrow(/could NOT be restored.*DIFFERENT builds/s);
  });

  it("does not patch twice when the rollout succeeds", async () => {
    const patchCount = mockCluster({ rolloutFails: false });
    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: "target",
      registry: "gcr.io/p",
      targetPlatform: "linux/amd64",
    });
    expect(patchCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rolled-back edge should be as immutable as a freshly deployed one. The revert used to
// reconstruct `<registry>/routing-service:<buildId>` — a TAG — so rolling back silently undid
// digest pinning, which is the mutable-tag exposure that pinning exists to close (the deploy
// identity can retag, and these pods hold the internal dispatch secret in env).
// ---------------------------------------------------------------------------
describe("revertRoutingServiceToBuild — digest pinning", () => {
  const DIGEST = `sha256:${"e".repeat(64)}`;

  function mockCluster() {
    // mock.calls accumulate across tests in this file — clear so the assertions below see only
    // the patches this test provoked.
    vi.mocked(execCapture).mockClear();
    vi.mocked(execCapture).mockImplementation((async (_cmd: string, args: string[]) => {
      const j = args.join(" ");
      if (j.includes("get deployment") && args.includes("json")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            spec: {
              template: {
                spec: {
                  containers: [{ name: "routing-service", image: "gcr.io/p/routing-service:cur" }],
                  volumes: [
                    { name: "routing-manifest", configMap: { name: "rel-routing-manifest" } },
                  ],
                },
              },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "configmap/rel-rm-target", stderr: "" };
    }) as never);
  }

  const patchBody = () =>
    vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch")
      .map((c) => c[1][c[1].length - 1]!)
      .join("\n");

  it("pins by digest when the deploy recorded one", async () => {
    mockCluster();
    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: "target",
      registry: "gcr.io/p",
      targetImageDigest: DIGEST,
      targetPlatform: "linux/arm64",
    });
    expect(patchBody()).toContain(`routing-service@${DIGEST}`);
    expect(patchBody()).not.toContain("routing-service:target");
    expect(patchBody()).toContain('"kubernetes.io/arch":"arm64"');
  });

  it("falls back to the tag for a build with no recorded digest, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockCluster();
    await revertRoutingServiceToBuild({
      releaseName: "rel",
      targetBuildId: "legacy",
      registry: "gcr.io/p",
    });
    expect(patchBody()).toContain("routing-service:legacy");
    expect(patchBody()).not.toContain("nodeSelector");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/reverting the edge by\s+TAG/i));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/No recorded target platform/i));
    warn.mockRestore();
  });
});
