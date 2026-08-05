// Survey Tier 1 #2 (plans/lessons-from-sibling-adapters.md): draft-mode bypass of the
// pool's `_next/data` static fast path.
//
// The fast path (index.ts, "truly static SSG data") serves `.next/server/pages/<page>.json`
// directly for prerendered pages this pool does not own a handler for. `next start`
// behaves differently in DRAFT MODE: a request carrying a `__prerender_bypass` cookie whose
// value equals the prerender manifest's `previewModeId` forces a fresh render — the staged
// prerender must not be served. Both reference adapters implement this (aws isr.ts:502-528
// checks query/header/cookie against bypassToken; vercel emits bypassToken per prerender);
// the pool already validates the same cookie for the strict-404 gate (dispatch.ts
// isAuthorizedBypass) but the static fast paths never consult it.
//
// An INVALID bypass value must keep hitting the fast path — upstream only honors an exact
// previewModeId match, and honoring arbitrary cookie values would let any client bust the
// static-serving tier.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { type AddressInfo } from "node:net";
import { createServer } from "node:http";

const REPO_ROOT = process.cwd();
const PREVIEW_MODE_ID = "draft-bypass-preview-id";
const DATA_BODY = JSON.stringify({ pageProps: { prerendered: true } });

process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";
delete process.env.VALKEY_URL;

const { startPoolServer } = await import("../../src/pool-server/index.js");

async function getFreePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

function writeStagedDir(): { dir: string; configDir: string } {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".draft-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(path.join(dir, "handlers"), { recursive: true });
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(path.join(dir, ".next", "server", "pages"), { recursive: true });

  writeFileSync(path.join(dir, "package.json"), "{}");
  // One importable handler so readiness reaches "serving". /foo deliberately has NO handler
  // in this pool — that is what routes its data URL onto the static fast path.
  writeFileSync(
    path.join(dir, "handlers", "hello.mjs"),
    `export function handler(req, res) { res.statusCode = 200; res.end("hello"); }\n`,
  );
  // The truly-static SSG data the fast path serves.
  writeFileSync(path.join(dir, ".next", "server", "pages", "foo.json"), DATA_BODY);
  writeFileSync(
    path.join(dir, ".next", "prerender-manifest.json"),
    JSON.stringify({
      version: 4,
      routes: {
        "/foo": { initialRevalidateSeconds: false, dataRoute: "/_next/data/draftbuild1/foo.json" },
      },
      dynamicRoutes: {},
      preview: {
        previewModeId: PREVIEW_MODE_ID,
        previewModeSigningKey: "0".repeat(64),
        previewModeEncryptionKey: "1".repeat(64),
      },
    }),
  );
  writeFileSync(
    path.join(configDir, "pool-manifest-main.json"),
    JSON.stringify({
      buildId: "draftbuild1",
      poolName: "main",
      outputs: {
        "/hello": {
          id: "/hello",
          filePath: "handlers/hello.mjs",
          pathname: "/hello",
          type: "PAGES",
        },
      },
    }),
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
      pathnames: ["/hello", "/foo"],
      i18n: null,
      buildId: "draftbuild1",
      basePath: "",
      middleware: null,
      poolAssignments: { "/hello": "main", "/foo": "main" },
      pprRoutes: {},
      nextVersion: "16.2.10",
    }),
  );
  return { dir, configDir };
}

describe("draft-mode bypass of the _next/data static fast path (survey Tier 1 #2)", () => {
  let staged: { dir: string; configDir: string };
  let server: Awaited<ReturnType<typeof startPoolServer>> | undefined;
  let port: number;
  let savedEnv: Record<string, string | undefined>;
  const envKeys = ["POOL_NAME", "NEXT_BUILD_ID", "PORT", "CONFIG_DIR", "TRUST_INTERNAL_HEADERS"];
  let listenersBefore: { uncaught: Function[]; rejection: Function[] };

  beforeAll(async () => {
    listenersBefore = {
      uncaught: process.listeners("uncaughtException") as Function[],
      rejection: process.listeners("unhandledRejection") as Function[],
    };
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    staged = writeStagedDir();
    port = await getFreePort();
    process.env.POOL_NAME = "main";
    process.env.NEXT_BUILD_ID = "draftbuild1";
    process.env.PORT = String(port);
    process.env.CONFIG_DIR = staged.configDir;
    delete process.env.TRUST_INTERNAL_HEADERS;
    process.chdir(staged.dir);
    server = await startPoolServer();
  }, 60_000);

  afterAll(async () => {
    await server?.stop({ graceMs: 100 });
    process.chdir(REPO_ROOT);
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.__NEXT_PREVIEW_MODE_ID;
    delete process.env.__NEXT_PREVIEW_MODE_SIGNING_KEY;
    delete process.env.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY;
    for (const l of process.listeners("uncaughtException")) {
      if (!listenersBefore.uncaught.includes(l)) process.removeListener("uncaughtException", l);
    }
    for (const l of process.listeners("unhandledRejection")) {
      if (!listenersBefore.rejection.includes(l)) process.removeListener("unhandledRejection", l);
    }
    rmSync(staged.dir, { recursive: true, force: true });
  });

  const dataUrl = () => `http://127.0.0.1:${port}/_next/data/draftbuild1/foo.json`;

  it("control: serves the staged prerender data without a bypass cookie", async () => {
    const res = await fetch(dataUrl());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DATA_BODY);
  });

  it("does NOT serve the staged prerender to an authorized draft-mode request", async () => {
    const res = await fetch(dataUrl(), {
      headers: { cookie: `__prerender_bypass=${PREVIEW_MODE_ID}` },
    });
    // Draft mode must fall through to a live render (here: no handler owns /foo, so the
    // pool's own 404 path answers). The one forbidden outcome is the staged bytes.
    expect(await res.text()).not.toBe(DATA_BODY);
  });

  it("ignores an INVALID bypass cookie (no cache-busting for unauthenticated clients)", async () => {
    const res = await fetch(dataUrl(), {
      headers: { cookie: `__prerender_bypass=wrong-value` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DATA_BODY);
  });
});
