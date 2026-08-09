import { createHash } from "node:crypto";

export async function POST(request: Request) {
  const body = Buffer.from(await request.arrayBuffer());
  return Response.json({
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    contentType: request.headers.get("content-type"),
  });
}
