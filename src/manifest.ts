// src/manifest.ts
import path from "node:path";
import type {
  AdapterOutputs,
  BuildCompleteContext,
  PoolDefinition,
  RoutingManifest,
} from "./types.js";

export function collectOutputPathnames(outputs: AdapterOutputs): string[] {
  const pathnames = new Set<string>();

  for (const output of [
    ...outputs.pages,
    ...outputs.pagesApi,
    ...outputs.appPages,
    ...outputs.appRoutes,
    ...outputs.prerenders,
    ...outputs.staticFiles,
  ]) {
    pathnames.add(output.pathname);
  }

  if (outputs.middleware) {
    pathnames.add(outputs.middleware.pathname);
  }

  return [...pathnames].sort();
}

export function buildRoutingManifest({
  routing,
  outputs,
  pools,
  buildId,
  basePath,
  i18n,
  nextVersion,
  projectDir,
}: {
  routing: BuildCompleteContext["routing"];
  outputs: AdapterOutputs;
  pools: Map<string, PoolDefinition>;
  buildId: string;
  basePath: string;
  i18n: BuildCompleteContext["config"]["i18n"] | null;
  nextVersion: string;
  projectDir: string;
}): RoutingManifest {
  // Build pool assignments: pathname → pool name.
  // Also track output id → pool so prerenders can inherit their parent's pool.
  const poolAssignments: Record<string, string> = {};
  const poolByOutputId: Record<string, string> = {};
  for (const [poolName, pool] of pools) {
    for (const output of pool.outputs) {
      poolAssignments[output.pathname] = poolName;
      poolByOutputId[output.id] = poolName;
    }
  }

  // Prerenders (e.g. /blog/hello) are not classified into pools, but they carry
  // parentOutputId pointing at the originating route (e.g. the /blog/[slug]
  // template). Inherit that parent's pool rather than force-assigning to the
  // first pool, which would be wrong in multi-pool setups.
  for (const prerender of outputs.prerenders) {
    if (poolAssignments[prerender.pathname]) continue;
    const parentOutputId = (prerender as { parentOutputId?: string }).parentOutputId;
    const parentPool = parentOutputId ? poolByOutputId[parentOutputId] : undefined;
    if (parentPool) {
      poolAssignments[prerender.pathname] = parentPool;
    }
  }

  // Assign remaining pathnames (static files, unresolved prerenders, etc.) to
  // the first pool.
  const allPathnames = collectOutputPathnames(outputs);
  const poolNames = [...pools.keys()];
  const defaultPool = poolNames[0];
  if (defaultPool) {
    for (const pathname of allPathnames) {
      if (!poolAssignments[pathname]) {
        poolAssignments[pathname] = defaultPool;
      }
    }
  }

  // Detect PPR routes from prerenders — only include entries with both values present
  const pprRoutes: RoutingManifest["pprRoutes"] = {};
  for (const prerender of outputs.prerenders) {
    const config = prerender.config as Record<string, unknown>;
    if (
      config.renderingMode === "PARTIALLY_STATIC" &&
      // @ts-ignore - mock/peer-dep property
      prerender.fallback?.postponedState &&
      // @ts-ignore - mock/peer-dep property
      prerender.fallback.filePath
    ) {
      pprRoutes[prerender.pathname] = {
        // @ts-ignore - mock/peer-dep property
        postponedState: prerender.fallback.postponedState,
        // @ts-ignore - mock/peer-dep property
        fallbackFilePath: prerender.fallback.filePath
          ? path.relative(projectDir, prerender.fallback.filePath)
          : "",
      };
    }
  }

  return {
    // rsc is inside routeGraph per design doc §5.3
    routeGraph: {
      beforeMiddleware: routing.beforeMiddleware,
      beforeFiles: routing.beforeFiles,
      afterFiles: routing.afterFiles,
      dynamicRoutes: routing.dynamicRoutes,
      onMatch: routing.onMatch,
      fallback: routing.fallback,
      shouldNormalizeNextData: routing.shouldNormalizeNextData,
      rsc: routing.rsc,
    },
    pathnames: collectOutputPathnames(outputs),
    i18n: i18n ?? null,
    buildId,
    basePath,
    middleware: outputs.middleware
      ? {
          filePath: path.relative(projectDir, outputs.middleware.filePath),
          runtime: (outputs.middleware as any).runtime ?? "nodejs",
        }
      : null,
    poolAssignments,
    pprRoutes,
    nextVersion,
  };
}
