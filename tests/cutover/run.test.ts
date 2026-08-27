// tests/cutover/run.test.ts
//
// GitOps PR2: the extracted cutover orchestrator (src/cutover/run.ts) and its gate battery,
// driven directly against a scripted cluster — the same incident-derived cases the CLI
// lane pins through runDeploy (tests/cli/deploy-orchestration.test.ts), now transferred to
// the module BOTH entrypoints call. One implementation, two entrypoints (design principle
// 2): if these gates only held on the CLI path, the in-cluster Job would promote on weaker
// evidence than a laptop deploy does.
//
// The named cases: the exact-version rollout wait (the 12-char-prefix false pass), the N64
// capacity gate, the generation-guarded EnvoyExtensionPolicy poll (stale Accepted=True),
// and the poison pill (design §8 risk 4).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("../../src/cli/composition-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/composition-plan.js")>();
  return {
    ...actual,
    loadDeployedCompositionPlan: vi.fn(),
    waitForCompositionPlanReadiness: vi.fn(),
  };
});
// Only the two state FUNCTIONS are mocked: the error classes stay real (the orchestrators
// and the Job branch on them).
vi.mock("../../src/cli/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/state.js")>();
  return { ...actual, readState: vi.fn(), writeState: vi.fn() };
});

import { runCutover } from "../../src/cutover/run.js";
import { jobMain } from "../../src/cutover/job-main.js";
import { CutoverExitError, type CutoverInputs } from "../../src/cutover/inputs.js";
import { execCapture } from "../../src/cli/exec.js";
import { readState, writeState } from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { loadDeployedCompositionPlan } from "../../src/cli/composition-plan.js";
import {
  deriveRolloutWaitBudget,
  poolRolloutWaitBudget,
  POOL_POD_AVAILABLE_BUDGET_SECONDS,
  ROLLOUT_SURGE_STEP_SECONDS,
  ROLLOUT_TIMEOUT_CEILING_SECONDS,
  ROLLOUT_TIMEOUT_FLOOR_SECONDS,
} from "../../src/cutover/gates.js";
import {
  MIN_READY_SECONDS,
  PRESTOP_DRAIN_SECONDS,
  READINESS_PROBE_FAILURE_THRESHOLD,
  READINESS_PROBE_PERIOD_SECONDS,
  STARTUP_PROBE_BUDGET_SECONDS,
  STARTUP_PROBE_FAILURE_THRESHOLD,
  TERMINATION_GRACE_SECONDS,
} from "../../src/emit/templates/deployment.js";
import { routeExtJobName } from "../../src/emit/templates/route-ext-update-job.js";
import { emitMetadataConfigMapName } from "../../src/emit/templates/cutover-job.js";

const RELEASE = "rel";
const NS = "default";
const BUILD = "buildn";
const PREV = "buildm";
const REGISTRY = "us-central1-docker.pkg.dev/proj/nextjs";

let events: string[];
let deps: {
  restoreEdgeToPreviousBuild: ReturnType<typeof vi.fn>;
  edgeStatusLines: ReturnType<typeof vi.fn>;
};

function inputs(overrides: Partial<CutoverInputs> = {}): CutoverInputs {
  return {
    projectDir: "/tmp",
    releaseName: RELEASE,
    namespace: NS,
    buildId: BUILD,
    previousBuildId: PREV,
    pools: ["ssr"],
    previousPools: ["ssr"],
    defaultPool: "ssr",
    hasPortableOrigin: false,
    previousReplicasByPool: new Map([["ssr", 2]]),
    state: { buildId: PREV, previousBuildId: "buildm0", generation: 4 },
    compositionSnapshot: null,
    imageDigests: { routingService: `sha256:${"b".repeat(64)}` },
    builtTargetPlatform: "linux/amd64",
    unretainedManifestBuild: null,
    projectId: "my-project",
    outputDir: "/tmp/out",
    hasRouteExtJob: false,
    hasEnvoyExtensionPolicy: false,
    cdnEnabled: false,
    ...overrides,
  };
}

interface ClusterOverrides {
  /** `<pool>` -> ready pod count reported by the D7 gate. */
  readyPerPool?: Record<string, number>;
  podsReady?: boolean;
  /** Deployment names the version-label listing reports (defaults to the new build's). */
  versionedDeployments?: string[];
  rolloutFailsFor?: string;
  /** New build's rendered replica count before the D6 scale-up. */
  newBuildReplicas?: number;
  /**
   * `.spec.replicas` the D2 existence probe reads back off the routing Deployment — the count
   * its own HPA has it at, which is what D2's budget is derived from. `null` renders the field
   * as absent (an unreadable count must degrade to the floor, not to zero).
   */
  routingReplicas?: number | null;
  /** D2 probe reports the routing Deployment as absent (the gate then skips entirely). */
  routingDeploymentMissing?: boolean;
  newBuildHpa?: { min: number; max: number };
  /** EnvoyExtensionPolicy `-o json` body. */
  policy?: unknown;
  policyReadFails?: boolean;
  routeExtJobFails?: boolean;
  servicePatchFailsFor?: string;
  serviceVersion?: string;
  /** Names the emit-metadata ConfigMap listing reports (job-mode GC sweep). */
  emitMetaConfigMaps?: string[];
  /** Deployment objects returned to the post-cutover ownership-aware GC sweep. */
  gcDeployments?: unknown[];
  /** Exact versioned companion objects keyed by `kind/name`; null means absent. */
  gcCompanions?: Record<string, unknown | null>;
}

/** A scripted cluster for one release serving `buildm`, with `buildn` landing. */
function cluster(overrides: ClusterOverrides = {}) {
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  return vi.fn(async (_cmd: string, args: string[]) => {
    const j = args.join(" ");
    if (args[0] === "rollout") {
      const target = args.find((a) => a.startsWith("deployment/"))!;
      events.push(`rollout:${target}`);
      if (overrides.rolloutFailsFor && target.endsWith(overrides.rolloutFailsFor)) {
        return { exitCode: 1, stdout: "", stderr: "error: exceeded its progress deadline" };
      }
      return ok();
    }
    if (args[0] === "wait") {
      events.push(`wait:${args.find((a) => a.startsWith("job/"))}`);
      return overrides.routeExtJobFails
        ? { exitCode: 1, stdout: "", stderr: "timed out waiting for the condition" }
        : ok();
    }
    if (args[1] === "envoyextensionpolicy") {
      events.push("policy-read");
      if (overrides.policyReadFails) return { exitCode: 1, stdout: "", stderr: "forbidden" };
      return ok(JSON.stringify(overrides.policy ?? ACCEPTED_CURRENT));
    }
    // D1 listing: deployments by the EXACT version label.
    if (args[1] === "deployments" && j.includes("app.kubernetes.io/version=")) {
      events.push(`list-versioned:${args[args.indexOf("-l") + 1]}`);
      return ok(`${(overrides.versionedDeployments ?? [`${RELEASE}-ssr-${BUILD}`]).join("\n")}\n`);
    }
    if (args[1] === "deployments") {
      return overrides.gcDeployments
        ? ok(JSON.stringify({ items: overrides.gcDeployments }))
        : ok("");
    }
    if (
      args[0] === "get" &&
      ["service", "healthcheckpolicy"].includes(args[1]!) &&
      args.includes("--ignore-not-found")
    ) {
      const key = `${args[1]}/${args[2]}`;
      const value = overrides.gcCompanions?.[key];
      return value == null ? ok() : ok(JSON.stringify(value));
    }
    // D2 routing-tier existence probe, which now also carries THIS tier's replica count
    // (checked before the D6 probe below — they share a jsonpath shape).
    if (args[0] === "get" && args[1] === "deployment" && args[2] === `${RELEASE}-routing-service`) {
      if (overrides.routingDeploymentMissing) return ok("");
      const replicas = overrides.routingReplicas === undefined ? 2 : overrides.routingReplicas;
      return ok(`${RELEASE}-routing-service|${replicas === null ? "" : replicas}`);
    }
    // D6 pre-scale probe on the NEW build's Deployment.
    if (j.includes("{.metadata.name}|{.spec.replicas}")) {
      return ok(`${args[2]}|${overrides.newBuildReplicas ?? 1}`);
    }
    if (args[1] === "hpa" || args[1] === "horizontalpodautoscalers") {
      if (args[0] === "delete") {
        events.push(`delete-hpa:${args[2]}`);
        return ok();
      }
      if (args[0] === "patch") {
        const body = JSON.parse(args[args.length - 1]!) as {
          spec: { minReplicas: number; maxReplicas: number };
        };
        events.push(`hpa-bounds:${args[2]}:${body.spec.minReplicas}:${body.spec.maxReplicas}`);
        return ok();
      }
      const { min = 1, max = 3 } = overrides.newBuildHpa ?? {};
      return ok(`${args[2]}|${min}|${max}`);
    }
    if (args[1] === "pods") {
      const wantsComponent = j.includes("/component}");
      const ready = overrides.podsReady === false ? "False" : "True";
      const rows = Object.entries(overrides.readyPerPool ?? { ssr: 2 }).flatMap(([pool, n]) =>
        Array.from({ length: n }, (_, i) =>
          wantsComponent
            ? `${RELEASE}-${pool}-${BUILD}-x${i}|${ready}|${pool}`
            : `${RELEASE}-${pool}-${BUILD}-x${i}|${ready === "True" ? "Running" : "Pending"}`,
        ),
      );
      return ok(rows.length ? `${rows.join("\n")}\n` : "");
    }
    if (args[0] === "get" && args[1] === "service") {
      return ok(
        JSON.stringify({
          metadata: { name: args[2] },
          spec: {
            selector: {
              "app.kubernetes.io/name": RELEASE,
              "app.kubernetes.io/component": args[2]!.slice(`${RELEASE}-`.length),
              "app.kubernetes.io/version": overrides.serviceVersion ?? PREV,
            },
          },
        }),
      );
    }
    if (args[0] === "patch" && args[1] === "service") {
      events.push(`patch:${args[2]}`);
      if (overrides.servicePatchFailsFor === args[2]) {
        return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
      }
      return ok();
    }
    if (args[0] === "scale") {
      const target = args.find((a) => a.startsWith("deployment/"));
      events.push(args.includes("--replicas=0") ? `park:${target}` : `scaleup:${target}`);
      return ok();
    }
    if (args[0] === "delete" && ["deployment", "service", "healthcheckpolicy"].includes(args[1]!)) {
      events.push(`delete:${args[1]}:${args[2]}`);
      return ok();
    }
    if (args[1] === "configmaps" && j.includes("component=emit-metadata")) {
      return ok(
        overrides.emitMetaConfigMaps?.length ? `${overrides.emitMetaConfigMaps.join("\n")}\n` : "",
      );
    }
    if (args[0] === "exec") return ok('503 {"reason":"route module failed to load"}');
    if (args[0] === "logs") return ok("");
    return ok("");
  });
}

/** An EnvoyExtensionPolicy whose Accepted condition is CURRENT for its generation. */
const ACCEPTED_CURRENT = {
  metadata: { generation: 7 },
  status: {
    ancestors: [
      {
        controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
        conditions: [{ type: "Accepted", status: "True", observedGeneration: 7 }],
      },
    ],
  },
};

function poolDeployment(name: string, pool: string, buildId: string, owned = true) {
  return {
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/name": RELEASE,
        "app.kubernetes.io/component": pool,
        "app.kubernetes.io/version": buildId,
        ...(owned ? { "adapter-k8s.dev/release": RELEASE } : {}),
      },
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "pool-server",
              env: [
                { name: "NEXT_BUILD_ID", value: buildId },
                { name: "POOL_NAME", value: pool },
                { name: "RELEASE_NAME", value: RELEASE },
              ],
            },
          ],
        },
      },
    },
  };
}

function poolService(name: string, pool: string, buildId: string, owned = true) {
  return {
    metadata: {
      name,
      labels: {
        "app.kubernetes.io/name": RELEASE,
        "app.kubernetes.io/component": pool,
        "app.kubernetes.io/version": buildId,
        ...(owned ? { "adapter-k8s.dev/release": RELEASE } : {}),
      },
    },
    spec: {
      selector: {
        "app.kubernetes.io/name": RELEASE,
        "app.kubernetes.io/component": pool,
        "app.kubernetes.io/version": buildId,
      },
    },
  };
}

function poolHealthCheckPolicy(name: string, serviceName: string, pool: string, buildId: string) {
  return {
    metadata: {
      name,
      labels: {
        "adapter-k8s.dev/release": RELEASE,
        "app.kubernetes.io/name": RELEASE,
        "app.kubernetes.io/component": pool,
        "app.kubernetes.io/version": buildId,
      },
    },
    spec: { targetRef: { group: "", kind: "Service", name: serviceName } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  deps = {
    restoreEdgeToPreviousBuild: vi.fn(async () => ({
      attempted: true,
      restored: true,
      error: "",
    })),
    edgeStatusLines: vi.fn(() => ["  The routing edge was reverted."]),
  };
  vi.mocked(readState).mockResolvedValue({
    buildId: PREV,
    previousBuildId: "buildm0",
    generation: 4,
  });
  vi.mocked(writeState).mockResolvedValue(undefined);
  vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined as never);
  vi.mocked(loadDeployedCompositionPlan).mockResolvedValue({
    plan: {
      operations: {
        routing: { dataplane: { readiness: [] } },
        resources: { readiness: [] },
      },
      target: { fingerprint: `sha256:${"c".repeat(64)}` },
      metadata: { releaseName: RELEASE, namespace: NS, buildId: BUILD },
    },
    digest: `sha256:${"d".repeat(64)}`,
    source: "test",
  } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function printedErrors(): string {
  return vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
}

describe("runCutover — the happy path's ordering", () => {
  it("gates, then patches selectors, then commits state, then parks the previous build", async () => {
    vi.mocked(execCapture).mockImplementation(cluster() as never);

    await runCutover(inputs(), deps);

    // E2 commits IMMEDIATELY after the confirmed cutover — every step between the selector
    // patch and the write is a window where traffic serves the new build while state names
    // the old one.
    expect(events.indexOf("rollout:deployment/rel-ssr-buildn")).toBeLessThan(
      events.indexOf("patch:rel-ssr"),
    );
    expect(events).toContain("park:deployment/rel-ssr-buildm");
    expect(events.indexOf("patch:rel-ssr")).toBeLessThan(
      events.indexOf("park:deployment/rel-ssr-buildm"),
    );
    const stateWrite = vi.mocked(writeState).mock.calls[0]!;
    expect(stateWrite[1]).toMatchObject({
      buildId: BUILD,
      previousBuildId: PREV,
      poolTopologies: { [BUILD]: ["ssr"], [PREV]: ["ssr"] },
      // N69: the write is based on the generation this operation READ.
      basedOnGeneration: 4,
    });
    expect(deps.restoreEdgeToPreviousBuild).not.toHaveBeenCalled();
  });

  it("routes the E2 commit to the store the caller chose (the Job runs cluster-CM-only)", async () => {
    vi.mocked(execCapture).mockImplementation(cluster() as never);

    await runCutover(inputs({ stateStore: "cluster-only" }), deps);
    expect(vi.mocked(writeState).mock.calls[0]![4]).toEqual({ clusterOnly: true });

    vi.mocked(writeState).mockClear();
    await runCutover(inputs(), deps);
    expect(vi.mocked(writeState).mock.calls[0]![4]).toEqual({ clusterOnly: false });
  });

  it("revalidates committed state at the last read-only point before selector cutover", async () => {
    vi.mocked(execCapture).mockImplementation(cluster() as never);
    vi.mocked(readState).mockResolvedValue({
      buildId: "another-build",
      previousBuildId: PREV,
      generation: 5,
    });

    await expect(runCutover(inputs(), deps)).rejects.toThrow(
      /state changed while build buildn was becoming ready/,
    );

    expect(events).not.toContain("patch:rel-ssr");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalledOnce();
  });

  it("sweeps superseded emit-metadata ConfigMaps, keeping current and previous", async () => {
    // Keep-at-birth makes these unpruneable by any reconciler (a forcePromotion re-run of
    // the parked build mounts ITS ConfigMap), so the cutover owns their deletion — without
    // this sweep they accumulate one per build forever.
    const current = emitMetadataConfigMapName(RELEASE, BUILD);
    const previous = emitMetadataConfigMapName(RELEASE, PREV);
    const stale = emitMetadataConfigMapName(RELEASE, "buildk");
    vi.mocked(execCapture).mockImplementation(
      cluster({ emitMetaConfigMaps: [current, previous, stale] }) as never,
    );

    await runCutover(inputs(), deps);

    const deletes = vi
      .mocked(execCapture)
      .mock.calls.filter(
        ([, a]) => (a as string[])[0] === "delete" && (a as string[])[1] === "configmap",
      )
      .map(([, a]) => (a as string[])[2]);
    expect(deletes).toContain(stale);
    expect(deletes).not.toContain(current);
    expect(deletes).not.toContain(previous);
  });
});

describe("runCutover — D1: the EXACT-version rollout wait (the 12-char-prefix false pass)", () => {
  it("matches the new build by its full sanitized version label, never a 12-char prefix", async () => {
    // The prior match used a 12-char normalized-prefix substring, so an OLD build sharing
    // that prefix satisfied the readiness check; cutover then patched Services to the FULL
    // new label, matched zero pods, drained the NEG and 503'd the origin.
    const newBuild = "build-prefix-new";
    const oldBuild = "build-prefix-old";
    expect(newBuild.slice(0, 12)).toBe(oldBuild.slice(0, 12));
    vi.mocked(execCapture).mockImplementation(
      cluster({
        versionedDeployments: [`${RELEASE}-ssr-${newBuild}`],
        readyPerPool: { ssr: 2 },
        serviceVersion: oldBuild,
      }) as never,
    );

    await runCutover(
      inputs({ buildId: newBuild, previousBuildId: oldBuild, previousPools: ["ssr"] }),
      deps,
    );

    // The listing selector carries the WHOLE sanitized build id...
    expect(events).toContain(
      `list-versioned:app.kubernetes.io/name=rel,app.kubernetes.io/version=${newBuild}`,
    );
    // ...and so does the readiness gate's pod selector.
    const podSelectors = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[1] === "pods")
      .map(([, a]) => a[a.indexOf("-l") + 1]!);
    expect(podSelectors.length).toBeGreaterThan(0);
    for (const s of podSelectors) {
      expect(s).toContain(`app.kubernetes.io/version=${newBuild}`);
      expect(s).not.toContain(`app.kubernetes.io/version=${newBuild.slice(0, 12)},`);
    }
    // The old build was never mistaken for the new one.
    expect(events).not.toContain(`rollout:deployment/${RELEASE}-ssr-${oldBuild}`);
    // The selector actually patched is the full sanitized label too.
    const patch = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a[0] === "patch" && a[1] === "service")!;
    expect(patch[1][patch[1].length - 1]).toContain(`"app.kubernetes.io/version":"${newBuild}"`);
  });

  it("excludes the routing tier by EXACT name — a pool named routing-service-extra still waits", async () => {
    // A substring filter would silently skip that pool's rollout wait entirely.
    vi.mocked(execCapture).mockImplementation(
      cluster({
        versionedDeployments: [
          `${RELEASE}-ssr-${BUILD}`,
          `${RELEASE}-routing-service-extra-${BUILD}`,
          `${RELEASE}-routing-service`,
        ],
        readyPerPool: { ssr: 2, "routing-service-extra": 2 },
      }) as never,
    );

    await runCutover(
      inputs({
        pools: ["ssr", "routing-service-extra"],
        previousPools: ["ssr", "routing-service-extra"],
        previousReplicasByPool: new Map([
          ["ssr", 2],
          ["routing-service-extra", 2],
        ]),
      }),
      deps,
    );

    expect(events).toContain(`rollout:deployment/${RELEASE}-routing-service-extra-${BUILD}`);
    expect(events).toContain(`rollout:deployment/${RELEASE}-ssr-${BUILD}`);
    // The stable routing Deployment is verified separately (D2), not as a pool.
    expect(
      events.filter((e) => e === `rollout:deployment/${RELEASE}-routing-service`),
    ).toHaveLength(1);
    expect(events).toContain("patch:rel-routing-service-extra");
  });

  it("a stuck rollout aborts BEFORE any selector patch, restoring the edge (N25)", async () => {
    vi.mocked(execCapture).mockImplementation(
      cluster({ rolloutFailsFor: `${RELEASE}-ssr-${BUILD}` }) as never,
    );

    await expect(runCutover(inputs(), deps)).rejects.toThrow(/did not finish rolling out/);
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    // The edge has been on the new build since the sync overwrote the stable manifest CM.
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
  });
});

describe("runCutover — A2: the two rollout gates budget the shapes they actually await", () => {
  /** `--timeout=<n>s` per awaited Deployment, keyed by the Deployment the gate waited on. */
  function rolloutTimeoutsByDeployment(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [, a] of vi.mocked(execCapture).mock.calls) {
      if (a[0] !== "rollout") continue;
      const target = a.find((x) => x.startsWith("deployment/"))!.slice("deployment/".length);
      out[target] = a.find((x) => x.startsWith("--timeout="))!;
    }
    return out;
  }

  it("D1 waits the fixed parallel-create budget; D2 derives its own from the ROUTING tier", async () => {
    // A2-repair, the whole point: these two numbers are independent. The pools sit at 2 live
    // replicas while the routing HPA has that tier at 4 under traffic — plausible, since the
    // tier is single-threaded at 500m with a 70% CPU target. A2 shipped handing BOTH gates
    // max(previousReplicasByPool) = 2, i.e. the 600s floor, against ~1140s of real serial
    // routing cost; D2 then aborted a cutover whose rollout was still progressing.
    vi.mocked(execCapture).mockImplementation(
      cluster({ readyPerPool: { ssr: 2 }, routingReplicas: 4 }) as never,
    );

    await runCutover(inputs({ previousReplicasByPool: new Map([["ssr", 2]]) }), deps);

    const waits = rolloutTimeoutsByDeployment();
    // D1: created-from-nothing Deployments, pods in parallel — the constant, regardless of any
    // replica count anywhere.
    expect(waits[`${RELEASE}-ssr-${BUILD}`]).toBe(`--timeout=${ROLLOUT_TIMEOUT_FLOOR_SECONDS}s`);
    // D2: patched in place, one serial surge step per ROUTING replica. 4 x 285s = 1140s, inside
    // the band where the derivation — not the floor, not the ceiling — governs the answer.
    expect(waits[`${RELEASE}-routing-service`]).toBe(`--timeout=1140s`);
    expect(4 * ROLLOUT_SURGE_STEP_SECONDS).toBe(1140);
  });

  it("D2's budget tracks the routing replica count and nothing else", async () => {
    // Same pool topology in every case; only the routing tier's own `.spec.replicas` moves. A
    // budget derived from previousReplicasByPool instead would be constant across this table,
    // and one landing on the ceiling could not tell the derivation from a hardcoded 1800.
    for (const [routingReplicas, expected] of [
      [2, `--timeout=${ROLLOUT_TIMEOUT_FLOOR_SECONDS}s`], // 570s of surge, under the floor
      [3, "--timeout=855s"],
      [4, "--timeout=1140s"],
      [6, "--timeout=1710s"],
      [12, `--timeout=${ROLLOUT_TIMEOUT_CEILING_SECONDS}s`], // 3420s, clamped
    ] as const) {
      vi.clearAllMocks();
      vi.mocked(writeState).mockResolvedValue(undefined);
      vi.mocked(execCapture).mockImplementation(cluster({ routingReplicas }) as never);

      await runCutover(inputs(), deps);

      const waits = rolloutTimeoutsByDeployment();
      expect(waits[`${RELEASE}-routing-service`]).toBe(expected);
      // And the pool gate never moves with it.
      expect(waits[`${RELEASE}-ssr-${BUILD}`]).toBe(`--timeout=${ROLLOUT_TIMEOUT_FLOOR_SECONDS}s`);
    }
  });

  it("an unreadable routing replica count degrades D2 to the floor, never to zero", async () => {
    // The routing template omits `.spec.replicas` (its HPA owns the field), so a tier the HPA
    // has not adopted yet reads back empty. A short wait is the dangerous direction: it aborts
    // a healthy cutover and reverts the edge.
    vi.mocked(execCapture).mockImplementation(cluster({ routingReplicas: null }) as never);

    await runCutover(inputs(), deps);

    expect(rolloutTimeoutsByDeployment()[`${RELEASE}-routing-service`]).toBe(
      `--timeout=${ROLLOUT_TIMEOUT_FLOOR_SECONDS}s`,
    );
  });

  it("quotes the budget it actually used when the ROUTING rollout fails", async () => {
    // The abort message quoted a stale "120s" for two revisions; A2 then made it quote the
    // POOL gate's number on a routing failure. It must quote the wait this gate performed.
    vi.mocked(execCapture).mockImplementation(
      cluster({ routingReplicas: 4, rolloutFailsFor: `${RELEASE}-routing-service` }) as never,
    );

    await expect(runCutover(inputs(), deps)).rejects.toThrow(
      /Routing service \(.*\) did not become healthy within 1140s/,
    );
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
  });

  it("the subprocess ceiling always outlives the flag, and the ceiling caps the derivation", () => {
    // exec.ts's rollout tier exists to let kubectl report the timeout rather than have the
    // parent kill it; a derived budget above that tier must carry its own headroom.
    for (const replicas of [1, 2, 4, 8, 40, 10_000]) {
      const b = deriveRolloutWaitBudget(replicas);
      expect(b.seconds).toBeGreaterThanOrEqual(ROLLOUT_TIMEOUT_FLOOR_SECONDS);
      expect(b.seconds).toBeLessThanOrEqual(ROLLOUT_TIMEOUT_CEILING_SECONDS);
      expect(b.execTimeoutMs).toBeGreaterThan(b.seconds * 1000);
      expect(b.arg).toBe(`--timeout=${b.seconds}s`);
    }
    // A missing/garbage live replica read degrades to the floor, never to zero.
    expect(deriveRolloutWaitBudget(0).seconds).toBe(ROLLOUT_TIMEOUT_FLOOR_SECONDS);
    expect(deriveRolloutWaitBudget(NaN).seconds).toBe(ROLLOUT_TIMEOUT_FLOOR_SECONDS);
    // The pool budget is not a degenerate case of the derivation — it is its own constant.
    expect(poolRolloutWaitBudget().seconds).toBe(ROLLOUT_TIMEOUT_FLOOR_SECONDS);
  });

  it("keeps both budgets pinned to the chart parameters they claim to be derived from", async () => {
    // Both budgets restate numbers that live in the emit templates. If one moves and this does
    // not, the comments in gates.ts become lies.
    expect(ROLLOUT_SURGE_STEP_SECONDS).toBe(
      READINESS_PROBE_PERIOD_SECONDS * READINESS_PROBE_FAILURE_THRESHOLD +
        30 +
        MIN_READY_SECONDS +
        TERMINATION_GRACE_SECONDS,
    );
    // The occupancy term must be the KUBELET's ceiling, not preStop + the pool server's
    // application drain: that sum is both smaller and not a bound at all, since
    // ADAPTER_K8S_SHUTDOWN_GRACE_MS is a documented operator knob.
    expect(TERMINATION_GRACE_SECONDS).toBeGreaterThan(PRESTOP_DRAIN_SECONDS);
    const { renderDeployment } = await import("../../src/emit/templates/deployment.js");
    const manifest = renderDeployment({
      poolName: "ssr",
      buildId: BUILD,
      releaseName: RELEASE,
      internalSecretRef: "rel-internal-secret",
    });
    expect(manifest).toContain(`terminationGracePeriodSeconds: ${TERMINATION_GRACE_SECONDS}`);
    expect(manifest).toContain(`minReadySeconds: ${MIN_READY_SECONDS}`);
    expect(manifest).toContain(`failureThreshold: ${STARTUP_PROBE_FAILURE_THRESHOLD}`);
    // D1's constant must stay above what ONE pod of a freshly created Deployment can cost, or
    // that gate is back to being arithmetically impossible (the 120s it replaced).
    expect(POOL_POD_AVAILABLE_BUDGET_SECONDS).toBe(
      STARTUP_PROBE_BUDGET_SECONDS +
        READINESS_PROBE_PERIOD_SECONDS * READINESS_PROBE_FAILURE_THRESHOLD +
        MIN_READY_SECONDS,
    );
    expect(ROLLOUT_TIMEOUT_FLOOR_SECONDS).toBeGreaterThan(POOL_POD_AVAILABLE_BUDGET_SECONDS * 2);
  });
});

describe("runCutover — N64: the capacity gate requires the outgoing build's live count", () => {
  it("scales the new build up to the outgoing count and warms its HPA before the gate", async () => {
    // The chart renders a new build at its HPA floor, and with no traffic yet nothing would
    // ever scale it up — so the capacity is requested explicitly, under temporarily lifted
    // HPA bounds (N67) that are restored on every exit path.
    vi.mocked(execCapture).mockImplementation(
      cluster({
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        readyPerPool: { ssr: 6 },
      }) as never,
    );

    await runCutover(inputs({ previousReplicasByPool: new Map([["ssr", 6]]) }), deps);

    expect(events).toContain("hpa-bounds:rel-ssr-buildn-hpa:6:6");
    expect(events).toContain("scaleup:deployment/rel-ssr-buildn");
    expect(events.indexOf("scaleup:deployment/rel-ssr-buildn")).toBeLessThan(
      events.indexOf("patch:rel-ssr"),
    );
    // N67: the chart's own bounds go back after the cutover is durable.
    expect(events).toContain("hpa-bounds:rel-ssr-buildn-hpa:1:3");
    expect(events.lastIndexOf("hpa-bounds:rel-ssr-buildn-hpa:1:3")).toBeGreaterThan(
      events.indexOf("patch:rel-ssr"),
    );
  });

  it("does NOT cut over while fewer pods are ready than the outgoing build runs", async () => {
    // The old gate passed on `checkedCount > 0` — ONE ready pod — so a previous build
    // serving 6 cut over to a single pod with the HPA climbing from behind.
    vi.mocked(execCapture).mockImplementation(
      cluster({ readyPerPool: { ssr: 1 }, newBuildReplicas: 6 }) as never,
    );

    vi.useFakeTimers();
    const run = runCutover(inputs({ previousReplicasByPool: new Map([["ssr", 6]]) }), deps);
    const assertion = expect(run).rejects.toBeInstanceOf(CutoverExitError);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    // The message says WHICH pool fell short and by how much.
    expect(printedErrors()).toContain("Capacity gate");
    expect(printedErrors()).toContain("ssr: 1/6 ready");
    // N25 + N67: the edge goes back, and so do the warm-up bounds on the abandoned build.
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
    expect(events).toContain("hpa-bounds:rel-ssr-buildn-hpa:1:3");
  });

  it("gates PER POOL: one pool at full capacity cannot cover another that is short", async () => {
    vi.mocked(execCapture).mockImplementation(
      cluster({ readyPerPool: { ssr: 5, api: 1 } }) as never,
    );

    vi.useFakeTimers();
    const run = runCutover(
      inputs({
        pools: ["ssr", "api"],
        previousPools: ["ssr", "api"],
        previousReplicasByPool: new Map([
          ["ssr", 3],
          ["api", 3],
        ]),
      }),
      deps,
    );
    const assertion = expect(run).rejects.toBeInstanceOf(CutoverExitError);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(printedErrors()).toContain("api: 1/3 ready");
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
  });

  it("S18: a pool with no live predecessor still owes one ready pod", async () => {
    // previousReplicasByPool has no entry for a pool that is NEW in this build, so those
    // pools once contributed no expectation at all: a sibling's ready pods satisfied the
    // gate and cutover then patched EVERY active Service — leaving the new pool's Service
    // with zero endpoints.
    vi.mocked(execCapture).mockImplementation(
      cluster({ readyPerPool: { ssr: 2, api: 0 } }) as never,
    );

    vi.useFakeTimers();
    const run = runCutover(
      inputs({ pools: ["ssr", "api"], previousReplicasByPool: new Map([["ssr", 2]]) }),
      deps,
    );
    const assertion = expect(run).rejects.toBeInstanceOf(CutoverExitError);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(printedErrors()).toContain("api: 0/1 ready");
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
  });

  it("N32: the failure diagnostic probes /readyz and prints its reason, not /healthz", async () => {
    vi.mocked(execCapture).mockImplementation(cluster({ readyPerPool: { ssr: 0 } }) as never);

    vi.useFakeTimers();
    const run = runCutover(inputs(), deps);
    const assertion = expect(run).rejects.toBeInstanceOf(CutoverExitError);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const probes = vi.mocked(execCapture).mock.calls.filter(([, a]) => a[0] === "exec");
    // /healthz is a hardcoded 200 emitted before any routing or handler load — it cannot
    // fail, so asking it here told the operator nothing.
    for (const [, a] of probes) {
      expect(a.join(" ")).toContain("/readyz");
      expect(a.join(" ")).not.toContain("/healthz");
    }
  });
});

describe("runCutover — D4/D5: the generation-guarded Accepted poll (stale Accepted=True)", () => {
  it("REJECTS an Accepted=True that is stale for the object's generation", async () => {
    // An UPDATED policy retains the previous `Accepted=True` until the controller catches
    // up — the dangerous direction, because it green-lights a cutover whose edge may not
    // be wired. observedGeneration vs metadata.generation is what distinguishes "accepted"
    // from "accepted, previously".
    vi.mocked(execCapture).mockImplementation(
      cluster({
        policy: {
          metadata: { generation: 9 },
          status: {
            ancestors: [
              {
                controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
                conditions: [{ type: "Accepted", status: "True", observedGeneration: 8 }],
              },
            ],
          },
        },
      }) as never,
    );

    vi.useFakeTimers();
    const run = runCutover(inputs({ hasEnvoyExtensionPolicy: true }), deps);
    const assertion = expect(run).rejects.toThrow(/EnvoyExtensionPolicy .* is not Accepted/);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(2000);
    await assertion;

    // It POLLED rather than deciding on one read, and never cut traffic.
    expect(events.filter((e) => e === "policy-read").length).toBeGreaterThan(1);
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
  });

  it("ACCEPTS when the condition is current for the generation", async () => {
    vi.mocked(execCapture).mockImplementation(cluster({ policy: ACCEPTED_CURRENT }) as never);
    await runCutover(inputs({ hasEnvoyExtensionPolicy: true }), deps);
    expect(events.filter((e) => e === "policy-read")).toHaveLength(1);
    expect(events).toContain("patch:rel-ssr");
  });

  it("selects the ancestor by the Envoy Gateway CONTROLLER, not ancestors[0]", async () => {
    // Ancestors are a map-like list, not an ordered one, so [0] is not necessarily this
    // release's Gateway/route.
    vi.mocked(execCapture).mockImplementation(
      cluster({
        policy: {
          metadata: { generation: 3 },
          status: {
            ancestors: [
              {
                controllerName: "example.com/some-other-controller",
                conditions: [{ type: "Accepted", status: "False", observedGeneration: 3 }],
              },
              {
                controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
                conditions: [{ type: "Accepted", status: "True", observedGeneration: 3 }],
              },
            ],
          },
        },
      }) as never,
    );
    await runCutover(inputs({ hasEnvoyExtensionPolicy: true }), deps);
    expect(events).toContain("patch:rel-ssr");
  });

  it("D3: an incomplete ext_proc registration Job refuses the cutover (middleware boundary)", async () => {
    vi.mocked(execCapture).mockImplementation(cluster({ routeExtJobFails: true }) as never);

    await expect(runCutover(inputs({ hasRouteExtJob: true }), deps)).rejects.toThrow(
      /registration job .* did not complete/,
    );
    expect(events).toContain(`wait:job/${routeExtJobName(RELEASE, BUILD)}`);
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
  });
});

describe("runCutover — E6: superseded deployment ownership", () => {
  it("deletes a superseded adapter pool but leaves a same-label foreign workload untouched", async () => {
    const oldAdapterName = `${RELEASE}-ssr-buildl`;
    const foreignName = `${RELEASE}-foreign-buildl`;
    vi.mocked(execCapture).mockImplementation(
      cluster({
        gcDeployments: [
          poolDeployment(oldAdapterName, "ssr", "buildl"),
          poolDeployment(foreignName, "foreign", "buildl", false),
        ],
        gcCompanions: {
          [`service/${oldAdapterName}`]: poolService(oldAdapterName, "ssr", "buildl"),
          [`healthcheckpolicy/${oldAdapterName}-hcp`]: poolHealthCheckPolicy(
            `${oldAdapterName}-hcp`,
            oldAdapterName,
            "ssr",
            "buildl",
          ),
        },
      }) as never,
    );

    await runCutover(inputs(), deps);

    expect(events).toContain(`delete:deployment:${oldAdapterName}`);
    expect(events).toContain(`delete:service:${oldAdapterName}`);
    expect(events).toContain(`delete:healthcheckpolicy:${oldAdapterName}-hcp`);
    expect(events.some((event) => event.includes(foreignName))).toBe(false);
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain(`keeping ambiguous Deployment "${foreignName}"`);
  });

  it("independently retains a foreign same-named Service beside an owned old Deployment", async () => {
    const oldAdapterName = `${RELEASE}-ssr-buildl`;
    vi.mocked(execCapture).mockImplementation(
      cluster({
        gcDeployments: [poolDeployment(oldAdapterName, "ssr", "buildl")],
        gcCompanions: {
          [`service/${oldAdapterName}`]: poolService(oldAdapterName, "ssr", "buildl", false),
        },
      }) as never,
    );

    await runCutover(inputs(), deps);

    expect(events).toContain(`delete:deployment:${oldAdapterName}`);
    expect(events).not.toContain(`delete:service:${oldAdapterName}`);
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain(`keeping ambiguous service "${oldAdapterName}"`);
  });

  it("keeps an owned-looking deployment whose template identity disagrees with its name", async () => {
    const mismatchedName = `${RELEASE}-api-buildl`;
    vi.mocked(execCapture).mockImplementation(
      cluster({ gcDeployments: [poolDeployment(mismatchedName, "ssr", "buildl")] }) as never,
    );

    await runCutover(inputs(), deps);

    expect(events.some((event) => event.includes(mismatchedName))).toBe(false);
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.map((call) => String(call[0]))
        .join("\n"),
    ).toContain("template identity does not match");
  });
});

describe("runCutover — E1: a failed selector patch never records the new build as serving", () => {
  it("restores the patched selectors, the edge, and the HPA bounds, and writes no state", async () => {
    vi.mocked(execCapture).mockImplementation(
      cluster({ servicePatchFailsFor: "rel-api", readyPerPool: { ssr: 2, api: 2 } }) as never,
    );

    await expect(
      runCutover(
        inputs({
          pools: ["ssr", "api"],
          previousPools: ["ssr", "api"],
          previousReplicasByPool: new Map([
            ["ssr", 2],
            ["api", 2],
          ]),
        }),
        deps,
      ),
    ).rejects.toBeInstanceOf(CutoverExitError);

    // Recording the new build as current would strand the real rollback target.
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(events).not.toContain("park:deployment/rel-ssr-buildm");
    expect(deps.restoreEdgeToPreviousBuild).toHaveBeenCalled();
    // The pool that DID flip is put back to its exact prior selector (a partial flip would
    // split traffic across builds), so rel-ssr is patched twice: forward, then back.
    expect(events.filter((e) => e === "patch:rel-ssr")).toHaveLength(2);
    const restore = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a[0] === "patch" && a[2] === "rel-ssr")
      .at(-1)!;
    expect(restore[1][restore[1].length - 1]).toContain(`"app.kubernetes.io/version":"${PREV}"`);
    // N67: the abandoned build must not keep the raised replica floor.
    expect(events).toContain("hpa-bounds:rel-ssr-buildn-hpa:1:3");
  });
});

// ---------------------------------------------------------------------------
// The poison pill (design §8 risk 4), through the Job's real entrypoint: an auto-syncing
// reconciler retries a failed sync on its own schedule, and each retry would re-run the
// HPA warm-up against a build that will never pass — a capacity wobble on the SERVING
// build, every interval, forever.
// ---------------------------------------------------------------------------
describe("jobMain — the poison pill", () => {
  let metadataDir: string;

  const STATE = {
    buildId: PREV,
    previousBuildId: "buildm0",
    generation: 4,
    poolTopologies: { [PREV]: ["ssr"] },
  };

  function writeMetadata(extra: Record<string, unknown> = {}): void {
    writeFileSync(
      path.join(metadataDir, "emit-metadata.json"),
      JSON.stringify({
        emitVersion: 1,
        buildId: BUILD,
        previousBuildId: PREV,
        releaseName: RELEASE,
        namespace: NS,
        registry: REGISTRY,
        digests: {},
        cdnTag: `build-${"0".repeat(64)}`,
        poolTopology: ["ssr"],
        defaultPool: "ssr",
        targetPlatforms: { [BUILD]: "linux/amd64" },
        secretsMode: "external",
        cutover: "job",
        ...extra,
      }),
    );
  }

  function mountMetadata(): void {
    metadataDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-jobmain-"));
    writeMetadata();
  }

  const env = (extra: Record<string, string> = {}) => ({
    EMIT_METADATA_PATH: path.join(metadataDir, "emit-metadata.json"),
    RELEASE_NAME: RELEASE,
    NAMESPACE: NS,
    ...extra,
  });

  beforeEach(() => {
    mountMetadata();
    vi.mocked(readState).mockResolvedValue(STATE);
  });
  afterEach(() => rmSync(metadataDir, { recursive: true, force: true }));

  it("records the FAILED promotion in the state ConfigMap and exits nonzero", async () => {
    vi.mocked(execCapture).mockImplementation(
      cluster({ rolloutFailsFor: `${RELEASE}-ssr-${BUILD}` }) as never,
    );

    expect(await jobMain(env())).not.toBe(0);

    // The record rides the EXISTING state body unchanged — a gate failure never moves the
    // build pointers — and is written cluster-CM-only.
    const [projectDir, body, releaseName, namespace, opts] = vi.mocked(writeState).mock.calls[0]!;
    expect(projectDir).toBe("/tmp");
    expect(body).toMatchObject({
      buildId: PREV,
      previousBuildId: "buildm0",
      failedPromotions: [BUILD],
      basedOnGeneration: 4,
    });
    expect(releaseName).toBe(RELEASE);
    expect(namespace).toBe(NS);
    expect(opts).toEqual({ clusterOnly: true });
  });

  it("REFUSES to re-promote a poisoned build — cheaply, before any HPA warm-up", async () => {
    vi.mocked(readState).mockResolvedValue({ ...STATE, failedPromotions: [BUILD] });
    vi.mocked(execCapture).mockImplementation(cluster() as never);

    expect(await jobMain(env())).toBe(3);

    // Cheap: no replica read, no warm-up, no gates — one short-lived pod per retry.
    expect(events.some((e) => e.startsWith("hpa-bounds:"))).toBe(false);
    expect(events.some((e) => e.startsWith("rollout:"))).toBe(false);
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("FORCE_PROMOTION overrides the pill deliberately (and only deliberately)", async () => {
    vi.mocked(readState).mockResolvedValue({ ...STATE, failedPromotions: [BUILD] });
    vi.mocked(execCapture).mockImplementation(cluster() as never);

    expect(await jobMain(env({ FORCE_PROMOTION: "true" }))).toBe(0);
    expect(events).toContain("patch:rel-ssr");

    // Anything other than the documented true/1 leaves the pill armed.
    events.length = 0;
    expect(await jobMain(env({ FORCE_PROMOTION: "yes-please" }))).toBe(3);
  });

  it("short-circuits an ALREADY promoted build without touching HPAs (§4.3)", async () => {
    // A re-applied pod (reconciler retry of an unrelated resource, `spec.force`) must log
    // and exit 0: re-running the gate battery on a Tuesday config tweak is noise, and
    // re-running the warm-up is a capacity wobble.
    vi.mocked(readState).mockResolvedValue({ ...STATE, buildId: BUILD });
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: BUILD, stderr: "" } as never);

    expect(await jobMain(env())).toBe(0);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    const verbs = vi.mocked(execCapture).mock.calls.map(([, a]) => (a as string[])[0]);
    expect(new Set(verbs)).toEqual(new Set(["get"]));
  });

  it("refuses a CROSS-WIRED bundle before touching anything", async () => {
    vi.mocked(execCapture).mockImplementation(cluster() as never);
    await expect(jobMain(env({ RELEASE_NAME: "other-release" }))).rejects.toThrow(
      /does not match the mounted emit-metadata/,
    );
    await expect(jobMain(env({ NAMESPACE: "other-ns" }))).rejects.toThrow(
      /Refusing to promote a cross-wired bundle/,
    );
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
  });

  it("REFUSES to promote a composed-target bundle whose composition plan ConfigMap is missing", async () => {
    writeMetadata({ hasPortableOrigin: true });
    vi.mocked(loadDeployedCompositionPlan).mockResolvedValue(null);
    vi.mocked(execCapture).mockImplementation(cluster() as never);
    await expect(jobMain(env())).rejects.toThrow(/Composition plan ConfigMap is missing/);
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
  });

  it("promotes a provider-ingress bundle WITHOUT a composition plan (none is rendered)", async () => {
    // helm.ts renders composition-plan.yaml only for compiledTarget bundles — an
    // unconditional refusal here would brick job mode for every provider-ingress release.
    vi.mocked(loadDeployedCompositionPlan).mockResolvedValue(null);
    vi.mocked(execCapture).mockImplementation(cluster() as never);
    expect(await jobMain(env())).toBe(0);
    expect(vi.mocked(loadDeployedCompositionPlan)).not.toHaveBeenCalled();
  });

  // The cutover marker lifecycle: the bundle stamps the stable Services
  // `adapter-k8s.io/cutover: pending`; the Job must CLEAR it once the promotion is
  // durable — a live object stuck at pending is indistinguishable from a Job that never
  // ran. A REMOVAL, not a "complete" value: SSA ownership is (manager, operation), so
  // both value-writing designs conflicted with helm's Apply re-stamp on the next sync
  // (kubectl-annotate's manager AND --field-manager=helm — "helm"+Update ≠
  // "helm"+Apply, both measured live). Updates ignore ownership and a removed field
  // has no owner, so the next sync's pending applies cleanly.
  function annotateCalls(): Array<string[]> {
    return vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => (a as string[])[0] === "annotate")
      .map(([, a]) => a as string[]);
  }

  it("CLEARS the stable Services' pending marker AFTER the promotion commits", async () => {
    vi.mocked(execCapture).mockImplementation(cluster() as never);

    expect(await jobMain(env())).toBe(0);

    // The trailing dash is kubectl's removal syntax — a value-writing form here is the
    // measured SSA conflict re-introduced.
    expect(annotateCalls()).toEqual([
      ["annotate", "service", `${RELEASE}-ssr`, "-n", NS, "adapter-k8s.io/cutover-"],
    ]);
    // AFTER the state commit — a failure between patch and commit must leave pending.
    const calls = vi.mocked(execCapture).mock.calls;
    const annotateIdx = calls.findIndex(([, a]) => (a as string[])[0] === "annotate");
    const patchIdx = calls.findIndex(
      ([, a]) => (a as string[])[0] === "patch" && (a as string[])[1] === "service",
    );
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(annotateIdx).toBeGreaterThan(patchIdx);
  });

  it("a clear failure is NON-FATAL — the promotion is already committed", async () => {
    const base = cluster();
    vi.mocked(execCapture).mockImplementation(((cmd: string, args: string[], opts: unknown) => {
      if (args[0] === "annotate") {
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "denied" });
      }
      return base(cmd, args, opts as never);
    }) as never);

    expect(await jobMain(env())).toBe(0);
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.map((c) => String(c[0]))
        .join("\n"),
    ).toContain("Could not clear the adapter-k8s.io/cutover: pending marker on rel-ssr");
  });

  it("a FAILED promotion never touches the marker (pending stays truthful)", async () => {
    vi.mocked(execCapture).mockImplementation(
      cluster({ rolloutFailsFor: `${RELEASE}-ssr-${BUILD}` }) as never,
    );

    expect(await jobMain(env())).not.toBe(0);
    expect(annotateCalls()).toEqual([]);
  });
});
