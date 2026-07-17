import { NextResponse } from "next/server";
import { cacheTag } from "next/cache";
import { headers } from "next/headers";

async function getCatalog() {
  "use cache";
  cacheTag("catalog");
  // Computed once, then served from the Valkey cache by every replica.
  return { generatedAt: new Date().toISOString() };
}

export async function GET() {
  const h = await headers(); // dynamic → runs per request, so the use-cache fetch is exercised
  const data = await getCatalog();
  return NextResponse.json({
    ...data,
    servedBy: process.env.HOSTNAME ?? "unknown",
    servedAt: new Date().toISOString(),
    req: h.get("x-req") ?? "none",
  });
}
