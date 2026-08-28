// tests/pool-server/index.instrumentation-failure.test.ts
// A THROWING `instrumentation.js` register() must not stop the pool from booting.
//
// Separate file on purpose: Next memoizes the registration promise module-globally, so a
// rejected registration poisons every later boot in the same worker. Vitest isolates by
// file, which keeps this case out of index.instrumentation.test.ts.
//
// What `next start` does with a throwing register() (measured 2026-07-25, Next 16.2.10):
// the process does NOT exit — it logs "Failed to prepare server" plus an unhandledRejection
// and stays up — but the rejected promise is memoized, so every request 500s forever
// (3/3 `/api/*` and `/` → 500 "Internal Server Error", process alive after 6 s).
//
// The adapter deliberately does not reproduce the "500 everything" half by hand, and it
// does not need to: it registers through Next's OWN
// `ensureInstrumentationRegistered`, which `RouteModule.prepare()` re-awaits per request on
// the entrypoint path the pool dispatches into — so Next's routes inherit upstream's
// fail-closed behavior from upstream's own memo. What the adapter adds is that /healthz,
// static assets and /_next/image keep working, so a broken instrumentation hook fails the
// blue/green health gate (leaving the previous build serving) instead of turning into a
// CrashLoopBackOff.
import { describe, it, expect, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = process.cwd();

delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

const envKeys = ["POOL_NAME", "NEXT_BUILD_ID", "PORT", "CONFIG_DIR", "RELEASE_NAME"] as const;
const events = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;

let staged: { dir: string; configDir: string } | undefined;
let server: Awaited<ReturnType<typeof startPoolServer>> | undefined;
const savedEnv: Record<string, string | undefined> = Object.fromEntries(
  envKeys.map((k) => [k, process.env[k]]),
);
const listenersBefore: Record<string, Function[]> = Object.fromEntries(
  events.map((e) => [e, process.listeners(e as "SIGTERM") as Function[]]),
);

afterAll(async () => {
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
});

describe("instrumentation.js register() that throws", () => {
  it("logs loudly and keeps serving instead of failing the boot", async () => {
    const dir = mkdtempSync(path.join(REPO_ROOT, ".instr-fail-stage-"));
    const configDir = path.join(dir, "config");
    mkdirSync(path.join(dir, "public"), { recursive: true });
    mkdirSync(path.join(dir, ".next", "server"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), "{}");
    // A real 1x1 PNG so the optimizer path can be exercised after the failed registration.
    writeFileSync(
      path.join(dir, "public", "tiny.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    writeFileSync(
      path.join(dir, ".next", "server", "instrumentation.js"),
      `exports.register = async function register() {
         throw new Error("boom from register");
       };
      `,
    );
    writeFileSync(
      path.join(configDir, "pool-manifest-main.json"),
      JSON.stringify({ buildId: "instrfail1", poolName: "main", outputs: {} }),
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
        buildId: "instrfail1",
        basePath: "",
        middleware: null,
        poolAssignments: {},
        pprRoutes: {},
        nextVersion: "16.3.0",
      }),
    );
    staged = { dir, configDir };

    const srv = createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
    const port = (srv.address() as AddressInfo).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));

    process.env.POOL_NAME = "main";
    process.env.NEXT_BUILD_ID = "instrfail1";
    process.env.PORT = String(port);
    process.env.CONFIG_DIR = configDir;
    process.chdir(dir);

    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    try {
      // Must RESOLVE — an instrumentation crash cannot be allowed to take the pod down.
      server = await startPoolServer();
    } finally {
      spy.mockRestore();
    }

    // Loud: the operator has to be able to find this in the pod log.
    const logged = errors.map((args) => args.map((a) => String(a)).join(" ")).join("\n");
    expect(logged).toContain("instrumentation register() FAILED");
    expect(logged).toContain("boom from register");

    // And the pod still answers the health probe and the adapter-owned optimizer path, so
    // the blue/green gate — not the kubelet's restart loop — decides what happens next.
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    const image = await fetch(`http://127.0.0.1:${port}/_next/image?url=/tiny.png&w=384&q=75`, {
      headers: { accept: "image/webp" },
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    await image.arrayBuffer();
  }, 60_000);
});
