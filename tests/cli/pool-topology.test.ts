import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/cli/exec.js");

import { execCapture } from "../../src/cli/exec.js";
import { discoverBuildPools, recordedBuildPools } from "../../src/cli/pool-topology.js";

describe("recordedBuildPools", () => {
  it("preserves the recorded order without exposing state for mutation", () => {
    const state = {
      buildId: "buildn",
      previousBuildId: "buildm",
      poolTopologies: { buildm: ["web", "api"] },
    };
    const pools = recordedBuildPools(state, "buildm");
    expect(pools).toEqual(["web", "api"]);
    pools!.push("other");
    expect(state.poolTopologies.buildm).toEqual(["web", "api"]);
  });

  it("distinguishes legacy absence from an explicitly malformed empty topology", () => {
    expect(recordedBuildPools({ buildId: "b", previousBuildId: null }, "b")).toBeNull();
    expect(() =>
      recordedBuildPools({ buildId: "b", previousBuildId: null, poolTopologies: { b: [] } }, "b"),
    ).toThrow(/invalid pool topology.*non-empty array/s);
  });

  it("rejects duplicate and unsafe pool names", () => {
    expect(() =>
      recordedBuildPools(
        { buildId: "b", previousBuildId: null, poolTopologies: { b: ["api", "api"] } },
        "b",
      ),
    ).toThrow(/duplicate pool "api"/);
    expect(() =>
      recordedBuildPools(
        { buildId: "b", previousBuildId: null, poolTopologies: { b: ["bad/name"] } },
        "b",
      ),
    ).toThrow(/Invalid pool name/);
  });
});

describe("discoverBuildPools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("migrates a legacy state from exact versioned Deployment identity", async () => {
    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: "rel-api-buildm",
              labels: {
                "app.kubernetes.io/component": "api",
                "app.kubernetes.io/version": "buildm",
              },
            },
          },
          {
            metadata: {
              name: "rel-web-buildm",
              labels: {
                "app.kubernetes.io/component": "web",
                "app.kubernetes.io/version": "buildm",
              },
            },
          },
        ],
      }),
      stderr: "",
    });

    await expect(discoverBuildPools("rel", "buildm", "apps")).resolves.toEqual(["api", "web"]);
    expect(vi.mocked(execCapture)).toHaveBeenCalledWith(
      "kubectl",
      expect.arrayContaining([
        "deployments",
        "-n",
        "apps",
        "-l",
        "app.kubernetes.io/name=rel,app.kubernetes.io/version=buildm,app.kubernetes.io/component!=routing-service",
        "json",
      ]),
    );
  });

  it("fails closed on absent, unreadable, or inconsistently-labelled topology", async () => {
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"items":[]}',
      stderr: "",
    });
    await expect(discoverBuildPools("rel", "buildm")).rejects.toThrow(
      /Could not recover any pool Deployment/,
    );

    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "deployments is forbidden",
    });
    await expect(discoverBuildPools("rel", "buildm")).rejects.toThrow(
      /incomplete topology can delete or strand rollback pools/,
    );

    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: "rel-not-api-buildm",
              labels: {
                "app.kubernetes.io/component": "api",
                "app.kubernetes.io/version": "buildm",
              },
            },
          },
        ],
      }),
      stderr: "",
    });
    await expect(discoverBuildPools("rel", "buildm")).rejects.toThrow(
      /claims pool "api".*adapter-derived name is "rel-api-buildm"/s,
    );
  });

  it('missingBuild "empty" downgrades ONLY the fully-absent topology', async () => {
    // A rebuilt cluster (or an externally cleaned namespace) holds NOTHING of the recorded
    // previous build. Deploy opts into [] here — refusing bricked every subsequent deploy
    // against state the operator could only repair by hand-editing state.json.
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"items":[]}',
      stderr: "",
    });
    await expect(
      discoverBuildPools("rel", "buildm", undefined, { missingBuild: "empty" }),
    ).resolves.toEqual([]);

    // Everything short of fully-absent still fails closed in the SAME mode: a kubectl
    // error hides an unknown amount of topology…
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 1,
      stdout: "",
      stderr: "deployments is forbidden",
    });
    await expect(
      discoverBuildPools("rel", "buildm", undefined, { missingBuild: "empty" }),
    ).rejects.toThrow(/incomplete topology can delete or strand rollback pools/);

    // …and an inconsistently-labelled Deployment is a PARTIAL topology, not an absent one.
    vi.mocked(execCapture).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({
        items: [
          {
            metadata: {
              name: "rel-not-api-buildm",
              labels: {
                "app.kubernetes.io/component": "api",
                "app.kubernetes.io/version": "buildm",
              },
            },
          },
        ],
      }),
      stderr: "",
    });
    await expect(
      discoverBuildPools("rel", "buildm", undefined, { missingBuild: "empty" }),
    ).rejects.toThrow(/Refusing to trust inconsistent labels/);
  });
});
