// tests/pool-server/index.instrumentation.test.ts
// `instrumentation.js` register() at pool startup — `next start` parity.
//
// What `next start` does (Next 16.2.10; source + measured on a live server 2026-07-25):
//   • `NextNodeServer.prepareImpl()` → `runInstrumentationHookIfAvailable()` →
//     `ensureInstrumentationRegistered(dir, distDir)`, which requires
//     `<distDir>/server/instrumentation.js` and AWAITS its `register()`.
//   • The port binds first, but every request queues behind `handlersPromise`, which
//     resolves only after `render-server`'s `initializeImpl` awaits `server.prepare()`.
//     With a `register()` that sleeps 1500 ms: port accepting +98 ms, register start
//     +124 ms, register DONE +1626 ms, first response +1674 ms with the completion flag
//     already set. So register() completes before the first request is served.
//   • Exactly once per process (the promise is memoized module-level).
//   • Missing file: silent no-op (ENOENT / MODULE_NOT_FOUND are swallowed).
//
// This file covers the SUCCESS and ABSENT cases. The throwing-register() case lives in
// index.instrumentation-failure.test.ts because Next memoizes the registration promise
// module-globally: a failed registration in this worker would poison every later boot.
//
// The staged dirs live UNDER THE REPO ROOT so createRequire(<staged>/package.json)
// resolves the repo's `next` — the pool reuses Next's own
// `ensureInstrumentationRegistered` so it shares that memo with the lazy registration
// Next performs in `RouteModule.prepare()` (verified: both call sites resolve to the same
// `next/dist/server/lib/router-utils/instrumentation-globals.external.js`, and require()
// and await import() of it return the same function object).
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = process.cwd();

delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

// The hook records its calls on a file so the assertions do not depend on sharing a
// module graph with the (CJS, app-resolved) instrumentation module.
function writeStagedDir(instrumentation: string | null): { dir: string; configDir: string } {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".instr-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(path.join(dir, ".next", "server"), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "public", "hello.txt"), "hello static");
  if (instrumentation !== null) {
    writeFileSync(path.join(dir, ".next", "server", "instrumentation.js"), instrumentation);
  }
  writeFileSync(
    path.join(configDir, "pool-manifest-main.json"),
    JSON.stringify({ buildId: "instrbuild1", poolName: "main", outputs: {} }),
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
      pathnames: [],
      i18n: null,
      buildId: "instrbuild1",
      basePath: "",
      middleware: null,
      poolAssignments: {},
      pprRoutes: {},
      nextVersion: "16.2.10",
    }),
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

const envKeys = ["POOL_NAME", "NEXT_BUILD_ID", "PORT", "CONFIG_DIR", "RELEASE_NAME"] as const;
const events = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;

interface Booted {
  port: number;
  dir: string;
  close: () => Promise<void>;
}

let active: {
  server: Awaited<ReturnType<typeof startPoolServer>> | undefined;
  staged: { dir: string; configDir: string } | undefined;
  savedEnv: Record<string, string | undefined>;
  listenersBefore: Record<string, Function[]>;
} | null = null;

async function boot(instrumentation: string | null): Promise<Booted> {
  const listenersBefore = Object.fromEntries(
    events.map((e) => [e, process.listeners(e as "SIGTERM") as Function[]]),
  );
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const staged = writeStagedDir(instrumentation);
  const port = await getFreePort();
  process.env.POOL_NAME = "main";
  process.env.NEXT_BUILD_ID = "instrbuild1";
  process.env.PORT = String(port);
  process.env.CONFIG_DIR = staged.configDir;
  process.chdir(staged.dir);
  active = { server: undefined, staged, savedEnv, listenersBefore };
  const server = await startPoolServer();
  active.server = server;
  return { port, dir: staged.dir, close: () => server.close() };
}

async function cleanup(): Promise<void> {
  if (!active) return;
  const { server, staged, savedEnv, listenersBefore } = active;
  if (server) await server.close().catch(() => undefined);
  process.chdir(REPO_ROOT);
  if (staged) rmSync(staged.dir, { recursive: true, force: true });
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const event of events) {
    for (const l of process.listeners(event as "SIGTERM")) {
      if (!(listenersBefore[event] ?? []).includes(l as Function)) {
        process.removeListener(event as "SIGTERM", l as never);
      }
    }
  }
  active = null;
}

describe("instrumentation.js register() at pool startup", () => {
  afterEach(async () => {
    await cleanup();
  });

  it("is a silent no-op when the app has no instrumentation hook", async () => {
    // Same as `next start`, which swallows ENOENT/MODULE_NOT_FOUND from the require. The
    // boot must not fail, warn, or delay for the (overwhelmingly common) no-hook app.
    const { port } = await boot(null);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  }, 60_000);

  it("awaits register() to completion BEFORE the first request can be served", async () => {
    // The hook writes marker files: `registered` after an awaited async tick, and
    // `calls` incremented on every invocation. Because startPoolServer only listens after
    // the hook resolves, `registered` MUST already exist when the first response arrives —
    // a stronger guarantee than `next start`, which binds the port first and queues.
    const { port, dir } = await boot(
      `const fs = require("node:fs");
       const path = require("node:path");
       exports.register = async function register() {
         const calls = path.join(__dirname, "calls");
         fs.appendFileSync(calls, "x");
         // A real register() awaits (SDK start, dynamic import of instrumentation.node).
         await new Promise((resolve) => setTimeout(resolve, 150));
         fs.writeFileSync(path.join(__dirname, "registered"), String(Date.now()));
       };
      `,
    );
    const { existsSync, readFileSync } = await import("node:fs");
    const marker = path.join(dir, ".next", "server", "registered");
    // Observed from the first request onwards — not from a later poll, which would prove
    // nothing about ordering.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(path.join(dir, ".next", "server", "calls"), "utf-8")).toBe("x");
  }, 60_000);

  it("does not register a SECOND time — it shares Next's memoized promise", async () => {
    // Next also calls ensureInstrumentationRegistered lazily from RouteModule.prepare on
    // the entrypoint path the pool dispatches into. Going through Next's own function
    // (rather than requiring the hook ourselves) is what makes that exactly-once: an OTEL
    // SDK started twice is a real failure, not a cosmetic one. Here the memo is already
    // resolved from the previous test's boot, so a fresh boot must NOT invoke register()
    // again even though a hook file is present.
    const { port, dir } = await boot(
      `const fs = require("node:fs");
       const path = require("node:path");
       exports.register = function register() {
         fs.appendFileSync(path.join(__dirname, "calls"), "x");
       };
      `,
    );
    const { existsSync } = await import("node:fs");
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    // This boot's own hook was never invoked: the process-wide registration already
    // happened (in the previous test), exactly as it would if a request had triggered
    // Next's lazy path first.
    expect(existsSync(path.join(dir, ".next", "server", "calls"))).toBe(false);
  }, 60_000);
});
