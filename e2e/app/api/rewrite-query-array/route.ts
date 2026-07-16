import { NextResponse } from "next/server";

export function GET(request: Request) {
  return NextResponse.json({ items: new URL(request.url).searchParams.getAll("item") });
}
