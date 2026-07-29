import {
  grantsSharedCacheFreshness,
  rscParentCandidates,
  stripBasePath,
  trailingSlashVariants,
  type RscConfig,
} from "../routing-common.js";

// N30 (SECURITY/CACHE): the PPR verdict must be computable WITHOUT the ext_proc tier.
//
// `x-nextjs-ppr` is stamped only by the routing service, so every path that reaches a pool
// without it — an ext_proc fail-open, a CEL-excluded path, an app with no middleware (the
// extension is not even wired), a timeout shed, a body request, a cross-pool hop — lost the
// verdict entirely. Measured on `next start` (Next 16.2.10, cacheComponents fixture): a PPR
// document is `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` with
// `x-nextjs-postponed: 1` and 6616 streamed bytes, while the build's shell artifact is 970
// bytes. Without the header the pool passed the generated entrypoint's own
// `s-maxage=31536000` through UNTAGGED, so Cloud CDN stored an unfinished shell for a year
// and no cutover tag invalidation could reach it (the M13 stale-apex class).
//
// The pool already holds `pprRoutes`/`pprCapableRoutes` locally, so build the verdict here and
// treat the header as a hint only. The matcher must accept the shapes a request pathname can
// take before route resolution has happened: an RSC/segment-prefetch output suffix, a
// basePath prefix, an i18n locale prefix, and a trailing slash.
export interface PprRouteMatcherOptions {
  /** PPR templates WITH a build-emitted shell (routingManifest.pprRoutes keys). */
  pprRoutes?: Record<string, unknown> | undefined;
  /** N16 PPR-capable templates with no emitted shell (routingManifest.pprCapableRoutes keys). */
  pprCapableRoutes?: Record<string, unknown> | undefined;
  basePath?: string;
  i18nLocales?: string[];
  rscConfig?: RscConfig | undefined;
}

// Compile one output-id template (`/blog/[slug]`, `/[locale]/(.)[user]/p/[id]`) to a regex over
// concrete pathnames. Mirrors dispatch.ts extractRouteParams' segment grammar: interception
// markers select a route-tree branch and consume no URL segment, `[[...x]]` is optional.
function templateToRegExp(template: string): RegExp {
  let pattern = "";
  for (const rawSegment of template.split("/").slice(1)) {
    const segment = rawSegment.replace(/^(?:\(\.{1,3}\))+/, "");
    if (/^\[\[\.\.\..+\]\]$/.test(segment)) pattern += "(?:/.*)?";
    else if (/^\[\.\.\..+\]$/.test(segment)) pattern += "/.+";
    else if (/^\[.+\]$/.test(segment)) pattern += "/[^/]+";
    else pattern += "/" + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern || "/"}$`);
}

export function createPprRouteMatcher(
  options: PprRouteMatcherOptions,
): (pathnameOrOutputId: string) => boolean {
  const { basePath = "", i18nLocales = [], rscConfig } = options;
  const templates = [
    ...Object.keys(options.pprRoutes ?? {}),
    ...Object.keys(options.pprCapableRoutes ?? {}),
  ];
  const exact = new Set<string>();
  const patterns: RegExp[] = [];
  for (const template of templates) {
    // A `.rsc`/segment-prefetch output id and its parent page are the same ROUTE for cache
    // purposes: both stream a per-request resume and neither may be stored by a shared cache.
    for (const form of new Set([template, ...rscParentCandidates(template, rscConfig)])) {
      for (const withBase of new Set([form, stripBasePath(form, basePath)])) {
        if (withBase.includes("[")) patterns.push(templateToRegExp(withBase));
        else for (const variant of trailingSlashVariants(withBase)) exact.add(variant);
      }
    }
  }
  if (exact.size === 0 && patterns.length === 0) return () => false;

  return (pathnameOrOutputId: string): boolean => {
    const seeds = new Set<string>([
      pathnameOrOutputId,
      ...rscParentCandidates(pathnameOrOutputId, rscConfig),
    ]);
    for (const seed of [...seeds]) {
      const withoutBase = stripBasePath(seed, basePath);
      seeds.add(withoutBase);
      // The locale prefix is routing state, not part of the route template — a PPR template
      // is keyed without it, so `/fr/ssr` must still resolve to the `/ssr` verdict.
      const firstSegment = withoutBase.split("/", 2)[1]?.toLowerCase();
      if (firstSegment && i18nLocales.some((locale) => locale.toLowerCase() === firstSegment)) {
        seeds.add(withoutBase.slice(firstSegment.length + 1) || "/");
      }
    }
    for (const seed of seeds) {
      for (const candidate of trailingSlashVariants(seed)) {
        if (exact.has(candidate)) return true;
        if (patterns.some((pattern) => pattern.test(candidate))) return true;
      }
    }
    return false;
  };
}

export function forcedCdnCacheControl({
  isPprRoute,
  middlewareCovers,
  emulateNextServer,
  rscHeadersUnvalidated = false,
}: {
  isPprRoute: boolean;
  middlewareCovers: boolean;
  emulateNextServer: boolean;
  /**
   * N18 (SECURITY): this is an RSC request whose `_rsc` cache-busting param does not
   * authenticate its RSC headers (routing-common.ts `rscCacheBustingUnvalidated`).
   */
  rscHeadersUnvalidated?: boolean;
}): "no-store" | "no-cache" | null {
  if (isPprRoute) return "no-store";
  // N18 (SECURITY): an RSC response whose content varies with headers a shared cache may ignore,
  // requested with a `_rsc` that doesn't match those headers, must never be STORABLE — that is
  // the whole poisoning primitive (`next start` answers such a request 307; we answer it
  // correctly but unstorably — see rscCacheBustingUnvalidated for why). `no-store`, not
  // `no-cache`: `no-cache` still permits storage-plus-revalidation, and it must outrank the
  // middleware verdict below AND any app-supplied Cache-Control (explicitCacheControlWins
  // returns false for every forced value except `no-cache`, which is what makes that hold).
  // NOT exempted under `emulateNextServer` — `next start` does not serve a cacheable response
  // to these requests either, so `no-store` is *closer* to parity than the origin value.
  if (rscHeadersUnvalidated) return "no-store";
  // In production, GXLB executes middleware after Cloud CDN. A cache hit would bypass middleware,
  // so every matched response must revalidate even if app code supplies a public cache directive.
  // NEXT_ENABLE_ADAPTER is different: it is Next's local deploy-test harness with no CDN or Valkey,
  // and its compatibility tests require the same response headers as `next start`. This exception
  // is deliberately explicit and MUST NOT be enabled in a real deployment.
  if (middlewareCovers && !emulateNextServer) return "no-cache";
  return null;
}

// Whether an EXPLICIT app-owned cache-control — next.config headers() or a middleware
// response header, delivered through the resolved routing verdict (x-resolved-headers on
// Phase 2, resolution.resolvedHeaders on Phase 1) — overrides the forced verdict above.
// The middleware-matched `no-cache` is a safe DEFAULT for routes with no explicit cache
// decision. An explicit value may replace it ONLY when it grants no unrevalidated
// shared-cache freshness: Cloud CDN sits BEFORE the ext_proc middleware callout, so any
// positive max-age/s-maxage would let cache hits bypass middleware for that window —
// the invariant `forcedCdnCacheControl` exists to protect. Values that force per-use
// revalidation or uncacheability (no-store, no-cache, private, max-age=0) keep middleware
// in the loop on every request and are honored verbatim (this is how an app expresses
// e.g. `public, max-age=0, must-revalidate` for a service worker). Hard limits:
//   • a forced `no-store` (PPR resume streams per-request bytes) is never overridden;
//   • a response that itself declares `no-store` (dynamic render) is never weakened —
//     a cacheable resolved value must not make an uncacheable response cacheable.
export function explicitCacheControlWins({
  forced,
  resolvedCacheControl,
  responseCacheControls,
}: {
  forced: "no-store" | "no-cache";
  resolvedCacheControl: string | null;
  responseCacheControls: string[];
}): boolean {
  if (forced !== "no-cache") return false;
  if (!resolvedCacheControl) return false;
  // The app's own `no-store` is at least as strong as the forced default — honor it
  // verbatim instead of downgrading it to `no-cache`.
  if (/\bno-store\b/i.test(resolvedCacheControl)) return true;
  if (responseCacheControls.some((cc) => /\bno-store\b/i.test(cc))) return false;
  if (grantsSharedCacheFreshness(resolvedCacheControl)) return false;
  return true;
}

// `grantsSharedCacheFreshness` — "the directive gives a shared cache a window in which it may
// serve hits without revalidating" — now lives in routing-common.ts: the routing-service tier
// needs the same predicate for the N18 RSC invariant, and two copies could drift. Middleware-
// covered routes must never get such a window: CDN hits inside it skip the ext_proc callout.
