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
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|cdn-probe.txt|header-priority.txt).*)"],
};
