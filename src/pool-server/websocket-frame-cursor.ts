// src/pool-server/websocket-frame-cursor.ts
import type { Duplex } from "node:stream";

/**
 * N91. Where a cross-pool WebSocket tunnel's CLIENT-BOUND byte stream currently sits, so shutdown
 * can tell "between frames" from "halfway through a relayed frame".
 *
 * N90 (websocket-upgrade.ts `UpgradeDisposition`) established that a tunnel must never be written
 * into blindly: `proxySocket.pipe(socket)` relays the sibling pool's frames as raw bytes, a frame
 * routinely spans several TCP chunks, and a `1001` written while one is half-relayed lands INSIDE
 * that frame's declared payload. Refusing to write at all is the safe answer to that, but it is
 * the wrong DEFAULT: the relay only carries the sibling's own close frame when the sibling pool is
 * draining at the same moment, and pools are separate Deployments with per-pool HPAs
 * (emit/templates/hpa.ts). A front pool scaling 3→2, a single-pod eviction, or a rollout touching
 * only one pool's Deployment leaves the peer pool healthy and silent, so those tunnelled clients
 * would get no close frame at all — partial bytes then a TCP destroy, i.e. ws code 1006 — where a
 * blind injection at least gave the common (idle, frame-aligned) tunnel a clean 1001.
 *
 * So track the one thing that decides between the two: the client-bound relay's frame position.
 * Only the payload LENGTH matters, so this reads headers and skips payloads — it does not decode,
 * validate or reassemble anything, and permessage-deflate is transparent to it (compression
 * changes payload bytes, not framing). The direction it tracks is server→client, which RFC 6455
 * §5.1 requires to be unmasked, so a header is 2 bytes plus at most an 8-byte extended length.
 *
 * Every uncertainty is fail-closed to "not a boundary", which is exactly the N90 behavior of
 * injecting nothing: an untracked socket, a masked or over-long header (a stream this cannot be
 * reasoning about correctly), a partly received header, a partly relayed payload, or a close frame
 * the sibling already sent. The worst case of this cursor is therefore the branch's un-injected
 * behavior; it can only ADD close frames in provably safe positions.
 */
class ClientBoundFrameCursor {
  /** Cleared for good once the stream stops looking like unmasked server framing. */
  #trackable = true;
  #payloadRemaining = 0;
  /** Header bytes seen for the frame currently being parsed; empty means "expecting a header". */
  #header: number[] = [];
  #closeRelayed = false;
  /** Set when shutdown has taken the relay over, so nothing further is credited to the client. */
  #relayStopped = false;
  readonly #detachRelay: () => void;

  constructor(detachRelay: () => void) {
    this.#detachRelay = detachRelay;
  }

  observe(chunk: Buffer): void {
    if (!this.#trackable) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#payloadRemaining > 0) {
        // Bulk skip: payload bytes carry no framing, so the loop is O(frames), not O(bytes).
        const consumed = Math.min(this.#payloadRemaining, chunk.length - offset);
        this.#payloadRemaining -= consumed;
        offset += consumed;
        continue;
      }
      this.#header.push(chunk[offset]!);
      offset += 1;
      const parsed = parseFrameHeader(this.#header);
      if (parsed === "incomplete") continue;
      if (parsed === "untrackable") {
        this.#trackable = false;
        return;
      }
      this.#payloadRemaining = parsed.payloadLength;
      if (parsed.close) this.#closeRelayed = true;
      this.#header = [];
    }
  }

  atFrameBoundary(): boolean {
    return (
      this.#trackable &&
      !this.#relayStopped &&
      !this.#closeRelayed &&
      this.#payloadRemaining === 0 &&
      this.#header.length === 0
    );
  }

  stopRelay(): void {
    this.#relayStopped = true;
    this.#detachRelay();
  }
}

type ParsedFrameHeader = { payloadLength: number; close: boolean };

/**
 * Length (and closeness) of the frame whose header these bytes begin, or why that is not knowable
 * yet — or at all. `masked` is the "not at all" case: RFC 6455 §5.1 forbids a server from masking,
 * so a mask bit in this direction means the bytes are not the frame stream this thinks they are
 * (a sibling that is not a WebSocket endpoint, a stream already desynchronized) and no position in
 * it can be trusted again.
 */
function parseFrameHeader(
  header: readonly number[],
): ParsedFrameHeader | "incomplete" | "untrackable" {
  if (header.length < 2) return "incomplete";
  const close = (header[0]! & 0x0f) === 0x8;
  if ((header[1]! & 0x80) !== 0) return "untrackable";
  const length7 = header[1]! & 0x7f;
  if (length7 < 126) return { payloadLength: length7, close };
  if (length7 === 126) {
    if (header.length < 4) return "incomplete";
    return { payloadLength: (header[2]! << 8) | header[3]!, close };
  }
  if (header.length < 10) return "incomplete";
  // 64-bit length. Anything past Number.MAX_SAFE_INTEGER cannot be counted down in a JS number,
  // and no real peer sends it, so stop tracking rather than mis-track.
  let payloadLength = 0;
  for (let index = 2; index < 10; index++) {
    payloadLength = payloadLength * 256 + header[index]!;
    if (!Number.isSafeInteger(payloadLength)) return "untrackable";
  }
  return { payloadLength, close };
}

/**
 * Keyed by the CLIENT socket, which is the socket createPoolServer's drain iterates and the only
 * handle it has. Weak so a closed tunnel's cursor is collected with its socket.
 */
const cursors = new WeakMap<Duplex, ClientBoundFrameCursor>();

/**
 * Start tracking the client-bound direction of a tunnel. `relayedHead` is the frame bytes the
 * upgrade response already carried (`proxyHead`), which are written to the client before the pipe
 * exists and are therefore part of the same stream.
 */
export function trackTunnelFraming(clientSocket: Duplex, poolSocket: Duplex, relayedHead: Buffer) {
  const cursor = new ClientBoundFrameCursor(() => poolSocket.unpipe(clientSocket));
  cursors.set(clientSocket, cursor);
  if (relayedHead.length > 0) cursor.observe(relayedHead);
  // Attached after `pipe()` deliberately: `pipe()` already resumed the source, and resumption is
  // scheduled (process.nextTick), so no chunk can be emitted between the two calls — while
  // attaching a `data` listener FIRST would resume the source before the destination exists.
  poolSocket.on("data", (chunk: Buffer) => cursor.observe(chunk));
}

/**
 * Write a close frame into a tunnel if — and only if — the client-bound relay is provably between
 * frames (N91). Returns whether it was written; `false` means the N90 outcome, no injected frame.
 *
 * The relay is detached on success so the injected frame is the last thing the client sees: once
 * this pod has told the client "going away" on the peer's behalf, forwarding further frames from a
 * peer that has not closed is a different kind of lie, and the pipe is destroyed within the
 * terminal flush window regardless.
 */
export function injectTunnelCloseFrame(clientSocket: Duplex, closeFrame: Buffer): boolean {
  const cursor = cursors.get(clientSocket);
  if (!cursor?.atFrameBoundary()) return false;
  cursor.stopRelay();
  clientSocket.write(closeFrame);
  return true;
}
