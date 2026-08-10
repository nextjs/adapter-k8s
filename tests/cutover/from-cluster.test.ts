// tests/cutover/from-cluster.test.ts
//
// GitOps PR2 (design §4.2 "The cutover Job"): the Job's THREE input sources — the mounted
// emit-metadata ConfigMap, the state ConfigMap, and the two live-cluster facts Git cannot
// know. Every read here is fail-closed by design: the Job must never promote on guessed
// facts, and the mounted ConfigMap is operator-mutable, so the assertSafe* battery runs at
// the point of consumption even though emit validated the same values at write time.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");

import { execCapture } from "../../src/cli/exec.js";
import {
  buildCutoverInputsFromCluster,
  isAlreadyPromoted,
  readJobEmitMetadata,
  readPreviousReplicas,
  type JobEmitMetadata,
} from "../../src/cutover/from-cluster.js";
import type { AdapterState } from "../../src/cli/state.js";
import type { EmitMetadata } from "../../src/cli/emit.js";

const RELEASE = "my-app";
const BUILD = "buildn";
const PREV = "buildm";

let tmpDir: string;

/** A complete, valid mounted emit-metadata.json for `cutover.mode: job`. */
function metadataFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const meta: Partial<EmitMetadata> = {
    emitVersion: 1,
    buildId: BUILD,
    previousBuildId: PREV,
    releaseName: RELEASE,
    namespace: "default",
    registry: "us-central1-docker.pkg.dev/proj/nextjs",
    digests: { ssr: `sha256:${"a".repeat(64)}`, routingService: `sha256:${"b".repeat(64)}` },
    cdnTag: `build-${"0".repeat(64)}`,
    poolTopology: ["ssr"],
    defaultPool: "ssr",
    targetPlatforms: { [BUILD]: "linux/amd64" },
    secretsMode: "external",
    cutover: "job",
    hasRouteExtJob: true,
    hasEnvoyExtensionPolicy: true,
    cdnEnabled: true,
    hasPortableOrigin: true,
    projectId: "my-project",
  };
  return { ...meta, ...overrides };
}

/** Write a metadata object (or raw text) to the mount path and return that path. */
function mount(body: unknown | string): string {
  const p = path.join(tmpDir, "emit-metadata.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}

/** Drop one required key from the fixture and read it back — the fail-closed branches. */
function readWithout(key: string): () => JobEmitMetadata {
  const meta = metadataFixture();
  delete meta[key];
  const p = mount(meta);
  return () => readJobEmitMetadata(p);
}

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-job-meta-"));
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("readJobEmitMetadata — the mounted emit-metadata ConfigMap", () => {
  it("happy path: returns the Job-consumed subset, with the platform parsed", () => {
    const meta = readJobEmitMetadata(mount(metadataFixture()));
    expect(meta).toEqual({
      buildId: BUILD,
      previousBuildId: PREV,
      releaseName: RELEASE,
      namespace: "default",
      registry: "us-central1-docker.pkg.dev/proj/nextjs",
      digests: { ssr: `sha256:${"a".repeat(64)}`, routingService: `sha256:${"b".repeat(64)}` },
      poolTopology: ["ssr"],
      defaultPool: "ssr",
      builtTargetPlatform: "linux/amd64",
      hasRouteExtJob: true,
      hasEnvoyExtensionPolicy: true,
      cdnEnabled: true,
      hasPortableOrigin: true,
      projectId: "my-project",
    });
  });

  it("the three template-existence booleans and projectId default OFF, never to a guess", () => {
    // A PR1-shaped (mode none) metadata mounted by mistake must not make the Job assume a
    // route-ext Job / policy / CDN filter exists — those gates would then wait on nothing.
    const meta = readJobEmitMetadata(
      mount(
        metadataFixture({
          hasRouteExtJob: undefined,
          hasEnvoyExtensionPolicy: undefined,
          cdnEnabled: undefined,
          hasPortableOrigin: undefined,
          projectId: undefined,
          digests: undefined,
          previousBuildId: null,
        }),
      ),
    );
    expect(meta.hasRouteExtJob).toBe(false);
    expect(meta.hasEnvoyExtensionPolicy).toBe(false);
    expect(meta.cdnEnabled).toBe(false);
    expect(meta.hasPortableOrigin).toBe(false);
    expect(meta.projectId).toBeUndefined();
    expect(meta.digests).toEqual({});
    expect(meta.previousBuildId).toBeNull();
    // "true"-ish strings are not true: the ConfigMap is operator-mutable.
    expect(readJobEmitMetadata(mount(metadataFixture({ cdnEnabled: "true" }))).cdnEnabled).toBe(
      false,
    );
  });

  it("fail-closed: a MISSING mount names the path and the chart gate that renders it", () => {
    expect(() => readJobEmitMetadata(path.join(tmpDir, "nope.json"))).toThrow(
      /Could not read the mounted emit-metadata/,
    );
    expect(() => readJobEmitMetadata(path.join(tmpDir, "nope.json"))).toThrow(/cutover.mode: job/);
  });

  it("fail-closed: unparseable JSON is not an empty metadata", () => {
    expect(() => readJobEmitMetadata(mount("{truncated"))).toThrow(/is not valid JSON/);
  });

  it("fail-closed: no buildId — refusing to promote", () => {
    expect(readWithout("buildId")).toThrow(/no buildId — refusing to promote/);
    expect(() => readJobEmitMetadata(mount(metadataFixture({ buildId: "" })))).toThrow(
      /no buildId/,
    );
  });

  it("fail-closed: no releaseName — refusing to promote", () => {
    expect(readWithout("releaseName")).toThrow(/no releaseName — refusing to promote/);
  });

  it("fail-closed: no poolTopology (or an empty one) — refusing to promote", () => {
    expect(readWithout("poolTopology")).toThrow(/no poolTopology — refusing to promote/);
    expect(() => readJobEmitMetadata(mount(metadataFixture({ poolTopology: [] })))).toThrow(
      /no poolTopology/,
    );
  });

  it("fail-closed: no defaultPool — refusing to promote", () => {
    expect(readWithout("defaultPool")).toThrow(/no defaultPool — refusing to promote/);
  });

  it("fail-closed: no registry — the edge revert could not run", () => {
    expect(readWithout("registry")).toThrow(/no registry — the edge revert could not run/);
  });

  it("fail-closed: no target platform FOR THIS BUILD — the edge's arch selector is unrestorable", () => {
    // Present-but-for-another-build is the sharp case: a stale metadata carrying only the
    // previous build's platform must not silently pass.
    expect(() =>
      readJobEmitMetadata(mount(metadataFixture({ targetPlatforms: { [PREV]: "linux/amd64" } }))),
    ).toThrow(/records no target platform for build "buildn"/);
    expect(readWithout("targetPlatforms")).toThrow(/records no target platform/);
    // ...and an unsupported value is rejected by the parser, not coerced.
    expect(() =>
      readJobEmitMetadata(
        mount(metadataFixture({ targetPlatforms: { [BUILD]: "linux/riscv64" } })),
      ),
    ).toThrow(/not a supported target platform/);
  });

  it("assertSafe*: a TAMPERED ConfigMap value is rejected at the point of consumption", () => {
    // The ConfigMap is operator-mutable, and every one of these lands in a kubectl argv or
    // a label selector.
    expect(() => readJobEmitMetadata(mount(metadataFixture({ buildId: 'bad"\nid: x' })))).toThrow(
      /Invalid buildId/,
    );
    expect(() =>
      readJobEmitMetadata(mount(metadataFixture({ previousBuildId: "bad id;rm -rf" }))),
    ).toThrow(/Invalid buildId/);
    expect(() =>
      readJobEmitMetadata(mount(metadataFixture({ releaseName: "BAD-RELEASE" }))),
    ).toThrow(/Invalid releaseName/);
    expect(() => readJobEmitMetadata(mount(metadataFixture({ namespace: "Bad NS" })))).toThrow(
      /Invalid namespace/,
    );
    expect(readWithout("namespace")).toThrow(/Invalid namespace/);
  });
});

describe("isAlreadyPromoted — the cheap-idempotent short-circuit (§4.3)", () => {
  const opts = (state: AdapterState | null, pools = ["ssr", "api"]) => ({
    releaseName: RELEASE,
    namespace: "default",
    buildId: BUILD,
    pools,
    state,
  });
  const selector = (v: string) => ({ exitCode: 0, stdout: v, stderr: "" });

  it("TRUE only when the state CM and EVERY pool's live selector agree", async () => {
    vi.mocked(execCapture).mockResolvedValue(selector(BUILD));
    expect(await isAlreadyPromoted(opts({ buildId: BUILD, previousBuildId: PREV }))).toBe(true);
    // Read by exact stable-Service NAME (Helm rewrites the managed-by label on live
    // objects, so a label selector would match nothing), with the absence discipline.
    const args = vi.mocked(execCapture).mock.calls[0]![1];
    expect(args.slice(0, 3)).toEqual(["get", "service", "my-app-ssr"]);
    expect(args).toContain("--ignore-not-found");
    expect(vi.mocked(execCapture).mock.calls[1]![1][2]).toBe("my-app-api");
  });

  it("FALSE on a state mismatch — and without touching the cluster at all", async () => {
    expect(await isAlreadyPromoted(opts({ buildId: PREV, previousBuildId: "older" }))).toBe(false);
    expect(await isAlreadyPromoted(opts(null))).toBe(false);
    // The state read is the cheap half; a stale-ahead pointer must not skip the gates.
    expect(vi.mocked(execCapture)).not.toHaveBeenCalled();
  });

  it("FALSE when ANY pool's selector still names another build (a half-run promotion)", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) =>
      args[2] === "my-app-api" ? selector(PREV) : selector(BUILD),
    );
    // State alone is not durability: selectors that disagree mean the promotion must re-run.
    expect(await isAlreadyPromoted(opts({ buildId: BUILD, previousBuildId: PREV }))).toBe(false);
  });

  it("FALSE on a kubectl READ FAILURE — the gate battery is the authority", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "services is forbidden",
    });
    expect(await isAlreadyPromoted(opts({ buildId: BUILD, previousBuildId: PREV }))).toBe(false);
  });

  it("compares the SANITIZED build id — the same value the cutover patches selectors to", async () => {
    // sanitizeK8sName prefixes ids that start with a digit; comparing the raw id would
    // make every such build look un-promoted and re-run the whole battery each sync.
    vi.mocked(execCapture).mockResolvedValue(selector("b-9build"));
    expect(
      await isAlreadyPromoted({
        ...opts({ buildId: "9build", previousBuildId: PREV }, ["ssr"]),
        buildId: "9build",
      }),
    ).toBe(true);
  });
});

describe("readPreviousReplicas — N64's live read, re-hosted in the Job", () => {
  const opts = (previousPools = ["ssr"]) => ({
    releaseName: RELEASE,
    namespace: "default",
    previousBuildId: PREV,
    previousPools,
  });
  const deployment = (replicas: unknown) => ({
    exitCode: 0,
    stdout: JSON.stringify({ kind: "Deployment", spec: { replicas } }),
    stderr: "",
  });

  it("reads the outgoing build's live count per pool, by exact template-derived name", async () => {
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) =>
      args[2] === "my-app-ssr-buildm" ? deployment(6) : deployment(2),
    );
    const out = await readPreviousReplicas(opts(["ssr", "api"]));
    expect(out).toEqual(new Map([["ssr", 6] as const, ["api", 2] as const]));
    expect(vi.mocked(execCapture).mock.calls[1]![1][2]).toBe("my-app-api-buildm");
  });

  it("FAIL-CLOSED on an unreadable Deployment: refusing to guess the capacity target", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "connection refused",
    });
    await expect(readPreviousReplicas(opts())).rejects.toThrow(
      /Could not read the currently-serving deployment my-app-ssr-buildm/,
    );
    await expect(readPreviousReplicas(opts())).rejects.toThrow(/Nothing was cut over/);
  });

  it("FAIL-CLOSED on a non-positive or non-integer replica count", async () => {
    for (const bad of [0, -1, 1.5, "3", null]) {
      vi.mocked(execCapture).mockResolvedValue(deployment(bad));
      await expect(readPreviousReplicas(opts())).rejects.toThrow(
        /Could not read the live replica count/,
      );
    }
    // ...and an unparseable body is the same verdict, not an empty map.
    vi.mocked(execCapture).mockResolvedValue({ exitCode: 0, stdout: "{oops", stderr: "" });
    await expect(readPreviousReplicas(opts())).rejects.toThrow(
      /Could not parse the live deployment/,
    );
  });

  it("SKIPS a genuinely absent Deployment (--ignore-not-found: exit 0 + empty stdout)", async () => {
    // keep-at-birth/migrate should have preserved it, but a hand-deleted pool must not
    // brick every future promotion — the S18 one-ready-pod floor covers that pool instead.
    vi.mocked(execCapture).mockImplementation(async (_cmd, args) =>
      args[2] === "my-app-api-buildm" ? { exitCode: 0, stdout: "", stderr: "" } : deployment(4),
    );
    const out = await readPreviousReplicas(opts(["ssr", "api"]));
    expect(out).toEqual(new Map([["ssr", 4] as const]));
    expect(out.has("api")).toBe(false);
    expect(vi.mocked(execCapture).mock.calls[0]![1]).toContain("--ignore-not-found");
  });
});

describe("buildCutoverInputsFromCluster — assembling CutoverInputs from the three sources", () => {
  const metadata = (): JobEmitMetadata => readJobEmitMetadata(mount(metadataFixture()));

  it("runs cluster-CM-only and touches no persistent checkout", () => {
    const inputs = buildCutoverInputsFromCluster({
      metadata: metadata(),
      state: { buildId: PREV, previousBuildId: "older", poolTopologies: { [PREV]: ["ssr"] } },
      previousReplicasByPool: new Map([["ssr", 3]]),
    });
    expect(inputs.stateStore).toBe("cluster-only");
    expect(inputs.projectDir).toBe("/tmp");
    expect(inputs.outputDir).toBe("/tmp");
    expect(inputs.compositionSnapshot).toBeNull();
    expect(inputs.unretainedManifestBuild).toBeNull();
    expect(inputs.previousReplicasByPool).toEqual(new Map([["ssr", 3]]));
    expect(inputs.hasRouteExtJob).toBe(true);
    expect(inputs.hasEnvoyExtensionPolicy).toBe(true);
    expect(inputs.cdnEnabled).toBe(true);
  });

  it("the CLUSTER's serving build wins over emit's assumption (reverting to a non-serving build is N25)", () => {
    // A promotion landed between emit and this sync: emit-metadata says the previous build
    // is `buildm`, the state CM says `buildx` is serving. The gates verify against live truth.
    const inputs = buildCutoverInputsFromCluster({
      metadata: metadata(),
      state: {
        buildId: "buildx",
        previousBuildId: PREV,
        poolTopologies: { buildx: ["ssr", "api"] },
      },
      previousReplicasByPool: new Map(),
    });
    expect(inputs.previousBuildId).toBe("buildx");
    expect(inputs.previousPools).toEqual(["ssr", "api"]);
  });

  it("falls back to emit-metadata's previousBuildId when there is no state yet", () => {
    const inputs = buildCutoverInputsFromCluster({
      metadata: metadata(),
      state: null,
      previousReplicasByPool: new Map(),
    });
    expect(inputs.previousBuildId).toBe(PREV);
    // No recorded topology for it ⇒ nothing to park or revert to (E5/E6 no-op).
    expect(inputs.previousPools).toEqual([]);
  });

  it("a state CM already naming THIS build yields previousBuildId null (never self-revert)", () => {
    const inputs = buildCutoverInputsFromCluster({
      metadata: metadata(),
      state: { buildId: BUILD, previousBuildId: PREV, poolTopologies: { [BUILD]: ["ssr"] } },
      previousReplicasByPool: new Map(),
    });
    expect(inputs.previousBuildId).toBeNull();
  });
});
