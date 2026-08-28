import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRespClient, RespError } from "../../../src/pool-server/valkey-cache/resp-client.js";

// Protocol correctness for the zero-dep RESP2 client, exercised against a real ephemeral Valkey
// (Docker). Skipped when Docker is unavailable. Includes a wire-compat cross-check: bytes written by
// our client are read back correctly by ioredis and vice versa.

function docker(args: string[]): string {
  return (
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || ""
  ).trim();
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dockerAvailable)("RespClient (integration)", () => {
  const containerName = `adapter-k8s-resp-test-${process.pid}`;
  let url = "";

  beforeAll(async () => {
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::6379",
      "valkey/valkey:8-alpine",
    ]);
    const port = Number(
      docker(["port", containerName, "6379/tcp"]).split("\n")[0].split(":").pop(),
    );
    url = `redis://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        if (docker(["exec", containerName, "valkey-cli", "ping"]) === "PONG") break;
      } catch {
        /* not ready */
      }
      await sleep(200);
    }
  }, 60_000);

  afterAll(() => {
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      /* already gone */
    }
  });

  it("GET/SET/DEL/TTL and null-on-miss", async () => {
    const c = createRespClient({ url });
    try {
      expect(await c.get("nope")).toBeNull();
      expect(await c.set("k", "v", "EX", 100)).toBe("OK");
      expect(await c.get("k")).toBe("v");
      expect(await c.ttl("k")).toBeGreaterThan(90);
      expect(await c.del("k")).toBe(1);
      expect(await c.get("k")).toBeNull();
    } finally {
      await c.quit();
    }
  });

  it("round-trips a binary value containing CRLF and NUL bytes", async () => {
    const c = createRespClient({ url });
    try {
      const payload = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x24, 0x2a, 0x00]); // \0 \r \n 0xff $ * \0
      await c.hset("h", "v", payload);
      const got = await c.hgetallBuffer("h");
      expect(Buffer.isBuffer(got.v)).toBe(true);
      expect(got.v.equals(payload)).toBe(true);
    } finally {
      await c.quit();
    }
  });

  it("parses a value larger than one TCP segment (chunked reply reassembly)", async () => {
    const c = createRespClient({ url });
    try {
      const big = "x".repeat(500_000); // >> a single MTU; reply arrives in many data chunks
      await c.set("big", big);
      expect(await c.get("big")).toBe(big);
    } finally {
      await c.quit();
    }
  });

  it("keeps replies aligned under heavy pipelining (concurrent commands)", async () => {
    const c = createRespClient({ url });
    try {
      await Promise.all(Array.from({ length: 200 }, (_, i) => c.set(`p:${i}`, String(i))));
      const got = await Promise.all(Array.from({ length: 200 }, (_, i) => c.get(`p:${i}`)));
      expect(got).toEqual(Array.from({ length: 200 }, (_, i) => String(i)));
    } finally {
      await c.quit();
    }
  });

  it("HMGET returns nulls for missing fields, EVAL runs server-side", async () => {
    const c = createRespClient({ url });
    try {
      await c.hset("m", "a", "1", "c", "3");
      expect(await c.hmget("m", "a", "b", "c")).toEqual(["1", null, "3"]);
      const sum = await c.eval("return tonumber(ARGV[1]) + tonumber(ARGV[2])", 0, "40", "2");
      expect(Number(sum)).toBe(42);
    } finally {
      await c.quit();
    }
  });

  it("MULTI/EXEC applies queued commands atomically", async () => {
    const c = createRespClient({ url });
    try {
      await c.multi().hset("t", "m", "meta", "v", "val").expire("t", 123).exec();
      expect((await c.hgetallBuffer("t")).m.toString()).toBe("meta");
      expect(await c.ttl("t")).toBeGreaterThan(100);
    } finally {
      await c.quit();
    }
  });

  it("surfaces server errors as RespError, staying usable afterward", async () => {
    const c = createRespClient({ url });
    try {
      await c.set("str", "notahash");
      // WRONGTYPE: hash op on a string key
      await expect(c.hmget("str", "x")).rejects.toBeInstanceOf(RespError);
      // The connection is still healthy for subsequent commands.
      expect(await c.get("str")).toBe("notahash");
    } finally {
      await c.quit();
    }
  });

  it("connects to a password-protected server, AUTHing before concurrent cold commands", async () => {
    // A dedicated requirepass'd server: fire many commands the instant the client is created (cold,
    // no prior connect) and assert none race ahead of AUTH (which would return NOAUTH).
    const authContainer = `adapter-k8s-resp-auth-${process.pid}`;
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      authContainer,
      "-p",
      "127.0.0.1::6379",
      "valkey/valkey:8-alpine",
      "--requirepass",
      "s3cret",
    ]);
    try {
      const authPort = Number(
        docker(["port", authContainer, "6379/tcp"]).split("\n")[0].split(":").pop(),
      );
      for (let i = 0; i < 60; i++) {
        try {
          if (
            docker(["exec", authContainer, "valkey-cli", "-a", "s3cret", "ping"]).includes("PONG")
          )
            break;
        } catch {
          /* not ready */
        }
        await sleep(200);
      }
      const c = createRespClient({ url: `redis://127.0.0.1:${authPort}`, password: "s3cret" });
      try {
        // No warm-up: all of these hit ensureConnected() while the single connect is in flight.
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => c.set(`a:${i}`, String(i))),
        );
        expect(results.every((r) => r === "OK")).toBe(true);
        expect(await c.get("a:7")).toBe("7");
      } finally {
        await c.quit();
      }
    } finally {
      try {
        docker(["rm", "-f", authContainer]);
      } catch {
        /* already gone */
      }
    }
  }, 60_000);

  it("rejects (does not hang) when the endpoint is unreachable, within connectTimeoutMs", async () => {
    // 192.0.2.1 is TEST-NET-1 (RFC 5737) — reserved and unrouteable, so the connect blackholes.
    const c = createRespClient({ url: "redis://192.0.2.1:6379", connectTimeoutMs: 400 });
    const started = Date.now();
    await expect(c.get("x")).rejects.toThrow(/connect timed out/i);
    expect(Date.now() - started).toBeLessThan(3000); // bounded by the timeout, not hung
    await c.quit();
  }, 10_000);

  it("WIRE-COMPAT: values written by RespClient are read by ioredis and vice versa", async () => {
    const resp = createRespClient({ url });
    const io = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    try {
      const bin = Buffer.from([1, 2, 3, 13, 10, 0, 255]);
      // RespClient writes → ioredis reads
      await resp.hset("x", "m", "meta-json", "v", bin);
      const ioVal = await io.hgetallBuffer("x");
      expect(ioVal.m.toString()).toBe("meta-json");
      expect((ioVal.v as Buffer).equals(bin)).toBe(true);
      // ioredis writes → RespClient reads
      await io.set("y", bin);
      const back = await resp.hgetallBuffer("x");
      expect(back.v.equals(bin)).toBe(true);
      expect(await resp.get("y")).toBe(bin.toString("utf8"));
    } finally {
      await resp.quit();
      await io.quit().catch(() => undefined);
    }
  });
});
