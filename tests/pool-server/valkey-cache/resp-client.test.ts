import * as net from "node:net";
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
  close: () => Promise<void>;
}

/**
 * Start a fake Valkey server. `respond` maps a decoded command to raw reply bytes (an array of
 * chunks to simulate fragmentation — chunks are written on separate event-loop ticks so they
 * arrive as separate TCP segments) or null (no reply at all).
 */
function startFakeValkey(respond: (cmd: string[]) => Buffer[] | null): Promise<FakeServer> {
  const commands: string[][] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const parsed = parseCommand(buf);
        if (!parsed) break;
        commands.push(parsed.args);
        buf = buf.subarray(parsed.consumed);
        const reply = respond(parsed.args);
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
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `redis://127.0.0.1:${port}`,
        port,
        commands,
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
