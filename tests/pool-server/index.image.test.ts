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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { request as httpRequest } from "node:http";
import { cdnTagForBuildId } from "../../src/cdn-tags.js";

const REPO_ROOT = process.cwd();
const BUILD_ID = "imgbuild1";
const BUILD_TAG = cdnTagForBuildId(BUILD_ID);

// A raw node:http GET. Required for conditional requests: undici's `fetch` silently drops
// a manually-supplied If-None-Match, so a 304 can only be observed this way (the same
// discovery forced the `next start` baseline measurements onto node:http).
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

// Production cache wiring must stay out of this test regardless of the host env.
delete process.env.VALKEY_URL;
delete process.env.NEXT_ENABLE_ADAPTER;
// The test removes boot-installed process listeners during cleanup; silence Next's
// warning about its unhandled-rejection filter being uninstalled.
process.env.NEXT_UNHANDLED_REJECTION_FILTER = "silent";

const { startPoolServer } = await import("../../src/pool-server/index.js");

const SVG_BODY = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`;
// Real, minimal GIF89a streams — a 2-frame one and a 1-frame one. Both were cross-checked
// against the upstream `is-animated` module Next's optimizer calls and against sharp's page
// count (2 and 1) before being pinned here. The distinction is load-bearing now: `next
// start` re-encodes a PROVABLY static GIF and returns an animated one verbatim, so a
// hand-waved "GIF-ish bytes" fixture would test nothing.
const ANIMATED_GIF_BODY = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAAKAAAALAAAAAABAAEAAAICRAEAIfkEAAoAAAAsAAAAAAEAAQAAAgJEAQA7",
  "base64",
);
const STATIC_GIF_BODY = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64",
);
// A real 1x1 PNG (same bytes the live fixture's /api/tiny-png serves) so sharp can
// actually decode it.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
// Sharp/libvips cannot DECODE either of these ("Input buffer contains unsupported image
// format"), which is why they must never reach it — Next lists both in BYPASS_TYPES and
// returns the source bytes. Only the magic bytes matter for that decision, so a header
// plus filler is enough to prove the bypass fires (and that the bytes come back intact).
const ICO_BODY = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x20, 0x20]),
  Buffer.alloc(56, 0x5a),
]);
const BMP_BODY = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(62, 0x5a)]);
// Not an image at all: next start answers 400 here, and passthrough would be an XSS
// channel (an HTML body echoed back under text/html).
const HTML_BODY = "<html><body><script>alert(1)</script></body></html>";
// A real 8x8 deflate TIFF (produced by the same sharp this repo ships). TIFF is the last
// source format `next start` PRESERVES through the optimizer: upstream's `optimizeImage`
// sets no encoder for it, so sharp writes TIFF back. Measured on the upstream fixture's
// public/test.tiff at w=384&q=75 — `next start` 200 image/tiff 2962 B, the adapter's old
// `default: jpeg` fallthrough 200 image/jpeg 1918 B.
const TIFF_BODY = Buffer.from(
  "SUkqABoAAAB4nDshF8WADZwYIuIAMmwKAQAQAAABAwABAAAACAAAAAEBAwABAAAACAAAAAIBAwADAAAA8AAA" +
    "AAMBAwABAAAACAAAAAYBAwABAAAAAgAAABEBBAABAAAACAAAABIBAwABAAAAAQAAABUBAwABAAAAAwAAABYB" +
    "AwABAAAAAAEAABcBBAABAAAAEQAAABoBBQABAAAA4AAAABsBBQABAAAA6AAAABwBAwABAAAAAQAAACgBAwAB" +
    "AAAAAgAAAD0BAwABAAAAAgAAAFMBAwADAAAA9gAAAAAAAAAzM8sAAAAIADMzywAAAAgACAAIAAgAAQABAAEA",
  "base64",
);
// public/test.jp2 from Next's own test/e2e/image-optimizer fixture, byte-for-byte (242 B).
// sharp/libvips cannot DECODE it ("Input buffer contains unsupported image format") and
// image/jp2 is NOT one of Next's BYPASS_TYPES, so upstream reaches it only through
// imageOptimizer's catch — "If we fail to optimize, fallback to the original image".
// Measured: `next start` answers `?url=/test.jp2&w=384&q=75` with 200 image/jp2 and these
// exact 242 bytes; the adapter used to answer 502.
const JP2_BODY = Buffer.from(
  "AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAAQAAAAEABA8HAAAA" +
    "AAAPY29scgEAAAAAABAAAAClanAyY/9P/1EAMgAAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAA" +
    "BA8BAQ8BAQ8BAQ8BAf9SAAwAAAABAAAEBAAB/1wABECA/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJz" +
    "aW9uIDIuNS4w/5AACgAAAAAAKgAB/5PH/gwGAtsPx/4MBgBEH8/8MAwEFxfP/DAMA0HP/9k=",
  "base64",
);

function writeStagedDir(
  images: Record<string, unknown> | null,
  options: {
    middlewareMatcher?: string;
    middlewareSource?: string;
    publicFiles?: string[];
    basePath?: string;
    beforeMiddleware?: Record<string, unknown>[];
    dynamicRoutes?: Record<string, unknown>[];
    pathnames?: string[];
    poolAssignments?: Record<string, string>;
  } = {},
): {
  dir: string;
  configDir: string;
} {
  const dir = mkdtempSync(path.join(REPO_ROOT, ".image-stage-"));
  const configDir = path.join(dir, "config");
  mkdirSync(path.join(dir, "public"), { recursive: true });
  mkdirSync(configDir, { recursive: true });

  writeFileSync(path.join(dir, "package.json"), "{}");
  writeFileSync(path.join(dir, "public", "icon.svg"), SVG_BODY);
  writeFileSync(path.join(dir, "public", "anim.gif"), ANIMATED_GIF_BODY);
  writeFileSync(path.join(dir, "public", "static.gif"), STATIC_GIF_BODY);
  // A content-addressed build artifact: Next marks these immutable (its `isStatic`).
  mkdirSync(path.join(dir, ".next", "static", "media"), { recursive: true });
  writeFileSync(path.join(dir, ".next", "static", "media", "logo.abc123.png"), ONE_PIXEL_PNG);
  // PNG bytes under a lying extension and under no extension at all: the source
  // format must come from a magic-byte sniff (next start parity), never the URL.
  writeFileSync(path.join(dir, "public", "mislabeled.jpg"), ONE_PIXEL_PNG);
  writeFileSync(path.join(dir, "public", "extensionless-png"), ONE_PIXEL_PNG);
  // SVG bytes hiding behind a raster extension: the dangerouslyAllowSVG gate must
  // fire on the sniffed type, not the claimed one.
  writeFileSync(path.join(dir, "public", "evil.png"), SVG_BODY);
  writeFileSync(path.join(dir, "public", "favicon.ico"), ICO_BODY);
  writeFileSync(path.join(dir, "public", "bitmap.bmp"), BMP_BODY);
  // ICO bytes under a .png name: the bypass decision must come from the sniff too.
  writeFileSync(path.join(dir, "public", "actually-ico.png"), ICO_BODY);
  writeFileSync(path.join(dir, "public", "notanimage.txt"), "hello, not an image\n");
  writeFileSync(path.join(dir, "public", "page.html"), HTML_BODY);
  writeFileSync(path.join(dir, "public", "test.tiff"), TIFF_BODY);
  writeFileSync(path.join(dir, "public", "test.jp2"), JP2_BODY);
  // JP2 bytes under a .png name: the passthrough-on-failure fallback must be driven by
  // the SNIFF, so this must behave exactly like /test.jp2 rather than trusting `.png`.
  writeFileSync(path.join(dir, "public", "jp2-as.png"), JP2_BODY);
  // HTML bytes under a .png name: nothing sniffs, so the only candidate type is a GUESS
  // — this must stay a 502 and must never be echoed back.
  writeFileSync(path.join(dir, "public", "html-as.png"), HTML_BODY);

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
        beforeMiddleware: options.beforeMiddleware ?? [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: options.dynamicRoutes ?? [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: true,
        rsc: { header: "rsc", suffix: ".rsc" },
      },
      pathnames: options.pathnames ?? [],
      i18n: null,
      buildId: "imgbuild1",
      basePath: options.basePath ?? "",
      middleware: options.middlewareMatcher
        ? {
            filePath: path.join(dir, "mw.mjs"),
            runtime: "nodejs",
            matchers: [{ regexp: options.middlewareMatcher }],
          }
        : null,
      poolAssignments: options.poolAssignments ?? {},
      pprRoutes: {},
      nextVersion: "16.2.10",
    }),
  );
  // Middleware module: never invoked by these tests, but its COVERAGE is what installs
  // the forced-cache wrapper the /_next/image response must not be able to defeat.
  writeFileSync(
    path.join(dir, "mw.mjs"),
    options.middlewareSource ?? "export function proxy(request) {}\n",
  );
  // S3: real public/ bytes, so the optimizer has a local source to prefer over re-entry —
  // plus a static-assets manifest entry for each, which is what lets the pool serve them on
  // the LOOPBACK re-entry the covered path now takes (the disk fast path never needed one).
  const publicFiles = options.publicFiles ?? [];
  for (const name of publicFiles) {
    writeFileSync(path.join(dir, "public", name), ONE_PIXEL_PNG);
  }
  writeFileSync(
    path.join(configDir, "static-assets.json"),
    JSON.stringify(
      publicFiles.map((name) => ({
        pathname: `/${name}`,
        filePath: `public/${name}`,
        cacheControl: "public, max-age=0, must-revalidate",
      })),
    ),
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

const envKeys = [
  "POOL_NAME",
  "NEXT_BUILD_ID",
  "PORT",
  "CONFIG_DIR",
  "RELEASE_NAME",
  "INTERNAL_HEADER_SECRET",
];

interface BootedServer {
  port: number;
  close: () => Promise<void>;
}

function makeBooter() {
  let savedEnv: Record<string, string | undefined>;
  let listenersBefore: Record<string, Function[]>;
  let savedCwd = REPO_ROOT;
  let staged: { dir: string; configDir: string } | undefined;
  let server: Awaited<ReturnType<typeof startPoolServer>> | undefined;

  const events = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"] as const;

  return {
    async boot(
      images: Record<string, unknown> | null,
      options: {
        middlewareMatcher?: string;
        middlewareSource?: string;
        publicFiles?: string[];
        basePath?: string;
        beforeMiddleware?: Record<string, unknown>[];
        dynamicRoutes?: Record<string, unknown>[];
        pathnames?: string[];
        poolAssignments?: Record<string, string>;
        internalSecret?: string;
      } = {},
    ): Promise<BootedServer> {
      listenersBefore = Object.fromEntries(
        events.map((e) => [e, process.listeners(e as "SIGTERM") as Function[]]),
      );
      savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
      savedCwd = process.cwd();
      staged = writeStagedDir(images, options);
      const port = await getFreePort();
      process.env.POOL_NAME = "main";
      process.env.NEXT_BUILD_ID = "imgbuild1";
      process.env.PORT = String(port);
      process.env.CONFIG_DIR = staged.configDir;
      if (options.internalSecret) process.env.INTERNAL_HEADER_SECRET = options.internalSecret;
      else delete process.env.INTERNAL_HEADER_SECRET;
      process.chdir(staged.dir);
      server = await startPoolServer();
      return { port, close: () => server!.close() };
    },
    async cleanup(): Promise<void> {
      if (server) await server.close().catch(() => undefined);
      server = undefined;
      process.chdir(savedCwd ?? REPO_ROOT);
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
    // Byte-for-byte the body `next start` sends (verified empirically 2026-07-24
    // against next start on fixtures/main, Next 16.2.x).
    expect(body).toBe('"url" parameter is valid but image type is not allowed');
  });

  it("keeps a PNG source PNG regardless of its URL extension (sniff, not extension)", async () => {
    // The regression: source type was derived from the URL (getContentType), so a
    // PNG served from an extensionless path (or a lying one) negotiated to JPEG.
    // next start sniffs the bytes and returned image/png for both of these
    // (verified against /api/tiny-png with `accept: image/png` on 2026-07-24).
    for (const name of ["mislabeled.jpg", "extensionless-png"]) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/${name}&w=640&q=75`, {
        headers: { accept: "image/png" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const body = Buffer.from(await res.arrayBuffer());
      // PNG signature, and no upscale: IHDR width/height (offsets 16/20) stay 1x1.
      expect(body.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(body.readUInt32BE(16)).toBe(1);
      expect(body.readUInt32BE(20)).toBe(1);
    }
  });

  it("400s SVG bytes hiding behind a raster extension (the gate fires on the sniff)", async () => {
    // An SVG at /evil.png previously classified as image/png from the extension and
    // sailed past the dangerouslyAllowSVG gate into sharp.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/evil.png&w=640&q=75`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('"url" parameter is valid but image type is not allowed');
  });

  it("passes an ANIMATED GIF through untouched even when the client accepts avif/webp", async () => {
    // Accept negotiation used to win BEFORE the gif/svg check, re-encoding animated
    // GIFs to a static first frame for any modern browser.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/anim.gif&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/gif");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(ANIMATED_GIF_BODY)).toBe(true);
    // The passthrough 200 is still an Accept-negotiated response class — it must
    // carry Vary: Accept like the optimized path.
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
  });

  it("re-encodes a provably STATIC GIF (next start does; blanket passthrough did not)", async () => {
    // `next start` on the upstream image-optimizer fixture turns its 2301 B static
    // public/test.gif into 916 B of image/webp at w=384/q=75 — with an ETag byte-identical
    // to the adapter\'s after this change. Blanket GIF passthrough shipped the source bytes.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/static.gif&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(body.subarray(8, 12).toString("ascii")).toBe("WEBP");
    // A client that negotiates nothing keeps the source FORMAT — re-encoded as GIF, not
    // handed back verbatim and not forced to JPEG.
    const plain = await fetch(`http://127.0.0.1:${port}/_next/image?url=/static.gif&w=640&q=75`, {
      headers: { accept: "*/*" },
    });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("image/gif");
    expect(
      Buffer.from(await plain.arrayBuffer())
        .subarray(0, 3)
        .toString("ascii"),
    ).toBe("GIF");
  });

  it("serves ICO/BMP untouched (Next's BYPASS_TYPES — sharp cannot decode them)", async () => {
    // The `[LOADING]` regression: an .ico went to sharp, sharp threw "Input buffer
    // contains unsupported image format", the handler 502'd, and the browser never fired
    // load for that <img> (next-image-legacy's on-loading-complete/on-load img4). Verified
    // against `next start` on that fixture: /_next/image?url=/test.ico&w=1920&q=75 → 200
    // image/x-icon byte-identical to public/test.ico; /test.bmp → 200 image/bmp likewise.
    for (const [name, type, body] of [
      ["favicon.ico", "image/x-icon", ICO_BODY],
      ["bitmap.bmp", "image/bmp", BMP_BODY],
      // The sniff, not the extension, decides: ICO bytes named .png still bypass.
      ["actually-ico.png", "image/x-icon", ICO_BODY],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/${name}&w=640&q=75`, {
        headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
      expect(Buffer.from(await res.arrayBuffer()).equals(body)).toBe(true);
    }
  });

  it("400s a source that isn't an image at all (never 502, never passthrough)", async () => {
    for (const name of ["notanimage.txt", "page.html"]) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/${name}&w=640&q=75`, {
        headers: { accept: "image/avif,image/webp,image/*" },
      });
      expect(res.status).toBe(400);
      const body = await res.text();
      // Byte-for-byte the body `next start` sends for this case (verified 2026-07-24).
      expect(body).toBe("The requested resource isn't a valid image.");
      // Whatever happens, the HTML body must not be echoed back to the client.
      expect(body).not.toContain("alert(1)");
      // No Content-Type at all — `next start` sends none on any optimizer error (measured
      // 2026-07-25 with curl: `400 Bad Request` + chunked + the body, nothing else). Safe
      // because every optimizer error body is a fixed string; see sendImageError.
      expect(res.headers.get("content-type")).toBeNull();
    }
  });

  // ---- gap 1: images.formats (default is webp-only) ----

  it("serves WebP, not AVIF, to a browser that advertises both (images.formats default)", async () => {
    // `next start` with a stock config answers this exact request with image/webp; the
    // adapter answered image/avif because negotiation ignored images.formats entirely.
    // (Also the production-cost fix: AVIF encoding is several times slower than WebP.)
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
  });

  // ---- gap 2: Cache-Control from images.minimumCacheTTL, + the CDN deploy tag ----

  it("sends next start's Cache-Control and the deploy cache-tag on a cacheable 200", async () => {
    // Was `public, max-age=60, must-revalidate`: a 60-second shared-cache lifetime means
    // the pool re-decodes and re-encodes the same image for essentially every visitor.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
      headers: { accept: "image/webp" },
    });
    expect(res.headers.get("cache-control")).toBe("public, max-age=14400, must-revalidate");
    // M13: the optimizer URL is NOT content-addressed, so a new build can make this entry
    // stale — it must carry the recorded deploy tag or cutover invalidation cannot purge it.
    expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
  });

  it("marks a content-addressed /_next/static/media source immutable and does NOT tag it", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Flogo.abc123.png&w=640&q=75`,
      { headers: { accept: "image/webp" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=315360000, immutable");
    // Immutable assets are shared across deploys — tagging them would re-fetch identical
    // bytes on every cutover (cdnCacheTag returns {} for `immutable`).
    expect(res.headers.get("cache-tag")).toBeNull();
  });

  // ---- gap 3: ETag + If-None-Match ----

  it("sends an ETag and answers If-None-Match with a bodyless 304", async () => {
    const url = `http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=640&q=75`;
    const first = await fetch(url, { headers: { accept: "image/webp" } });
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    // Next's shape: unquoted base64url(sha256(bytes)).
    expect(etag).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await first.arrayBuffer();

    // `fetch` (undici) drops a manually-set If-None-Match, so the conditional replay goes
    // through node:http — the same reason the `next start` measurements used raw http.
    const conditional = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
      "if-none-match": etag!,
    });
    expect(conditional.status).toBe(304);
    expect(conditional.body.length).toBe(0);
    // RFC 7232: a 304 repeats the caching headers and omits representation metadata —
    // byte-for-byte what `next start` sends.
    expect(conditional.headers["cache-control"]).toBe("public, max-age=14400, must-revalidate");
    expect(conditional.headers["etag"]).toBe(etag);
    expect(conditional.headers["vary"]).toBe("Accept");
    expect(conditional.headers["content-type"]).toBeUndefined();
    // The tag travels on the 304 as well: a CDN that refreshes its entry from a tagless
    // 304 would be left holding an un-invalidatable object (the M13 stale-apex class).
    expect(conditional.headers["cache-tag"]).toBe(BUILD_TAG);

    // Weak-prefixed and wildcard validators also match, per RFC 7232 (and `next start`).
    for (const value of [`W/${etag}`, "*"]) {
      const res = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
        accept: "image/webp",
        "if-none-match": value,
      });
      expect(res.status).toBe(304);
    }
    // A stale validator still gets the full body.
    const stale = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
      "if-none-match": "not-the-etag",
    });
    expect(stale.status).toBe(200);
    expect(stale.body.length).toBeGreaterThan(0);
  });

  it("gives Accept variants distinct ETags (the bytes differ, and Vary: Accept is set)", async () => {
    const webp = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
    });
    const png = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "*/*",
    });
    expect(webp.headers["content-type"]).toBe("image/webp");
    expect(png.headers["content-type"]).toBe("image/png");
    expect(webp.headers["etag"]).not.toBe(png.headers["etag"]);
    expect(webp.headers["vary"]).toBe("Accept");
  });

  // ---- gap 4: Content-Disposition + CSP on EVERY 200, not only SVG ----

  it("sends Content-Disposition and the images CSP on every 200, including passthrough", async () => {
    for (const [name, expectedDisposition] of [
      // Re-encoded: the OUTPUT extension, not the source's.
      ["mislabeled.jpg", 'attachment; filename="mislabeled.webp"'],
      // Passthrough (BYPASS_TYPES) still gets both headers.
      ["favicon.ico", 'attachment; filename="favicon.ico"'],
      ["anim.gif", 'attachment; filename="anim.gif"'],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/${name}&w=640&q=75`, {
        headers: { accept: "image/webp,image/*,*/*;q=0.8" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toBe(expectedDisposition);
      expect(res.headers.get("content-security-policy")).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      await res.arrayBuffer();
    }
  });

  it("answers HEAD with the payload size and no body (next start sends Content-Length)", async () => {
    // Node marks a HEAD response as bodyless and then emits NEITHER Content-Length nor
    // Transfer-Encoding, so this only works because the handler sets it explicitly —
    // `next start` answers HEAD with Content-Length for the same request.
    const get = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
    });
    const head = await new Promise<{ headers: Record<string, string | undefined>; bytes: number }>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/_next/image?url=/mislabeled.jpg&w=640&q=75",
            method: "HEAD",
            headers: { accept: "image/webp" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                headers: res.headers as Record<string, string | undefined>,
                bytes: Buffer.concat(chunks).length,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    expect(head.bytes).toBe(0);
    expect(head.headers["content-length"]).toBe(String(get.body.length));
    expect(head.headers["etag"]).toBe(get.headers["etag"]);
  });

  it("cannot be steered into injecting a response header via the filename", async () => {
    // The Content-Disposition filename comes from the request's `url` parameter. Whatever
    // the path resolution does with it, no CR/LF can reach the header (the quoted form
    // replaces them, the extended form percent-encodes them) — so this must never be a 500.
    const res = await rawGet(
      port,
      "/_next/image?url=%2F%0d%0aX-Injected%3A%201%2Fmislabeled.jpg&w=640&q=75",
      { accept: "image/webp" },
    );
    expect(res.status).toBeLessThan(500);
    expect(res.headers["x-injected"]).toBeUndefined();
  });

  // --- `w` / `q` enforcement (ImageOptimizerCache.validateParams) ----------------
  //
  // Every body below was read off `next start` 16.2.10 on a copy of Next's own
  // test/e2e/image-optimizer fixture (2026-07-25, default images config, image cache
  // cleared). `next start` sends no Content-Type on these, and neither does the adapter
  // any more — pinned below.
  //
  // This is not cosmetic parity. `w=16` and `q=50` used to return 200, and each additional
  // accepted (w, q) pair is one more CDN cache entry and one more sharp encode — an
  // unenforced set is a cache-fill / CPU amplification vector.
  it.each([
    // [query, expected 400 body, `next start` note]
    ["w=16&q=75", '"w" parameter (width) of 16 is not allowed'],
    ["w=17&q=75", '"w" parameter (width) of 17 is not allowed'],
    ["w=999999&q=75", '"w" parameter (width) of 999999 is not allowed'],
    ["w=384&q=50", '"q" parameter (quality) of 50 is not allowed'],
    ["w=384&q=1", '"q" parameter (quality) of 1 is not allowed'],
    ["q=75", '"w" parameter (width) is required'],
    ["w=&q=75", '"w" parameter (width) is required'],
    ["w=384", '"q" parameter (quality) is required'],
    ["w=384&q=", '"q" parameter (quality) is required'],
    ["w=abc&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=384.5&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=-5&q=75", '"w" parameter (width) must be an integer greater than 0'],
    ["w=384&q=abc", '"q" parameter (quality) must be an integer between 1 and 100'],
    ["w=384&q=0", '"q" parameter (quality) must be an integer between 1 and 100'],
    ["w=384&q=101", '"q" parameter (quality) must be an integer between 1 and 100'],
    // Repeated params: Next parses the query into arrays, so these are 400s, NOT
    // first-wins 200s.
    ["w=384&w=32&q=75", '"w" parameter (width) cannot be an array'],
    ["w=384&q=75&q=50", '"q" parameter (quality) cannot be an array'],
  ])("400s ?%s with next start's exact body", async (query, expected) => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&${query}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe(expected);
  });

  it("still serves the allowed (w, q) pairs the default config permits", async () => {
    // The floor of imageSizes is 32 (not 16), and 75 is the only default quality.
    for (const query of ["w=32&q=75", "w=384&q=75", "w=3840&q=75"]) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&${query}`, {
        headers: { accept: "image/webp" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
    }
  });

  it("re-encodes a TIFF source as TIFF when nothing is negotiated (not JPEG)", async () => {
    // `next start` → 200 image/tiff 2962 B for the fixture's test.tiff at w=384&q=75; the
    // adapter's `default: jpeg` produced image/jpeg 1918 B. Upstream reaches TIFF-in/
    // TIFF-out by setting NO sharp encoder; `.tiff()` is byte-identical.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/test.tiff&w=384&q=75`, {
      headers: { accept: "*/*" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/tiff");
    const body = Buffer.from(await res.arrayBuffer());
    // Little-endian TIFF magic (II*\0) — a JPEG would start FF D8 FF.
    expect(body.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x49, 0x2a, 0x00]));
    // A TIFF source still honors Accept when the client offers a configured format.
    const webp = await fetch(`http://127.0.0.1:${port}/_next/image?url=/test.tiff&w=384&q=75`, {
      headers: { accept: "image/webp" },
    });
    expect(webp.headers.get("content-type")).toBe("image/webp");
  });

  it("falls back to the SOURCE bytes when sharp cannot decode a sniffed image (jp2)", async () => {
    // `next start`: 200 image/jp2, 242 B (the upstream bytes), Cache-Control
    // `public, max-age=14400, must-revalidate`, Content-Disposition attachment, images CSP.
    // The adapter used to 502 here on a "no passthrough fallback" policy whose stated
    // premise — that upstream has no such path — was simply false.
    for (const [name, stem] of [
      ["test.jp2", "test"],
      ["jp2-as.png", "jp2-as"],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/${name}&w=384&q=75`, {
        // Even with a configured format on offer, an undecodable source cannot be encoded
        // into it — upstream answers with the source type either way.
        headers: { accept: "image/webp" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/jp2");
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(JP2_BODY)).toBe(true);
      // The fallback is still a full optimizer 200: attachment + CSP + Vary + a validator,
      // which is what makes serving unmodified bytes safe.
      // The filename's EXTENSION follows the output type (jp2), the stem the request's url.
      expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${stem}.jp2"`);
      expect(res.headers.get("content-security-policy")).toBe(
        "script-src 'none'; frame-src 'none'; sandbox;",
      );
      expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
      expect(res.headers.get("etag")).toBeTruthy();
      // maxAge is images.minimumCacheTTL on the fallback path (upstream's literal choice).
      expect(res.headers.get("cache-control")).toBe("public, max-age=14400, must-revalidate");
    }
  });

  it("still 502s undecodable bytes whose type is only a GUESS (never echoes them back)", async () => {
    // The XSS vector the fallback was originally removed for: HTML under an image name.
    // Nothing sniffs, so the type would come from the extension/upstream header — upstream
    // 400s this case outright, and the adapter must not serve the bytes under a guess.
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/html-as.png&w=384&q=75`);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).not.toContain("alert(1)");
  });

  // --- `url` rejection at the server boundary (validateParams, the `url` half) ------
  //
  // The unit-level table lives in image-utils.test.ts; these pin the wiring: the gate runs
  // BEFORE w/q, the 400 carries no Content-Type, and the branches that used to fall through
  // to the loopback self-fetch now stop here. Bodies measured against `next start` on a
  // scratch copy of Next's test/e2e/image-optimizer fixture, 2026-07-25.
  it.each([
    ["", '"url" parameter is required'],
    ["url=", '"url" parameter is required'],
    ["url=/mislabeled.jpg&url=/evil.png", '"url" parameter cannot be an array'],
    ["url=//example.com/a.png", '"url" parameter cannot be a protocol-relative URL (//)'],
    ["url=/_next/image", '"url" parameter cannot be recursive'],
    ["url=/_next/image/foo", '"url" parameter cannot be recursive'],
    ["url=/_next%2Fimage", '"url" parameter cannot be recursive'],
    // remotePatterns is empty in this app, so every absolute host is refused.
    ["url=https://example.com/a.png", '"url" parameter is not allowed'],
    ["url=file:///etc/passwd", '"url" parameter is invalid'],
    ["url=test.png", '"url" parameter is invalid'],
  ])("400s ?%s with next start's exact body and NO Content-Type", async (query, expected) => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?${query}&w=384&q=75`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe(expected);
  });

  it("caps the `url` length instead of echoing it back in a 404", async () => {
    // Before: 404 with a ~3 kB body that repeated the whole attacker-supplied url.
    const res = await fetch(
      `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent("/" + "a".repeat(3072))}&w=384&q=75`,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('"url" parameter is too long');
  });

  it("validates `url` before `w`/`q` (upstream order)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/_next/image&w=16&q=75`);
    expect(res.status).toBe(400);
    // The old order answered '"w" parameter (width) of 16 is not allowed' here.
    expect(await res.text()).toBe('"url" parameter cannot be recursive');
  });

  it("resolves a local url by its PATHNAME (fragment / trailing newline stripped)", async () => {
    // `next start` serves all three of these as the same image (its internal fetch parses
    // the url); the adapter used to look for a literal `public/mislabeled.jpg#a` on disk and
    // answered 400 "The requested resource isn't a valid image." on the miss.
    for (const url of ["/mislabeled.jpg", "/mislabeled.jpg#a", "/mislabeled.jpg\n"]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent(url)}&w=384&q=75`,
        { headers: { accept: "image/png" } },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
    }
  });

  it("still refuses a traversal whose separators survive URL normalization", async () => {
    // The disk path now comes from `new URL(url, "http://n").pathname`, which collapses BOTH
    // `..` and `%2e%2e` dot segments (WHATWG treats them alike) — but an ENCODED SEPARATOR
    // (`%2f`) is not a separator to the parser, so `/..%2f..%2fx` survives normalization and
    // only becomes a traversal when decodePublicPathname decodes it. resolveWithinRoot is
    // the guard for exactly that class and must keep firing.
    //
    // `next start` also 400s all of these; it reaches its 400 by MISSING the file rather
    // than by refusing the path, hence the different body (the documented divergence — the
    // status, and the fact that nothing outside public/ is ever served, are parity).
    for (const url of [
      "/..%2f..%2fpackage.json",
      "/%2e%2e%2F%2e%2e%2Fpackage.json",
      "/_next/static/..%2f..%2fpackage.json",
    ]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent(url)}&w=384&q=75`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toBe('"url" parameter is not allowed');
      expect(body).not.toContain("dependencies");
    }
  });

  it("normalizes a dot-segment traversal away instead of serving it (next start parity)", async () => {
    // `/%2e%2e/%2e%2e/package.json` and `/../../package.json` both normalize to
    // `/package.json` inside public/, which does not exist — `next start` answers exactly
    // this 400 for every form (measured 2026-07-25). What must never happen is a 200
    // carrying the repo's package.json.
    for (const url of [
      "/../../package.json",
      "/%2e%2e/%2e%2e/package.json",
      "/_next/static/%2e%2e/%2e%2e/package.json",
    ]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent(url)}&w=384&q=75`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toBe("The requested resource isn't a valid image.");
      expect(body).not.toContain("dependencies");
    }
  });

  it("400s a missing local source the way next start does (no url echo, no 404)", async () => {
    // Upstream's fetchInternalImage does NOT check res.ok: the 404 page's bytes reach the
    // sniff gate and come back as this 400. The adapter used to answer
    // `404 Image not found: <url>`, reflecting the request into the body.
    for (const url of ["/does-not-exist.png", "/mislabeled\u0000.jpg"]) {
      const res = await fetch(
        `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent(url)}&w=384&q=75`,
      );
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toBe("The requested resource isn't a valid image.");
      expect(body).not.toContain("does-not-exist");
    }
  });
});

describe("image optimizer parity — images.localPatterns", () => {
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    // Next's RESOLVED config always materializes this, even for an app that never mentions
    // localPatterns (read straight out of a real .next/required-server-files.json,
    // 2026-07-25). The `search: ""` clause is live behavior, not a formality.
    ({ port } = await booter.boot({ localPatterns: [{ pathname: "**", search: "" }] }));
  }, 60_000);

  afterAll(async () => {
    await booter.cleanup();
  });

  it('rejects a local url carrying a query string (the default `search: ""`)', async () => {
    // `next start` answers ?url=/test.png%3Ffoo%3D1 with exactly this (measured); the
    // adapter had no localPatterns support at all and answered
    // `404 Image not found: /test.png?foo=1`.
    const res = await fetch(
      `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent("/mislabeled.jpg?foo=1")}&w=384&q=75`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe('"url" parameter is not allowed');
  });

  it('still serves a url whose query is EMPTY (search is `""` for `/x?`)', async () => {
    // `new URL("/x?", "http://n").search === ""`, so upstream serves it — measured 200.
    const res = await fetch(
      `http://127.0.0.1:${port}/_next/image?url=${encodeURIComponent("/mislabeled.jpg?")}&w=384&q=75`,
      { headers: { accept: "image/png" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("honors a restrictive pathname glob with the same picomatch Next uses", async () => {
    await booter.cleanup();
    ({ port } = await booter.boot({ localPatterns: [{ pathname: "/assets/**" }] }));
    const denied = await fetch(
      `http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=384&q=75`,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toBe('"url" parameter is not allowed');
  });

  it("allows every local image when localPatterns is ABSENT (upstream short-circuit)", async () => {
    await booter.cleanup();
    ({ port } = await booter.boot({ dangerouslyAllowSVG: false }));
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=384&q=75`, {
      headers: { accept: "image/png" },
    });
    expect(res.status).toBe(200);
  });

  it("allows NOTHING when localPatterns is an explicitly empty list", async () => {
    // `[].some(...)` is false upstream, so an empty list is "no local images", not "all".
    await booter.cleanup();
    ({ port } = await booter.boot({ localPatterns: [] }));
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=384&q=75`);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('"url" parameter is not allowed');
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
    // plus the default images.contentSecurityPolicy. The filename is the SOURCE name with
    // the output extension — it used to be a hardcoded `filename="image"`, which is not
    // what `next start` sends for any request.
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="icon.svg"');
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'none'; frame-src 'none'; sandbox;",
    );
    expect(res.headers.get("vary")?.toLowerCase()).toContain("accept");
    // The allowed-SVG branch is no longer header-special: it carries the same
    // Cache-Control/ETag as every other optimizer 200.
    expect(res.headers.get("cache-control")).toBe("public, max-age=14400, must-revalidate");
    expect(res.headers.get("etag")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Passthrough: the source bytes are untouched (no rasterization).
    expect(await res.text()).toBe(SVG_BODY);
  });
});

describe("image optimizer parity — non-default images config", () => {
  // formats opts into AVIF, minimumCacheTTL shortens the freshness lifetime, and
  // contentDispositionType flips the disposition. All three are read from
  // .next/required-server-files.json, and all three were verified against `next start`
  // built with the same next.config.js (Next 16.2.10, 2026-07-24).
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    ({ port } = await booter.boot({
      formats: ["image/avif", "image/webp"],
      minimumCacheTTL: 5,
      contentDispositionType: "inline",
    }));
  }, 60_000);

  afterAll(async () => {
    await booter.cleanup();
  });

  it("serves AVIF once the app opts in, honoring minimumCacheTTL and the disposition type", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
      headers: { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/avif");
    expect(res.headers.get("cache-control")).toBe("public, max-age=5, must-revalidate");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="mislabeled.avif"');
    await res.arrayBuffer();
  });

  it("ignores an unsupported formats entry rather than handing it to sharp", async () => {
    // A build-controlled value reaching the encoder: only avif/webp survive validation, so
    // a stray entry cannot select an encoder that does not exist.
    const solo = makeBooter();
    try {
      const { port: p2 } = await solo.boot({ formats: ["image/tiff", "image/webp"] });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        headers: { accept: "image/tiff,image/webp" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/webp");
      await res.arrayBuffer();
    } finally {
      await solo.cleanup();
    }
  }, 60_000);

  it("honors a custom imageSizes / qualities set, and only that set", async () => {
    const solo = makeBooter();
    try {
      const { port: p2 } = await solo.boot({ imageSizes: [16, 33], qualities: [40, 75] });
      const ok = async (query: string) =>
        (
          await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&${query}`, {
            headers: { accept: "image/webp" },
          })
        ).status;
      // Opted-in sizes/qualities are accepted (w=16 is legal HERE, and only here) …
      expect(await ok("w=16&q=40")).toBe(200);
      expect(await ok("w=33&q=75")).toBe(200);
      // … deviceSizes are still merged in (upstream concatenates both lists) …
      expect(await ok("w=640&q=40")).toBe(200);
      // … and nothing else is.
      expect(await ok("w=32&q=40")).toBe(400);
      expect(await ok("w=16&q=50")).toBe(400);
    } finally {
      await solo.cleanup();
    }
  }, 60_000);

  it("treats `imageSizes: []` as EMPTY, not as 'use the defaults'", async () => {
    // `imageSizes: []` is valid config (schema min(0)) and means "only deviceSizes".
    // Falling back to Next's default list for an explicit empty array — which the old
    // truthiness check did — silently widens the accepted width set past the app's intent.
    const solo = makeBooter();
    try {
      const { port: p2 } = await solo.boot({ imageSizes: [] });
      const status = async (query: string) =>
        (
          await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&${query}`, {
            headers: { accept: "image/webp" },
          })
        ).status;
      expect(await status("w=640&q=75")).toBe(200); // deviceSizes still apply
      expect(await status("w=384&q=75")).toBe(400); // a default imageSize — now rejected
      expect(await status("w=32&q=75")).toBe(400);
    } finally {
      await solo.cleanup();
    }
  }, 60_000);
});

describe("image optimizer — middleware coverage must still win over the cacheable policy", () => {
  // INVARIANT (AGENTS.md #2, and the reason forcedCdnCacheControl exists): Cloud CDN sits
  // BEFORE the ext_proc middleware callout, so any shared-cache freshness on a
  // middleware-covered route lets CDN hits skip middleware entirely. Making /_next/image
  // responses genuinely cacheable (`public, max-age=14400`) is only safe because the forced
  // wrapper strips it — and the deploy tag with it — when the matcher covers the path.
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    ({ port } = await booter.boot(null, { middlewareMatcher: "^\\/_next\\/image" }));
  }, 60_000);

  afterAll(async () => {
    await booter.cleanup();
  });

  it("forces no-cache and drops the cache-tag when middleware covers /_next/image", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
      headers: { accept: "image/webp" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    // No shared-cache freshness ⇒ the CDN never stores it ⇒ a deploy tag would be dead
    // weight (and misleading) on it.
    expect(res.headers.get("cache-tag")).toBeNull();
    // Parity headers are unaffected — only the caching verdict changes.
    expect(res.headers.get("etag")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="mislabeled.webp"');
    await res.arrayBuffer();
  });

  it("runs terminal middleware before the optimizer", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export function proxy() {
  return new Response("blocked by image middleware", {
    status: 451,
    headers: { "x-image-middleware": "ran" },
  });
}\n`,
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`);
      expect(res.status).toBe(451);
      expect(res.headers.get("x-image-middleware")).toBe("ran");
      expect(await res.text()).toBe("blocked by image middleware");
    } finally {
      await scoped.cleanup();
    }
  });

  it("does not run middleware twice after a trusted upstream verdict", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        internalSecret: "image-routing-secret",
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export function proxy() {
  return new Response("middleware ran twice", { status: 451 });
}\n`,
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        headers: {
          accept: "image/webp",
          "x-internal-secret": "image-routing-secret",
          "x-mw-evaluated": "ran",
          "x-resolved-headers": JSON.stringify({ "x-image-upstream": "reused" }),
          "x-mw-request-headers": JSON.stringify({ accept: "image/png" }),
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-image-upstream")).toBe("reused");
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("carries middleware request and response header mutations into the optimizer", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export function proxy() {
  return new Response(null, {
    headers: {
      "x-middleware-next": "1",
      "x-middleware-override-headers": "accept",
      "x-middleware-request-accept": "image/png",
      "x-image-middleware": "continued",
    },
  });
}\n`,
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        headers: { accept: "image/webp" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-image-middleware")).toBe("continued");
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("continues the optimizer after middleware when an app catch-all also matches", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export function proxy() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}\n`,
        pathnames: ["/[...slug]"],
        poolAssignments: { "/[...slug]": "main" },
        dynamicRoutes: [
          {
            source: "/[...slug]",
            sourceRegex: "^\\/(?<nxtPslug>.+?)(?:\\/)?$",
            destination: "/[...slug]?nxtPslug=$nxtPslug",
          },
        ],
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        headers: { accept: "image/png" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("runs headers rules before the optimizer without middleware", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        beforeMiddleware: [
          {
            source: "/_next/image",
            sourceRegex: "^\\/_next\\/image(?:\\/)?$",
            headers: { "x-image-rule": "applied" },
          },
        ],
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-image-rule")).toBe("applied");
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("buffers a non-read body for middleware and then continues the optimizer", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export async function proxy(request) {
  const body = await request.text();
  return new Response(null, {
    headers: { "x-middleware-next": "1", "x-image-request-body": body },
  });
}\n`,
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        method: "POST",
        body: "optimizer-body",
        headers: { accept: "image/png" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("x-image-request-body")).toBe("optimizer-body");
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("preserves middleware cookies with Expires commas exactly once", async () => {
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, {
        middlewareMatcher: "^\\/_next\\/image$",
        middlewareSource: `export function proxy() {
  const headers = new Headers({ "x-middleware-next": "1" });
  headers.append("set-cookie", "session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/");
  headers.append("set-cookie", "theme=dark; Path=/");
  return new Response(null, { headers });
}\n`,
      });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`);
      expect(res.status).toBe(200);
      expect(res.headers.getSetCookie()).toEqual([
        "session=one; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/",
        "theme=dark; Path=/",
      ]);
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  });

  it("still answers If-None-Match with a 304 whose Cache-Control is the forced no-cache", async () => {
    const first = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
    });
    const conditional = await rawGet(port, "/_next/image?url=/mislabeled.jpg&w=640&q=75", {
      accept: "image/webp",
      "if-none-match": first.headers["etag"]!,
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers["cache-control"]).toBe("no-cache");
    expect(conditional.headers["cache-tag"]).toBeUndefined();
  });

  it("leaves a NON-covered optimizer path cacheable (the force is matcher-scoped)", async () => {
    // Proves the previous assertions come from middleware coverage, not from the optimizer
    // having silently lost its cacheable policy.
    const scoped = makeBooter();
    try {
      const { port: p2 } = await scoped.boot(null, { middlewareMatcher: "^\\/only-this" });
      const res = await fetch(`http://127.0.0.1:${p2}/_next/image?url=/mislabeled.jpg&w=640&q=75`, {
        headers: { accept: "image/webp" },
      });
      expect(res.headers.get("cache-control")).toBe("public, max-age=14400, must-revalidate");
      expect(res.headers.get("cache-tag")).toBe(BUILD_TAG);
      await res.arrayBuffer();
    } finally {
      await scoped.cleanup();
    }
  }, 60_000);
});

describe("image optimizer — basePath", () => {
  const booter = makeBooter();
  let port: number;

  beforeAll(async () => {
    ({ port } = await booter.boot(null, { basePath: "/docs" }));
  });

  afterAll(async () => {
    await booter.cleanup();
  });

  it("serves the basePath-prefixed platform route", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/docs/_next/image?url=/docs/mislabeled.jpg&w=640&q=75`,
      { headers: { accept: "image/png" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    await res.arrayBuffer();
  });

  it("serves the default loader source shape under a basePath", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/docs/_next/image?url=/mislabeled.jpg&w=640&q=75`,
      { headers: { accept: "image/png" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    await res.arrayBuffer();
  });

  it.each(["/_next/image", "/docsy/_next/image"])(
    "does not recognize %s outside the configured basePath boundary",
    async (pathname) => {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}?url=/mislabeled.jpg&w=640&q=75`);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("image/");
    },
  );
});

// ---------------------------------------------------------------------------
// S3 (SECURITY + PARITY) — a middleware-covered image SOURCE may not be read off disk.
//
// The optimizer's local branch did `readFileSync(public/<source>)` with no coverage check,
// while its siblings (`/_next/static/`, `/_next/data/`) both refuse to short-circuit a covered
// path. So `GET /_next/image?url=/gated.png` returned the bytes middleware on `/gated.png`
// denies — and sendImageResponse then made them CDN-cacheable. It is also a parity break:
// upstream's fetchInternalImage resolves a relative source through `routerServerHandler`, the
// full pipeline INCLUDING middleware, not a filesystem read. The adapter already has that
// re-entry (the loopback self-fetch); the fix is to prefer it when the source is covered.
// ---------------------------------------------------------------------------
describe("image optimizer — middleware covering the SOURCE path (S3)", () => {
  const booter = makeBooter();
  afterAll(async () => {
    await booter.cleanup();
  });

  // Denies /gated.png, allows /open.png. Matcher covers both so coverage is not the variable.
  const MW = `export function proxy(request) {
  const { pathname } = new URL(request.url);
  if (pathname === "/gated.png") return new Response("denied", { status: 403 });
}
`;

  it("does NOT serve a middleware-denied public image through /_next/image", async () => {
    const { port } = await booter.boot(null, {
      middlewareMatcher: "^\\/(gated|open)\\.png$",
      middlewareSource: MW,
      publicFiles: ["gated.png", "open.png"],
    });
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/gated.png&w=640&q=75`);
    // The re-entry surfaces middleware's 403 as an upstream failure, so the one thing that
    // must not happen is a 200 carrying the protected bytes.
    expect(res.status).not.toBe(200);
    expect(res.headers.get("content-type") ?? "").not.toContain("image/");
  });

  it("takes the loopback re-entry for a covered source, so middleware actually RUNS", async () => {
    // The positive half of the fix: a covered source must not merely be refused, it must be
    // resolved through the pipeline. Middleware records the paths it is invoked for, so the
    // marker proves the request re-entered the server for the SOURCE path instead of being
    // read off disk. (Whether the re-entry then yields bytes depends on the app's own routing;
    // this fixture is an optimizer-parity fixture with no route graph, so serving is covered
    // by the live suite, not here.)
    const markers = path.join(REPO_ROOT, `.image-mw-seen-${process.pid}.log`);
    rmSync(markers, { force: true });
    try {
      const { port } = await booter.boot(null, {
        middlewareMatcher: "^\\/(gated|open)\\.png$",
        middlewareSource: `import { appendFileSync } from "node:fs";
export function proxy(request) {
  const { pathname } = new URL(request.url);
  appendFileSync(${JSON.stringify(markers)}, pathname + "\\n");
  if (pathname === "/gated.png") return new Response("denied", { status: 403 });
}
`,
        publicFiles: ["gated.png", "open.png"],
      });
      await fetch(`http://127.0.0.1:${port}/_next/image?url=/open.png&w=640&q=75`).catch(
        () => undefined,
      );
      const seen = existsSync(markers) ? readFileSync(markers, "utf-8") : "";
      expect(seen).toContain("/open.png");
    } finally {
      rmSync(markers, { force: true });
    }
  });

  it("reads an UNCOVERED source straight from disk (the fast path is intact)", async () => {
    const { port } = await booter.boot(null, {
      middlewareMatcher: "^\\/only-this$",
      middlewareSource: MW,
      publicFiles: ["gated.png"],
    });
    const res = await fetch(`http://127.0.0.1:${port}/_next/image?url=/gated.png&w=640&q=75`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("image/");
  });
});
