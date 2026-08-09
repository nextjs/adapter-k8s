// src/manifest.ts
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import type {
  AdapterOutputs,
  BuildCompleteContext,
  PoolDefinition,
  RoutingManifest,
} from "./types.js";
import { unsafeConditionPattern, type RouteHasCondition } from "./routing-common.js";
import { assertSafePathname } from "./emit/templates/utils.js";
import { collectPublicPathnames } from "./pool-server/public-files.js";

// Build-time middleware matcher shape (outputs.middleware.config.matchers).
interface MiddlewareMatcherBuild {
  source: string;
  sourceRegex: string;
  has?: RouteHasCondition[];
  missing?: RouteHasCondition[];
}

/**
 * S11 (AVAILABILITY), build-time half. A middleware matcher's `has`/`missing` VALUE is a regexp
 * from the app's own config, evaluated at request time against a header, cookie, query value or
 * hostname — all attacker-controlled. `conditionRegex` (routing-common.ts) refuses a pattern whose
 * shape backtracks exponentially and degrades that condition to exact string comparison, because a
 * matcher that cannot be evaluated must never silently widen coverage.
 *
 * That degrade is correct but it is a bad way to FIND OUT: coverage narrows silently, in production,
 * announced only by a warning in a pod log. The shape is knowable here, at build, so reject it here
 * — with the same predicate, imported rather than restated, so the build cannot become stricter or
 * laxer than the two resolver tiers it is protecting.
 *
 * Deliberately fatal, with no bypass flag. The pattern does not work at runtime either way: the
 * choice is between a build error naming the matcher and a production behaviour change the author
 * did not ask for. Rewriting the matcher is always available (`(a+)+` is `a+` for matching
 * purposes), and the fail-safe reasoning in `matchesMiddleware` means the alternative to failing is
 * *narrower* middleware coverage, i.e. potentially a skipped auth check.
 */
function assertSafeMatcherConditions(m: MiddlewareMatcherBuild): void {
  for (const field of ["has", "missing"] as const) {
    for (const cond of m[field] ?? []) {
      if (cond.value === undefined) continue; // presence-only, never compiled
      const unsafe = unsafeConditionPattern(cond.value);
      if (!unsafe) continue;
      throw new Error(
        `Middleware matcher ${JSON.stringify(m.source)} has an unevaluatable ` +
          `${field}.${cond.type} condition${cond.key ? ` on ${JSON.stringify(cond.key)}` : ""}: ` +
          `${JSON.stringify(cond.value)} — ${unsafe}. The value is matched against a ` +
          `request-controlled string, so this would be a remote availability bug; the pool and the ` +
          `routing service both refuse to compile it and would fall back to EXACT string ` +
          `comparison, silently narrowing which requests run middleware. Rewrite the pattern ` +
          `without nested quantifiers or repeated alternation (for matching purposes \`(a+)+\` ` +
          `is \`a+\`; replace repeated alternatives with a character class or another linear ` +
          `expression).`,
      );
    }
  }
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

// The fields of a PRERENDER output this module reads. Declared structurally because synthetic
// build contexts (unit tests) supply only these, and because `groupId` is typed `number` upstream
// while a mock may key groups by any stable value.
interface PrerenderView {
  pathname: string;
  groupId?: string | number;
  fallback?: { filePath?: string; postponedState?: string } | null;
}

interface PrerenderGroup {
  /** ANY member of the group carries a postponed state, i.e. this route's build render postponed. */
  postpones: boolean;
  /**
   * Pathnames of members carrying a `fallback` object with NO `filePath` — the exact shape
   * upstream uses for the `.rsc` PRERENDER sibling of a PARTIALLY_STATIC route
   * (`filePath: undefined` at build-complete.js:989). Used only by the build-time assertion.
   */
  fileless: string[];
}

// N16b. Upstream records the postponed state of a PARTIALLY_STATIC route TEMPLATE on a SIBLING
// output, not always on the template's own output. `build-complete.js` pushes the template with
// `fallback.postponedState: undefined` and then pushes a `${dynamicRoute}.rsc` PRERENDER carrying
// `postponedState: meta.postponed` (next@16.2.10
// node_modules/next/dist/build/adapter/build-complete.js:986-991). A template that HAS a
// build-emitted shell also ends up with the state on its own output, because `handleAppMeta`
// mutates `initialOutput.fallback.postponedState` in place first (build-complete.js:596) — but
// that mutation is guarded on `initialOutput.fallback` existing, so a template whose shell was
// suppressed (`fallback: null` in the prerender manifest) keeps `fallback: undefined` and ONLY the
// sibling records that the build render postponed. Reading `fallback.postponedState` off the
// template alone therefore cannot tell "never postpones" from "postpones, shell suppressed" — and
// types.ts documents those two flavours as needing OPPOSITE handling.
//
// Measured against a probe app on next 16.2.10:
//   - empty root shell (`hasEmptyStaticShell`, build/index.js:1825) demotes the route to
//     BLOCKING_STATIC_RENDER → template `fallback: undefined`, sibling postponedState PRESENT.
//     This is the `/novel/early-span` class that was served as a bare 1,358-byte closed Suspense
//     boundary where `next start` returns 7,658 bytes of resolved content.
//   - a dynamic-segment route whose page never postpones keeps its shell but has NO postponed
//     state anywhere in its group (the app-dir/fallback-shells `without-io` class, which MUST
//     stay minimal).
//
// The join is on `groupId` — the build's own "revalidated together" grouping — never on munging
// `.rsc` on/off ids. `rscParentCandidates` in dispatch.ts exists because suffix arithmetic on
// these ids is error-prone; `groupId` is exact, since `prerenderGroupId` increments once per
// template and once per concrete generateStaticParams route (verified: template `/p/[slug]` and
// `/p/[slug].rsc` share group 3 while its concrete `/p/one` is group 2, so a concrete param can
// never leak its postponed state into the template's flag).
//
// Every non-`.rsc` group member hardcodes `postponedState: undefined` (segment prerenders at
// build-complete.js:634, data routes at 860/1027), so "some member of this group carries a
// postponed state" is equivalent to "this route's build render postponed" without having to
// identify WHICH member carried it.
function indexPrerenderGroups(outputs: AdapterOutputs): Map<string | number, PrerenderGroup> {
  const groups = new Map<string | number, PrerenderGroup>();
  for (const output of outputs.prerenders as unknown as PrerenderView[]) {
    const groupId = output.groupId;
    // A synthetic output with no groupId must not join every other group-less output: an
    // `undefined` key would make one such entry's postponed state answer for all of them.
    if (groupId === undefined) continue;
    let group = groups.get(groupId);
    if (!group) {
      group = { postpones: false, fileless: [] };
      groups.set(groupId, group);
    }
    const fb = output.fallback;
    if (fb?.postponedState) group.postpones = true;
    if (fb && !fb.filePath) group.fileless.push(output.pathname);
  }
  return groups;
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
  const routeExecutionTimeoutByOutputId: Record<string, number> = {};
  const routeExecutionTimeouts: Record<string, number> = {};
  const poolResponseHeadTimeouts: Record<string, number> = {};
  for (const [poolName, pool] of pools) {
    if (pool.config.timeout !== undefined) {
      poolResponseHeadTimeouts[poolName] = pool.config.timeout * 1000;
    }
    for (const output of pool.outputs) {
      poolAssignments[output.pathname] = poolName;
      poolByOutputId[output.id] = poolName;
      const maxDuration = (output.config as { maxDuration?: unknown } | undefined)?.maxDuration;
      if (typeof maxDuration === "number" && Number.isFinite(maxDuration) && maxDuration > 0) {
        routeExecutionTimeouts[output.pathname] = Math.round(maxDuration * 1000);
        routeExecutionTimeoutByOutputId[output.id] = routeExecutionTimeouts[output.pathname]!;
      }
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
      const parentTimeout = parentOutputId
        ? routeExecutionTimeoutByOutputId[parentOutputId]
        : undefined;
      if (parentTimeout !== undefined) routeExecutionTimeouts[prerender.pathname] = parentTimeout;
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
  const pprCapableRoutes: Record<
    string,
    { rootParams: string[]; wouldPostpone: boolean; allowQuery?: string[] }
  > = {};
  // Survey Tier 2 #7 (plans/lessons-from-sibling-adapters.md): PARTIALLY_STATIC prerenders whose
  // fallback carries a postponedState but NO filePath — the shell-less `.rsc` postponed-state
  // siblings (build-complete.js:986-991, the dynamic-RSC prefetch responses for PPR routes).
  // `pprRoutes` requires a shell and `pprCapableRoutes` only admits route templates, so these
  // were dropped from the manifest entirely and the resume implementation could not see them.
  // Gated on `allowQuery === []` per the reference adapter (adapter-vercel outputs.ts:652-673):
  // with no route-param variance the state is shareable across requests; with params (or with
  // variance unknown) it is not and the route must cold-render instead.
  const pprStatePrerenders: RoutingManifest["pprStatePrerenders"] = {};
  const dynamicRouteRootParams = readDynamicRouteFallbackRootParams(resolvedDistDir);
  const prerenderGroups = indexPrerenderGroups(outputs);
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
    if (config.renderingMode === "PARTIALLY_STATIC" && rootParams !== undefined) {
      // N16b: the `.rsc` PRERENDER sibling is how the build reports that a template's render
      // postponed (see indexPrerenderGroups). Assert it exists for every PARTIALLY_STATIC
      // template — both flavours, since either could lose it — so an upstream change that stops
      // emitting it FAILS THE BUILD instead of silently reclassifying every shell-less PPR
      // template back to "never postpones", which is exactly the truncation this bit fixes.
      // Only app-router routes reach PARTIALLY_STATIC (build/index.js only sets it under
      // `isAppPPREnabled` for app pages), so the Pages-Router i18n branch of build-complete.js —
      // the one path that emits no `.rsc` sibling — cannot trip this.
      const groupId = (prerender as unknown as PrerenderView).groupId;
      const group = groupId === undefined ? undefined : prerenderGroups.get(groupId);
      // N16c. No build-time assertion on the sibling's presence. An earlier revision threw
      // here when a PARTIALLY_STATIC template had no same-groupId `.rsc` sibling, to protect the
      // `wouldPostpone` signal below — but that signal turned out not to discriminate (see the
      // N16c note at the minimalMode gate in pool-server/dispatch.ts), so nothing consumes it in
      // a load-bearing way and a hard throw could only fail builds for no benefit.
      // N16c. Computed and carried, but NOT used to decide minimal mode — measured on the e2e
      // suite, it classifies fallback-shells' never-postponing routes the same as a template that
      // genuinely postpones, so using it regressed fallback-shells 13→8 passing. Kept (with its
      // tests) so the next attempt starts from the measurement rather than re-deriving it.
      const wouldPostpone = group?.postpones ?? false;
      // Shell-BEARING templates are handled via pprRoutes/handlerPprInfo and are deliberately
      // DISJOINT from this map, so keep the existing `fallback: null` restriction.
      if (!(fb?.postponedState && fb.filePath)) {
        pprCapableRoutes[prerender.pathname] = {
          rootParams,
          wouldPostpone,
          // Shell-less templates partition the platform cache key too
          // (the with-root same-entry cells prove sharing through the header alone).
          ...(Array.isArray(config.allowQuery)
            ? {
                allowQuery: config.allowQuery.filter((q): q is string => typeof q === "string"),
              }
            : {}),
        };
      }
    }
    if (
      config.renderingMode === "PARTIALLY_STATIC" &&
      fb?.postponedState &&
      !fb.filePath &&
      Array.isArray(config.allowQuery) &&
      config.allowQuery.length === 0
    ) {
      pprStatePrerenders[prerender.pathname] = { postponedState: fb.postponedState };
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
        // The build's statement of which params PARTITION the platform
        // cache key (never-enumerable params are excluded). Dispatch's seen-key registry
        // computes HIT-vs-PRERENDER from exactly this list.
        ...(Array.isArray(config.allowQuery)
          ? { allowQuery: config.allowQuery.filter((q): q is string => typeof q === "string") }
          : {}),
      };
    }
  }

  // Every emitted pathname ends up spliced into quoted YAML in the HTTPRoute
  // prefix rules (gateway.ts) — reject `"`/`\`/control characters at the source.
  // Public files join the set: `next start` serves them as FILESYSTEM routes (between
  // beforeFiles and afterFiles), so a rewrite destination like `/another.txt` must resolve —
  // without them @next/routing fell through and every rewrite-to-public-file 404'd
  // (full-run v4: custom-routes-catchall, i18n-ignore-rewrite-source-locale).
  const pathnames = [
    ...new Set([...collectOutputPathnames(outputs), ...collectPublicPathnames(projectDir)]),
  ].sort();
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
          ).map((m) => {
            assertSafeMatcherConditions(m);
            return {
              regexp: m.sourceRegex,
              ...(m.has ? { has: m.has } : {}),
              ...(m.missing ? { missing: m.missing } : {}),
              originalSource: m.source,
            };
          }),
        }
      : null,
    poolAssignments,
    ...(Object.keys(routeExecutionTimeouts).length > 0 ? { routeExecutionTimeouts } : {}),
    ...(Object.keys(poolResponseHeadTimeouts).length > 0 ? { poolResponseHeadTimeouts } : {}),
    pprRoutes,
    // Sorted for byte-identical chart regeneration, like pprCapableRoutes below.
    pprStatePrerenders: Object.fromEntries(
      Object.entries(pprStatePrerenders).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    // Sorted so two chart generations of the same build are byte-identical.
    pprCapableRoutes: Object.fromEntries(
      Object.entries(pprCapableRoutes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    nextVersion,
  };
}
