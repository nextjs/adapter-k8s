// A tiny, zero-dependency RESP2 client for Valkey/Redis — the only Redis client the adapter ships.
//
// Why not ioredis: the incremental `cacheHandler` is referenced from `next.config` and Turbopack
// pulls it (and its Redis client) into every runtime that touches the incremental cache. A big
// socket library drags a transitive dep tree the adapter had to stage by hand, and bloats those
// chunks. This client needs only `node:net`/`node:tls` (Next auto-externalizes `node:*`), so there
// is nothing to stage and almost nothing to bundle.
//
// It is NOT edge-safe in the sense of running there — no socket client can, the edge runtime has no
// `node:net`. But it is edge-EVAL-safe: `node:net`/`node:tls` are loaded via `await import(...)`
// inside `connect()`, never at module top level, so merely importing this file (as an edge chunk
// would) touches no node internals. The cacheHandler's `EdgeRuntime` guard ensures `connect()` is
// never reached in edge.
//
// Command surface is deliberately the handful the handlers use. RESP2 replies map to JS as: simple
// string -> string, integer -> number, bulk -> Buffer (binary-safe; wrappers decode when they want
// text), array -> array, null bulk/array -> null, error -> RespError. FIFO: RESP guarantees replies
// arrive in request order, so a single ordered queue resolves them.

import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { wallClockNow } from "./stream-codec.js";

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RespError";
  }
}

type Arg = string | number | Buffer;
type Reply = Buffer | string | number | null | RespError | Reply[];

interface Pending {
  resolve: (value: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface ValkeyMulti {
  hset(key: string, ...args: Arg[]): this;
  expire(key: string, seconds: number): this;
  exec(): Promise<unknown[]>;
}

/** The subset of a Redis client the Valkey cache handlers depend on. */
export interface ValkeyClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string | Buffer, ...args: Arg[]): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  ttl(key: string): Promise<number>;
  eval(script: string, numkeys: number, ...args: Arg[]): Promise<unknown>;
  hmget(key: string, ...fields: string[]): Promise<(string | null)[]>;
  hset(key: string, ...args: Arg[]): Promise<number>;
  hgetallBuffer(key: string): Promise<Record<string, Buffer>>;
  multi(): ValkeyMulti;
  quit(): Promise<void>;
}

export interface RespClientOptions {
  /** `redis://host:port` or `rediss://host:port` (TLS). IPv6 literals use URL brackets:
   * `redis://[::1]:6379` (N7). Userinfo is honored as AUTH when `password` isn't given
   * explicitly: `redis://:pass@host` sends `AUTH pass`, `redis://user:pass@host` sends the ACL
   * form `AUTH user pass` (N3), and `redis://user@host` (an ACL `nopass` user) sends
   * `AUTH user ""` (N7). A DB index in the URL path (`redis://host/1`) is NOT honored — the
   * cache keyspace is namespaced by build id and always uses DB 0; a warning is logged once
   * per process (N4). */
  url: string;
  /** AUTH string, sent before any command. Takes precedence over URL userinfo. */
  password?: string | undefined;
  /** PEM of the server CA to pin TLS verification against (e.g. a Memorystore in-transit
   * encryption CA, which is not publicly rooted). Only meaningful with `rediss:`. */
  caCert?: string | undefined;
  /** Reject (and drop the socket) if a command has no reply within this window. 0 disables. */
  commandTimeoutMs?: number;
  /** Reject if the TCP/TLS connection isn't established within this window (a blackholed endpoint
   * has no connect timeout of its own and would otherwise hang the first command's render). */
  connectTimeoutMs?: number;
  /** How long the circuit breaker stays open after a connect/command failure (L17): during the
   * window, commands fail fast instead of each paying a fresh connect + connectTimeoutMs. */
  circuitBreakerMs?: number;
  /** Maximum size of a single reply frame in bytes (default 64 MiB). A server-advertised bulk
   * length or array that would exceed this is a protocol error: the connection is destroyed and
   * all in-flight commands fail (we never buffer an unbounded/untrustworthy advertised length). */
  maxReplyBytes?: number;
}

const CRLF = Buffer.from("\r\n");

/** Default cap for one reply frame (M6b). Entries are capped at 16 MiB, so 64 MiB is generous. */
const DEFAULT_MAX_REPLY_BYTES = 64 * 1024 * 1024;
/**
 * N72: hard cap on ONE RESP header/inline line (the bytes up to the first CRLF). Real Valkey
 * lines are tiny — a bulk/array header is `$<digits>`, and simple-string/error replies are short
 * status text. Without a bound, an UNTERMINATED inline line (`+AAAA…` with no CRLF, which a
 * hostile or broken endpoint can emit) made `scanFrameEnd` return `need = buf.length + 1`, so the
 * inbound path re-`Buffer.concat`ed the entire backlog on every 64 KiB chunk until
 * `maxBufferedBytes` — quadratic copying. Measured fail-time vs the frame cap, before this bound:
 * 2 MiB → 116 ms, 4 → 473, 8 → 2084, 16 → 8844 (a clean 4× per doubling), and at the 64 MiB
 * DEFAULT cap **164_197 ms with 884 MiB peak RSS** — nearly three minutes of CPU-bound copying,
 * i.e. a liveness-probe failure or an OOMKill instead of a clean protocol error. With the bound:
 * ~2 ms and no measurable RSS growth at every cap.
 */
const MAX_HEADER_LINE_BYTES = 8 * 1024;
/**
 * S21. Upper bound on the ELEMENT count of a single RESP array, independent of the byte cap.
 * See the note at the array branch in parseReply for why bytes alone are not a bound.
 */
const MAX_ARRAY_ELEMENTS = 1_000_000;
/** Total buffered-but-unparsed bytes are capped at a multiple of the frame cap: pipelined replies
 * (MULTI, concurrent commands) legitimately stack several frames behind the head one. */
const MAX_BUFFERED_FACTOR = 4;
/**
 * Default circuit-breaker window (L17). During a Valkey outage, every command would otherwise
 * pay a fresh TCP/TLS connect plus up to `connectTimeoutMs` before failing — per cache read,
 * per render, amplifying the outage's latency cost across the whole pool. After any
 * connect/command failure the breaker stays open for this window and commands fail fast (the
 * handlers degrade to a cache miss); the first command past the window probes a fresh
 * connection, so recovery is automatic and uncoordinated.
 */
const DEFAULT_CIRCUIT_BREAKER_MS = 1_500;

/** Everything `connect()` needs, derived from the URL exactly once (N70). */
interface ValkeyTarget {
  host: string;
  port: number;
  useTls: boolean;
  /** ACL username from URL userinfo (N3), percent-decoded. */
  username: string | undefined;
  /** Password from URL userinfo (L6), percent-decoded. */
  password: string | undefined;
  /** Whether the URL carried a DB index path (`redis://host/1`) — warned about, ignored (N4). */
  hasDbIndex: boolean;
}

/**
 * N70 (SECURITY): parse the connection URL ONCE, and never let the parse error escape.
 *
 * `new URL(badUrl)` throws a `TypeError` with `code: 'ERR_INVALID_URL'` **and the raw input
 * attached as `.input`**. That error used to be raised per-command from inside `connect()`, where
 * the handlers' `logErrorRateLimited(..., error)` → `console.error(msg, error)` inspects own
 * properties — so a `redis://:sup3rs3cret@bad host:6379` (a space in the host, e.g. a stray
 * newline or a copy-paste from a secret manager) printed the PASSWORD into the pod log, and did it
 * again every 1.5 s as the circuit breaker cycled. Measured before the fix:
 *   `[valkey-cache] revalidateTag failed … | TypeError: Invalid URL
 *    {"code":"ERR_INVALID_URL","input":"redis://:sup3rs3cret@bad host:6379"}`
 * AGENTS.md is explicit: secrets never reach logs. So the only thing that leaves this function on
 * failure is a fixed, input-free message.
 */
function parseValkeyUrl(url: string): ValkeyTarget {
  const redacted = () => new Error("invalid Valkey URL (redacted)");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw redacted();
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw redacted();
  // N7: `URL.hostname` keeps the brackets on an IPv6 literal (`redis://[::1]:6379` → `"[::1]"`).
  // Unbracketed, `net.isIP` recognizes it (so the L18 SNI skip applies) and `net.connect` gets a
  // connectable address instead of resolving `"[::1]"` as a DNS name.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host.length === 0) throw redacted();
  const port = parsed.port ? Number(parsed.port) : 6379;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw redacted();
  // Honor URL userinfo (`redis://:secret@host`) when no explicit password is configured (L6) — it
  // was previously parsed and silently dropped, which surfaced as a permanent NOAUTH. The N3 ACL
  // USERNAME (`redis://user:pass@host`) selects the ACL identity; dropping it made ACL-user
  // deployments AUTH as `default` and get NOAUTH.
  const decode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // malformed percent-encoding: use it verbatim
    }
  };
  return {
    host,
    port,
    useTls: parsed.protocol === "rediss:",
    username: parsed.username ? decode(parsed.username) : undefined,
    password: parsed.password ? decode(parsed.password) : undefined,
    hasDbIndex: Boolean(parsed.pathname) && parsed.pathname !== "/",
  };
}

function encodeCommand(args: Arg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const body = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${body.length}\r\n`), body, CRLF);
  }
  return Buffer.concat(parts);
}

// Parse one reply starting at `offset`. Returns [value, nextOffset], or null if `buf` doesn't yet
// hold a complete reply (caller waits for more data). Bulk payloads are sliced by their length
// prefix, so binary values containing CRLF parse correctly. Callers must have validated the frame
// with `scanFrameEnd` first (which rejects malformed lengths), so the length fields seen here are
// already known-good.
function parseReply(buf: Buffer, offset: number): [Reply, number] | null {
  if (offset >= buf.length) return null;
  const lineEnd = buf.indexOf(CRLF, offset);
  if (lineEnd === -1) return null;
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const after = lineEnd + 2;
  switch (buf[offset]) {
    case 0x2b: // '+' simple string
      return [line, after];
    case 0x2d: // '-' error
      return [new RespError(line), after];
    case 0x3a: // ':' integer
      return [Number(line), after];
    case 0x24: {
      // '$' bulk string
      const len = Number(line);
      if (len < 0) return [null, after];
      const end = after + len;
      if (end + 2 > buf.length) return null; // payload + trailing CRLF not fully arrived
      return [buf.subarray(after, end), end + 2];
    }
    case 0x2a: {
      // '*' array
      const count = Number(line);
      if (count < 0) return [null, after];
      // S21 (AVAILABILITY). The wire-size cap (maxReplyBytes) bounds BYTES, not ELEMENTS —
      // `$-1\r\n` is 5 bytes, so a hostile or compromised Valkey fits ~13M null elements
      // inside a 64 MiB reply and this loop allocates a JS slot for every one of them,
      // synchronously, on a pod whose default limit is 512 MiB. Bound the count too. The
      // legitimate ceiling is an HMGET over the tag manifest, itself capped at 1024 tags
      // (incremental-cache-handler.ts), so this leaves three orders of magnitude of headroom.
      // Unreachable in the client path — scanFrameEnd rejects an oversized count first, inside
      // the guarded region. Kept because parseReply is also called directly by tests and any
      // future caller, and a RespError here still reaches failAll rather than the process.
      if (count > MAX_ARRAY_ELEMENTS) {
        throw new RespError(
          `RESP protocol error: array of ${count} elements exceeds the ` +
            `${MAX_ARRAY_ELEMENTS}-element cap`,
        );
      }
      const items: Reply[] = [];
      let cursor = after;
      for (let i = 0; i < count; i++) {
        const next = parseReply(buf, cursor);
        if (!next) return null;
        items.push(next[0]);
        cursor = next[1];
      }
      return [items, cursor];
    }
    default:
      return null;
  }
}

/**
 * Measure the RESP frame starting at `offset` WITHOUT copying anything (M6b). Returns `{ end }`
 * (absolute index one past the complete frame) or `{ need }` (rescanning is pointless until
 * `buf.length >= need`). The `need` contract is what lets the inbound path buffer chunks of a
 * large reply without re-scanning (and re-copying) per chunk: the bulk header reveals the full
 * frame size up front.
 *
 * Throws a RespError on a protocol violation (L8): a non-integer or `< -1` length/count (RESP
 * nulls use -1), an unknown type byte, a frame that would exceed `limit` bytes, or nesting past
 * MAX_FRAME_DEPTH. Such a reply means the byte stream can no longer be trusted — the caller
 * destroys the connection and fails all in-flight commands rather than risking a
 * command-queue desync.
 */
// Real Valkey replies nest at most 2-3 levels (array → bulk, array → array → bulk). The
// scanner recurses per array element, so a hostile endpoint could otherwise crash the process
// with a stack overflow via `*1\r\n*1\r\n...` — cap the depth far above anything legitimate.
const MAX_FRAME_DEPTH = 32;
/**
 * L8 + N73: a RESP length/count must be a plain decimal integer. `Number.isInteger(Number(line))`
 * accepted hex (`$0x10` → a 16-byte read, measured), exponent (`$1e1` → 10 bytes), a leading space
 * (`$ 3`), a leading `+`, and `3.0`. No queue desync resulted (the scanner and the parser share the
 * same coercion, and `drainInbound`'s `parsed[1] !== scan.end` cross-check catches any drift), but
 * accepting non-canonical forms from an untrusted stream is exactly the kind of latitude the M6b/L8
 * hardening exists to remove: the byte stream is only trustworthy while it is EXACTLY RESP2.
 */
const DECIMAL_INTEGER = /^-?\d+$/;
function parseRespLength(line: string): number | undefined {
  if (!DECIMAL_INTEGER.test(line)) return undefined;
  const value = Number(line);
  return Number.isInteger(value) && value >= -1 ? value : undefined;
}
function scanFrameEnd(
  buf: Buffer,
  offset: number,
  limit: number,
  depth = 0,
): { end: number } | { need: number } {
  if (depth > MAX_FRAME_DEPTH) {
    throw new RespError(`RESP frame nested past ${MAX_FRAME_DEPTH} levels`);
  }
  if (offset >= buf.length) return { need: offset + 1 };
  const type = buf[offset]!;
  const lineEnd = buf.indexOf(CRLF, offset);
  // N72: bound the header/inline-line scan. A line longer than MAX_HEADER_LINE_BYTES — terminated
  // or not — is a protocol violation, not something to keep buffering and re-scanning for.
  if (lineEnd === -1 || lineEnd - offset > MAX_HEADER_LINE_BYTES) {
    if (buf.length - offset > MAX_HEADER_LINE_BYTES) {
      throw new RespError(
        `RESP protocol error: no CRLF within ${MAX_HEADER_LINE_BYTES} bytes of a reply line`,
      );
    }
    if (lineEnd === -1) return { need: buf.length + 1 };
  }
  const after = lineEnd + 2;
  switch (type) {
    case 0x2b: // '+' simple string
    case 0x2d: // '-' error
    case 0x3a: // ':' integer
      // N72: inline frames count against the frame cap like bulk ones do. They were exempt, so a
      // `maxReplyBytes` of 1 KiB did not stop a multi-KiB inline line.
      if (after > limit) {
        throw new RespError(`RESP inline reply of ${after} bytes exceeds the ${limit}-byte cap`);
      }
      return { end: after };
    case 0x24: {
      // '$' bulk string
      const len = parseRespLength(buf.toString("utf8", offset + 1, lineEnd));
      if (len === undefined) {
        throw new RespError(
          `RESP protocol error: invalid bulk length ${JSON.stringify(buf.toString("utf8", offset + 1, lineEnd))}`,
        );
      }
      if (len === -1) return { end: after };
      const end = after + len + 2;
      if (end > limit) {
        throw new RespError(`RESP reply frame of ${len} bytes exceeds the ${limit}-byte cap`);
      }
      return buf.length >= end ? { end } : { need: end };
    }
    case 0x2a: {
      // '*' array
      const count = parseRespLength(buf.toString("utf8", offset + 1, lineEnd));
      if (count === undefined) {
        throw new RespError(
          `RESP protocol error: invalid array count ${JSON.stringify(buf.toString("utf8", offset + 1, lineEnd))}`,
        );
      }
      if (count === -1) return { end: after };
      // S21: the ELEMENT cap belongs HERE, in the framing pass, not only in parseReply.
      // `$-1\r\n` is 5 bytes, so ~13M null elements fit under a 64 MiB byte cap; scanFrameEnd
      // would then report the frame COMPLETE and parseReply — which runs OUTSIDE
      // drainInbound's try/catch — would throw and take the process down, instead of the
      // RespError path that calls failAll and lets callers fall back to a cache miss.
      if (count > MAX_ARRAY_ELEMENTS) {
        throw new RespError(
          `RESP protocol error: array of ${count} elements exceeds the ` +
            `${MAX_ARRAY_ELEMENTS}-element cap`,
        );
      }
      let cursor = after;
      for (let i = 0; i < count; i++) {
        const sub = scanFrameEnd(buf, cursor, limit, depth + 1);
        if ("need" in sub) return sub;
        cursor = sub.end;
      }
      if (cursor > limit) {
        throw new RespError(`RESP reply frame exceeds the ${limit}-byte cap`);
      }
      return { end: cursor };
    }
    default:
      throw new RespError(`RESP protocol error: unknown type byte 0x${type.toString(16)}`);
  }
}

class RespClient implements ValkeyClient {
  private socket: Socket | TLSSocket | undefined;
  private connecting: Promise<void> | undefined;
  /** Inbound bytes not yet attributed to a complete reply frame, as a chunk list + running total
   * (concatenated lazily, once per emitted frame — never per received chunk). */
  private inboundChunks: Buffer[] = [];
  private inboundBytes = 0;
  /** Rescan hint from `scanFrameEnd`: don't touch the chunk list until this many bytes exist. */
  private neededBytes = 0;
  private readonly queue: Pending[] = [];
  private ended = false;
  /**
   * N76: monotonic id of the CURRENT connection attempt. Every failure path (socket `error`/`close`
   * listener, command timeout, connect rejection) captures the generation it belongs to, and
   * `failAll` ignores a report from a superseded one. Without it, one socket error could tear down a
   * NEWER connection: on the AUTH path a socket error rejects the in-flight AUTH pending AND later
   * resolves `connect()`'s rejection, so `ensureConnected` called `failAll(error, true)` a second
   * time — by which point a fresh `connect()` may already own `this.socket`. The circuit breaker
   * hides it today (the second call lands inside the open window, before any reconnect), but
   * `circuitBreakerMs: 0` is a documented option, and with it the second `failAll` kills a healthy
   * connection and rejects its unrelated in-flight commands.
   */
  private generation = 0;
  /** Parsed once in the constructor (N70). Undefined when the URL is invalid; see `urlError`. */
  private readonly target: ValkeyTarget | undefined;
  /** Redacted parse failure, re-thrown lazily from `connect()` so a bad URL degrades to a
   * cache miss (fail-open) instead of throwing out of the cacheHandler constructor. */
  private readonly urlError: Error | undefined;
  private readonly password: string | undefined;
  private readonly caCert: string | undefined;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly circuitBreakerMs: number;
  private readonly maxReplyBytes: number;
  private readonly maxBufferedBytes: number;
  /** L17: while the wall clock (wallClockNow, N8) is below this, commands fail fast instead of reconnecting. */
  private circuitOpenUntil = 0;

  constructor(options: RespClientOptions) {
    // N70: parse ONCE, here, and keep the failure redacted. It is stored rather than thrown
    // because this constructor runs inside Next's `cacheHandler` construction (which happens
    // during a render): throwing there would break rendering, while the dataplane rule is to
    // fail open to a cache miss. `connect()` rejects with the redacted error instead.
    try {
      this.target = parseValkeyUrl(options.url);
    } catch (error) {
      this.target = undefined;
      this.urlError = error instanceof Error ? error : new Error("invalid Valkey URL (redacted)");
    }
    this.password = options.password;
    this.caCert = options.caCert;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.circuitBreakerMs = options.circuitBreakerMs ?? DEFAULT_CIRCUIT_BREAKER_MS;
    this.maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
    this.maxBufferedBytes = this.maxReplyBytes * MAX_BUFFERED_FACTOR;
  }

  private onData(chunk: Buffer, generation: number): void {
    if (generation !== this.generation) return; // bytes from a superseded socket (N76)
    // N71: RESP2 has no legal server-push path on a connection this client uses (no SUBSCRIBE, no
    // MONITOR, and RESP3 push frames require a HELLO 3 we never send). So bytes arriving while the
    // reply queue is EMPTY are unsolicited, and retaining them (which `drainInbound`'s
    // `while (queue.length > 0)` did, silently) shifts every subsequent reply by one frame FOR THE
    // LIFE OF THE SOCKET. Probed with a server that writes `+UNSOLICITED\r\n` once before any
    // command: `GET keyA` returned `"UNSOLICITED"` and `GET keyB` returned `"AAAA-value"` — keyA's
    // bytes served under keyB's key. `parseStoredMeta` cannot catch that: the bytes are a
    // well-formed entry, just the WRONG one. Treat it as the protocol violation it is.
    if (this.queue.length === 0) {
      this.failAll(
        new RespError(
          "RESP protocol error: unsolicited reply bytes arrived with no command in flight; " +
            "destroying the connection rather than desynchronizing the reply stream",
        ),
        false,
        generation,
      );
      return;
    }
    this.inboundChunks.push(chunk);
    this.inboundBytes += chunk.length;
    if (this.inboundBytes > this.maxBufferedBytes) {
      // Unbounded buffering is a memory-exhaustion vector (M6b); bail out exactly like a socket
      // error: destroy the connection and fail every in-flight command.
      this.failAll(
        new RespError(
          `Valkey reply buffer grew past ${this.maxBufferedBytes} bytes; destroying connection`,
        ),
        false,
        generation,
      );
      return;
    }
    this.drainInbound(generation);
  }

  // Emit every complete reply frame the inbound buffer currently holds. The expensive path — a
  // large reply arriving in many TCP chunks — copies each byte exactly once: the header scan
  // learns the frame size up front, intermediate chunks are only appended to the chunk list,
  // and a single concat happens when the last chunk lands.
  private drainInbound(generation: number): void {
    while (this.queue.length > 0) {
      if (this.inboundBytes < this.neededBytes) return; // head frame known-incomplete: wait cheaply
      const buf = this.flattenInbound();
      let scan: { end: number } | { need: number };
      try {
        scan = scanFrameEnd(buf, 0, this.maxReplyBytes);
      } catch (error) {
        this.failAll(
          error instanceof Error ? error : new RespError(String(error)),
          false,
          generation,
        );
        return;
      }
      if ("need" in scan) {
        this.neededBytes = scan.need;
        return;
      }
      const parsed = parseReply(buf, 0);
      if (!parsed || parsed[1] !== scan.end) {
        // scanFrameEnd proved the frame complete, so parseReply cannot disagree — unless the two
        // parsers drifted apart. Fail closed rather than desync the command queue.
        this.failAll(
          new RespError("RESP protocol error: frame scanner/parser disagree"),
          false,
          generation,
        );
        return;
      }
      this.consumeInbound(parsed[1]);
      const pending = this.queue.shift()!;
      if (pending.timer) clearTimeout(pending.timer);
      const value = parsed[0];
      if (value instanceof RespError) pending.reject(annotateRespError(value));
      else pending.resolve(value);
    }
    // N71: the same rule as `onData`, for bytes that arrived in the SAME chunk as the last reply —
    // a trailing partial/extra frame with nothing left to attribute it to would silently shift the
    // next command's reply.
    if (this.inboundBytes > 0) {
      this.failAll(
        new RespError(
          "RESP protocol error: extra reply bytes remained after the last in-flight command; " +
            "destroying the connection rather than desynchronizing the reply stream",
        ),
        false,
        generation,
      );
    }
  }

  // Join the chunk list into one contiguous buffer for scanning/parsing. No-op when a single
  // chunk is buffered; afterwards the list collapses to that one buffer.
  private flattenInbound(): Buffer {
    if (this.inboundChunks.length === 1) return this.inboundChunks[0]!;
    const flat = Buffer.concat(this.inboundChunks, this.inboundBytes);
    this.inboundChunks = [flat];
    return flat;
  }

  private consumeInbound(consumed: number): void {
    const rest = this.inboundChunks[0]!.subarray(consumed);
    this.inboundChunks = rest.length > 0 ? [rest] : [];
    this.inboundBytes = rest.length;
    this.neededBytes = 0; // the next head frame's size is unknown until scanned
  }

  // Tear down the socket and fail every in-flight command. Called on socket error/close, on a
  // command timeout, and on a reply-protocol violation — destroying is deliberate: a late or
  // mistramed reply after we've shifted the queue would map to the wrong caller, so we resync
  // from a clean slate and let the next command reconnect.
  //
  // `fromConnectFailure` is set by the connect path (ensureConnected's rejection handler): a
  // failed connect never has queued commands, but it absolutely warrants the breaker.
  //
  // `generation` (N76) identifies the connection attempt the failure was observed on. When it no
  // longer matches, a newer connect already replaced that socket and this report is stale — dropping
  // it is what keeps a healthy connection alive (see the `generation` field's comment). Callers that
  // are inherently current (`quit`) pass nothing.
  private failAll(error: Error, fromConnectFailure = false, generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    // Retire this connection id so a second report about the SAME failure (the classic case: a
    // socket `error` event AND the connect promise's rejection) is a no-op.
    this.generation++;
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    this.inboundChunks = [];
    this.inboundBytes = 0;
    this.neededBytes = 0;
    // Open the circuit breaker (L17) — but only when the failure actually cost something: a
    // connect failure, or in-flight commands that just paid for it (`queue.length > 0`, checked
    // BEFORE the queue is drained below). A server-initiated close with an EMPTY queue (server
    // `timeout`, NAT/proxy idle reaping — routine in k8s) is benign (N7): pre-breaker the client
    // reconnected transparently on the next command, and opening here made that next cache read
    // fail fast for circuitBreakerMs even though an immediate reconnect would have succeeded.
    if (this.circuitBreakerMs > 0 && (fromConnectFailure || this.queue.length > 0)) {
      // N8: wallClockNow, not Date.now — a patched Date.now throwing INSIDE ensureConnection
      // corrupted the connect state ("Connection closed" on every later command), silently
      // killing freshness checks. These circuit-breaker clock reads are load-bearing.
      this.circuitOpenUntil = wallClockNow() + this.circuitBreakerMs;
    }
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    while (this.queue.length) {
      const pending = this.queue.shift()!;
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private async connect(generation: number): Promise<void> {
    // N70: the URL was parsed (and any failure redacted) in the constructor.
    if (!this.target) throw this.urlError ?? new Error("invalid Valkey URL (redacted)");
    const {
      host,
      port,
      useTls,
      username: userinfoUsername,
      password: userinfoPassword,
    } = this.target;
    // N4: a DB index in the URL path (`redis://host/1`) is silently ignored by design — the
    // cache keyspace is namespaced by build id, so everything lives in DB 0. Warn once rather
    // than dropping it silently (SELECT is deliberately unimplemented: multi-DB is deprecated
    // upstream and the build-id namespace already provides the wanted isolation).
    if (this.target.hasDbIndex) warnDbIndexOnce();
    const password = this.password ?? userinfoPassword;
    if (password && !useTls) warnPlaintextAuthOnce();

    // EDGE-COMPILE-SAFE builtin loading (2026-08-02, measured on canary.97): Turbopack
    // statically resolves `import("node:net")` / `require("node:net")` specifiers even in
    // never-executed branches and REFUSES them in the Edge Runtime compilation — and
    // next.config.cacheHandler is pulled into the edge middleware graph, so a resolvable
    // specifier here made every edge-middleware app UNBUILDABLE with the shared cache
    // (the historical hasEdgeMiddleware registration skip, now removed).
    // `process.getBuiltinModule` (Node >= 20.16/22.3, within `engines`) has no static
    // specifier: the edge bundle carries this as dead code and parses; Node loads the real
    // builtins. With a configured CA (Memorystore in-transit encryption), pin verification
    // to it — its CA is not publicly rooted, so the default trust store would reject the
    // handshake.
    const getBuiltin = (
      globalThis as {
        process?: { getBuiltinModule?: (id: string) => unknown };
      }
    ).process?.getBuiltinModule;
    if (!getBuiltin) {
      throw new Error(
        "[valkey-cache] process.getBuiltinModule is unavailable — use Node 20 >=20.16 or " +
          "Node >=22.3 to open a Valkey connection (edge runtimes never connect; this code " +
          "is inert there).",
      );
    }
    const net = getBuiltin("node:net") as typeof import("node:net");
    const socket: Socket | TLSSocket = useTls
      ? (getBuiltin("node:tls") as typeof import("node:tls")).connect({
          host,
          port,
          // L18: SNI is a DNS-name extension, so it is omitted for IP-literal hosts —
          // `rediss://<ip>` (a Memorystore VPC endpoint) is the normal production shape.
          // Certificate verification still runs, matched against the cert's IP subjectAltName.
          //
          // The failure originally reported here was a hard throw (ERR_INVALID_ARG_VALUE) on an
          // IP `servername`, making `rediss://<ip>` unconnectable. Both measurements, 2026-07:
          //   • Node 20 / 22 / 24 (what `engines` allows and what the emitted images pin):
          //     NO throw — only DEP0123 ("Setting the TLS ServerName to an IP address is not
          //     permitted by RFC 6066. This will be ignored in a future version."), SNI is still
          //     sent, and the handshake completes.
          //   • Node 25 / 26: the deprecation has become a hard `ERR_INVALID_ARG_VALUE` throw.
          // So the throw is real, just AHEAD of our supported range — this skip is what keeps
          // `rediss://<ip>` working when a build host or base image moves to Node 25+, and it is
          // RFC 6066 correctness meanwhile (a server may reject an IP SNI outright). Nothing in
          // the CURRENT runtime enforces it, though: deleting it would keep connecting on 20-24
          // and only break later.
          // That is why `resp-client-tls.integration.test.ts` asserts SNI absence ON THE WIRE
          // (parsing the ClientHello through a TCP relay in front of a real Valkey TLS listener)
          // instead of merely asserting that an IP endpoint connects — a behavioral test would
          // pass either way and this skip would rot unnoticed.
          ...(net.isIP(host) ? {} : { servername: host }),
          ...(this.caCert ? { ca: this.caCert } : {}),
        })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk, generation));

    // Wait for the TCP/TLS connection with a bounded timeout, and reject on a pre-connect error or
    // close — DNS/TCP/TLS have no timeout of their own, so a blackholed endpoint would otherwise
    // leave the first command (and its render) unresolved forever.
    const readyEvent = useTls ? "secureConnect" : "connect";
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        socket.off(readyEvent, onReady);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onClose = () => onError(new Error("Valkey connection closed during connect"));
      const timer = setTimeout(() => {
        socket.destroy();
        onError(new Error("Valkey connect timed out"));
      }, this.connectTimeoutMs);
      timer.unref?.();
      socket.once(readyEvent, onReady);
      socket.once("error", onError);
      socket.once("close", onClose);
    });

    // Connected. Expose the socket and wire persistent failure handling only now — before this point
    // no command may reach the half-open socket (ensureConnected gates them on `this.connecting`).
    this.socket = socket;
    socket.on("error", (error: Error) => this.failAll(error, false, generation));
    socket.on("close", () =>
      this.failAll(new Error("Valkey connection closed"), false, generation),
    );

    // AUTH before any user command. connect() stays pending (so ensureConnected keeps gating user
    // commands) until AUTH's reply lands; its own command timeout bounds it. ACL form (N3) when
    // the URL carried a username, single-arg legacy form otherwise. A username WITHOUT a password
    // (`redis://user@host`, an ACL `nopass` user) still sends the ACL form with an empty-string
    // password — the server accepts it for `nopass` users; previously the username was silently
    // dropped and no AUTH was sent at all, so the connection ran as `default` (N7).
    if (userinfoUsername) {
      await this.write(["AUTH", userinfoUsername, password ?? ""]);
    } else if (password) {
      await this.write(["AUTH", password]);
    }
  }

  private ensureConnected(): Promise<void> {
    if (this.ended) return Promise.reject(new Error("Valkey client closed"));
    // Gate on an in-progress connect FIRST. During connect `this.socket` is briefly assigned (for
    // the AUTH write) while the connection isn't yet AUTHed/ready, so a concurrent command must
    // await the connect promise — not take the socket fast path and race ahead of AUTH.
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    // Circuit breaker (L17): a recent connect/command failure means reconnecting right now would
    // very likely pay the full connect timeout again — per cache read, per render. Fail fast;
    // the handlers treat a rejected command as a cache miss. The window is short and only a
    // fresh attempt past it can close the breaker, so recovery needs no probe traffic.
    if (wallClockNow() < this.circuitOpenUntil) {
      return Promise.reject(
        new Error("Valkey circuit breaker open after a recent failure; failing fast"),
      );
    }
    // N76: the attempt's identity, so a failure reported for THIS attempt can be distinguished
    // from one reported for a socket that a later attempt has already replaced.
    const generation = ++this.generation;
    this.connecting = this.connect(generation).then(
      () => {
        this.connecting = undefined;
        this.circuitOpenUntil = 0;
      },
      (error: unknown) => {
        // Connect failures open the breaker even with an empty queue (see failAll).
        this.failAll(error instanceof Error ? error : new Error(String(error)), true, generation);
        throw error;
      },
    );
    return this.connecting;
  }

  // Queue a command and write it now. Requires an established socket (callers await ensureConnected).
  private write(args: Arg[]): Promise<Reply> {
    return new Promise<Reply>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error("Valkey not connected"));
        return;
      }
      const pending: Pending = { resolve, reject, timer: undefined };
      if (this.commandTimeoutMs > 0) {
        // N76: the timeout belongs to the connection this command was written on; a fresh
        // connection must not be torn down by a stale timer.
        const generation = this.generation;
        pending.timer = setTimeout(
          () => this.failAll(new Error("Valkey command timed out"), false, generation),
          this.commandTimeoutMs,
        );
        pending.timer.unref?.();
      }
      this.queue.push(pending);
      socket.write(encodeCommand(args));
    });
  }

  private async send(args: Arg[]): Promise<Reply> {
    await this.ensureConnected();
    return this.write(args);
  }

  async get(key: string): Promise<string | null> {
    const reply = await this.send(["GET", key]);
    if (reply === null) return null;
    // N74: assert the reply SHAPE instead of blind-casting. `(reply as Buffer).toString("utf8")`
    // turned an integer reply into `RangeError: toString() radix argument must be between 2 and 36`
    // (a nonsense error escaping the cache layer) and an array reply into the JOINED elements
    // (measured: `*2 a b` → `"a,b"`), i.e. fabricated entry bytes. A wrong-typed reply means the
    // key is not what this cache thinks it is (a WRONGTYPE-adjacent misconfiguration, or a desync)
    // — surface it as the protocol error it is and let the handler degrade to a miss.
    if (!Buffer.isBuffer(reply)) {
      throw new RespError(`GET returned a ${describeReply(reply)} reply; expected a bulk string`);
    }
    return reply.toString("utf8");
  }

  async set(key: string, value: string | Buffer, ...args: Arg[]): Promise<string | null> {
    const reply = await this.send(["SET", key, value, ...args]);
    return reply === null ? null : String(reply);
  }

  async del(...keys: string[]): Promise<number> {
    return Number(await this.send(["DEL", ...keys]));
  }

  async expire(key: string, seconds: number): Promise<number> {
    return Number(await this.send(["EXPIRE", key, seconds]));
  }

  async ttl(key: string): Promise<number> {
    return Number(await this.send(["TTL", key]));
  }

  async eval(script: string, numkeys: number, ...args: Arg[]): Promise<unknown> {
    return this.send(["EVAL", script, numkeys, ...args]);
  }

  async hmget(key: string, ...fields: string[]): Promise<(string | null)[]> {
    const reply = await this.send(["HMGET", key, ...fields]);
    // N74 (same class as `get`): assert the shape rather than blind-casting to `(Buffer|null)[]`.
    if (!Array.isArray(reply)) {
      throw new RespError(`HMGET returned a ${describeReply(reply)} reply; expected an array`);
    }
    return reply.map((value) => {
      if (value === null) return null;
      if (!Buffer.isBuffer(value)) {
        throw new RespError(
          `HMGET returned a ${describeReply(value)} element; expected a bulk string`,
        );
      }
      return value.toString("utf8");
    });
  }

  async hset(key: string, ...args: Arg[]): Promise<number> {
    return Number(await this.send(["HSET", key, ...args]));
  }

  async hgetallBuffer(key: string): Promise<Record<string, Buffer>> {
    const raw = await this.send(["HGETALL", key]);
    // N74: shape assertion before any element access (see `get`).
    if (!Array.isArray(raw) || raw.some((value) => !Buffer.isBuffer(value))) {
      throw new RespError(
        `HGETALL returned a ${describeReply(raw)} reply; expected an array of bulk strings`,
      );
    }
    const reply = raw as Buffer[];
    // HGETALL always returns field/value pairs; an odd length signals protocol corruption — surface
    // it rather than silently dropping the trailing element.
    if (reply.length % 2 !== 0)
      throw new RespError(`HGETALL returned an odd-length reply (${reply.length})`);
    // Null-prototype object (L4): a hash field literally named `__proto__` must be stored as data,
    // not silently mutate the result's prototype chain.
    const out: Record<string, Buffer> = Object.create(null);
    for (let i = 0; i + 1 < reply.length; i += 2) out[reply[i]!.toString("utf8")] = reply[i + 1]!;
    return out;
  }

  multi(): ValkeyMulti {
    return new RespMulti(this);
  }

  async quit(): Promise<void> {
    this.ended = true;
    try {
      if (this.socket && !this.socket.destroyed) await this.write(["QUIT"]);
    } catch {
      // best-effort graceful close
    }
    this.failAll(new Error("Valkey client closed"));
  }

  // --- internal, used by RespMulti to pipeline a transaction in guaranteed order ---
  _ensureConnected(): Promise<void> {
    return this.ensureConnected();
  }
  _write(args: Arg[]): Promise<Reply> {
    return this.write(args);
  }
}

/** Human-readable RESP type of an unexpected reply, for the N74 shape assertions. */
function describeReply(reply: Reply): string {
  if (reply === null) return "null";
  if (Buffer.isBuffer(reply)) return "bulk-string";
  if (Array.isArray(reply)) return `${reply.length}-element array`;
  if (reply instanceof RespError) return "error";
  return typeof reply === "number" ? "integer" : "simple-string";
}

let warnedClusterRedirect = false;

/**
 * N77: this client does NOT implement cluster redirection. Against a multi-shard deployment every
 * command for a non-local slot comes back as `-MOVED <slot> <host>:<port>` (or `-ASK` mid-migration),
 * which used to surface as a plain `RespError` — straight into the handlers' catch blocks, where it
 * degraded to a cache miss. The result was a cache that was 100% dead with no signal at all, for the
 * life of the deployment. The CLI provisions Memorystore for *Redis* (a single endpoint, so this
 * never fires there), but the failure has to be loud if anyone points `VALKEY_URL` at a cluster.
 *
 * "Loud" is the point of this function: the rejected command still fails open, but the operator gets
 * an unmistakable log line naming the actual cause instead of silence.
 */
function annotateRespError(error: RespError): RespError {
  const isRedirect = /^(MOVED|ASK) /.test(error.message);
  if (!isRedirect) return error;
  if (!warnedClusterRedirect) {
    warnedClusterRedirect = true;
    console.error(
      "[valkey-cache] Valkey replied " +
        `${error.message.split(" ")[0]} — the endpoint is a CLUSTER, and this client does not ` +
        "implement MOVED/ASK redirection. Every command for a non-local slot will fail and the " +
        "shared cache is effectively disabled. Point VALKEY_URL at a single-endpoint instance " +
        "(Memorystore for Redis, or a cluster's single-shard/proxy endpoint).",
    );
  }
  return new RespError(
    `${error.message} — cluster redirection is not supported by this client (see the log for details)`,
  );
}

let warnedPlaintextAuth = false;

/** One-time warning (L6): AUTH and every cached page cross the network unencrypted on redis://. */
function warnPlaintextAuthOnce(): void {
  if (warnedPlaintextAuth) return;
  warnedPlaintextAuth = true;
  console.warn(
    "[valkey-cache] a Valkey password is configured over a plaintext redis:// connection — " +
      "AUTH and all cache content cross the network in cleartext; use rediss:// (TLS) instead",
  );
}

let warnedDbIndex = false;

/** One-time warning (N4): a `redis://host/1`-style DB index in the URL is ignored by design. */
function warnDbIndexOnce(): void {
  if (warnedDbIndex) return;
  warnedDbIndex = true;
  console.warn(
    "[valkey-cache] a DB index in the Valkey URL (redis://host/<n>) is unsupported and ignored — " +
      "the cache keyspace is namespaced by build id and always uses DB 0",
  );
}

class RespMulti implements ValkeyMulti {
  private readonly commands: Arg[][] = [];
  constructor(private readonly client: RespClient) {}

  hset(key: string, ...args: Arg[]): this {
    this.commands.push(["HSET", key, ...args]);
    return this;
  }

  expire(key: string, seconds: number): this {
    this.commands.push(["EXPIRE", key, seconds]);
    return this;
  }

  async exec(): Promise<unknown[]> {
    // Connect first, then dispatch MULTI / commands / EXEC synchronously so they're written in
    // order on the wire (RESP replies come back FIFO; only the EXEC result matters to callers).
    await this.client._ensureConnected();
    const replies = await Promise.all([
      this.client._write(["MULTI"]),
      ...this.commands.map((command) => this.client._write(command)),
      this.client._write(["EXEC"]),
    ]);
    const exec = replies[replies.length - 1];
    // N75: a NULL EXEC reply (`*-1`) means the transaction was DISCARDED — nothing ran. The old
    // `?? []` turned it into an empty array, which the V2 handler's `results.find(...)` read as
    // "no per-command failure", i.e. a successful write of an entry that was never stored.
    // (Only WATCH produces this today, and this client never sends WATCH — but the whole point of
    // the H4 per-command inspection is not to assume a transaction applied.)
    if (exec === null || exec === undefined) {
      throw new RespError(
        "EXEC returned a null reply: the MULTI transaction was discarded and NOTHING was applied",
      );
    }
    if (!Array.isArray(exec)) {
      throw new RespError(`EXEC returned a ${describeReply(exec)} reply; expected an array`);
    }
    return exec;
  }
}

export function createRespClient(options: RespClientOptions): ValkeyClient {
  return new RespClient(options);
}
