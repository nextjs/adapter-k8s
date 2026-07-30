import { describe, expect, it } from "vitest";

const BASE = process.env.E2E_EDGE_BASE_URL?.replace(/\/$/, "");

describe.skipIf(!BASE)("deployed Edge invocation fixture", () => {
  it("reconstructs optional catch-all params", async () => {
    const response = await fetch(`${BASE}/edge-catchall/one/two/three`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: ["one", "two", "three"] });
  });

  it("reconstructs dynamic params after a rewrite", async () => {
    const response = await fetch(`${BASE}/edge-rewrite/rewritten/param`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: ["rewritten", "param"] });
  });
});

// LIVE COVERAGE for the emulateNextServer split (pool-server/index.ts) — the standing rule is
// that every case the NEXT_ENABLE_ADAPTER harness emulates gets a corresponding test here,
// against real production config (Valkey present, minimal-mode selection as deployed).
//
// This fixture is the only one that CAN host these: fixtures/main sets cacheComponents, which
// makes every route PPR-capable (the other flag domain) and rejects classic SSG shapes
// outright. The gap let a production bug survive every live run: plain SSG pages ran minimal,
// re-rendered per request, and never reported a cache status. MEASURED on GKE before the fix:
// three fetches of a static page returned three different renders, x-vercel-cache MISS each.
// Fixed 2026-07-30 by the incrementalCacheShared rungs + static-page seed serve in dispatch.ts.
describe.skipIf(!BASE)("plain SSG caching against production config", () => {
  const mark = (body: string) => body.match(/id="now">(\d+)</)?.[1] ?? null;

  it("serves a STATIC prerendered page from the build seed with a HIT verdict", async () => {
    // The exact class that was broken: handlerPathname === matchedPathname, so the seed-serve
    // gate used to exclude it and minimal mode re-rendered every request.
    const first = await fetch(`${BASE}/isr-static`);
    expect(first.status).toBe(200);
    const firstNow = mark(await first.text());
    expect(firstNow, "expected the #now marker").toBeTruthy();
    expect(first.headers.get("x-vercel-cache")).toBe("HIT");

    const second = await fetch(`${BASE}/isr-static`);
    expect(mark(await second.text())).toBe(firstNow);
    expect(second.headers.get("x-vercel-cache")).toBe("HIT");
  });

  it("serves a PREBUILT template instance from the build seed", async () => {
    const first = await fetch(`${BASE}/isr-repro/prebuilt`);
    expect(first.status).toBe(200);
    const firstNow = mark(await first.text());
    const second = await fetch(`${BASE}/isr-repro/prebuilt`);
    expect(mark(await second.text())).toBe(firstNow);
    expect(second.headers.get("x-vercel-cache")).toBe("HIT");
  });

  it("caches an ON-DEMAND template instance through the shared incremental cache", async () => {
    // A slug outside generateStaticParams has no build artifact: first request renders
    // (MISS is legitimate there), and the entry must then be served back — cross-replica,
    // since the two requests may land on different pods and the cache is Valkey.
    // A fresh slug per run keeps the first-request assertion meaningful.
    const slug = `probe-${Date.now().toString(36)}`;
    const first = await fetch(`${BASE}/isr-repro/${slug}`);
    expect(first.status).toBe(200);
    const firstNow = mark(await first.text());
    expect(firstNow).toBeTruthy();

    const second = await fetch(`${BASE}/isr-repro/${slug}`);
    expect(second.status).toBe(200);
    // Re-rendered instead of cached ⟺ the marker changes. This is the assertion that failed
    // for the whole class before the fix.
    expect(mark(await second.text())).toBe(firstNow);
    expect(second.headers.get("x-nextjs-cache")).toBe("HIT");
  });
});
