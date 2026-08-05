// tests/cli/deploy-orchestration.test.ts
// runDeploy orchestration tests: the whole blue/green flow with a scripted exec.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
// Only the two state FUNCTIONS are mocked: deploy branches on the real
// StateUnavailableError family (N20), so those classes must stay real.
vi.mock("../../src/cli/state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/state.js")>();
  return { ...actual, readState: vi.fn(), writeState: vi.fn() };
});
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("../../src/cli/rollback.js");
vi.mock("../../src/cli/doctor.js");
vi.mock("../../src/cli/provision-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/provision-cache.js")>();
  return { ...actual, provisionMemorystore: vi.fn() };
});
vi.mock("node:fs");

import { runDeploy, discoverServingBuildId } from "../../src/cli/deploy.js";
import { execCapture, execCaptureStdin, execOrThrow } from "../../src/cli/exec.js";
import {
  readState,
  writeState,
  ClusterStateReadError,
  StateDisagreementError,
} from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { retainLiveRoutingManifest, revertRoutingServiceToBuild } from "../../src/cli/rollback.js";
import { runDomainChecks } from "../../src/cli/doctor.js";
import { provisionMemorystore } from "../../src/cli/provision-cache.js";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { routingManifestSnapshotName } from "../../src/emit/templates/routing-manifest-configmap.js";
import { poolResourceNames } from "../../src/emit/templates/utils.js";
import { renderHPA } from "../../src/emit/templates/hpa.js";
import { cdnTagForBuildId } from "../../src/cdn-tags.js";
import {
  internalSecretName,
  legacyInternalSecretName,
} from "../../src/emit/templates/internal-secret.js";

const PROJECT = "/proj";
const RELEASE = "rel";
// Retained routing-manifest snapshot names (hashed — derive, never hardcode).
const SNAP_PREV = routingManifestSnapshotName(RELEASE, "buildm");
const SNAP_STALE = routingManifestSnapshotName(RELEASE, "oldx");
const REGISTRY = "us-central1-docker.pkg.dev/my-project/nextjs";
const infraPath = path.join(PROJECT, ".k8s-adapter", "infrastructure.json");
const metaPath = path.join(PROJECT, ".k8s-adapter", "output", "build-metadata.json");
const cdnFilter = path.join(
  PROJECT,
  ".k8s-adapter",
  "output",
  "chart",
  "templates",
  "cdn-http-filter.yaml",
);
const routeExtJobYaml = path.join(
  PROJECT,
  ".k8s-adapter",
  "output",
  "chart",
  "templates",
  "route-ext-update-job.yaml",
);

interface InfraFixture {
  projectId?: string;
  region?: string;
  containerRegistry?: string;
  cacheRegion?: string;
  namespace?: string;
}

const BASE_INFRA: InfraFixture = {
  projectId: "my-project",
  region: "us-central1",
  containerRegistry: REGISTRY,
};

// The pool set the scripted cluster answers for (pods, per-pool readiness). Recorded by
// setupFs from the build metadata so every call site stays a one-liner — N64's gate is
// per-pool, so the pods listing has to mirror the pools under test.
let fixturePools: string[] = ["ssr"];

function setupFs({
  infra = BASE_INFRA,
  metadata = { buildId: "buildn", pools: ["ssr"], cacheEnabled: false },
  cdn = true,
}: {
  infra?: InfraFixture;
  metadata?: Record<string, unknown>;
  cdn?: boolean;
} = {}) {
  fixturePools = Array.isArray(metadata.pools) ? (metadata.pools as string[]) : ["ssr"];
  vi.mocked(existsSync).mockImplementation(
    (p) => p === infraPath || p === metaPath || (cdn && p === cdnFilter) || p === routeExtJobYaml,
  );
  vi.mocked(readFileSync).mockImplementation((p) => {
    if (p === infraPath) return JSON.stringify(infra);
    if (p === metaPath) return JSON.stringify(metadata);
    return "";
  });
}

/**
 * What the previous build's LIVE Deployment reports — deliberately DIFFERENT from the new
 * build's `.Values` (a smaller pool, the shared-image repository, and the pre-/readyz
 * readiness path), so a retained render that resolved from `.Values` is detectable (N66).
 */
const DEFAULT_PREV_LIVE = {
  replicas: 2,
  image: `${REGISTRY}/nextjs-app-ssr:buildm`,
  cpu: "750m",
  memory: "1536Mi",
  ephemeralStorage: "3Gi",
  cpuLimit: "1500m",
  memoryLimit: "3Gi",
  readinessPath: "/healthz",
  // N87: a previous build deployed BEFORE per-build Secret names — it references the legacy
  // stable name, which the retained render must mirror rather than repoint.
  internalSecretRef: legacyInternalSecretName(RELEASE),
};

/**
 * Scripted cluster for a deploy where build "buildm" is serving and "buildn" lands.
 * `overrides` tweaks individual responses per test.
 */
function happyCluster(
  events: string[],
  overrides: {
    replicasProbeFails?: boolean;
    replicasProbeGone?: boolean; // NotFound: previous Deployment was deleted manually
    poolServiceMissing?: boolean; // N31: the pool is NEW in this build
    poolServiceProbeFails?: boolean;
    patchFailsFor?: string; // service name whose selector patch fails
    podsNeverReady?: boolean;
    // N20: active-Service discovery (used only when deploy state is unavailable).
    activeServices?: string; // jsonpath rows: name|component|versionSelector
    activeServicesFail?: boolean;
    servingImages?: string; // jsonpath rows: name|image
    // N66: the previous build's LIVE pod template, as the retained render must mirror it.
    prevLive?: Partial<typeof DEFAULT_PREV_LIVE>;
    // N64: the new build's rendered replica count, and how many of its pods are Ready.
    newBuildReplicas?: number;
    newBuildReplicasProbeFails?: boolean;
    podReplicas?: number;
    readyPerPool?: Record<string, number>;
    // N67: the chart-rendered HPA the new build's Deployment is bound to. `null` = the
    // pool has no HPA at all (autoscaling disabled). Default min 1 / max 3 mirrors
    // renderValuesYaml, and covers DEFAULT_PREV_LIVE.replicas so the common case needs
    // no widening at all.
    newBuildHpa?: { min?: number; max: number } | null;
    newBuildHpaReadFails?: boolean;
    newBuildHpaPatchFails?: boolean;
    // N87: internal dispatch Secret lifecycle. The legacy stable-named Secret (migrated past
    // helm upgrade), and the per-build ones the post-cutover sweep prunes.
    legacySecretPresent?: boolean;
    legacySecretProbeFails?: boolean;
    legacyAnnotateFails?: boolean;
    /** Names the `component=internal-secret` listing reports. */
    internalSecretsInCluster?: string[];
    /** Secret names the release's Deployments reference; `"invalid"` = unparseable output. */
    referencedSecrets?: string[] | "invalid" | "unreadable";
  } = {},
) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const j = args.join(" ");
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    // N87 (before the generic `secret` branch below, which answers the cache-Secret delete).
    if (args[0] === "get" && args[1] === "secret" && args.includes("--ignore-not-found")) {
      if (overrides.legacySecretProbeFails) {
        return { exitCode: 1, stdout: "", stderr: "Unable to connect to the server" };
      }
      const name = args[2]!;
      return overrides.legacySecretPresent ? ok(`secret/${name}\n`) : ok("");
    }
    if (args[0] === "annotate" && args[1] === "secret") {
      events.push(`annotate:${args[2]}:${args.find((a) => a.includes("resource-policy"))}`);
      if (overrides.legacyAnnotateFails) {
        return { exitCode: 1, stdout: "", stderr: "secrets is forbidden" };
      }
      return ok();
    }
    if (args[0] === "delete" && args[1] === "secret") {
      events.push(`delete-secret:${args[2]}`);
      return ok();
    }
    if (args.includes("secrets")) {
      return ok(`${(overrides.internalSecretsInCluster ?? []).join("\n")}\n`);
    }
    if (args.includes("deployments") && args.includes("json")) {
      if (overrides.referencedSecrets === "unreadable") {
        return { exitCode: 1, stdout: "", stderr: "Unable to connect to the server" };
      }
      if (overrides.referencedSecrets === "invalid") return ok("not json at all");
      const refs = overrides.referencedSecrets ?? [];
      return ok(
        JSON.stringify({
          items: [
            {
              spec: {
                template: {
                  spec: {
                    containers: [
                      {
                        env: [
                          { name: "NEXT_BUILD_ID", value: "buildn" },
                          ...refs.map((name) => ({
                            name: "INTERNAL_HEADER_SECRET",
                            valueFrom: { secretKeyRef: { name, key: "secret" } },
                          })),
                        ],
                      },
                    ],
                  },
                },
              },
            },
          ],
        }),
      );
    }
    if (args.includes("get-credentials")) {
      events.push("get-credentials");
      return ok();
    }
    // S23: image-digest pinning is fail-closed, so the harness must answer for it. Local
    // daemon knows the digest; the registry fallback is never reached on the happy path.
    if (args.includes("inspect") && j.includes("RepoDigests")) {
      const ref = args[args.length - 1]!;
      return ok(`${ref.slice(0, ref.lastIndexOf(":"))}@sha256:${"a".repeat(64)}\n`);
    }
    if (j.includes("clusterIpv4Cidr")) return ok("10.4.0.0/14\n");
    // S22: strict-posture node-range discovery — cluster subnetwork, then its primary
    // range, then any extra node-pool subnets (empty here: one subnet, like Autopilot).
    if (j.includes("value(subnetwork)")) return ok("default\n");
    if (j.includes("ipCidrRange")) return ok("10.128.0.0/20\n");
    if (args.includes("node-pools")) return ok("\n");
    if (args.includes("addresses") && args.includes("describe")) {
      return { exitCode: 1, stdout: "", stderr: "not found" }; // → create via execOrThrow
    }
    if (args.includes("crd")) return ok("gcphttpfilters.networking.gke.io\n");
    if (args.includes("secret")) return ok(""); // cache-disabled secret delete
    // N20: active-Service discovery for the unreadable-state recovery path.
    if (args.includes("svc")) {
      if (overrides.activeServicesFail) {
        return { exitCode: 1, stdout: "", stderr: "Unable to connect to the server" };
      }
      return ok(overrides.activeServices ?? "rel-ssr|ssr|buildm\n");
    }
    // N20: the serving build's raw id comes from the selected Deployment's image tag.
    if (args.includes("deployments") && j.includes("containers[0].image")) {
      return ok(overrides.servingImages ?? `rel-ssr-buildm|${REGISTRY}/nextjs-app-ssr:buildm\n`);
    }
    // N66: retained-manifest probe — ONE call returning name|replicas plus the live pod
    // template fields the retained render must reproduce (image, four quantities, readiness
    // path). The N64 capacity probe below asks the same resource with the SHORT jsonpath.
    if (j.includes("containers[0].image") && j.includes("{.spec.replicas}")) {
      if (overrides.replicasProbeGone) return ok("");
      if (overrides.replicasProbeFails) {
        return { exitCode: 1, stdout: "", stderr: "connection refused" };
      }
      const name = args[args.indexOf("deployment") + 1]!;
      const live = { ...DEFAULT_PREV_LIVE, ...overrides.prevLive };
      return ok(
        [
          name,
          String(live.replicas),
          live.image,
          live.cpu,
          live.memory,
          live.ephemeralStorage,
          live.cpuLimit,
          live.memoryLimit,
          live.readinessPath,
          live.internalSecretRef,
        ].join("|"),
      );
    }
    // N64: pre-cutover capacity probe on the NEW build's Deployment (short jsonpath).
    if (j.includes("jsonpath={.metadata.name}|{.spec.replicas}")) {
      if (overrides.newBuildReplicasProbeFails) {
        return { exitCode: 1, stdout: "", stderr: "connection refused" };
      }
      const name = args[args.indexOf("deployment") + 1]!;
      return ok(`${name}|${overrides.newBuildReplicas ?? 1}`);
    }
    // N31: pool-existed-before probe (stable active Service).
    if (args.includes("service") && args.includes("--ignore-not-found")) {
      if (overrides.poolServiceProbeFails) {
        return { exitCode: 1, stdout: "", stderr: "Unable to connect to the server" };
      }
      const svcName = args[args.indexOf("service") + 1]!;
      return overrides.poolServiceMissing ? ok("") : ok(`service/${svcName}\n`);
    }
    if (args.includes("configmaps")) {
      // Snapshot-pruning listing: previous build's snapshot + a stale one.
      return ok(`${SNAP_PREV}\n${SNAP_STALE}\n`);
    }
    if (args.includes("httproute")) return ok("GCPHTTPFilter");
    if (args.includes("wait")) return ok(""); // route-ext job
    if (args.includes("rollout")) {
      events.push(`rollout:${args.find((a) => a.startsWith("deployment/"))}`);
      return ok();
    }
    if (args.includes("pods")) {
      // Health gate + diagnostics. The gate's jsonpath asks for name|Ready|component
      // (N64 counts ready pods PER POOL); the diagnostics one asks name|phase.
      // NOTE: the real jsonpath escapes the dots (`app\.kubernetes\.io/component`).
      const wantsComponent = j.includes("/component}");
      const ready = overrides.podsNeverReady ? "False" : "True";
      const rows = fixturePools.flatMap((pool) => {
        // Default: the count deploy asks for at 7a-ter — the outgoing build's live
        // replicas (N64 scales the new build up to match before the gate).
        const count =
          overrides.readyPerPool?.[pool] ?? overrides.podReplicas ?? DEFAULT_PREV_LIVE.replicas;
        return Array.from({ length: count }, (_, i) =>
          wantsComponent
            ? `rel-${pool}-buildn-abc${i}|${ready}|${pool}`
            : `rel-${pool}-buildn-abc${i}|${overrides.podsNeverReady ? "Pending" : "Running"}`,
        );
      });
      return ok(`${rows.join("\n")}\n`);
    }
    // N67: the new build's HPA — read (min|max), widened for the warm-up, restored after.
    // MUST come before the generic `patch` branch below, which assumes a Service.
    if (args.includes("hpa")) {
      const hpaName = args[args.indexOf("hpa") + 1]!;
      if (args.includes("patch")) {
        const body = JSON.parse(args[args.length - 1]!) as {
          spec: { maxReplicas?: number; minReplicas?: number };
        };
        events.push(`hpa-max:${hpaName}:${body.spec.maxReplicas}`);
        if (overrides.newBuildHpaPatchFails) {
          return { exitCode: 1, stdout: "", stderr: "hpa patch denied by webhook" };
        }
        return ok();
      }
      if (args.includes("delete")) return ok(""); // 7f parks the previous build
      if (overrides.newBuildHpaReadFails) {
        return { exitCode: 1, stdout: "", stderr: "connection refused" };
      }
      if (overrides.newBuildHpa === null) return ok(""); // --ignore-not-found: absent
      const min = overrides.newBuildHpa?.min ?? 1;
      const max = overrides.newBuildHpa?.max ?? 3;
      return ok(`${hpaName}|${min}|${max}`);
    }
    if (args.includes("patch")) {
      const svc = args[args.indexOf("service") + 1]!;
      events.push(`patch:${svc}`);
      if (svc === overrides.patchFailsFor) {
        return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
      }
      return ok();
    }
    if (args.includes("scale")) {
      // Two different scales exist now: N64's pre-cutover capacity match on the NEW build,
      // and 7f's park-the-previous-build-at-zero. Event names keep them apart so the
      // "nothing was scaled down" assertions on abort paths stay meaningful.
      const target = args.find((a) => a.startsWith("deployment/"));
      events.push(args.includes("--replicas=0") ? `scale:${target}` : `scaleup:${target}`);
      return ok();
    }
    if (args.includes("deployments")) {
      // New-build discovery has a version= label; the cleanup list does not.
      if (j.includes("version=")) return ok("rel-ssr-buildn\nrel-routing-service\n");
      return ok("rel-ssr-buildn\nrel-ssr-buildm\nrel-routing-service\n");
    }
    if (args.includes("deployment") && args.includes("rel-routing-service")) {
      return ok("deployment.apps/rel-routing-service\n"); // 7a-bis existence probe
    }
    if (args.includes("jobs")) return ok("");
    if (args.includes("exec")) return ok("200 OK");
    if (args.includes("logs")) return ok("");
    return ok();
  });
}

describe("runDeploy — orchestration", () => {
  let events: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    setupFs();
    vi.mocked(execOrThrow).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "helm") events.push("helm");
      if (args.includes("get-credentials")) events.push("get-credentials");
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildm",
      previousBuildId: "buildm0",
    } as never);
    vi.mocked(writeState).mockImplementation((async () => {
      events.push("writeState");
    }) as never);
    vi.mocked(invalidateCdnBuildTag).mockImplementation((async () => {
      events.push("cdn-invalidate");
    }) as never);
    vi.mocked(retainLiveRoutingManifest).mockImplementation((async () => {
      events.push("retain-routing-manifest");
      return { status: "retained", snapshotName: SNAP_PREV };
    }) as never);
    vi.mocked(runDomainChecks).mockResolvedValue(undefined as never);
    vi.mocked(provisionMemorystore).mockResolvedValue({ host: "10.0.0.1", port: 6379 } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("happy path: build → push → helm → rollout → health → selector patch → state commit → CDN invalidate → previous scaled down, in that order", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const order = [
      "get-credentials",
      "retain-routing-manifest",
      "helm",
      "rollout:deployment/rel-ssr-buildn",
      "rollout:deployment/rel-routing-service",
      "patch:rel-ssr",
      "writeState",
      "cdn-invalidate",
      "scale:deployment/rel-ssr-buildm",
    ];
    const positions = order.map((e) => events.indexOf(e));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // State committed with the swapped builds, recording the new build's CDN tag (M13).
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        cdnTags: { buildn: cdnTagForBuildId("buildn") },
        // The build just installed serves /readyz, so the NEXT deploy may flip the load
        // balancer's HealthCheckPolicy to readiness without stranding it.
        readinessPathSupported: true,
        // S23: the routing image is now pinned to its digest on every path (the harness's
        // `docker inspect` answers, as a real daemon does after a push), so state records it.
        routingImageDigests: { buildn: `sha256:${"a".repeat(64)}` },
        // N69: the floor writeState stamps above — the prior state carried no generation.
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
    // CDN invalidated for the OUTGOING build. Prior state (legacy) recorded no tag for
    // it, so no recordedTag is passed — cdn-invalidate falls back to the full purge (M13).
    expect(vi.mocked(invalidateCdnBuildTag)).toHaveBeenCalledWith(
      expect.objectContaining({
        buildId: "buildm",
        releaseName: RELEASE,
        projectId: "my-project",
        recordedTag: undefined,
      }),
    );
    // Helm pinned to the namespace init binds Workload Identity to.
    const helmCall = vi.mocked(execOrThrow).mock.calls.find(([cmd]) => cmd === "helm");
    expect(helmCall?.[1].join(" ")).toContain("--namespace default --create-namespace");
    // Docker push happened for the pool and the routing service.
    const dockerCalls = vi
      .mocked(execOrThrow)
      .mock.calls.filter(([cmd]) => cmd === "docker")
      .map(([, a]) => a.join(" "));
    expect(dockerCalls.some((a) => a.includes(`nextjs-app-ssr:buildn`))).toBe(true);
    expect(dockerCalls.some((a) => a.includes(`routing-service:buildn`))).toBe(true);
    // Health gate scoped pool pods by exact component label, not a name substring.
    const podsQuery = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("pods") && a.some((x) => x.includes("version=")));
    expect(podsQuery?.[1].join(" ")).toContain("app.kubernetes.io/component!=routing-service");
    // The routing deployment was NOT rollout-waited by the POOL loop (exact-name exclusion):
    // it appears exactly once — from the dedicated 7a-bis check.
    expect(events.filter((e) => e === "rollout:deployment/rel-routing-service")).toHaveLength(1);
    // Cleanup never deletes the routing deployment.
    const deletes = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a.includes("delete"))
      .map(([, a]) => a.join(" "));
    expect(deletes.some((a) => a.includes("deployment rel-routing-service"))).toBe(false);
    // Post-deploy health checks ran.
    expect(vi.mocked(runDomainChecks)).toHaveBeenCalledWith({
      projectDir: PROJECT,
      releaseName: RELEASE,
    });
  });

  it("new build never healthy: no selector patch, no state commit, non-zero exit, previous keeps serving", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { podsNeverReady: true }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(events).not.toContain("writeState");
    expect(events).not.toContain("cdn-invalidate");
    expect(events.some((e) => e.startsWith("scale:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    const printed = vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("did not become healthy within 2 minutes");
    // N25: the claim is now scoped to the POOLS — the ext_proc edge went to the new build
    // at `helm upgrade` and is reported separately (see the N25 suite below).
    expect(printed).toContain("previous build's pools are still serving");
  });

  it("selector patch failure: reverts the successful patches, no state commit, non-zero exit", async () => {
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { patchFailsFor: "rel-api" }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/process\.exit:1/);

    // rel-ssr was patched to buildn, then reverted back to buildm after rel-api failed.
    const patchCalls = vi
      .mocked(execCapture)
      .mock.calls.filter(
        ([, a]) => a.includes("patch") && a.includes("service") && a.includes("rel-ssr"),
      );
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]![1].join(" ")).toContain('"value":"buildn"');
    expect(patchCalls[1]![1].join(" ")).toContain('"value":"buildm"');
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(vi.mocked(invalidateCdnBuildTag)).not.toHaveBeenCalled();
    expect(events.some((e) => e.startsWith("scale:"))).toBe(false);
  });

  it("dry-run: prints the plan and mutates nothing", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true, dryRun: true });

    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
    expect(vi.mocked(execOrThrow)).not.toHaveBeenCalled();
    expect(vi.mocked(execCaptureStdin)).not.toHaveBeenCalled();
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(vi.mocked(invalidateCdnBuildTag)).not.toHaveBeenCalled();
    expect(vi.mocked(retainLiveRoutingManifest)).not.toHaveBeenCalled();
    // Local state only (no cluster ConfigMap read) — no releaseName passed.
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT);
    const printed = vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(printed).toContain("[dry-run] helm upgrade");
    expect(printed).toContain("--namespace default --create-namespace");
  });
});

describe("runDeploy — guards and teardown", () => {
  let events: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    setupFs();
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildm",
      previousBuildId: "buildm0",
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(retainLiveRoutingManifest).mockResolvedValue({
      status: "no-routing-tier",
    } as never);
    vi.mocked(runDomainChecks).mockResolvedValue(undefined as never);
    vi.mocked(provisionMemorystore).mockResolvedValue({ host: "10.0.0.1", port: 6379 } as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects a pool named exactly routing-service (reserved routing-tier name)", async () => {
    setupFs({
      metadata: { buildId: "buildn", pools: ["routing-service"], cacheEnabled: false },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/reserved for the routing tier/);
    expect(events).not.toContain("helm");
  });

  it("exact-name filtering: a pool named routing-service-extra is rollout-waited like any pool", async () => {
    setupFs({
      metadata: { buildId: "buildn", pools: ["ssr", "routing-service-extra"], cacheEnabled: false },
    });
    const cluster = happyCluster(events);
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      const j = args.join(" ");
      if (args.includes("deployments") && j.includes("version=")) {
        return {
          exitCode: 0,
          stdout: "rel-ssr-buildn\nrel-routing-service-extra-buildn\nrel-routing-service\n",
          stderr: "",
        };
      }
      return cluster(cmd, args);
    }) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    // The old substring filter would have skipped this pool's rollout wait entirely.
    expect(events).toContain("rollout:deployment/rel-routing-service-extra-buildn");
    expect(events).toContain("rollout:deployment/rel-ssr-buildn");
    expect(events).toContain("patch:rel-routing-service-extra");
  });

  it("aborts when the previous build's replica-count probe fails (no silent default to 2)", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { replicasProbeFails: true }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/replica count/);
    expect(events).not.toContain("helm");
  });

  it("self-heals when the previous Deployment is NotFound: warns, renders default replicas, deploy proceeds", async () => {
    // Regression: the retention probe aborted on ANY kubectl failure, including
    // NotFound (state names a build whose Deployment was deleted manually), which
    // bricked every future deploy of the release. N31: the pool's stable active Service
    // still exists, which is what proves the pool existed in the previous build.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { replicasProbeGone: true }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    // The deploy completed: cutover happened and state was committed.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        cdnTags: { buildn: cdnTagForBuildId("buildn") },
        // The build just installed serves /readyz, so the NEXT deploy may flip the load
        // balancer's HealthCheckPolicy to readiness without stranding it.
        readinessPathSupported: true,
        // S23: the routing image is now pinned to its digest on every path (the harness's
        // `docker inspect` answers, as a real daemon does after a push), so state records it.
        routingImageDigests: { buildn: `sha256:${"a".repeat(64)}` },
        // N69: the floor writeState stamps above — the prior state carried no generation.
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
    // A loud warning named the missing deployment...
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.some(
          (c) => String(c[0]).includes("rel-ssr-buildm") && String(c[0]).includes("not found"),
        ),
    ).toBe(true);
    // ...and the retained manifest fell back to the default replica count.
    const prevDeploymentWrite = vi
      .mocked(writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith("ssr-prev-deployment.yaml"));
    expect(prevDeploymentWrite).toBeDefined();
    expect(String(prevDeploymentWrite![1])).toContain("replicas: 2");
  });

  it("aborts when COMPOSED truncated names collide even though the bare build ids differ", async () => {
    // A long release+pool prefix pushes the differing tail of the build id past the
    // 63-char boundary: sanitizeK8sName(buildId) differs, but every composed resource
    // name is identical — the old bare-build-id guard waved this through.
    const longRelease = "a".repeat(40);
    const longPool = "p".repeat(20);
    setupFs({ metadata: { buildId: "build-one", pools: [longPool], cacheEnabled: false } });
    vi.mocked(readState).mockResolvedValue({
      buildId: "build-two",
      previousBuildId: null,
    } as never);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: longRelease, skipBuild: true }),
    ).rejects.toThrow(/collides with the currently-serving build/);
    expect(events).not.toContain("helm");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("--skip-build with pre-cacheManaged artifacts: cacheEnabled without cacheManaged is treated as MANAGED (no teardown)", async () => {
    // Regression: metadata from an older adapter version carries cacheEnabled but no
    // cacheManaged flag; the teardown branch then deleted a LIVE managed Memorystore.
    setupFs({
      infra: { ...BASE_INFRA, cacheRegion: "us-central1" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: true },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const calls = vi.mocked(execCapture).mock.calls.map(([, a]) => a.join(" "));
    expect(calls.some((a) => a.includes("redis instances delete"))).toBe(false);
    expect(calls.some((a) => a.includes("delete secret"))).toBe(false);
    // Managed path taken instead (idempotent re-provision of the existing instance).
    expect(vi.mocked(provisionMemorystore)).toHaveBeenCalled();
  });

  it("prunes routing-manifest snapshots that belong to neither the current nor previous build", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const deletes = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a.includes("delete") && a.includes("configmap"))
      .map(([, a]) => a.join(" "));
    // Stale snapshot deleted; the previous build's (rollback target) kept.
    expect(deletes.some((a) => a.includes(SNAP_STALE))).toBe(true);
    expect(deletes.some((a) => a.includes(SNAP_PREV))).toBe(false);
    // The listing was scoped to this release's snapshot ConfigMaps.
    const listing = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("configmaps"))![1]
      .join(" ");
    expect(listing).toContain("app.kubernetes.io/component=routing-manifest-snapshot");
    expect(listing).toContain("app.kubernetes.io/managed-by=adapter-k8s");
  });

  it("fails fast when a pool rollout status fails (exit code is not discarded)", async () => {
    const cluster = happyCluster(events);
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.includes("rollout") && args.some((a) => a === "deployment/rel-ssr-buildn")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "error: deployment exceeded its progress deadline",
        };
      }
      return cluster(cmd, args);
    }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/did not finish rolling out within 120s/);
    // No selector patch, no state commit — the previous build keeps serving.
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("aborts on a sanitized build-id collision with the serving build", async () => {
    setupFs({ metadata: { buildId: "abc", pools: ["ssr"], cacheEnabled: false } });
    vi.mocked(readState).mockResolvedValue({
      buildId: "abc-", // sanitizes to "abc" — identical to the new build's label
      previousBuildId: "abc0",
    } as never);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/collides with the currently-serving build/);
    expect(events).not.toContain("helm");
  });

  it("uses a custom namespace for Helm, cluster state, and routing retention", async () => {
    setupFs({
      infra: { ...BASE_INFRA, namespace: "prod" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: false, namespace: "prod" },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const helmCall = vi.mocked(execOrThrow).mock.calls.find(([cmd]) => cmd === "helm");
    expect(helmCall?.[1].join(" ")).toContain("--namespace prod --create-namespace");
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT, RELEASE, { namespace: "prod" });
    expect(vi.mocked(retainLiveRoutingManifest)).toHaveBeenCalledWith(RELEASE, "prod");
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ buildId: "buildn", previousBuildId: "buildm" }),
      RELEASE,
      "prod",
    );
  });

  it("refuses build output emitted for a different namespace", async () => {
    setupFs({
      infra: { ...BASE_INFRA, namespace: "prod" },
      metadata: {
        buildId: "buildn",
        pools: ["ssr"],
        cacheEnabled: false,
        namespace: "staging",
      },
    });

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/emitted for namespace "staging".*targets "prod"/s);
    expect(events).not.toContain("helm");
  });

  it("treats legacy build output with no namespace as default", async () => {
    setupFs({
      infra: { ...BASE_INFRA, namespace: "prod" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: false },
    });

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/emitted for namespace "default".*targets "prod"/s);
    expect(events).not.toContain("helm");
  });

  it("rejects malformed namespace metadata instead of bypassing the fingerprint", async () => {
    setupFs({
      infra: { ...BASE_INFRA, namespace: "prod" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: false, namespace: 123 },
    });

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Invalid namespace/);
    expect(events).not.toContain("helm");
  });

  it('accepts an explicit namespace of "default" in infrastructure.json', async () => {
    setupFs({ infra: { ...BASE_INFRA, namespace: "default" } });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        cdnTags: { buildn: cdnTagForBuildId("buildn") },
        // The build just installed serves /readyz, so the NEXT deploy may flip the load
        // balancer's HealthCheckPolicy to readiness without stranding it.
        readinessPathSupported: true,
        // S23: the routing image is now pinned to its digest on every path (the harness's
        // `docker inspect` answers, as a real daemon does after a push), so state records it.
        routingImageDigests: { buildn: `sha256:${"a".repeat(64)}` },
        // N69: the floor writeState stamps above — the prior state carried no generation.
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("M13: passes the outgoing build's RECORDED tag to invalidation and carries it in state", async () => {
    // Prior state recorded the tag buildm's pods actually stamp (possibly under an older
    // derivation — deliberately not cdnTagForBuildId("buildm")). Cutover must hand that
    // exact value to cdn-invalidate and keep it recorded while buildm remains the
    // rollback target.
    const recordedPrev = `build-${"cd".repeat(32)}`;
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildm",
      previousBuildId: "buildm0",
      cdnTags: { buildm: recordedPrev },
    } as never);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(vi.mocked(invalidateCdnBuildTag)).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildm", recordedTag: recordedPrev }),
    );
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        // Carried verbatim + the new build's own recording; buildm0 pruned (out of play).
        cdnTags: { buildm: recordedPrev, buildn: cdnTagForBuildId("buildn") },
        readinessPathSupported: true,
        // S23: the routing image is now pinned to its digest on every path (the harness's
        // `docker inspect` answers, as a real daemon does after a push), so state records it.
        routingImageDigests: { buildn: `sha256:${"a".repeat(64)}` },
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });

  it("scale-down deletes the TEMPLATE-named HPA when the composed base exceeds the 59-char boundary", async () => {
    // 30-char release + "-ssr-" + 30-char build ids: deployment names truncate at 63,
    // HPA names at 59 (suffix reserved inside the cap, hpa.ts). The old
    // `${deployment}-hpa` reconstruction produced an invalid 67-char name, the delete
    // silently missed the real HPA, and the autoscaler rescaled the parked build.
    const longRelease = "r".repeat(30);
    const prevBuild = "buildm" + "x".repeat(24);
    const newBuild = "buildn" + "x".repeat(24);
    setupFs({ metadata: { buildId: newBuild, pools: ["ssr"], cacheEnabled: false } });
    vi.mocked(readState).mockResolvedValue({
      buildId: prevBuild,
      previousBuildId: null,
    } as never);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: longRelease, skipBuild: true });

    const prevNames = poolResourceNames(longRelease, "ssr", prevBuild);
    // Guard the fixture's premise: this IS the divergent long-name case.
    expect(`${prevNames.deployment}-hpa`).not.toBe(prevNames.hpa);
    const hpaDeletes = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a.includes("delete") && a.includes("hpa"))
      .map(([, a]) => a as string[]);
    // The delete targeted the name renderHPA stamped — cross-checked against the
    // actual template output, not just the helper.
    const renderedHpaName = renderHPA({
      poolName: "ssr",
      buildId: prevBuild,
      releaseName: longRelease,
    }).match(/^\s*name: (\S+)/m)![1];
    expect(prevNames.hpa).toBe(renderedHpaName);
    expect(hpaDeletes.some((a) => a.includes(prevNames.hpa))).toBe(true);
    // No call anywhere used the invalid 67-char concatenation.
    const allArgs = vi.mocked(execCapture).mock.calls.flatMap(([, a]) => a as string[]);
    expect(allArgs).not.toContain(`${prevNames.deployment}-hpa`);
    // The deployment itself was still scaled to 0 under its own (63-char) name.
    expect(events).toContain(`scale:deployment/${prevNames.deployment}`);
  });

  it("fails with an actionable message when containerRegistry is missing", async () => {
    setupFs({ infra: { projectId: "my-project", region: "us-central1" } });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/missing containerRegistry.*adapter-k8s init/s);
  });

  it("names the file when infrastructure.json is malformed", async () => {
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return "{not json";
      if (p === metaPath) return '{"buildId":"buildn","pools":["ssr"]}';
      return "";
    });
    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(new RegExp(`Failed to parse ${infraPath.replace(/[/.]/g, "\\$&")}`));
  });

  it("managed→BYO: tears down the previously provisioned Memorystore and clears cacheRegion", async () => {
    setupFs({
      infra: { ...BASE_INFRA, cacheRegion: "us-central1" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: true, cacheManaged: false },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const calls = vi.mocked(execCapture).mock.calls.map(([, a]) => a.join(" "));
    expect(calls.some((a) => a.includes("redis instances delete rel-cache"))).toBe(true);
    // The BYO Secret is helm-owned — the imperative secret delete must NOT run.
    expect(calls.some((a) => a.includes("delete secret"))).toBe(false);
    // cacheRegion was cleared from infrastructure.json.
    const infraWrites = vi
      .mocked(writeFileSync)
      .mock.calls.filter(([p]) => p === infraPath)
      .map(([, content]) => String(content));
    expect(infraWrites.length).toBeGreaterThan(0);
    expect(infraWrites[infraWrites.length - 1]).not.toContain("cacheRegion");
    expect(vi.mocked(provisionMemorystore)).not.toHaveBeenCalled();
  });

  it("cache disabled: removes the Secret AND the managed instance (regression)", async () => {
    setupFs({
      infra: { ...BASE_INFRA, cacheRegion: "us-east1" },
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: false, cacheManaged: false },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const calls = vi.mocked(execCapture).mock.calls.map(([, a]) => a.join(" "));
    expect(calls.some((a) => a.includes("delete secret rel-valkey"))).toBe(true);
    expect(
      calls.some((a) => a.includes("redis instances delete rel-cache") && a.includes("us-east1")),
    ).toBe(true);
  });

  it("BYO from the start (no cacheRegion): no teardown of anything", async () => {
    setupFs({
      metadata: { buildId: "buildn", pools: ["ssr"], cacheEnabled: true, cacheManaged: false },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const calls = vi.mocked(execCapture).mock.calls.map(([, a]) => a.join(" "));
    expect(calls.some((a) => a.includes("redis instances delete"))).toBe(false);
    expect(calls.some((a) => a.includes("delete secret"))).toBe(false);
  });
});

/** Shared setup for the review-fix suites below (same shape as "guards and teardown"). */
function standardBeforeEach(events: string[]): void {
  vi.clearAllMocks();
  setupFs();
  vi.mocked(execOrThrow).mockImplementation((async (cmd: string, args: string[]) => {
    if (cmd === "helm") events.push("helm");
    if (args.includes("get-credentials")) events.push("get-credentials");
    return { exitCode: 0, stdout: "", stderr: "" };
  }) as never);
  vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
  vi.mocked(readState).mockResolvedValue({
    buildId: "buildm",
    previousBuildId: "buildm0",
  } as never);
  vi.mocked(writeState).mockImplementation((async () => {
    events.push("writeState");
  }) as never);
  vi.mocked(invalidateCdnBuildTag).mockImplementation((async () => {
    events.push("cdn-invalidate");
  }) as never);
  vi.mocked(retainLiveRoutingManifest).mockImplementation((async () => {
    events.push("retain-routing-manifest");
    return { status: "retained", snapshotName: SNAP_PREV };
  }) as never);
  vi.mocked(revertRoutingServiceToBuild).mockImplementation((async () => {
    events.push("revert-edge");
  }) as never);
  vi.mocked(runDomainChecks).mockResolvedValue(undefined as never);
  vi.mocked(provisionMemorystore).mockResolvedValue({ host: "10.0.0.1", port: 6379 } as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${code}`);
  }) as never);
}

const printedErrors = (): string =>
  vi
    .mocked(console.error)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
const printedLogs = (): string =>
  vi
    .mocked(console.log)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
const printedWarnings = (): string =>
  vi
    .mocked(console.warn)
    .mock.calls.map((c) => String(c[0]))
    .join("\n");
const helmArgLine = (): string =>
  vi
    .mocked(execOrThrow)
    .mock.calls.find(([cmd]) => cmd === "helm")?.[1]
    .join(" ") ?? "";

describe("runDeploy — N20: unreadable deploy state must never read as a first deploy", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("recovers the SERVING build from the active Service selector and retains it", async () => {
    // The outage: readClusterState returned null for every failure, so one transient
    // kubectl/RBAC error made previousBuildId null → no retained manifest injection (helm
    // DELETES the serving Deployment) and activeBuildId = the new build (Service repointed
    // at a build with zero ready pods, minutes before the health gate).
    vi.mocked(readState).mockRejectedValue(
      new ClusterStateReadError("kubectl exited 1: Unable to connect to the server"),
    );
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    // helm was told about the live build, not "no previous build".
    expect(helmArgLine()).toContain("previousBuildId=buildm");
    expect(helmArgLine()).toContain("activeBuildId=buildm");
    // ...and the serving build's Deployment was retained so helm cannot prune it.
    const retained = vi
      .mocked(writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith("ssr-prev-deployment.yaml"));
    expect(retained).toBeDefined();
    expect(printedWarnings()).toContain('Recovered the currently-serving build "buildm"');
  });

  it("aborts (no helm) when the live build cannot be discovered", async () => {
    vi.mocked(readState).mockRejectedValue(new ClusterStateReadError("kubectl exited 1"));
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { activeServicesFail: true }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/active Services could not be listed/);
    expect(events).not.toContain("helm");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("aborts when no active Service carries a version selector", async () => {
    vi.mocked(readState).mockRejectedValue(new ClusterStateReadError("kubectl exited 1"));
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { activeServices: "rel-ssr|ssr|\n" }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Refusing to deploy as if this were a first deploy/);
    expect(events).not.toContain("helm");
  });

  it("aborts when the selected build has no Deployment (release already broken)", async () => {
    vi.mocked(readState).mockRejectedValue(new ClusterStateReadError("kubectl exited 1"));
    vi.mocked(execCapture).mockImplementation(happyCluster(events, { servingImages: "" }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/NO Deployment carries it/);
    expect(events).not.toContain("helm");
  });

  it("aborts when active Services select DIFFERENT builds (traffic already split)", async () => {
    vi.mocked(readState).mockRejectedValue(new ClusterStateReadError("kubectl exited 1"));
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        activeServices: "rel-ssr|ssr|buildm\nrel-api|api|buildx\n",
      }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/select DIFFERENT builds/);
    expect(events).not.toContain("helm");
  });

  it("N21: a cluster/local state disagreement is also 'unknown', not 'first deploy'", async () => {
    vi.mocked(readState).mockRejectedValue(
      new StateDisagreementError("cluster says A, local says B"),
    );
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(helmArgLine()).toContain("previousBuildId=buildm");
  });

  it("discoverServingBuildId ignores per-build Services and the routing tier", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        // A per-build Service (name != <release>-<pool>) selecting an OLD build, plus the
        // routing tier, must not be mistaken for the active Service.
        activeServices:
          "rel-ssr-buildold|ssr|buildold\nrel-routing-service|routing-service|buildn\nrel-ssr|ssr|buildm\n",
      }) as never,
    );

    await expect(discoverServingBuildId(RELEASE)).resolves.toBe("buildm");
  });

  it("discoverServingBuildId rejects an image tag that does not match the selector", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        servingImages: `rel-ssr-buildm|${REGISTRY}/nextjs-app-ssr:someotherbuild\n`,
      }) as never,
    );

    await expect(discoverServingBuildId(RELEASE)).rejects.toThrow(
      /does not sanitize to the active/,
    );
  });
});

describe("runDeploy — N25: every post-helm abort puts the ext_proc edge back", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("health-gate failure reverts the routing tier to the previous build and says so", async () => {
    // helm overwrites the stable <release>-routing-manifest ConfigMap the routing
    // Deployment mounts BY NAME, so after helm the edge runs the NEW build's
    // middleware/manifest even if no routing pod rolled. The old message asserted the
    // opposite ("No cutover performed") and left the skew in place indefinitely.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { podsNeverReady: true }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(vi.mocked(revertRoutingServiceToBuild)).toHaveBeenCalledWith({
      releaseName: RELEASE,
      namespace: "default",
      targetBuildId: "buildm",
      registry: REGISTRY,
      targetImageDigest: undefined,
    });
    expect(printedErrors()).toContain("reverted to build buildm");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("names the edge's ACTUAL state (and the recovery command) when the revert also fails", async () => {
    vi.mocked(revertRoutingServiceToBuild).mockRejectedValue(new Error("field manager conflict"));
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { podsNeverReady: true }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const out = printedErrors();
    expect(out).toContain("could not revert the routing edge to build buildm");
    expect(out).toContain("is running build buildn's middleware");
    expect(out).toContain("kubectl -n default set image deployment/rel-routing-service");
    expect(out).not.toContain("reverted to build buildm, so edge and pools are consistent");
  });

  it("a failed pool rollout reverts the edge and scopes the claim to the pools", async () => {
    const cluster = happyCluster(events);
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.includes("rollout") && args.some((a) => a === "deployment/rel-ssr-buildn")) {
        return { exitCode: 1, stdout: "", stderr: "progress deadline exceeded" };
      }
      return cluster(cmd, args);
    }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/previous build's pools are still serving[\s\S]*reverted to build buildm/);
    expect(events).toContain("revert-edge");
  });

  it("a failed ext_proc registration job reverts the edge", async () => {
    const cluster = happyCluster(events);
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.includes("wait")) return { exitCode: 1, stdout: "", stderr: "timed out" };
      return cluster(cmd, args);
    }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/registration job/);
    expect(events).toContain("revert-edge");
  });

  it("a selector-patch failure restores the Services FIRST, then the edge", async () => {
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { patchFailsFor: "rel-api" }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/process\.exit:1/);

    // The service selector restore (a second patch of rel-ssr) precedes the edge revert.
    const lastPatch = events.lastIndexOf("patch:rel-ssr");
    expect(lastPatch).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("revert-edge")).toBeGreaterThan(lastPatch);
  });

  it("does NOT touch the edge when there is no previous build (genuine first deploy)", async () => {
    vi.mocked(readState).mockResolvedValue(null as never);
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { podsNeverReady: true }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(vi.mocked(revertRoutingServiceToBuild)).not.toHaveBeenCalled();
  });
});

describe("runDeploy — N28/N31: retained-manifest classification without free-text errors", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => vi.restoreAllMocks());

  it('aborts on a kubectl failure whose stderr merely CONTAINS "404" (never scales a serving build to 2)', async () => {
    // isAlreadyGoneError matches a bare "404" anywhere in stderr, so a proxy/auth error
    // took the "nothing is serving" branch and the retained manifest scaled a build
    // serving N≫2 down to 2 mid-deploy.
    const cluster = happyCluster(events);
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.join(" ").includes("jsonpath={.metadata.name}|{.spec.replicas}")) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'Error from server: error dialing backend: 404 page not found ("no such host")',
        };
      }
      return cluster(cmd, args);
    }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Could not read the live replica count/);
    expect(events).not.toContain("helm");
    // Nothing was rendered at the dangerous default.
    expect(vi.mocked(writeFileSync).mock.calls.some(([p]) => String(p).includes("-prev-"))).toBe(
      false,
    );
  });

  it("renders NO retained resources for a pool that is new in this build", async () => {
    // The previous build had only "ssr". Rendering a retained Deployment for "api" used
    // imageTag: previousBuildId — a tag never built → ImagePullBackOff for the whole
    // deploy, and it turned the next rollback's clean abort into a 120 s timeout.
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    // ssr ran 3 replicas in the previous build; the gate (N64) therefore needs 3 ready ssr
    // pods, and "api" contributes no expectation at all because it did not exist.
    const cluster = happyCluster(events, {
      prevLive: { replicas: 3 },
      readyPerPool: { ssr: 3, api: 1 },
    });
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      const j = args.join(" ");
      // The retained probe (long jsonpath) for the pool that is ABSENT in the previous
      // build: exit 0 + empty stdout, the --ignore-not-found absence signal.
      if (j.includes("containers[0].image") && j.includes("{.spec.replicas}")) {
        const name = args[args.indexOf("deployment") + 1];
        if (name !== "rel-ssr-buildm") return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args.includes("service") && args.includes("--ignore-not-found")) {
        const name = args[args.indexOf("service") + 1];
        return name === "rel-api"
          ? { exitCode: 0, stdout: "", stderr: "" } // no active Service ⇒ brand-new pool
          : { exitCode: 0, stdout: `service/${name}\n`, stderr: "" };
      }
      return cluster(cmd, args);
    }) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const retainedFiles = vi
      .mocked(writeFileSync)
      .mock.calls.map(([p]) => String(p))
      .filter((p) => p.includes("-prev-"));
    expect(retainedFiles.some((p) => p.endsWith("ssr-prev-deployment.yaml"))).toBe(true);
    expect(retainedFiles.some((p) => p.includes("api-prev-"))).toBe(false);
    expect(printedLogs()).toContain('Pool "api" is new in this build');
    // The pool that DID exist was still retained at its live count.
    const ssrDeployment = vi
      .mocked(writeFileSync)
      .mock.calls.find(([p]) => String(p).endsWith("ssr-prev-deployment.yaml"))!;
    expect(String(ssrDeployment[1])).toContain("replicas: 3");
  });

  it("aborts when the pool-existed-before probe itself fails", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { replicasProbeGone: true, poolServiceProbeFails: true }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Could not determine whether pool "ssr" existed in the previous build/);
    expect(events).not.toContain("helm");
  });
});

describe("runDeploy — N29: an unpinnable kubectl context is confirmed, not silently used", () => {
  let events: string[];
  const NO_CONTEXT_INFRA: InfraFixture = { containerRegistry: REGISTRY };

  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
    setupFs({ infra: NO_CONTEXT_INFRA });
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses to deploy non-interactively and mutates nothing", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
    const stdin = process.stdin as unknown as { isTTY?: boolean };
    const previous = stdin.isTTY;
    stdin.isTTY = false;
    try {
      await expect(
        runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
      ).rejects.toThrow(/Refusing to deploy against an unpinned kubectl context/);
    } finally {
      stdin.isTTY = previous;
    }
    expect(events).not.toContain("helm");
    expect(events).not.toContain("get-credentials");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("--yes proceeds but prints the context the deploy will mutate", async () => {
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.join(" ") === "config current-context") {
        return { exitCode: 0, stdout: "gke_other-project_us-west1_prod-cluster\n", stderr: "" };
      }
      return happyCluster(events)(cmd, args);
    }) as never);

    // S29: this scenario has no projectId/region, so neither the pod CIDR nor the node range can
    // be discovered and the chart would render NO NetworkPolicies. That now requires the
    // explicit opt-out — `--yes` confirms WHICH CLUSTER to mutate, which is a different
    // question from whether to ship an unisolated dataplane.
    await runDeploy({
      projectDir: PROJECT,
      releaseName: RELEASE,
      skipBuild: true,
      yes: true,
      allowNoNetworkPolicy: true,
    });

    expect(printedWarnings()).toContain("gke_other-project_us-west1_prod-cluster");
    expect(printedWarnings()).toContain("could NOT be pinned");
    expect(events).toContain("helm");
  });

  it("S29: --yes alone does NOT authorize deploying without NetworkPolicies", async () => {
    // Previously this combination silently shipped an unisolated dataplane: CIDR discovery was
    // skipped, buildHelmUpgradeArgs set strict=false, and with no podCidrs the chart's guard
    // rendered nothing — leaving the routing tier's ext_proc port reachable, which is what makes
    // the internal dispatch secret obtainable. Two separate risks need two separate consents.
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.join(" ") === "config current-context") {
        return { exitCode: 0, stdout: "gke_other-project_us-west1_prod-cluster\n", stderr: "" };
      }
      return happyCluster(events)(cmd, args);
    }) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true, yes: true }),
    ).rejects.toThrow(/--allow-no-network-policy/);
    expect(events).not.toContain("helm");
  });

  it("dry-run just says what a real deploy would target", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true, dryRun: true });
    expect(printedLogs()).toContain("kubectl context pinning is impossible");
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
  });
});

describe("runDeploy — N30: routing-manifest retention failure is fatal by default", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("aborts BEFORE helm upgrade (the manifest is still recoverable at that point)", async () => {
    vi.mocked(retainLiveRoutingManifest).mockResolvedValue({
      status: "failed",
      reason: "ConfigMap rel-routing-manifest unreadable",
    } as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/--allow-unretained-manifest/);
    expect(events).not.toContain("helm");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it("--allow-unretained-manifest proceeds and RECORDS the degradation in state", async () => {
    vi.mocked(retainLiveRoutingManifest).mockResolvedValue({
      status: "failed",
      reason: "ConfigMap rel-routing-manifest unreadable",
    } as never);

    await runDeploy({
      projectDir: PROJECT,
      releaseName: RELEASE,
      skipBuild: true,
      allowUnretainedManifest: true,
    });

    expect(events).toContain("helm");
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      expect.objectContaining({ unretainedManifestBuilds: ["buildm"] }),
      RELEASE,
      "default",
    );
    expect(printedWarnings()).toContain("revert the routing IMAGE only");
  });

  it("a release with no routing tier is not a retention failure", async () => {
    vi.mocked(retainLiveRoutingManifest).mockResolvedValue({
      status: "no-routing-tier",
    } as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("helm");
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      {
        buildId: "buildn",
        previousBuildId: "buildm",
        cdnTags: { buildn: cdnTagForBuildId("buildn") },
        // The build just installed serves /readyz, so the NEXT deploy may flip the load
        // balancer's HealthCheckPolicy to readiness without stranding it.
        readinessPathSupported: true,
        // S23: the routing image is now pinned to its digest on every path (the harness's
        // `docker inspect` answers, as a real daemon does after a push), so state records it.
        routingImageDigests: { buildn: `sha256:${"a".repeat(64)}` },
        // N69: the floor writeState stamps above — the prior state carried no generation.
        basedOnGeneration: null,
      },
      RELEASE,
      "default",
    );
  });
});

describe("runDeploy — N32: stale *-prev-*.yaml never survives into another deploy", () => {
  let events: string[];
  const chartTemplatesDir = path.join(PROJECT, ".k8s-adapter", "output", "chart", "templates");

  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
    vi.mocked(existsSync).mockImplementation(
      (p) =>
        p === infraPath ||
        p === metaPath ||
        p === cdnFilter ||
        p === routeExtJobYaml ||
        p === chartTemplatesDir,
    );
    vi.mocked(readdirSync).mockReturnValue([
      "deployment.yaml",
      "ssr-prev-deployment.yaml",
      "reaped-prev-service.yaml",
    ] as never);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("deletes every retained file from an earlier deploy before writing this deploy's", async () => {
    // The chart dir is only wiped by a build, and these files are written after it — so a
    // --skip-build deploy inherited them and helm re-applied a reaped build's Deployment.
    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const unlinked = vi.mocked(unlinkSync).mock.calls.map(([p]) => String(p));
    expect(unlinked).toContain(path.join(chartTemplatesDir, "ssr-prev-deployment.yaml"));
    expect(unlinked).toContain(path.join(chartTemplatesDir, "reaped-prev-service.yaml"));
    expect(unlinked).not.toContain(path.join(chartTemplatesDir, "deployment.yaml"));
    // The wipe happens BEFORE the fresh retained render (which writes the same name).
    const rewritten = vi
      .mocked(writeFileSync)
      .mock.calls.findIndex(([p]) => String(p).endsWith("ssr-prev-deployment.yaml"));
    expect(rewritten).toBeGreaterThanOrEqual(0);
  });

  it("runs unconditionally, even on a first deploy with no previous build", async () => {
    vi.mocked(readState).mockResolvedValue(null as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(vi.mocked(unlinkSync).mock.calls.map(([p]) => String(p))).toContain(
      path.join(chartTemplatesDir, "reaped-prev-service.yaml"),
    );
  });
});

// N87 (SECURITY). Internal dispatch Secrets are per BUILD and annotated
// `helm.sh/resource-policy: keep`, so deploy owns both ends of their lifecycle: the legacy
// stable-named Secret must survive the first upgrade under the new scheme (the outgoing build's
// pods reference it BY NAME and cannot start without it — that is the rollback target), and the
// kept Secrets must be pruned once nothing references them.
describe("runDeploy — N87: per-build internal dispatch Secret lifecycle", () => {
  let events: string[];
  const LEGACY = legacyInternalSecretName(RELEASE);
  const CURRENT_SECRET = internalSecretName(RELEASE, "buildn");
  const PREVIOUS_SECRET = internalSecretName(RELEASE, "buildm");
  const STALE_SECRET = internalSecretName(RELEASE, "oldx");
  /** Delete events for INTERNAL secrets only — the cache Secret cleanup shares the shape. */
  const internalDeletes = new Set(
    [LEGACY, CURRENT_SECRET, PREVIOUS_SECRET, STALE_SECRET].map((n) => `delete-secret:${n}`),
  );

  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => vi.restoreAllMocks());

  it("annotates the legacy Secret keep BEFORE helm upgrade, so helm cannot prune it", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { legacySecretPresent: true }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const annotate = events.findIndex((e) => e.startsWith(`annotate:${LEGACY}:`));
    expect(annotate).toBeGreaterThanOrEqual(0);
    expect(events[annotate]).toContain("helm.sh/resource-policy=keep");
    // Order is the whole point: helm prunes what the chart no longer renders, and the
    // annotation is only honored if it is on the LIVE object first.
    expect(annotate).toBeLessThan(events.indexOf("helm"));
  });

  it("does nothing when there is no legacy Secret (a release already on per-build names)", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { legacySecretPresent: false }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events.filter((e) => e.startsWith("annotate:"))).toEqual([]);
    expect(events).toContain("helm");
  });

  it("aborts BEFORE helm upgrade when the legacy Secret cannot be READ", async () => {
    // The N68 lesson: a read failure is not "absent". Upgrading here could prune a Secret the
    // outgoing build needs, and nothing has been changed yet — so abort cleanly.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { legacySecretProbeFails: true }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/legacy internal dispatch Secret .* could not|Could not determine whether/);
    expect(events).not.toContain("helm");
  });

  it("aborts BEFORE helm upgrade when the legacy Secret cannot be ANNOTATED", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { legacySecretPresent: true, legacyAnnotateFails: true }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/helm\.sh\/resource-policy=keep/);
    expect(events).not.toContain("helm");
  });

  it("prunes only the internal Secrets no Deployment references any more", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        internalSecretsInCluster: [CURRENT_SECRET, PREVIOUS_SECRET, STALE_SECRET, LEGACY],
        // The legacy one is still referenced here — a pre-N87 rollback target's pods resolve
        // it, so it must survive exactly as long as they do.
        referencedSecrets: [CURRENT_SECRET, PREVIOUS_SECRET, LEGACY],
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain(`delete-secret:${STALE_SECRET}`);
    expect(events).not.toContain(`delete-secret:${CURRENT_SECRET}`);
    expect(events).not.toContain(`delete-secret:${PREVIOUS_SECRET}`);
    expect(events).not.toContain(`delete-secret:${LEGACY}`);
  });

  it("prunes the legacy Secret once nothing references it", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        internalSecretsInCluster: [CURRENT_SECRET, PREVIOUS_SECRET, LEGACY],
        referencedSecrets: [],
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain(`delete-secret:${LEGACY}`);
    // Belt and braces: this deploy's own Secret and the retained rollback target's are
    // referenced by definition, whatever the cluster listing says.
    expect(events).not.toContain(`delete-secret:${CURRENT_SECRET}`);
    expect(events).not.toContain(`delete-secret:${PREVIOUS_SECRET}`);
  });

  for (const referencedSecrets of ["invalid", "unreadable"] as const) {
    it(`deletes nothing when the reference set is ${referencedSecrets}`, async () => {
      // Deleting a Secret a live pod template needs would brick that build's restarts, so an
      // unusable reference set skips the sweep entirely (it only leaks 64-byte Secrets).
      vi.mocked(execCapture).mockImplementation(
        happyCluster(events, {
          internalSecretsInCluster: [CURRENT_SECRET, PREVIOUS_SECRET, STALE_SECRET, LEGACY],
          referencedSecrets,
        }) as never,
      );

      await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

      // (the unrelated `delete-secret:rel-valkey` is the cache-disabled Secret cleanup)
      expect(events.filter((e) => internalDeletes.has(e))).toEqual([]);
    });
  }

  it("dry-run touches no Secret at all", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { legacySecretPresent: true }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true, dryRun: true });

    expect(events.filter((e) => e.startsWith("annotate:"))).toEqual([]);
    expect(events.filter((e) => internalDeletes.has(e))).toEqual([]);
  });
});

describe("runDeploy — N33: domain checks run before the completion banner", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("the banner is never printed before the checks run", async () => {
    let bannerBeforeChecks = false;
    vi.mocked(runDomainChecks).mockImplementation((async () => {
      bannerBeforeChecks = printedLogs().includes("Deploy complete");
      return undefined;
    }) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(bannerBeforeChecks).toBe(false);
    expect(printedLogs()).toContain("✓ Deploy complete (build: buildn)");
  });

  it("failing domain checks downgrade the banner and exit non-zero", async () => {
    vi.mocked(runDomainChecks).mockResolvedValue({ failures: 2 } as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(printedLogs()).not.toContain("✓ Deploy complete");
    expect(printedErrors()).toContain("2 domain check(s) FAILED");
    // The deploy itself still completed: state was committed before the checks.
    expect(events).toContain("writeState");
  });
});

describe("runDeploy — N66: the retained previous Deployment mirrors what is RUNNING", () => {
  let events: string[];
  const retainedYaml = (): string =>
    String(
      vi
        .mocked(writeFileSync)
        .mock.calls.find(([p]) => String(p).endsWith("ssr-prev-deployment.yaml"))![1],
    );

  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => vi.restoreAllMocks());

  // N87. The previous build may predate per-build Secret names, in which case its pods resolve
  // the legacy stable-named Secret. Stamping the derived per-build name onto the retained render
  // would repoint the pod template of the build serving 100% of traffic at a Secret nobody
  // rendered — CreateContainerConfigError on every new pod, before cutover. Same failure shape
  // as the containerStrategy flip this suite exists for.
  it("mirrors the live INTERNAL_HEADER_SECRET secretKeyRef instead of deriving it", async () => {
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    expect(yaml).toContain(`name: ${legacyInternalSecretName(RELEASE)}`);
    expect(yaml).not.toContain(internalSecretName(RELEASE, "buildm"));
  });

  it("derives the per-build Secret name when the live template already carries one", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { internalSecretRef: internalSecretName(RELEASE, "buildm") },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(retainedYaml()).toContain(`name: ${internalSecretName(RELEASE, "buildm")}`);
  });

  it("falls back to the derived name (with a warning) for an unusable live ref", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { internalSecretRef: 'x"\n              hostNetwork: true' },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    expect(yaml).toContain(`name: ${internalSecretName(RELEASE, "buildm")}`);
    expect(yaml).not.toContain("hostNetwork");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/not a plain Secret name/);
  });

  it("renders the live image + all four quantities as LITERALS, with no .Values left", async () => {
    // Everything the retained render resolved from `.Values` resolved against the NEW
    // build's values: changing `resources` in next.config mutated the pod template of the
    // build serving 100% of traffic (→ RollingUpdate rolled it), and flipping
    // containerStrategy repointed it at a tag that was never pushed (ImagePullBackOff on
    // the SERVING build, before cutover).
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    expect(yaml).not.toContain(".Values");
    expect(yaml).not.toContain("{{");
    expect(yaml).toContain(`image: "${DEFAULT_PREV_LIVE.image}"`);
    expect(yaml).toContain(`cpu: "${DEFAULT_PREV_LIVE.cpu}"`);
    expect(yaml).toContain(`memory: "${DEFAULT_PREV_LIVE.memory}"`);
    expect(yaml).toContain(`ephemeral-storage: "${DEFAULT_PREV_LIVE.ephemeralStorage}"`);
    expect(yaml).toContain(`cpu: "${DEFAULT_PREV_LIVE.cpuLimit}"`);
    expect(yaml).toContain(`memory: "${DEFAULT_PREV_LIVE.memoryLimit}"`);
    // ...and the live replica count, as before.
    expect(yaml).toContain(`replicas: ${DEFAULT_PREV_LIVE.replicas}`);
  });

  it("keeps the OLD repository when containerStrategy flips between builds", async () => {
    // shared-image renders `nextjs-app`; the serving build was built per-pool
    // (`nextjs-app-ssr`). The retained manifest must name what is running, not what this
    // build would produce.
    setupFs({
      metadata: {
        buildId: "buildn",
        pools: ["ssr"],
        cacheEnabled: false,
        containerStrategy: "shared-image",
      },
    });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    expect(yaml).toContain(`${REGISTRY}/nextjs-app-ssr:buildm`);
    expect(yaml).not.toContain("nextjs-app:buildn");
    expect(yaml).not.toContain(".Values");
  });

  it("mirrors the live readiness path so the SERVING build's probe never changes", async () => {
    // The retained build may predate /readyz; stamping the current default onto it would
    // change the serving build's pod template into a probe its pods cannot satisfy.
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    // Scope to the readinessProbe block itself: the startup/liveness probes are /healthz
    // too, so a substring search over the whole document would pass vacuously.
    expect(yaml).toMatch(
      new RegExp(
        `readinessProbe:\\s*\\n\\s*httpGet:\\s*\\n\\s*path: ${DEFAULT_PREV_LIVE.readinessPath}\\b`,
      ),
    );
    // The current default must appear NOWHERE in a manifest that mirrors an older build.
    expect(yaml).not.toContain("/readyz");
  });

  it("falls back to .Values only where there is no live object to mirror (NotFound self-heal)", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { replicasProbeGone: true }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    expect(yaml).toContain("replicas: 2");
    // Nothing was invented: the template's own .Values expressions remain.
    expect(yaml).toContain(".Values");
  });

  it("omits only the fields the live object lacks (an older build with no limits)", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { cpuLimit: "", memoryLimit: "", ephemeralStorage: "" },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const yaml = retainedYaml();
    // Requests were mirrored...
    expect(yaml).toContain(`cpu: "${DEFAULT_PREV_LIVE.cpu}"`);
    // ...and exactly the absent fields stayed on the .Values fallback.
    expect(yaml).toContain('(index .Values.pools "ssr").resources.limits.cpu');
    expect(yaml).toContain('(index .Values.pools "ssr").resources.limits.memory');
  });

  it("aborts when a live quantity is not a valid Kubernetes quantity (never spliced raw)", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { memory: '1Gi"\n      hostNetwork: true\n      _pad: "' },
      }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Invalid Kubernetes quantity/);
    expect(events).not.toContain("helm");
  });

  it("warns and uses the template default when the live readiness path is not a plain path", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { prevLive: { readinessPath: '/x"\n            port: 22' } }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(printedWarnings()).toContain("is not a plain URL path");
    expect(retainedYaml()).not.toContain("port: 22");
  });
});

describe("runDeploy — N64: the cutover gate requires the outgoing build's capacity", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("scales the new build up to the outgoing replica count BEFORE the gate", async () => {
    // The chart renders a new build at its HPA floor; with no traffic yet nothing would
    // ever scale it up, so the capacity is requested explicitly here.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 2,
        readyPerPool: { ssr: 6 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("scaleup:deployment/rel-ssr-buildn");
    const scaleUp = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("scale") && a.includes("deployment/rel-ssr-buildn"))!;
    expect(scaleUp[1]).toContain("--replicas=6");
    // ...and it happened before the selector flip.
    expect(events.indexOf("scaleup:deployment/rel-ssr-buildn")).toBeLessThan(
      events.indexOf("patch:rel-ssr"),
    );
  });

  it("does NOT cut over while fewer pods are ready than the outgoing build runs", async () => {
    // The old gate passed on `checkedCount > 0` — ONE ready pod — so a previous build
    // serving 6 cut over to a single pod with the HPA climbing from behind.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 6,
        readyPerPool: { ssr: 1 },
      }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    // The message says which pool fell short, and by how much.
    expect(printedErrors()).toContain("Capacity gate");
    expect(printedErrors()).toContain("ssr: 1/6 ready");
  });

  it("gates per pool: one pool at full capacity cannot cover another that is short", async () => {
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 3 },
        newBuildReplicas: 3,
        readyPerPool: { ssr: 5, api: 1 },
      }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(printedErrors()).toContain("api: 1/3 ready");
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
  });

  it("N32: the failure diagnostic probes /readyz and prints its reason, not /healthz", async () => {
    // /healthz returns a hardcoded 200 before any routing or handler load — asking it here
    // told the operator nothing. /readyz carries the reason the pod is not serving.
    const cluster = happyCluster(events, { podsNeverReady: true });
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.includes("exec")) {
        return {
          exitCode: 0,
          stdout:
            '503 {"status":"unavailable","reason":"instrumentation register() failed: boom[31m"}',
          stderr: "",
        };
      }
      return cluster(cmd, args);
    }) as never);

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const probe = vi.mocked(execCapture).mock.calls.find(([, a]) => a.includes("exec"))!;
    expect(probe[1].join(" ")).toContain("/readyz");
    expect(probe[1].join(" ")).not.toContain("/healthz");
    const out = printedErrors();
    expect(out).toContain("Readiness (/readyz)");
    expect(out).toContain("instrumentation register() failed");
    // L14: pod-sourced text is stripped of terminal control characters.
    expect(out).not.toContain("[31m");
  });

  it("a pool with no live predecessor imposes no capacity expectation", async () => {
    // First deploy: nothing to MATCH, so the gate asks only for the S18 floor of one ready
    // pod per configured pool rather than a predecessor's count.
    vi.mocked(readState).mockResolvedValue(null as never);
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { readyPerPool: { ssr: 1 } }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("patch:rel-ssr");
    expect(events.some((e) => e.startsWith("scaleup:"))).toBe(false);
  });

  it("S18: a NEW pool with zero ready pods blocks cutover even when its sibling is full", async () => {
    // capacityTargets was seeded ONLY from previousReplicasByPool, which has no entry for a
    // pool that is new in this build (or for any pool on a first deploy). A pool with zero
    // pods therefore contributed no expectation, `checkedCount > 0` was satisfied by the
    // sibling's pods, and the gate passed — then cutover patched EVERY active Service to the
    // new build, leaving the new pool's Service with no endpoints and serving 503s. Every
    // configured pool must show at least one ready pod before the selector flip.
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr", "api"], cacheEnabled: false } });
    vi.mocked(readState).mockResolvedValue(null as never);
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { readyPerPool: { ssr: 3, api: 0 } }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(printedErrors()).toContain("api: 0/1 ready");
    expect(events.some((e) => e.startsWith("patch:"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });
});

describe("runDeploy — N67: the new build's HPA must not undo the pre-cutover warm-up", () => {
  let events: string[];
  const NEW_HPA = poolResourceNames(RELEASE, "ssr", "buildn").hpa;
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("widens maxReplicas above the chart ceiling, warms up, then restores the ceiling after cutover", async () => {
    // The outgoing build runs 6; the new chart caps the pool at 3. helm already installed
    // that HPA, so the N64 scale-up to 6 was reconciled straight back down to 3 and the
    // capacity gate waited for a count that could never be reached — every such deploy
    // hung for the full health budget and aborted BEFORE cutover.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        readyPerPool: { ssr: 6 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    // Widened to the warm-up target BEFORE the scale-up, and the scale-up asked for 6.
    expect(events).toContain(`hpa-max:${NEW_HPA}:6`);
    expect(events.indexOf(`hpa-max:${NEW_HPA}:6`)).toBeLessThan(
      events.indexOf("scaleup:deployment/rel-ssr-buildn"),
    );
    const scaleUp = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("scale") && a.includes("deployment/rel-ssr-buildn"))!;
    expect(scaleUp[1]).toContain("--replicas=6");
    // Cutover happened (the gate was satisfiable) and state was committed.
    expect(events).toContain("patch:rel-ssr");
    expect(events).toContain("writeState");
    // ...and the chart's ceiling is back, AFTER the cutover was committed.
    expect(events).toContain(`hpa-max:${NEW_HPA}:3`);
    expect(events.indexOf("writeState")).toBeLessThan(events.indexOf(`hpa-max:${NEW_HPA}:3`));
    // The LAST thing done to that HPA is the restore — no widened HPA is left behind.
    const hpaEvents = events.filter((e) => e.startsWith("hpa-max:"));
    expect(hpaEvents).toEqual([`hpa-max:${NEW_HPA}:6`, `hpa-max:${NEW_HPA}:3`]);
    // The restore patch impersonates helm, which owns the chart-rendered HPA.
    const restore = vi
      .mocked(execCapture)
      .mock.calls.filter(([, a]) => a.includes("patch") && a.includes("hpa"))
      .at(-1)!;
    expect(restore[1]).toContain("--field-manager=helm");
    expect(JSON.parse(restore[1].at(-1)!)).toEqual({ spec: { maxReplicas: 3 } });
  });

  it("restores the chart ceiling when the deploy ABORTS mid-warm-up", async () => {
    // A deploy that aborts before cutover must not leave a widened autoscaler behind:
    // the abandoned build would keep the right to autoscale past its configured ceiling.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        readyPerPool: { ssr: 3 }, // never reaches 6 → the gate expires
      }) as never,
    );

    vi.useFakeTimers();
    const run = runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });
    const assertion = expect(run).rejects.toThrow(/process\.exit:1/);
    for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(events.some((e) => e.startsWith("patch:rel-ssr"))).toBe(false);
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    const hpaEvents = events.filter((e) => e.startsWith("hpa-max:"));
    expect(hpaEvents).toEqual([`hpa-max:${NEW_HPA}:6`, `hpa-max:${NEW_HPA}:3`]);
    expect(printedErrors()).toContain("ssr: 3/6 ready");
  });

  it("restores the chart ceiling when the selector cutover fails", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        readyPerPool: { ssr: 6 },
        patchFailsFor: "rel-ssr",
      }) as never,
    );

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
    expect(events.filter((e) => e.startsWith("hpa-max:"))).toEqual([
      `hpa-max:${NEW_HPA}:6`,
      `hpa-max:${NEW_HPA}:3`,
    ]);
  });

  it("restores the chart ceiling when the post-cutover state commit fails", async () => {
    // The third exit path: traffic HAS switched but state could not be persisted. The
    // process still leaves here, so the HPA must be chart-intended before it does.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        readyPerPool: { ssr: 6 },
      }) as never,
    );
    vi.mocked(writeState).mockRejectedValue(new Error("Unable to connect to the server"));

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(events.filter((e) => e.startsWith("hpa-max:"))).toEqual([
      `hpa-max:${NEW_HPA}:6`,
      `hpa-max:${NEW_HPA}:3`,
    ]);
    expect(printedErrors()).toContain("persisting deploy state failed");
  });

  it("warns with a repair command when the ceiling cannot be restored", async () => {
    // Never silent: an HPA left widened outlives the deploy, so name it and the fix.
    let widenSeen = false;
    const cluster = happyCluster(events, {
      prevLive: { replicas: 6 },
      newBuildReplicas: 1,
      newBuildHpa: { min: 1, max: 3 },
      readyPerPool: { ssr: 6 },
    });
    vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (args.includes("patch") && args.includes("hpa")) {
        if (widenSeen) return { exitCode: 1, stdout: "", stderr: "etcdserver: leader changed" };
        widenSeen = true;
      }
      return cluster(cmd, args);
    }) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    const warned = printedWarnings();
    expect(warned).toContain(`Could not restore ${NEW_HPA} to the chart's maxReplicas=3`);
    expect(warned).toContain(`patch hpa ${NEW_HPA}`);
  });

  it("leaves the HPA alone when its ceiling already covers the outgoing capacity", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 3 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 10 },
        readyPerPool: { ssr: 3 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("scaleup:deployment/rel-ssr-buildn");
    expect(events.some((e) => e.startsWith("hpa-max:"))).toBe(false);
  });

  it("cuts over at the ceiling it could not raise instead of waiting for an unreachable count", async () => {
    // An un-widenable HPA (RBAC, webhook) must not turn into a hung deploy: the ceiling
    // IS the most capacity this pool can have under this chart, so the gate asks for it.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: { min: 1, max: 3 },
        newBuildHpaPatchFails: true,
        readyPerPool: { ssr: 3 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("patch:rel-ssr");
    const scaleUp = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a.includes("scale") && a.includes("deployment/rel-ssr-buildn"))!;
    expect(scaleUp[1]).toContain("--replicas=3");
    expect(printedWarnings()).toContain("caps pool");
    // Nothing to restore — the widen never took effect.
    expect(events.filter((e) => e.startsWith("hpa-max:"))).toEqual([`hpa-max:${NEW_HPA}:6`]);
  });

  it("warns but still scales up when the HPA cannot be read", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpaReadFails: true,
        readyPerPool: { ssr: 6 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("scaleup:deployment/rel-ssr-buildn");
    expect(printedWarnings()).toContain(`Could not read the new build's HPA ${NEW_HPA}`);
  });

  it("needs no widening when the pool has no HPA at all", async () => {
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, {
        prevLive: { replicas: 6 },
        newBuildReplicas: 1,
        newBuildHpa: null,
        readyPerPool: { ssr: 6 },
      }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(events).toContain("scaleup:deployment/rel-ssr-buildn");
    expect(events.some((e) => e.startsWith("hpa-max:"))).toBe(false);
  });
});

describe("runDeploy — N61/N62: pool-name and emitted-name guards", () => {
  let events: string[];
  beforeEach(() => {
    events = [];
    standardBeforeEach(events);
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("rejects an out-of-charset pool name through the shared validator, naming the source file", async () => {
    // The message must still point at build-metadata.json (deploy reads pool names from
    // there and puts them in chart file paths), while the CHARSET comes from the shared
    // validator so emit and deploy can never disagree. (YAML-boolean names like "on" are
    // legal here and handled by QUOTING in the templates — see N61 in deployment.ts.)
    setupFs({ metadata: { buildId: "buildn", pools: ["SSR_Pool"], cacheEnabled: false } });
    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/from build-metadata\.json/);
    expect(events).not.toContain("helm");
  });

  it("rejects a pool name with an edge hyphen (invalid label value)", async () => {
    setupFs({ metadata: { buildId: "buildn", pools: ["ssr-"], cacheEnabled: false } });
    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/Invalid pool name "ssr-"/);
    expect(events).not.toContain("helm");
  });

  it("catches a CROSS-POOL emitted-name collision on a FIRST deploy", async () => {
    // pools `api` + `api-v2` with buildId `v2`: the versioned name of `api` equals the
    // stable name of `api-v2`. helm applies both, last-writer-wins.
    vi.mocked(readState).mockResolvedValue(null as never);
    setupFs({ metadata: { buildId: "v2", pools: ["api", "api-v2"], cacheEnabled: false } });

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(/would be applied TWICE/);
    expect(events).not.toContain("helm");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });
});
