// src/emit/metadata.ts
//
// build-metadata.json — the hand-off from build to `adapter-k8s deploy` (which reads
// cacheEnabled/cacheManaged to provision or tear down the managed Memorystore, and pools
// to render the previous build's templates).
//
// N50 (review, Medium): every field used to be optional with a `??` default HERE:
//   - `failureModeAllow ?? true` defaulted to fail-OPEN — the middleware-BYPASS direction —
//     in the one file whose entire purpose is recording the fail-closed decision (invariant
//     2). Latent, because the generator always passes a value, but the trap pointed the
//     wrong way: any future caller that forgets the field would silently record "the edge
//     may bypass middleware".
//   - `containerStrategy ?? "traced-assets"` and `cacheEnabled ?? false` duplicated
//     config.ts `applyDefaults`, so the two would drift the moment either changed.
// Both are fixed the same way: the fields are REQUIRED. Callers supply defaults once, in
// applyDefaults (config.ts), and this file only serializes what it is given.
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
  incrementalCacheHandler,
  cacheMemorystore,
}: {
  buildId: string;
  nextVersion: string;
  poolNames: string[];
  /**
   * Build timestamp. Must be STABLE for a given build (adapter.ts passes the routing
   * manifest's `builtAt`, which is anchored to SOURCE_DATE_EPOCH / the BUILD_ID mtime) —
   * a wall-clock stamp made every chart/metadata regeneration differ, which defeats the
   * only audit for invariant 5 (diff a regenerated artifact against what was applied).
   */
  generatedAt: string;
  containerStrategy: "traced-assets" | "shared-image";
  hasMiddleware: boolean;
  /** ext_proc callout failure policy. `false` = fail CLOSED (middleware is never bypassed). */
  failureModeAllow: boolean;
  cacheEnabled: boolean;
  /** cache enabled with no BYO url ⇒ the deploy step must provision managed Memorystore. */
  cacheManaged: boolean;
  /**
   * Whether the adapter's Valkey-backed INCREMENTAL cache handler (ISR + PPR shells) is
   * registered in next.config for this build. False when the app defines EDGE middleware
   * (the handler cannot be bundled into the edge runtime) or brings its own cacheHandler —
   * in which case ISR/PPR-shell revalidation is per-replica even though the shared cache is
   * still provisioned and still backs `use cache` (V2 handler, registered at runtime).
   */
  incrementalCacheHandler: boolean;
  cacheMemorystore?: { region?: string; sizeGb?: number; tier?: string } | undefined;
}): string {
  return JSON.stringify(
    {
      buildId,
      nextVersion,
      pools: poolNames,
      generatedAt,
      containerStrategy,
      hasMiddleware,
      failureModeAllow,
      cacheEnabled,
      cacheManaged,
      incrementalCacheHandler,
      ...(cacheMemorystore ? { cacheMemorystore } : {}),
    },
    null,
    2,
  );
}
