import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ValkeyClient,
  ValkeyMulti,
} from "../../../src/pool-server/valkey-cache/resp-client.js";
import { ValkeyIncrementalCacheHandler } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";

// Unit tests for the classic incremental handler's tag caps (L9), size cap (M6), malformed-entry
// handling (L5) and observable invalidation failures (M1) — no Docker needed.

type Arg = string | number | Buffer;

class FakeValkeyClient implements ValkeyClient {
  readonly strings = new Map<string, string>();
  readonly tagFields = new Map<string, string>();
  readonly setArgs: { key: string; value: string; args: Arg[] }[] = [];
  evalError: Error | null = null;

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string | Buffer, ...args: Arg[]): Promise<string | null> {
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
    for (let i = 3; i + 1 < args.length; i += 2) {
      this.tagFields.set(String(args[i]), String(args[i + 1]));
    }
    return 1;
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

afterEach(() => {
  delete process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES;
  vi.restoreAllMocks();
});

describe("L9: extractTags caps", () => {
  it("caps the tag list at 128 entries", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "l9", now: () => 1000 });
    const tags = Array.from({ length: 200 }, (_, i) => `tag-${i}`);
    await h.set("/p", appPageEntry("P"), { tags });
    const stored = storedTags(client, "k8s:l9:inc:/p");
    expect(stored).toHaveLength(128);
    expect(stored[0]).toBe("tag-0"); // keeps the first tags in declared order
    expect(stored[127]).toBe("tag-127");
  });

  it("drops tags longer than 256 chars (manually-set x-next-cache-tags)", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "l9b", now: () => 1000 });
    const long = "x".repeat(257);
    const ok = "y".repeat(256);
    await h.set("/p", appPageEntry("P", `${long},keep,${ok}`), {});
    expect(storedTags(client, "k8s:l9b:inc:/p")).toEqual(["keep", ok]);
  });

  it("drops empty segments from a messy header", async () => {
    const client = new FakeValkeyClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "l9c", now: () => 1000 });
    await h.set("/p", appPageEntry("P", " , a,, b ,"), {});
    expect(storedTags(client, "k8s:l9c:inc:/p")).toEqual(["a", "b"]);
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
