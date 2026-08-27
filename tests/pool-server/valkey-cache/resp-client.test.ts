import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRespClient, RespError } from "../../../src/pool-server/valkey-cache/resp-client.js";

// Unit tests for the RESP2 client against an in-process fake server (no Docker needed): raw
// scripted bytes give exact control over reply framing, so these exercise the inbound
// reassembly path (M6b), the reply-size caps, protocol validation (L8), URL userinfo AUTH and
// the plaintext warning (L6), and prototype-pollution safety in hgetallBuffer (L4).

/** Parse one RESP2 command (array of bulk strings) from the head of `buf`. */
function parseCommand(buf: Buffer): { args: string[]; consumed: number } | null {
  if (buf.length === 0 || buf[0] !== 0x2a) return null;
  const lineEnd = buf.indexOf("\r\n");
  if (lineEnd === -1) return null;
  const count = Number(buf.toString("utf8", 1, lineEnd));
  if (!Number.isInteger(count) || count < 1) return null;
  let cursor = lineEnd + 2;
  const args: string[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor >= buf.length || buf[cursor] !== 0x24) return null;
    const le = buf.indexOf("\r\n", cursor);
    if (le === -1) return null;
    const len = Number(buf.toString("utf8", cursor + 1, le));
    const start = le + 2;
    if (!Number.isInteger(len) || len < 0 || start + len + 2 > buf.length) return null;
    args.push(buf.toString("utf8", start, start + len));
    cursor = start + len + 2;
  }
  return { args, consumed: cursor };
}

interface FakeServer {
  url: string;
  port: number;
  /** Every command the server has parsed, in arrival order (decoded as strings). */
  commands: string[][];
  /** Connections that carried at least one complete RESP command. Ambient localhost probes may
   * connect to a random test port, but they cannot manufacture the client's command stream. */
  commandConnectionCount: () => number;
  close: () => Promise<void>;
}

/**
 * Start a fake Valkey server. `respond` maps a decoded command to raw reply bytes (an array of
 * chunks to simulate fragmentation — chunks are written on separate event-loop ticks so they
 * arrive as separate TCP segments) or null (no reply at all); it also receives the server-side
 * socket so a test can end the connection at a chosen moment (idle-reap simulation, N7). With
 * `tlsOpts`, the server only speaks TLS and the returned URL uses `rediss://`. `host` selects
 * the bind address (e.g. `"::1"` for IPv6 loopback — bracketed in the returned URL).
 */
function startFakeValkey(
  respond: (cmd: string[], socket: net.Socket) => Buffer[] | null,
  tlsOpts?: { key: string; cert: string },
  host = "127.0.0.1",
): Promise<FakeServer> {
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();
  const commandSockets = new Set<net.Socket>();
  const onConnection = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) break;
        commandSockets.add(socket);
        commands.push(parsed.args);
        buf = buf.subarray(parsed.consumed);
        const reply = respond(parsed.args, socket);
        if (reply) {
          // Trickle chunks on separate ticks so large replies actually arrive fragmented.
          let i = 0;
          const tick = () => {
            if (socket.destroyed || i >= reply.length) return;
            socket.write(reply[i++]!, tick);
          };
          tick();
        }
      }
    });
  };
  const server = tlsOpts
    ? tls.createServer({ key: tlsOpts.key, cert: tlsOpts.cert }, onConnection)
    : net.createServer(onConnection);
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      const urlHost = host.includes(":") ? `[${host}]` : host;
      resolve({
        url: `${tlsOpts ? "rediss" : "redis"}://${urlHost}:${port}`,
        port,
        commands,
        commandConnectionCount: () => commandSockets.size,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

const ok = () => [Buffer.from("+OK\r\n")];
const bulk = (value: string | null) => [
  Buffer.from(value === null ? "$-1\r\n" : `$${Buffer.byteLength(value)}\r\n${value}\r\n`),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether this environment can bind IPv6 loopback (gates the `redis://[::1]` literal test). */
const hasIpv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = net.createServer();
  probe.once("error", () => resolve(false));
  probe.listen(0, "::1", () => probe.close(() => resolve(true)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inbound reassembly (M6b)", () => {
  it("reassembles a large bulk string arriving in many small chunks", async () => {
    // Patterned (not uniform) payload so an ordering/offset bug changes the bytes.
    const body = Buffer.alloc(400_000);
    for (let i = 0; i < body.length; i++) body[i] = 65 + (i % 26);
    const frame = Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")]);
    const chunks: Buffer[] = [];
    for (let i = 0; i < frame.length; i += 8_192) chunks.push(frame.subarray(i, i + 8_192));
    const server = await startFakeValkey(() => chunks);
    const client = createRespClient({ url: server.url });
    try {
      const got = await client.get("big");
      expect(got).toBe(body.toString("utf8"));
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("emits multiple pipelined replies from a single TCP chunk", async () => {
    const server = await startFakeValkey((cmd) => {
      if (cmd[0] === "GET") return bulk(`v-${cmd[1]}`);
      return ok();
    });
    const client = createRespClient({ url: server.url });
    try {
      const [a, b, c] = await Promise.all([client.get("a"), client.get("b"), client.get("c")]);
      expect([a, b, c]).toEqual(["v-a", "v-b", "v-c"]);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("parses every reply type: simple string, integer, null bulk, null array", async () => {
    const server = await startFakeValkey((cmd) => {
      switch (cmd[0]) {
        case "SET":
          return ok();
        case "GET":
          return bulk(null);
        case "TTL":
          return [Buffer.from(":42\r\n")];
        case "EVAL":
          return [Buffer.from("*-1\r\n")];
        default:
          return ok();
      }
    });
    const client = createRespClient({ url: server.url });
    try {
      expect(await client.set("k", "v")).toBe("OK");
      expect(await client.get("k")).toBeNull();
      expect(await client.ttl("k")).toBe(42);
      expect(await client.eval("return nil", 0)).toBeNull();
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("reply size caps (M6b) and protocol validation (L8)", () => {
  it("fails all commands when a bulk advertises more than the 64 MiB frame cap", async () => {
    const server = await startFakeValkey(() => [Buffer.from("$70000000\r\n")]); // header only
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/exceeds the .* cap/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("honors a custom maxReplyBytes", async () => {
    const server = await startFakeValkey(() => [Buffer.from("$2048\r\n")]);
    const client = createRespClient({ url: server.url, maxReplyBytes: 1024 });
    try {
      await expect(client.get("k")).rejects.toThrow(/exceeds the 1024-byte cap/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("fails all commands on a NaN bulk length (never desyncs the queue)", async () => {
    const server = await startFakeValkey(() => [Buffer.from("$notanumber\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/invalid bulk length/);
      // The connection was destroyed; a fresh command reconnects rather than reading garbage.
      expect(server.commands).toEqual([["GET", "k"]]);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("fails all commands on a NaN array count", async () => {
    const server = await startFakeValkey(() => [Buffer.from("*x\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/invalid array count/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("fails all commands on an out-of-range negative length (< -1)", async () => {
    const server = await startFakeValkey(() => [Buffer.from("$-5\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/invalid bulk length/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("fails all commands on pathologically deep array nesting (no stack overflow)", async () => {
    // Real Valkey replies nest ≤3 levels; `*1\r\n` × 100 is a hostile endpoint probing
    // the recursive frame scanner. The depth cap must turn it into a protocol error.
    const server = await startFakeValkey(() => [Buffer.from("*1\r\n".repeat(100))]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/nested past 32 levels/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("fails all commands on an unknown type byte", async () => {
    const server = await startFakeValkey(() => [Buffer.from("!bogus\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/unknown type byte/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("a RespError reply rejects that command but keeps the connection usable", async () => {
    const server = await startFakeValkey((cmd) =>
      cmd[1] === "bad" ? [Buffer.from("-WRONGTYPE nope\r\n")] : bulk("fine"),
    );
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("bad")).rejects.toBeInstanceOf(RespError);
      expect(await client.get("good")).toBe("fine");
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N71: an unsolicited reply frame is a protocol violation, never a queue shift", () => {
  // Pre-fix, `drainInbound` only looped `while (queue.length > 0)`, so bytes that arrived with an
  // empty queue were silently RETAINED and shifted every later reply by one frame for the life of
  // the socket. Probed against the pre-fix client with a server that pushes `+UNSOLICITED\r\n`:
  //   [idle-push]     GET keyA -> "AAAA-value"   GET keyB -> "UNSOLICITED"
  //   [double-frame]  GET keyA -> "AAAA-value"   GET keyB -> "UNSOLICITED"
  // i.e. one key's bytes served under another key — and undetectable by `parseStoredMeta`, because
  // the bytes are a well-formed entry, just the wrong one. RESP2 has no legal push path here.

  const store: Record<string, string> = { keyA: "AAAA-value", keyB: "BBBB-value" };
  const reply = (key: string) => {
    const v = store[key];
    return v === undefined ? "$-1\r\n" : `$${v.length}\r\n${v}\r\n`;
  };

  it("drops the connection when bytes arrive while the client is IDLE", async () => {
    let pushed = false;
    const server = await startFakeValkey((cmd, socket) => {
      if (!pushed) {
        pushed = true;
        // Push an extra frame shortly AFTER this reply lands, with the queue empty.
        setTimeout(() => {
          if (!socket.destroyed) socket.write("+UNSOLICITED\r\n");
        }, 40);
      }
      return [Buffer.from(reply(cmd[1]!))];
    });
    // circuitBreakerMs: 0 so the next command reconnects immediately and we observe the RESYNC,
    // not a breaker rejection.
    const client = createRespClient({ url: server.url, circuitBreakerMs: 0 });
    try {
      expect(await client.get("keyA")).toBe("AAAA-value");
      await sleep(120); // let the unsolicited frame arrive and tear the connection down
      // The critical assertion: keyB gets KEY B's value, from a fresh connection.
      expect(await client.get("keyB")).toBe("BBBB-value");
      expect(server.commandConnectionCount()).toBe(2);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("drops the connection when an extra frame rides along in the same write", async () => {
    let first = true;
    const server = await startFakeValkey((cmd) => {
      const bytes = reply(cmd[1]!) + (first ? "+UNSOLICITED\r\n" : "");
      first = false;
      return [Buffer.from(bytes)];
    });
    const client = createRespClient({ url: server.url, circuitBreakerMs: 0 });
    try {
      expect(await client.get("keyA")).toBe("AAAA-value");
      await sleep(20);
      expect(await client.get("keyB")).toBe("BBBB-value");
      expect(server.commandConnectionCount()).toBe(2);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("rejects the in-flight command with a protocol error when the extra frame precedes it", async () => {
    // Same violation observed from the other side: the client has a command in flight when the
    // stray frame lands, so the frame is attributed to it and the SHAPE assertion catches it
    // (a `+simple-string` is not a valid GET reply).
    const server = await startFakeValkey(() => [Buffer.from("+UNSOLICITED\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("keyA")).rejects.toThrow(/expected a bulk string/);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N72: header/inline lines are bounded and inline frames obey the reply cap", () => {
  it("fails fast on an unterminated inline line instead of buffering quadratically", async () => {
    // A '+' with no CRLF, ever. Pre-fix `scanFrameEnd` returned `need = buf.length + 1`, so every
    // 64 KiB chunk re-`Buffer.concat`ed the whole backlog until `maxBufferedBytes` (4x the frame
    // cap). Measured pre-fix, fail-time vs frame cap: 2 MiB → 116 ms, 4 → 473, 8 → 2084,
    // 16 → 8844, and at the 64 MiB DEFAULT cap 164_197 ms with 884 MiB peak RSS — an OOMKill
    // rather than a protocol error. Post-fix it is ~2 ms at every cap.
    const filler = Buffer.alloc(64 * 1024, 0x41);
    const server = await startFakeValkey((_cmd, socket) => {
      const pump = () => {
        if (socket.destroyed) return;
        if (socket.write(filler)) setImmediate(pump);
        else socket.once("drain", pump);
      };
      socket.write("+", () => pump());
      return null;
    });
    // Deliberately the DEFAULT 64 MiB frame cap — the configuration whose pre-fix failure took
    // 164 seconds. A generous 5s bound still discriminates by ~30x.
    const client = createRespClient({ url: server.url, commandTimeoutMs: 0 });
    try {
      const started = Date.now();
      await expect(client.get("k")).rejects.toThrow(/no CRLF within 8192 bytes/);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await client.quit();
      await server.close();
    }
  }, 20_000);

  it("counts an inline reply against maxReplyBytes (it used to be exempt)", async () => {
    const line = `+${"A".repeat(2048)}\r\n`;
    const server = await startFakeValkey(() => [Buffer.from(line)]);
    const client = createRespClient({ url: server.url, maxReplyBytes: 1024 });
    try {
      await expect(client.get("k")).rejects.toThrow(/inline reply of \d+ bytes exceeds the 1024/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("still accepts a normal short inline reply", async () => {
    const server = await startFakeValkey(() => ok());
    const client = createRespClient({ url: server.url });
    try {
      expect(await client.set("k", "v")).toBe("OK");
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N73: lengths and counts must be plain decimal integers", () => {
  // Measured pre-fix: `Number.isInteger(Number(line))` accepted `$0x10` (a 16-byte read),
  // `$1e1` (10 bytes), `$3.0`, `$ 3` and `$+3` (3 bytes each). No desync followed — the scanner
  // and parser share the coercion, and the `parsed[1] !== scan.end` cross-check catches drift —
  // but an untrusted stream is only trustworthy while it is EXACTLY RESP2.
  it.each([
    ["$0x10", /invalid bulk length "0x10"/],
    ["$1e1", /invalid bulk length "1e1"/],
    ["$3.0", /invalid bulk length "3\.0"/],
    ["$ 3", /invalid bulk length " 3"/],
    ["$+3", /invalid bulk length "\+3"/],
    ["*0x2", /invalid array count "0x2"/],
    ["*2.0", /invalid array count "2\.0"/],
  ])("rejects %s", async (header, message) => {
    const server = await startFakeValkey(() => [
      Buffer.concat([Buffer.from(`${header}\r\n`), Buffer.alloc(32, 0x7a), Buffer.from("\r\n")]),
    ]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(message);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("still accepts canonical decimal forms, including the RESP nulls", async () => {
    const server = await startFakeValkey((cmd) => {
      if (cmd[0] === "GET") return bulk("abc");
      if (cmd[0] === "TTL") return [Buffer.from(":-1\r\n")];
      if (cmd[0] === "EVAL") return [Buffer.from("*-1\r\n")];
      return [Buffer.from("$-1\r\n")];
    });
    const client = createRespClient({ url: server.url });
    try {
      expect(await client.get("k")).toBe("abc");
      expect(await client.ttl("k")).toBe(-1);
      expect(await client.eval("return nil", 0)).toBeNull();
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N74: reply shapes are asserted, never blind-cast", () => {
  it("an integer reply to GET is a protocol error, not a RangeError", async () => {
    // Pre-fix: `(reply as Buffer).toString("utf8")` on a number →
    // `RangeError: toString() radix argument must be between 2 and 36`, escaping the cache layer.
    const server = await startFakeValkey(() => [Buffer.from(":42\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(RespError);
      await expect(client.get("k")).rejects.toThrow(/integer reply; expected a bulk string/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("an array reply to GET does NOT silently become the joined elements", async () => {
    // Pre-fix this returned `"a,b"` — fabricated entry bytes for whatever key was read.
    const server = await startFakeValkey(() => [Buffer.from("*2\r\n$1\r\na\r\n$1\r\nb\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/2-element array reply; expected a bulk/);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("HMGET and HGETALL assert their array shape too", async () => {
    const server = await startFakeValkey((cmd) =>
      cmd[0] === "HMGET" ? [Buffer.from(":7\r\n")] : [Buffer.from("+OK\r\n")],
    );
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.hmget("h", "f")).rejects.toThrow(/expected an array/);
      await expect(client.hgetallBuffer("h")).rejects.toThrow(/expected an array of bulk strings/);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N75: a null EXEC reply is a failed transaction, not an empty success", () => {
  it("throws instead of reporting an applied write", async () => {
    // `*-1` for EXEC means the transaction was DISCARDED. Pre-fix `?? []` turned that into an
    // empty array, which the V2 handler's per-command failure scan read as success — so an entry
    // that was never stored was reported as cached.
    const server = await startFakeValkey((cmd) =>
      cmd[0] === "EXEC" ? [Buffer.from("*-1\r\n")] : ok(),
    );
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.multi().hset("h", "f", "v").expire("h", 60).exec()).rejects.toThrow(
        /transaction was discarded and NOTHING was applied/,
      );
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("a normal EXEC still returns the per-command replies (H4 inspection)", async () => {
    const server = await startFakeValkey((cmd) =>
      cmd[0] === "EXEC" ? [Buffer.from("*2\r\n:1\r\n-ERR nope\r\n")] : ok(),
    );
    const client = createRespClient({ url: server.url });
    try {
      const results = await client.multi().hset("h", "f", "v").expire("h", 60).exec();
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(1);
      expect(results[1]).toBeInstanceOf(RespError);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N70 (SECURITY): a URL parse failure never carries the URL", () => {
  it("rejects with a redacted message, and the rejection has no `input` property", async () => {
    // `new URL(bad)` throws a TypeError with `code: 'ERR_INVALID_URL'` AND the raw input attached
    // as `.input`. `logErrorRateLimited(..., error)` → `console.error(msg, error)` inspects own
    // properties, so a password in the URL reached the pod log — and again every breaker cycle.
    // Measured pre-fix:
    //   TypeError: Invalid URL {"code":"ERR_INVALID_URL","input":"redis://:sup3rs3cret@bad host:6379"}
    const secret = "sup3rs3cret";
    const client = createRespClient({ url: `redis://:${secret}@bad host:6379` });
    try {
      const error = await client.get("k").then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error).toBeDefined();
      expect(error!.message).toBe("invalid Valkey URL (redacted)");
      // Nothing enumerable, nothing inspectable, no `.input`.
      expect(JSON.stringify(error)).toBe("{}");
      expect((error as unknown as { input?: string }).input).toBeUndefined();
      const dumped = `${error!.message} ${JSON.stringify(Object.getOwnPropertyNames(error))} ${JSON.stringify(error)}`;
      expect(dumped).not.toContain(secret);
    } finally {
      await client.quit();
    }
  });

  it("also redacts a rejected scheme and an out-of-range port", async () => {
    for (const url of ["http://:s3cret@127.0.0.1:6379", "redis://:s3cret@127.0.0.1:99999"]) {
      const client = createRespClient({ url });
      try {
        await expect(client.get("k")).rejects.toThrow(/^invalid Valkey URL \(redacted\)$/);
      } finally {
        await client.quit();
      }
    }
  });

  it("a valid URL still works (the parse moved to the constructor, N70)", async () => {
    const server = await startFakeValkey(() => bulk("v"));
    const client = createRespClient({ url: server.url });
    try {
      expect(await client.get("k")).toBe("v");
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N77: a cluster MOVED/ASK reply fails LOUDLY", () => {
  it("logs once per process and rejects with an explanatory error", async () => {
    // Pre-fix a `-MOVED` was a plain RespError straight into the handlers' silent catches, so a
    // cluster endpoint produced a 100%-dead cache with no signal at all.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = await startFakeValkey(() => [Buffer.from("-MOVED 3999 127.0.0.1:6381\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/cluster redirection is not supported/);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/CLUSTER/);
      expect(String(error.mock.calls[0]?.[0])).toMatch(/MOVED/);
      // Once per process, not per command.
      await expect(client.get("k")).rejects.toThrow(/cluster redirection is not supported/);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("an ordinary error reply is passed through untouched", async () => {
    const server = await startFakeValkey(() => [Buffer.from("-WRONGTYPE nope\r\n")]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("k")).rejects.toThrow(/^WRONGTYPE nope$/);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("AUTH via URL userinfo + plaintext warning (L6)", () => {
  it("honors `redis://:pass@host` userinfo when no explicit password is given, warning once", async () => {
    const server = await startFakeValkey((cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createRespClient({ url: `redis://:s3cret@127.0.0.1:${server.port}` });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands[0]).toEqual(["AUTH", "s3cret"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/cleartext/);

      // An explicit password wins over userinfo, and the plaintext warning stays once-per-process.
      const explicit = createRespClient({
        url: `redis://:wrong@127.0.0.1:${server.port}`,
        password: "right",
      });
      try {
        expect(await explicit.get("k")).toBe("v");
        const auths = server.commands.filter((c) => c[0] === "AUTH");
        expect(auths).toEqual([
          ["AUTH", "s3cret"],
          ["AUTH", "right"],
        ]);
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        await explicit.quit();
      }

      // Percent-encoded userinfo is decoded.
      const encoded = createRespClient({ url: `redis://:p%40ss@127.0.0.1:${server.port}` });
      try {
        await encoded.get("k");
        expect(server.commands.filter((c) => c[0] === "AUTH").at(-1)).toEqual(["AUTH", "p@ss"]);
      } finally {
        await encoded.quit();
      }
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("sends no AUTH and warns nothing when no password is configured anywhere", async () => {
    const server = await startFakeValkey(() => bulk("v"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createRespClient({ url: server.url });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands).toEqual([["GET", "k"]]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("hgetallBuffer (L4: prototype pollution)", () => {
  it("stores a `__proto__` FIELD as data on a null-prototype result", async () => {
    const server = await startFakeValkey(() => [
      Buffer.from("*2\r\n$9\r\n__proto__\r\n$5\r\nvalue\r\n"),
    ]);
    const client = createRespClient({ url: server.url });
    try {
      const result = await client.hgetallBuffer("h");
      expect(Object.getPrototypeOf(result)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
      expect(result["__proto__"]?.toString("utf8")).toBe("value");
      // The global object prototype was not polluted.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N3: ACL-username AUTH (redis://user:pass@host)", () => {
  it("sends the two-argument ACL form when the URL carries a username", async () => {
    const server = await startFakeValkey((cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createRespClient({ url: `redis://acluser:aclsecret@127.0.0.1:${server.port}` });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands[0]).toEqual(["AUTH", "acluser", "aclsecret"]);
      expect(server.commands[1]).toEqual(["GET", "k"]);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("decodes a percent-encoded username, and an explicit password keeps the URL username", async () => {
    const server = await startFakeValkey((cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const encoded = createRespClient({
      url: `redis://cache%2Dwriter:p%40ss@127.0.0.1:${server.port}`,
    });
    try {
      await encoded.get("k");
      expect(server.commands[0]).toEqual(["AUTH", "cache-writer", "p@ss"]);
    } finally {
      await encoded.quit();
    }
    // Explicit `password` replaces only the PASSWORD; the ACL username still comes from the URL.
    const explicit = createRespClient({
      url: `redis://acluser:wrong@127.0.0.1:${server.port}`,
      password: "right",
    });
    try {
      await explicit.get("k");
      expect(server.commands.filter((c) => c[0] === "AUTH").at(-1)).toEqual([
        "AUTH",
        "acluser",
        "right",
      ]);
    } finally {
      await explicit.quit();
      await server.close();
    }
  });
});

describe("N4: a DB index in the URL is warned about and ignored (no SELECT)", () => {
  it("warns once and never sends SELECT for redis://host/2", async () => {
    const server = await startFakeValkey(() => bulk("v"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createRespClient({ url: `redis://127.0.0.1:${server.port}/2` });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands).toEqual([["GET", "k"]]); // no SELECT, no surprise commands
      const dbWarnings = warn.mock.calls.filter((c) => /DB index/.test(String(c[0])));
      expect(dbWarnings).toHaveLength(1);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("N7: IPv6 literal hosts (redis://[::1]:port)", () => {
  it.skipIf(!hasIpv6Loopback)(
    "strips the URL brackets so net.connect gets an address, not a bogus DNS name",
    async () => {
      // `new URL("redis://[::1]:p").hostname` is `"[::1]"` — passing that to net.connect fails
      // DNS resolution, and `net.isIP("[::1]")` is 0 so the L18 SNI skip misfires for rediss.
      // A successful round-trip over IPv6 loopback proves the brackets were stripped.
      const server = await startFakeValkey(() => bulk("v6"), undefined, "::1");
      const client = createRespClient({ url: `redis://[::1]:${server.port}` });
      try {
        expect(server.url).toBe(`redis://[::1]:${server.port}`);
        expect(await client.get("k")).toBe("v6");
        expect(server.commands).toEqual([["GET", "k"]]);
      } finally {
        await client.quit();
        await server.close();
      }
    },
  );
});

describe("N7: username-only userinfo (ACL nopass user)", () => {
  it("sends the ACL form with an empty password for redis://user@host", async () => {
    // Pre-fix, the `if (password)` gate dropped the username entirely and sent NO AUTH, so an
    // ACL `nopass` user silently ran as `default`. The ACL AUTH form accepts an empty-string
    // password for nopass users.
    const server = await startFakeValkey((cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")));
    const client = createRespClient({ url: `redis://nopassuser@127.0.0.1:${server.port}` });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands[0]).toEqual(["AUTH", "nopassuser", ""]);
      expect(server.commands[1]).toEqual(["GET", "k"]);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("an explicit password still pairs with a username-only URL (ACL form)", async () => {
    const server = await startFakeValkey((cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")));
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // plaintext-auth warning
    const client = createRespClient({
      url: `redis://acluser@127.0.0.1:${server.port}`,
      password: "s3cret",
    });
    try {
      expect(await client.get("k")).toBe("v");
      expect(server.commands[0]).toEqual(["AUTH", "acluser", "s3cret"]);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("L17: circuit breaker after a failure (fail fast, probe later)", () => {
  // The fail-fast tests use a breaker window far larger than any plausible CI event-loop stall
  // (60s): the assertions are the /circuit breaker/ rejection message plus an UNCHANGED server
  // connection count — not wall-clock elapsed — so a loaded machine can't expire the window
  // mid-test and flake them. Recovery is tested separately with a tiny window and a sleep with
  // a generous margin past it.

  it("a command failure opens the breaker: later commands fail fast WITHOUT reconnecting", async () => {
    const server = await startFakeValkey(
      (cmd) => (cmd[1] === "hang" ? null : bulk("v")), // "hang" never gets a reply
    );
    const client = createRespClient({
      url: server.url,
      commandTimeoutMs: 100,
      connectTimeoutMs: 200,
      circuitBreakerMs: 60_000,
    });
    try {
      // Trip the breaker: the command times out and the connection is destroyed.
      await expect(client.get("hang")).rejects.toThrow(/timed out/);
      const connsAfterTrip = server.commandConnectionCount();
      // Within the window, commands reject with the breaker error and make NO reconnect attempt
      // (a reconnect would bump the server's accepted-connection count).
      await expect(client.get("k")).rejects.toThrow(/circuit breaker/);
      await expect(client.get("k")).rejects.toThrow(/circuit breaker/);
      expect(server.commandConnectionCount()).toBe(connsAfterTrip);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("the first command past the breaker window probes a fresh connection and recovers", async () => {
    const server = await startFakeValkey((cmd) => (cmd[1] === "hang" ? null : bulk("v")));
    const client = createRespClient({
      url: server.url,
      commandTimeoutMs: 100,
      connectTimeoutMs: 1000,
      circuitBreakerMs: 200, // tiny window; the sleep below clears it with a 4x margin
    });
    try {
      await expect(client.get("hang")).rejects.toThrow(/timed out/);
      const connsAfterTrip = server.commandConnectionCount();
      await sleep(800);
      expect(await client.get("k")).toBe("v");
      expect(server.commandConnectionCount()).toBe(connsAfterTrip + 1);
    } finally {
      await client.quit();
      await server.close();
    }
  });

  it("a CONNECT failure opens the breaker (no 5s connect timeout per command)", async () => {
    // A port with nothing listening on it: connects are refused immediately.
    const probe = await startFakeValkey(() => ok());
    const deadPort = probe.port;
    await probe.close();
    const client = createRespClient({
      url: `redis://127.0.0.1:${deadPort}`,
      connectTimeoutMs: 5000, // deliberately long — only the breaker keeps later commands fast
      circuitBreakerMs: 60_000,
    });
    try {
      await expect(client.get("x")).rejects.toThrow(); // ECONNREFUSED, trips the breaker
      const started = Date.now();
      await expect(client.get("x")).rejects.toThrow(/circuit breaker/);
      await expect(client.get("x")).rejects.toThrow(/circuit breaker/);
      // Generous bound — the point is only that neither command paid the 5s connectTimeoutMs.
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await client.quit();
    }
  });

  it("N7: a server-initiated idle close with an EMPTY queue does NOT open the breaker", async () => {
    // The k8s-common case: server `timeout`, or a NAT/proxy reaping an idle connection. Nothing
    // was in flight, so nothing paid for the failure — the next command must reconnect
    // transparently instead of fail-fasting for circuitBreakerMs.
    let serverSocket: net.Socket | undefined;
    const server = await startFakeValkey((_cmd, socket) => {
      serverSocket = socket;
      return bulk("v");
    });
    // Huge window: if the idle close wrongly opened the breaker, the next get deterministically
    // rejects with /circuit breaker/ instead of succeeding.
    const client = createRespClient({ url: server.url, circuitBreakerMs: 60_000 });
    try {
      expect(await client.get("a")).toBe("v");
      // Server reaps the idle connection while the client's reply queue is empty.
      serverSocket!.end();
      // Let the client observe the FIN before issuing the next command — a command written
      // BEFORE the close lands would be a legitimately-failed in-flight command (breaker opens).
      await sleep(200);
      expect(await client.get("b")).toBe("v"); // transparent reconnect, no breaker error
      expect(server.commandConnectionCount()).toBe(2);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

describe("rediss:// TLS (handshake + AUTH + round-trip against a pinned CA)", () => {
  it("connects over TLS to an IP host, AUTHs, and round-trips", async () => {
    // Mint a throwaway self-signed pair with an IP SAN — the shape Memorystore's in-transit
    // encryption CA presents for the instance's VPC IP (routing-service/server.test.ts uses
    // the same openssl pattern). IP SAN is required: modern Node rejects CN-only IP certs.
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "resp-tls-test-"));
    try {
      const certFile = path.join(tmpDir, "tls-cert.pem");
      const keyFile = path.join(tmpDir, "tls-key.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyFile,
          "-out",
          certFile,
          "-days",
          "1",
          "-subj",
          "/CN=127.0.0.1",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const tlsOpts = {
        key: readFileSync(keyFile, "utf8"),
        cert: readFileSync(certFile, "utf8"),
      };
      const server = await startFakeValkey(
        (cmd) => (cmd[0] === "AUTH" ? ok() : bulk("v")),
        tlsOpts,
      );
      // The client pins verification to the self-signed cert as its CA (the caCert option) —
      // the default trust store would reject it. A successful round-trip proves the handshake
      // AND hostname verification passed (a failure rejects the connect, it does not degrade).
      const client = createRespClient({
        url: `rediss://:tlssecret@127.0.0.1:${server.port}`,
        caCert: tlsOpts.cert,
      });
      try {
        expect(await client.get("k")).toBe("v");
        expect(server.commands[0]).toEqual(["AUTH", "tlssecret"]); // AUTH after the handshake
        expect(server.commands[1]).toEqual(["GET", "k"]);
      } finally {
        await client.quit();
        await server.close();
      }
      // Negative control: pinning to a DIFFERENT CA must fail the handshake.
      const otherDir = mkdtempSync(path.join(os.tmpdir(), "resp-tls-test-ca-"));
      try {
        const otherCert = path.join(otherDir, "other-cert.pem");
        const otherKey = path.join(otherDir, "other-key.pem");
        execFileSync(
          "openssl",
          [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            otherKey,
            "-out",
            otherCert,
            "-days",
            "1",
            "-subj",
            "/CN=127.0.0.1",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
          ],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        const server2 = await startFakeValkey(() => bulk("v"), tlsOpts);
        const mistrusting = createRespClient({
          url: server2.url,
          caCert: readFileSync(otherCert, "utf8"), // wrong CA for server2's cert
        });
        try {
          await expect(mistrusting.get("k")).rejects.toThrow();
          expect(server2.commands).toEqual([]); // no command ever crossed the wire
        } finally {
          await mistrusting.quit();
          await server2.close();
        }
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("N76: a failure report is scoped to the connection that produced it", () => {
  it("an AUTH-time socket failure with the breaker DISABLED still recovers on one reconnect", async () => {
    // The duplicate-report path: a socket error during AUTH rejects the in-flight AUTH pending
    // (failAll #1) AND then resolves `connect()`'s rejection, which called `failAll(error, true)`
    // a second time. With `circuitBreakerMs: 0` there is no breaker window to absorb the second
    // call, so it could tear down whatever connection `this.socket` pointed at by then. The
    // generation guard makes report #2 a no-op; what is observable here is that recovery needs
    // exactly ONE new connection and the recovered connection is not disturbed.
    let kill = true;
    const server = await startFakeValkey((cmd, socket) => {
      if (cmd[0] === "AUTH" && kill) {
        kill = false;
        socket.destroy(); // RST during AUTH: rejects the pending AND fails the connect
        return null;
      }
      return cmd[0] === "AUTH" ? ok() : bulk("v");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // plaintext-auth warning
    const client = createRespClient({
      url: server.url,
      password: "s3cret",
      circuitBreakerMs: 0,
      commandTimeoutMs: 500,
      connectTimeoutMs: 500,
    });
    try {
      await expect(client.get("a")).rejects.toThrow();
      const connsAfterFailure = server.commandConnectionCount();
      expect(await client.get("b")).toBe("v");
      expect(server.commandConnectionCount()).toBe(connsAfterFailure + 1);
      // And the recovered connection is still usable — nothing tore it down behind our back.
      expect(await client.get("c")).toBe("v");
      expect(server.commandConnectionCount()).toBe(connsAfterFailure + 1);
    } finally {
      await client.quit();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// S21 (AVAILABILITY) — an oversized ARRAY must be refused by the FRAMING pass, not the parser.
//
// The byte cap is not an element cap: `$-1\r\n` is 5 bytes, so millions of null elements fit
// well inside a 64 MiB reply. scanFrameEnd would report such a frame COMPLETE and parseReply —
// which runs OUTSIDE drainInbound's try/catch — would throw, taking the pool process down
// instead of failing the command and degrading to a cache miss.
// ---------------------------------------------------------------------------
describe("S21: RESP array element cap", () => {
  it("fails the command (RespError) rather than escaping as an uncaught throw", async () => {
    const count = 2_000_000; // ~10 MB on the wire, far under the byte cap, far over the element cap
    const server = await startFakeValkey(() => [
      Buffer.from(`*${count}\r\n`),
      Buffer.from("$-1\r\n".repeat(count)),
    ]);
    const client = createRespClient({ url: server.url });
    try {
      await expect(client.get("x")).rejects.toThrow(/element cap/);
      // Reached only because the throw was converted into a failed command, not a crash.
      await expect(client.get("y")).rejects.toThrow();
    } finally {
      await server.close();
    }
  }, 30_000);
});
