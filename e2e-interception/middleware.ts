import { NextResponse, type NextRequest } from "next/server";

export default function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === "/en" || request.nextUrl.pathname.startsWith("/en/")) return;
  const url = request.nextUrl.clone();
  url.pathname = `/en${url.pathname}`;
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
