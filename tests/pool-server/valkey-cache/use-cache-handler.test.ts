import { afterEach, describe, expect, it, vi } from "vitest";
import { DURABLE_TTL_SECONDS } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";
import { RespError, type ValkeyMulti } from "../../../src/pool-server/valkey-cache/resp-client.js";
import type { ValkeyClient } from "../../../src/pool-server/valkey-cache/client.js";
import { bufferToStream } from "../../../src/pool-server/valkey-cache/stream-codec.js";
import { TAG_MANIFEST_TTL_SECONDS } from "../../../src/pool-server/valkey-cache/tag-manifest.js";
import type { CacheEntry } from "../../../src/pool-server/valkey-cache/types.js";
import { ValkeyCacheHandler } from "../../../src/pool-server/valkey-cache/use-cache-handler.js";

// Unit tests for the V2 `use cache` handler's defensive write/read paths (no Docker needed):
// an in-memory fake ValkeyClient records writes and can be scripted to fail.

type Arg = string | number | Buffer;

class FakeValkeyClient implements ValkeyClient {
  readonly hashes = new Map<string, Record<string, Buffer>>();
  readonly strings = new Map<string, string>();
  readonly tagFields = new Map<string, string>();
  readonly delCalls: string[][] = [];
  readonly multiExpireArgs: number[] = [];
  /** The manifest TTL from each updateTags eval call (the script EXPIREs the key per write). */
  readonly manifestExpireCalls: number[] = [];
  multiCount = 0;
  /** When set, `multi().exec()` reports it as a per-command failure inside the EXEC reply. */
  execFailure: RespError | null = null;
  evalError: Error | null = null;
  hmgetError: Error | null = null;
  /** The fake's "server clock" for the eval merge; 0 means Date.now(). */
  serverNow = 0;

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string | Buffer): Promise<string | null> {
    this.strings.set(key, String(value));
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    this.delCalls.push(keys);
    let n = 0;
    for (const key of keys) {
      if (this.hashes.delete(key)) n++;
      if (this.strings.delete(key)) n++;
    }
    return n;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async ttl(): Promise<number> {
    return -1;
  }
  async eval(...args: Arg[]): Promise<unknown> {
    if (this.evalError) throw this.evalError;
    // Emulates UPDATE_TAGS_SCRIPT — keep in sync with the real script (the Docker integration
    // tests verify it against actual Valkey): args are
    // [script, numkeys, key, field, json, field, json, ..., ttlSeconds]; each event wins when
    // its server-stamped `at` is >= the stored one, merging PER DIMENSION (an event replaces
    // only the watermarks it sets, preserving the rest), and the trailing ttl refreshes the
    // manifest key's expiry on every write (M11). Returns the clamp count (always 0 here).
    this.manifestExpireCalls.push(Number(args[args.length - 1]));
    const pairEnd = args.length - 1;
    const now = this.serverNow || Date.now();
    for (let i = 3; i < pairEnd; i += 2) {
      const field = String(args[i]);
      const incoming = JSON.parse(String(args[i + 1])) as Record<string, number>;
      const storedRaw = this.tagFields.get(field);
      const stored = storedRaw ? (JSON.parse(storedRaw) as Record<string, number>) : undefined;
      if (stored && (stored.at ?? 0) > now) continue; // out-of-order event loses (LEW)
      const merged: Record<string, number> = { at: now };
      const stale = incoming.stale ?? stored?.stale;
      if (stale !== undefined) merged.stale = stale;
      const expired = incoming.expired ?? stored?.expired;
      if (expired !== undefined) merged.expired = expired;
      this.tagFields.set(field, JSON.stringify(merged));
    }
    return 0;
  }
  async hmget(_key: string, ...fields: string[]): Promise<(string | null)[]> {
    if (this.hmgetError) throw this.hmgetError;
    return fields.map((field) => this.tagFields.get(field) ?? null);
  }
  async hset(key: string, ...args: Arg[]): Promise<number> {
    const hash = this.hashes.get(key) ?? Object.create(null);
    for (let i = 0; i + 1 < args.length; i += 2) {
      const value = args[i + 1]!;
      hash[String(args[i])] = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    }
    this.hashes.set(key, hash);
    return 1;
  }
  async hgetallBuffer(key: string): Promise<Record<string, Buffer>> {
    return this.hashes.get(key) ?? Object.create(null);
  }
  multi(): ValkeyMulti {
    this.multiCount++;
    const pendingHsets: [string, Arg[]][] = [];
    const expireArgs = this.multiExpireArgs;
    const applyHset = (key: string, args: Arg[]) => this.hset(key, ...args);
    const getFailure = () => this.execFailure;
    return {
      hset(key: string, ...args: Arg[]) {
        pendingHsets.push([key, args]);
        return this;
      },
      expire(_key: string, seconds: number) {
        expireArgs.push(seconds);
        return this;
      },
      async exec(): Promise<unknown[]> {
        const failure = getFailure();
        if (failure) {
          // Simulate MULTI's non-atomicity: the HSET applied, the EXPIRE was rejected.
          for (const [key, args] of pendingHsets) await applyHset(key, args);
          return [pendingHsets.length, failure];
        }
        const results: unknown[] = [];
        for (const [key, args] of pendingHsets) results.push(await applyHset(key, args));
        results.push(1);
        return results;
      },
    };
  }
  async quit(): Promise<void> {}
}

function makeEntry(
  text: string,
  opts: {
    tags?: string[];
    stale?: number;
    timestamp?: number;
    expire?: number;
    revalidate?: number;
  } = {},
): CacheEntry {
  return {
    value: bufferToStream(Buffer.from(text, "utf8")),
    tags: opts.tags ?? [],
    stale: opts.stale ?? 300,
    timestamp: opts.timestamp ?? 1000,
    expire: opts.expire ?? 300,
    revalidate: opts.revalidate ?? 60,
  };
}

async function readStream(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const validMeta = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    tags: [],
    stale: 300,
    timestamp: 1000,
    expire: 300,
    revalidate: 60,
    ...overrides,
  });

afterEach(() => {
  delete process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES;
  vi.restoreAllMocks();
});

describe("set/get round-trip (fake client)", () => {
  it("caches and serves a fresh entry", async () => {
    const h = new ValkeyCacheHandler({
      client: new FakeValkeyClient(),
      buildId: "u1",
      now: () => 1000,
    });
    await h.set("k", Promise.resolve(makeEntry("hello", { tags: ["t"] })));
    const got = await h.get("k", []);
    expect(got).toBeDefined();
    expect(await readStream(got!.value)).toBe("hello");
  });
});

describe("H4: non-finite lifetimes are refused, EXEC failures are detected", () => {
  it("does NOT cache an entry with a NaN expire (and warns once per process)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "h4", now: () => 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await h.set("k", Promise.resolve(makeEntry("v", { expire: NaN })));
    await h.set("k2", Promise.resolve(makeEntry("v", { revalidate: Infinity })));

    // No write was ever dispatched, and reads see nothing.
    expect(client.multiCount).toBe(0);
    expect(client.hashes.size).toBe(0);
    expect(await h.get("k", [])).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/non-finite or non-positive/);
  });

  it("does NOT cache an entry with a non-positive lifetime", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "h4b", now: () => 1000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.set("k", Promise.resolve(makeEntry("v", { expire: 0 })));
    expect(client.multiCount).toBe(0);
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("treats a per-command EXEC failure as a failed write and DELs the partial entry", async () => {
    const client = new FakeValkeyClient();
    client.execFailure = new RespError("ERR invalid expire time in 'expire' command");
    const h = new ValkeyCacheHandler({ client, buildId: "h4c", now: () => 1000 });

    // set() must not reject (a cache write failure never breaks the response)...
    await expect(h.set("k", Promise.resolve(makeEntry("v")))).resolves.toBeUndefined();
    // ...but the partially-applied HSET (no TTL) must be cleaned up.
    expect(client.delCalls).toEqual([["k8s:h4c:entry:k"]]);
    expect(client.hashes.size).toBe(0);
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("does NOT DEL a previously cached entry when the entry promise itself rejects", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "h4d", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("good")));
    expect(client.hashes.size).toBe(1);
    await h.set("k", Promise.reject(new Error("render failed")));
    // The write was never dispatched, so no cleanup DEL may remove the old entry.
    expect(client.delCalls).toEqual([]);
    expect(await h.get("k", [])).toBeDefined();
  });
});

describe("M7: V2 key TTL is capped at DURABLE_TTL_SECONDS", () => {
  it("caps the EXPIRE argument for an INFINITE_CACHE-scale expire (~136 years)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "m7", now: () => 1000 });
    await h.set(
      "k",
      Promise.resolve(makeEntry("v", { expire: 2 ** 32 - 1, revalidate: 2 ** 32 - 1 })),
    );
    expect(client.multiExpireArgs).toEqual([DURABLE_TTL_SECONDS]);
    expect(DURABLE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it("does not shorten a normal TTL (expire + retention margin)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "m7b", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("v", { expire: 300, revalidate: 60 })));
    expect(client.multiExpireArgs).toEqual([360]); // 300 + 60s retention margin
  });
});

describe("M6: entry size cap", () => {
  it("skips caching when the value exceeds ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES", async () => {
    process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES = "16";
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "m6", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("x".repeat(64))));
    expect(client.multiCount).toBe(0);
    expect(await h.get("k", [])).toBeUndefined();
  });
});

describe("L5: malformed stored entries degrade to a miss", () => {
  const preload = (client: FakeValkeyClient, key: string, fields: Record<string, string>) => {
    const hash: Record<string, Buffer> = Object.create(null);
    for (const [f, v] of Object.entries(fields)) hash[f] = Buffer.from(v, "utf8");
    client.hashes.set(`k8s:l5:entry:${key}`, hash);
  };

  it("meta present but value field missing → miss (not an empty fresh entry)", async () => {
    const client = new FakeValkeyClient();
    preload(client, "k", { m: validMeta() }); // no "v"
    const h = new ValkeyCacheHandler({ client, buildId: "l5", now: () => 1000 });
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("unparseable meta JSON → miss", async () => {
    const client = new FakeValkeyClient();
    preload(client, "k", { m: "{corrupt", v: "value" });
    const h = new ValkeyCacheHandler({ client, buildId: "l5", now: () => 1000 });
    expect(await h.get("k", [])).toBeUndefined();
  });

  it.each([
    ["non-numeric expire", { expire: "300" }],
    ["NaN revalidate", { revalidate: null }],
    ["missing timestamp", { timestamp: undefined }],
    ["tags not an array", { tags: "t1,t2" }],
    ["tags with non-string members", { tags: [1, 2] }],
    ["meta is a JSON array", null],
  ])("invalid meta shape (%s) → miss", async (_label, patch) => {
    const client = new FakeValkeyClient();
    const raw = patch === null ? "[1,2,3]" : validMeta(patch as Record<string, unknown>);
    preload(client, "k", { m: raw, v: "value" });
    const h = new ValkeyCacheHandler({ client, buildId: "l5", now: () => 1000 });
    expect(await h.get("k", [])).toBeUndefined();
  });
});

describe("L3: getExpiration fails STALE (not fresh) on error", () => {
  it("returns now and logs rate-limited when the manifest read fails", async () => {
    const client = new FakeValkeyClient();
    client.hmgetError = new Error("valkey down");
    const h = new ValkeyCacheHandler({ client, buildId: "l3", now: () => 777_000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await h.getExpiration(["a"])).toBe(777_000);
    expect(await h.getExpiration(["a"])).toBe(777_000);
    expect(error).toHaveBeenCalledTimes(1); // rate-limited, not per-call
  });
});

describe("M1: updateTags failures are observable (fail-open, rate-limited)", () => {
  it("logs once per 60s class window and never throws", async () => {
    const client = new FakeValkeyClient();
    client.evalError = new Error("valkey down");
    const h = new ValkeyCacheHandler({ client, buildId: "m1", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(h.updateTags(["t"])).resolves.toBeUndefined();
    await expect(h.updateTags(["t"])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/updateTags failed/);
  });
});

describe("tag state reads", () => {
  it("corrupt manifest fields are treated as 'never revalidated'", async () => {
    const client = new FakeValkeyClient();
    client.tagFields.set("t", "{corrupt json");
    const h = new ValkeyCacheHandler({ client, buildId: "ts", now: () => 1000 });
    // A corrupt field must not throw or invalidate; entry stays fresh.
    expect(await h.getExpiration(["t"])).toBe(0);
    await h.set("k", Promise.resolve(makeEntry("v", { tags: ["t"] })));
    expect(await h.get("k", [])).toBeDefined();
  });
});

describe("M11: the tag manifest itself is TTL-bounded (refreshed per write)", () => {
  it("passes TAG_MANIFEST_TTL_SECONDS as the trailing eval argv on every updateTags", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "m11", now: () => 1000 });
    await h.updateTags(["a"]);
    await h.updateTags(["b"], { expire: 300 });
    expect(client.manifestExpireCalls).toEqual([
      TAG_MANIFEST_TTL_SECONDS,
      TAG_MANIFEST_TTL_SECONDS,
    ]);
  });
});

describe("M12: updateTags merges per dimension (a profiled event keeps a hard-expire watermark)", () => {
  const storedState = (client: FakeValkeyClient, tag: string) => {
    const raw = client.tagFields.get(tag);
    if (!raw) throw new Error(`no stored state for ${tag}`);
    return JSON.parse(raw) as { stale?: number; expired?: number; at: number };
  };

  it("hard then profile-without-expire: the hard-expire watermark survives", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1000 };
    client.serverNow = clock.t;
    const h = new ValkeyCacheHandler({ client, buildId: "m12", now: () => clock.t });

    await h.updateTags(["t"]); // hard expire at 1000
    clock.t = 2000;
    client.serverNow = 2000;
    await h.updateTags(["t"], {}); // profiled, but no expire → only {stale, at}

    const state = storedState(client, "t");
    expect(state.expired).toBe(1000); // preserved — whole-field replace would have ERASED it
    expect(state.stale).toBe(2000);
    // And the hard expire still bites: an entry created before 1000 is expired, not served SWR.
    await h.set("k", Promise.resolve(makeEntry("v", { tags: ["t"], timestamp: 500 })));
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("profile-with-expire then hard: the later hard expire wins immediately, stale survives", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1000 };
    client.serverNow = clock.t;
    const h = new ValkeyCacheHandler({ client, buildId: "m12b", now: () => clock.t });

    await h.updateTags(["t"], { expire: 300 }); // stale=1000, expired=1000+300_000 (future)
    clock.t = 2000;
    client.serverNow = 2000;
    await h.updateTags(["t"]); // hard expire at 2000

    const state = storedState(client, "t");
    expect(state.expired).toBe(2000); // the later event's expired wins (immediate, not future)
    expect(state.stale).toBe(1000); // the profile's stale watermark is preserved
    await h.set("k", Promise.resolve(makeEntry("v", { tags: ["t"], timestamp: 500 })));
    expect(await h.get("k", [])).toBeUndefined(); // expired (2000 > 500, 2000 <= now)
  });
});

describe("L10: a hung set does not block a concurrent same-key get forever", () => {
  it("get proceeds as a miss after pendingSetWaitMs", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({
      client,
      buildId: "l10",
      now: () => 1000,
      pendingSetWaitMs: 50,
    });
    // A set whose entry promise never resolves — the gate never releases on its own.
    const setP = h.set("k", new Promise<CacheEntry>(() => undefined));
    const started = Date.now();
    const got = await h.get("k", []);
    const elapsed = Date.now() - started;
    expect(got).toBeUndefined(); // proceeded as a miss rather than hanging
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(3000); // bounded by the option, not unbounded
    // The set is still in flight; a later get sees the resolved value once it lands.
    expect(client.hashes.size).toBe(0);
    await expect(Promise.race([setP, sleep(20).then(() => "pending")])).resolves.toBe("pending");
  });

  it("a healthy set is still awaited (the bound does not race ahead of it)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({
      client,
      buildId: "l10b",
      now: () => 1000,
      pendingSetWaitMs: 500,
    });
    let resolveEntry!: (e: CacheEntry) => void;
    const pending = new Promise<CacheEntry>((r) => {
      resolveEntry = r;
    });
    const setP = h.set("k", pending);
    const getP = h.get("k", []);
    await sleep(30);
    resolveEntry(makeEntry("late", { timestamp: 1000 }));
    await setP;
    const got = await getP;
    expect(got).toBeDefined();
    expect(await readStream(got!.value)).toBe("late");
  });
});

describe("N5: the stored tag list is capped like the incremental handler's", () => {
  it("caps at 128 tags and drops tags longer than 256 chars", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n5", now: () => 1000 });
    const tags = Array.from({ length: 200 }, (_, i) => `tag-${i}`);
    tags[3] = "x".repeat(300); // over-length: dropped, so tag-4 shifts into place
    await h.set("k", Promise.resolve(makeEntry("v", { tags })));
    const meta = JSON.parse(client.hashes.get("k8s:n5:entry:k")!.m.toString("utf8")) as {
      tags: string[];
    };
    expect(meta.tags).toHaveLength(128);
    expect(meta.tags[0]).toBe("tag-0");
    expect(meta.tags).not.toContain("x".repeat(300));
    expect(meta.tags[3]).toBe("tag-4"); // the over-length tag left no hole
  });
});
