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
  if (lineEnd === -1) return { need: buf.length + 1 };
  const after = lineEnd + 2;
  switch (type) {
    case 0x2b: // '+' simple string
    case 0x2d: // '-' error
    case 0x3a: // ':' integer
      return { end: after };
    case 0x24: {
      // '$' bulk string
      const len = Number(buf.toString("utf8", offset + 1, lineEnd));
      if (!Number.isInteger(len) || len < -1) {
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
      const count = Number(buf.toString("utf8", offset + 1, lineEnd));
      if (!Number.isInteger(count) || count < -1) {
        throw new RespError(
          `RESP protocol error: invalid array count ${JSON.stringify(buf.toString("utf8", offset + 1, lineEnd))}`,
        );
      }
      if (count === -1) return { end: after };
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
  private readonly url: string;
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
    this.url = options.url;
    this.password = options.password;
    this.caCert = options.caCert;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
    this.circuitBreakerMs = options.circuitBreakerMs ?? DEFAULT_CIRCUIT_BREAKER_MS;
    this.maxReplyBytes = options.maxReplyBytes ?? DEFAULT_MAX_REPLY_BYTES;
    this.maxBufferedBytes = this.maxReplyBytes * MAX_BUFFERED_FACTOR;
  }

  private onData(chunk: Buffer): void {
    this.inboundChunks.push(chunk);
    this.inboundBytes += chunk.length;
    if (this.inboundBytes > this.maxBufferedBytes) {
      // Unbounded buffering is a memory-exhaustion vector (M6b); bail out exactly like a socket
      // error: destroy the connection and fail every in-flight command.
      this.failAll(
        new RespError(
          `Valkey reply buffer grew past ${this.maxBufferedBytes} bytes; destroying connection`,
        ),
      );
      return;
    }
    this.drainInbound();
  }

  // Emit every complete reply frame the inbound buffer currently holds. The expensive path — a
  // large reply arriving in many TCP chunks — copies each byte exactly once: the header scan
  // learns the frame size up front, intermediate chunks are only appended to the chunk list,
  // and a single concat happens when the last chunk lands.
  private drainInbound(): void {
    while (this.queue.length > 0) {
      if (this.inboundBytes < this.neededBytes) return; // head frame known-incomplete: wait cheaply
      const buf = this.flattenInbound();
      let scan: { end: number } | { need: number };
      try {
        scan = scanFrameEnd(buf, 0, this.maxReplyBytes);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new RespError(String(error)));
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
        this.failAll(new RespError("RESP protocol error: frame scanner/parser disagree"));
        return;
      }
      this.consumeInbound(parsed[1]);
      const pending = this.queue.shift()!;
      if (pending.timer) clearTimeout(pending.timer);
      const value = parsed[0];
      if (value instanceof RespError) pending.reject(value);
      else pending.resolve(value);
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
  private failAll(error: Error, fromConnectFailure = false): void {
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

  private async connect(): Promise<void> {
    const parsed = new URL(this.url);
    // N7: `URL.hostname` keeps the brackets on an IPv6 literal (`redis://[::1]:6379` →
    // `"[::1]"`). Unbracketed, `net.isIP` recognizes it (so the L18 SNI skip below applies)
    // and `net.connect` gets a connectable address instead of resolving `"[::1]"` as a DNS name.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const port = parsed.port ? Number(parsed.port) : 6379;
    const useTls = parsed.protocol === "rediss:";
    // Honor URL userinfo (`redis://:secret@host`) when no explicit password is configured (L6) —
    // it was previously parsed and silently dropped, which surfaced as a permanent NOAUTH.
    let userinfoPassword: string | undefined;
    if (parsed.password) {
      try {
        userinfoPassword = decodeURIComponent(parsed.password);
      } catch {
        userinfoPassword = parsed.password; // malformed percent-encoding: use it verbatim
      }
    }
    // N3: the userinfo USERNAME (`redis://user:pass@host`) selects the ACL identity — it was
    // previously dropped, so ACL-user deployments AUTHed as `default` and got NOAUTH.
    let userinfoUsername: string | undefined;
    if (parsed.username) {
      try {
        userinfoUsername = decodeURIComponent(parsed.username);
      } catch {
        userinfoUsername = parsed.username; // malformed percent-encoding: use it verbatim
      }
    }
    // N4: a DB index in the URL path (`redis://host/1`) is silently ignored by design — the
    // cache keyspace is namespaced by build id, so everything lives in DB 0. Warn once rather
    // than dropping it silently (SELECT is deliberately unimplemented: multi-DB is deprecated
    // upstream and the build-id namespace already provides the wanted isolation).
    if (parsed.pathname && parsed.pathname !== "/") warnDbIndexOnce();
    const password = this.password ?? userinfoPassword;
    if (password && !useTls) warnPlaintextAuthOnce();

    // Lazy dynamic import keeps `node:net`/`node:tls` out of module eval (edge-eval-safe).
    // With a configured CA (Memorystore in-transit encryption), pin verification to it — its
    // CA is not publicly rooted, so the default trust store would reject the handshake.
    const net = await import("node:net");
    const socket: Socket | TLSSocket = useTls
      ? (await import("node:tls")).connect({
          host,
          port,
          // L18: SNI is a DNS-name extension — Node THROWS (ERR_INVALID_ARG_VALUE) when
          // `servername` is an IP literal, which made `rediss://<ip>` (e.g. a Memorystore
          // VPC endpoint) unconnectable. Skip SNI for IP hosts; certificate verification
          // still runs, matched against the cert's IP subjectAltName.
          ...(net.isIP(host) ? {} : { servername: host }),
          ...(this.caCert ? { ca: this.caCert } : {}),
        })
      : net.connect({ host, port });
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => this.onData(chunk));

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
    socket.on("error", (error: Error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("Valkey connection closed")));

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
    this.connecting = this.connect().then(
      () => {
        this.connecting = undefined;
        this.circuitOpenUntil = 0;
      },
      (error: unknown) => {
        // Connect failures open the breaker even with an empty queue (see failAll).
        this.failAll(error instanceof Error ? error : new Error(String(error)), true);
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
        pending.timer = setTimeout(
          () => this.failAll(new Error("Valkey command timed out")),
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
    return reply === null ? null : (reply as Buffer).toString("utf8");
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
    const reply = (await this.send(["HMGET", key, ...fields])) as (Buffer | null)[];
    return reply.map((value) => (value === null ? null : value.toString("utf8")));
  }

  async hset(key: string, ...args: Arg[]): Promise<number> {
    return Number(await this.send(["HSET", key, ...args]));
  }

  async hgetallBuffer(key: string): Promise<Record<string, Buffer>> {
    const reply = (await this.send(["HGETALL", key])) as Buffer[];
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
    return (replies[replies.length - 1] as unknown[]) ?? [];
  }
}

export function createRespClient(options: RespClientOptions): ValkeyClient {
  return new RespClient(options);
}
