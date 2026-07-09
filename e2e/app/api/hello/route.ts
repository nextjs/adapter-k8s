import { NextResponse } from "next/server";

// Route handler (pagesApi/appRoutes pool). Dynamic JSON response.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ ok: true, service: "adapter-k8s-e2e", now: new Date().toISOString() });
}
