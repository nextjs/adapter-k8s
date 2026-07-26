// src/manifest.ts
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import type {
  AdapterOutputs,
  BuildCompleteContext,
  PoolDefinition,
  RoutingManifest,
} from "./types.js";
import type { RouteHasCondition } from "./routing-common.js";
import { assertSafePathname } from "./emit/templates/utils.js";

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

// builtAt is embedded in the chart ConfigMap and every Docker build context, so a
// wall-clock stamp makes two chart generations of the SAME build byte-different —
// busting Docker layer caches and violating the clean chart-regeneration invariant
// (regenerating must be a no-op when nothing changed). Derivation, in order:
//   1. SOURCE_DATE_EPOCH (the reproducible-builds standard, seconds since epoch) when set;
//   2. the mtime of <distDir>/BUILD_ID — written once per `next build`, so it is stable
//      across chart regenerations of the same build output;
//   3. Date.now() only when neither exists (synthetic build contexts, unit tests).
// Consumers (pool-server dispatch.ts ISR anchor) parse this with a NaN fallback —
// keep the ISO-8601 format.
// N50 (review #33): distDir is passed in (ctx.distDir) rather than assuming `.next` —
// with a custom distDir the anchor silently missed and every regeneration re-stamped
// Date.now().
function stableBuiltAt(distDir: string): string {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch && /^\d+$/.test(sourceDateEpoch)) {
    return new Date(Number(sourceDateEpoch) * 1000).toISOString();
  }
  try {
    return statSync(path.join(distDir, "BUILD_ID")).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

// N16. The adapter's PRERENDER outputs expose `config.renderingMode` and the fallback shell the
// build emitted, but NOT `fallbackRootParams` — the build's own record of which ROOT params were
// still unresolved when it declined to emit that shell. That field is the ONLY thing separating
// the two reasons a PPR route can have `fallback: null`, and the pool has to treat them
// oppositely (see the pprCapableRoutes doc comment in types.ts). Read it from
// <distDir>/prerender-manifest.json, whose `dynamicRoutes` map is also the authoritative list of
// route TEMPLATES — concrete generateStaticParams prerenders live under `routes`, so membership
// here doubles as the "this is a template, not an instance" test.
function readDynamicRouteFallbackRootParams(distDir: string): Map<string, string[]> {
  const byRoute = new Map<string, string[]>();
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(distDir, "prerender-manifest.json"), "utf-8"),
    ) as { dynamicRoutes?: Record<string, { fallbackRootParams?: unknown }> };
    for (const [route, entry] of Object.entries(manifest.dynamicRoutes ?? {})) {
      byRoute.set(
        route,
        Array.isArray(entry?.fallbackRootParams)
          ? entry.fallbackRootParams.filter((param): param is string => typeof param === "string")
          : [],
      );
    }
  } catch {
    // No prerender manifest (synthetic build contexts, unit tests) — no route is recorded as
    // PPR-capable-without-shell, which leaves every route in minimal mode. That is the
    // pre-N16 behavior, i.e. this degrades toward the conservative side.
  }
  return byRoute;
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
  distDir,
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
  /**
   * Absolute dist directory (ctx.distDir). Defaults to `<projectDir>/.next` for synthetic
   * build contexts and unit tests that predate the parameter.
   */
  distDir?: string;
}): RoutingManifest {
  const resolvedDistDir = distDir ?? path.join(projectDir, ".next");
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
  // N16: PPR-capable route TEMPLATES whose build emitted NO fallback shell, each tagged with the
  // unresolved ROOT params that stopped it. See the types.ts doc comment — the pool needs both
  // the membership (a PPR route, so keep it out of the emulated-SSG flip) and the root-param
  // flavour (the only flavour that must run NON-minimal).
  const pprCapableRoutes: Record<string, { rootParams: string[] }> = {};
  const dynamicRouteRootParams = readDynamicRouteFallbackRootParams(resolvedDistDir);
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
    // N16: PPR-capable but with NO build-emitted shell (`fallback: null`). Deliberately DISJOINT
    // from pprRoutes: shell-bearing entries are handled via handlerPprInfo. Restricted to
    // prerender-manifest `dynamicRoutes` members, i.e. route TEMPLATES: an earlier revision keyed
    // this by every PARTIALLY_STATIC output, which pulled in the concrete generateStaticParams
    // prerenders (`/without-io/foo`) and `/_global-error` and flipped them non-minimal.
    const rootParams = dynamicRouteRootParams.get(prerender.pathname);
    if (
      config.renderingMode === "PARTIALLY_STATIC" &&
      !(fb?.postponedState && fb.filePath) &&
      rootParams !== undefined
    ) {
      pprCapableRoutes[prerender.pathname] = { rootParams };
    }
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
        ...((prerender as { pprChain?: { headers?: Record<string, string> } }).pprChain?.headers
          ? {
              chainHeaders: (prerender as { pprChain: { headers: Record<string, string> } })
                .pprChain.headers,
            }
          : {}),
        ...(fb.initialHeaders ? { initialHeaders: fb.initialHeaders } : {}),
        ...(typeof (fb as { initialStatus?: unknown }).initialStatus === "number"
          ? { initialStatus: (fb as { initialStatus: number }).initialStatus }
          : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(typeof fb.initialRevalidate === "number" ? { revalidate: fb.initialRevalidate } : {}),
        ...(typeof fb.initialExpiration === "number" ? { expire: fb.initialExpiration } : {}),
      };
    }
  }

  // Every emitted pathname ends up spliced into quoted YAML in the HTTPRoute
  // prefix rules (gateway.ts) — reject `"`/`\`/control characters at the source.
  const pathnames = collectOutputPathnames(outputs);
  for (const pathname of pathnames) {
    assertSafePathname(pathname);
  }

  return {
    // rsc is inside routeGraph per design doc §5.3
    routeGraph: {
      // Rewrites/redirects/headers/onMatch match case-insensitively in `next start`
      // (path-to-regexp `sensitive: false` — filesystem.js buildCustomRoute passes
      // experimental.caseSensitiveRoutes, default false), but @next/routing's
      // matchRoute compiles the baked sourceRegex with no flags, so `/Rewrite-1`
      // would miss `/rewrite-1`. Wrap each custom-route source in an inline
      // case-insensitive group so both the pool and the ext_proc routing service
      // match the way `next start` does. Named capture groups are preserved.
      beforeMiddleware: caseInsensitiveSources(routing.beforeMiddleware),
      beforeFiles: caseInsensitiveSources(routing.beforeFiles),
      afterFiles: caseInsensitiveSources(routing.afterFiles),
      // dynamicRoutes stay case-SENSITIVE: `next start` matches dynamic PAGE routes
      // via getRouteRegex (route-regex.js) which compiles `new RegExp(...)` with no
      // flags — verified: /BLOG/hello does not match /blog/[slug] upstream. Only
      // custom routes are case-insensitive, so only they get the wrap.
      dynamicRoutes: routing.dynamicRoutes,
      onMatch: caseInsensitiveSources(routing.onMatch),
      fallback: caseInsensitiveSources(routing.fallback),
      shouldNormalizeNextData: routing.shouldNormalizeNextData,
      rsc: routing.rsc,
    },
    pathnames,
    i18n: i18n ?? null,
    buildId,
    builtAt: stableBuiltAt(resolvedDistDir),
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
    // Sorted so two chart generations of the same build are byte-identical.
    pprCapableRoutes: Object.fromEntries(
      Object.entries(pprCapableRoutes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    nextVersion,
  };
}
