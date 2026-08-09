// tests/cli/doctor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("../../src/cli/exec.js");
vi.mock("../../src/cli/state.js");
vi.mock("node:dns/promises", () => ({
  resolve4: vi.fn(),
  resolveCname: vi.fn(),
}));

import { runDoctor } from "../../src/cli/doctor.js";
import { execCapture } from "../../src/cli/exec.js";
import { readState } from "../../src/cli/state.js";
import { resolve4, resolveCname } from "node:dns/promises";

const RELEASE = "rel";
const STATIC_IP = "34.1.2.3";

interface ClusterData {
  deployments?: string;
  services?: string;
  endpoints?: string;
  pods?: string;
  logs?: string;
  svcneg?: string;
  te?: { exitCode: number; stdout: string };
  frs?: { exitCode: number; stdout: string };
  bsList?: string;
  health?: string;
  dnsAuth?: string;
}

/** Router-style execCapture stub: per-resource responses with sane passing defaults. */
function stubCluster(data: ClusterData): void {
  vi.mocked(execCapture).mockImplementation((async (cmd: string, args: string[]) => {
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const joined = args.join(" ");
    const has = (s: string) => joined.includes(s);
    if (args.includes("get-credentials")) return ok();
    if (args.includes("print-access-token")) return ok("token");
    if (args.includes("cluster-info")) return ok();
    if (args.includes("get-health")) return ok(data.health ?? "[]");
    if (args.includes("deployments")) return ok(data.deployments ?? "");
    if (args.includes("endpointslice")) return ok(data.endpoints ?? "");
    if (args.includes("pods")) return ok(data.pods ?? "");
    if (args.includes("logs")) return ok(data.logs ?? "");
    if (args.includes("svcneg")) return ok(data.svcneg ?? "");
    if (args.includes("lb-traffic-extensions"))
      return {
        exitCode: data.te?.exitCode ?? 0,
        stdout: data.te?.stdout ?? "gw-fr1;gw-fr2",
        stderr: "",
      };
    if (args.includes("forwarding-rules"))
      return {
        exitCode: data.frs?.exitCode ?? 0,
        stdout: data.frs?.stdout ?? "gw-fr1\ngw-fr2",
        stderr: "",
      };
    if (args.includes("backend-services") && args.includes("list")) return ok(data.bsList ?? "");
    if (has("value(loadBalancingScheme)")) return ok("EXTERNAL_MANAGED");
    if (has("value(backends)")) return ok("neg-group");
    if (args.includes("health-checks")) return ok("TCP");
    if (args.includes("certificates")) return ok("ACTIVE");
    if (args.includes("dns-authorizations"))
      return ok(data.dnsAuth ?? "_acme-challenge.app.example.com.\tCNAME\tabc123.");
    if (args.includes("gateway") && has("addresses[0]")) return ok(STATIC_IP);
    if (args.includes("gateway") && has("Accepted')]")) return ok("True");
    if (args.includes("gateway")) return ok("");
    if (args.includes("httproute")) return ok("True");
    if (args.includes("addresses")) return ok(STATIC_IP);
    if (args.includes("svc")) return ok(data.services ?? "");
    if (args.includes("buckets")) return ok();
    if (args.includes("repositories")) return ok();
    // Tool presence checks (gcloud/kubectl/helm/docker --version) and anything else.
    return ok(cmd === "kubectl" ? "" : "v1.0.0");
  }) as never);
}

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function printed(): string {
  return stripAnsi(
    vi
      .mocked(console.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n"),
  );
}

describe("runDoctor", () => {
  let tmpDir: string;
  const infraDir = () => path.join(tmpDir, ".k8s-adapter");

  function writeInfra(hosts: string[] = [], namespace?: string): void {
    mkdirSync(infraDir(), { recursive: true });
    writeFileSync(
      path.join(infraDir(), "infrastructure.json"),
      JSON.stringify({
        projectId: "proj-12345",
        region: "us-central1",
        hosts,
        gcsBucket: "proj-nextjs-static",
        containerRegistry: "us-central1-docker.pkg.dev/proj/nextjs",
        releaseName: RELEASE,
        ...(namespace ? { namespace } : {}),
      }),
    );
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-doctor-test-"));
    writeInfra();
    vi.clearAllMocks();
    vi.mocked(readState).mockResolvedValue(null as never);
    vi.mocked(resolve4).mockResolvedValue([STATIC_IP] as never);
    vi.mocked(resolveCname).mockResolvedValue(["abc123."] as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("classifies builds by EXACT version label — two builds sharing a 12-char prefix", async () => {
    // Regression: the old 12-char normalized-prefix substring match called BOTH of
    // these "current" (deploy's comments record that technique 503'ing production).
    const buildA = "aaaabbbbcccc1111";
    const buildB = "aaaabbbbcccc2222"; // identical first 12 normalized chars
    vi.mocked(readState).mockResolvedValue({ buildId: buildA, previousBuildId: null } as never);
    stubCluster({
      deployments:
        `rel-ssr-${buildA}|2/2|${buildA}\n` +
        `rel-ssr-${buildB}|0/0|${buildB}\n` +
        `rel-legacy|1/1|\n`, // no version label — cannot classify
    });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain(`Pool: ssr-${buildA}: 2/2 ready`);
    expect(out).toContain(`Pool: ssr-${buildB} [old]: 0/0 (pending cleanup)`);
    expect(out).not.toContain(`ssr-${buildB} [previous]`);
    // No version label → explicitly "unknown", never guessed current/old.
    expect(out).toContain(`Pool: legacy [unknown]: 1/1 ready`);
    // The current build WAS found — no "No pool Deployment found" failure.
    expect(out).not.toContain("No pool Deployment found");
  });

  it("endpoint check discovers active Services from the CLUSTER by NAME, ignoring stale local metadata", async () => {
    // Local metadata names pools that do NOT match the deployed release — the cluster
    // is the source of truth. Discovery must be by exact stable NAME (reconstructed
    // from the pool/component label): Helm rewrites the `managed-by:
    // adapter-k8s-active` label the template stamps to `managed-by: Helm` (see
    // rollback.ts), so the old label selector matched nothing at all.
    mkdirSync(path.join(infraDir(), "output"), { recursive: true });
    writeFileSync(
      path.join(infraDir(), "output", "build-metadata.json"),
      JSON.stringify({ pools: ["stale"] }),
    );
    stubCluster({
      // name|component lines: two active Services, one per-build (versioned) Service
      // that must NOT be endpoint-checked, and the routing tier which is excluded.
      services: "rel-ssr|ssr\nrel-api|api\nrel-ssr-buildn|ssr\nrel-routing-service|routing-service",
      endpoints: "true\ntrue",
    });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain("Active Service endpoints: rel-ssr: 2 ready");
    expect(out).toContain("Active Service endpoints: rel-api: 2 ready");
    expect(out).not.toContain("Active Service endpoints: rel-ssr-buildn");
    expect(out).not.toContain("Active Service endpoints: rel-routing-service");
    expect(out).not.toContain("rel-stale");
    expect(out).not.toContain("LOCAL build-metadata.json");
    // The discovery query selects by release name only (NOT the Helm-rewritten
    // adapter-k8s-active label) and is pinned to the default namespace.
    const svcCall = vi
      .mocked(execCapture)
      .mock.calls.find(([cmd, a]) => cmd === "kubectl" && a.includes("svc"))!;
    expect(svcCall[1].join(" ")).not.toContain("adapter-k8s-active");
    expect(svcCall[1].join(" ")).toContain(`-n default`);
    expect(svcCall[1].join(" ")).toContain(`app.kubernetes.io/name=${RELEASE}`);
  });

  it("endpoint check falls back to local metadata with a printed caveat", async () => {
    mkdirSync(path.join(infraDir(), "output"), { recursive: true });
    writeFileSync(
      path.join(infraDir(), "output", "build-metadata.json"),
      JSON.stringify({ pools: ["ssr"] }),
    );
    stubCluster({ services: "", endpoints: "true" });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain("LOCAL build-metadata.json");
    expect(out).toContain("Active Service endpoints: rel-ssr: 1 ready");
  });

  it("endpoint check falls back to local metadata when only versioned Services exist", async () => {
    // Cluster returns Services, but none matches the stable `<release>-<pool>` name —
    // discovery must not silently check nothing.
    mkdirSync(path.join(infraDir(), "output"), { recursive: true });
    writeFileSync(
      path.join(infraDir(), "output", "build-metadata.json"),
      JSON.stringify({ pools: ["ssr"] }),
    );
    stubCluster({ services: "rel-ssr-buildn|ssr", endpoints: "true" });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain("LOCAL build-metadata.json");
    expect(out).toContain("Active Service endpoints: rel-ssr: 1 ready");
  });

  it("endpoint check FAILs when an active Service has zero ready endpoints", async () => {
    stubCluster({ services: "rel-ssr|ssr", endpoints: "false" });

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(printed()).toContain("0 ready endpoints — selector matches no ready pods");
  });

  it("NEG check finds the Initialized condition BY TYPE (not conditions[0])", async () => {
    stubCluster({ svcneg: `rel-ssr|True\nrel-api|` });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    // The jsonpath must filter by condition type — positional conditions[0] reads
    // whichever condition sorts first.
    const calls = vi.mocked(execCapture).mock.calls.map(([, args]) => args.join(" "));
    expect(calls.some((a) => a.includes("svcneg") && a.includes("@.type=='Initialized'"))).toBe(
      true,
    );
    const out = printed();
    expect(out).toContain("Backend NEG: rel-ssr");
    expect(out).toContain("Initialized=not reported");
  });

  it("per-host DNS/cert checks: A record match, CNAME configured, cert ACTIVE", async () => {
    writeInfra(["app.example.com"]);
    stubCluster({});

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain(`A record: app.example.com -> ${STATIC_IP}`);
    expect(out).toContain("CNAME (cert auth): _acme-challenge.app.example.com. -> abc123.");
    expect(out).toContain("TLS certificate: Active");
  });

  it("per-host A record FAILs when DNS does not resolve", async () => {
    writeInfra(["app.example.com"]);
    vi.mocked(resolve4).mockRejectedValue(new Error("ENOTFOUND") as never);
    stubCluster({});

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    const out = printed();
    expect(out).toContain("A record: Does not resolve");
    expect(out).toContain(`Add DNS: app.example.com A ${STATIC_IP}`);
  });

  it("traffic-ext coverage WARNs instead of vacuously passing when FR enumeration fails", async () => {
    // Regression: the old code read .stdout unconditionally — a failed list call
    // produced "covers 2/0 forwarding rules", a PASS that proved nothing.
    stubCluster({ frs: { exitCode: 1, stdout: "" } });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain("could not be enumerated");
    expect(out).not.toContain("covers 2/0");
  });

  it("traffic-ext coverage FAILs when the extension covers fewer FRs than the release owns", async () => {
    stubCluster({
      te: { exitCode: 0, stdout: "gw-fr1" }, // only 1 of 2 covered
      frs: { exitCode: 0, stdout: "gw-fr1\ngw-fr2" },
    });

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(printed()).toContain("covers 1/2 forwarding rules — http:// can bypass middleware");
  });

  it("pod logs: transient error lines WARN, fatal signatures FAIL, all pods checked", async () => {
    stubCluster({
      pods: "rel-ssr-a\nrel-ssr-b",
      logs: "info ok\nError: transient request failure, retried\n",
    });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const out = printed();
    expect(out).toContain("error-level lines in 2/2 pod(s) — likely transient app errors");
    // All pods were queried, not just the first.
    const logCalls = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => args.includes("logs"))
      .map(([, args]) => args);
    expect(logCalls.length).toBe(2);
  });

  it("pod logs: FATAL is a hard FAIL", async () => {
    stubCluster({
      pods: "rel-ssr-a",
      logs: "starting\nFATAL: cannot bind port\n",
    });

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    expect(printed()).toContain("Fatal error in rel-ssr-a");
  });

  it("LB backend health skips OTHER releases' backends (hyphen-bounded match)", async () => {
    // `name~rel` is a substring regex: "otherrel-ssr" also matches. Its health must
    // not be consulted at all — a neighbour's unhealthy backend used to false-FAIL us.
    stubCluster({ bsList: "k8s1-abc-defaul-otherrel-ssr-80-xyz\nk8s1-abc-defaul-rel-ssr-80-xyz" });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const healthCalls = vi
      .mocked(execCapture)
      .mock.calls.filter(([, args]) => args.includes("get-health"))
      .map(([, args]) => args.join(" "));
    expect(healthCalls.length).toBe(1);
    expect(healthCalls[0]).toContain("k8s1-abc-defaul-rel-ssr-80-xyz");
  });

  it("LB health: a build-agnostic (Gateway-managed) backend is treated as current — unhealthy FAILs, never 'old build'", async () => {
    // Gateway-managed pool backend names never embed a build id, so the build
    // attribution can't fire for them. Fail closed: an unhealthy backend that can't be
    // positively attributed to the previous build must FAIL, not be waved through with
    // an "old build (pending cleanup)" label it may not deserve.
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    stubCluster({
      deployments: "rel-ssr-buildn|2/2|buildn\nrel-ssr-buildm|0/0|buildm",
      bsList: "gkegw1-abc-defau-rel-ssr-3000-hash",
      health: JSON.stringify([{ status: { healthStatus: [{ healthState: "UNHEALTHY" }] } }]),
    });

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );
    const out = printed();
    expect(out).toContain("LB health: rel-ssr-3000-hash: 0/1 healthy");
    expect(out).not.toContain("old build");
  });

  it("LB health: only a backend embedding the PREVIOUS build id gets the lenient pending-cleanup WARN", async () => {
    vi.mocked(readState).mockResolvedValue({
      buildId: "buildn",
      previousBuildId: "buildm",
    } as never);
    stubCluster({
      deployments: "rel-ssr-buildn|2/2|buildn\nrel-ssr-buildm|0/0|buildm",
      bsList: "k8s1-abc-defaul-rel-ssr-buildm-80-xyz",
      health: JSON.stringify([{ status: { healthStatus: [{ healthState: "UNHEALTHY" }] } }]),
    });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    expect(printed()).toContain("0/1 healthy (previous build, pending cleanup)");
  });

  it("pins kubectl resource reads to the default namespace", async () => {
    stubCluster({ deployments: "rel-ssr-buildn|2/2|buildn", pods: "rel-ssr-buildn-a" });

    await runDoctor({ projectDir: tmpDir, releaseName: RELEASE });

    const kubectlCalls = vi
      .mocked(execCapture)
      .mock.calls.filter(([cmd]) => cmd === "kubectl")
      .map(([, args]) => args);
    for (const resource of ["deployments", "gateway", "httproute", "pods", "svcneg", "logs"]) {
      const call = kubectlCalls.find((a) => a.includes(resource));
      expect(call, `kubectl ${resource} call`).toBeDefined();
      expect(call!.join(" "), `kubectl ${resource} pinned to -n default`).toContain("-n default");
    }
  });

  it("includes the configured namespace in kubectl remediation commands", async () => {
    writeInfra([], "apps");
    vi.mocked(readState).mockResolvedValue({ buildId: "buildn", previousBuildId: null } as never);
    stubCluster({
      deployments: "rel-ssr-buildn|0/1|buildn",
      services: "rel-ssr|ssr",
      endpoints: "false",
      pods: "rel-ssr-buildn-a",
      logs: "FATAL startup failed",
    });

    await expect(runDoctor({ projectDir: tmpDir, releaseName: RELEASE })).rejects.toThrow(
      /process\.exit:1/,
    );

    const out = printed();
    expect(out).toContain("kubectl describe deployment/rel-ssr-buildn -n apps");
    expect(out).toContain("kubectl get svc rel-ssr -n apps");
    expect(out).toContain("kubectl logs rel-ssr-buildn-a -n apps --tail=50");
  });
});
