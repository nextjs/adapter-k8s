import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ValkeyClient,
  ValkeyMulti,
} from "../../../src/pool-server/valkey-cache/resp-client.js";
import {
  STORE_INCREMENTAL_ENTRY_SCRIPT,
  ValkeyIncrementalCacheHandler,
} from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";
import { resetLogSuppressionForTests } from "../../../src/pool-server/valkey-cache/stream-codec.js";
import { TAG_MANIFEST_TTL_SECONDS } from "../../../src/pool-server/valkey-cache/tag-manifest.js";
import { READ_VALKEY_TIME_SCRIPT } from "../../../src/pool-server/valkey-cache/valkey-clock.js";

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
  /** Server time used by atomic entry writes. Zero lets the write use the handler's test clock. */
  serverNow = 0;
  private observedServerNow = 0;

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
    if (String(args[0]) === READ_VALKEY_TIME_SCRIPT) {
      return this.serverNow || this.observedServerNow;
    }
    if (String(args[0]) === STORE_INCREMENTAL_ENTRY_SCRIPT) {
      if (this.setError) throw this.setError;
      const key = String(args[2]);
      const entry = JSON.parse(String(args[3])) as Record<string, unknown>;
      const clientNow = Number(args[5]);
      const serverNow = this.serverNow || clientNow;
      this.observedServerNow = serverNow;
      entry.lastModified = serverNow;
      const value = JSON.stringify(entry);
      this.strings.set(key, value);
      this.setArgs.push({ key, value, args: ["EX", Number(args[4])] });
      return Math.abs(serverNow - clientNow) > 60_000 ? 1 : 0;
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
    // args: [script, numkeys, key, field, json, field, json, ..., ttlSeconds] — the trailing
    // ttl refreshes the manifest key's expiry (M11); the naive store skips the merge (the
    // Docker integration tests cover the real script's semantics).
    this.manifestExpireCalls.push(Number(args[args.length - 1]));
    for (let i = 3; i + 1 < args.length - 1; i += 2) {
      const state = JSON.parse(String(args[i + 1])) as { at?: number };
      if (!this.serverNow && typeof state.at === "number") this.observedServerNow = state.at;
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

describe("getStored staleness signal (SWR must not become stale-forever)", () => {
  // Dispatch consumes getStored DIRECTLY — no Next incremental-cache layer above it to
  // compute age staleness from lastModified. getStored therefore surfaces `isStale`
  // itself (tag- or age-stale); dispatch serves the stale
  // entry and schedules one canonical regeneration behind it.
  it("marks an AGE-stale stored entry isStale", async () => {
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx1", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000; // past the 60s revalidate window, inside expire
    client.serverNow = clock.t;
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
    client.serverNow = clock.t;
    const got = await h.getStored("/p", {});
    expect(got).not.toBeNull();
    expect((got as { isStale?: boolean }).isStale).toBeFalsy();
  });

  it("staleness is a NON-CONSUMING peek: every getStored reader is told stale", async () => {
    // Dispatch must not change what the entrypoint sees. Each serving read reports the same
    // staleness state independently.
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx3", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000;
    client.serverNow = clock.t;
    const first = await h.getStored("/p", {});
    const second = await h.getStored("/p", {});
    expect((first as { isStale?: boolean }).isStale).toBe(true);
    expect((second as { isStale?: boolean }).isStale).toBe(true);
  });

  it("does not surface isStale for age on the app-path get()", async () => {
    // Next's own incremental-cache layer sits above get() and computes age staleness from
    // lastModified. Age staleness is a getStored-only contract.
    const client = new FakeValkeyClient();
    const clock = { t: 1_000_000 };
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "cx4", now: () => clock.t });
    await h.set("/p", appPageEntry("P"), { cacheControl: { revalidate: 60, expire: 6000 } });
    clock.t += 120_000;
    client.serverNow = clock.t;
    const got = await h.get("/p", {});
    expect(got).not.toBeNull();
    expect((got as { isStale?: boolean }).isStale).toBeUndefined();
    // A later dispatch read still reports age staleness.
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

describe("cross-replica stale signalling", () => {
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

  it("signals stale to every replica until a fresh value is stored", async () => {
    const client = new FakeValkeyClient();
    const h = await staleEntry(client);
    const first = await h.get("/page");
    const second = await h.get("/page");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Every reader gets the shifted lastModified (one second past the route's 60s revalidate
    // window at now=2,000,000 — see staleByTagLastModified): Next computes "past revalidate
    // window" from it and revalidates behind the request.
    expect(first!.lastModified).toBe(2_000_000 - 60_000 - 1_000);
    expect(second!.lastModified).toBe(2_000_000 - 60_000 - 1_000);
    // A second replica must not be told the stale value is fresh. Next deduplicates within one
    // process; duplicate work across replicas is the correctness-first fallback.
    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "sf1",
      now: () => 2_000_000,
    });
    const cross = await other.get("/page");
    expect(cross!.lastModified).toBe(2_000_000 - 60_000 - 1_000);
  });
});

describe("shared-clock regeneration ordering", () => {
  it("keeps a regeneration written after a hard invalidation when the writer clock is behind", async () => {
    const client = new FakeValkeyClient();
    client.tagFields.set("_N_T_/page", JSON.stringify({ expired: 2_000, at: 2_000 }));
    client.serverNow = 2_001;

    // The pod clock is behind the shared Valkey clock. A client-stamped write at 1,000 would be
    // classified as older than the already-consumed hard invalidation and deleted on its first
    // read, even though the SET reached Valkey afterwards.
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "server-order",
      now: () => 1_000,
    });
    await h.set("/page", appPageEntry("fresh", "_N_T_/page"), {});

    const raw = client.strings.get("k8s:server-order:inc:/page");
    expect(raw).toBeDefined();
    expect(raw).toMatch(/^\{"lastModified":/);
    expect((JSON.parse(raw!) as { lastModified: number }).lastModified).toBe(2_001);
    expect(await h.get("/page", {})).not.toBeNull();
  });

  it("preserves one server-measured age for fast and slow readers", async () => {
    const client = new FakeValkeyClient();
    const server = { t: 5_000_000 };
    client.serverNow = server.t;
    const writer = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "reader-offsets",
      now: () => server.t - 300_000,
    });
    await writer.set("/page", appPageEntry("fresh"), {
      cacheControl: { revalidate: 60, expire: 600 },
    });

    server.t += 30_000;
    client.serverNow = server.t;
    const fastNow = server.t + 300_000;
    const slowNow = server.t - 300_000;
    const fast = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "reader-offsets",
      now: () => fastNow,
    });
    const slow = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "reader-offsets",
      now: () => slowNow,
    });
    const fastEntry = await fast.get("/page");
    const slowEntry = await slow.get("/page");
    expect(fastNow - fastEntry!.lastModified!).toBe(30_000);
    expect(slowNow - slowEntry!.lastModified!).toBe(30_000);
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

  it("unifies encoded Unicode page keys with the decoded build manifest key", async () => {
    const client = new FakeValkeyClient();
    const seedLookup = vi
      .fn()
      .mockImplementation(async (key: string) => (key === "/🎉" ? seed : null));
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "seed-unicode",
      now: () => 1000,
      seedLookup,
    });

    const seeded = await h.get("/%F0%9F%8E%89", { kind: "APP_PAGE" });
    expect(seeded?.value).toEqual(seed.value);
    expect(seedLookup).toHaveBeenCalledWith("/🎉", expect.any(Object));

    await h.set(
      "/%F0%9F%8E%89",
      { kind: "APP_PAGE", html: "<html>regenerated</html>", headers: {} } as never,
      { revalidate: 60 },
    );
    const stored = await h.getStored("/🎉", { kind: "APP_PAGE" });
    expect((stored?.value as { html?: string })?.html).toContain("regenerated");
  });

  it("preserves an encoded slash while canonicalizing pathname cache keys", async () => {
    const seedLookup = vi.fn().mockResolvedValue(null);
    const h = new ValkeyIncrementalCacheHandler({
      client: new FakeValkeyClient(),
      buildId: "seed-delimiter",
      now: () => 1000,
      seedLookup,
    });

    await h.get("/a%2Fb", { kind: "APP_PAGE" });
    expect(seedLookup).toHaveBeenCalledWith("/a%2Fb", expect.any(Object));
  });

  it("keeps encoded and double-encoded delimiters in separate cache entries", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "delimiter-identity",
      now: () => 1000,
    });

    await h.set("/a/%2F", appPageEntry("encoded slash") as never, {});
    await h.set("/a/%252F", appPageEntry("literal percent spelling") as never, {});

    expect((await h.getStored("/a/%2F"))?.value).toEqual(appPageEntry("encoded slash"));
    expect((await h.getStored("/a/%252F"))?.value).toEqual(
      appPageEntry("literal percent spelling"),
    );
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

  // FETCH-kind seeds (the staged build fetch-cache): a profiled revalidateTag must remain a
  // stale hit. During static generation patch-fetch turns that signal into doOriginalFetch(true),
  // which detaches the prerender abort signal before refreshing.
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

  it("signals a profiled-stale FETCH seed to every replica", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetchseed2",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(fetchSeed),
    });
    await h.revalidateTag("test", { expire: 3600 }); // profiled: stale now, hard-expire in 1h
    const winner = await h.get("0123abcdef", { kind: "FETCH", tags: ["test"] });
    expect(winner).not.toBeNull();
    expect((5000 - winner!.lastModified!) / 1000).toBeGreaterThan(31_536_000);
    expect((winner?.value as { kind?: string })?.kind).toBe("FETCH");

    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetchseed2",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(fetchSeed),
    });
    const stale = await other.get("0123abcdef", { kind: "FETCH", tags: ["test"] });
    expect((5000 - stale!.lastModified!) / 1000).toBeGreaterThan(31_536_000);
    expect((stale?.value as { kind?: string })?.kind).toBe("FETCH");
  });

  it("uses the current FETCH read lifetime when signalling a stale build seed", async () => {
    const client = new FakeValkeyClient();
    const now = 1_800_000_000_000;
    const currentRevalidate = 4_294_967_294;
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetch-current-seed",
      now: () => now,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("test", { expire: 3600 });

    const got = await h.get("0123abcdef", {
      kind: "FETCH",
      tags: ["test"],
      revalidate: currentRevalidate,
    });
    expect(got).not.toBeNull();
    expect((now - got!.lastModified!) / 1000).toBeGreaterThan(currentRevalidate);
  });

  it("keeps SWR for a stored stale FETCH whose lifetime fits before the current epoch", async () => {
    const client = new FakeValkeyClient();
    let now = 1_787_916_225_000;
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetchstoredfit1",
      now: () => now,
    });
    await h.set(
      "ordinary-fetch",
      {
        kind: "FETCH",
        data: { body: "stale", headers: {}, status: 200 },
        revalidate: 31_536_000,
      },
      { tags: ["test"] },
    );
    now += 1;
    await h.revalidateTag("test", { expire: 3600 });

    const winner = await h.get("ordinary-fetch", { kind: "FETCH", tags: ["test"] });
    expect(winner).not.toBeNull();
    expect(winner?.lastModified).toBe(now - 31_536_000 * 1000 - 1000);
    expect((winner?.value as { kind?: string })?.kind).toBe("FETCH");
  });

  it("uses the current FETCH read lifetime when signalling a stale stored entry", async () => {
    const client = new FakeValkeyClient();
    let now = 1_800_000_000_000;
    const currentRevalidate = 4_294_967_294;
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "fetch-current-stored",
      now: () => now,
    });
    await h.set(
      "ordinary-fetch",
      {
        kind: "FETCH",
        data: { body: "stale", headers: {}, status: 200 },
        revalidate: 31_536_000,
      },
      { tags: ["test"] },
    );
    now += 1;
    await h.revalidateTag("test", { expire: 3600 });

    const got = await h.get("ordinary-fetch", {
      kind: "FETCH",
      tags: ["test"],
      revalidate: currentRevalidate,
    });
    expect(got).not.toBeNull();
    expect((now - got!.lastModified!) / 1000).toBeGreaterThan(currentRevalidate);
  });

  it.each(["tag", "age"] as const)(
    "signals every cross-replica %s-stale FETCH read",
    async (staleBy) => {
      const client = new FakeValkeyClient();
      let now = 1_000;
      const options = {
        client,
        buildId: `atomic-${staleBy}`,
        now: () => now,
      };
      const winnerHandler = new ValkeyIncrementalCacheHandler(options);
      const loserHandler = new ValkeyIncrementalCacheHandler(options);
      await winnerHandler.set(
        "shared-fetch",
        {
          kind: "FETCH",
          data: { body: "old", headers: {}, status: 200 },
          revalidate: staleBy === "age" ? 1 : 3600,
        },
        { tags: ["shared"] },
      );
      now = staleBy === "age" ? 2_001 : 1_001;
      client.serverNow = now;
      if (staleBy === "tag") await winnerHandler.revalidateTag("shared", { expire: 3600 });

      const [winner, loser] = await Promise.all([
        winnerHandler.get("shared-fetch", { kind: "FETCH", tags: ["shared"] }),
        loserHandler.get("shared-fetch", { kind: "FETCH", tags: ["shared"] }),
      ]);
      expect(winner).not.toBeNull();
      expect(loser).not.toBeNull();
      expect(winner?.lastModified).toBe(loser?.lastModified);
      expect(winner?.lastModified).not.toBe(now);
    },
  );

  it("getPeek reports staleness without changing the app-path signal", async () => {
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

    // Next's own read still gets the stale-signalling lastModified.
    const got = await h.get("/blog/tim");
    expect(got?.lastModified).toBe(-1);
  });

  it("every process keeps seeing the stale seed until regeneration stores a replacement", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "lockwin1",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    await h.revalidateTag("_N_T_/blog/tim", { expire: 3600 });
    const first = await h.get("/blog/tim");
    expect(first?.lastModified).toBe(-1);
    const second = await h.get("/blog/tim");
    expect(second?.lastModified).toBe(-1);

    // Another replica is also told stale; hiding the signal could lose regeneration entirely.
    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "lockwin1",
      now: () => 5000,
      seedLookup: vi.fn().mockResolvedValue(seed),
    });
    const cross = await other.get("/blog/tim");
    expect(cross?.lastModified).toBe(-1);
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

  it("getSeed does not change the app-path stale signal", async () => {
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
    expect(got?.lastModified).toBe(-1);
  });

  // Pages and cache-components renders can share one FETCH key while declaring different tags.
  // FileSystemCache updates the FETCH value's tag metadata on read. Rewriting our whole entry to
  // do that would let a late read resurrect a concurrent regeneration's old body and timestamp.
  it("persists current FETCH tags in companion metadata without rewriting the entry", async () => {
    const client = new FakeValkeyClient();
    let now = 1000;
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "tagmerge1", now: () => now });
    await h.set(
      "sharedfetchkey",
      {
        kind: "FETCH",
        data: { body: "x", headers: {}, status: 200 },
        revalidate: 31536000,
      } as never,
      { tags: ["other-page-tag"] },
    );

    now = 1001;
    client.serverNow = now;
    await h.revalidateTag("other-page-tag");
    const entryKey = "k8s:tagmerge1:inc:sharedfetchkey";
    const primaryBefore = client.strings.get(entryKey);
    const current = await h.get("sharedfetchkey", { kind: "FETCH", tags: ["test"] });
    // FileSystemCache checks current request tags for FETCH freshness. A tag belonging to a prior
    // consumer of the same fetch key must not expire this request.
    expect(current).not.toBeNull();
    expect((current!.value as { tags?: string[] }).tags).toEqual(["test"]);
    expect(client.strings.get(entryKey)).toBe(primaryBefore);
    expect(storedTags(client, "k8s:tagmerge1:inc:sharedfetchkey")).toEqual(["other-page-tag"]);
    expect(JSON.parse(client.strings.get("k8s:tagmerge1:inc-fetch-tags:sharedfetchkey")!)).toEqual([
      "test",
    ]);

    // A later request sees FileSystemCache-compatible value metadata even without adding a tag.
    const nextRequest = await h.get("sharedfetchkey", { kind: "FETCH" });
    expect(nextRequest).not.toBeNull();
    expect((nextRequest!.value as { tags?: string[] }).tags).toEqual(["test"]);

    // The request tag is still a real staleness input on every matching read.
    const revalidateNow = 1_787_916_225_000;
    const later = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "tagmerge1",
      now: () => revalidateNow,
    });
    await later.revalidateTag("test", { expire: 3600 });
    const winner = await later.get("sharedfetchkey", { kind: "FETCH", tags: ["test"] });
    expect(winner).not.toBeNull();
    expect(winner?.lastModified).not.toBe(1000);

    const other = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "tagmerge1",
      now: () => revalidateNow,
    });
    const stale = await other.get("sharedfetchkey", { kind: "FETCH", tags: ["test"] });
    expect(stale?.lastModified).toBe(winner?.lastModified);
  });

  it("does not delete an old hard-expired entry after a concurrent writer could replace it", async () => {
    const client = new FakeValkeyClient();
    let now = 1000;
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "keep-expired",
      now: () => now,
    });
    await h.set("shared", appPageEntry("old", "tag"), {});
    now = 1001;
    await h.revalidateTag("tag");

    expect(await h.get("shared", { kind: "APP_PAGE" })).toBeNull();
    expect(client.strings.has("k8s:keep-expired:inc:shared")).toBe(true);
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
