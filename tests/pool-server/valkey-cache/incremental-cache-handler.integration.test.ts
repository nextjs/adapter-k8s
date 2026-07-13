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
    const clock = { t: 1000 };
    const a = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "shared",
      now: () => clock.t,
    });
    const b = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "shared",
      now: () => clock.t,
    });

    await a.set("/page", appPageEntry("v1", "catalog"), {});
    expect(await b.get("/page", {})).not.toBeNull(); // B sees A's shell

    clock.t = 2000;
    await a.revalidateTag("catalog"); // hard revalidate on A

    // B, reading the shared manifest live, drops the stale shell → Next regenerates.
    expect(await b.get("/page", {})).toBeNull();
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

  it("SWR: a stale (profiled) tag returns lastModified=-1 rather than dropping the entry", async () => {
    const clock = { t: 1000 };
    const h = new ValkeyIncrementalCacheHandler({
      client: newClient(),
      buildId: "swr",
      now: () => clock.t,
    });
    await h.set("/isr", appPageEntry("isr", "news"), {});
    clock.t = 2000;
    await h.revalidateTag("news", { expire: 300 }); // stale=2000, expired=2000+300s (future)
    const got = await h.get("/isr", {});
    expect(got).not.toBeNull();
    expect(got!.lastModified).toBe(-1); // signals background/blocking revalidation, entry still served
  });
});
