export function forcedCdnCacheControl({
  isPprRoute,
  middlewareCovers,
  emulateNextServer,
}: {
  isPprRoute: boolean;
  middlewareCovers: boolean;
  emulateNextServer: boolean;
}): "no-store" | "no-cache" | null {
  if (isPprRoute) return "no-store";
  // In production, GXLB executes middleware after Cloud CDN. A cache hit would bypass middleware,
  // so every matched response must revalidate even if app code supplies a public cache directive.
  // NEXT_ENABLE_ADAPTER is different: it is Next's local deploy-test harness with no CDN or Valkey,
  // and its compatibility tests require the same response headers as `next start`. This exception
  // is deliberately explicit and MUST NOT be enabled in a real deployment.
  if (middlewareCovers && !emulateNextServer) return "no-cache";
  return null;
}
