// tests/cli/rollback.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/state.js");
vi.mock("../../src/cli/cdn-invalidate.js");
vi.mock("node:fs");

import {
  retainLiveRoutingManifest,
  runRollback,
  SNAPSHOT_BUILD_ID_ANNOTATION,
} from "../../src/cli/rollback.js";
import { execCapture, execCaptureStdin, execOrThrow } from "../../src/cli/exec.js";
import { readState, writeState } from "../../src/cli/state.js";
import { invalidateCdnBuildTag } from "../../src/cli/cdn-invalidate.js";
import { existsSync, readFileSync } from "node:fs";
import { routingManifestSnapshotName } from "../../src/emit/templates/routing-manifest-configmap.js";
import { poolResourceNames } from "../../src/emit/templates/utils.js";
import { renderHPA } from "../../src/emit/templates/hpa.js";

const PROJECT = "/proj";
const RELEASE = "rel";
// Retained routing-manifest snapshot names (hashed — derive, never hardcode).
const SNAP_M = routingManifestSnapshotName(RELEASE, "buildm");
const SNAP_N = routingManifestSnapshotName(RELEASE, "buildn");
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

describe("runRollback — CDN invalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation(
      (p) => p === infraPath || p === metaPath || p === cdnFilter,
    );
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj","region":"us-central1"}';
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
      expect.objectContaining({ buildId: "buildn", releaseName: RELEASE, projectId: "proj" }),
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
    } as never);
    vi.mocked(execCapture).mockImplementation(capture(false) as never);

    await runRollback({ projectDir: PROJECT, releaseName: RELEASE });

    expect(invalidateCdnBuildTag).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: "buildn", recordedTag: cdnTags.buildn }),
    );
    expect(vi.mocked(writeState)).toHaveBeenCalledWith(
      PROJECT,
      { buildId: "buildm", previousBuildId: "buildn", cdnTags },
      RELEASE,
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
      { buildId: "buildm", previousBuildId: "buildn" },
      RELEASE,
    );
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
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT, RELEASE, { localOnly: true });
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
    vi.mocked(readState).mockResolvedValue({ buildId: CURR, previousBuildId: PREV } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj","region":"us-central1"}';
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

    // Existence probe looked for the HPA the template rendered.
    const getHpa = vi
      .mocked(execCapture)
      .mock.calls.find(([, a]) => a[0] === "get" && a[1] === "hpa");
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
      { buildId: PREV, previousBuildId: CURR },
      LONG_RELEASE,
    );
  });
});

describe("runRollback — state read ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCapture).mockImplementation(capture(false) as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj","region":"us-central1"}';
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
    expect(vi.mocked(readState)).toHaveBeenCalledWith(PROJECT, RELEASE, undefined);
  });
});

describe("runRollback — routing service revert", () => {
  const REGISTRY = "us-central1-docker.pkg.dev/proj/nextjs";

  function routingCapture(opts: { targetSnapshotExists: boolean }) {
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
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath)
        return JSON.stringify({
          projectId: "proj",
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

    // 3. ...and its rollout was awaited.
    const rolloutArgs = vi.mocked(execOrThrow).mock.calls.map(([, args]) => args.join(" "));
    expect(
      rolloutArgs.some((a) => a.includes("rollout status deployment/rel-routing-service")),
    ).toBe(true);

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
      { buildId: "buildm", previousBuildId: "buildn" },
      RELEASE,
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
  function partialFailCapture(opts: { edgeForwardFails?: boolean } = {}) {
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
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(execCaptureStdin).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath)
        return JSON.stringify({
          projectId: "proj",
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

  it("overwrites a snapshot stamped with the SAME build id (idempotent re-retention)", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: "buildn" }) as never,
    );

    await expect(retainLiveRoutingManifest("rel")).resolves.toBe(SNAP_N);
    expect(vi.mocked(execCaptureStdin)).toHaveBeenCalledTimes(1);
  });

  it("overwrites a legacy unstamped snapshot and stamps the build-id annotation on the new one", async () => {
    vi.mocked(execCapture).mockImplementation(
      retainCapture({ existingSnapshotAnnotation: null }) as never,
    );

    await expect(retainLiveRoutingManifest("rel")).resolves.toBe(SNAP_N);
    const applied = JSON.parse(vi.mocked(execCaptureStdin).mock.calls[0]![2] as string);
    expect(applied.metadata.annotations[SNAPSHOT_BUILD_ID_ANNOTATION]).toBe("buildn");
    expect(applied.metadata.labels["app.kubernetes.io/managed-by"]).toBe("adapter-k8s");
  });
});

describe("runRollback — serving gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    vi.mocked(writeState).mockResolvedValue(undefined as never);
    vi.mocked(execOrThrow).mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" } as never);
    vi.mocked(invalidateCdnBuildTag).mockResolvedValue(undefined);
    vi.mocked(existsSync).mockImplementation((p) => p === infraPath || p === metaPath);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (p === infraPath) return '{"projectId":"proj","region":"us-central1"}';
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
