// tests/pool-server/index.image.test.ts
// /_next/image `next start` parity at the real server boundary: the SVG
// dangerouslyAllowSVG gate (400 by default; attachment + CSP when enabled), the
// gif/svg-before-Accept negotiation order, and Vary: Accept on passthrough 200s.
//
// Two real boots of startPoolServer against synthetic staged dirs (one without an
// images config, one with dangerouslyAllowSVG enabled). The staged dirs live UNDER
// THE REPO ROOT so createRequire(<staged>/package.json) can resolve the repo's
// `next` (pool-server requires several next/dist modules at boot).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const REPO_ROOT = process.cwd();

// Production cache wiring must stay out of this test regardless of the host env.
delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
// The test removes boot-installed process listeners during cleanup; silence Next's
// warning about its unhandled-rejection filter being uninstalled.
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

const SVG_BODY = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
// Not a real animation decoder target: passthrough must serve the SOURCE bytes, so
// any GIF-typed content works to prove sharp never touched it.
const GIF_BODY = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(64, 0x2a)]);

function writeStagedDir(images: Record<string, unknown> | null): { dir: string; configDir: string } {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".image-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(configDir, { recursive: true });

  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "public", "icon.svg"), SVG_BODY);
  writeFileSync(path.join(dir, "public", "anim.gif"), GIF_BODY);

  if (images) {
    mkdirSync(path.join(dir, ".next"), { recursive: true });
    writeFileSync(
      path.join(dir, ".next", "required-server-files.json"),
      JSON.stringify({ config: { images } }),
    );
  }

  writeFileSync(
    path.join(configDir, "pool-manifest-main.json"),
    JSON.stringify({ buildId: "imgbuild1", poolName: "main", outputs: {} }),
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
      buildId: "imgbuild1",
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

const envKeys = ["POOL_NAME", "NEXT_BUILD_ID", "PORT", "CONFIG_DIR", "RELEASE_NAME"];

interface BootedServer {
  port: number;
  close: () => Promise<void>;
}

function makeBooter() {
  let savedEnv: Record<string, string | undefined>;
  let listenersBefore: Record<string, Function[]>;
  let staged: { dir: string; configDir: string } | undefined;
  let server: Awaited<ReturnType<typeof startPoolServer>> | undefined;

  const events = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;

  return {
    async boot(images: Record<string, unknown> | null): Promise<BootedServer> {
      listenersBefore = Object.fromEntries(
        events.map((e) => [e, process.listeners(e as "SIGTERM") as Function[]]),
      );
      savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      staged = writeStagedDir(images);
      const port = await getFreePort();
      process.env.POOL_NAME = "main";
      process.env.NEXT_BUILD_ID = "imgbuild1";
      process.env.PORT = String(port);
      process.env.CONFIG_DIR = staged.configDir;
      process.chdir(staged.dir);
      server = await startPoolServer();
      return { port, close: () => server!.close() };
    },
    async cleanup(): Promise<void> {
      if (server) await server.close().catch(() => undefined);
      server = undefined;
      process.chdir(REPO_ROOT);
      if (staged) rmSync(staged.dir, { recursive: true, force: true });
      staged = undefined;
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
      // Remove the process handlers startPoolServer installed so they can't leak
      // into (or exit) the test worker.
      for (const event of events) {
        for (const l of process.listeners(event as "SIGTERM")) {
          if (!(listenersBefore[event] ?? []).includes(l as Function)) {
            process.removeListener(event as "SIGTERM", l as never);
          }
        }
      }
    },
  };
}

describe("image optimizer parity — default config", () => {
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    ({ port } = await booter.boot(null));
  }, 60_000);

  afterAll(async () => {
    await booter.cleanup();
  });

  it("400s SVG through the optimizer (next start parity: dangerouslyAllowSVG off)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/icon.svg&w=640&q=75`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("image type is not allowed");
    // The SVG bytes must never be served inline.
    expect(body).not.toContain("<svg");
  });

  it("passes a GIF through untouched even when the client accepts avif/webp", async () => {
    // Accept negotiation used to win BEFORE the gif/svg check, re-encoding animated
    // GIFs to a static first frame for any modern browser.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/anim.gif&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(GIF_BODY)).toBe(true);
    // The passthrough 200 is still an Accept-negotiated response class — it must
    // carry Vary: Accept like the optimized path.
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
  });
});

describe("image optimizer parity — dangerouslyAllowSVG enabled", () => {
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    ({ port } = await booter.boot({ dangerouslyAllowSVG: true }));
  }, 60_000);

  afterAll(async () => {
    await booter.cleanup();
  });

  it("serves SVG as attachment with Next's default CSP", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/icon.svg&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    // next start parity: attachment (never rendered inline in the site's origin)
    // plus the default images.contentSecurityPolicy.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="image"');
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
    // Passthrough: the source bytes are untouched (no rasterization).
    expect(await res.text()).toBe(SVG_BODY);
  });
});
