// tests/pool-server/index.headers.test.ts
// Response cache-control precedence at the index.ts boundary, proven against the real
// server (same harness style as index.smoke.test.ts): public/ files must flow through
// dispatch's static manifest with resolved-header merging (next.config headers() /
// middleware response headers win over the adapter's `public, max-age=3600` default),
// and the middleware-matched forced `no-cache` must yield to an EXPLICIT app-owned
// cache-control from the resolved routing verdict — while a PPR `no-store` verdict and
// a response's own `no-store` are never weakened.
//
// The staged dir lives UNDER THE REPO ROOT so createRequire(<staged>/package.json)
// can resolve the repo's `next` and `@next/routing`. Created/removed by this test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cdnTagForBuildId } from "../../src/cdn-tags.js";

const REPO_ROOT = process.cwd();
const BUILD_ID = "headersbuild1";
const BUILD_TAG = cdnTagForBuildId(BUILD_ID);

// Production cache wiring must stay out of this test regardless of the host env.
delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

function writeStagedDir(): { dir: string; configDir: string } {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".headers-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(path.join(dir, "handlers"), { recursive: true });
  mkdirSync(configDir, { recursive: true });

  writeFileSync(path.join(dir, "package.json"), "{}");
  // Public files: the first three are in static-assets.json (the dispatch path);
  // stale.txt is deliberately ABSENT from it (the last-resort disk path).
  writeFileSync(path.join(dir, "public", "header-priority.txt"), "priority body");
  writeFileSync(path.join(dir, "public", "probe.txt"), "probe body");
  writeFileSync(path.join(dir, "public", "mw-probe.txt"), "mw probe body");
  writeFileSync(path.join(dir, "public", "stale.txt"), "stale body");

  // Middleware-covered handler that claims a cacheable policy of its own — the forced
  // policy must strip it when there is NO explicit app-owned cache-control.
  writeFileSync(
    path.join(dir, "handlers", "mw-covered.mjs"),
    `export function handler(req, res) {
       res.writeHead(200, {
         "cache-control": "public, max-age=7777",
         "cache-tag": "handler-tag",
         "content-type": "text/plain",
       });
       res.end("covered");
     }
    `,
  );
  // Handler that declares no-store via the setHeader map (how entrypoints mark
  // dynamic responses) — a weaker resolved value must NOT make it cacheable.
  writeFileSync(
    path.join(dir, "handlers", "mw-nostore.mjs"),
    `export function handler(req, res) {
       res.setHeader("cache-control", "no-store");
       res.writeHead(200, { "content-type": "text/plain" });
       res.end("nostore");
     }
    `,
  );

  // Echoes the rewrite-invocation request meta the dispatcher supplies, so tests can
  // assert that trusted x-invoke-path/x-invoke-query reach the handler.
  writeFileSync(
    path.join(dir, "handlers", "echo.mjs"),
    `export function handler(req, res, ctx) {
       const meta = (ctx && ctx.requestMeta) || {};
       res.writeHead(200, { "content-type": "application/json" });
       res.end(JSON.stringify({
         resolvedPathname: meta.resolvedPathname ?? null,
         rewrittenPathname: meta.rewrittenPathname ?? null,
         query: meta.query ?? null,
       }));
     }
    `,
  );

  writeFileSync(
    path.join(configDir, "pool-manifest-main.json"),
    JSON.stringify({
      buildId: BUILD_ID,
      poolName: "main",
      outputs: {
        "/mw-covered": {
          id: "/mw-covered",
          filePath: "handlers/mw-covered.mjs",
          pathname: "/mw-covered",
          type: "PAGES",
        },
        "/mw-nostore": {
          id: "/mw-nostore",
          filePath: "handlers/mw-nostore.mjs",
          pathname: "/mw-nostore",
          type: "PAGES",
        },
        "/echo-target": {
          id: "/echo-target",
          filePath: "handlers/echo.mjs",
          pathname: "/echo-target",
          type: "PAGES",
        },
      },
    }),
  );
  writeFileSync(
    path.join(configDir, "routing-manifest.json"),
    JSON.stringify({
      routeGraph: {
        beforeMiddleware: [
          {
            // next.config headers() rule, exactly as the adapter's manifest emits it
            // for fixtures/main — Phase-1 local resolution must surface it as a
            // resolved header that beats the public-file default.
            source: "/header-priority.txt",
            sourceRegex: "(?i:^\\/header-priority\\.txt(?:\\/)?$)",
            headers: { "Cache-Control": "max-age=1234" },
          },
        ],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
        rsc: { header: "rsc", suffix: ".rsc" },
      },
      pathnames: ["/mw-covered", "/mw-nostore", "/echo-target"],
      i18n: null,
      buildId: BUILD_ID,
      basePath: "",
      // Node-runtime middleware whose matcher covers only /mw-* paths. The module is
      // never INVOKED here (the tests assert the forced-cache policy via trusted
      // Phase-2 dispatch headers, x-mw-evaluated: ran) — but its coverage is what
      // installs the forced no-cache wrapper.
      middleware: {
        filePath: path.join(dir, "mw.mjs"),
        runtime: "nodejs",
        matchers: [{ regexp: "^\\/mw-" }],
      },
      poolAssignments: {
        "/mw-covered": "main",
        "/mw-nostore": "main",
        "/echo-target": "main",
      },
      pprRoutes: {},
      nextVersion: "16.2.10",
    }),
  );
  writeFileSync(path.join(dir, "mw.mjs"), "export function proxy(request) {}\n");
  // Static-assets manifest as the adapter now emits it: public/ files included with
  // the mutable default. stale.txt is deliberately missing.
  writeFileSync(
    path.join(configDir, "static-assets.json"),
    JSON.stringify([
      {
        pathname: "/header-priority.txt",
        filePath: "public/header-priority.txt",
        cacheControl: "public, max-age=3600",
      },
      {
        pathname: "/probe.txt",
        filePath: "public/probe.txt",
        cacheControl: "public, max-age=3600",
      },
      {
        pathname: "/mw-probe.txt",
        filePath: "public/mw-probe.txt",
        cacheControl: "public, max-age=3600",
      },
    ]),
  );
  return { dir, configDir };
}

async function getFreePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

describe("pool-server response cache-control precedence", () => {
  let staged: { dir: string; configDir: string };
  let server: Awaited<ReturnType<typeof startPoolServer>> | undefined;
  let port: number;
  let savedEnv: Record<string, string | undefined>;
  const envKeys = [
    "POOL_NAME",
    "NEXT_BUILD_ID",
    "PORT",
    "CONFIG_DIR",
    "RELEASE_NAME",
    "TRUST_INTERNAL_HEADERS",
  ];
  let listenersBefore: {
    uncaught: Function[];
    rejection: Function[];
    sigterm: Function[];
    sigint: Function[];
  };

  beforeAll(async () => {
    listenersBefore = {
      uncaught: process.listeners("uncaughtException") as Function[],
      rejection: process.listeners("unhandledRejection") as Function[],
      sigterm: process.listeners("SIGTERM") as Function[],
      sigint: process.listeners("SIGINT") as Function[],
    };
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    staged = writeStagedDir();
    port = await getFreePort();

    process.env.POOL_NAME = "main";
    process.env.NEXT_BUILD_ID = BUILD_ID;
    process.env.PORT = String(port);
    process.env.CONFIG_DIR = staged.configDir;
    // Legacy trust mode (no secret configured): lets the Phase-2 dispatch headers
    // (x-output-id / x-mw-evaluated / x-resolved-headers / x-nextjs-ppr) through.
    process.env.TRUST_INTERNAL_HEADERS = "1";

    process.chdir(staged.dir);
    server = await startPoolServer();
  }, 60_000);

  afterAll(async () => {
    if (server) await server.close();
    process.chdir(REPO_ROOT);
    rmSync(staged.dir, { recursive: true, force: true });
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    const prune = (
      event: "uncaughtException" | "unhandledRejection" | "SIGTERM" | "SIGINT",
      before: Function[],
    ) => {
      for (const l of process.listeners(event)) {
        if (!before.includes(l as Function)) process.removeListener(event, l);
      }
    };
    prune("uncaughtException", listenersBefore.uncaught);
    prune("unhandledRejection", listenersBefore.rejection);
    prune("SIGTERM", listenersBefore.sigterm);
    prune("SIGINT", listenersBefore.sigint);
  });

  // ---- Fix 1: public files flow through dispatch with resolved-header merging ----

  it("Phase 2: public file honors x-resolved-headers cache-control over the 3600 default", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/header-priority.txt`, {
      headers: {
        "x-output-id": "/header-priority.txt",
        "x-mw-evaluated": "skip-nomatch",
        "x-resolved-headers": JSON.stringify({
          "cache-control": "max-age=1234",
          "x-custom-resolved": "1",
        }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("priority body");
    expect(res.headers.get("cache-control")).toBe("max-age=1234");
    // The full resolved set must merge, not just cache-control.
    expect(res.headers.get("x-custom-resolved")).toBe("1");
  });

  it("Phase 1: next.config headers() cache-control reaches a public file (next start parity)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/header-priority.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("priority body");
    expect(res.headers.get("cache-control")).toBe("max-age=1234");
  });

  it("Phase 1: public file without resolved headers keeps the adapter default + cache tag + ETag/304", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("probe body");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const revalidated = await fetch(`http://127.0.0.1:${port}/probe.txt`, {
      headers: { "if-none-match": etag! },
    });
    expect(revalidated.status).toBe(304);
  });

  it("Phase 1: a public file missing from the static manifest is still served from disk (last resort)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stale.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("stale body");
    // N31: `next start` answers a public/ file `public, max-age=0` (measured 2026-07-25 against
    // Next 16.2.10 — `Cache-Control: public, max-age=0`, `Content-Length: 13`, a weak ETag). The
    // disk last resort used to answer `public, max-age=3600`, so a browser copy outlived a
    // deploy of the same URL and no cache-tag could purge it (a browser cache has no tags).
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    // And with no shared-cache freshness window there is nothing at the CDN to tag: cdnCacheTag
    // returns {} for max-age=0, which is the M13 "tag only what the CDN can store" rule.
    expect(res.headers.get("cache-tag")).toBeNull();
    // N31: Content-Length is present (and HEAD reports it) — see the HEAD case below.
    expect(res.headers.get("content-length")).toBe(String("stale body".length));
  });

  // N31: all three disk/manifest serve sites `writeHead` without a length and then
  // `res.end(HEAD ? undefined : content)`. Node marks a HEAD response body-less and emits
  // NEITHER Content-Length NOR Transfer-Encoding, so HEAD reported no size at all where
  // `next start` sends the real one (measured: `Content-Length: 13` for a public file, 309404
  // for a build chunk). This is the same bug the image optimizer fixed and never propagated.
  it("HEAD on the public-file disk last resort reports Content-Length and no body", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stale.txt`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String("stale body".length));
    expect(res.headers.get("transfer-encoding")).toBeNull();
    expect(await res.text()).toBe("");
  });

  // N31: `next start` gates every static output on GET/HEAD (`res.setHeader('Allow',
  // ['GET','HEAD']); res.statusCode = 405` in router-server, before serveStatic). Measured:
  // POST/PUT/DELETE on a public file → 405. The adapter answered 200 with the whole body and
  // the deploy cache-tag, having read and discarded the request body. This disk path is the
  // live one for fixtures/main, whose static-assets.json carries no public/ entries.
  it("405s a write to a public file served from disk, with Allow and no body", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const res = await fetch(`http://127.0.0.1:${port}/stale.txt`, {
        method,
        ...(method === "POST" || method === "PUT" || method === "PATCH"
          ? { body: "should never be stored" }
          : {}),
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("GET, HEAD");
      expect(res.headers.get("cache-tag"), method).toBeNull();
      expect(await res.text(), method).toBe("");
    }
  });

  it("a write to a path with NO public file still falls through to routing (not a 405)", async () => {
    // `next start` 405s only once a static output matched; an unknown path is the router's.
    const res = await fetch(`http://127.0.0.1:${port}/no-such-public-file.txt`, {
      method: "POST",
      body: "x",
    });
    expect(res.status).not.toBe(405);
  });

  it("Phase 2: the disk last resort still merges resolved headers", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/stale.txt`, {
      headers: {
        "x-output-id": "/stale.txt",
        "x-mw-evaluated": "skip-nomatch",
        "x-resolved-headers": JSON.stringify({
          "cache-control": "max-age=1234",
          "x-custom-resolved": "1",
        }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("stale body");
    expect(res.headers.get("cache-control")).toBe("max-age=1234");
    expect(res.headers.get("x-custom-resolved")).toBe("1");
    // Still cacheable → still deploy-tagged.
    expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
  });

  // ---- Fix 2: explicit app cache-control beats the forced middleware no-cache ----

  it("middleware-covered public file: explicit resolved cache-control wins over forced no-cache", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mw-probe.txt`, {
      headers: {
        "x-output-id": "/mw-probe.txt",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({
          "cache-control": "public, max-age=0, must-revalidate",
          "x-mw-marker": "adapter-k8s-e2e",
        }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("mw probe body");
    expect(res.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(res.headers.get("x-mw-marker")).toBe("adapter-k8s-e2e");
    // max-age=0 is not CDN-cacheable → the deploy tag must not ride along.
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("middleware-covered handler: positive freshness is still forced to no-cache (CDN sits before middleware)", async () => {
    // `max-age=2345` would give Cloud CDN a 39-minute window in which hits bypass the
    // ext_proc middleware callout entirely — the exact hole forcedCdnCacheControl closes.
    // Explicit values only win when they force per-use revalidation (see the
    // grantsSharedCacheFreshness rule and the live suite's middleware-cache-probe test).
    const res = await fetch(`http://127.0.0.1:${port}/mw-covered`, {
      headers: {
        "x-output-id": "/mw-covered",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({
          "cache-control": "max-age=2345",
          "x-mw-marker": "adapter-k8s-e2e",
        }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("covered");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-mw-marker")).toBe("adapter-k8s-e2e");
    // no-cache → not CDN-cacheable → no deploy tag.
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("middleware-covered handler: s-maxage=0 with private wins (no shared freshness granted)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mw-covered`, {
      headers: {
        "x-output-id": "/mw-covered",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({
          "cache-control": "private, max-age=60",
          "x-mw-marker": "adapter-k8s-e2e",
        }),
      },
    });
    expect(res.status).toBe(200);
    // `private` vetoes shared-cache storage — browser caching is the app's call and
    // cannot bypass middleware at the CDN, so the explicit value is honored.
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("middleware-covered handler WITHOUT an explicit app cache-control stays forced no-cache", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mw-covered`, {
      headers: {
        "x-output-id": "/mw-covered",
        "x-mw-evaluated": "ran",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("covered");
    // The handler's own public max-age=7777 and cache-tag are stripped.
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("a response that itself sets no-store is never weakened by a resolved cache-control", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mw-nostore`, {
      headers: {
        "x-output-id": "/mw-nostore",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({ "cache-control": "max-age=2345" }),
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("nostore");
    // The forced middleware policy stands — the weaker resolved value must not
    // turn an uncacheable response cacheable.
    expect(["no-cache", "no-store"]).toContain(res.headers.get("cache-control"));
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  // ---- Phase-2 rewrite invocation target (x-invoke-path / x-invoke-query) ----

  it("Phase 2: trusted x-invoke-path/x-invoke-query reach the handler as the rewrite target", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/echo-public`, {
      headers: {
        "x-output-id": "/echo-target",
        "x-mw-evaluated": "skip-nomatch",
        "x-invoke-path": "/echo-target?item=one&item=two",
        "x-invoke-query": JSON.stringify({ item: ["one", "two"] }),
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resolvedPathname: string | null;
      rewrittenPathname: string | null;
      query: Record<string, string | string[]> | null;
    };
    // The handler must observe the REWRITTEN invocation target (with the repeated
    // destination query restored), not the public request URL.
    expect(body.resolvedPathname).toBe("/echo-target");
    expect(body.rewrittenPathname).toBe("/echo-target");
    expect(body.query).toEqual({ item: ["one", "two"] });
  });

  it("Phase 2: a malformed x-invoke-query is ignored, not a 500 (query recovered from x-invoke-path)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/echo-public`, {
      headers: {
        "x-output-id": "/echo-target",
        "x-mw-evaluated": "skip-nomatch",
        "x-invoke-path": "/echo-target?item=one&item=two",
        "x-invoke-query": "{not json",
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rewrittenPathname: string | null; query: unknown };
    expect(body.rewrittenPathname).toBe("/echo-target");
    // The invoker falls back to the query parsed out of the invocation path itself.
    expect(body.query).toEqual({ item: ["one", "two"] });
  });

  it("the PPR no-store verdict is never overridden by a resolved cache-control", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mw-covered`, {
      headers: {
        "x-nextjs-ppr": "1",
        "x-output-id": "/mw-covered",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({ "cache-control": "max-age=1234" }),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  // ---- N18 (SECURITY): the `_rsc` cache-busting param gates SHARED CACHEABILITY -----------
  //
  // Next validates `_rsc` against the RSC request headers and 307s a mismatch, because a CDN
  // that ignores Vary would otherwise let one header set poison the entry another header set
  // reads ("Neglecting to do this properly can lead to cache poisoning attacks on certain
  // CDNs" — base-server.ts). That check is behind `!this.minimalMode`; the adapter runs every
  // entrypoint in minimal mode, so the pool enforces it here. We do NOT 307 (see
  // routing-common.ts `rscCacheBustingUnvalidated`): the response is still correct for its own
  // headers, it just may not be STORED. Poisoning requires storage.
  //
  // `/probe.txt` is the sharpest probe available in this staged app: without the check it is
  // served `public, max-age=3600` WITH a deploy cache-tag — a cacheable, tagged entry.
  // Hash inputs and expectations are the recorded `next start` values; the derivation itself is
  // proven in tests/routing-common.rsc-cache-busting.test.ts.

  it("an RSC request with NO _rsc gets no-store and loses its cache tag", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt`, { headers: { rsc: "1" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("probe body");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("an RSC request with a FORGED _rsc gets no-store and loses its cache tag", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt?_rsc=DEADBEEFdeadbeef`, {
      headers: { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("a VALID bare `?_rsc` (no hash inputs) keeps the cacheable headers — no false positives", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt?_rsc`, { headers: { rsc: "1" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
  });

  it("a VALID hashed _rsc keeps the cacheable headers (modern and legacy forms)", async () => {
    const headers = { rsc: "1", "next-router-state-tree": "%5B%22%22%2C%7B%7D%5D" };
    for (const param of ["OxBCQ2sR9P8GlKR3", "1tccy"]) {
      const res = await fetch(`http://127.0.0.1:${port}/probe.txt?_rsc=${param}`, { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
      expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
    }
  });

  it("a hash bound to a DIFFERENT header set is rejected (the poisoning attempt itself)", async () => {
    // `_rsc` is the hash for prefetch=1 + segment=/_tree; the request sends a different
    // segment. Same URL, different content — exactly what must not become a shared entry.
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt?_rsc=_i_aeImnuN6u1u1r`, {
      headers: {
        rsc: "1",
        "next-router-prefetch": "1",
        "next-router-segment-prefetch": "/_index",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("a DOCUMENT request is untouched by the check, even with a forged _rsc", async () => {
    // Recorded `next start` behavior: no `rsc: 1` header ⇒ no validation, 200 as normal.
    const res = await fetch(`http://127.0.0.1:${port}/probe.txt?_rsc=DEADBEEFdeadbeef`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
  });

  it("an unvalidated RSC request cannot be made cacheable by an app cache-control", async () => {
    // The forced `no-store` must outrank next.config headers() / middleware response headers
    // carried in the resolved verdict — the same rule that protects the PPR verdict.
    const res = await fetch(`http://127.0.0.1:${port}/mw-covered`, {
      headers: {
        rsc: "1",
        "x-output-id": "/mw-covered",
        "x-mw-evaluated": "ran",
        "x-resolved-headers": JSON.stringify({ "cache-control": "public, max-age=1234" }),
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });
});
