import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bufferToStream,
  drainEntryValue,
  maxCacheEntryBytes,
} from "../../../src/pool-server/valkey-cache/stream-codec.js";
import type { CacheEntry } from "../../../src/pool-server/valkey-cache/types.js";

// Unit tests for the value-stream drain, including the M6 size cap (an over-cap entry degrades
// to a miss, matching the partial-stream policy) and the env-configurable cap.

function entryOf(text: string): CacheEntry {
  return {
    value: bufferToStream(Buffer.from(text, "utf8")),
    tags: [],
    stale: 300,
    timestamp: 1000,
    expire: 300,
    revalidate: 60,
  };
}

/** A multi-chunk stream entry, so the cap is exercised across chunk boundaries. */
function chunkedEntry(chunks: string[]): CacheEntry {
  const entry = entryOf("");
  entry.value = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk, "utf8"));
      controller.close();
    },
  });
  return entry;
}

afterEach(() => {
  delete process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES;
  vi.restoreAllMocks();
});

describe("drainEntryValue", () => {
  it("drains an under-cap stream to a Buffer and leaves the entry's stream readable", async () => {
    const entry = entryOf("hello world");
    const buf = await drainEntryValue(entry, 1024);
    expect(buf?.toString("utf8")).toBe("hello world");
    // The tee'd branch handed back to the entry still delivers the full body.
    const reread = await drainEntryValue(entry, 1024);
    expect(reread?.toString("utf8")).toBe("hello world");
  });

  it("accepts a body of exactly maxBytes", async () => {
    const body = "x".repeat(64);
    const buf = await drainEntryValue(entryOf(body), 64);
    expect(buf?.toString("utf8")).toBe(body);
  });

  it("returns null when the accumulated body exceeds maxBytes (M6)", async () => {
    const buf = await drainEntryValue(chunkedEntry(["a".repeat(40), "b".repeat(40)]), 64);
    expect(buf).toBeNull();
  });

  it("returns null when a single chunk exceeds maxBytes", async () => {
    const buf = await drainEntryValue(entryOf("x".repeat(65)), 64);
    expect(buf).toBeNull();
  });

  it("returns null for an errored stream (existing partial-stream policy)", async () => {
    const entry = entryOf("");
    entry.value = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial"));
        controller.error(new Error("boom"));
      },
    });
    expect(await drainEntryValue(entry, 1024)).toBeNull();
  });

  it("defaults to the ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES env cap", async () => {
    process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES = "16";
    expect(await drainEntryValue(entryOf("x".repeat(17)))).toBeNull();
    expect((await drainEntryValue(entryOf("x".repeat(16))))?.length).toBe(16);
  });

  it("logs the oversize skip at most once per process", async () => {
    // Fresh module state so the once-per-process flag starts unset regardless of test order.
    vi.resetModules();
    const codec = await import("../../../src/pool-server/valkey-cache/stream-codec.js");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await codec.drainEntryValue(entryOf("x".repeat(100)), 8)).toBeNull();
    expect(await codec.drainEntryValue(entryOf("y".repeat(100)), 8)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES/);
  });
});

describe("maxCacheEntryBytes", () => {
  it("defaults to 16 MiB", () => {
    expect(maxCacheEntryBytes()).toBe(16 * 1024 * 1024);
  });

  it("honors a valid env override", () => {
    process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES = "1024";
    expect(maxCacheEntryBytes()).toBe(1024);
  });

  it("falls back to the default on invalid env values", () => {
    for (const bad of ["abc", "-5", "0", "NaN", "Infinity"]) {
      process.env.ADAPTER_K8S_MAX_CACHE_ENTRY_BYTES = bad;
      expect(maxCacheEntryBytes()).toBe(16 * 1024 * 1024);
    }
  });
});
