/**
 * Container platforms the adapter can stage and schedule end to end.
 *
 * Keep this list deliberately narrower than OCI's platform grammar. The emitted Node image is
 * Linux/glibc and Sharp's native packages are selected explicitly, so accepting a syntactically
 * valid platform here without teaching both staging and scheduling about it would produce a
 * build that only fails after rollout.
 */
export const SUPPORTED_TARGET_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;

export type TargetPlatform = (typeof SUPPORTED_TARGET_PLATFORMS)[number];
export type TargetArchitecture = "amd64" | "arm64";
export type TargetNodeCpu = "x64" | "arm64";

export const DEFAULT_TARGET_PLATFORM: TargetPlatform = "linux/amd64";

export function parseTargetPlatform(
  value: unknown,
  source = "ADAPTER_K8S_TARGET_PLATFORM",
): TargetPlatform {
  if (
    typeof value === "string" &&
    (SUPPORTED_TARGET_PLATFORMS as readonly string[]).includes(value)
  ) {
    return value as TargetPlatform;
  }
  throw new Error(
    `${source}=${JSON.stringify(value)} is not a supported target platform. Expected one of: ` +
      `${SUPPORTED_TARGET_PLATFORMS.join(", ")}.`,
  );
}

export function targetPlatform(): TargetPlatform {
  const override = process.env.ADAPTER_K8S_TARGET_PLATFORM?.trim();
  return override ? parseTargetPlatform(override) : DEFAULT_TARGET_PLATFORM;
}

export function targetArchitecture(platform: TargetPlatform): TargetArchitecture {
  return parseTargetPlatform(platform, "targetPlatform") === "linux/arm64" ? "arm64" : "amd64";
}

/** Node/npm uses `x64` for the OCI/Kubernetes `amd64` architecture. */
export function targetNodeCpu(platform: TargetPlatform): TargetNodeCpu {
  return parseTargetPlatform(platform, "targetPlatform") === "linux/arm64" ? "arm64" : "x64";
}

export function parseTargetArchitecture(value: unknown, source: string): TargetArchitecture {
  if (value === "amd64" || value === "arm64") return value;
  throw new Error(
    `${source}=${JSON.stringify(value)} is not a supported target architecture. Expected ` +
      `amd64 or arm64.`,
  );
}
