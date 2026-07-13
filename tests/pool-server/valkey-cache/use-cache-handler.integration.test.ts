import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bufferToStream } from "../../../src/pool-server/valkey-cache/stream-codec.js";
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

  it("updateTags is last-event-wins: an older event cannot clobber a newer one", async () => {
    // Reproduces the concurrent-revalidation race: a later profiled revalidation (future expiry)
    // must not be overwritten by an older hard-expire that arrives afterward.
    const early = new ValkeyCacheHandler({ client: newClient(), buildId: "lew", now: () => 5000 });
    const late = new ValkeyCacheHandler({ client: newClient(), buildId: "lew", now: () => 9000 });
    await late.updateTags(["t"], { expire: 300 }); // event at 9000 → expired = 9000 + 300_000
    await early.updateTags(["t"]); // older event at 5000 → must be ignored by the atomic merge
    expect(await early.getExpiration(["t"])).toBe(9000 + 300_000);
  });
});
