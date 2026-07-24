// tests/pool-server/index.smoke.test.ts
// Startup smoke test for src/pool-server/index.ts (previously zero coverage): boots
// the real server against a synthetic staged dir and exercises the request-level
// hardening that only exists at the index.ts boundary (413 delivery, forged
// content-length, /_next/image SSRF/XSS guards, malformed Host rejection).
//
// The staged dir lives UNDER THE REPO ROOT so createRequire(<staged>/package.json)
// can resolve the repo's `next` (pool-server requires several next/dist modules at
// boot). It is created and removed by this test.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import net, { type AddressInfo } from "node:net";
import { createServer } from "node:http";

const REPO_ROOT = process.cwd();

// Small body cap so the 413 regression test doesn't need a 25MiB upload. MUST be set
// before importing index.ts — the limit is read at module load.
process.env.ADAPTER_K8S_MAX_BODY_BYTES = "1024";
// Production cache wiring must stay out of this test regardless of the host env.
delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
// The test removes boot-installed process listeners during cleanup; silence Next's
// warning about its unhandled-rejection filter being uninstalled.
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

interface StagedDir {
  dir: string;
  configDir: string;
}

function writeStagedDir(withMiddleware: boolean): StagedDir {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".smoke-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(path.join(dir, "handlers"), { recursive: true });
  mkdirSync(configDir, { recursive: true });

  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "public", "hello.txt"), "hello static");
  writeFileSync(path.join(dir, "public", "corrupt.png"), "this is not actually a png");
  writeFileSync(
    path.join(dir, "handlers", "hello.mjs"),
    `export function handler(req, res) {
       res.statusCode = 200;
       res.setHeader("content-type", "text/plain");
       res.end("hello from handler");
     }
    `,
  );
  writeFileSync(
    path.join(dir, "handlers", "redirect.mjs"),
    `export function handler(req, res) {
       res.statusCode = 302;
       res.setHeader("location", "/hello.txt");
       res.end();
     }
    `,
  );
  writeFileSync(
    path.join(dir, "handlers", "array-headers.mjs"),
    `export function handler(req, res) {
       // Array-form writeHead — the form that bypassed header-strip wrappers.
       res.writeHead(200, [
         ["cache-control", "public, max-age=3600"],
         ["cache-tag", "some-tag"],
         ["content-type", "text/plain"],
       ]);
       res.end("array headers");
     }
    `,
  );
  writeFileSync(
    path.join(configDir, "pool-manifest-main.json"),
    JSON.stringify({
      buildId: "smokebuild1",
      poolName: "main",
      outputs: {
        "/hello": {
          id: "/hello",
          filePath: "handlers/hello.mjs",
          pathname: "/hello",
          type: "PAGES",
        },
        "/redirect-img": {
          id: "/redirect-img",
          filePath: "handlers/redirect.mjs",
          pathname: "/redirect-img",
          type: "PAGES",
        },
        "/array-headers": {
          id: "/array-headers",
          filePath: "handlers/array-headers.mjs",
          pathname: "/array-headers",
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
      pathnames: ["/hello", "/redirect-img", "/array-headers"],
      i18n: null,
      buildId: "smokebuild1",
      basePath: "",
      middleware: withMiddleware
        ? // Absolute: the pool resolves middleware filePath against process.cwd(),
          // and this test's cwd is the FIRST staged dir when the guard test runs.
          { filePath: path.join(dir, "mw.mjs"), runtime: "nodejs" }
        : null,
      poolAssignments: {
        "/hello": "main",
        "/redirect-img": "main",
        "/array-headers": "main",
      },
      pprRoutes: {},
      nextVersion: "16.2.10",
    }),
  );
  if (withMiddleware) {
    // A middleware module with NO callable export — the pool must refuse to start
    // rather than silently bypass the application's middleware policy.
    writeFileSync(path.join(dir, "mw.mjs"), "export const matcher = ['/protected'];\n");
  }
  return { dir, configDir };
}

async function getFreePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

// Send one raw HTTP request and collect the raw response (for header forgery that
// fetch/undici refuses to emit).
function rawRequest(port: number, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("raw request timed out"));
    }, 5000);
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString());
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // The server may close the connection after responding (connection: close);
    // treat a clean FIN after data as completion.
  });
}

describe("pool-server startup smoke test", () => {
  let staged: StagedDir;
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
    staged = writeStagedDir(false);
    port = await getFreePort();

    process.env.POOL_NAME = "main";
    process.env.NEXT_BUILD_ID = "smokebuild1";
    process.env.PORT = String(port);
    process.env.CONFIG_DIR = staged.configDir;
    // Legacy trust mode (no secret configured): lets the PPR dispatch header through
    // so the forced cache-policy wrapper is exercised end to end.
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
    // Remove the process handlers startPoolServer installed so they can't leak
    // into (or exit) the test worker.
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

  it("answers /healthz with 200", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("serves a public/ static file", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hello.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello static");
  });

  it("invokes a pool handler for a known route", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hello`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from handler");
  });

  it("404s an unknown route", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/definitely-not-a-route`);
    expect(res.status).toBe(404);
  });

  it("delivers a 413 for an oversize body (not an ECONNRESET)", async () => {
    // The cap is 1024 bytes (ADAPTER_K8S_MAX_BODY_BYTES above). The client must
    // RECEIVE the 413 status — before the fix the socket was destroyed first and
    // the client got a connection reset instead.
    const res = await fetch(`http://127.0.0.1:${port}/hello`, {
      method: "POST",
      body: Buffer.alloc(4096, 0x61),
      headers: { "content-type": "text/plain" },
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toBe("Payload Too Large");
  });

  it("completes a GET with a forged content-length instead of hanging", async () => {
    // Declares 100 body bytes and sends none. The loopback invocation must delete
    // the header rather than wait for the body until the 300s requestTimeout.
    const raw = await rawRequest(
      port,
      `GET /hello HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\nConnection: close\r\n\r\n`,
    );
    expect(raw).toContain("200");
    expect(raw).toContain("hello from handler");
  });

  it("rejects a malformed Host header with 400 (not 500)", async () => {
    const raw = await rawRequest(
      port,
      `GET /hello HTTP/1.1\r\nHost: [broken\r\nConnection: close\r\n\r\n`,
    );
    expect(raw).toContain("400");
    expect(raw).not.toContain("500");
  });

  it("502s (never passthrough) when sharp fails on corrupt image bytes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/corrupt.png&w=640&q=75`);
    expect(res.status).toBe(502);
    // The raw bytes must NOT be served back under a guessed content-type.
    expect(res.headers.get("content-type")).not.toBe("image/png");
    expect(await res.text()).not.toContain("this is not actually a png");
  });

  it("refuses to follow redirects on the internal image self-fetch", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/redirect-img&w=640&q=75`);
    expect(res.status).toBe(502);
  });

  it("negotiates the image format on Accept and emits Vary: Accept", async () => {
    // Produce a real PNG with sharp (available in this repo).
    const sharp = (await import("sharp")).default;
    writeFileSync(
      path.join(staged.dir, "public", "real.png"),
      await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 10, g: 120, b: 200 },
        },
      })
        .png()
        .toBuffer(),
    );

    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/real.png&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/avif");
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
  });

  it("applies the forced PPR cache policy over array-form writeHead headers", async () => {
    // The trusted x-nextjs-ppr dispatch header forces no-store; the handler answers
    // with the array form of writeHead, whose cache-control/cache-tag must be
    // stripped (not bypass the wrapper).
    const res = await fetch(`http://127.0.0.1:${port}/array-headers`, {
      headers: { "x-nextjs-ppr": "1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("array headers");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  it("refuses to start when declared middleware has no callable export", async () => {
    const stagedB = writeStagedDir(true);
    const previousConfigDir = process.env.CONFIG_DIR;
    process.env.CONFIG_DIR = stagedB.configDir;
    try {
      await expect(startPoolServer()).rejects.toThrow(/no callable export/);
    } finally {
      process.env.CONFIG_DIR = previousConfigDir;
      rmSync(stagedB.dir, { recursive: true, force: true });
    }
  });
});
