// src/emit/metadata.ts
export function generateBuildMetadata({
  buildId,
  nextVersion,
  poolNames,
  generatedAt,
}: {
  buildId: string;
  nextVersion: string;
  poolNames: string[];
  generatedAt: string;
}): string {
  return JSON.stringify(
    {
      buildId,
      nextVersion,
      pools: poolNames,
      generatedAt,
    },
    null,
    2,
  );
}
