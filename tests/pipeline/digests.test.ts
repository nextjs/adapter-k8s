// tests/pipeline/digests.test.ts
// Moved from tests/cli/deploy.test.ts with the GitOps PR1 extraction of the pipeline-safe
// deploy steps into src/pipeline/ (A8 registry digest resolution, S7/S23/S25/S27/S28). The
// tests are unchanged; only the import path moved.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/cli/exec.js");

import * as exec from "../../src/cli/exec.js";
import {
  resolveDeployImageDigests,
  resolveImageDigest,
  resolveRegistryDigest,
  resolveRegistryDigestAny,
} from "../../src/pipeline/digests.js";

describe("resolveRegistryDigestAny (S28: works on ECR/ACR/Harbor, not just Artifact Registry)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REF = "myregistry.example.com/ns/app:b1";
  const SHA = "sha256:" + "d".repeat(64);
  const singleManifest = JSON.stringify({ schemaVersion: 2, config: { digest: SHA }, layers: [] });
  const imageConfig = (architecture = "amd64") => JSON.stringify({ os: "linux", architecture });

  it("prefers crane when it is available", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd !== "crane") return { exitCode: 127, stdout: "", stderr: "not found" };
      if (args[0] === "manifest") return { exitCode: 0, stdout: singleManifest, stderr: "" };
      if (args[0] === "config") return { exitCode: 0, stdout: imageConfig(), stderr: "" };
      return { exitCode: 0, stdout: SHA + "\n", stderr: "" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("falls back to skopeo", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "skopeo"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ Digest: SHA, Os: "linux", Architecture: "amd64" }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "podman")).resolves.toBe(SHA);
  });

  it("falls back to `docker manifest inspect -v`, which needs no extra tooling", async () => {
    // VERIFIED against Artifact Registry: `docker manifest inspect -v` reported
    // sha256:ed188f20… byte-identical to `gcloud artifacts docker images describe`. It queries
    // the REGISTRY, so unlike `docker inspect` it is not the local daemon's opinion.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "docker" && args.includes("manifest")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            Descriptor: {
              digest: SHA,
              size: 1995,
              platform: { os: "linux", architecture: "amd64" },
            },
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("picks the TARGET PLATFORM's child from a manifest LIST, not the first entry", async () => {
    // This test previously asserted element [0], which encoded a real bug: the order of a
    // manifest list is the registry's, so an ARM-first list would pin the arm64 child and the
    // pods would die with `exec format error` on x86 nodes. The child digest is also not the
    // digest of the index the tag points at. Since the platform we build is fixed
    // (targetPlatform()), select the matching child explicitly.
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
              { Descriptor: { digest: SHA, platform: { os: "linux", architecture: "amd64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBe(SHA);
  });

  it("uses the build artifact platform when selecting a manifest-list child", async () => {
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: SHA, platform: { os: "linux", architecture: "amd64" } } },
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBe(ARM);
  });

  it("refuses a manifest LIST with no child for the platform we deploy", async () => {
    // Pinning an image that cannot run is worse than failing: it deploys, then CrashLoops with
    // `exec format error` after cutover has begun.
    const ARM = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? {
            exitCode: 0,
            stdout: JSON.stringify([
              { Descriptor: { digest: ARM, platform: { os: "linux", architecture: "arm64" } } },
            ]),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
  });

  it("rejects an amd64-only crane index when arm64 is requested", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "crane" && args[0] === "manifest"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              schemaVersion: 2,
              manifests: [
                {
                  digest: SHA,
                  platform: { os: "linux", architecture: "amd64" },
                },
              ],
            }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBeNull();
  });

  it("rejects a skopeo result whose reported platform differs from the request", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "skopeo"
        ? {
            exitCode: 0,
            stdout: JSON.stringify({ Digest: SHA, Os: "linux", Architecture: "amd64" }),
            stderr: "",
          }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "podman", "linux/arm64")).resolves.toBeNull();
  });

  it("rejects a single docker manifest without target-platform evidence", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "docker" && args.includes("manifest")
        ? { exitCode: 0, stdout: JSON.stringify({ Descriptor: { digest: SHA } }), stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "not found" }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker", "linux/arm64")).resolves.toBeNull();
  });

  it("does NOT use `docker manifest inspect` for a non-docker runtime", async () => {
    // nerdctl has no `manifest inspect`, and podman's is for manifest LISTS it manages
    // locally — neither answers for a remote registry.
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "x",
    } as never);
    await resolveRegistryDigestAny(REF, "nerdctl");
    const cmds = vi.mocked(exec.execCapture).mock.calls.map(([c]) => c);
    expect(cmds).not.toContain("nerdctl");
  });

  it("returns null when no probe can answer, so the caller fails closed", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "x",
    } as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
  });

  it("rejects a malformed digest rather than passing it to helm", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd !== "crane") return { exitCode: 127, stdout: "", stderr: "x" };
      if (args[0] === "manifest") return { exitCode: 0, stdout: singleManifest, stderr: "" };
      if (args[0] === "config") return { exitCode: 0, stdout: imageConfig(), stderr: "" };
      return { exitCode: 0, stdout: "not-a-digest\n", stderr: "" };
    }) as never);
    await expect(resolveRegistryDigestAny(REF, "docker")).resolves.toBeNull();
  });
});

describe("resolveRegistryDigest (S23: the registry is authoritative, not the local daemon)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REF = "us-central1-docker.pkg.dev/proj/nextjs/routing-service:build1";

  // `docker inspect` reports RepoDigests only when the LOCAL daemon recorded a push. podman,
  // buildx with certain drivers, and any push that did not go through this daemon leave it
  // empty — and the old code answered that by deploying the MUTABLE tag, on pods that hold
  // the internal dispatch secret. But the image was just pushed: the registry knows the
  // digest. VERIFIED live — `gcloud artifacts docker images describe` returned byte-identical
  // sha256 to `docker inspect` for the same ref.
  it("resolves the digest from the registry", async () => {
    const digest = "sha256:" + "a".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: digest + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [{ digest, platform: { os: "linux", architecture: "amd64" } }],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBe("sha256:" + "a".repeat(64));
    const args = vi.mocked(exec.execCapture).mock.calls[0]?.[1];
    expect(args).toContain("--format=value(image_summary.digest)");
    expect(args).toContain(REF);
  });

  it("does not accept an amd64-only Artifact Registry index for an arm64 deploy", async () => {
    const index = "sha256:" + "f".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: index + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [
              {
                digest: "sha256:" + "a".repeat(64),
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(resolveRegistryDigest(REF, "proj", "linux/arm64")).resolves.toBeNull();
  });

  it("returns null when the registry cannot be reached", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBeNull();
  });

  it("returns null on a malformed digest rather than passing it to helm", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode: 0,
      stdout: "not-a-digest\n",
      stderr: "",
    });
    await expect(resolveRegistryDigest(REF, "proj")).resolves.toBeNull();
  });
});

describe("S27: image integrity must not depend on the CLOUD", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  it("resolves digests for a generic build with no GCP project", () => {
    // The digest block was gated on `infra.projectId`, which only a GCP config has. A generic
    // deploy therefore skipped resolution entirely and shipped MUTABLE TAGS — silently
    // bypassing the --allow-mutable-tags gate that exists precisely to make that a decision
    // rather than an accident. The registry probe is provider-specific; the REQUIREMENT is not.
    const SHA = "sha256:" + "c".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "inspect") {
        const ref = args[args.length - 1]!;
        return {
          exitCode: 0,
          stdout: `linux/amd64\n${ref.slice(0, ref.lastIndexOf(":"))}@${SHA}\n`,
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: "no gcloud here" };
    }) as never);

    return expect(
      resolveDeployImageDigests({
        refs: [["ssr", "registry.example.com/ns/app:b1"]],
        projectId: "",
        containerCli: "docker",
      }),
    ).resolves.toEqual({ ssr: SHA });
  });

  it("still fails closed for a generic build when nothing can pin the image", () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "x" });
    return expect(
      resolveDeployImageDigests({
        refs: [["ssr", "registry.example.com/ns/app:b1"]],
        projectId: "",
      }),
    ).rejects.toThrow(/--allow-mutable-tags/);
  });

  it("runs the platform-aware probe chain once per image, even when it comes up empty", async () => {
    // resolveRegistryDigest ends by running the crane/skopeo/docker-manifest chain; the
    // caller's ?? fallback used to run the IDENTICAL chain again whenever that answer was
    // null — doubling every probe subprocess on exactly the slow path (no crane/skopeo
    // installed, image genuinely unresolvable).
    vi.mocked(exec.execCapture).mockImplementation((async (command: string) => {
      if (command === "gcloud") {
        return { exitCode: 0, stdout: "sha256:" + "e".repeat(64) + "\n", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "us-central1-docker.pkg.dev/proj/repo/app:b1"]],
        projectId: "proj",
        allowMutableTags: true,
      }),
    ).resolves.toEqual({});
    const craneCalls = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(([command, args]) => command === "crane" && args?.[0] === "manifest");
    expect(craneCalls).toHaveLength(1);
  });

  it("does not probe Artifact Registry when the plan selects OCI distribution", async () => {
    const SHA = "sha256:" + "d".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (command: string, args: string[]) => {
      if (command === "crane" && args[0] === "manifest") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            schemaVersion: 2,
            manifests: [{ digest: SHA, platform: { os: "linux", architecture: "amd64" } }],
          }),
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "us-central1-docker.pkg.dev/proj/repo/app:b1"]],
        projectId: "proj",
        digestLookup: { kind: "oci-distribution" },
      }),
    ).resolves.toEqual({ ssr: SHA });
    expect(vi.mocked(exec.execCapture).mock.calls.some(([command]) => command === "gcloud")).toBe(
      false,
    );
  });
});

describe("resolveDeployImageDigests (S23: image integrity fails closed)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
  });

  const REFS: Array<[string, string]> = [
    ["ssr", "reg/nextjs-app-ssr:build1"],
    ["routingService", "reg/routing-service:build1"],
  ];
  const SHA_A = "sha256:" + "a".repeat(64);
  const SHA_B = "sha256:" + "b".repeat(64);
  const dockerOk = (ref: string, sha: string) => ({
    exitCode: 0,
    stdout: `linux/amd64\n${ref.slice(0, ref.lastIndexOf(":"))}@${sha}\n`,
    stderr: "",
  });
  const craneIndex = (ref: string, digest: string, architecture = "amd64") => ({
    exitCode: 0,
    stdout: JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          digest,
          platform: { os: "linux", architecture },
          annotations: { ref },
        },
      ],
    }),
    stderr: "",
  });

  // NOTE: this originally asserted the OPPOSITE — local-first, with the registry as fallback
  // and an explicit "no registry round-trip" check. Running a real podman deploy disproved
  // that premise (see the S25 cases below): podman's local RepoDigest is not the digest the
  // registry stores, and deploying it fails the rollout. Registry-first is the contract now.
  it("uses the platform-validated registry digest", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") {
        const ref = args.find((a) => a.includes("/")) ?? "";
        return {
          exitCode: 0,
          stdout: (ref.includes("routing") ? SHA_B : SHA_A) + "\n",
          stderr: "",
        };
      }
      if (cmd === "crane" && args[0] === "manifest") {
        const ref = args[1]!;
        return craneIndex(ref, ref.includes("routing") ? SHA_B : SHA_A);
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).resolves.toEqual({
      ssr: SHA_A,
      routingService: SHA_B,
    });
  });

  it("S25: prefers the REGISTRY over the local daemon (podman reports a different digest)", async () => {
    // MEASURED with podman 6.0.1 against Artifact Registry: podman converts the manifest on
    // push, so its local RepoDigest is NOT the digest the registry stored —
    //   podman inspect : sha256:e04a0a5b…
    //   registry       : sha256:27fa476b…
    // Deploying the local one produced ImagePullBackOff and a failed rollout on a live
    // cluster. The registry is what kubelet pulls from, so the registry is the truth; the
    // local daemon is only a fallback for when the registry cannot be reached.
    const LOCAL = "sha256:" + "e".repeat(64);
    const REGISTRY = "sha256:" + "7".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: REGISTRY + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, REGISTRY);
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, LOCAL);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(REGISTRY);
    expect(out.routingService).toBe(REGISTRY);
  });

  it("S28: uses the generic registry probe when there is no GCP project", async () => {
    // An ECR/ACR/Harbor deploy has no projectId, so the AR probe no-ops. Before this it fell
    // straight to the local daemon — the path podman gets wrong.
    const SHA = "sha256:" + "9".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) =>
      cmd === "crane" && args[0] === "manifest"
        ? craneIndex(args[1]!, SHA)
        : { exitCode: 127, stdout: "", stderr: "x" }) as never);

    const out = await resolveDeployImageDigests({
      refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
      projectId: "",
      containerCli: "docker",
    });
    expect(out.ssr).toBe(SHA);
  });

  it("S28: prefers the REGISTRY over a disagreeing local daemon on any registry", async () => {
    const LOCAL = "sha256:" + "e".repeat(64);
    const REGISTRY = "sha256:" + "7".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, REGISTRY);
      if (cmd === "docker" && args.includes("inspect")) {
        const ref = args[args.length - 1]!;
        return dockerOk(ref, LOCAL);
      }
      return { exitCode: 127, stdout: "", stderr: "x" };
    }) as never);

    const out = await resolveDeployImageDigests({
      refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
      projectId: "",
      containerCli: "docker",
    });
    expect(out.ssr).toBe(REGISTRY);
  });

  it("S28: does NOT trust a non-docker local daemon when no registry answered", async () => {
    // MEASURED with podman 6.0.1: its local RepoDigest matched the registry for one image and
    // differed for another (e04a0a5b… vs 27fa476b…), because push can rewrite the manifest.
    // An unreliable digest is worse than none — deploying it yields ImagePullBackOff at
    // rollout, after cutover has begun. Failing at deploy time is the louder, earlier failure.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "podman" && args.includes("inspect")) {
        const ref = args[args.length - 1]!;
        return {
          exitCode: 0,
          stdout: `${ref.slice(0, ref.lastIndexOf(":"))}@sha256:${"f".repeat(64)}\n`,
          stderr: "",
        };
      }
      return { exitCode: 127, stdout: "", stderr: "x" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "myregistry.example.com/ns/app:b1"]],
        projectId: "",
        containerCli: "podman",
      }),
    ).rejects.toThrow(/crane|skopeo/);
  });

  it("rejects an amd64-only registry and local image when the artifact targets arm64", async () => {
    const INDEX = "sha256:" + "1".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: INDEX + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") {
        return craneIndex(args[1]!, SHA_A, "amd64");
      }
      if (cmd === "skopeo") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ Digest: INDEX, Os: "linux", Architecture: "amd64" }),
          stderr: "",
        };
      }
      if (cmd === "docker" && args.includes("manifest")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Descriptor: {
                digest: SHA_A,
                platform: { os: "linux", architecture: "amd64" },
              },
            },
          ]),
          stderr: "",
        };
      }
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, SHA_A);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(
      resolveDeployImageDigests({
        refs: [["ssr", "us-docker.pkg.dev/p/r/app:b1"]],
        projectId: "p",
        targetPlatform: "linux/arm64",
      }),
    ).rejects.toThrow(/No registry probe could pin/);
  });

  it("S25: falls back to the local daemon when the registry is unreachable", async () => {
    const LOCAL = "sha256:" + "e".repeat(64);
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 1, stdout: "", stderr: "offline" };
      if (cmd === "docker" && args[0] === "inspect") return dockerOk(args.at(-1)!, LOCAL);
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    const out = await resolveDeployImageDigests({ refs: REFS, projectId: "proj" });
    expect(out.ssr).toBe(LOCAL);
  });

  it("falls back to the registry when the local daemon has no RepoDigest", async () => {
    // The podman / buildx / pushed-elsewhere case. Previously this silently deployed the
    // mutable tag; now the registry answers it.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "gcloud") return { exitCode: 0, stdout: SHA_A + "\n", stderr: "" };
      if (cmd === "crane" && args[0] === "manifest") return craneIndex(args[1]!, SHA_A);
      if (cmd === "docker" && args[0] === "inspect") {
        return { exitCode: 0, stdout: "linux/amd64\n", stderr: "" };
      }
      return { exitCode: 127, stdout: "", stderr: "not found" };
    }) as never);

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).resolves.toEqual({
      ssr: SHA_A,
      routingService: SHA_A,
    });
  });

  it("THROWS when neither source can pin an image (no silent mutable-tag deploy)", async () => {
    // A retag of the mutable tag changes what runs on the next pod start or scale-up, on pods
    // that receive the internal dispatch secret and the cache credentials. That is an image
    // integrity failure, not a warning — the repo's own idiom is fail-closed plus an explicit
    // opt-out flag (cf. --allow-no-network-policy).
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });

    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).rejects.toThrow(
      /--allow-mutable-tags/,
    );
  });

  it("names the images it could not pin", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(resolveDeployImageDigests({ refs: REFS, projectId: "proj" })).rejects.toThrow(
      /routing-service:build1/,
    );
  });

  it("--allow-mutable-tags opts out: warns and omits the unpinned entries", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "nope" });
    await expect(
      resolveDeployImageDigests({ refs: REFS, projectId: "proj", allowMutableTags: true }),
    ).resolves.toEqual({});
  });
});

// ---------------------------------------------------------------------------
// resolveImageDigest — RepoDigests belongs to the image ID, so one local image tagged and
// pushed to several repositories carries an entry per repository. Taking index 0 and pairing
// its digest with the repository being deployed can name a manifest that does not exist there,
// leaving the new pods in ImagePullBackOff.
// ---------------------------------------------------------------------------
describe("resolveImageDigest", () => {
  const DIGEST_A = `sha256:${"a".repeat(64)}`;
  const DIGEST_B = `sha256:${"b".repeat(64)}`;

  function mockInspect(stdout: string, exitCode = 0) {
    vi.mocked(exec.execCapture).mockResolvedValue({
      exitCode,
      stdout: exitCode === 0 ? `linux/amd64\n${stdout}` : stdout,
      stderr: "",
    });
  }

  it("selects the entry whose repository matches the pushed image", async () => {
    mockInspect(
      `other.registry/nextjs-app-ssr@${DIGEST_B}\ngcr.io/proj/nextjs-app-ssr@${DIGEST_A}\n`,
    );
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBe(DIGEST_A);
  });

  it("returns null when no entry matches, rather than guessing", async () => {
    mockInspect(`other.registry/nextjs-app-ssr@${DIGEST_B}\n`);
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });

  it("returns null (deploy warns, does not fail) when inspect fails or reports nothing", async () => {
    mockInspect("", 1);
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
    mockInspect("\n");
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });

  it("rejects a malformed digest", async () => {
    mockInspect("gcr.io/proj/nextjs-app-ssr@sha256:nope\n");
    await expect(resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1")).resolves.toBeNull();
  });

  it("rejects a local image built for a different platform", async () => {
    mockInspect(`gcr.io/proj/nextjs-app-ssr@${DIGEST_A}\n`);
    await expect(
      resolveImageDigest("gcr.io/proj/nextjs-app-ssr:b1", "docker", "linux/arm64"),
    ).resolves.toBeNull();
  });
});
