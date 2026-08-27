import { NextResponse, type NextRequest } from "next/server";

// Node-runtime proxy (Next 16.2's replacement for deprecated edge middleware). Runs the same
// routing logic: rewrites /from-mw → /rewritten and stamps x-mw-executed; gates on x-gate=deny.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (request.headers.get("x-gate") === "deny") {
    return new NextResponse("Blocked by middleware", {
      status: 403,
      headers: { "x-mw-blocked": "1", "x-mw-marker": "adapter-k8s-e2e" },
    });
  }

  if (pathname === "/rsc-redirect-origin") {
    return NextResponse.redirect(new URL("/rewritten", request.url));
  }

  if (pathname === "/api/rewrite-body-source") {
    // Deliberately rewrite a body-bearing request to itself. The adapter must continue routing
    // without invoking middleware a second time: Web request bodies are single-consumer streams,
    // and a second middleware pass would fail with `ReadableStream is locked` before the route
    // handler can read the payload. This probe covers the Server Action rewrite failure mode with
    // a stable action-independent HTTP contract.
    return NextResponse.rewrite(request.nextUrl.clone());
  }

  if (pathname === "/middleware-cache-probe.txt") {
    const response = NextResponse.next();
    // This is an explicit app-owned cache decision used to verify response-header precedence.
    // It is intentionally confined to this probe: middleware-matched routes without an explicit
    // safe policy remain no-cache because GXLB runs this traffic extension after Cloud CDN.
    response.headers.set("cache-control", "max-age=2345");
    return response;
  }

  let response: NextResponse;
  if (pathname === "/from-mw") {
    const url = request.nextUrl.clone();
    url.pathname = "/rewritten";
    response = NextResponse.rewrite(url);
  } else {
    response = NextResponse.next();
  }
  // Marker on every matched response; x-mw-executed is a numeric epoch (the live test asserts
  // Number(x-mw-executed) > 0), not an ISO string.
  response.headers.set("x-mw-marker", "adapter-k8s-e2e");
  response.headers.set("x-mw-executed", Date.now().toString());
  // A4: WHICH TIER executed this pass. The marker above proves middleware ran somewhere, which
  // is exactly the ambiguity that let the edge tier fail silently: if the pool rejects the
  // dispatch proof it strips the headers and re-resolves locally — running this middleware in
  // the POOL process — and every existing assertion still passes. The routing-service
  // (ext_proc) container has no POOL_NAME; a pool pod always does (emit/templates/
  // deployment.ts stamps it, and POOL_NAME is a reserved env name so an app cannot set it).
  // So "edge" on the response is positive evidence that the pool VERIFIED the proof and reused
  // the edge's verdict, and a pool name is positive evidence that it did not.
  response.headers.set("x-mw-tier", process.env.POOL_NAME ?? "edge");
  return response;
}

export const config = {
  // `isr-template` is excluded deliberately. Everything else here is middleware-matched, which
  // forces `no-cache` on page routes; the exclusion keeps the one plain-SSG template in this
  // app on the ordinary cacheable path so the live guard can observe its cache status. That
  // template is the only route here that reaches the `emulatedSsgTemplates` rung — see the
  // KNOWN PRODUCTION BUG note in pool-server/dispatch.ts.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|cdn-probe.txt|header-priority.txt|isr-template).*)",
  ],
};
