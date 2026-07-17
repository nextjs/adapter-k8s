import { cacheLife, cacheTag } from "next/cache";

async function generated() {
  "use cache";
  cacheLife("minutes");
  cacheTag("route-probe");
  return new Date().toISOString();
}

export async function GET() {
  return Response.json({ at: await generated() });
}
