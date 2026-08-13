// S24: the adapter shelled out to a hardcoded `docker` everywhere. The verbs it uses —
// build / push / inspect / run / rm / exec — are the portable subset that podman and nerdctl
// accept with identical flags, so the binary name is the only thing that was ever
// docker-specific. This module resolves it once.
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as exec from "../../src/cli/exec.js";
import {
  resolveContainerCli,
  CONTAINER_CLI_CANDIDATES,
  TARGET_PLATFORM,
  targetPlatform,
  resetContainerCliCache,
  checkContainerRuntime,
} from "../../src/cli/container-runtime.js";

vi.mock("../../src/cli/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/cli/exec.js")>();
  return {
    EXEC_TIMEOUTS: actual.EXEC_TIMEOUTS,
    execCapture: vi.fn(),
    execOrThrow: vi.fn(),
  };
});

const ok = { exitCode: 0, stdout: "ok\n", stderr: "" };
const missing = { exitCode: 127, stdout: "", stderr: "command not found" };

describe("resolveContainerCli", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
    delete process.env.ADAPTER_K8S_CONTAINER_CLI;
    // The resolver caches its probe for the process; each case probes afresh.
    resetContainerCliCache();
  });

  it("prefers docker when it is available", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(ok as never);
    await expect(resolveContainerCli()).resolves.toBe("docker");
  });

  it("falls back to podman when docker is absent", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "docker" ? missing : ok) as never);
    await expect(resolveContainerCli()).resolves.toBe("podman");
  });

  it("falls back to nerdctl when neither docker nor podman is present", async () => {
    // nerdctl needs buildkit too — see the buildctl case below.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "nerdctl" || cmd === "buildctl" ? ok : missing) as never);
    await expect(resolveContainerCli()).resolves.toBe("nerdctl");
  });

  it("honours an explicit ADAPTER_K8S_CONTAINER_CLI override", async () => {
    process.env.ADAPTER_K8S_CONTAINER_CLI = "podman";
    vi.mocked(exec.execCapture).mockResolvedValue(ok as never);
    await expect(resolveContainerCli()).resolves.toBe("podman");
  });

  it("still capability-checks an explicit override", async () => {
    // Forcing nerdctl used to skip canBuild entirely, so a deploy on a host with no reachable
    // buildkit sailed past preflight, PROVISIONED MEMORYSTORE, and only then died on the
    // first build. An override says which runtime to use, not that checking is unnecessary.
    process.env.ADAPTER_K8S_CONTAINER_CLI = "nerdctl";
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "buildctl" ? { exitCode: 1, stdout: "", stderr: "no workers" } : ok) as never);
    await expect(resolveContainerCli()).rejects.toThrow(/buildkit/i);
  });

  it("rejects an override that is not a known runtime (it reaches argv)", async () => {
    process.env.ADAPTER_K8S_CONTAINER_CLI = "rm -rf /";
    await expect(resolveContainerCli()).rejects.toThrow(/ADAPTER_K8S_CONTAINER_CLI/);
  });

  it("throws a single actionable error when no runtime is installed", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(missing as never);
    await expect(resolveContainerCli()).rejects.toThrow(
      /No container runtime found.*docker.*podman.*nerdctl/s,
    );
  });

  it("skips a runtime that is installed but whose daemon is unreachable", async () => {
    // MEASURED, not assumed: `nerdctl version` exits 0 with no containerd socket and no
    // buildctl — it reports the CLIENT. Only `info` talks to the daemon (`nerdctl info` exits
    // 1 there, as does `nerdctl images`). Probing `version` would therefore select a runtime
    // that cannot build anything, and the failure would surface much later, mid-push.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, args: string[]) => {
      if (cmd === "docker") return missing;
      if (cmd === "podman") return args[0] === "info" ? ok : ok;
      // nerdctl: client responds, daemon does not.
      return args[0] === "info" ? { exitCode: 1, stdout: "", stderr: "no containerd" } : ok;
    }) as never);

    await expect(resolveContainerCli()).resolves.toBe("podman");
  });

  it("probes the daemon, not just the client binary", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(ok as never);
    await resolveContainerCli();
    const probes = vi.mocked(exec.execCapture).mock.calls.map(([, a]) => (a as string[])[0]);
    expect(probes).toContain("info");
    expect(probes).not.toContain("version");
  });

  it("rejects nerdctl when buildkit is absent (containerd alone cannot build)", async () => {
    // MEASURED: with containerd reachable (`nerdctl info` exits 0, `nerdctl images` works),
    // `nerdctl build` STILL fails — buildkit is a separate daemon and nerdctl shells out to
    // `buildctl`. On this host it died with: `buildctl` needs to be installed and
    // `buildkitd` needs to be running. `info` alone therefore over-reports capability, and
    // the deploy's entire purpose is to build. nerdctl names buildctl-in-PATH as the
    // requirement, so that is what we check.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) => {
      if (cmd === "docker" || cmd === "podman") return missing;
      if (cmd === "buildctl") return { exitCode: 1, stdout: "", stderr: "failed to list workers" };
      return ok; // nerdctl info succeeds
    }) as never);

    await expect(resolveContainerCli()).rejects.toThrow(/No container runtime/);
  });

  it("accepts nerdctl when buildkit is present", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "docker" || cmd === "podman" ? missing : ok) as never);
    await expect(resolveContainerCli()).resolves.toBe("nerdctl");
  });

  it("finds buildkit on nerdctl's ROOTLESS socket when the default host is unreachable", async () => {
    // MEASURED, third correction: with rootless buildkit healthy and `nerdctl build`
    // WORKING, a bare `buildctl debug workers` still failed — buildctl defaults to
    // /run/buildkit/buildkitd.sock (root-owned, permission denied) while nerdctl uses
    // $XDG_RUNTIME_DIR/buildkit{-default}/buildkitd.sock. Probing the default host alone
    // therefore REFUSES a runtime that works, which is worse than the bug it replaced.
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, _a: string[], o?: any) => {
      if (cmd === "docker" || cmd === "podman") return missing;
      if (cmd !== "buildctl") return ok; // nerdctl info
      const host = o?.env?.BUILDKIT_HOST ?? "";
      return host.includes("/run/user/1000/buildkit")
        ? ok
        : { exitCode: 1, stdout: "", stderr: "permission denied" };
    }) as never);

    await expect(resolveContainerCli()).resolves.toBe("nerdctl");
  });

  it("honours an explicit BUILDKIT_HOST", async () => {
    process.env.BUILDKIT_HOST = "unix:///custom/buildkitd.sock";
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string, _a: string[], o?: any) => {
      if (cmd === "docker" || cmd === "podman") return missing;
      if (cmd !== "buildctl") return ok;
      return o?.env?.BUILDKIT_HOST === "unix:///custom/buildkitd.sock"
        ? ok
        : { exitCode: 1, stdout: "", stderr: "nope" };
    }) as never);

    await expect(resolveContainerCli()).resolves.toBe("nerdctl");
    delete process.env.BUILDKIT_HOST;
  });

  it("probes buildkit's DAEMON, not just the buildctl binary", async () => {
    // MEASURED, second correction: `buildctl --version` passes with the binary merely
    // installed, while `nerdctl build` still fails when no buildkitd is REACHABLE. On this
    // host buildkitd ran as root on /run/buildkit/buildkitd.sock (srw-rw---- root root) with
    // no rootless daemon in /run/user/1000, so nerdctl could not build at all.
    // `buildctl debug workers` dials the daemon; `--version` does not.
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "docker" || cmd === "podman" ? missing : ok) as never);
    await resolveContainerCli();
    const buildctlArgs = vi
      .mocked(exec.execCapture)
      .mock.calls.filter(([c]) => c === "buildctl")
      .map(([, a]) => (a as string[]).join(" "));
    expect(buildctlArgs.some((a) => a.includes("debug workers"))).toBe(true);
    expect(buildctlArgs.some((a) => a.includes("--version"))).toBe(false);
  });

  it("does not require buildctl for docker or podman (they build in-daemon)", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "buildctl" ? missing : ok) as never);
    await expect(resolveContainerCli()).resolves.toBe("docker");
  });

  it("candidate order is docker, podman, nerdctl", () => {
    expect(CONTAINER_CLI_CANDIDATES).toEqual(["docker", "podman", "nerdctl"]);
  });

  it("targets linux/amd64 — GKE's default node architecture", () => {
    // Without an explicit platform an Apple-Silicon host builds arm64 images that die with
    // `exec format error` on x86 nodes. Overridable for ARM (T2A) node pools.
    expect(TARGET_PLATFORM).toBe("linux/amd64");
  });

  it("supports linux/arm64 and rejects platforms the emitted runtime cannot stage", () => {
    process.env.ADAPTER_K8S_TARGET_PLATFORM = "linux/arm64";
    expect(targetPlatform()).toBe("linux/arm64");
    process.env.ADAPTER_K8S_TARGET_PLATFORM = "linux/arm/v7";
    expect(() => targetPlatform()).toThrow(/supported target platform/);
    delete process.env.ADAPTER_K8S_TARGET_PLATFORM;
  });
});

describe("checkContainerRuntime (S24: doctor must not fail a podman-only host)", () => {
  beforeEach(() => {
    vi.mocked(exec.execCapture).mockReset();
    delete process.env.ADAPTER_K8S_CONTAINER_CLI;
    resetContainerCliCache();
  });

  it("passes and names the runtime it found", async () => {
    vi.mocked(exec.execCapture).mockImplementation((async (cmd: string) =>
      cmd === "podman"
        ? { exitCode: 0, stdout: "podman version 5.0.0\n", stderr: "" }
        : missing) as never);
    const r = await checkContainerRuntime();
    expect(r.status).toBe("pass");
    expect(r.message).toContain("podman");
  });

  it("fails only when NO runtime is available, and says which are accepted", async () => {
    vi.mocked(exec.execCapture).mockResolvedValue(missing as never);
    const r = await checkContainerRuntime();
    expect(r.status).toBe("fail");
    expect(r.fix).toMatch(/podman/);
  });
});
