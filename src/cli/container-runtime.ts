// src/cli/container-runtime.ts
//
// S24: which container CLI the deploy shells out to.
//
// Every container invocation in this codebase uses the portable verb subset — `build -t/-f`,
// `push`, `inspect --format`, `run`, `rm`, `exec` — which podman and nerdctl accept with the
// same flags docker does. The hardcoded `"docker"` string was therefore the only thing tying
// the adapter to one runtime, and this module removes it.
import { execCapture } from "./exec.js";
export {
  DEFAULT_TARGET_PLATFORM as TARGET_PLATFORM,
  parseTargetPlatform,
  targetPlatform,
} from "../target-platform.js";

/**
 * Probe order. docker first because it is the most common and the one every existing deploy
 * already used; podman next (the usual rootless replacement); then nerdctl (containerd).
 */
export const CONTAINER_CLI_CANDIDATES = ["docker", "podman", "nerdctl"] as const;

export type ContainerCli = (typeof CONTAINER_CLI_CANDIDATES)[number];

/**
 * The architecture GKE nodes run. Builds are pinned to it explicitly because a host-native
 * build on Apple Silicon produces arm64 images that fail with `exec format error` on the x86
 * nodes this chart targets — loud, but only after a rollout. Override with
 * `ADAPTER_K8S_TARGET_PLATFORM` for an ARM (T2A) node pool.
 */
/**
 * Can this runtime actually BUILD, not merely talk to its daemon?
 *
 * docker and podman build in-process/in-daemon, so a reachable daemon is sufficient. nerdctl
 * does not: `build` shells out to buildkit, a SEPARATE daemon. MEASURED on a host with
 * containerd healthy (`nerdctl info` 0, `nerdctl images` fine) — `nerdctl build` still died
 * with "`buildctl` needs to be installed and `buildkitd` needs to be running". So `info`
 * over-reports capability for nerdctl, and since building is the entire point of the deploy,
 * a runtime that cannot build is not a candidate.
 *
 * The probe is `buildctl debug workers`, which DIALS buildkitd. `buildctl --version` is not
 * enough — measured on the same host after installing buildkit: the binary answered
 * `--version` fine while `nerdctl build` still failed, because buildkitd was running as root
 * on /run/buildkit/buildkitd.sock (srw-rw---- root root) and nerdctl rootless looks in
 * /run/user/1000. Installed is not the same as reachable. `debug workers` is also
 * non-destructive, unlike `nerdctl builder prune`, which probes buildkit by wiping the cache.
 */
async function canBuild(candidate: ContainerCli): Promise<boolean> {
  if (candidate !== "nerdctl") return true;
  // Try the SAME hosts nerdctl tries, in its order. A bare `buildctl debug workers` is not
  // enough: buildctl defaults to /run/buildkit/buildkitd.sock, which on a host that also runs
  // a system buildkitd is root-owned and denies us — MEASURED to report failure while
  // `nerdctl build` succeeded against the rootless socket. Refusing a runtime that works is
  // worse than the over-reporting this check was added to fix.
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`;
  const hosts = process.env.BUILDKIT_HOST
    ? [process.env.BUILDKIT_HOST]
    : [
        `unix://${runtimeDir}/buildkit-default/buildkitd.sock`,
        `unix://${runtimeDir}/buildkit/buildkitd.sock`,
        // Last: buildctl's own default (the system socket), for a root//privileged setup.
        "",
      ];
  for (const host of hosts) {
    const res = await execCapture(
      "buildctl",
      ["debug", "workers"],
      host ? { env: { BUILDKIT_HOST: host } } : {},
    ).catch(() => null);
    if (res && res.exitCode === 0) return true;
  }
  return false;
}

let cached: ContainerCli | undefined;

/**
 * Resolve the container CLI to use, once per process.
 *
 * `ADAPTER_K8S_CONTAINER_CLI` forces a specific runtime and skips probing. It is checked
 * against the known set rather than trusted: the value becomes argv[0] of a spawned process,
 * so an arbitrary string here would be command execution by configuration.
 */
export async function resolveContainerCli(): Promise<ContainerCli> {
  const override = process.env.ADAPTER_K8S_CONTAINER_CLI?.trim();
  if (override) {
    if (!(CONTAINER_CLI_CANDIDATES as readonly string[]).includes(override)) {
      throw new Error(
        `ADAPTER_K8S_CONTAINER_CLI=${JSON.stringify(override)} is not a supported container ` +
          `runtime. Expected one of: ${CONTAINER_CLI_CANDIDATES.join(", ")}.`,
      );
    }
    const forced = override as ContainerCli;
    // An override picks WHICH runtime, not whether it can work. Skipping this let a forced
    // nerdctl past preflight on a host with no reachable buildkit — the deploy then
    // provisioned Memorystore and died on the first build.
    if (!(await canBuild(forced))) {
      throw new Error(
        `ADAPTER_K8S_CONTAINER_CLI=${forced} was requested, but it cannot build images here: ` +
          `buildkit is not reachable (\`buildctl debug workers\` failed). nerdctl needs a ` +
          `running buildkitd it can reach — a root-owned /run/buildkit/buildkitd.sock is not ` +
          `reachable by a rootless nerdctl. See ` +
          `\`containerd-rootless-setuptool.sh install-buildkit\`, or use docker/podman.`,
      );
    }
    return forced;
  }
  if (cached) return cached;

  for (const candidate of CONTAINER_CLI_CANDIDATES) {
    // `info`, NOT `version`. MEASURED: `nerdctl version` exits 0 with no containerd socket
    // and no buildctl in PATH — it reports the CLIENT only. `nerdctl info` (like `images`)
    // exits 1 there. Probing `version` would select a runtime that cannot build anything and
    // push the failure out to the first build. docker and podman answer `info` 0 when healthy.
    const res = await execCapture(candidate, ["info"]).catch(() => null);
    if (!res || res.exitCode !== 0) continue;
    if (!(await canBuild(candidate))) continue;
    cached = candidate;
    return candidate;
  }

  throw new Error(
    `No container runtime found. The deploy builds and pushes images, which needs one of: ` +
      `${CONTAINER_CLI_CANDIDATES.join(", ")}. Install one, start its daemon, or set ` +
      `ADAPTER_K8S_CONTAINER_CLI to the runtime you want to use. Note that nerdctl ALSO ` +
      `needs buildkit REACHABLE (\`buildctl debug workers\` must succeed) — containerd alone ` +
      `cannot build images, and a buildkitd running as root is not reachable by a rootless ` +
      `nerdctl. See \`containerd-rootless-setuptool.sh install-buildkit\`.`,
  );
}

/** Test seam: forget the probed runtime. */
export function resetContainerCliCache(): void {
  cached = undefined;
}

/**
 * S24: doctor's container-runtime check. It used to probe `docker --version` specifically and
 * report a hard failure on a host that has only podman or nerdctl — a false alarm, since the
 * deploy works fine with either. Report the runtime that WILL be used, and fail only when
 * there is none.
 */
export async function checkContainerRuntime(): Promise<{
  name: string;
  status: "pass" | "fail";
  message: string;
  fix?: string;
}> {
  for (const candidate of CONTAINER_CLI_CANDIDATES) {
    // Same daemon-reachability probe as resolveContainerCli — doctor must agree with what the
    // deploy will actually pick, including rejecting an installed-but-daemonless nerdctl.
    const reachable = await execCapture(candidate, ["info"]).catch(() => null);
    if (!reachable || reachable.exitCode !== 0) continue;
    const ver = await execCapture(candidate, ["version"]).catch(() => null);
    const version = ((ver?.stdout || ver?.stderr) ?? "").trim().split("\n")[0] || candidate;
    return { name: "container runtime", status: "pass", message: `${candidate} — ${version}` };
  }
  return {
    name: "container runtime",
    status: "fail",
    message: `none of ${CONTAINER_CLI_CANDIDATES.join(", ")} responded`,
    fix:
      `Install and start one of: ${CONTAINER_CLI_CANDIDATES.join(", ")} ` +
      `(or set ADAPTER_K8S_CONTAINER_CLI)`,
  };
}
