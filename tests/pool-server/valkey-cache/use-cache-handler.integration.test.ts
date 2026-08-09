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
// Docker Desktop and virtualized CI clocks can differ from the host wall clock by more than
// 5 ms. This remains tiny beside the 60-second production skew clamp the assertions protect.
const SERVER_CLOCK_TOLERANCE_MS = 100;

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

  it("N84: an entry with revalidate <= 0 round-trips (a valid EXPIRE reaches the server)", async () => {
    // `get` returns `revalidate: -1` for a stale entry, the `use cache` wrapper propagates the
    // minimum into the ENCLOSING entry, and the old guard then refused to store that outer entry —
    // so nested caches stopped caching while any inner entry was stale, and
    // `cacheLife({ revalidate: 0 })` was never cached at all. Measured pre-fix against real Valkey:
    // `stored entry with revalidate=-1? false`, `revalidate=0? false`.
    const client = newClient();
    const t0 = Date.now();
    const h = new ValkeyCacheHandler({ client, buildId: "n84-int", now: () => t0 });
    for (const [key, revalidate] of [
      ["outer", -1],
      ["zero", 0],
    ] as const) {
      await h.set(
        key,
        Promise.resolve(makeEntry(`v-${key}`, { timestamp: t0, revalidate, expire: 300 })),
      );
      const got = await h.get(key, []);
      expect(got, `revalidate=${revalidate} must be storable`).toBeDefined();
      expect(await readStream(got!.value)).toBe(`v-${key}`);
      // The key really has a TTL — the EXPIRE argument was valid, not NaN/negative.
      const ttl = await client.ttl(`k8s:n84-int:entry:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(360);
    }
    // `expire: 0` is still skipped (Next's dynamic entry) — no key, no TTL-less leftover.
    await h.set("dyn", Promise.resolve(makeEntry("v", { timestamp: t0, expire: 0 })));
    expect(await h.get("dyn", [])).toBeUndefined();
    expect(await client.exists("k8s:n84-int:entry:dyn")).toBe(0);
  });

  it("getExpiration returns the max expired watermark for tags", async () => {
    // N78: the stored watermark is rebased onto the SERVER clock, so it is `serverNow + 300s`
    // rather than literally `clientNow + 300s`. With a realistic client clock the two are the same
    // to within the round trip — which is exactly the invariant worth asserting.
    const t0 = Date.now();
    const h = new ValkeyCacheHandler({ client: newClient(), buildId: "b-exp", now: () => t0 });
    await h.updateTags(["x"], { expire: 300 });
    const expiration = await h.getExpiration(["x"]);
    expect(expiration).toBeGreaterThanOrEqual(t0 + 300_000 - 50);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 300_000 + 50);
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
    // N78: injected clocks are anchored to the real clock now — the shared manifest is stamped
    // from Valkey's own TIME, so a client clock 55 years behind (a literal `now: () => 1000`) is
    // rebased and no longer participates in the comparison. Anchoring is what a real replica does.
    const clock = { t: Date.now() };
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
    // The entry is stamped 5s in the past so the SERVER-stamped watermark is unambiguously newer
    // — comparing a client timestamp with a server one at a sub-millisecond margin is a coin flip.
    const t0 = clock.t;
    await a.set("page", Promise.resolve(makeEntry("v1", { timestamp: t0 - 5000, tags: ["prod"] })));
    await b.refreshTags();
    expect(await readStream((await b.get("page", []))!.value)).toBe("v1");

    // A revalidates the tag (hard, no duration → immediate expiry) at a later time.
    clock.t = t0 + 1000;
    await a.updateTags(["prod"]);

    // B, on its next request, sees the shared manifest and drops the entry.
    await b.refreshTags();
    expect(await b.get("page", [])).toBeUndefined();
  });

  it("CROSS-REPLICA revalidation is visible LIVE without refreshTags", async () => {
    // Reproduces the live bug: a replica that did NOT handle the revalidateTag must still see
    // it immediately (get/getExpiration read the shared manifest live, not a stale snapshot).
    const t0 = Date.now();
    const a = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "live-build",
      now: () => t0 + 1000,
    });
    const b = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "live-build",
      now: () => t0 + 2000,
    });
    await a.set("e", Promise.resolve(makeEntry("v1", { timestamp: t0 - 5000, tags: ["live"] })));
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
    const t0 = Date.now();
    const ahead = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "lew",
      now: () => t0 + 4000,
    });
    const behind = new ValkeyCacheHandler({ client: newClient(), buildId: "lew", now: () => t0 });
    await ahead.updateTags(["t"], { expire: 300 }); // expired = now + 300_000, arrives first
    await behind.updateTags(["t"]); // hard-expire, arrives LATER → wins
    // The winning hard expire lands on the SERVER's now (N78), NOT on the behind replica's
    // `t0` and not on the earlier event's `+300s` future watermark.
    const expiration = await ahead.getExpiration(["t"]);
    expect(expiration).toBeGreaterThanOrEqual(t0 - 50);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 50);
  });

  it("updateTags merge: a later-arriving profiled revalidation wins over an earlier hard-expire", async () => {
    // Same server-clock ordering, opposite direction: the hard-expire arrives first, the
    // profiled revalidation (future expiry) arrives later and must not be shadowed by it.
    const t0 = Date.now();
    const early = new ValkeyCacheHandler({ client: newClient(), buildId: "lew2", now: () => t0 });
    const late = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "lew2",
      now: () => t0 + 4000,
    });
    await early.updateTags(["u"]); // hard-expire, arrives first
    await late.updateTags(["u"], { expire: 300 }); // arrives LATER → wins
    // The profile's duration survives the rebase exactly; its base is the server's now.
    const expiration = await early.getExpiration(["u"]);
    expect(expiration).toBeGreaterThanOrEqual(t0 + 300_000 - 50);
    expect(expiration).toBeLessThanOrEqual(Date.now() + 300_000 + 50);
  });

  it("M11: the tag manifest hash itself carries the durable TTL (refreshed per write)", async () => {
    const client = newClient();
    // N78: an anchored clock (a 1970 clock would be rebased and report skew, consuming the
    // once-per-process warning this file asserts on elsewhere).
    const h = new ValkeyCacheHandler({ client, buildId: "mttl", now: () => Date.now() });
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
    const t0 = Date.now();
    const clock = { t: t0 };
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "mrg-hp",
      now: () => clock.t,
    });
    await h.set("k", Promise.resolve(makeEntry("v1", { timestamp: t0 - 5000, tags: ["t"] })));

    const beforeHard = Date.now();
    await h.updateTags(["t"]); // hard expire, stamped from the server clock (N78)
    const afterHard = Date.now();
    clock.t = t0 + 1000;
    await h.updateTags(["t"], {}); // profiled, no expire → only {stale, at}

    // The hard-expire watermark survived the merge: getExpiration still reports it, and the
    // entry is EXPIRED (dropped), not merely stale.
    const expiration = await h.getExpiration(["t"]);
    expect(expiration).toBeGreaterThanOrEqual(beforeHard - 50);
    expect(expiration).toBeLessThanOrEqual(afterHard + 50);
    expect(await h.get("k", [])).toBeUndefined();
  });

  // N78 rebase cases: the only suite-wide exercises of the Lua rebase against a REAL server in
  // both skew directions. The Docker container shares the host kernel clock, so bracketing the
  // eval with Date.now() bounds the server's TIME tightly (±ms truncation → 5ms slack).

  it("N78 hard expire, clock 120s AHEAD: the watermark lands on the server's now, not 60s ahead", async () => {
    // Pre-fix this was clamped to `serverNow + MAX_CLOCK_SKEW_MS` and carried no `stale`, so
    // `expired <= now` was false for a full minute and entries read back FRESH.
    const raw = newClient();
    const key = "k8s:skew-hard:tags";
    const clientNow = Date.now() + 120_000;
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
    // The script reports the skew to the caller (feeds warnOnClockSkewClamp).
    expect(Number(clamped)).toBe(1);
    const stored = JSON.parse((await raw.hget(key, "t"))!);
    expect(stored.expired).toBeGreaterThanOrEqual(before - SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.expired).toBeLessThanOrEqual(after + SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.expired).toBeLessThan(clientNow - MAX_CLOCK_SKEW_MS);
    // `at` was rewritten to the SERVER clock, not the skewed client clock.
    expect(stored.at).toBeLessThanOrEqual(after + SERVER_CLOCK_TOLERANCE_MS);
  });

  it("N78 hard expire, clock 5min BEHIND: the watermark is dragged FORWARD to the server's now", async () => {
    // The missing floor was the worse half of the finding: pre-fix the behind pod stored
    // `{"expired": now - 300000}`, older than every current entry, so the hard revalidateTag
    // invalidated NOTHING. Probed against real Valkey: the entry was "STILL SERVED".
    const raw = newClient();
    const key = "k8s:skew-behind:tags";
    const clientNow = Date.now() - 300_000;
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
    expect(Number(clamped)).toBe(1);
    const stored = JSON.parse((await raw.hget(key, "t"))!);
    expect(stored.expired).toBeGreaterThanOrEqual(before - SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.expired).toBeLessThanOrEqual(after + SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.expired).toBeGreaterThan(clientNow + MAX_CLOCK_SKEW_MS);
  });

  it("N78 profiled: the base is pinned to server time and the profile duration is exact", async () => {
    const raw = newClient();
    const key = "k8s:skew-profile:tags";
    const clientNow = Date.now() + 120_000;
    // Profiled event: stale = clientNow (skewed), expired = clientNow + 300_000. Both shift by the
    // SAME amount — the base is pinned to server time while the intended 300s duration survives.
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
    expect(stored.stale).toBeGreaterThanOrEqual(before - SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.stale).toBeLessThanOrEqual(after + SERVER_CLOCK_TOLERANCE_MS);
    expect(stored.expired - stored.stale).toBe(300_000);
  });

  it("N78 no skew: a well-synced replica's watermarks are effectively untouched", async () => {
    const raw = newClient();
    const key = "k8s:skew-none:tags";
    const clientNow = Date.now();
    const event = JSON.stringify(computeTagUpdate(undefined, clientNow, { expire: 300 }));
    const clamped = await raw.eval(
      UPDATE_TAGS_SCRIPT,
      1,
      key,
      "t",
      event,
      String(TAG_MANIFEST_TTL_SECONDS),
    );
    expect(Number(clamped)).toBe(0); // no skew reported
    const stored = JSON.parse((await raw.hget(key, "t"))!);
    expect(Math.abs(stored.stale - clientNow)).toBeLessThan(1000);
    expect(stored.expired - stored.stale).toBe(300_000);
  });

  it("N78 via the handler: a fast-clock replica's revalidation bites immediately and warns once", async () => {
    // Same branch through the production path: the handler's eval return feeds
    // warnOnClockSkewClamp (warnOnce is per-process — this is the only handler-level skew in the
    // suite, so the warning must fire here). And the entry must actually be INVALIDATED, which is
    // what the pre-fix ceiling (a future watermark with no `stale`) prevented for 60s.
    const raw = newClient();
    const t0 = Date.now();
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "skew-handler",
      now: () => Date.now() + 120_000,
    });
    const reader = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "skew-handler",
      now: () => Date.now(),
    });
    await reader.set("k", Promise.resolve(makeEntry("v", { timestamp: t0 - 5000, tags: ["t"] })));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const before = Date.now();
      await h.updateTags(["t"]);
      const after = Date.now();
      expect(warn.mock.calls.some((c) => /clock/i.test(String(c[0])))).toBe(true);
      const stored = JSON.parse((await raw.hget("k8s:skew-handler:tags", "t"))!);
      expect(stored.expired).toBeGreaterThanOrEqual(before - SERVER_CLOCK_TOLERANCE_MS);
      expect(stored.expired).toBeLessThanOrEqual(after + SERVER_CLOCK_TOLERANCE_MS);
      // The whole point: a correctly-clocked replica drops the entry NOW.
      expect(await reader.get("k", [])).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it("M12 profile→hard: a later hard expire wins immediately and keeps the stale watermark", async () => {
    const t0 = Date.now();
    const clock = { t: t0 };
    const h = new ValkeyCacheHandler({
      client: newClient(),
      buildId: "mrg-ph",
      now: () => clock.t,
    });
    await h.set("k", Promise.resolve(makeEntry("v1", { timestamp: t0 - 5000, tags: ["t"] })));

    await h.updateTags(["t"], { expire: 300 }); // stale=now, expired=now+300_000 (future)
    clock.t = t0 + 1000;
    const beforeHard = Date.now();
    await h.updateTags(["t"]); // hard expire, server-stamped
    const afterHard = Date.now();

    // The later event's `expired` (immediate) replaced the profile's future expiry — the entry
    // is dropped NOW, not SWR-served for another 300s.
    const expiration = await h.getExpiration(["t"]);
    expect(expiration).toBeGreaterThanOrEqual(beforeHard - 50);
    expect(expiration).toBeLessThanOrEqual(afterHard + 50);
    expect(await h.get("k", [])).toBeUndefined();
  });
});
