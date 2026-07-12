// src/emit/metadata.ts
export function generateBuildMetadata({
  buildId,
  nextVersion,
  poolNames,
  generatedAt,
  containerStrategy,
  hasMiddleware,
  failureModeAllow,
  cacheEnabled,
  cacheManaged,
  cacheMemorystore,
}: {
  buildId: string;
  nextVersion: string;
  poolNames: string[];
  generatedAt: string;
  containerStrategy?: string | undefined;
  hasMiddleware?: boolean | undefined;
  failureModeAllow?: boolean | undefined;
  cacheEnabled?: boolean | undefined;
  /** cache enabled with no BYO url ⇒ the deploy step must provision managed Memorystore. */
  cacheManaged?: boolean | undefined;
  cacheMemorystore?: { region?: string; sizeGb?: number; tier?: string } | undefined;
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
      cacheEnabled: cacheEnabled ?? false,
      cacheManaged: cacheManaged ?? false,
      ...(cacheMemorystore ? { cacheMemorystore } : {}),
    },
    null,
    2,
  );
}
