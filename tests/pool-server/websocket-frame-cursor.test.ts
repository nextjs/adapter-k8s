// tests/pool-server/websocket-frame-cursor.test.ts
// N91. The cursor is the whole basis for deciding whether shutdown may write a 1001 into a
// cross-pool tunnel, so its answer has to be right for the byte splits a relay actually produces —
// headers split across chunks, extended lengths, several frames in one chunk — and fail-closed for
// anything it cannot account for. server-shutdown.test.ts covers the real-socket drain outcome;
// this pins the parse itself, which that test can only reach one position at a time.
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  injectTunnelCloseFrame,
  trackTunnelFraming,
} from "../../src/pool-server/websocket-frame-cursor.js";

const GOING_AWAY = Buffer.from([0x88, 0x02, 0x03, 0xe9]);

/** A tunnel's two ends, with the client end's writes captured as bytes. */
function tunnel(relayedHead = Buffer.alloc(0)) {
  const clientSocket = new PassThrough();
  const poolSocket = new PassThrough();
  const written: Buffer[] = [];
  clientSocket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
  poolSocket.pipe(clientSocket);
  trackTunnelFraming(clientSocket, poolSocket, relayedHead);
  return {
    /** Relay bytes from the peer pool and wait for them to reach the cursor. */
    async relay(...chunks: Buffer[]) {
      for (const chunk of chunks) {
        poolSocket.write(chunk);
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    inject: () => injectTunnelCloseFrame(clientSocket, GOING_AWAY),
    clientBytes: () => Buffer.concat(written),
  };
}

describe("N91 tunnel frame cursor", () => {
  it("accepts a close frame on a tunnel that never relayed a byte", async () => {
    const relay = tunnel();
    expect(relay.inject()).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(relay.clientBytes()).toEqual(GOING_AWAY);
  });

  it("counts the upgrade response's own trailing frame bytes", async () => {
    // proxyHead is written to the client before the pipe exists, so a cursor that ignored it would
    // report a boundary while the client holds two of eight promised payload bytes.
    const relay = tunnel(Buffer.from([0x81, 0x08, 0x61, 0x62]));
    expect(relay.inject()).toBe(false);
    await relay.relay(Buffer.from("cdefgh"));
    expect(relay.inject()).toBe(true);
  });

  it.each<[string, Buffer[], boolean]>([
    ["a complete short frame", [Buffer.from([0x81, 0x02, 0x68, 0x69])], true],
    ["a frame missing its last payload byte", [Buffer.from([0x81, 0x02, 0x68])], false],
    ["a lone first header byte", [Buffer.from([0x81])], false],
    ["a header split across chunks, completed", [Buffer.from([0x81]), Buffer.from([0x00])], true],
    [
      "a 126-length header split before its extended length",
      [Buffer.from([0x81, 0x7e]), Buffer.from([0x00])],
      false,
    ],
    [
      "a 126-length frame completed across chunks",
      [Buffer.from([0x81, 0x7e, 0x01, 0x00]), Buffer.alloc(256, 0x61)],
      true,
    ],
    [
      "a 127-length header whose extended length is incomplete",
      [Buffer.from([0x81, 0x7f, 0, 0, 0, 0, 0, 0, 0])],
      false,
    ],
    [
      "a 127-length frame completed across chunks",
      [Buffer.from([0x81, 0x7f, 0, 0, 0, 0, 0, 0, 0, 0x04]), Buffer.from("abcd")],
      true,
    ],
    [
      "two frames and a partial third in one chunk",
      [Buffer.from([0x81, 0x01, 0x61, 0x8a, 0x00, 0x81, 0x03, 0x62])],
      false,
    ],
    [
      "two whole frames in one chunk",
      [Buffer.from([0x81, 0x01, 0x61, 0x8a, 0x00, 0x81, 0x01, 0x62])],
      true,
    ],
    // Fail-closed cases. A mask bit is forbidden in the server→client direction (RFC 6455 §5.1),
    // so seeing one means these bytes are not the frame stream the cursor thinks they are — no
    // position in the stream can be trusted again, even once it looks aligned.
    ["a masked frame, complete", [Buffer.from([0x81, 0x81, 0x00, 0x00, 0x00, 0x00, 0x61])], false],
    [
      "an unreasonable 64-bit length",
      [Buffer.from([0x81, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])],
      false,
    ],
    // The peer already said goodbye at a real boundary: relaying that is the honest close, and a
    // second 1001 of this pod's own invention adds nothing.
    ["the peer pool's own close frame", [Buffer.from([0x88, 0x02, 0x03, 0xe9])], false],
  ])("decides injection after relaying %s", async (_name, chunks, allowed) => {
    const relay = tunnel();
    await relay.relay(...chunks);
    expect(relay.inject()).toBe(allowed);
  });

  it("stops relaying once it has injected, so the close frame is the client's last bytes", async () => {
    const relay = tunnel();
    await relay.relay(Buffer.from([0x81, 0x01, 0x61]));
    expect(relay.inject()).toBe(true);
    await relay.relay(Buffer.from([0x81, 0x01, 0x62]));
    expect(relay.clientBytes()).toEqual(
      Buffer.concat([Buffer.from([0x81, 0x01, 0x61]), GOING_AWAY]),
    );
    // And it stays injected-once: a second drain pass must not append a second frame.
    expect(relay.inject()).toBe(false);
  });

  it("reports no boundary for a socket that was never tracked", () => {
    expect(injectTunnelCloseFrame(new PassThrough(), GOING_AWAY)).toBe(false);
  });
});
