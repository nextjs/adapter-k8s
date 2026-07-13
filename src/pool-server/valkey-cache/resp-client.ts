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
  /** `redis://host:port` or `rediss://host:port` (TLS). */
  url: string;
  /** AUTH string, sent before any command. */
  password?: string | undefined;
  /** Reject (and drop the socket) if a command has no reply within this window. 0 disables. */
  commandTimeoutMs?: number;
  /** Reject if the TCP/TLS connection isn't established within this window (a blackholed endpoint
   * has no connect timeout of its own and would otherwise hang the first command's render). */
  connectTimeoutMs?: number;
}

const CRLF = Buffer.from("\r\n");

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
// prefix, so binary values containing CRLF parse correctly.
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

class RespClient implements ValkeyClient {
  private socket: Socket | TLSSocket | undefined;
  private connecting: Promise<void> | undefined;
  private inbound: Buffer = Buffer.alloc(0);
  private readonly queue: Pending[] = [];
  private ended = false;
  private readonly url: string;
  private readonly password: string | undefined;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(options: RespClientOptions) {
    this.url = options.url;
    this.password = options.password;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  }

  private onData(chunk: Buffer): void {
    this.inbound = this.inbound.length ? Buffer.concat([this.inbound, chunk]) : chunk;
    while (this.queue.length) {
      const parsed = parseReply(this.inbound, 0);
      if (!parsed) break;
      this.inbound = this.inbound.subarray(parsed[1]);
      const pending = this.queue.shift()!;
      if (pending.timer) clearTimeout(pending.timer);
      const value = parsed[0];
      if (value instanceof RespError) pending.reject(value);
      else pending.resolve(value);
    }
  }

  // Tear down the socket and fail every in-flight command. Called on socket error/close and on a
  // command timeout — destroying is deliberate: a late reply after we've shifted the queue would
  // map to the wrong caller, so we resync from a clean slate and let the next command reconnect.
  private failAll(error: Error): void {
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = undefined;
    this.inbound = Buffer.alloc(0);
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
    const host = parsed.hostname;
    const port = parsed.port ? Number(parsed.port) : 6379;
    const useTls = parsed.protocol === "rediss:";
    // Lazy dynamic import keeps `node:net`/`node:tls` out of module eval (edge-eval-safe).
    const socket: Socket | TLSSocket = useTls
      ? (await import("node:tls")).connect({ host, port, servername: host })
      : (await import("node:net")).connect({ host, port });
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
    // commands) until AUTH's reply lands; its own command timeout bounds it.
    if (this.password) await this.write(["AUTH", this.password]);
  }

  private ensureConnected(): Promise<void> {
    if (this.ended) return Promise.reject(new Error("Valkey client closed"));
    // Gate on an in-progress connect FIRST. During connect `this.socket` is briefly assigned (for
    // the AUTH write) while the connection isn't yet AUTHed/ready, so a concurrent command must
    // await the connect promise — not take the socket fast path and race ahead of AUTH.
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    this.connecting = this.connect().then(
      () => {
        this.connecting = undefined;
      },
      (error: unknown) => {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
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
    const out: Record<string, Buffer> = {};
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
