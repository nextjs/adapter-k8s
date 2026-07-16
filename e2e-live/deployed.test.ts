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

  it("serves an opaque generated metadata icon with its public MIME type", async () => {
    // Next stores generated metadata bodies under opaque artifact names. The public metadata
    // pathname, not the `.body` artifact suffix, is authoritative for the response type.
    const r = await req("/icon.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("image/svg+xml");
  });

  it("keeps the public origin and port in an absolute 307 form redirect", async () => {
    // App Route request.nextUrl is derived from requestMeta.initURL. A bare localhost fallback
    // drops the deployment port, so the preserved-method POST escapes to port 80.
    const redirect = await req("/api/form-redirect", { method: "POST" });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe(`${BASE}/form-redirect-target?success=true`);

    const followed = await fetch(BASE + "/api/form-redirect", {
      method: "POST",
      redirect: "follow",
    });
    expect(followed.status).toBe(200);
    expect(followed.url).toBe(`${BASE}/form-redirect-target?success=true`);
    expect(await followed.text()).toContain("form-redirect-target");
  });

  it("runs middleware once for a same-origin rewrite with a POST body", async () => {
    const response = await fetch(`${BASE}/api/rewrite-body-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "body-survived-rewrite" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: "body-survived-rewrite" });
  });

  it("revalidates a cached App route through the shared middle cache", async () => {
    const read = async () => {
      const response = await req(`/api/cache-probe?lifecycle=${Date.now()}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-next-cache-tags")).toBeNull();
      return (JSON.parse(response.body) as { at: string }).at;
    };
    const initial = await read();
    expect(await read()).toBe(initial);

    const invalidated = await req("/api/revalidate?tag=route-probe", { method: "POST" });
    expect(invalidated.status).toBe(200);

    const deadline = Date.now() + 20_000;
    let refreshed = initial;
    while (Date.now() < deadline && refreshed === initial) {
      refreshed = await read();
      if (refreshed === initial) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(refreshed).not.toBe(initial);
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

  it("decodes an encoded slash once inside an ordinary dynamic parameter", async () => {
    // The adapter receives the capture in URL-encoded form and must pass the decoded value to the
    // generated entrypoint. Double encoding here breaks both route params and revalidation keys.
    const r = await req("/encoded-key/%2Flive%2Fprobe");
    expect(r.status).toBe(200);
    expect(r.body).toContain("encoded-key:/live/probe");
  });

  it("preserves React's Link-header budget across a PPR shell and resume", async () => {
    // The persisted shell can spell this field `Link` while Node normalizes the resumed response
    // to `link`. They are the same HTTP field and must not be forwarded twice.
    const r = await req("/header-budget");
    const link = r.headers.get("link");
    expect(r.status).toBe(200);
    expect(link).not.toBeNull();
    expect(link!.length).toBeLessThanOrEqual(400);
  });

  it("materializes a Pages fallback:true route through the shared platform cache", async () => {
    // This is the production half of the fallback-cache contract. A real deployment has Valkey,
    // so it must return materialized content and must never depend on the NEXT_ENABLE_ADAPTER-only
    // per-process cache marker used by the local Next.js deploy harness. The upstream prerender E2E
    // separately locks the local first-shell → data-fill → materialized-document lifecycle.
    const slug = `live-${Date.now()}`;
    const first = await req(`/fallback-cache/${slug}`);
    const second = await req(`/fallback-cache/${slug}`);
    expect(first.status).toBe(200);
    expect(first.body).toContain(`fallback-cache-materialized:${slug}`);
    expect(first.body).not.toContain("fallback-cache-shell");
    expect(second.body).toContain(`fallback-cache-materialized:${slug}`);
  });

  it("finishes tag invalidation work before releasing the request lifecycle", async () => {
    // This is the production/Valkey counterpart to the unit-level waitUntil test and Next's
    // Server Action deploy test. Mutable ISR data belongs in Valkey, while a unique query avoids
    // accidentally observing an older Cloud CDN object during the verification poll.
    const readTime = (body: string) => body.match(/isr-time">([^<]+)/)?.[1];
    const initial = await req(`/isr?lifecycle=${Date.now()}`);
    const initialTime = readTime(initial.body);
    expect(initial.status).toBe(200);
    expect(initialTime).toBeTruthy();
    expect(initial.headers.get("x-next-cache-tags")).toBeNull();

    const invalidated = await req("/api/revalidate?tag=isr", { method: "POST" });
    expect(invalidated.status).toBe(200);

    const deadline = Date.now() + 20_000;
    let refreshedTime = initialTime;
    while (Date.now() < deadline && refreshedTime === initialTime) {
      const refreshed = await req(`/isr?lifecycle=${Date.now()}`);
      refreshedTime = readTime(refreshed.body);
      if (refreshedTime === initialTime) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    expect(refreshedTime).toBeTruthy();
    expect(refreshedTime).not.toBe(initialTime);
  });
});

describe("middleware at the ext_proc edge (traffic extension, after the CDN cache)", () => {
  it("applies the rewrite verdict: /from-mw renders /rewritten", async () => {
    const r = await req("/from-mw");
    expect(r.status).toBe(200);
    expect(r.body).toContain("Rewritten by middleware");
  });

  it("translates a middleware redirect into an RSC navigation response", async () => {
    const r = await req("/rsc-redirect-origin?_rsc=probe", {
      headers: { rsc: "1" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("location")).toBeNull();
    expect(r.headers.get("x-nextjs-redirect")).toBe("/rewritten");
  });

  it("stamps matched responses with its marker header", async () => {
    const r = await req("/");
    expect(r.headers.get("x-mw-marker")).toBe("adapter-k8s-e2e");
    expect(Number(r.headers.get("x-mw-executed"))).toBeGreaterThan(0);
  });

  it("forces even an explicitly cacheable middleware-matched route to revalidate", async () => {
    const r = await req("/middleware-cache-probe.txt");
    expect(r.status).toBe(200);
    // GXLB middleware runs after Cloud CDN; allowing this origin header through would let a later
    // cache hit bypass middleware. The CDN-less NEXT_ENABLE_ADAPTER harness is separately covered
    // by the upstream compatibility suite and the cache-policy unit test.
    expect(r.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("rewrite query semantics", () => {
  it("preserves repeated destination values as an ordered array", async () => {
    const r = await req("/rewrite-query-array");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ items: ["one", "two"] });
  });
});

describe("Cloud CDN", () => {
  it("serves and optimizes a public image whose filename contains a space", async () => {
    const direct = await req("/image%20probe.svg");
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toContain("image/svg");

    // The optimizer query decodes once to `/image%20probe.svg`; filesystem resolution must perform
    // the URL-path decode exactly once more to find the literal-space public file.
    const optimized = await req("/_next/image?url=%2Fimage%2520probe.svg&w=640&q=75");
    expect(optimized.status).toBe(200);
  });

  it("does not upscale an image smaller than the requested optimizer width", async () => {
    const response = await fetch(`${BASE}/_next/image?url=%2Fapi%2Ftiny-png&w=640&q=75`, {
      headers: { accept: "image/png" },
    });
    expect(response.status).toBe(200);
    const png = Buffer.from(await response.arrayBuffer());
    // PNG IHDR stores width/height as big-endian uint32 values at byte offsets 16 and 20.
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
  });

  it("ETag-revalidates a mutable worker without downloading its body again", async () => {
    const first = await req("/sw-revalidation-probe.js");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("must-revalidate");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await req("/sw-revalidation-probe.js", {
      headers: { "if-none-match": etag! },
    });
    expect(second.status).toBe(304);
    expect(second.body).toBe("");
  });

  it("preserves next.config headers over the public-file cache default", async () => {
    const r = await req("/header-priority.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("max-age=1234");
  });

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
