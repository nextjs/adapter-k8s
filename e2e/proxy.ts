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

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|cdn-probe.txt).*)"] };
