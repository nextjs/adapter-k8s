// Live end-to-end tests against a DEPLOYED instance of the e2e/ app (see e2e/).
// These hit a real URL over the network — they are intentionally NOT part of the
// default `vitest run` (which globs tests/**). Run with:
//
//   npm run test:e2e:live
//   E2E_BASE_URL=https://my-deployment npm run test:e2e:live
//
// They assert the flagship behaviours validated by hand during the first live
// deploy: route correctness, middleware executing at the ext_proc edge (rewrite +
// header), the RSC-vs-HTML cache-key partition, and Cloud CDN edge caching of
// cacheable content while dynamic responses stay uncacheable.
import { describe, it, expect, beforeAll } from "vitest";

const BASE = (process.env.E2E_BASE_URL ?? "https://adapter-gke.jamesdaniels.net").replace(
  /\/$/,
  "",
);

interface Resp {
  status: number;
  headers: Headers;
  body: string;
}

async function req(path: string, init: RequestInit = {}): Promise<Resp> {
  const res = await fetch(BASE + path, { redirect: "manual", ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/**
 * Poll a path until Cloud CDN serves it from the edge (an `age` header appears),
 * or the budget elapses. CDN population/propagation is asynchronous and per-PoP,
 * so a warm cache can still take a few requests — hence the retry budget rather
 * than a single assertion.
 */
async function waitForEdgeCache(
  path: string,
  {
    headers = {},
    budgetMs = 45_000,
    intervalMs = 3_000,
  }: { headers?: Record<string, string>; budgetMs?: number; intervalMs?: number } = {},
): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let lastAge: string | null = null;
  // Prime the cache first.
  await req(path, { headers });
  while (Date.now() < deadline) {
    const r = await req(path, { headers });
    lastAge = r.headers.get("age");
    if (lastAge !== null) return Number(lastAge);
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  throw new Error(
    `No CDN edge cache (age header) for ${path} within ${budgetMs}ms (last age=${lastAge})`,
  );
}

beforeAll(async () => {
  // Fail fast with a clear message if the deployment is unreachable.
  try {
    const r = await req("/");
    if (r.status >= 500) throw new Error(`origin ${r.status}`);
  } catch (err) {
    throw new Error(
      `Deployment not reachable at ${BASE} (${(err as Error).message}). ` +
        `Deploy the e2e/ app or set E2E_BASE_URL.`,
    );
  }
});

describe("routes", () => {
  it("serves the static home page", async () => {
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(r.body).toContain("adapter-k8s e2e");
  });

  it("serves the API route handler as JSON", async () => {
    const r = await req("/api/hello");
    expect(r.status).toBe(200);
    const json = JSON.parse(r.body);
    expect(json).toMatchObject({ ok: true, service: "adapter-k8s-e2e" });
  });

  it("renders SSR dynamically (distinct timestamps per request)", async () => {
    const t = (b: string) => b.match(/ssr-time">([^<]+)/)?.[1];
    const a = await req("/ssr");
    const b = await req("/ssr");
    expect(a.status).toBe(200);
    expect(t(a.body)).toBeTruthy();
    expect(t(b.body)).toBeTruthy();
    expect(t(a.body)).not.toBe(t(b.body));
  });
});

describe("middleware at the ext_proc edge (traffic extension, after the CDN cache)", () => {
  it("applies the rewrite verdict: /from-mw renders /rewritten", async () => {
    const r = await req("/from-mw");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Rewritten by middleware");
  });

  it("stamps matched responses with its marker header", async () => {
    const r = await req("/");
    expect(r.headers.get("x-mw-marker")).toBe("adapter-k8s-e2e");
    expect(Number(r.headers.get("x-mw-executed"))).toBeGreaterThan(0);
  });
});

describe("Cloud CDN", () => {
  it("never caches dynamic SSR (private/no-store)", async () => {
    const r = await req("/ssr");
    expect(r.headers.get("cache-control") ?? "").toMatch(/no-store|private/);
    expect(r.headers.get("age")).toBeNull();
  });

  it("partitions the cache key: RSC and HTML for the same URL are distinct", async () => {
    const html = await req("/");
    const rsc = await req("/", { headers: { RSC: "1" } });
    expect(html.headers.get("content-type")).toMatch(/text\/html/);
    expect(rsc.headers.get("content-type")).toMatch(/text\/x-component/);
    // A shared/undifferentiated cache key would serve one to the other — it must not.
    expect(rsc.headers.get("content-type")).not.toBe(html.headers.get("content-type"));
  });

  it("edge-caches immutable static assets", async () => {
    const home = await req("/");
    const asset = home.body.match(/\/_next\/static\/[^"']+\.js/)?.[0];
    expect(asset, "expected a hashed static asset in the home page").toBeTruthy();
    const cc = (await req(asset!)).headers.get("cache-control") ?? "";
    expect(cc).toMatch(/immutable/);
    await expect(waitForEdgeCache(asset!)).resolves.toBeGreaterThanOrEqual(0);
  });

  it("keeps middleware-matched App Router HTML OUT of the edge cache (forced no-cache)", async () => {
    // Reality on GXLB: ext_proc runs as a traffic extension AFTER the Cloud CDN cache, so a
    // cache hit is served WITHOUT invoking middleware. Every page route in this app is
    // matched by the middleware config, so the pool forces `Cache-Control: no-cache` to keep
    // them out of the edge cache — otherwise the CDN could serve a middleware-gated route
    // without consulting the middleware that gates it. (The earlier version of this test
    // asserted `/` becomes edge-cached, which is the opposite of the deployed topology.)
    const r = await req("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control") ?? "").toMatch(/no-cache|no-store|private/);
  });
});
