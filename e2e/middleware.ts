import { NextResponse, type NextRequest } from "next/server";

// Middleware runs at the ext_proc edge, in front of the CDN. It:
//   1. rewrites /from-mw → /rewritten (a routing verdict), and
//   2. stamps every matched response with x-mw-executed (a fresh value per
//      invocation) so we can observe that middleware ran — even on a CDN cache hit,
//      since the route extension runs before the cache lookup.
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Gate: reject on a request header that is deliberately NOT part of the CDN cache key
  // (x-gate is not in cacheKeyPolicy.includedHeaderNames), so a request that would
  // otherwise be a cache HIT for this URL must still be blocked here — proving the route
  // extension runs in front of the CDN. A cached response served ahead of middleware
  // would bypass this and return 200.
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
