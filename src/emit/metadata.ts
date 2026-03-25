// src/emit/metadata.ts
export function generateBuildMetadata({
  buildId,
  nextVersion,
  poolNames,
  generatedAt,
  containerStrategy,
}: {
  buildId: string;
  nextVersion: string;
  poolNames: string[];
  generatedAt: string;
  containerStrategy?: string | undefined;
}): string {
  return JSON.stringify(
    {
      buildId,
      nextVersion,
      pools: poolNames,
      generatedAt,
      containerStrategy: containerStrategy ?? "traced-assets",
    },
    null,
    2,
  );
}
