// Shared routing helpers used by BOTH resolvers — the ext_proc edge
// (routing-service/handler.ts, "Phase 2") and the pool's local resolver
// (pool-server/resolve.ts, "Phase 1"). Keeping these in one place prevents the two
// paths from drifting; a divergence here means production (ext_proc) and emulate
// (Phase 1) route the same request differently.

// Internal request headers set by the routing extension / cross-pool proxy. Clients
// must never be able to speak this dispatch protocol, so the pool strips them unless
// they arrive with a valid internal secret (see pool-server/server.ts), and the routing
// service overwrites/clears them on every response it returns.
export const INTERNAL_DISPATCH_HEADERS = [
  "x-output-id",
  "x-matched-pathname",
  "x-route-matches",
  "x-upstream-pool",
  "x-nextjs-ppr",
  "x-resolved-headers",
] as const;

// Header carrying the shared secret that authenticates the dispatch headers above.
// Present only on responses from the trusted routing extension / cross-pool proxy.
export const INTERNAL_SECRET_HEADER = "x-internal-secret";

export function trailingSlashVariants(pathname: string): string[] {
  if (pathname === "/") return ["/"];
  const withSlash = pathname.endsWith("/") ? pathname : pathname + "/";
  const withoutSlash = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return [pathname, withoutSlash, withSlash];
}

// Resolve a pathname to its owning pool. A route may be keyed in poolAssignments with or
// without a trailing slash, and i18n routes arrive locale-prefixed (/en/about) while the
// assignment is keyed unprefixed (/about). Falls back to the "default" pool, then the first
// assignment. NOTE: the fallback is a best-effort guess — if it guesses wrong the pool's
// cross-pool proxy (dispatch.ts) still recovers, at the cost of an extra hop.
export function lookupPool(
  poolAssignments: Record<string, string>,
  resolvedPathname: string | undefined,
  matchedPathname: string,
  i18nLocales?: string[],
): string | undefined {
  const candidates: string[] = [];
  if (resolvedPathname) candidates.push(...trailingSlashVariants(resolvedPathname));
  candidates.push(...trailingSlashVariants(matchedPathname));

  // Also try stripping i18n locale prefix (e.g., /en/about → /about)
  if (i18nLocales?.length) {
    const extra: string[] = [];
    for (const c of candidates) {
      for (const locale of i18nLocales) {
        const prefix = `/${locale}`;
        if (c.startsWith(prefix + "/") || c === prefix) {
          extra.push(...trailingSlashVariants(c.slice(prefix.length) || "/"));
        }
      }
    }
    candidates.push(...extra);
  }

  for (const p of candidates) {
    if (poolAssignments[p]) return poolAssignments[p];
  }
  return poolAssignments["default"] ?? Object.values(poolAssignments)[0];
}

export interface RscConfig {
  header: string;
  suffix: string;
  prefetchSegmentHeader?: string;
  prefetchSegmentDirSuffix?: string;
  prefetchSegmentSuffix?: string;
}

// Map a resolved pathname to its RSC output variant when the request is an RSC request.
// resolveRoutes returns the base pathname (e.g. /page); the handler must be dispatched to the
// .rsc output (e.g. /page.rsc) so it returns a flight payload instead of HTML, and to the
// segment-prefetch output for a partial-tree prefetch. Returns the input unchanged when the
// request isn't RSC or no matching output exists. Pool assignment is unaffected — the .rsc
// output lives in the same pool as its page — so callers look up the pool on the BASE
// pathname and only use this result for the output id (x-output-id).
export function resolveRscOutput(
  matchedPathname: string,
  headers: Headers,
  rscConfig: RscConfig | undefined,
  poolAssignments: Record<string, string>,
): string {
  if (!rscConfig || headers.get(rscConfig.header) !== "1") return matchedPathname;

  const basePath = matchedPathname === "/" ? "/index" : matchedPathname;

  // Segment prefetch (a specific RSC segment) takes precedence over the whole-page .rsc.
  if (rscConfig.prefetchSegmentHeader) {
    const segmentPrefetch = headers.get(rscConfig.prefetchSegmentHeader);
    if (segmentPrefetch && segmentPrefetch.length > 0) {
      const normalized = segmentPrefetch.replace(/^\/+/, "");
      const candidate = `${basePath}${rscConfig.prefetchSegmentDirSuffix ?? ""}/${normalized}${rscConfig.prefetchSegmentSuffix ?? ""}`;
      if (poolAssignments[candidate]) return candidate;
    }
  }

  const rscCandidate = `${basePath}${rscConfig.suffix}`;
  if (poolAssignments[rscCandidate]) return rscCandidate;

  return matchedPathname;
}
