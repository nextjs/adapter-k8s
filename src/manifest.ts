// src/manifest.ts
import path from "node:path";
import type {
  AdapterOutputs,
  BuildCompleteContext,
  PoolDefinition,
  RoutingManifest,
} from "./types.js";
import type { RouteHasCondition } from "./routing-common.js";

// Build-time middleware matcher shape (outputs.middleware.config.matchers).
interface MiddlewareMatcherBuild {
  source: string;
  sourceRegex: string;
  has?: RouteHasCondition[];
  missing?: RouteHasCondition[];
}

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
    // The Pages Router root page is keyed "/index", but @next/routing matches
    // the public request path "/". Without "/" in the set it doesn't see the
    // root as a page, so a catch-all rewrite (`/:path* -> /category/:path*`)
    // wrongly fires for "/". Add the public alias so the root resolves to itself.
    if (output.pathname === "/index") {
      pathnames.add("/");
    }
  }

  if (outputs.middleware) {
    pathnames.add(outputs.middleware.pathname);
  }

  return [...pathnames].sort();
}

// Wrap each route's baked sourceRegex in an inline case-insensitive group so
// @next/routing matches rewrite/redirect/header sources the way `next start`
// does (path-to-regexp `sensitive: false`). The `(?i:…)` modifier keeps named
// capture groups intact, so dynamic-param extraction is unaffected.
function caseInsensitiveSources<T extends { sourceRegex: string }>(routes: T[]): T[] {
  return routes.map((route) =>
    route.sourceRegex && !route.sourceRegex.startsWith("(?i")
      ? { ...route, sourceRegex: `(?i:${route.sourceRegex})` }
      : route,
  );
}

export function buildRoutingManifest({
  routing,
  outputs,
  pools,
  buildId,
  basePath,
  i18n,
  trailingSlash,
  nextVersion,
  projectDir,
}: {
  routing: BuildCompleteContext["routing"];
  outputs: AdapterOutputs;
  pools: Map<string, PoolDefinition>;
  buildId: string;
  basePath: string;
  i18n: BuildCompleteContext["config"]["i18n"] | null;
  trailingSlash: boolean;
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
    const fb = (
      prerender as {
        fallback?: {
          postponedState?: string;
          filePath?: string;
          initialHeaders?: Record<string, string | string[]>;
          initialRevalidate?: unknown;
          initialExpiration?: unknown;
        };
      }
    ).fallback;
    if (config.renderingMode === "PARTIALLY_STATIC" && fb?.postponedState && fb.filePath) {
      // Shell cache tags come from the build's initialHeaders (x-next-cache-tags = the
      // `_N_T_/…` implicit path tags). The pool checks them against the shared Valkey manifest
      // to decide resume-vs-blocking-render. Not `x-nextjs-stale-time` — that's client-router
      // stale time, not server expiry.
      const rawTags = fb.initialHeaders?.["x-next-cache-tags"];
      const tags =
        typeof rawTags === "string"
          ? rawTags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : Array.isArray(rawTags)
            ? rawTags
                .flatMap((t) => t.split(","))
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined;
      pprRoutes[prerender.pathname] = {
        postponedState: fb.postponedState,
        fallbackFilePath: path.relative(projectDir, fb.filePath),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(typeof fb.initialRevalidate === "number" ? { revalidate: fb.initialRevalidate } : {}),
        ...(typeof fb.initialExpiration === "number" ? { expire: fb.initialExpiration } : {}),
      };
    }
  }

  return {
    // rsc is inside routeGraph per design doc §5.3
    routeGraph: {
      beforeMiddleware: routing.beforeMiddleware,
      // Rewrites/redirects/headers match case-insensitively in Next (path-to-regexp
      // `sensitive: false`), but @next/routing compiles the baked sourceRegex with
      // no flags, so `/Rewrite-1` would miss `/rewrite-1`. Wrap each source in an
      // inline case-insensitive group so both the pool and the ext_proc routing
      // service match the way `next start` does. Named capture groups are preserved.
      beforeFiles: caseInsensitiveSources(routing.beforeFiles),
      afterFiles: caseInsensitiveSources(routing.afterFiles),
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
    trailingSlash,
    middleware: outputs.middleware
      ? {
          filePath: path.relative(projectDir, outputs.middleware.filePath),
          runtime: (outputs.middleware as any).runtime ?? "nodejs",
          matchers: (
            (outputs.middleware as { config?: { matchers?: MiddlewareMatcherBuild[] } }).config
              ?.matchers ?? []
          ).map((m) => ({
            regexp: m.sourceRegex,
            ...(m.has ? { has: m.has } : {}),
            ...(m.missing ? { missing: m.missing } : {}),
            originalSource: m.source,
          })),
        }
      : null,
    poolAssignments,
    pprRoutes,
    nextVersion,
  };
}
