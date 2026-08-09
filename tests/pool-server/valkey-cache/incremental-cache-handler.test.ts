import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValkeyClient,
  ValkeyMulti,
} from "../../../src/pool-server/valkey-cache/resp-client.js";
import { ValkeyIncrementalCacheHandler } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";
import { resetLogSuppressionForTests } from "../../../src/pool-server/valkey-cache/stream-codec.js";
import { TAG_MANIFEST_TTL_SECONDS } from "../../../src/pool-server/valkey-cache/tag-manifest.js";

// Unit tests for the classic incremental handler's tag caps (L9), size cap (M6), malformed-entry
// handling (L5) and observable invalidation failures (M1) — no Docker needed.

type Arg = string | number | Buffer;

class FakeValkeyClient implements ValkeyClient {
  readonly strings = new Map<string, string>();
  readonly tagFields = new Map<string, string>();
  readonly setArgs: { key: string; value: string; args: Arg[] }[] = [];
  /** The manifest TTL from each revalidateTag eval call (the script EXPIREs the key per write). */
  readonly manifestExpireCalls: number[] = [];
  evalError: Error | null = null;
  /** When set, every `get`/`set` rejects with it (a permanently dead cache — N81). */
  getError: Error | null = null;
  setError: Error | null = null;

  async get(key: string): Promise<string | null> {
    if (this.getError) throw this.getError;
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string | Buffer, ...args: Arg[]): Promise<string | null> {
    if (this.setError) throw this.setError;
    // Honor NX like real Valkey: no write and a null reply when the key exists.
    if (args.some((a) => String(a).toUpperCase() === "NX") && this.strings.has(key)) {
      return null;
    }
    this.strings.set(key, String(value));
    this.setArgs.push({ key, value: String(value), args });
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.strings.delete(key)) n++;
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
    // args: [script, numkeys, key, field, json, field, json, ..., ttlSeconds] — the trailing
    // ttl refreshes the manifest key's expiry (M11); the naive store skips the merge (the
    // Docker integration tests cover the real script's semantics).
    this.manifestExpireCalls.push(Number(args[args.length - 1]));
    for (let i = 3; i + 1 < args.length - 1; i += 2) {
      this.tagFields.set(String(args[i]), String(args[i + 1]));
    }
    return 0;
  }
  async hmget(_key: string, ...fields: string[]): Promise<(string | null)[]> {
    return fields.map((field) => this.tagFields.get(field) ?? null);
  }
  async hset(): Promise<number> {
    return 1;
  }
  async hgetallBuffer(): Promise<Record<string, Buffer>> {
    return Object.create(null);
  }
  multi(): ValkeyMulti {
    throw new Error("not used by the incremental handler");
  }
  async quit(): Promise<void> {}
}

function appPageEntry(html: string, tagHeader?: string): Record<string, unknown> {
  return {
    kind: "APP_PAGE",
    html,
    headers: tagHeader === undefined ? {} : { "x-next-cache-tags": tagHeader },
  } as Record<string, unknown>;
}

const storedTags = (client: FakeValkeyClient, key: string): string[] => {
  const raw = client.strings.get(key);
  if (!raw) throw new Error(`no stored entry for ${key}`);
  return (JSON.parse(raw) as { tags: string[] }).tags;
};

// warnOnce / logErrorRateLimited suppress by design (process-global); reset so each test's
// log-count assertions are independent of test order.
beforeEach(() => {
  resetLogSuppressionForTests();
});

afterEach(() => {
  delete process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES;
  vi.restoreAllMocks();
});

describe("L9/N79: the stored tag list is bounded without dropping tags Next generates", () => {
  it("keeps an IMPLICIT path tag longer than 256 chars (upstream allows 1024 for soft tags)", async () => {
    // The whole finding: 256 is `NEXT_CACHE_TAG_MAX_LENGTH`, which upstream applies only to
    // explicit `cacheTag()`. Implicit tags are `_N_T_` + `encodeCacheTag(pathname)` and are bounded
    // by `NEXT_CACHE_SOFT_TAG_MAX_LENGTH` (1024) — a 63-char Cyrillic path measures 348 chars once
    // percent-encoded. Probed against real Valkey pre-fix with a 305-char implicit tag:
    // `stored tags: []` — the entry could never be invalidated by revalidatePath OR revalidateTag,
    // for the 30 days of DURABLE_TTL_SECONDS.
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79a", now: () => 1000 });
    const implicit = `_N_T_/${"a".repeat(299)}`;
    expect(implicit.length).toBeGreaterThan(256);
    await h.set("/long", appPageEntry("P", implicit), {});
    expect(storedTags(client, "k8s:n79a:inc:/long")).toEqual([implicit]);
  });

  it("still drops an over-limit EXPLICIT tag, and an implicit tag past 1024", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79b", now: () => 1000 });
    const longExplicit = "x".repeat(257);
    const okExplicit = "y".repeat(256);
    const okImplicit = `_N_T_/${"i".repeat(1018)}`; // exactly 1024
    const hugeImplicit = `_N_T_/${"j".repeat(1019)}`; // 1025 — past the soft-tag limit
    expect(okImplicit).toHaveLength(1024);
    await h.set(
      "/p",
      appPageEntry("P", `${longExplicit},keep,${okExplicit},${okImplicit},${hugeImplicit}`),
      {},
    );
    expect(storedTags(client, "k8s:n79b:inc:/p")).toEqual(["keep", okExplicit, okImplicit]);
  });

  it("NEVER drops the private _N_RP_* root-param markers, even past the old 128 cap", async () => {
    // Next appends `rootParamTags` LAST on the coarse/redirect entry
    // (`use-cache-wrapper.ts`: `tags: [...fullEntry.tags, ...rootParamTags]`), so the old
    // keep-the-first-128 rule dropped exactly them. Measured pre-fix: 132 tags in, 128 stored,
    // `has _N_RP_lang: false`. The reader then sees `paramNames.size === 0` and serves the coarse
    // entry's placeholder body — a single 0x00 byte — as the cache hit.
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79c", now: () => 1000 });
    const tags = [...Array.from({ length: 130 }, (_, i) => `t-${i}`), "_N_RP_lang", "_N_RP_region"];
    await h.set("/coarse", appPageEntry(" "), { tags });
    const stored = storedTags(client, "k8s:n79c:inc:/coarse");
    expect(stored).toContain("_N_RP_lang");
    expect(stored).toContain("_N_RP_region");
    expect(stored).toHaveLength(132); // nothing dropped: the budget is bytes, not a count of 128
  });

  it("bounds the list by TOTAL BYTES, skipping over-budget tags rather than truncating the tail", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79d", now: () => 1000 });
    // 100 x 1024-char implicit tags = ~102 KiB, past the 64 KiB budget; a short tag declared LAST
    // must still make it in (a tail-truncating cap would have lost it).
    const fat = Array.from({ length: 100 }, (_, i) => `_N_T_/${String(i).padStart(1017, "0")}`);
    await h.set("/fat", appPageEntry("P"), { tags: [...fat, "_N_RP_lang", "short-tag"] });
    const stored = storedTags(client, "k8s:n79d:inc:/fat");
    expect(stored).toContain("_N_RP_lang"); // reserved up front, never dropped
    expect(stored).toContain("short-tag"); // a big tag must not shadow the ones after it
    expect(stored.length).toBeLessThan(102);
    const bytes = stored.reduce((n, t) => n + t.length + 1, 0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024 + "_N_RP_lang".length + 1);
  });

  // N79 follow-up (review): the cap counted `tag.length` (UTF-16 units), but what lands in the
  // entry JSON and in the freshness HMGET argv is UTF-8 — so a non-ASCII list "within budget" was
  // up to 3x over it on the wire.
  it("spends the budget in UTF-8 BYTES, not UTF-16 code units", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79e", now: () => 1000 });
    // 120 explicit tags of 256 CJK chars: 30,720 UTF-16 units total (well under the 64 KiB
    // budget, so a `.length`-based cap stored ALL of them) but 92,160 UTF-8 bytes.
    const cjk = Array.from(
      { length: 120 },
      (_, i) => "字".repeat(255) + String.fromCharCode(97 + i),
    );
    expect(cjk[0]).toHaveLength(256); // still within the explicit-tag length limit
    expect(Buffer.byteLength(cjk[0]!, "utf8")).toBe(766);
    await h.set("/cjk", appPageEntry("P"), { tags: [...cjk, "tail"] });
    const stored = storedTags(client, "k8s:n79e:inc:/cjk");
    const bytes = stored.reduce((n, t) => n + Buffer.byteLength(t, "utf8") + 1, 0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
    expect(stored.length).toBeLessThan(121); // a `.length` budget kept all 121
    expect(stored).toContain("tail"); // skip-don't-stop still holds
  });

  // N79 follow-up (review): reserved `_N_RP_*` markers were pushed even after the reserved cost
  // drove the remaining budget negative, so the "cap" was not an upper bound at all. Dropping a
  // marker is not an option (that is the `0x00`-placeholder-served-as-a-hit bug), so the resolution
  // is to keep them all, raise this entry's budget to exactly their cost, store no ordinary tag,
  // and SAY SO — the pre-fix code did the same truncation silently while advertising a 64 KiB cap.
  it("keeps every _N_RP_* marker but warns loudly when they alone exceed the budget", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79f", now: () => 1000 });
    // 256 markers (the count cap) of 1024 units each (the soft-tag length limit) = 262,400 bytes
    // of reserved cost — 4x the 64 KiB budget, and the documented worst case for ASCII markers.
    const markers = Array.from({ length: 256 }, (_, i) => `_N_RP_${String(i).padStart(1018, "p")}`);
    expect(markers[0]).toHaveLength(1024);
    await h.set("/rp", appPageEntry(" "), { tags: [...markers, "ordinary", "another"] });
    const stored = storedTags(client, "k8s:n79f:inc:/rp");
    expect(stored).toEqual(markers); // all markers, no ordinary tag: the budget is spent
    const bytes = stored.reduce((n, t) => n + Buffer.byteLength(t, "utf8") + 1, 0);
    expect(bytes).toBe(256 * 1025);
    const warnings = warn.mock.calls.map(String).join("\n");
    expect(warnings).toMatch(/root-param tags \(_N_RP_\*\) alone need 262400 bytes/);
    expect(warnings).toContain("raising this entry's budget");
  });

  it("warns instead of silently dropping _N_RP_* markers past the count cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n79g", now: () => 1000 });
    const markers = Array.from({ length: 300 }, (_, i) => `_N_RP_p${i}`);
    await h.set("/rp2", appPageEntry(" "), { tags: markers });
    expect(storedTags(client, "k8s:n79g:inc:/rp2")).toEqual(markers.slice(0, 256));
    expect(warn.mock.calls.map(String).join("\n")).toMatch(/more than 256 private root-param tags/);
  });

  it("drops empty segments from a messy header", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "l9c", now: () => 1000 });
    await h.set("/p", appPageEntry("P", " , a,, b ,"), {});
    expect(storedTags(client, "k8s:l9c:inc:/p")).toEqual(["a", "b"]);
  });
});

describe("N80: a stale-by-tag read signals SWR, not a blocking re-render", () => {
  // `lastModified: -1` is NOT "revalidate in the background": `incremental-cache/index.ts` maps it
  // to `isStale = -1`, and `response-cache/index.ts` implements that as "do NOT early-resolve with
  // the stale value" — the user waits for a full render. `FileSystemCache` never returns -1 for a
  // merely-stale tag (it returns `null` for an EXPIRED one and the untouched entry otherwise, so
  // `index.ts` sets `isStale = true`). Measured pre-fix against real Valkey:
  //   `after profiled revalidateTag: lastModified = -1`
  const REVALIDATE = 60;
  const EXPIRE = 300;

  const setup = async (
    buildId: string,
    cacheControl: { revalidate?: number | false; expire?: number },
  ) => {
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId, now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { tags: ["t"], cacheControl });
    clock.t += 1000;
    await h.revalidateTag("t", { expire: 600 }); // PROFILED → stale = now, expired = now + 600s
    clock.t += 1000;
    return { h, clock };
  };

  it("returns a lastModified just past the revalidate window, still inside expire", async () => {
    const { h, clock } = await setup("n80a", { revalidate: REVALIDATE, expire: EXPIRE });
    const got = await h.get("/p", {});
    expect(got).not.toBeNull();
    const lastModified = got!.lastModified!;
    expect(lastModified).not.toBe(-1);
    // This is exactly what makes index.ts choose `isStale = true` (serve stale + background
    // revalidate) instead of `isStale = -1` (block on a fresh render):
    expect(REVALIDATE * 1000 + lastModified).toBeLessThan(clock.t); // revalidateAfter < now
    expect(EXPIRE * 1000 + lastModified).toBeGreaterThanOrEqual(clock.t); // expireAfter >= now
  });

  it("falls back to -1 when SWR is not expressible: revalidate:false (PPR shell / static)", async () => {
    // `calculateRevalidate` returns `false` for such a route, so `revalidateAfter` is `false` and
    // NOTHING but -1 can force a revalidation. Blocking is the only correct answer here.
    const { h } = await setup("n80b", { revalidate: false });
    expect((await h.get("/p", {}))?.lastModified).toBe(-1);
  });

  it("falls back to -1 when the expire window is too short to hold the shift", async () => {
    // expire <= revalidate means the shifted timestamp would be past expiry — genuinely blocking.
    const { h } = await setup("n80c", { revalidate: REVALIDATE, expire: REVALIDATE });
    expect((await h.get("/p", {}))?.lastModified).toBe(-1);
  });

  it("an EXPIRED tag is still a miss (null), matching FileSystemCache", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n80d", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), {
      tags: ["t"],
      cacheControl: { revalidate: REVALIDATE, expire: EXPIRE },
    });
    clock.t += 1000;
    await h.revalidateTag("t"); // HARD → expired = now
    clock.t += 1000;
    expect(await h.get("/p", {})).toBeNull();
  });

  it("a fresh entry still reports its real lastModified", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n80e", now: () => 1000 });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 300 } });
    expect((await h.get("/p", {}))?.lastModified).toBe(1000);
  });
});

describe("N81: a non-functional cache is observable", () => {
  it("logs (rate-limited) when a read fails, instead of silently rendering uncached forever", async () => {
    // Measured pre-fix: 4 handler operations against a dead Valkey produced ZERO log lines, while
    // stream-codec.ts's own M1 rationale says a Valkey outage "must still be OBSERVABLE".
    const client = new FakeValkeyClient();
    client.getError = new Error("NOAUTH Authentication required");
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n81a", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await h.get("/p", {})).toBeNull(); // still fails OPEN
    expect(await h.get("/q", {})).toBeNull();
    expect(error).toHaveBeenCalledTimes(1); // rate-limited per failure class, not per request
    expect(String(error.mock.calls[0]?.[0])).toMatch(/incremental cache read failed/);
    expect(error.mock.calls[0]?.[1]).toBe(client.getError); // the cause is attached
  });

  it("logs (rate-limited) when a write fails", async () => {
    const client = new FakeValkeyClient();
    client.setError = new Error(
      "WRONGTYPE Operation against a key holding the wrong kind of value",
    );
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n81b", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(h.set("/p", appPageEntry("P"), {})).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/incremental cache write failed/);
  });
});

describe("N82: the build id is validated where it becomes keyspace", () => {
  it.each([
    ["a colon (would alias another build's keys)", "build:entry"],
    ["a space", "build 1"],
    ["an empty string", ""],
    ["a newline", "build\n"],
    ["a wildcard", "build*"],
  ])("refuses %s", (_label, buildId) => {
    expect(
      () => new ValkeyIncrementalCacheHandler({ client: new FakeValkeyClient(), buildId }),
    ).toThrow(/unsafe build id/);
  });

  it("accepts the shapes the adapter actually generates", () => {
    for (const buildId of ["abc123", "k8s-1a2b3c4d", "build_1.2.3", "A".repeat(128)]) {
      expect(
        () => new ValkeyIncrementalCacheHandler({ client: new FakeValkeyClient(), buildId }),
      ).not.toThrow();
    }
  });
});

describe("N83: revalidateTag runs its tags through the shared manifest filter", () => {
  it("drops empty and over-long tags before they become manifest fields", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n83", now: () => 1000 });
    const longExplicit = "x".repeat(257);
    await h.revalidateTag(["", "keep", longExplicit, `_N_T_/${"y".repeat(300)}`]);
    expect([...client.tagFields.keys()]).toEqual(["keep", `_N_T_/${"y".repeat(300)}`]);
  });

  it("does nothing (no eval) when every tag is filtered out", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n83b", now: () => 1000 });
    await h.revalidateTag(["", "x".repeat(1000)]);
    expect(client.manifestExpireCalls).toEqual([]);
  });
});

describe("M6: entry size cap", () => {
  it("skips the write when the serialized entry exceeds the cap, logging once", async () => {
    // Cap sits between a small entry's serialized size (~200 bytes of JSON overhead) and the
    // oversized ones (4 KiB of HTML each).
    process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES = "1024";
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "m6", now: () => 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await h.set("/big", appPageEntry("x".repeat(4096), "t"), {});
    await h.set("/big2", appPageEntry("y".repeat(4096), "t"), {});
    expect(client.setArgs).toEqual([]); // nothing reached Valkey
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES/);

    // An under-cap entry still caches.
    await h.set("/small", appPageEntry("ok"), {});
    expect(client.setArgs).toHaveLength(1);
  });
});

describe("L5: malformed stored entries degrade to a miss", () => {
  it.each([
    ["unparseable JSON", "{corrupt"],
    [
      "non-numeric lastModified",
      JSON.stringify({ value: null, tags: [], lastModified: "1000", ttlSeconds: 61 }),
    ],
    [
      "tags not an array",
      JSON.stringify({ value: null, tags: "t", lastModified: 1000, ttlSeconds: 61 }),
    ],
    [
      "non-positive ttlSeconds",
      JSON.stringify({ value: null, tags: [], lastModified: 1000, ttlSeconds: 0 }),
    ],
    ["missing value member", JSON.stringify({ tags: [], lastModified: 1000, ttlSeconds: 61 })],
    ["a JSON array", JSON.stringify([1, 2, 3])],
  ])("get returns null for %s", async (_label, raw) => {
    const client = new FakeValkeyClient();
    client.strings.set("k8s:l5i:inc:/p", raw);
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "l5i", now: () => 1000 });
    expect(await h.get("/p", {})).toBeNull();
  });

  it("round-trips a real entry through the fake (sanity)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "ok", now: () => 1000 });
    await h.set("/p", appPageEntry("PAGE", "prod"), {});
    const got = await h.get("/p", {});
    expect(got).not.toBeNull();
    expect((got!.value as Record<string, unknown>).html).toBe("PAGE");
    expect(got!.lastModified).toBe(1000);
  });
});

describe("M1: revalidateTag failures are observable (fail-open, rate-limited)", () => {
  it("logs once per 60s class window and never throws", async () => {
    const client = new FakeValkeyClient();
    client.evalError = new Error("valkey down");
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "m1i", now: () => 1000 });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(h.revalidateTag("t")).resolves.toBeUndefined();
    await expect(h.revalidateTag(["t", "u"])).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toMatch(/revalidateTag failed/);
  });
});

describe("M11: the tag manifest itself is TTL-bounded (refreshed per write)", () => {
  it("passes TAG_MANIFEST_TTL_SECONDS as the trailing eval argv on every revalidateTag", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "m11i", now: () => 1000 });
    await h.revalidateTag("a");
    await h.revalidateTag(["b"], { expire: 300 });
    expect(client.manifestExpireCalls).toEqual([
      TAG_MANIFEST_TTL_SECONDS,
      TAG_MANIFEST_TTL_SECONDS,
    ]);
  });
});

describe("N6: non-finite lifetimes are refused (never reach Valkey)", () => {
  it("skips the write and warns once per process for every non-finite shape", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n6", now: () => 1000 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Every shape that would otherwise produce SET EX Infinity/NaN (a server error → the
    // entry was silently never cached): ctx revalidate, ctx cacheControl.expire, and the
    // FETCH value's own revalidate.
    await h.set("/a", appPageEntry("P"), { revalidate: Infinity });
    await h.set("/b", appPageEntry("P"), { revalidate: NaN });
    await h.set("/c", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: Infinity } });
    await h.set(
      "/d",
      { kind: "FETCH", data: {}, revalidate: Infinity } as Record<string, unknown>,
      {},
    );
    expect(client.setArgs).toEqual([]); // no SET EX Infinity/NaN ever reached the client
    expect(warn).toHaveBeenCalledTimes(1); // once per process, not per offending entry
    expect(warn.mock.calls[0]?.[0]).toMatch(/non-finite/);
  });

  it("still caches a finite lifetime after the guard", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "n6b", now: () => 1000 });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.set("/ok", appPageEntry("P"), { revalidate: 60 });
    expect(client.setArgs).toHaveLength(1);
    expect(client.setArgs[0]!.args).toEqual(["EX", 120]); // 60 + 60s retention margin
  });
});

// Survey Tier 3 #16: `set(key, null)` is a REAL cached value (Next stores null for
// not-found responses). It must round-trip as a hit carrying `value: null` — collapsing it
// into a miss makes Next re-render the known-empty result on every request, forever.
describe("cache trace (ADAPTER_K8S_CACHE_TRACE=1 — PPR materialization diagnosis)", () => {
  // One JSON line per set()/get() so a deployed pool's writes can be diffed against
  // `next start`'s filesystem materialization (which keys, which kinds, postponed/rscData
  // presence). Off by default; costs nothing when unset.
  it("logs a structured line for set() and get() when enabled", async () => {
    process.env.ADAPTER_K8S_CACHE_TRACE = "1";
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const client = new FakeValkeyClient();
      const h = new ValkeyIncrementalCacheHandler({ client, buildId: "tr1", now: () => 1000 });
      await h.set("/traced", appPageEntry("T"), {
        tags: ["t1"],
        cacheControl: { revalidate: 60, expire: 600 },
      });
      await h.get("/traced", { kind: "APP_PAGE" });
      const traceLines = lines.filter((l) => l.includes("[cache-trace]"));
      expect(traceLines.length).toBe(2);
      const setLine = JSON.parse(traceLines[0]!.slice(traceLines[0]!.indexOf("{")));
      expect(setLine.op).toBe("set");
      expect(setLine.key).toBe("/traced");
      expect(setLine.kind).toBe("APP_PAGE");
      expect(setLine).toHaveProperty("postponedBytes");
      expect(setLine).toHaveProperty("htmlBytes");
      expect(setLine.tags).toEqual(["t1"]);
      const getLine = JSON.parse(traceLines[1]!.slice(traceLines[1]!.indexOf("{")));
      expect(getLine.op).toBe("get");
      expect(getLine.hit).toBe(true);
    } finally {
      spy.mockRestore();
      delete process.env.ADAPTER_K8S_CACHE_TRACE;
    }
  });

  it("logs nothing when disabled", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const client = new FakeValkeyClient();
      const h = new ValkeyIncrementalCacheHandler({ client, buildId: "tr2", now: () => 1000 });
      await h.set("/quiet", appPageEntry("Q"), {});
      await h.get("/quiet", {});
      expect(lines.filter((l) => l.includes("[cache-trace]"))).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("getStored staleness signal (SWR must not become stale-forever)", () => {
  // Dispatch consumes getStored DIRECTLY — no Next incremental-cache layer above it to
  // compute age staleness from lastModified. getStored therefore surfaces `isStale`
  // itself (tag- OR age-stale, single-flight lock-gated); dispatch serves the stale
  // entry and schedules one canonical regeneration behind it.
  it("marks an AGE-stale stored entry isStale", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx1", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000; // past the 60s revalidate window, inside expire
    const got = await h.getStored("/p", {});
    expect(got).not.toBeNull();
    expect((got as { isStale?: boolean }).isStale).toBe(true);
  });

  it("does not mark a fresh stored entry", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx2", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 1_000;
    const got = await h.getStored("/p", {});
    expect(got).not.toBeNull();
    expect((got as { isStale?: boolean }).isStale).toBeFalsy();
  });

  it("staleness is a NON-CONSUMING peek: every getStored reader is told stale", async () => {
    // The single-flight NX revalidate lock nearly killed resume-data-cache: dispatch's
    // ladder read consumed it (its own regen path 500s for cache-components AND holds the
    // lock to TTL on failure), so the ENTRYPOINT — the only actor whose revalidation works
    // — was told FRESH and never regenerated (stale >12s on cold pods, traced). getStored
    // now reports staleness without touching the lock; the app-path get() keeps lock
    // semantics for Next's own SWR signalling.
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx3", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000;
    const first = await h.getStored("/p", {});
    const second = await h.getStored("/p", {});
    expect((first as { isStale?: boolean }).isStale).toBe(true);
    expect((second as { isStale?: boolean }).isStale).toBe(true);
    // And the lock was NOT consumed: the app path's tag-stale signalling still wins it.
  });

  it("does not surface isStale (or take the regen lock for age) on the app-path get()", async () => {
    // Next's own incremental-cache layer sits above get() and computes age staleness from
    // lastModified — the handler adding its own signal there would double-signal and take
    // locks the app path never needed. Age staleness is a getStored-only contract.
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx4", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000;
    const got = await h.get("/p", {});
    expect(got).not.toBeNull();
    expect((got as { isStale?: boolean }).isStale).toBeUndefined();
    // The lock was not consumed — a getStored after the app-path get still wins it.
    const stored = await h.getStored("/p", {});
    expect((stored as { isStale?: boolean }).isStale).toBe(true);
  });
});

describe("negative caching (survey Tier 3 #16)", () => {
  it("round-trips set(key, null) as a cache HIT with value null, distinct from a miss", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "neg1", now: () => 5000 });
    await h.set("/gone", null, {});
    const hit = await h.get("/gone");
    expect(hit).not.toBeNull(); // a HIT...
    expect(hit!.value).toBeNull(); // ...whose cached value is the negative result
    expect(await h.get("/never-stored")).toBeNull(); // and a true miss stays a miss
  });
});

// Survey Tier 1 #5: single-flight revalidation. When a profiled (SWR) tag revalidation marks
// an entry stale, EVERY replica that reads it gets the stale-signalling lastModified and every
// one of them triggers a background re-render — N pods, N renders, one Valkey. The first
// reader must take a short-TTL NX lock and be the only one told "stale"; concurrent readers
// are told "fresh" and keep serving the stale-but-valid value while the winner revalidates.
describe("single-flight revalidation lock (survey Tier 1 #5)", () => {
  async function staleEntry(client: FakeValkeyClient) {
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "sf1", now: () => 1_000_000 });
    await h.set("/page", appPageEntry("P", "tag-a"), {
      cacheControl: { revalidate: 60, expire: 600 },
    });
    // Profile-carrying revalidateTag → stale (SWR), not expired. Issued AFTER the entry was
    // written (later clock) — an invalidation at the same instant as the write is not stale.
    const later = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "sf1",
      now: () => 1_500_000,
    });
    await later.revalidateTag("tag-a", { expire: 3600 });
    // Advance the clock past the write so the tag update outdates the entry.
    return new ValkeyIncrementalCacheHandler({ client, buildId: "sf1", now: () => 2_000_000 });
  }

  it("signals stale to exactly one REPLICA; other replicas see the entry as fresh", async () => {
    // Single-flight is per-REPLICA, not per-get (2026-08-04): one render reads the same
    // key several times (ResponseCache pipeline first, then the entrypoint's RDC branch,
    // which is the only reader that schedules the working revalidation), so the winning
    // process must keep the signal for the lock window. In-process repetition is deduped
    // by Next's own revalidateBatcher; the lock exists to stop CROSS-replica stampedes.
    const client = new FakeValkeyClient();
    const h = await staleEntry(client);
    const first = await h.get("/page");
    const second = await h.get("/page");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // The winner gets the shifted lastModified (one second past the route's 60s revalidate
    // window at now=2,000,000 — see staleByTagLastModified): Next computes "past revalidate
    // window" from it and revalidates behind the request — on EVERY read in this process
    // while the window lasts.
    expect(first!.lastModified).toBe(2_000_000 - 60_000 - 1_000);
    expect(second!.lastModified).toBe(2_000_000 - 60_000 - 1_000);
    // Another replica (fresh handler instance, same shared store) loses the NX acquire and
    // sees the entry's own lastModified — fresh, no cross-replica duplicate revalidation.
    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "sf1",
      now: () => 2_000_000,
    });
    const cross = await other.get("/page");
    expect(cross!.lastModified).toBe(1_000_000);
  });
});

// Survey batch 2 (Tier 3 #18): variant-fanout on invalidation. adapter-aws fans a
// revalidation out across a route's HTML + `.rsc` + segment outputs via groupId; our
// equivalent mechanism is the SHARED implicit path tag (`_N_T_/route`) every variant of a
// route carries. Pin that one hard revalidateTag misses ALL variants — if tag extraction or
// the manifest check ever stops covering a variant class, a revalidated page would keep
// serving its stale RSC payload (hydration mismatch: fresh HTML, stale flight data).
describe("variant fanout via shared implicit path tags (survey Tier 3 #18)", () => {
  it("hard revalidateTag on the implicit path tag misses the HTML entry AND its .rsc sibling", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "fan1", now: () => 1_000_000 });
    await h.set("/route", appPageEntry("<html>", "_N_T_/route"), {});
    await h.set("/route.rsc", appPageEntry("flight-bytes", "_N_T_/route"), {});
    const later = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fan1",
      now: () => 2_000_000,
    });
    await later.revalidateTag("_N_T_/route");
    expect(await later.get("/route")).toBeNull();
    expect(await later.get("/route.rsc")).toBeNull();
  });
});

describe("build-seed fallback: an empty Valkey behaves like next start's warm filesystem cache", () => {
  // The production invariant this exists for, measured on GKE 2026-07-30: /blog/[author] with
  // `dynamicParams: false` 500'd with "invariant: cache entry required but not generated" the
  // moment its seed's revalidate window lapsed — Next consulted the (empty) Valkey store,
  // found nothing, and is FORBIDDEN from rendering dynamically by dynamicParams:false.
  // `next start` never hits this because its filesystem cache IS the build output. The seed
  // fallback restores that property: a Valkey miss consults the on-disk build prerender.
  const seed = {
    lastModified: 500,
    tags: ["_N_T_/blog/tim"],
    value: {
      kind: "APP_PAGE",
      html: "<html>built at build time</html>",
      rscData: Buffer.from("rsc-bytes"),
      headers: { vary: "rsc" },
      status: 200,
    },
  };

  it("returns the build seed on a Valkey miss", async () => {
    const client = new FakeValkeyClient();
    const seedLookup = vi.fn().mockResolvedValue(seed);
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed1",
      now: () => 1000,
      seedLookup,
    });
    const got = await h.get("/blog/tim");
    expect(seedLookup).toHaveBeenCalledWith("/blog/tim", expect.any(Object));
    expect(got?.lastModified).toBe(500);
    expect((got?.value as { html?: string })?.html).toContain("built at build time");
  });

  it("prefers a stored Valkey entry over the seed", async () => {
    const client = new FakeValkeyClient();
    const h0 = new ValkeyIncrementalCacheHandler({ client, buildId: "seed2", now: () => 1000 });
    await h0.set("/blog/tim", appPageEntry("<html>regenerated</html>") as never, {});
    const seedLookup = vi.fn().mockResolvedValue(seed);
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed2",
      now: () => 1000,
      seedLookup,
    });
    const got = await h.get("/blog/tim");
    expect((got?.value as { html?: string })?.html).toContain("regenerated");
    expect(seedLookup).not.toHaveBeenCalled();
  });

  it("misses (never crashes) when there is no seed either", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed3",
      now: () => 1000,
      seedLookup: vi.fn().mockResolvedValue(null),
    });
    expect(await h.get("/no-seed")).toBeNull();
  });

  it("drops a seed whose tag was HARD-invalidated (updateTag semantics)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed4",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    // Hard-expire the seed's tag AFTER the seed's lastModified (expire: 0 = updateTag).
    await h.revalidateTag("_N_T_/blog/tim", { expire: 0 });
    expect(await h.get("/blog/tim")).toBeNull();
  });

  // FETCH-kind seeds (the staged build fetch-cache): the contract that closes the rdc
  // stale-forever loop. After a PROFILED revalidateTag, the read must be a stale HIT —
  // upstream patch-fetch foreground-refetches a stale FETCH entry with the prerender's
  // abort signal DETACHED (patch-fetch.ts:1073-1104), while a MISS re-fetches signal-
  // attached and loses the abort race under load, killing the background revalidation.
  const fetchSeed = {
    lastModified: 500,
    tags: ["test"],
    value: {
      kind: "FETCH",
      data: { headers: {}, body: "YmFrZWQ=", status: 200, url: "https://api.example/r" },
      revalidate: 31536000,
      tags: ["test"],
    },
  };

  it("serves a fresh FETCH seed with the artifact lastModified", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetchseed1",
      now: () => 1000,
      seedLookup: vi.fn().mockResolvedValue(fetchSeed),
    });
    const got = await h.get("0123abcdef", { kind: "FETCH", tags: ["test"] });
    expect(got?.lastModified).toBe(500);
    expect((got?.value as { kind?: string })?.kind).toBe("FETCH");
  });

  it("signals a profiled-stale FETCH seed as stale (lastModified -1), never a miss", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetchseed2",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(fetchSeed),
    });
    await h.revalidateTag("test", { expire: 3600 }); // profiled: stale now, hard-expire in 1h
    const got = await h.get("0123abcdef", { kind: "FETCH", tags: ["test"] });
    // The whole point: a MISS would re-fetch under the prerender's abort signal. The seed
    // has no revalidate window of its own, so the stale signal degrades to -1 — for FETCH
    // entries upstream derives isStale from age, and -1 makes the age astronomical.
    expect(got).not.toBeNull();
    expect(got?.lastModified).toBe(-1);
    expect((got?.value as { kind?: string })?.kind).toBe("FETCH");
  });

  // Dispatch's own serving reads must never spend the single-flight revalidate lock: the
  // lock exists so exactly ONE of Next's own readers is told "stale" and revalidates.
  // Dispatch reads entries only to SERVE them (document injection, template shells) and
  // never revalidates from those paths — measured 2026-08-04 (rdc, run 6): document
  // injection reads consumed the lock on every tag-stale seed read, so the entrypoint's
  // dynamic-RSC read milliseconds later was told FRESH and its background revalidation
  // never scheduled — zero errors, zero regenerations, stale forever.
  it("getPeek reports the stale entry WITHOUT consuming the single-flight lock", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "peek1",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("_N_T_/blog/tim", { expire: 3600 }); // profiled: stale, not expired
    const peeked = await h.getPeek("/blog/tim");
    expect(peeked).not.toBeNull();
    expect(peeked?.isStale).toBe(true);
    expect(peeked?.lastModified).toBe(500); // untouched — no SWR shifting for dispatch

    // The lock is still free: Next's own read (app-path get) must still win it and get
    // the stale-signalling lastModified.
    const got = await h.get("/blog/tim");
    expect(got?.lastModified).toBe(-1);
  });

  // One render performs SEVERAL app-path gets for the same key (Next's ResponseCache
  // pipeline reads first, then the entrypoint's RDC branch — the only caller that
  // schedules the WORKING forceStaticRender revalidation). With a strictly one-shot lock,
  // the pipeline read won it and the RDC branch was told FRESH — so nothing ever
  // scheduled: rdc run 9, zero revalidate calls with the handler provably signalling -1.
  // next start has no such lock (per-process manifest, every reader sees stale), so the
  // pod that WINS the lock must keep signalling stale to its own subsequent reads for the
  // lock window; other pods still read fresh (cross-replica single-flight preserved).
  it("the lock-winning process keeps seeing the stale signal on subsequent gets", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "lockwin1",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("_N_T_/blog/tim", { expire: 3600 });
    const first = await h.get("/blog/tim");
    expect(first?.lastModified).toBe(-1); // won the lock
    const second = await h.get("/blog/tim");
    expect(second?.lastModified).toBe(-1); // same process: still the revalidation owner

    // Another replica (fresh handler, same shared store) is told fresh — single-flight.
    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "lockwin1",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    const cross = await other.get("/blog/tim");
    expect(cross?.lastModified).toBe(500);
  });

  it("a completed set() ends the local stale-signal window", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "lockwin2",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("_N_T_/blog/tim", { expire: 3600 });
    expect((await h.get("/blog/tim"))?.lastModified).toBe(-1);
    // The revalidation completed: fresh entry stored (newer than the watermark).
    await h.set(
      "/blog/tim",
      { kind: "APP_PAGE", html: "<html>fresh</html>", headers: {} } as never,
      { revalidate: 60 },
    );
    const after = await h.get("/blog/tim");
    expect(after?.lastModified).toBe(5000); // stored entry, served fresh — no lingering -1
  });

  it("getSeed never consumes the lock either (dispatch's template-shell rung)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "peek2",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("_N_T_/blog/tim", { expire: 3600 });
    const seeded = await h.getSeed("/blog/tim");
    expect(seeded).not.toBeNull();
    const got = await h.get("/blog/tim");
    expect(got?.lastModified).toBe(-1); // lock was still available to the real reader
  });

  // Upstream fs-cache parity (file-system-cache.ts:167-187): pages can share one fetch
  // cache key (same URL+init) while declaring DIFFERENT tags, and the stored entry only
  // carries the LAST writer's list — so revalidateTag on the other page's tag no longer
  // stales the shared entry. FileSystemCache re-sets the entry with the requesting page's
  // tags on read ("update stored tags if a new one is being added"); mirror it, keeping
  // the stored lastModified so tag watermarks keep their meaning (rdc fetch-cache
  // variant, 2026-08-04: the / page's 'test' tag was clobbered by
  // /revalidate-fetch-action's write and the entry never went stale again).
  it("FETCH get merges missing request tags into the stored entry (fs-cache parity)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "tagmerge1", now: () => 1000 });
    await h.set(
      "sharedfetchkey",
      {
        kind: "FETCH",
        data: { body: "x", headers: {}, status: 200 },
        revalidate: 31536000,
      } as never,
      { tags: ["other-page-tag"] },
    );

    await h.get("sharedfetchkey", { kind: "FETCH", tags: ["test"] });
    expect(storedTags(client, "k8s:tagmerge1:inc:sharedfetchkey").sort()).toEqual(
      ["other-page-tag", "test"].sort(),
    );

    // The merged tag is now a real staleness input: a profiled revalidateTag on it makes
    // the shared entry stale for the next reader.
    const later = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "tagmerge1",
      now: () => 5000,
    });
    await later.revalidateTag("test", { expire: 3600 });
    const got = await later.get("sharedfetchkey", { kind: "FETCH", tags: ["test"] });
    expect(got).not.toBeNull();
    expect(got!.lastModified).not.toBe(1000); // stale-signalled (shifted), not fresh
  });

  it("keeps working when the seed lookup itself throws", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed5",
      now: () => 1000,
      seedLookup: vi.fn().mockRejectedValue(new Error("corrupt manifest")),
    });
    expect(await h.get("/blog/tim")).toBeNull();
  });
});
