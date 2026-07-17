import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";

// POST /api/revalidate?tag=catalog — invalidates a cache tag across every replica via the
// shared Valkey tag manifest. `{ expire: 0 }` = immediate hard expiry.
export async function POST(req: Request) {
  const tag = new URL(req.url).searchParams.get("tag") ?? "catalog";
  revalidateTag(tag, { expire: 0 });
  return NextResponse.json({ revalidated: tag, at: new Date().toISOString() });
}
