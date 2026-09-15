export const SUPPORTED_NEXT_RELEASE_LINE = ">=16.3.0 <16.4.0";
export const PINNED_NEXT_CANARY = "16.3.0-canary.97";

export type NextVersionSupport =
  | { supported: true; prerelease: boolean }
  | { supported: false; reason: string };

/**
 * The adapter and @next/routing are tested as one release-line contract. A 16.4 runtime may
 * change generated entrypoints or routing semantics, so it must be reviewed before widening this
 * bound. The exact upstream conformance canary is accepted deliberately, but is reported as a
 * prerelease and is not part of the stable support promise.
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
  if (major !== 16 || minor !== 3) {
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
    throw new Error(
      `${source} was built with Next.js ${JSON.stringify(version)}, which ${support.reason}. ` +
        `This adapter runtime supports ${SUPPORTED_NEXT_RELEASE_LINE}. Rebuild with a supported ` +
        `Next.js version; do not run artifacts against an unreviewed runtime contract.`,
    );
  }
  return support;
}
