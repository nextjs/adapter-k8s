import { createHash } from "node:crypto";

// ⚠️ STOPGAP FIXTURE — does NOT use the real (unreleased) Next.js WebSocket API.
//
// The proposed application API (RFC https://github.com/vercel/next.js/discussions/95514, gated by
// `experimental.webSocketRouteHandlers`) is a normal `GET` returning `NextResponse.upgrade({ open,
// message, close, error })`, and Next GENERATES the adapter-facing `upgradeHandler` entrypoint from
// it. That API is not in published canary yet, so this fixture hand-writes the adapter-facing
// `upgradeHandler` directly to exercise the adapter's dispatch/tunnel end-to-end. It validates the
// ADAPTER mechanism, not Next's generated entrypoint. SWITCH THIS to `GET` + `NextResponse.upgrade`
// once the experimental flag ships, and re-confirm the adapter loads Next's real generated handler.

// Normal HTTP GET on the same route — proves the route resolves for non-WS requests too.
export function GET() {
  return new Response("use a WebSocket on this route", { status: 426 });
}

// Adapter WebSocket contract (RFC §Adapter Integration; nextjs/adapter-vercel#86): the adapter calls
// upgradeHandler(ctx, { node: { req, socket, head } }) with the raw upgrade primitives.
// This echoes text frames back and greets with the serving pod + the route ctx it received,
// so an e2e client can confirm the REAL adapter dispatch (not a probe) end-to-end.
export async function upgradeHandler(
  ctx: { requestMeta?: { outputId?: string; params?: Record<string, unknown> } },
  { node }: { node: { req: any; socket: any; head: Buffer } },
) {
  const { req, socket } = node;
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const frame = (opcode: number, payload: Buffer) => {
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    }
    return Buffer.concat([header, payload]);
  };

  socket.write(
    frame(
      0x1,
      Buffer.from(
        JSON.stringify({
          hello: "ws-canary upgradeHandler",
          pod: process.env.HOSTNAME ?? "?",
          outputId: ctx?.requestMeta?.outputId ?? null,
        }),
      ),
    ),
  );

  const keepalive = setInterval(() => {
    if (!socket.destroyed) socket.write(frame(0x9, Buffer.alloc(0)));
  }, 15_000);

  let buf: Buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b1 = buf[1]!;
      const opcode = buf[0]! & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      }
      let mask: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        mask = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) {
        clearInterval(keepalive);
        socket.destroy();
        return;
      }
      if (opcode === 0x1 || opcode === 0x2) socket.write(frame(opcode, payload));
    }
  });
  socket.on("close", () => clearInterval(keepalive));
  socket.on("error", () => {
    clearInterval(keepalive);
    socket.destroy();
  });
}
