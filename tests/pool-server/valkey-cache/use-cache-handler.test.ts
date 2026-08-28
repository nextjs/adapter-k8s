import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DURABLE_TTL_SECONDS } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";
import { RespError, type ValkeyMulti } from "../../../src/pool-server/valkey-cache/resp-client.js";
import type { ValkeyClient } from "../../../src/pool-server/valkey-cache/client.js";
import {
  bufferToStream,
  resetLogSuppressionForTests,
} from "../../../src/pool-server/valkey-cache/stream-codec.js";
import {
  MAX_CLOCK_SKEW_MS,
  TAG_MANIFEST_EPOCH_FIELD,
  TAG_MANIFEST_TTL_SECONDS,
} from "../../../src/pool-server/valkey-cache/tag-manifest.js";
import type { CacheEntry } from "../../../src/pool-server/valkey-cache/types.js";
import {
  STORE_USE_CACHE_ENTRY_SCRIPT,
  ValkeyCacheHandler,
} from "../../../src/pool-server/valkey-cache/use-cache-handler.js";
import { READ_VALKEY_TIME_SCRIPT } from "../../../src/pool-server/valkey-cache/valkey-clock.js";

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
  readonly hmgetCalls: string[][] = [];
  manifestEpoch = 0;
  multiCount = 0;
  /** When set, `multi().exec()` reports it as a per-command failure inside the EXEC reply. */
  execFailure: RespError | null = null;
  evalError: Error | null = null;
  hmgetError: Error | null = null;
  /** When set, every `hgetallBuffer` rejects with it (a permanently dead cache — N81). */
  hgetallError: Error | null = null;
  /** The fake's "server clock" for the eval merge; 0 means Date.now(). */
  serverNow = 0;
  /** A moving "server clock" for the eval merge; wins over `serverNow` when set (N78). */
  serverNowFn: (() => number) | null = null;

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string | Buffer, ...args: Arg[]): Promise<string | null> {
    if (args.some((arg) => String(arg).toUpperCase() === "NX") && this.strings.has(key)) {
      return null;
    }
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
    const serverNow = () => (this.serverNowFn ? this.serverNowFn() : this.serverNow || Date.now());
    if (String(args[0]) === READ_VALKEY_TIME_SCRIPT) return serverNow();
    if (String(args[0]) === STORE_USE_CACHE_ENTRY_SCRIPT) {
      this.multiCount++;
      const key = String(args[2]);
      const meta = JSON.parse(String(args[3])) as Record<string, unknown>;
      const entryTimestamp = Number(args[6]);
      const clientNow = Number(args[7]);
      const sharedNow = serverNow();
      meta.timestamp = sharedNow + entryTimestamp - clientNow;
      await this.hset(key, "m", JSON.stringify(meta), "v", args[4]!);
      this.multiExpireArgs.push(Number(args[5]));
      if (this.execFailure) throw this.execFailure;
      return Math.abs(sharedNow - clientNow) > MAX_CLOCK_SKEW_MS ? 1 : 0;
    }
    if (args.length === 4) {
      const key = String(args[2]);
      const token = String(args[3]);
      if (this.strings.get(key) === token) {
        this.strings.delete(key);
        return 1;
      }
      return 0;
    }
    // Emulates UPDATE_TAGS_SCRIPT — keep in sync with the real script (the Docker integration
    // tests verify it against actual Valkey): args are
    // [script, numkeys, key, field, json, field, json, ..., ttlSeconds]; each event wins when
    // its server-stamped `at` is >= the stored one, its watermarks are REBASED onto the server
    // clock by the client's offset (N78), and the winner is merged PER DIMENSION (an event
    // replaces only the watermarks it sets, preserving the rest). The trailing ttl refreshes the
    // manifest key's expiry on every write (M11). Returns the skew count.
    this.manifestExpireCalls.push(Number(args[args.length - 1]));
    const pairEnd = args.length - 1;
    const now = serverNow();
    let clamped = 0;
    for (let i = 3; i < pairEnd; i += 2) {
      const field = String(args[i]);
      const incoming = JSON.parse(String(args[i + 1])) as Record<string, number>;
      // N78: rebase every client watermark by `serverNow - clientAt`.
      const shift = typeof incoming.at === "number" ? now - incoming.at : 0;
      if (Math.abs(shift) > MAX_CLOCK_SKEW_MS) clamped++;
      if (typeof incoming.stale === "number") incoming.stale += shift;
      if (typeof incoming.expired === "number") incoming.expired += shift;
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
    this.manifestEpoch++;
    return clamped;
  }
  async hmget(_key: string, ...fields: string[]): Promise<(string | null)[]> {
    if (this.hmgetError) throw this.hmgetError;
    this.hmgetCalls.push(fields);
    return fields.map((field) =>
      field === TAG_MANIFEST_EPOCH_FIELD
        ? this.manifestEpoch === 0
          ? null
          : String(this.manifestEpoch)
        : (this.tagFields.get(field) ?? null),
    );
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
    if (this.hgetallError) throw this.hgetallError;
    if (key.endsWith(":tags")) {
      const fields: Record<string, Buffer> = Object.create(null);
      for (const [tag, state] of this.tagFields) fields[tag] = Buffer.from(state);
      return fields;
    }
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

async function preparedGet(
  handler: ValkeyCacheHandler,
  cacheKey: string,
  softTags: string[],
): Promise<CacheEntry | undefined> {
  const run = await handler.prepareForInvocation();
  return run(() => handler.get(cacheKey, softTags));
}

async function preparedExpiration(handler: ValkeyCacheHandler, tags: string[]): Promise<number> {
  const run = await handler.prepareForInvocation();
  return run(() => handler.getExpiration(tags));
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

// warnOnce / logErrorRateLimited suppress by design (process-global); reset so each test's
// log-count assertions are independent of test order.
beforeEach(() => {
  resetLogSuppressionForTests();
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

  it("evaluates request soft tags inside the shared clock domain", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 10_000 };
    client.serverNowFn = () => clock.t;
    const h = new ValkeyCacheHandler({ client, buildId: "soft-tag", now: () => clock.t });
    await h.set("k", Promise.resolve(makeEntry("hello", { timestamp: clock.t })));
    clock.t += 1;
    await h.updateTags(["_N_T_/route"]);
    clock.t += 1;

    expect(await h.get("k", ["_N_T_/route"])).toBeUndefined();
    expect(await h.get("k", [])).toBeDefined();
  });

  it("signals tag staleness to every replica during page regeneration", async () => {
    const client = new FakeValkeyClient();
    let now = 1_000;
    client.serverNowFn = () => now;
    const options = {
      client,
      buildId: "atomic-tag",
      now: () => now,
    };
    const winnerHandler = new ValkeyCacheHandler(options);
    const loserHandler = new ValkeyCacheHandler(options);
    await winnerHandler.set(
      "shared",
      Promise.resolve(
        makeEntry("old", {
          tags: ["shared"],
          timestamp: now,
          revalidate: 3600,
          expire: 7200,
        }),
      ),
    );
    now = 1_001;
    await winnerHandler.updateTags(["shared"], { expire: 3600 });

    const [winner, loser] = await Promise.all([
      winnerHandler.get("shared", []),
      loserHandler.get("shared", []),
    ]);
    // Duplicate regeneration is acceptable. Suppressing a reader could leave every request stale
    // when the nominated owner never reaches the write path.
    expect(winner?.revalidate).toBe(-1);
    expect(loser?.revalidate).toBe(-1);
    expect(await readStream(loser!.value)).toBe("old");
  });

  it("treats an age-stale entry as a synchronous miss like Next production", async () => {
    const client = new FakeValkeyClient();
    let now = 1_000;
    client.serverNowFn = () => now;
    const handler = new ValkeyCacheHandler({ client, buildId: "age-miss", now: () => now });
    await handler.set(
      "shared",
      Promise.resolve(makeEntry("old", { timestamp: now, revalidate: 1, expire: 60 })),
    );

    now = 2_001;
    expect(await handler.get("shared", [])).toBeUndefined();
    // A read miss does not delete blindly; the bounded key remains available for a writer to
    // replace without racing an eager cleanup.
    expect(client.hashes.has("k8s:age-miss:entry:shared")).toBe(true);
  });
});

describe("staged-render safe reads", () => {
  it("turns a cold Valkey hit into an immediate miss, then warms the local front", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    client.hashes.set("k8s:stage-safe:entry:k", {
      m: Buffer.from(validMeta({ timestamp: 1000, revalidate: 60, expire: 300 })),
      v: Buffer.from("shared"),
    });
    const h = new ValkeyCacheHandler({ client, buildId: "stage-safe", now: () => 1000 });

    const run = await h.prepareForInvocation();
    expect(client.hmgetCalls).toEqual([[TAG_MANIFEST_EPOCH_FIELD]]);

    // A network-backed hit cannot resolve inside Cache Components' static stage. The current
    // request recomputes instead; the backing read only warms the process for a later request.
    expect(await run(() => h.get("k", []))).toBeUndefined();

    await vi.waitFor(async () => {
      const warmed = await preparedGet(h, "k", []);
      expect(warmed).toBeDefined();
      expect(await readStream(warmed!.value)).toBe("shared");
    });
  });

  it("never scans the high-cardinality tag manifest during request preflight", async () => {
    const client = new FakeValkeyClient();
    for (let i = 0; i < 10_000; i++) {
      client.tagFields.set(`tag-${i}`, JSON.stringify({ expired: i, at: i }));
    }
    const hgetall = vi.spyOn(client, "hgetallBuffer");
    const h = new ValkeyCacheHandler({ client, buildId: "stage-bounded", now: () => 10_000 });

    const run = await h.prepareForInvocation();

    expect(client.hmgetCalls).toEqual([[TAG_MANIFEST_EPOCH_FIELD]]);
    expect(hgetall).not.toHaveBeenCalled();
    expect(await run(() => h.getExpiration(["tag-9999"]))).toBe(Number.POSITIVE_INFINITY);
  });

  it("does not reuse one implicit-tag verdict for another tag set", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    client.hashes.set("k8s:stage-soft-tags:entry:k", {
      m: Buffer.from(validMeta({ timestamp: 1000, revalidate: 60, expire: 300 })),
      v: Buffer.from("shared"),
    });
    const h = new ValkeyCacheHandler({ client, buildId: "stage-soft-tags", now: () => 1000 });

    expect(await preparedGet(h, "k", ["_N_T_/one"])).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await preparedGet(h, "k", ["_N_T_/one"])).toBeDefined();
    });
    expect(await preparedGet(h, "k", ["_N_T_/two"])).toBeUndefined();
  });

  it("does not admit a background warm after a newer epoch was prepared", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    const stored = {
      m: Buffer.from(validMeta({ timestamp: 1000, revalidate: 60, expire: 300 })),
      v: Buffer.from("old"),
    };
    client.hashes.set("k8s:stage-warm-race:entry:k", stored);
    const h = new ValkeyCacheHandler({ client, buildId: "stage-warm-race", now: () => 1000 });
    const peer = new ValkeyCacheHandler({ client, buildId: "stage-warm-race", now: () => 1000 });
    const firstRun = await h.prepareForInvocation();

    let releaseRead!: () => void;
    const blockedRead = new Promise<Record<string, Buffer>>((resolve) => {
      releaseRead = () => resolve(stored);
    });
    vi.spyOn(client, "hgetallBuffer").mockImplementationOnce(() => blockedRead);
    expect(await firstRun(() => h.get("k", []))).toBeUndefined();

    await peer.updateTags(["peer-update"]);
    await h.prepareForInvocation();
    releaseRead();
    await new Promise<void>((resolve) => setImmediate(resolve));

    // The old read completed after the epoch changed, so it cannot repopulate the cleared front.
    expect(await preparedGet(h, "k", [])).toBeUndefined();
  });

  it("does not let an older backing warm cross a newer local write", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    const oldStored = {
      m: Buffer.from(validMeta({ timestamp: 900, revalidate: 60, expire: 300 })),
      v: Buffer.from("old"),
    };
    client.hashes.set("k8s:stage-write-race:entry:k", oldStored);
    const h = new ValkeyCacheHandler({ client, buildId: "stage-write-race", now: () => 1000 });

    let releaseRead!: () => void;
    const blockedRead = new Promise<Record<string, Buffer>>((resolve) => {
      releaseRead = () => resolve(oldStored);
    });
    vi.spyOn(client, "hgetallBuffer").mockImplementationOnce(() => blockedRead);
    expect(await preparedGet(h, "k", [])).toBeUndefined();

    await h.set("k", Promise.resolve(makeEntry("new", { timestamp: 1000 })));
    releaseRead();
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Neither the generated write nor the older in-flight read is trusted without a fresh,
    // exact backing read at the prepared epoch.
    expect(await preparedGet(h, "k", [])).toBeUndefined();
    await vi.waitFor(async () => {
      const warmed = await preparedGet(h, "k", []);
      expect(await readStream(warmed!.value)).toBe("new");
    });
  });

  it("does not start a backing warm while a same-key write is pending", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    client.hashes.set("k8s:stage-pending-write:entry:k", {
      m: Buffer.from(validMeta({ timestamp: 900, revalidate: 60, expire: 300 })),
      v: Buffer.from("old"),
    });
    const hgetall = vi.spyOn(client, "hgetallBuffer");
    const h = new ValkeyCacheHandler({ client, buildId: "stage-pending-write", now: () => 1000 });
    let resolveEntry!: (entry: CacheEntry) => void;
    const pendingEntry = new Promise<CacheEntry>((resolve) => {
      resolveEntry = resolve;
    });
    const set = h.set("k", pendingEntry);

    expect(await preparedGet(h, "k", [])).toBeUndefined();
    expect(hgetall).not.toHaveBeenCalled();

    resolveEntry(makeEntry("new", { timestamp: 1000 }));
    await set;
    expect(await preparedGet(h, "k", [])).toBeUndefined();
    await vi.waitFor(async () => {
      const warmed = await preparedGet(h, "k", []);
      expect(await readStream(warmed!.value)).toBe("new");
    });
  });

  it("bounds concurrent backing warms under a high-cardinality miss burst", async () => {
    const client = new FakeValkeyClient();
    const blockedRead = new Promise<Record<string, Buffer>>(() => undefined);
    const hgetall = vi.spyOn(client, "hgetallBuffer").mockImplementation(() => blockedRead);
    const h = new ValkeyCacheHandler({ client, buildId: "stage-warm-bound", now: () => 1000 });
    const run = await h.prepareForInvocation();

    for (let i = 0; i < 65; i++) {
      expect(await run(() => h.get(`key-${i}`, []))).toBeUndefined();
    }

    expect(hgetall).toHaveBeenCalledTimes(64);
  });

  it("drops locally warmed entries after another replica updates the shared tag manifest", async () => {
    const client = new FakeValkeyClient();
    let now = 1000;
    client.serverNowFn = () => now;
    const first = new ValkeyCacheHandler({ client, buildId: "stage-tags", now: () => now });
    const peer = new ValkeyCacheHandler({ client, buildId: "stage-tags", now: () => now });

    await first.set(
      "k",
      Promise.resolve(
        makeEntry("local", { tags: ["shared"], timestamp: now, revalidate: 60, expire: 300 }),
      ),
    );
    // A generated value is not admitted until the same persisted entry and its implicit tags
    // have been checked outside Next's render boundary.
    expect(await preparedGet(first, "k", [])).toBeUndefined();
    await vi.waitFor(async () => {
      expect(await preparedGet(first, "k", [])).toBeDefined();
    });

    now += 1;
    await peer.updateTags(["shared"]);
    now += 1;
    expect(await preparedGet(first, "k", [])).toBeUndefined();
  });

  it("keeps prepared mode scoped to one invocation", async () => {
    const client = new FakeValkeyClient();
    client.serverNow = 1000;
    client.hashes.set("k8s:stage-scope:entry:k", {
      m: Buffer.from(validMeta({ timestamp: 1000, revalidate: 60, expire: 300 })),
      v: Buffer.from("shared"),
    });
    const h = new ValkeyCacheHandler({ client, buildId: "stage-scope", now: () => 1000 });

    expect(await preparedGet(h, "k", [])).toBeUndefined();
    // A direct consumer after unrelated prepared traffic retains the original live-read contract.
    expect(await readStream((await h.get("k", []))!.value)).toBe("shared");
    expect(await h.getExpiration(["never"])).toBe(0);
    expect(await preparedExpiration(h, ["never"])).toBe(Number.POSITIVE_INFINITY);
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
    expect(warn.mock.calls[0]?.[0]).toMatch(/non-finite expire\/revalidate/);
  });

  it("does NOT cache an entry with a non-positive lifetime", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "h4b", now: () => 1000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.set("k", Promise.resolve(makeEntry("v", { expire: 0 })));
    expect(client.multiCount).toBe(0);
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("does not delete a possibly committed entry after an ambiguous script failure", async () => {
    const client = new FakeValkeyClient();
    client.execFailure = new RespError("ERR invalid expire time in 'expire' command");
    const h = new ValkeyCacheHandler({ client, buildId: "h4c", now: () => 1000 });

    // set() must not reject (a cache write failure never breaks the response)...
    await expect(h.set("k", Promise.resolve(makeEntry("v")))).resolves.toBeUndefined();
    // Lua is atomic. A transport error can arrive after Valkey committed the script, so cleanup
    // must not race a later writer and delete its value.
    expect(client.delCalls).toEqual([]);
    expect(client.hashes.size).toBe(1);
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

  it("does not eagerly delete an expired entry that a concurrent writer may replace", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "keep-expired", now: () => 2000 });
    client.hashes.set("k8s:keep-expired:entry:k", {
      m: Buffer.from(validMeta({ timestamp: 1000, expire: 1 })),
      v: Buffer.from("old"),
    });

    expect(await h.get("k", [])).toBeUndefined();
    expect(client.delCalls).toEqual([]);
    expect(client.hashes.has("k8s:keep-expired:entry:k")).toBe(true);
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
    expect(error).toHaveBeenCalledTimes(1);
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

  it("detects profiled updates even when they carry no expired watermark", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "shell-tags", now: () => 1000 });
    expect(await h.hasTagUpdates(["shell"])).toBe(false);

    await h.updateTags(["shell"], {});

    expect(await h.hasTagUpdates(["shell"])).toBe(true);
  });

  it("withholds a build artifact when the tag check fails", async () => {
    const client = new FakeValkeyClient();
    client.hmgetError = new Error("valkey down");
    const h = new ValkeyCacheHandler({ client, buildId: "shell-tags-fail", now: () => 1000 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await h.hasTagUpdates(["shell"])).toBe(true);
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

describe("N5/N79: the stored tag list is bounded exactly like the incremental handler's", () => {
  const storedMetaTags = (client: FakeValkeyClient, key: string): string[] =>
    (JSON.parse(client.hashes.get(key)!.m.toString("utf8")) as { tags: string[] }).tags;

  it("drops an over-long EXPLICIT tag but keeps a long implicit one, and keeps every _N_RP_", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n79v2", now: () => 1000 });
    const tags = Array.from({ length: 200 }, (_, i) => `tag-${i}`);
    tags[3] = "x".repeat(300); // over-length EXPLICIT tag: dropped, tag-4 shifts into place
    const implicit = `_N_T_/${"p".repeat(400)}`; // 406 chars — legal for a soft tag
    tags.push(implicit, "_N_RP_lang");
    await h.set("k", Promise.resolve(makeEntry("v", { tags })));
    const stored = storedMetaTags(client, "k8s:n79v2:entry:k");
    expect(stored).not.toContain("x".repeat(300));
    expect(stored[3]).toBe("tag-4"); // the over-length tag left no hole
    // The 128-count cap is gone (it dropped the trailing `_N_RP_*` markers, which the `use cache`
    // wrapper reads back off the COARSE entry to build the specific key — losing them makes the
    // reader serve the redirect entry's single 0x00 byte as the cache hit).
    expect(stored).toHaveLength(201);
    expect(stored).toContain(implicit);
    expect(stored).toContain("_N_RP_lang");
  });
});

describe("N84: `revalidate <= 0` is storable (only a non-finite/`expire<=0` entry is not)", () => {
  // A tag-stale `get` returns `revalidate: -1`, the `use cache` wrapper propagates the MINIMUM
  // revalidate into the ENCLOSING cache's store, and the
  // old H4 guard then refused to store that outer entry — so nested caches stopped caching for as
  // long as any inner entry was stale, and `cacheLife({ revalidate: 0 })` was never cached at all.
  // Measured pre-fix: `stored entry with revalidate=-1? false`, `revalidate=0? false`.
  // Next's own default handler stores both and skips only `expire === 0`.
  it("stores an entry whose revalidate is -1 (an inner stale entry's propagated lifetime)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n84a", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("outer", { revalidate: -1, expire: 300 })));
    expect(client.multiCount).toBe(1);
    expect(client.hashes.has("k8s:n84a:entry:k")).toBe(true);
    // It is stored because an enclosing cache may receive the propagated lifetime, but a later
    // production read treats the already-due time boundary as a synchronous miss.
    expect(await h.get("k", [])).toBeUndefined();
    // The TTL argument is still valid (the arithmetic floors at 1s + the retention margin).
    expect(client.multiExpireArgs).toEqual([360]);
  });

  it("stores a cacheLife({ revalidate: 0 }) entry", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n84b", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("v", { revalidate: 0, expire: 300 })));
    expect(await h.get("k", [])).toBeDefined();
  });

  it("still skips `expire <= 0` (Next's dynamic / eviction-sentinel entries), silently", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n84c", now: () => 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.set("zero", Promise.resolve(makeEntry("v", { expire: 0 })));
    await h.set("neg", Promise.resolve(makeEntry("v", { expire: -1 })));
    expect(client.multiCount).toBe(0);
    expect(await h.get("zero", [])).toBeUndefined();
    // `expire: 0` is a NORMAL Next shape (a dynamic entry), so it must not warn.
    expect(warn).not.toHaveBeenCalled();
  });

  it("still refuses a NON-FINITE lifetime, with a message that no longer says 'non-positive'", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n84d", now: () => 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.set("a", Promise.resolve(makeEntry("v", { expire: NaN })));
    await h.set("b", Promise.resolve(makeEntry("v", { revalidate: Infinity })));
    expect(client.multiCount).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1); // once per process
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/non-finite expire\/revalidate/);
    expect(String(warn.mock.calls[0]?.[0])).not.toMatch(/non-positive/);
  });
});

describe("N81: a non-functional `use cache` store is observable", () => {
  it("logs (rate-limited) on a read failure instead of silently recomputing forever", async () => {
    const client = new FakeValkeyClient();
    client.hgetallError = new Error("NOAUTH Authentication required");
    const h = new ValkeyCacheHandler({ client, buildId: "n81v2", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await h.get("k", [])).toBeUndefined(); // still fails OPEN
    expect(await h.get("k2", [])).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/`use cache` read failed/);
    expect(error.mock.calls[0]?.[1]).toBe(client.hgetallError);
  });

  it("logs (rate-limited) on a write failure", async () => {
    const client = new FakeValkeyClient();
    client.execFailure = new RespError("ERR invalid expire time in 'expire' command");
    const h = new ValkeyCacheHandler({ client, buildId: "n81v2b", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(h.set("k", Promise.resolve(makeEntry("v")))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/`use cache` write failed/);
  });
});

describe("N82: the build id is validated where it becomes keyspace", () => {
  it("refuses a build id that could alias another build's keys", () => {
    expect(
      () => new ValkeyCacheHandler({ client: new FakeValkeyClient(), buildId: "build:entry" }),
    ).toThrow(/unsafe build id/);
    expect(() => new ValkeyCacheHandler({ client: new FakeValkeyClient(), buildId: "" })).toThrow(
      /unsafe build id/,
    );
    expect(
      () => new ValkeyCacheHandler({ client: new FakeValkeyClient(), buildId: "k8s-1a2b3c4d" }),
    ).not.toThrow();
  });
});

describe("N83: updateTags runs its tags through the shared manifest filter", () => {
  it("an empty-string tag never becomes a manifest field", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n83v2", now: () => 1000 });
    await h.updateTags(["", "keep"]);
    expect([...client.tagFields.keys()]).toEqual(["keep"]);
  });

  it("no eval is issued when every tag is filtered out", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyCacheHandler({ client, buildId: "n83v2b", now: () => 1000 });
    await h.updateTags([""]);
    await h.updateTags(["x".repeat(257)]);
    expect(client.manifestExpireCalls).toEqual([]);
  });
});

describe("N78: watermarks are rebased onto the Valkey server clock", () => {
  // The Lua script runs for real in the Docker-gated integration suite. These use the fake's
  // faithful emulation (kept in sync with the script) to pin the OBSERVABLE consequence through
  // the handler on a machine without Docker.
  it("a 5-minute-BEHIND replica's hard revalidateTag still invalidates a current entry", async () => {
    // Pre-fix there was no floor: the behind pod stored `{"expired": now - 300000}`, which was
    // older than every current entry, so `expired > entryTimestamp` was false and the
    // revalidation invalidated NOTHING. Probed against real Valkey: "STILL SERVED".
    const client = new FakeValkeyClient();
    const server = { t: 5_000_000 };
    client.serverNowFn = () => server.t;
    const ok = new ValkeyCacheHandler({ client, buildId: "n78a", now: () => server.t });
    const behind = new ValkeyCacheHandler({
      client,
      buildId: "n78a",
      now: () => server.t - 300_000,
    });
    await ok.set("k", Promise.resolve(makeEntry("v", { tags: ["t"], timestamp: server.t })));
    server.t += 1000;
    await behind.updateTags(["t"]);
    server.t += 1000;
    expect(await ok.get("k", [])).toBeUndefined();
  });

  it("a 5-minute-AHEAD replica's hard revalidateTag invalidates NOW, not 60s from now", async () => {
    // Pre-fix the ceiling parked the watermark at `serverNow + 60000` with no `stale`, so
    // `expired <= now` was false for a full minute: the entry read back `revalidate: 60`, i.e.
    // FRESH — not even stale-while-revalidate. Probed against real Valkey: "revalidate = 60".
    const client = new FakeValkeyClient();
    const server = { t: 5_000_000 };
    client.serverNowFn = () => server.t;
    const ok = new ValkeyCacheHandler({ client, buildId: "n78b", now: () => server.t });
    const ahead = new ValkeyCacheHandler({
      client,
      buildId: "n78b",
      now: () => server.t + 300_000,
    });
    await ok.set("k", Promise.resolve(makeEntry("v", { tags: ["t"], timestamp: server.t - 1000 })));
    server.t += 1000;
    await ahead.updateTags(["t"]);
    server.t += 1000;
    expect(await ok.get("k", [])).toBeUndefined();
  });

  it("a profiled revalidation keeps its duration exactly after the rebase", async () => {
    const client = new FakeValkeyClient();
    const server = { t: 5_000_000 };
    client.serverNowFn = () => server.t;
    const ahead = new ValkeyCacheHandler({
      client,
      buildId: "n78c",
      now: () => server.t + 300_000,
    });
    await ahead.updateTags(["t"], { expire: 300 });
    const state = JSON.parse(client.tagFields.get("t")!) as { stale: number; expired: number };
    expect(state.stale).toBe(server.t); // base pinned to the SERVER clock
    expect(state.expired - state.stale).toBe(300_000); // duration preserved bit-for-bit
  });

  it("stores computation start in the server domain and preserves age for skewed readers", async () => {
    const client = new FakeValkeyClient();
    const server = { t: 5_000_000 };
    client.serverNowFn = () => server.t;
    const writerNow = server.t - 300_000;
    const writer = new ValkeyCacheHandler({
      client,
      buildId: "clock-entry",
      now: () => writerNow,
    });
    await writer.set(
      "k",
      Promise.resolve(
        makeEntry("v", {
          timestamp: writerNow - 90_000,
          revalidate: 120,
          expire: 600,
        }),
      ),
    );
    const meta = JSON.parse(client.hashes.get("k8s:clock-entry:entry:k")!.m.toString("utf8")) as {
      timestamp: number;
    };
    expect(meta.timestamp).toBe(server.t - 90_000);

    server.t += 10_000;
    const fastNow = server.t + 300_000;
    const slowNow = server.t - 300_000;
    const fast = new ValkeyCacheHandler({
      client,
      buildId: "clock-entry",
      now: () => fastNow,
    });
    const slow = new ValkeyCacheHandler({
      client,
      buildId: "clock-entry",
      now: () => slowNow,
    });
    const fastEntry = await fast.get("k", []);
    const slowEntry = await slow.get("k", []);
    expect(fastNow - fastEntry!.timestamp).toBe(100_000);
    expect(slowNow - slowEntry!.timestamp).toBe(100_000);
    expect(fastEntry!.revalidate).toBe(120);
    expect(slowEntry!.revalidate).toBe(120);
  });

  it("keeps an invalidation that arrives while a value is computing", async () => {
    const client = new FakeValkeyClient();
    const server = { t: 8_000_000 };
    client.serverNowFn = () => server.t;
    const local = { t: server.t - 300_000 };
    const handler = new ValkeyCacheHandler({
      client,
      buildId: "compute-race",
      now: () => local.t,
    });
    const computationStarted = local.t;
    server.t += 10_000;
    local.t += 10_000;
    await handler.updateTags(["t"]);
    server.t += 10_000;
    local.t += 10_000;
    await handler.set(
      "k",
      Promise.resolve(makeEntry("late", { tags: ["t"], timestamp: computationStarted })),
    );

    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("returns tag expirations in the requesting replica's local clock domain", async () => {
    const client = new FakeValkeyClient();
    const server = { t: 9_000_000 };
    client.serverNowFn = () => server.t;
    const writer = new ValkeyCacheHandler({
      client,
      buildId: "expiration-offset",
      now: () => server.t,
    });
    await writer.updateTags(["t"]);

    const readerNow = server.t + 300_000;
    const reader = new ValkeyCacheHandler({
      client,
      buildId: "expiration-offset",
      now: () => readerNow,
    });
    expect(await reader.getExpiration(["t"])).toBe(readerNow);
  });
});
