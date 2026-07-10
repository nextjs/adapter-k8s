import { NextResponse, type NextRequest } from "next/server";

// Middleware runs at the ext_proc edge as a TRAFFIC EXTENSION — which on GXLB executes
// AFTER the Cloud CDN cache lookup (post-cache), on cache-miss traffic heading to origin.
// It:
//   1. rewrites /from-mw → /rewritten (a routing verdict), and
//   2. stamps every matched response with x-mw-executed (a fresh value per invocation) so
//      we can observe that middleware ran on origin (cache-miss) requests.
// Because middleware runs post-cache, a CDN cache HIT is served WITHOUT invoking it — which
// is exactly why the pool forces `Cache-Control: no-cache` on middleware-matched routes, to
// keep them out of the edge cache and ensure middleware always runs.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Gate: reject on a request header that is deliberately NOT part of the CDN cache key
  // (x-gate is not in cacheKeyPolicy.includedHeaderNames). On a cache MISS the request
  // reaches middleware and is blocked here; a cache HIT would be served before middleware
  // runs — which is why middleware-matched routes are kept out of the edge cache (above).
  if (request.headers.get("x-gate") === "deny") {
    return new NextResponse("Blocked by middleware", {
      status: 403,
      headers: { "x-mw-blocked": "1", "x-mw-marker": "adapter-k8s-e2e" },
    });
  }

  let response: NextResponse;
  if (pathname === "/from-mw") {
    const url = request.nextUrl.clone();
    url.pathname = "/rewritten";
    response = NextResponse.rewrite(url);
  } else {
    response = NextResponse.next();
  }

  response.headers.set("x-mw-executed", String(Date.now()));
  response.headers.set("x-mw-marker", "adapter-k8s-e2e");
  return response;
}

export const config = {
  matcher: ["/", "/ssr", "/isr", "/from-mw", "/rewritten", "/api/:path*"],
};
