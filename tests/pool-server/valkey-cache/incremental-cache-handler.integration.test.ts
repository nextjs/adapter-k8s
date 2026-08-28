import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createValkeyClient,
  type ValkeyClient,
} from "../../../src/pool-server/valkey-cache/client.js";
import { ValkeyIncrementalCacheHandler } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";

// Integration test against a real ephemeral Valkey (Docker). Skipped when Docker is unavailable.

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

// A representative APP_PAGE (PPR shell) entry: html + rscData Buffer + tags header + segmentData Map.
function appPageEntry(html: string, tag: string) {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`rsc:${html}`),
    status: 200,
    postponed: "postponed-token",
    headers: { "x-next-cache-tags": tag },
    segmentData: new Map([["/_index", Buffer.from(`seg:${html}`)]]),
  } as Record<string, unknown>;
}

describe.skipIf(!dockerAvailable)("ValkeyIncrementalCacheHandler (integration)", () => {
  const containerName = `adapter-k8s-inc-test-${process.pid}`;
  let url = "";
  const clients: ValkeyClient[] = [];
  const newClient = () => {
    const c = createValkeyClient({ url });
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

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      /* already gone */
    }
  });

  it("round-trips an APP_PAGE shell entry, preserving binary members", async () => {
    const h = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "b1",
      now: () => 1000,
    });
    await h.set("/shell", appPageEntry("SHELL-A", "prod"), {});
    const got = await h.get("/shell", {});
    expect(got).not.toBeNull();
    const v = got!.value as Record<string, unknown>;
    expect(v.kind).toBe("APP_PAGE");
    expect(v.html).toBe("SHELL-A");
    expect(Buffer.isBuffer(v.rscData)).toBe(true);
    expect((v.rscData as Buffer).toString()).toBe("rsc:SHELL-A");
    expect(v.postponed).toBe("postponed-token");
    expect(v.segmentData instanceof Map).toBe(true);
    expect(((v.segmentData as Map<string, Buffer>).get("/_index") as Buffer).toString()).toBe(
      "seg:SHELL-A",
    );
  });

  it("namespaces by build id", async () => {
    const a = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "bA",
      now: () => 1000,
    });
    const b = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "bB",
      now: () => 1000,
    });
    await a.set("/p", appPageEntry("A", "t"), {});
    expect(await a.get("/p", {})).not.toBeNull();
    expect(await b.get("/p", {})).toBeNull();
  });

  it("CROSS-REPLICA: revalidateTag on A drops the shell on B (closes the shell gap)", async () => {
    // N78: the manifest is stamped from Valkey's own TIME, so the injected clock tracks the real
    // clock (`Date.now() + offset`) instead of a literal 1970 value that the script would rebase.
    // The entry is written 5s "ago" so the server-stamped watermark is unambiguously newer than
    // it — comparing two clocks with a sub-millisecond margin would be a coin flip.
    const offset = { ms: -5000 };
    const clientA = newClient();
    const a = new ValkeyIncrementalCacheHandler({
      client: clientA,
      buildId: "shared",
      now: () => Date.now() + offset.ms,
    });
    const b = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "shared",
      now: () => Date.now() + offset.ms,
    });

    await a.set("/page", appPageEntry("v1", "catalog"), {});
    expect(await b.get("/page", {})).not.toBeNull(); // B sees A's shell

    offset.ms = 0;
    await a.revalidateTag("catalog"); // hard revalidate on A, stamped from the server clock
    expect((await clientA.hmget("k8s:shared:tags", "catalog"))[0]).toMatch(/"expired":/);

    // B, reading the shared manifest live, drops the stale shell → Next regenerates.
    offset.ms = 1000;
    expect(await b.get("/page", {})).toBeNull();
  });

  it("orders a regenerated write after the hard invalidation on the Valkey clock", async () => {
    const client = newClient();
    const writer = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "server-order",
      // Reproduce a pod whose wall clock trails Valkey. Before the write was server-stamped, the
      // regenerated value inherited this old timestamp and its first read deleted it again.
      now: () => Date.now() - 5 * 60_000,
    });
    await writer.revalidateTag("_N_T_/page");
    await writer.set("/page", appPageEntry("fresh", "_N_T_/page"), {});

    const reader = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "server-order",
      now: () => Date.now(),
    });
    expect(await reader.get("/page", {})).not.toBeNull();
  });

  it("stamps only the top-level timestamp when application data contains the private marker", async () => {
    const client = newClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "marker-collision" });
    const marker = "__adapter_k8s_valkey_time__";
    await h.set(
      "/page",
      { kind: "PAGES", html: "page", pageData: { lastModified: marker } },
      { revalidate: 60 },
    );

    const raw = await client.get("k8s:marker-collision:inc:/page");
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as {
      lastModified: number;
      value: { pageData: { lastModified: string } };
    };
    expect(stored.lastModified).toEqual(expect.any(Number));
    expect(stored.value.pageData.lastModified).toBe(marker);
  });

  it("N79: a 300-char IMPLICIT path tag is stored AND can still invalidate the entry", async () => {
    // The end-to-end consequence of the old flat 256-char cap, against real Valkey: the entry was
    // stored with `tags: []` (measured), so `revalidatePath`/`revalidateTag` could never reach it
    // and it lived out the full 30-day DURABLE_TTL_SECONDS. `revalidate: false` here is exactly the
    // shape that gets that retention (a static page / PPR shell).
    const client = newClient();
    const offset = { ms: -5000 };
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "n79-int",
      now: () => Date.now() + offset.ms,
    });
    // `_N_T_` + a 300-char pathname — the shape `getImplicitTags` produces, and what a 63-char
    // Cyrillic path expands to (348 chars measured) once `encodeCacheTag` percent-encodes it.
    const implicit = `_N_T_/${"a".repeat(299)}`;
    await h.set("/long", appPageEntry("LONG", implicit), { cacheControl: { revalidate: false } });
    const stored = JSON.parse((await client.get("k8s:n79-int:inc:/long"))!) as { tags: string[] };
    expect(stored.tags).toEqual([implicit]);
    expect(await h.get("/long", {})).not.toBeNull();

    offset.ms = 0;
    await h.revalidateTag(implicit); // what revalidatePath ultimately calls
    offset.ms = 1000;
    expect(await h.get("/long", {})).toBeNull();
  });

  it("N79: the private _N_RP_* markers survive an entry with more than 128 tags", async () => {
    const client = newClient();
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "n79-rp",
      now: () => Date.now(),
    });
    const tags = [...Array.from({ length: 130 }, (_, i) => `t-${i}`), "_N_RP_lang", "_N_RP_region"];
    await h.set("/coarse", appPageEntry("COARSE"), { tags });
    const stored = JSON.parse((await client.get("k8s:n79-rp:inc:/coarse"))!) as { tags: string[] };
    expect(stored.tags).toContain("_N_RP_lang");
    expect(stored.tags).toContain("_N_RP_region");
    // And the freshness HMGET over that whole list still works against a real server.
    expect(await h.get("/coarse", {})).not.toBeNull();
  });

  it("caches a null value (404) as a real entry, not a delete", async () => {
    const h = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "nullc",
      now: () => 1000,
    });
    await h.set("/missing", null, {});
    const got = await h.get("/missing", {});
    expect(got).not.toBeNull(); // the negative result IS cached (shared across replicas)
    expect(got!.value).toBeNull();
  });

  it("uses the FETCH value's own revalidate for retention (not the ctx default)", async () => {
    const client = newClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "fetchttl", now: () => 1000 });
    const fetchEntry = {
      kind: "FETCH",
      data: { headers: {}, body: "x", status: 200, url: "https://e" },
      revalidate: 3600,
      tags: [],
    } as Record<string, unknown>;
    await h.set("/api/f", fetchEntry, {}); // no ctx.revalidate → must read data.revalidate
    const ttl = await client.ttl("k8s:fetchttl:inc:/api/f");
    expect(ttl).toBeGreaterThan(3600); // 3600 + retention margin, not the ~61s ctx fallback
  });

  it("gives a never-revalidate (static) entry a durable TTL, not the ~61s floor", async () => {
    const client = newClient();
    const h = new ValkeyIncrementalCacheHandler({ client, buildId: "durable", now: () => 1000 });
    // No ctx.revalidate / expire, and cacheControl.revalidate:false → "never time-revalidate".
    await h.set("/static", appPageEntry("STATIC", "prod"), { cacheControl: { revalidate: false } });
    const ttl = await client.ttl("k8s:durable:inc:/static");
    expect(ttl).toBeGreaterThan(24 * 60 * 60); // durable (days), not the 61s numeric-revalidate floor
  });

  it("SWR: a stale (profiled) tag keeps serving the entry, signalling background revalidation", async () => {
    // N80: for a route WITH a numeric revalidate window the signal is a real `lastModified` shifted
    // just past that window (→ `isStale = true`, serve stale + revalidate behind the request), not
    // `-1` (→ `isStale = -1`, which response-cache implements as "block on a fresh render").
    // Entry writes and manifest updates use the same server clock. Keep them in distinct
    // milliseconds because Next's predicate is deliberately `staleAt > entryTimestamp`.
    const client = newClient();
    const offset = { ms: 0 };
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "swr",
      now: () => Date.now() + offset.ms,
    });
    await h.set("/isr", appPageEntry("isr", "news"), {
      cacheControl: { revalidate: 60, expire: 300 },
    });
    await sleep(5);
    await h.revalidateTag("news", { expire: 300 }); // stale=now, expired=now+300s (future)
    // The manifest write is best-effort by design; assert it landed so a swallowed failure can't
    // masquerade as "the entry wasn't stale".
    expect((await client.hmget("k8s:swr:tags", "news"))[0]).toMatch(/"stale":/);
    offset.ms = 2000;
    const now = Date.now() + offset.ms;
    const got = await h.get("/isr", {});
    expect(got).not.toBeNull();
    expect(got!.lastModified).not.toBe(-1);
    expect(60 * 1000 + got!.lastModified!).toBeLessThan(now); // revalidateAfter < now
    expect(300 * 1000 + got!.lastModified!).toBeGreaterThanOrEqual(now); // still inside expire
  });

  it("SWR falls back to -1 for a route with no numeric revalidate (PPR shell / static)", async () => {
    // `calculateRevalidate` returns `false` there, so `revalidateAfter` is `false` and nothing but
    // -1 can force a revalidation — blocking is the only expressible answer (N80).
    const client = newClient();
    const offset = { ms: 0 };
    const h = new ValkeyIncrementalCacheHandler({
      client,
      buildId: "swr-static",
      now: () => Date.now() + offset.ms,
    });
    await h.set("/shell", appPageEntry("shell", "news"), { cacheControl: { revalidate: false } });
    await sleep(5);
    await h.revalidateTag("news", { expire: 300 });
    expect((await client.hmget("k8s:swr-static:tags", "news"))[0]).toMatch(/"stale":/);
    offset.ms = 2000;
    expect((await h.get("/shell", {}))?.lastModified).toBe(-1);
  });
});
