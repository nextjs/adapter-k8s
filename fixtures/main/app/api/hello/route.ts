import { NextResponse } from "next/server";
import { connection } from "next/server";

// Dynamic JSON response (connection() replaces the cacheComponents-incompatible
// `export const dynamic = "force-dynamic"`).
export async function GET() {
  await connection();
  return NextResponse.json({ ok: true, service: "adapter-k8s-e2e", now: new Date().toISOString() });
}
