// tests/cli/deploy-orchestration.test.ts
// runDeploy orchestration tests: the whole blue/green flow with a scripted exec.js.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/state.js");
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("../../src/cli/rollback.js");
vi.mock("../../src/cli/doctor.js");
vi.mock("../../src/cli/provision-cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/provision-cache.js")>();
  return { ...actual, provisionMemorystore: vi.fn() };
});
vi.mock("node:fs");

import { runDeploy } from "../../src/cli/deploy.js";
import { execCapture, execCaptureStdin, execOrThrow } from "../../src/cli/exec.js";
import { readState, writeState } from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { retainLiveRoutingManifest } from "../../src/cli/rollback.js";
import { runDomainChecks } from "../../src/cli/doctor.js";
import { provisionMemorystore } from "../../src/cli/provision-cache.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { routingManifestSnapshotName } from "../../src/emit/templates/routing-manifest-configmap.js";
import { poolResourceNames } from "../../src/emit/templates/utils.js";
import { renderHPA } from "../../src/emit/templates/hpa.js";

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

function setupFs({
  infra = BASE_INFRA,
  metadata = { buildId: "buildn", pools: ["ssr"], cacheEnabled: false },
  cdn = true,
}: {
  infra?: InfraFixture;
  metadata?: Record<string, unknown>;
  cdn?: boolean;
} = {}) {
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
 * Scripted cluster for a deploy where build "buildm" is serving and "buildn" lands.
 * `overrides` tweaks individual responses per test.
 */
function happyCluster(
  events: string[],
  overrides: {
    replicasProbeFails?: boolean;
    replicasProbeGone?: boolean; // NotFound: previous Deployment was deleted manually
    patchFailsFor?: string; // service name whose selector patch fails
    podsNeverReady?: boolean;
  } = {},
) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const j = args.join(" ");
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    if (args.includes("get-credentials")) {
      events.push("get-credentials");
      return ok();
    }
    if (j.includes("clusterIpv4Cidr")) return ok("10.4.0.0/14\n");
    if (args.includes("addresses") && args.includes("describe")) {
      return { exitCode: 1, stdout: "", stderr: "not found" }; // → create via execOrThrow
    }
    if (args.includes("crd")) return ok("gcphttpfilters.networking.gke.io\n");
    if (args.includes("secret")) return ok(""); // cache-disabled secret delete
    if (j.includes("jsonpath={.spec.replicas}")) {
      if (overrides.replicasProbeGone) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: 'Error from server (NotFound): deployments.apps "rel-ssr-buildm" not found',
        };
      }
      return overrides.replicasProbeFails
        ? { exitCode: 1, stdout: "", stderr: "connection refused" }
        : ok("2");
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
      // Health gate + diagnostics: Ready unless the test says otherwise.
      return ok(
        overrides.podsNeverReady
          ? "rel-ssr-buildn-abc|False\nrel-routing-service-extra-buildn-xyz|False\n"
          : "rel-ssr-buildn-abc|True\n",
      );
    }
    if (args.includes("patch")) {
      const svc = args[args.indexOf("service") + 1]!;
      events.push(`patch:${svc}`);
      if (svc === overrides.patchFailsFor) {
        return { exitCode: 1, stdout: "", stderr: "denied by webhook" };
      }
      return ok();
    }
    if (args.includes("hpa")) return ok("");
    if (args.includes("scale")) {
      events.push(`scale:${args.find((a) => a.startsWith("deployment/"))}`);
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
      return "rel-routing-manifest-buildm";
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

    // State committed with the swapped builds.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      { buildId: "buildn", previousBuildId: "buildm" },
      RELEASE,
    );
    // CDN invalidated for the OUTGOING build.
    expect(vi.mocked(invalidateCdnBuildTag)).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildm", releaseName: RELEASE, projectId: "my-project" }),
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
    expect(printed).toContain("previous build is still serving");
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
    vi.mocked(retainLiveRoutingManifest).mockResolvedValue(null as never);
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
    // bricked every future deploy of the release.
    vi.mocked(execCapture).mockImplementation(
      happyCluster(events, { replicasProbeGone: true }) as never,
    );

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    // The deploy completed: cutover happened and state was committed.
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      { buildId: "buildn", previousBuildId: "buildm" },
      RELEASE,
    );
    // A loud warning named the missing deployment...
    expect(
      vi
        .mocked(console.warn)
        .mock.calls.some((c) => String(c[0]).includes("rel-ssr-buildm") && String(c[0]).includes("not found")),
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

  it("rejects a non-default namespace in infrastructure.json before touching anything", async () => {
    // The chart/extension chain were built for the ext_proc authority in
    // infra.namespace, but every kubectl/helm call pins "default" — deploying would
    // skew the GXLB callout target away from the workloads. Fail fast instead.
    setupFs({ infra: { ...BASE_INFRA, namespace: "prod" } });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await expect(
      runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true }),
    ).rejects.toThrow(
      /Unsupported namespace "prod".*deploys only to the "default" namespace.*Remove "namespace"/s,
    );
    expect(events).not.toContain("helm");
    expect(events).not.toContain("get-credentials");
    expect(vi.mocked(writeState)).not.toHaveBeenCalled();
  });

  it('accepts an explicit namespace of "default" in infrastructure.json', async () => {
    setupFs({ infra: { ...BASE_INFRA, namespace: "default" } });
    vi.mocked(execCapture).mockImplementation(happyCluster(events) as never);

    await runDeploy({ projectDir: PROJECT, releaseName: RELEASE, skipBuild: true });

    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      { buildId: "buildn", previousBuildId: "buildm" },
      RELEASE,
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
