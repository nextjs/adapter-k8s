import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bufferToStream } from "../../../src/pool-server/valkey-cache/stream-codec.js";
import {
  computeTagUpdate,
  MAX_CLOCK_SKEW_MS,
  TAG_MANIFEST_TTL_SECONDS,
  UPDATE_TAGS_SCRIPT,
} from "../../../src/pool-server/valkey-cache/tag-manifest.js";
import type { CacheEntry } from "../../../src/pool-server/valkey-cache/types.js";
import { ValkeyCacheHandler } from "../../../src/pool-server/valkey-cache/use-cache-handler.js";

// Integration test against a real ephemeral Valkey (Docker). Skipped when Docker is
// unavailable so `npm test` stays green on machines without it.

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEntry(
  text: string,
  opts: {
    tags?: string[];
    timestamp: number;
    revalidate?: number;
    expire?: number;
    stale?: number;
  },
): CacheEntry {
  return {
    value: bufferToStream(Buffer.from(text, "utf8")),
    tags: opts.tags ?? [],
    stale: opts.stale ?? 300,
    timestamp: opts.timestamp,
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

describe.skipIf(!dockerAvailable)("ValkeyCacheHandler (integration)", () => {
  const containerName = `adapter-k8s-valkey-test-${process.pid}`;
  let url = "";
  const clients: Redis[] = [];

  const newClient = () => {
    const c = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    clients.push(c);
    return c;
  };

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
    const portLine = docker(["port", containerName, "6379/tcp"]).split("\n")[0];
    const port = Number(portLine.split(":").pop());
    url = `redis://127.0.0.1:${port}`;
    // wait for readiness
    for (let i = 0; i < 60; i++) {
      try {
        if (docker(["exec", containerName, "valkey-cli", "ping"]) === "PONG") break;
      } catch {
        /* not ready */
      }
      await sleep(200);
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      /* already gone */
    }
  });

  it("round-trips a value and reports it fresh within the revalidate window", async () => {
    const h = new ValkeyCacheHandler({ client: newClient(), buildId: "b1", now: () => 1000 });
    await h.set("k", Promise.resolve(makeEntry("hello-world", { timestamp: 1000, tags: ["t"] })));
    const got = await h.get("k", []);
    expect(got).toBeDefined();
    expect(got?.revalidate).toBe(60);
    expect(await readStream(got!.value)).toBe("hello-world");
  });

  it("namespaces by build id (a different build cannot see the entry)", async () => {
    const a = new ValkeyCacheHandler({ client: newClient(), buildId: "buildA", now: () => 1000 });
    const b = new ValkeyCacheHandler({ client: newClient(), buildId: "buildB", now: () => 1000 });
    await a.set("shared", Promise.resolve(makeEntry("A-only", { timestamp: 1000 })));
    expect(await a.get("shared", [])).toBeDefined();
    expect(await b.get("shared", [])).toBeUndefined();
  });

  it("serves stale (revalidate:-1) past revalidate, then expires past expire", async () => {
    const clock = { t: 1000 };
    const h = new ValkeyCacheHandler({ client: newClient(), buildId: "b-ttl", now: () => clock.t });
    await h.set(
      "k",
      Promise.resolve(makeEntry("v", { timestamp: 1000, revalidate: 60, expire: 300 })),
    );
    clock.t = 1000 + 61_000; // past revalidate (60s), within expire (300s)
    expect((await h.get("k", []))?.revalidate).toBe(-1);
    clock.t = 1000 + 301_000; // past expire
    expect(await h.get("k", [])).toBeUndefined();
  });

  it("getExpiration returns the max expired watermark for tags", async () => {
    const h = new ValkeyCacheHandler({ client: newClient(), buildId: "b-exp", now: () => 5000 });
    await h.updateTags(["x"], { expire: 300 });
    expect(await h.getExpiration(["x"])).toBe(5000 + 300_000);
    expect(await h.getExpiration(["never"])).toBe(0);
  });

  it("a concurrent get waits for an in-flight set (single-flight)", async () => {
    const h = new ValkeyCacheHandler({ client: newClient(), buildId: "b-sf", now: () => 1000 });
    let resolveEntry!: (e: CacheEntry) => void;
    const pending = new Promise<CacheEntry>((r) => {
      resolveEntry = r;
    });
    const setP = h.set("k", pending);
    const getP = h.get("k", []); // must await the in-flight set
    await sleep(50);
    resolveEntry(makeEntry("late", { timestamp: 1000 }));
    await setP;
    const got = await getP;
    expect(got).toBeDefined();
    expect(await readStream(got!.value)).toBe("late");
  });

  it("CROSS-REPLICA: updateTags on handler A invalidates get on handler B", async () => {
    const clock = { t: 1000 };
    const a = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "shared-build",
      now: () => clock.t,
    });
    const b = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "shared-build",
      now: () => clock.t,
    });

    // A writes an entry tagged "prod"; B (a different replica) can read it.
    await a.set("page", Promise.resolve(makeEntry("v1", { timestamp: 1000, tags: ["prod"] })));
    await b.refreshTags();
    expect(await readStream((await b.get("page", []))!.value)).toBe("v1");

    // A revalidates the tag (hard, no duration → immediate expiry) at a later time.
    clock.t = 2000;
    await a.updateTags(["prod"]);

    // B, on its next request, sees the shared manifest and drops the entry.
    await b.refreshTags();
    expect(await b.get("page", [])).toBeUndefined();
  });

  it("CROSS-REPLICA revalidation is visible LIVE without refreshTags", async () => {
    // Reproduces the live bug: a replica that did NOT handle the revalidateTag must still see
    // it immediately (get/getExpiration read the shared manifest live, not a stale snapshot).
    const a = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "live-build",
      now: () => 2000,
    });
    const b = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "live-build",
      now: () => 3000,
    });
    await a.set("e", Promise.resolve(makeEntry("v1", { timestamp: 1000, tags: ["live"] })));
    expect(await b.get("e", [])).toBeDefined();

    await a.updateTags(["live"]); // A revalidates at now=2000 (after the entry's timestamp)
    // B never calls refreshTags; a live read must still see the invalidation.
    expect(await b.get("e", [])).toBeUndefined();
    expect(await b.getExpiration(["live"])).toBeGreaterThan(0);
  });

  it("updateTags merge is last-event-wins on the SERVER clock (client clocks don't order events)", async () => {
    // The Lua merge stamps each event with the Valkey server's TIME, so ARRIVAL ORDER — not the
    // (possibly skewed) client clock — decides which event wins. Here the second event carries
    // the OLDER client clock yet still wins, because it reached the server later. (Pre-L7 this
    // merge compared client-stamped `at`s, so a backward-stepping replica's invalidation was
    // silently dropped.)
    const ahead = new ValkeyCacheHandler({ client: newClient(), buildId: "lew", now: () => 9000 });
    const behind = new ValkeyCacheHandler({ client: newClient(), buildId: "lew", now: () => 5000 });
    await ahead.updateTags(["t"], { expire: 300 }); // expired = 9000 + 300_000, arrives first
    await behind.updateTags(["t"]); // hard-expire (expired = 5000), arrives LATER → wins
    expect(await ahead.getExpiration(["t"])).toBe(5000);
  });

  it("updateTags merge: a later-arriving profiled revalidation wins over an earlier hard-expire", async () => {
    // Same server-clock ordering, opposite direction: the hard-expire arrives first, the
    // profiled revalidation (future expiry) arrives later and must not be shadowed by it.
    const early = new ValkeyCacheHandler({ client: newClient(), buildId: "lew2", now: () => 5000 });
    const late = new ValkeyCacheHandler({ client: newClient(), buildId: "lew2", now: () => 9000 });
    await early.updateTags(["u"]); // hard-expire, arrives first
    await late.updateTags(["u"], { expire: 300 }); // arrives LATER → wins
    expect(await early.getExpiration(["u"])).toBe(9000 + 300_000);
  });

  it("M11: the tag manifest hash itself carries the durable TTL (refreshed per write)", async () => {
    const client = newClient();
    const h = new ValkeyCacheHandler({ client, buildId: "mttl", now: () => 1000 });
    await h.updateTags(["t"]);
    // Entry keys were always TTL-bounded; the manifest must be too (30 days), or every deploy
    // leaks a build-namespaced hash forever.
    const ttl = await client.ttl("k8s:mttl:tags");
    expect(ttl).toBeGreaterThan(29 * 24 * 60 * 60);
    expect(ttl).toBeLessThanOrEqual(30 * 24 * 60 * 60);
  });

  it("M12 hard→profile: a profiled revalidation WITHOUT expire preserves a stored hard-expire", async () => {
    // The pre-fix bug: the profiled event `{stale, at}` REPLACED the whole hash field, erasing
    // the earlier hard expire — entries Next would hard-regenerate kept serving stale (SWR).
    const clock = { t: 1000 };
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "mrg-hp",
      now: () => clock.t,
    });
    await h.set("k", Promise.resolve(makeEntry("v1", { timestamp: 500, tags: ["t"] })));

    await h.updateTags(["t"]); // hard expire at 1000
    clock.t = 2000;
    await h.updateTags(["t"], {}); // profiled, no expire → only {stale, at}

    // The hard-expire watermark survived the merge: getExpiration still reports it, and the
    // entry is EXPIRED (dropped), not merely stale.
    expect(await h.getExpiration(["t"])).toBe(1000);
    expect(await h.get("k", [])).toBeUndefined();
  });

  // L16 clamp cases: these are the only suite-wide exercises of the Lua clamp BRANCH against a
  // real server — every other test's injected clock sits far BEHIND the server clock, so the
  // clamp never fires there. The Docker container shares the host kernel clock, so bracketing
  // the eval with Date.now() bounds the server's TIME tightly (±ms truncation → 5ms slack).

  it("L16 hard expire: a client clock 120s ahead is clamped to serverNow + MAX_CLOCK_SKEW_MS", async () => {
    const raw = newClient();
    const key = "k8s:skew-hard:tags";
    const clientNow = Date.now() + 120_000;
    // A hard expire (no durations): `expired` IS the (skewed) event time, no `stale` base.
    const event = JSON.stringify(computeTagUpdate(undefined, clientNow));
    const before = Date.now();
    const clamped = await raw.eval(
      UPDATE_TAGS_SCRIPT,
      1,
      key,
      "t",
      event,
      String(TAG_MANIFEST_TTL_SECONDS),
    );
    const after = Date.now();
    // The script reports the clamp to the caller (feeds warnOnClockSkewClamp).
    expect(Number(clamped)).toBe(1);
    const stored = JSON.parse((await raw.hget(key, "t"))!);
    // `expired` landed at serverNow + MAX_CLOCK_SKEW_MS, far below the skewed watermark.
    expect(stored.expired).toBeGreaterThanOrEqual(before + MAX_CLOCK_SKEW_MS - 5);
    expect(stored.expired).toBeLessThanOrEqual(after + MAX_CLOCK_SKEW_MS + 5);
    expect(stored.expired).toBeLessThan(clientNow);
    // `at` was rewritten to the SERVER clock, not the skewed client clock.
    expect(stored.at).toBeLessThanOrEqual(after + 5);
  });

  it("L16 profiled: the shift pins the stale base but preserves the profile duration exactly", async () => {
    const raw = newClient();
    const key = "k8s:skew-profile:tags";
    const clientNow = Date.now() + 120_000;
    // Profiled event: stale = clientNow (skewed), expired = clientNow + 300_000. The clamp must
    // SHIFT both by the same amount — pinning the base to the server bound while keeping the
    // intended 300s duration — not truncate `expired` to the bound.
    const event = JSON.stringify(computeTagUpdate(undefined, clientNow, { expire: 300 }));
    const before = Date.now();
    const clamped = await raw.eval(
      UPDATE_TAGS_SCRIPT,
      1,
      key,
      "t",
      event,
      String(TAG_MANIFEST_TTL_SECONDS),
    );
    const after = Date.now();
    expect(Number(clamped)).toBe(1);
    const stored = JSON.parse((await raw.hget(key, "t"))!);
    expect(stored.stale).toBeGreaterThanOrEqual(before + MAX_CLOCK_SKEW_MS - 5);
    expect(stored.stale).toBeLessThanOrEqual(after + MAX_CLOCK_SKEW_MS + 5);
    expect(stored.expired - stored.stale).toBe(300_000);
  });

  it("L16 via the handler: updateTags on a fast-clock replica clamps and warns once", async () => {
    // Same branch through the production path: the handler's eval return feeds
    // warnOnClockSkewClamp (warnOnce is per-process — this is the only handler-level clamp in
    // the suite, so the warning must fire here).
    const raw = newClient();
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "skew-handler",
      now: () => Date.now() + 120_000,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const before = Date.now();
      await h.updateTags(["t"]);
      const after = Date.now();
      expect(warn.mock.calls.some((c) => /clock/i.test(String(c[0])))).toBe(true);
      const stored = JSON.parse((await raw.hget("k8s:skew-handler:tags", "t"))!);
      expect(stored.expired).toBeGreaterThanOrEqual(before + MAX_CLOCK_SKEW_MS - 5);
      expect(stored.expired).toBeLessThanOrEqual(after + MAX_CLOCK_SKEW_MS + 5);
    } finally {
      warn.mockRestore();
    }
  });

  it("M12 profile→hard: a later hard expire wins immediately and keeps the stale watermark", async () => {
    const clock = { t: 1000 };
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "mrg-ph",
      now: () => clock.t,
    });
    await h.set("k", Promise.resolve(makeEntry("v1", { timestamp: 500, tags: ["t"] })));

    await h.updateTags(["t"], { expire: 300 }); // stale=1000, expired=1000+300_000 (future)
    clock.t = 2000;
    await h.updateTags(["t"]); // hard expire at 2000

    // The later event's `expired` (immediate) replaced the profile's future expiry — the entry
    // is dropped NOW, not SWR-served for another 300s.
    expect(await h.getExpiration(["t"])).toBe(2000);
    expect(await h.get("k", [])).toBeUndefined();
  });
});
