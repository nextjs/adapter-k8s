// tests/pool-server/index.hardening.test.ts
// Real-server tests for the index.ts request boundary, booted through the actual
// startPoolServer against a synthetic staged dir (the style of index.smoke.test.ts /
// index.headers.test.ts — real sockets, no mocking of the thing under test):
//
//   • N30 the `/_next/data/<buildId>/…` read primitive over `.next/server/pages`
//   • N30 the PPR `no-store` verdict on a middleware-less app (no ext_proc header anywhere)
//   • N31 method gate + Content-Length on the `_next/static` disk serve
//   • N32 `/readyz` — including a build whose route module cannot be imported
//   • N34 the process-wide in-flight body budget
//
// The staged dirs live UNDER THE REPO ROOT so createRequire(<staged>/package.json) can resolve
// the repo's `next` (the pool requires several next/dist modules at boot).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import { createServer } from "node:http";

const REPO_ROOT = process.cwd();
const BUILD_ID = "hardenbuild1";
// A secret planted in the "compiled server bundle" below. It must never reach a client.
const PLANTED_SECRET = "SECRET_API_KEY=sk-live-do-not-leak-me";

// Small caps so the budget/limit tests need no large uploads. MUST be set before importing
// index.ts — both are read at module load.
process.env.ADAPTER_K8S_MAX_BODY_BYTES = "2048";
process.env.ADAPTER_K8S_MAX_INFLIGHT_BODY_BYTES = "2500";
// N35: the ONE image byte cap, shared by the external fetch and the loopback self-fetch (they
// used to disagree: 25 MiB vs 20 MiB). Tiny here so the test needs no large payload.
process.env.ADAPTER_K8S_MAX_IMAGE_BYTES = "64";
// Production cache wiring must stay out of this test regardless of the host env.
delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

interface Staged {
  dir: string;
  configDir: string;
}

type StageOptions = {
  /** Emit a handler module that throws on import — the N32 unloadable-build case. */
  brokenHandler?: boolean;
  /** Declare an app route at `/healthz` — the probe-shadowing case. */
  appOwnsHealthz?: boolean;
  /** Boot with a dispatch secret so trusted and UNTRUSTED Phase-2 requests can be told apart. */
  internalSecret?: string;
  /**
   * The production basePath manifest shape: keys (and pathnames) carry the basePath prefix
   * while each entry's `id` is Next's UNPREFIXED output id. Every basePath deploy shipped
   * this shape, and the readiness probe loaded by `.id` → "Unknown output ID" → /readyz 503
   * forever (measured: the full-run basePath cluster, ~20 suites, all rollout timeouts).
   */
  basePathKeys?: boolean;
};

function writeStagedDir(options: StageOptions = {}): Staged {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".harden-stage-"));
  const configDir = path.join(dir, "config");
  const serverPages = path.join(dir, ".next", "server", "pages");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(serverPages, { recursive: true });
  mkdirSync(path.join(dir, ".next", "static", "chunks"), { recursive: true });
  mkdirSync(path.join(dir, "handlers"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");

  // ---- the Pages server build: exactly the files measured as readable through /_next/data ----
  writeFileSync(
    path.join(serverPages, "_app.js"),
    `// compiled server bundle\nconst KEY = "${PLANTED_SECRET}";\nmodule.exports = { KEY };\n`,
  );
  writeFileSync(
    path.join(serverPages, "_app.js.map"),
    JSON.stringify({ version: 3, sources: ["../../src/pages/_app.tsx"], sourcesContent: ["x"] }),
  );
  writeFileSync(
    path.join(serverPages, "_app.js.nft.json"),
    JSON.stringify({ version: 1, files: ["/home/build-machine/app/node_modules/next/x.js"] }),
  );
  // The only legitimate data payload: `/ssg` IS in prerender-manifest.routes.
  writeFileSync(path.join(serverPages, "ssg.json"), JSON.stringify({ pageProps: { a: 1 } }));
  // On disk but NOT a prerender of this build (`next start` 404s such a data URL — measured for
  // `/index.json` on a static `/` with no getStaticProps).
  writeFileSync(path.join(serverPages, "orphan.json"), JSON.stringify({ pageProps: { b: 2 } }));

  writeFileSync(
    path.join(dir, ".next", "prerender-manifest.json"),
    JSON.stringify({
      version: 4,
      routes: {
        "/ssg": {
          initialRevalidateSeconds: false,
          srcRoute: null,
          dataRoute: `/_next/data/${BUILD_ID}/ssg.json`,
        },
      },
      dynamicRoutes: {},
      preview: {
        previewModeId: "preview-mode-id",
        previewModeSigningKey: "k",
        previewModeEncryptionKey: "k",
      },
    }),
  );

  writeFileSync(path.join(dir, ".next", "static", "chunks", "main.js"), "console.log('chunk');\n");

  // ---- handlers ----
  writeFileSync(
    path.join(dir, "handlers", "ssr.mjs"),
    `export function handler(req, res) {
       // A PPR/dynamic entrypoint's own origin-oriented verdict — exactly what leaked to the CDN
       // for a year when the pool had no local PPR knowledge.
       res.writeHead(200, {
         "content-type": "text/html; charset=utf-8",
         "cache-control": "s-maxage=31536000",
       });
       res.end("<html>unfinished shell</html>");
     }
    `,
  );
  writeFileSync(
    path.join(dir, "handlers", "slow.mjs"),
    `export function handler(req, res) {
       setTimeout(() => {
         res.writeHead(200, { "content-type": "text/plain" });
         res.end("slow ok");
       }, 1500);
     }
    `,
  );
  // A route-served image comfortably above the (tiny, env-set) shared image cap.
  writeFileSync(
    path.join(dir, "handlers", "big-image.mjs"),
    `export function handler(req, res) {
       const body = Buffer.alloc(4096, 0x41);
       res.writeHead(200, {
         "content-type": "image/png",
         "content-length": String(body.length),
       });
       res.end(body);
     }
    `,
  );
  // Echoes exactly what the handler observes on req.headers — the only way to prove that
  // middleware's final request-header set was installed as a REPLACEMENT (N40).
  writeFileSync(
    path.join(dir, "handlers", "echo-headers.mjs"),
    `export function handler(req, res) {
       res.writeHead(200, { "content-type": "application/json" });
       res.end(JSON.stringify({
         userId: req.headers["x-user-id"] ?? null,
         authenticatedUser: req.headers["x-authenticated-user"] ?? null,
         mwRequestHeaders: req.headers["x-mw-request-headers"] ?? null,
         resolvedHeaders: req.headers["x-resolved-headers"] ?? null,
         internalSecret: req.headers["x-internal-secret"] ?? null,
       }));
     }
    `,
  );
  writeFileSync(
    path.join(dir, "handlers", "healthz.mjs"),
    `export function handler(req, res) {
       res.writeHead(200, { "content-type": "text/plain" });
       res.end("app-owned healthz");
     }
    `,
  );
  if (options.brokenHandler) {
    // The N32 case: a build whose Next output cannot be import()ed at all (missing chunk,
    // broken native dep, a top-level await that rejects). /healthz answered 200 regardless.
    writeFileSync(
      path.join(dir, "handlers", "ssr.mjs"),
      `throw new Error("Cannot find module './chunks/9271.js'");\n`,
    );
  }

  // The production basePath shape prefixes the manifest KEY and `pathname` but keeps Next's
  // unprefixed output id — see StageOptions.basePathKeys.
  const keyPrefix = options.basePathKeys ? "/base" : "";
  const outputs: Record<string, unknown> = {
    [`${keyPrefix}/ssr`]: {
      id: "/ssr",
      filePath: "handlers/ssr.mjs",
      pathname: `${keyPrefix}/ssr`,
      type: "APP_PAGE",
    },
    "/slow": { id: "/slow", filePath: "handlers/slow.mjs", pathname: "/slow", type: "PAGES_API" },
    "/big-image": {
      id: "/big-image",
      filePath: "handlers/big-image.mjs",
      pathname: "/big-image",
      type: "PAGES_API",
    },
    "/echo-headers": {
      id: "/echo-headers",
      filePath: "handlers/echo-headers.mjs",
      pathname: "/echo-headers",
      type: "PAGES_API",
    },
  };
  const pathnames = ["/ssr", "/slow", "/big-image", "/echo-headers"];
  if (options.appOwnsHealthz) {
    outputs["/healthz"] = {
      id: "/healthz",
      filePath: "handlers/healthz.mjs",
      pathname: "/healthz",
      type: "PAGES_API",
    };
    pathnames.push("/healthz");
  }

  writeFileSync(
    path.join(configDir, `pool-manifest-main.json`),
    JSON.stringify({ buildId: BUILD_ID, poolName: "main", outputs }),
  );
  writeFileSync(
    path.join(configDir, "routing-manifest.json"),
    JSON.stringify({
      routeGraph: {
        beforeMiddleware: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
        rsc: { header: "rsc", suffix: ".rsc" },
      },
      pathnames,
      i18n: null,
      buildId: BUILD_ID,
      basePath: "",
      // NO middleware — the review's "middleware-less app" case. Nothing stamps `x-nextjs-ppr`
      // in such a deployment (there is no traffic extension at all), and `middlewareCovers` is
      // false for every request, so the ONLY source of the PPR verdict is the local inventory.
      middleware: null,
      poolAssignments: Object.fromEntries(pathnames.map((p) => [p, "main"])),
      // `fallbackFilePath` deliberately points at a file that does not exist: the resume-token
      // injection is then skipped (shellAvailable === false) and the handler answers normally,
      // which isolates the CACHE-POLICY behavior under test from the PPR resume machinery.
      pprRoutes: {
        "/ssr": { postponedState: "state", fallbackFilePath: ".next/missing-shell.html" },
      },
      pprCapableRoutes: {},
      nextVersion: "16.2.10",
    }),
  );
  writeFileSync(path.join(configDir, "static-assets.json"), JSON.stringify([]));
  return { dir, configDir };
}

async function getFreePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

const ENV_KEYS = [
  "__NEXT_PRIVATE_ORIGIN",
  "POOL_NAME",
  "NEXT_BUILD_ID",
  "PORT",
  "CONFIG_DIR",
  "RELEASE_NAME",
  "TRUST_INTERNAL_HEADERS",
  "INTERNAL_HEADER_SECRET",
];

/** Boot the real pool server against a staged dir; returns a teardown that fully undoes it. */
async function boot(options: StageOptions = {}) {
  const listenersBefore = {
    uncaught: process.listeners("uncaughtException") as Function[],
    rejection: process.listeners("unhandledRejection") as Function[],
    sigterm: process.listeners("SIGTERM") as Function[],
    sigint: process.listeners("SIGINT") as Function[],
  };
  const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // A previously-imported module (next's own start-server machinery) may have set this in
  // the shared test process — the assertion below must prove the POOL sets it.
  delete process.env.__NEXT_PRIVATE_ORIGIN;
  const staged = writeStagedDir(options);
  const port = await getFreePort();
  process.env.POOL_NAME = "main";
  process.env.NEXT_BUILD_ID = BUILD_ID;
  process.env.PORT = String(port);
  process.env.CONFIG_DIR = staged.configDir;
  delete process.env.TRUST_INTERNAL_HEADERS;
  if (options.internalSecret) process.env.INTERNAL_HEADER_SECRET = options.internalSecret;
  else delete process.env.INTERNAL_HEADER_SECRET;
  process.chdir(staged.dir);
  const server = await startPoolServer();

  return {
    port,
    staged,
    async stop() {
      await server.close();
      process.chdir(REPO_ROOT);
      rmSync(staged.dir, { recursive: true, force: true });
      for (const key of ENV_KEYS) {
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
    },
  };
}

describe("pool-server request-boundary hardening", () => {
  let pool: Awaited<ReturnType<typeof boot>>;
  const url = (p: string) => `http://localhost:${pool.port}${p}`;

  beforeAll(async () => {
    pool = await boot();
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  // ---- N30 (SECURITY): /_next/data/<buildId>/<anything> served the Pages server build ----
  //
  // Measured against `next start` on a real Pages build (Next 16.2.10, 2026-07-25) with the
  // build id in the URL — which is public, it appears in every asset URL:
  //   /_next/data/<id>/ssg.json        → 200 application/json (36 B)
  //   /_next/data/<id>/_app.js         → 404
  //   /_next/data/<id>/_app.js.map     → 404
  //   /_next/data/<id>/_app.js.nft.json→ 404
  //   /_next/data/<id>/index.json      → 404   (a static `/` has no data route)
  // The adapter answered the middle three with 200 + `application/json` and the file's bytes:
  // the compiled server bundle, then the source map (⇒ original TypeScript), then absolute
  // build-machine paths. The gate was `!middlewareCovers`, i.e. ALWAYS for an app like this one.
  describe("N30: /_next/data is restricted to real data routes", () => {
    it("serves a legitimate SSG data payload", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/ssg.json`));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.json()).toEqual({ pageProps: { a: 1 } });
    });

    it("reports Content-Length and no body for a HEAD of that payload", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/ssg.json`), { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(
        String(JSON.stringify({ pageProps: { a: 1 } }).length),
      );
      expect(await res.text()).toBe("");
    });

    it("does NOT serve the compiled server bundle (and never leaks its secret)", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/_app.js`));
      expect(res.status).not.toBe(200);
      const body = await res.text();
      expect(body).not.toContain(PLANTED_SECRET);
      expect(body).not.toContain("module.exports");
    });

    it("does NOT serve a source map (which carries the original TypeScript)", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/_app.js.map`));
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("sourcesContent");
    });

    it("does NOT serve an .nft.json trace (absolute build-machine paths) — `.json` alone is not enough", async () => {
      // This is why the fix cannot be a suffix check: `_app.js.nft.json` ENDS IN `.json`.
      const res = await fetch(url(`/_next/data/${BUILD_ID}/_app.js.nft.json`));
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("/home/build-machine/");
    });

    it("does NOT serve a .json on disk whose page is not a prerender of this build", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/orphan.json`));
      expect(res.status).not.toBe(200);
      expect(await res.text()).not.toContain("pageProps");
    });

    it("refuses an encoded-separator traversal attempt", async () => {
      const res = await fetch(url(`/_next/data/${BUILD_ID}/..%2f..%2f..%2fpackage.json`));
      expect(res.status).not.toBe(200);
    });
  });

  // ---- N30 (SECURITY/CACHE): the PPR verdict without any ext_proc header ----
  describe("N30: the PPR no-store verdict is computed locally", () => {
    it("forces no-store for a PPR route with NO x-nextjs-ppr header at all", async () => {
      const res = await fetch(url("/ssr"));
      expect(res.status).toBe(200);
      // Before: `s-maxage=31536000` with no cache-tag — a year of Cloud CDN storage for an
      // unfinished shell that cutover tag invalidation could never purge (M13 class).
      // `next start` answers a PPR document `private, no-cache, no-store, max-age=0,
      // must-revalidate` (measured); `no-store` is the adapter's equivalent verdict.
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cache-tag")).toBeNull();
    });

    it("still honors the header as a hint when it IS present", async () => {
      const res = await fetch(url("/ssr"), { headers: { "x-nextjs-ppr": "1" } });
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("leaves a NON-PPR route's own cache-control alone", async () => {
      // The local verdict must be a route decision, not a blanket one.
      const res = await fetch(url("/slow"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBeNull();
    });

    it("leaves an immutable build asset immutable (the plain-asset exclusion)", async () => {
      // A root optional catch-all PPR template would otherwise match every asset URL and force
      // `no-store` onto content `next start` serves `public, max-age=31536000, immutable`.
      const res = await fetch(url("/_next/static/chunks/main.js"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    });
  });

  // ---- N31: method gate + Content-Length on the _next/static disk serve ----
  describe("N31: _next/static serve is GET/HEAD only and reports its length", () => {
    const asset = "/_next/static/chunks/main.js";
    const bytes = "console.log('chunk');\n".length;

    it("GET returns the asset with Content-Length", async () => {
      const res = await fetch(url(asset));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(bytes));
    });

    it("HEAD reports Content-Length and no body", async () => {
      const res = await fetch(url(asset), { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-length")).toBe(String(bytes));
      expect(res.headers.get("transfer-encoding")).toBeNull();
      expect(await res.text()).toBe("");
    });

    it("405s every other method with Allow, and never echoes the asset", async () => {
      // Measured on `next start`: POST/PUT/DELETE on a build chunk → 405 (`Allow: GET`,
      // `Allow: HEAD`). The adapter answered 200 with all 309404 bytes of the real fixture's
      // chunk plus the deploy cache-tag, after reading and discarding the request body.
      for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
        const res = await fetch(url(asset), {
          method,
          ...(method === "POST" || method === "PUT" ? { body: "x" } : {}),
        });
        expect(res.status, method).toBe(405);
        expect(res.headers.get("allow"), method).toBe("GET, HEAD");
        expect(await res.text(), method).toBe("");
      }
    });

    it("still 404s a missing asset for a GET", async () => {
      const res = await fetch(url("/_next/static/chunks/nope.js"));
      expect(res.status).toBe(404);
    });
  });

  // ---- N35: one shared image byte cap ----
  describe("N35: the optimizer's byte cap is one number for every source", () => {
    it("413s a route-served image above ADAPTER_K8S_MAX_IMAGE_BYTES", async () => {
      // The loopback self-fetch used a LOCAL 20 MiB constant while the external fetch used the
      // 25 MiB REQUEST-body cap, so the same oversize source was refused or buffered depending on
      // which side of `isAbsolute` it arrived on. Both now read MAX_IMAGE_BYTES.
      const res = await fetch(url("/_next/image?url=/big-image&w=640&q=75"));
      expect(res.status).toBe(413);
      expect(await res.text()).toBe('"url" parameter is valid but internal response is invalid');
    });
  });

  // ---- N32: readiness ----
  describe("N32: /readyz on a healthy build", () => {
    it("reports ready, and names what it verified", async () => {
      const res = await fetch(url("/readyz"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; reason: string };
      expect(body.status).toBe("ok");
      expect(body.reason).toContain("route module loaded");
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("publishes the loopback origin for self-forwarded requests (Server Action forwarding)", async () => {
      // next start sets __NEXT_PRIVATE_ORIGIN to its own URL (start-server.js) and action
      // forwarding fetches `${origin}${workerPathname}` — without it the pool fell back to
      // the request's PUBLIC origin and hairpinned action POSTs through the whole edge
      // (full-run v4: app-action forwarding, both runtimes, "<null>" results).
      expect(process.env.__NEXT_PRIVATE_ORIGIN).toBe(`http://127.0.0.1:${pool.port}`);
    });

    it("answers a probe with a query string too (the old check was exact-match on req.url)", async () => {
      expect((await fetch(url("/readyz?from=kubelet"))).status).toBe(200);
      expect((await fetch(url("/healthz?from=kubelet"))).status).toBe(200);
    });
  });

  // ---- N34: the process-wide in-flight body budget ----
  describe("N34: in-flight body budget", () => {
    it("503s the upload that would exceed the process budget while the first is still held", async () => {
      // Caps for this file: 2048 B per request, 2500 B across all in-flight requests. `/slow`
      // holds its response (and therefore its charge) for 1500 ms, so the second 1500-byte
      // upload is what pushes the total past the budget.
      const body = "a".repeat(1500);
      const first = fetch(url("/slow"), { method: "POST", body });
      // Let the first upload be fully received (1500 B on loopback) before the second starts.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const second = await fetch(url("/slow"), { method: "POST", body });
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("1");
      expect(await second.text()).toBe("Service Unavailable");
      // The admitted request is unaffected.
      const firstRes = await first;
      expect(firstRes.status).toBe(200);
      expect(await firstRes.text()).toBe("slow ok");
    });

    it("releases the budget once responses complete, so later uploads are admitted again", async () => {
      const res = await fetch(url("/slow"), { method: "POST", body: "b".repeat(1500) });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("slow ok");
    });

    it("still answers the per-request cap with 413, not 503", async () => {
      const res = await fetch(url("/slow"), { method: "POST", body: "c".repeat(4096) });
      expect(res.status).toBe(413);
      expect(await res.text()).toBe("Payload Too Large");
    });
  });
});

// ---- N32: the failure this endpoint exists for ----
describe("N32: /readyz goes ready on a basePath build (manifest keys prefixed, Next ids not)", () => {
  let pool: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    pool = await boot({ basePathKeys: true });
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  it("verifies a route module by its manifest KEY, not Next's unprefixed output id", async () => {
    // Every basePath deploy shipped keys like "/base/ssr" with id "/ssr". Probing by `.id`
    // could never load anything ("Unknown output ID"), so /readyz sat 503 and the blue/green
    // gate timed every basePath rollout out — the full run's ~20-suite basePath cluster.
    const res = await fetch(`http://localhost:${pool.port}/readyz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("ok");
    expect(body.reason).toContain("route module loaded");
  });
});

describe("N32: /readyz withholds traffic from a build whose route module cannot load", () => {
  let pool: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    pool = await boot({ brokenHandler: true });
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  it("still answers /healthz 200 — liveness is not the gate", async () => {
    const res = await fetch(`http://localhost:${pool.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers /readyz 503 with the reason", async () => {
    const res = await fetch(`http://localhost:${pool.port}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("unavailable");
    expect(body.reason).toContain("failed to load");
  });

  it("and the app route it could not load does 500 — which is what the gate must catch", async () => {
    const res = await fetch(`http://localhost:${pool.port}/ssr`);
    expect(res.status).toBe(500);
  });
});

// ---- N32/low: a probe path the app owns must not be shadowed ----
describe("N32: an app route named /healthz is served, not shadowed", () => {
  let pool: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    pool = await boot({ appOwnsHealthz: true });
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  it("serves the app's own /healthz", async () => {
    const res = await fetch(`http://localhost:${pool.port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("app-owned healthz");
  });

  it("keeps /readyz as the pool's probe (the app declares no such route)", async () => {
    const res = await fetch(`http://localhost:${pool.port}/readyz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });
});

// A raw-socket assertion that the 405 gate fires BEFORE the request body is buffered: the
// response must arrive without the pool having read the declared payload.
describe("N31: an oversize write to an asset URL is refused without buffering it", () => {
  let pool: Awaited<ReturnType<typeof boot>>;

  beforeAll(async () => {
    pool = await boot();
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  it("405s a POST to a build chunk declaring a body far above the per-request cap", async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: pool.port });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("raw request timed out"));
      }, 5000);
      socket.on("connect", () => {
        socket.write(
          `POST /_next/static/chunks/main.js HTTP/1.1\r\nHost: localhost\r\n` +
            `Content-Length: 100000\r\nConnection: close\r\n\r\n`,
        );
        // Deliberately send NO body: a 405 that had to buffer first would hang here.
      });
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString());
      });
      socket.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(raw).toContain("405");
    expect(raw.toLowerCase()).toContain("allow: get, head");
  });
});

// ---- N40 (SECURITY, pool half of the Phase-2 middleware-request-header contract) ----
//
// `responseToMiddlewareResult` produces middleware's FINAL request-header set. Phase 1 captures it
// and dispatch installs it as a REPLACEMENT for `req.headers` (the override list is authoritative:
// a header absent from the set was DELETED by middleware). Phase 2 built the same set at the edge
// and threw it away, and the dispatch vocabulary had no transport for it — so
// `NextResponse.next({ request: { headers } })` was a no-op in production while
// `x-mw-evaluated: ran` told the pool the middleware stage was complete. A middleware that strips a
// spoofed `x-user-id` or stamps `x-authenticated-user` accomplished NEITHER, and the client's
// spoofed header reached the handler unmodified. The edge now stamps the secret-gated
// `x-mw-request-headers`; this is the pool side that applies it.
describe("N40: Phase 2 installs the middleware's final request-header set", () => {
  let pool: Awaited<ReturnType<typeof boot>>;
  const SECRET = "an-internal-dispatch-secret";

  beforeAll(async () => {
    pool = await boot({ internalSecret: SECRET });
  }, 60_000);
  afterAll(async () => {
    await pool.stop();
  });

  // The middleware's verdict: `x-user-id` deleted, `x-authenticated-user` added.
  const MW_HEADERS = JSON.stringify({
    host: "localhost",
    "x-authenticated-user": "alice",
  });

  // The trusted cases use a PUBLIC url the dispatch headers redirect to `/echo-headers`; the
  // untrusted ones must request the route directly, because stripping `x-output-id` (correctly)
  // leaves Phase 1 to resolve the url itself.
  async function echo(headers: Record<string, string>, requestPath = "/echo-public") {
    const res = await fetch(`http://localhost:${pool.port}${requestPath}`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      userId: string | null;
      authenticatedUser: string | null;
      mwRequestHeaders: string | null;
      resolvedHeaders: string | null;
      internalSecret: string | null;
    };
  }

  it("applies it as a REPLACEMENT for a trusted request: added header in, deleted header gone", async () => {
    const body = await echo({
      "x-internal-secret": SECRET,
      "x-output-id": "/echo-headers",
      "x-mw-evaluated": "ran",
      "x-mw-request-headers": MW_HEADERS,
      // The client's spoof, which the middleware deleted at the edge.
      "x-user-id": "spoofed-by-client",
    });
    expect(body.authenticatedUser).toBe("alice");
    expect(body.userId).toBeNull();
  });

  it("never leaks the transport header (or the secret) to the handler", async () => {
    const body = await echo({
      "x-internal-secret": SECRET,
      "x-output-id": "/echo-headers",
      "x-mw-evaluated": "ran",
      "x-mw-request-headers": MW_HEADERS,
      "x-resolved-headers": JSON.stringify({ "x-from-headers-rule": "1" }),
    });
    expect(body.mwRequestHeaders).toBeNull();
    expect(body.resolvedHeaders).toBeNull();
    expect(body.internalSecret).toBeNull();
  });

  it("RED TEAM: an UNTRUSTED request cannot install request headers with it", async () => {
    // No secret ⇒ server.ts strips every INTERNAL_DISPATCH_HEADER, `x-mw-request-headers`
    // included, and the request is fully re-resolved locally (invariant #1).
    const body = await echo(
      {
        "x-output-id": "/echo-headers",
        "x-mw-evaluated": "ran",
        "x-mw-request-headers": JSON.stringify({
          host: "localhost",
          "x-authenticated-user": "attacker",
        }),
        "x-user-id": "spoofed-by-client",
      },
      "/echo-headers",
    );
    // The forged identity must NOT appear...
    expect(body.authenticatedUser).toBeNull();
    // ...and nothing pretended middleware ran: this app has none, so the client's own header
    // is simply untouched (there is no middleware policy to have stripped it).
    expect(body.userId).toBe("spoofed-by-client");
    expect(body.mwRequestHeaders).toBeNull();
  });

  it("RED TEAM: a WRONG secret of the same length is also refused", async () => {
    const wrong = "x".repeat(SECRET.length);
    expect(wrong.length).toBe(SECRET.length);
    const body = await echo(
      {
        "x-internal-secret": wrong,
        "x-output-id": "/echo-headers",
        "x-mw-evaluated": "ran",
        "x-mw-request-headers": MW_HEADERS,
        "x-user-id": "spoofed-by-client",
      },
      "/echo-headers",
    );
    expect(body.authenticatedUser).toBeNull();
    expect(body.userId).toBe("spoofed-by-client");
  });
});
