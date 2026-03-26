// src/emit/metadata.ts
export function generateBuildMetadata({
  buildId,
  nextVersion,
  poolNames,
  generatedAt,
  containerStrategy,
  hasMiddleware,
  failureModeAllow,
}: {
  buildId: string;
  nextVersion: string;
  poolNames: string[];
  generatedAt: string;
  containerStrategy?: string | undefined;
  hasMiddleware?: boolean | undefined;
  failureModeAllow?: boolean | undefined;
}): string {
  return JSON.stringify(
    {
      buildId,
      nextVersion,
      pools: poolNames,
      generatedAt,
      containerStrategy: containerStrategy ?? "traced-assets",
      hasMiddleware: hasMiddleware ?? false,
      failureModeAllow: failureModeAllow ?? true,
    },
    null,
    2,
  );
}
