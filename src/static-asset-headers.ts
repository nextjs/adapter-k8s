// Cache-control + headers for assets under `/_next/static/`, mirroring Next's own server
// (packages/next/src/server/lib/router-server.ts). Kept in one place so the pool's direct
// fast-path and the emitted static-asset manifest (CDN + dispatcher) can't diverge.
//
//   - `/_next/static/service-worker/*` — a service worker script must NOT be immutable (the browser
//     has to revalidate it to pick up a new worker) and needs `Service-Worker-Allowed` so it can
//     control a scope above its own directory.
//   - everything else under `/_next/static/*` — content-addressed (build id / content hash in the
//     path), so served immutable for a year.
//
// The `?dpl` skew-protection token on asset URLs is a separate concern handled by Next at build
// time via `supportsImmutableAssets`; this only governs response headers on serve.

export interface StaticAssetHeaders {
  cacheControl: string;
  /** Extra response headers (e.g. Service-Worker-Allowed); omitted when none. */
  headers?: Record<string, string>;
}

const NEXT_STATIC_PREFIX = "/_next/static/";

/** True for paths the adapter should treat with the `_next/static` header policy below. */
export function isNextStaticPath(pathname: string): boolean {
  return pathname.startsWith(NEXT_STATIC_PREFIX);
}

/**
 * Headers for a `/_next/static/*` asset. `basePath` is the app's configured basePath (Next uses
 * `basePath || "/"` for the service-worker scope). Only call for paths where isNextStaticPath is true.
 */
export function nextStaticAssetHeaders(pathname: string, basePath = ""): StaticAssetHeaders {
  const rel = pathname.slice(NEXT_STATIC_PREFIX.length);
  if (rel.startsWith("service-worker/")) {
    return {
      cacheControl: "public, max-age=0, must-revalidate",
      headers: { "Service-Worker-Allowed": basePath || "/" },
    };
  }
  return { cacheControl: "public, max-age=31536000, immutable" };
}
