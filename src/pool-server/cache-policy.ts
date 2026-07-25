import { grantsSharedCacheFreshness } from "../routing-common.js";

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
