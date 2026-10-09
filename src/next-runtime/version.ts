export const SUPPORTED_NEXT_RELEASE_LINE = ">=16.3.8 <17.0.0";
export const TESTED_NEXT_RELEASE_LINE = ">=16.3.8 <16.4.0";
export const NEXT_VERSION_OVERRIDE_ENV = "ADAPTER_K8S_ALLOW_UNSUPPORTED_NEXT";
export const PINNED_NEXT_CANARY = "16.3.0-canary.97";

export type NextVersionSupport =
  | { supported: true; prerelease: boolean; warning?: string }
  | { supported: false; reason: string };

/**
 * Keep the security floor and major-version boundary hard, but allow newer stable minors
 * with a warning. The adapter uses experimental Next internals, so semver compatibility
 * alone does not establish conformance. The exact upstream canary remains an explicit lane.
 */
export function checkSupportedNextVersion(version: unknown): NextVersionSupport {
  if (typeof version !== "string") {
    return { supported: false, reason: "does not declare a string Next.js version" };
  }
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
      version,
    );
  if (!match) return { supported: false, reason: "is not a valid full Next.js version" };

  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major !== 16 || minor < 3) {
    return { supported: false, reason: "is outside the supported Next.js release line" };
  }

  const prerelease = match[4];
  if (prerelease !== undefined) {
    if (version !== PINNED_NEXT_CANARY) {
      return {
        supported: false,
        reason: `is not the pinned ${PINNED_NEXT_CANARY} canary conformance lane`,
      };
    }
    return { supported: true, prerelease: true };
  }

  // 16.3.8 includes the required cache isolation and image-optimizer security fixes
  // (GHSA-3w37-wq28-93x7, GHSA-4jqv-mc3x-m676, GHSA-cjq9-62q9-8jv4).
  if (minor === 3 && Number(match[3]) < 8) {
    return { supported: false, reason: "predates the required Next.js 16.3.8 security fixes" };
  }
  if (minor > 3) {
    return {
      supported: true,
      prerelease: false,
      warning: `is outside the tested Next.js range ${TESTED_NEXT_RELEASE_LINE}; compatibility has not been verified`,
    };
  }
  return { supported: true, prerelease: false };
}

export function assertSupportedNextVersion(
  version: unknown,
  source: string,
): NextVersionSupport & {
  supported: true;
} {
  const support = checkSupportedNextVersion(version);
  if (!support.supported) {
    const message =
      `${source} was built with Next.js ${JSON.stringify(version)}, which ${support.reason}. ` +
      `This adapter runtime supports ${SUPPORTED_NEXT_RELEASE_LINE}.`;
    // Read at consumption time so the same explicit override works for builds and pool startup.
    // Do not silently skip validation: every overridden rejection remains visible to the tester.
    if (process.env[NEXT_VERSION_OVERRIDE_ENV] === "1") {
      const warning = `${message} Continuing because ${NEXT_VERSION_OVERRIDE_ENV}=1; compatibility has not been verified.`;
      console.warn(warning);
      return {
        supported: true,
        prerelease: typeof version === "string" && version.split("+", 1)[0]!.includes("-"),
        warning,
      };
    }
    throw new Error(
      `${message} Rebuild with a supported Next.js version, or set ${NEXT_VERSION_OVERRIDE_ENV}=1 ` +
        `to continue with a warning for compatibility testing.`,
    );
  }
  if (support.warning) {
    console.warn(
      `${source} was built with Next.js ${JSON.stringify(version)}, which ${support.warning}.`,
    );
  }
  return support;
}
