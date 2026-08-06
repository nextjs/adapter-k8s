// src/emit/metadata.ts
//
// build-metadata.json — the hand-off from build to `adapter-k8s deploy` (which reads
// cacheEnabled/cacheManaged to provision or tear down the managed Memorystore, and pools
// to coordinate versioned resources across a cutover).
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
import { parseTargetPlatform, type TargetPlatform } from "../target-platform.js";

export function generateBuildMetadata({
  buildId,
  nextVersion,
  targetPlatform,
  poolNames,
  defaultPool,
  generatedAt,
  provider,
  namespace,
  containerRegistry,
  nodeCidrs,
  containerStrategy,
  hasMiddleware,
  failureModeAllow,
  cacheEnabled,
  cacheManaged,
  incrementalCacheHandler,
  cacheMemorystore,
  distDir,
  compositionPlan,
}: {
  buildId: string;
  nextVersion: string;
  /** OCI platform used for native staging, image builds, digest selection, and scheduling. */
  targetPlatform: TargetPlatform;
  poolNames: string[];
  /** Pool selected by the stable portable origin Service. */
  defaultPool: string;
  /**
   * Project-relative dist dir (the S20-validated `distDirRel`, usually ".next"). The deploy
   * step needs it to re-stage `<distDir>/cache/fetch-cache` into the image contexts before
   * `docker build` — the build's own staging races the async fetch-cache writes (see
   * refreshFetchCacheStaging in cli/deploy.ts).
   */
  distDir: string;
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
  /**
   * Which provider this build targets. The CLI is otherwise unable to tell: it infers "GCP"
   * from the presence of infrastructure.json fields, so a generic build looked to `deploy`
   * exactly like a misconfigured GKE one — it skipped image-digest resolution (silently
   * bypassing the --allow-mutable-tags gate), could not pin a kube context, and tried to
   * discover NetworkPolicy ranges through gcloud.
   */
  provider: string;
  /** Namespace qualified into the ext_proc authority at build time. */
  namespace: string;
  /**
   * Registry the emitted chart's image references were built against. The routing tier's image
   * is baked into its Deployment template at BUILD time, so a chart is only valid for the
   * registry it was emitted for — see the fingerprint check in deploy.ts.
   */
  containerRegistry?: string | undefined;
  /** provider.generic.nodeCidrs, if set — deploy prefers it over live node discovery. */
  nodeCidrs?: string[] | undefined;
  compositionPlan?: { digest: string; targetFingerprint: string } | undefined;
}): string {
  const safeTargetPlatform = parseTargetPlatform(targetPlatform, "build metadata targetPlatform");
  return JSON.stringify(
    {
      buildId,
      nextVersion,
      targetPlatform: safeTargetPlatform,
      provider,
      namespace,
      ...(containerRegistry ? { containerRegistry } : {}),
      ...(nodeCidrs && nodeCidrs.length > 0 ? { nodeCidrs } : {}),
      pools: poolNames,
      defaultPool,
      ...(compositionPlan ? { compositionPlan } : {}),
      generatedAt,
      distDir,
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
