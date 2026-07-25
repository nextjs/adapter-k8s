// src/pool-server/index.ts
import { readFileSync, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolManifest, RoutingManifest, StaticAssetEntry } from "../types.js";
import {
  getRscConfig,
  manifestNextConfig,
  matchesMiddleware,
  MW_EVALUATED_TRUSTED,
  parseRequestUrl,
  rscCacheBustingUnvalidated,
  rscParentCandidates,
  templateOutputCandidates,
  type MiddlewareMatcher,
  type RscConfig,
} from "../routing-common.js";
import { createHandlerLoader } from "./handler-loader.js";
import { collectPublicPathnames } from "./public-files.js";
import { cdnCacheTag } from "../cdn-tags.js";
import { createLocalResolver, hasCallableMiddlewareExport } from "./resolve.js";
import {
  createDispatcher,
  getContentType,
  mergeResolvedHeadersIntoHeadersArg,
} from "./dispatch.js";
import { nextStaticAssetHeaders } from "../static-asset-headers.js";
import { ifNoneMatchMatches, staticAssetEtag } from "./http-cache.js";
import { decodePublicPathname } from "./public-files.js";
import {
  DEFAULT_IMAGE_FORMATS,
  detectImageContentType,
  DEFAULT_IMAGE_DEVICE_SIZES,
  DEFAULT_IMAGE_QUALITIES,
  DEFAULT_IMAGE_SIZES,
  imageCacheControl,
  imageContentDisposition,
  imageEtag,
  imageMaxAge,
  validateImageSizeAndQuality,
  isOptimizableImageContentType,
  negotiateImageFormat,
  resizeForRequestedWidth,
} from "./image-utils.js";
import { createPoolServer, filterWriteHeadHeadersArg } from "./server.js";
import { readWebBodyWithLimit } from "./body-limit.js";
import { registerValkeyCacheHandler } from "./valkey-cache/register.js";
import { explicitCacheControlWins, forcedCdnCacheControl } from "./cache-policy.js";

const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");

// Initialize Next.js Node runtime shims (AsyncLocalStorage, hooks, crypto polyfills).
// This MUST run before any Next.js handler modules are imported.
// Follows the AWS adapter's ensureNextNodeEnvironment pattern.
async function ensureNextNodeEnvironment(): Promise<void> {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const candidates = [
    "next/setup-node-env",
    "next/dist/build/adapter/setup-node-env.external",
    "next/dist/server/node-environment",
  ];

  for (const candidate of candidates) {
    try {
      req(candidate);
      return;
    } catch {
      // Try the next candidate.
    }
  }

  console.warn(
    "[pool-server] Could not load Next.js node environment shims from app dependencies — AsyncLocalStorage may not work",
  );
}

// Run the app's `instrumentation.js` `register()` hook before the pool serves anything,
// which is what `next start` does — and the ordering, not just the fact of registration,
// is the point: an app that sets up a tracer provider, monkey-patches `node:http`, or
// installs an error reporter in `register()` expects that to have happened before the
// first request is handled.
//
// What `next start` actually does (Next 16.2, verified in source and on a live server):
//   • `NextNodeServer.prepareImpl()` → `runInstrumentationHookIfAvailable()` →
//     `ensureInstrumentationRegistered(dir, distDir)`
//     (server/lib/router-utils/instrumentation-globals.external.ts), which requires
//     `<distDir>/server/instrumentation.js` and awaits its `register()`.
//   • Ordering: `startServer` binds the port immediately but QUEUES every request behind
//     `handlersPromise`, which resolves only after `render-server`'s `initializeImpl`
//     awaits `server.prepare()`. Measured with a `register()` that sleeps 1500 ms: port
//     accepting at +98 ms, register start +124 ms, register DONE +1626 ms, and the first
//     response only at +1674 ms — with the hook's completion flag already set. So
//     `register()` is awaited to completion before the first request is served.
//   • Exactly once per process: the promise is memoized in a module-level
//     `registerInstrumentationPromise` (`calls=1` on the probe, same pid as the request
//     handler). There is no per-worker duplication in `next start`.
//   • Missing file: `getInstrumentationModule` swallows ENOENT / MODULE_NOT_FOUND /
//     ERR_MODULE_NOT_FOUND, so an app without instrumentation is a silent no-op.
//   • A THROWING `register()`: the process does NOT exit. `next start` logs
//     "Failed to prepare server" plus an unhandledRejection and stays up — but the
//     rejected promise is memoized, so every subsequent request 500s forever (measured:
//     3/3 `/api/*` and `/` → 500 "Internal Server Error", process alive after 6 s).
//
// The adapter goes through upstream's own `ensureInstrumentationRegistered` rather than
// requiring `.next/server/instrumentation.js` itself, for one decisive reason: Next ALSO
// calls it lazily from `RouteModule.prepare()` on the entrypoint path the pool dispatches
// into. Both call sites resolve to the same file
// (`<app>/node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js`
// — verified identical, and `require()` here shares the CJS cache entry with
// route-module's `await import()`), so they share the memoized promise: registering here
// guarantees exactly-once and cannot double-register, whereas a hand-rolled loader would
// run `register()` a second time (an OTEL SDK started twice is a real failure).
// Reusing it also keeps `afterRegistration()` — the cache-components tracer patch that
// runs immediately after `register()` upstream.
//
// Failure policy: log loudly, do NOT block startup. The pod keeps answering `/healthz`,
// static assets and `/_next/image`, while Next's own per-request
// `ensureInstrumentationRegistered` re-awaits the same rejected promise and 500s the
// routes it owns — i.e. `next start`'s observable behavior on the app's own routes,
// without an instrumentation bug turning into a CrashLoopBackOff.
async function registerInstrumentationHook(): Promise<void> {
  // distDir is `.next` everywhere in the pool (staging, manifests, the edge sandbox);
  // upstream passes a project-relative distDir here too.
  const distDir = ".next";
  const cwd = process.cwd();
  // `ensureInstrumentationRegistered` already tolerates a missing hook, but checking first
  // keeps the "no instrumentation" case from depending on error-code sniffing at all.
  if (!existsSync(path.join(cwd, distDir, "server", "instrumentation.js"))) return;

  // Resolving the registrar and RUNNING it fail for different reasons and must not share a
  // diagnostic: "the app's hook threw" and "this Next version moved the registrar" call for
  // different fixes. If the registrar can't be found, do NOT fall back to requiring the hook
  // directly — that would break the shared memo with RouteModule.prepare and run register()
  // a second time. Next's lazy path still runs it on the first request: late, but once.
  const MODULE_ID = "next/dist/server/lib/router-utils/instrumentation-globals.external";
  let ensureInstrumentationRegistered:
    | ((projectDir: string, distDir: string) => Promise<void>)
    | undefined;
  try {
    const appRequire = createRequire(path.join(cwd, "package.json"));
    ({ ensureInstrumentationRegistered } = appRequire(MODULE_ID) as {
      ensureInstrumentationRegistered?: (projectDir: string, distDir: string) => Promise<void>;
    });
  } catch (err) {
    console.error(
      `[pool-server] could not load ${MODULE_ID} from the app — instrumentation register() ` +
        `will run lazily on the first request instead of at startup:`,
      err,
    );
    return;
  }
  if (typeof ensureInstrumentationRegistered !== "function") {
    console.error(
      `[pool-server] ${MODULE_ID} does not export ensureInstrumentationRegistered — ` +
        `instrumentation register() will run lazily on the first request instead of at startup`,
    );
    return;
  }

  try {
    // Awaited: a hook that never settles holds the pod out of readiness, which fails the
    // blue/green gate rather than cutting traffic to a half-initialized build. `next start`
    // is equivalent — its requests queue behind the same unresolved promise.
    await ensureInstrumentationRegistered(cwd, distDir);
    console.log("[pool-server] instrumentation register() completed");
  } catch (err) {
    console.error(
      "[pool-server] instrumentation register() FAILED — the pool will keep serving " +
        "/healthz and static assets, but Next re-awaits this same rejected registration " +
        "per request, so app routes will 500 (this is what next start does too):",
      err,
    );
  }
}

// DoS backstop: the pool buffers request/image bodies fully in memory (the
// loopback handler needs a fixed-length body, and middleware may read it). Cap
// the buffer well above any legitimate payload so app-level limits
// (serverActions.bodySizeLimit, the image optimizer) still fire first; this
// only stops an unbounded upload from exhausting pod memory. Configurable.
const MAX_BODY_BYTES = Math.max(
  1,
  parseInt(process.env.ADAPTER_K8S_MAX_BODY_BYTES ?? "", 10) || 26_214_400, // 25 MiB
);

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds ADAPTER_K8S_MAX_BODY_BYTES");
    this.name = "BodyTooLargeError";
  }
}

async function readRequestBody(
  req: NodeJS.ReadableStream,
  maxBytes = MAX_BODY_BYTES,
): Promise<Buffer | null> {
  const stream = req as NodeJS.ReadableStream & {
    on: (event: string, cb: (...args: never[]) => void) => unknown;
    off: (event: string, cb: (...args: never[]) => void) => unknown;
    once: (event: string, cb: (...args: never[]) => void) => unknown;
    pause?: () => void;
  };
  const chunks: Buffer[] = [];
  let total = 0;
  // Explicit listener pump instead of `for await`: an early exit from a stream async
  // iterator DESTROYS the stream (and, for IncomingMessage, the socket), which turned
  // a deliverable 413 into an ECONNRESET the client couldn't read. On oversize we
  // pause and throw; the caller writes 413 + `connection: close` and only then
  // destroys the socket after the response has been flushed.
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        cleanup();
        stream.pause?.();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buf);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
  return chunks.length > 0 ? Buffer.concat(chunks) : null;
}

function createBufferedStream(body: Buffer | null): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (body && body.length > 0) {
        controller.enqueue(body);
      }
      controller.close();
    },
  });
}

// Reconstruct a Headers from the routing extension's serialized x-resolved-headers (JSON of
// next.config headers() + middleware response headers). Set-Cookie arrives as an array so each
// cookie is re-appended intact. Malformed JSON is ignored (returns undefined) rather than
// failing the request.
function parseResolvedHeaders(raw: string | undefined): Headers | undefined {
  if (!raw) return undefined;
  try {
    const obj = JSON.parse(raw) as Record<string, string | string[]>;
    const headers = new Headers();
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }
    return headers;
  } catch {
    return undefined;
  }
}

// Every cache-control observable on the response at writeHead time: from the headers
// ARGUMENT (object, tuple-array, and flat-array forms — the same shapes the strip
// wrappers handle) and from the setHeader map. The forced-cache skip below must see a
// `no-store` in ANY of them: dispatch's resolved-header merge may have replaced the
// argument copy while a setHeader copy still records the handler's own verdict (or
// vice versa), and missing one would let a weaker resolved value uncork a response
// the app declared uncacheable.
function observedCacheControls(args: unknown[], res: ServerResponse): string[] {
  const found: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg || typeof arg !== "object") continue;
    if (Array.isArray(arg)) {
      if (arg.length > 0 && !Array.isArray(arg[0])) {
        // Flat form: even offsets are names, odd offsets are values.
        for (let j = 0; j + 1 < arg.length; j += 2) {
          if (String(arg[j]).toLowerCase() === "cache-control") found.push(String(arg[j + 1]));
        }
      } else {
        for (const entry of arg as [unknown, unknown][]) {
          if (String(entry[0]).toLowerCase() === "cache-control") found.push(String(entry[1]));
        }
      }
    } else {
      for (const [key, value] of Object.entries(arg as Record<string, unknown>)) {
        if (key.toLowerCase() === "cache-control") {
          found.push(Array.isArray(value) ? value.join(", ") : String(value));
        }
      }
    }
  }
  const fromMap = res.getHeader("cache-control");
  if (fromMap !== undefined) {
    found.push(Array.isArray(fromMap) ? fromMap.join(", ") : String(fromMap));
  }
  return found;
}

// LAST-RESORT public/ file serving from disk. The canonical path for public files is the
// static-assets manifest via dispatcher.dispatch (which merges the resolved routing
// verdict — next.config headers() / middleware headers — over the adapter's mutable
// default); this fallback exists only for a file that is on disk but missing from the
// manifest (stale or absent static-assets.json, e.g. emulate/bootstrap setups or a
// canonical-encoding miss), so a build inconsistency degrades to the old serve instead
// of a 404. It applies the SAME resolved-header merge dispatch would have, then stamps
// the CDN cache tag from the EFFECTIVE cache-control (mutable cacheable ⇒ tagged,
// uncacheable ⇒ never — the final-Cache-Control rule).
function servePublicFileFromDisk(
  req: IncomingMessage,
  res: ServerResponse,
  requestPathname: string,
  resolvedHeaders: Headers | undefined,
  buildId: string,
): boolean {
  const decodedPathname = decodePublicPathname(requestPathname);
  const publicFile = decodedPathname
    ? resolveWithinRoot(path.join(process.cwd(), "public"), decodedPathname)
    : null;
  if (!publicFile || !existsSync(publicFile) || statSync(publicFile).isDirectory()) {
    return false;
  }
  const content = readFileSync(publicFile);
  const etag = staticAssetEtag(content);
  let responseHeaders: Record<string, string | string[]> = {
    "content-type": getContentType(decodedPathname!),
    "cache-control": "public, max-age=3600",
    etag,
  };
  if (resolvedHeaders) {
    responseHeaders = mergeResolvedHeadersIntoHeadersArg(
      resolvedHeaders,
      responseHeaders,
    ) as Record<string, string | string[]>;
  }
  Object.assign(
    responseHeaders,
    cdnCacheTag(String(responseHeaders["cache-control"] ?? ""), buildId),
  );
  const effectiveEtag = String(responseHeaders["etag"] ?? etag);
  if (ifNoneMatchMatches(req.headers["if-none-match"], effectiveEtag)) {
    res.writeHead(304, responseHeaders);
    res.end();
    return true;
  }
  res.writeHead(200, responseHeaders);
  res.end(req.method === "HEAD" ? undefined : content);
  return true;
}

function addRequestMeta(req: Record<PropertyKey, unknown>, key: string, value: unknown): void {
  const meta = (req[NEXT_REQUEST_META] as Record<string, unknown> | undefined) ?? {};
  meta[key] = value;
  req[NEXT_REQUEST_META] = meta;
}

function isServerActionRequest(headers: Headers, method: string): boolean {
  if (method !== "POST") return false;
  const nextAction = headers.get("next-action");
  const contentType = headers.get("content-type") ?? "";
  return (
    typeof nextAction === "string" ||
    contentType.startsWith("multipart/form-data") ||
    contentType.startsWith("application/x-www-form-urlencoded")
  );
}

// --- Image optimizer SSRF / path-traversal guards -------------------------------

interface ImageRemotePattern {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
}

interface ImageConfig {
  remotePatterns: ImageRemotePattern[];
  domains: string[];
  // Allowed optimization widths — the union bounds the `w` param so a client can't drive
  // Sharp into an unbounded allocation. Default to Next's defaults when unconfigured.
  // An explicitly EMPTY list means "no width allowed" (valid config: `imageSizes: []`),
  // which is why absence and emptiness must stay distinguishable at load time.
  deviceSizes: number[];
  imageSizes: number[];
  // Allowed `q` values (`images.qualities`, default [75]). Each accepted quality is its
  // own CDN cache entry and its own sharp encode, so the set bounds amplification as much
  // as it enforces parity. `undefined` only when the build config couldn't be read.
  qualities: number[] | undefined;
  // `next start` parity: SVG through /_next/image is a 400 unless the app opted in via
  // images.dangerouslyAllowSVG, and even then Next serves it with Content-Disposition:
  // attachment + this CSP so a crafted SVG can't run script in the site's origin.
  dangerouslyAllowSVG: boolean;
  // Sent on EVERY optimizer 200, not only the SVG branch — Next's setResponseHeaders
  // stamps both unconditionally. A `<img src>` can't execute the CSP anyway, but a user
  // who navigates straight to an optimizer URL gets the same sandbox `next start` gives.
  contentSecurityPolicy: string;
  contentDispositionType: "attachment" | "inline";
  // Output formats the optimizer may negotiate into. Next's default is webp-ONLY: a
  // browser advertising `image/avif,image/webp` gets WebP unless the app opts into AVIF.
  // (Also the cheaper default — AVIF encoding costs several times more CPU per request.)
  formats: string[];
  // Freshness floor for optimizer responses (`public, max-age=<ttl>, must-revalidate`).
  minimumCacheTTL: number;
}

// Load sharp exactly once per process and cache the verdict — success OR failure.
// esbuild bundles sharp's JS into pool-server.cjs, and its __commonJS wrapper
// registers the module record BEFORE evaluating it: when the native binding is
// missing (no @img/sharp-* in the container), the FIRST require throws but every
// LATER require returns the broken partially-initialized module. Live this showed
// up as one honest 503 ("sharp is unavailable") followed by an endless stream of
// misleading 502s from deep inside the pipeline (build XchOtaGFu6GdFrcdujVc0).
// Memoizing the first attempt keeps the failure mode consistent and logs WHY once.
type SharpModule = (input: Buffer) => SharpPipeline;
type SharpPipeline = {
  resize: (w: number | undefined, h: undefined, o: { withoutEnlargement: true }) => SharpPipeline;
  timeout: (o: { seconds: number }) => SharpPipeline;
  rotate: () => SharpPipeline;
  avif: (o: { quality: number; effort: number }) => SharpPipeline;
  webp: (o: { quality: number }) => SharpPipeline;
  png: (o: { quality: number }) => SharpPipeline;
  jpeg: (o: { quality: number; mozjpeg: true }) => SharpPipeline;
  gif: () => SharpPipeline;
  tiff: () => SharpPipeline;
  toBuffer: () => Promise<Buffer>;
};
let sharpLoadAttempted = false;
let sharpModule: SharpModule | null = null;
function loadSharpOnce(): SharpModule | null {
  if (sharpLoadAttempted) return sharpModule;
  sharpLoadAttempted = true;
  try {
    // In the production CJS bundle `require` exists (and esbuild has inlined sharp's
    // JS behind it). Under the ESM source loader (vitest) it is undefined — resolve
    // from the app dir instead, the same way the pool resolves next/dist modules.
    sharpModule =
      typeof require === "function"
        ? (require("sharp") as SharpModule)
        : (createRequire(path.join(process.cwd(), "package.json"))("sharp") as SharpModule);
  } catch (err) {
    sharpModule = null;
    console.error(
      "[pool-server] sharp failed to load — /_next/image will refuse to serve unoptimized (production images always ship sharp; check the image build):",
      err instanceof Error ? err.message : err,
    );
  }
  return sharpModule;
}

// Next's default images.contentSecurityPolicy (config-shared) — applied to every
// optimizer 200 when the app doesn't configure its own.
const DEFAULT_IMAGE_CSP = "script-src 'none'; frame-src 'none'; sandbox;";
// Next's default images.minimumCacheTTL (4 hours). The optimizer's Cache-Control floor.
const DEFAULT_MINIMUM_CACHE_TTL = 14400;
// Formats the pipeline can actually emit as a NEGOTIATED output. Next documents only
// these two for images.formats, and an unrecognized entry must not reach sharp.
const SUPPORTED_IMAGE_FORMATS = new Set(["image/avif", "image/webp"]);

// Keep only the values Next's config schema admits for deviceSizes/imageSizes (integers
// 1..10000). These bound a sharp allocation, so a junk entry must not become an allowed
// width; an all-junk list becomes an empty set, which rejects every `w` (fail closed).
function toAllowedSizes(values: unknown[]): number[] {
  return values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10000,
  );
}

// Read the app's image config (external-host allowlist + allowed sizes) from the build
// output. Next.js writes the resolved config to .next/required-server-files.json. When it's
// unavailable, external image fetches are denied by default and sizes fall back to defaults.
function loadImageConfig(cwd: string): ImageConfig {
  const config: ImageConfig = {
    remotePatterns: [],
    domains: [],
    deviceSizes: [...DEFAULT_IMAGE_DEVICE_SIZES],
    imageSizes: [...DEFAULT_IMAGE_SIZES],
    qualities: [...DEFAULT_IMAGE_QUALITIES],
    dangerouslyAllowSVG: false,
    contentSecurityPolicy: DEFAULT_IMAGE_CSP,
    contentDispositionType: "attachment",
    formats: [...DEFAULT_IMAGE_FORMATS],
    minimumCacheTTL: DEFAULT_MINIMUM_CACHE_TTL,
  };
  try {
    const rsfPath = path.join(cwd, ".next", "required-server-files.json");
    if (existsSync(rsfPath)) {
      const rsf = JSON.parse(readFileSync(rsfPath, "utf-8"));
      const images = rsf?.config?.images ?? {};
      if (Array.isArray(images.remotePatterns)) config.remotePatterns = images.remotePatterns;
      if (Array.isArray(images.domains)) config.domains = images.domains;
      // PRESENCE, not truthiness: `imageSizes: []` is valid config meaning "only
      // deviceSizes are allowed", and falling back to Next's default list for it would
      // silently WIDEN the accepted width set past what the app configured. Entries are
      // filtered to the shape Next's config schema guarantees (int 1..10000) because they
      // bound a sharp allocation.
      if (Array.isArray(images.deviceSizes)) config.deviceSizes = toAllowedSizes(images.deviceSizes);
      if (Array.isArray(images.imageSizes)) config.imageSizes = toAllowedSizes(images.imageSizes);
      // `images.qualities` (schema: 1..20 ints in 1..100, so never legitimately empty).
      // An unreadable/empty list keeps Next's default [75] rather than disabling the
      // check — the narrow direction.
      if (Array.isArray(images.qualities)) {
        const qualities = images.qualities.filter(
          (value: unknown): value is number =>
            typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100,
        );
        if (qualities.length) config.qualities = qualities;
      }
      config.dangerouslyAllowSVG = images.dangerouslyAllowSVG === true;
      if (typeof images.contentSecurityPolicy === "string" && images.contentSecurityPolicy)
        config.contentSecurityPolicy = images.contentSecurityPolicy;
      if (images.contentDispositionType === "inline") config.contentDispositionType = "inline";
      // Validate at the point of consumption: these two steer a response header and the
      // encoder, so keep only values this pipeline can honor. An unrecognized `formats`
      // entry is dropped (never handed to sharp); an all-unrecognized list falls back to
      // Next's default rather than disabling negotiation entirely.
      if (Array.isArray(images.formats)) {
        const supported = images.formats.filter(
          (format: unknown): format is string =>
            typeof format === "string" && SUPPORTED_IMAGE_FORMATS.has(format.toLowerCase()),
        );
        if (supported.length) config.formats = supported;
      }
      if (
        typeof images.minimumCacheTTL === "number" &&
        Number.isSafeInteger(images.minimumCacheTTL) &&
        images.minimumCacheTTL >= 0
      ) {
        config.minimumCacheTTL = images.minimumCacheTTL;
      }
    }
  } catch {
    // No image config — external images denied by default, sizes fall back to defaults,
    // SVG stays denied (fail-safe direction).
  }
  return config;
}

// Emit an optimizer 200 (or a 304) exactly the way Next's `setResponseHeaders` /
// `sendResponse` do. EVERY /_next/image success — re-encoded, format-passthrough, and the
// allowed-SVG branch — goes through here, because `next start` sends the same header set
// for all of them: Vary, Cache-Control, ETag (with If-None-Match honored), Content-Type,
// Content-Disposition and the images CSP. Previously only the SVG branch carried
// Content-Disposition/CSP, nothing carried an ETag, and the Cache-Control was a hardcoded
// `max-age=60`.
//
// Two adapter-specific concerns layered on top of parity:
//   • the CDN deploy tag (M13). These responses are now genuinely CDN-cacheable and their
//     URL is NOT content-addressed (`?url=/logo.png&w=384` serves whatever the current
//     build's public/logo.png is), so a cutover must be able to purge them — cdnCacheTag
//     stamps the recorded deploy tag whenever the effective Cache-Control lets a shared
//     cache store the response, and returns {} for the `immutable` static-media case and
//     for anything uncacheable. It is applied to the 304 too: a CDN revalidation that
//     refreshes an entry from a tagless 304 would leave an untagged, un-invalidatable
//     entry behind, which is exactly the stale-apex failure M13 documents.
//   • middleware. Nothing here can defeat `forcedCdnCacheControl`: when middleware's
//     matcher covers /_next/image the writeHead wrapper installed earlier in the request
//     strips this Cache-Control AND the cache-tag and forces `no-cache`, so a CDN hit can
//     never bypass the ext_proc callout. The wrapper is installed before this handler
//     runs and sits under every write below (verified by test).
function sendImageResponse(
  req: IncomingMessage,
  res: ServerResponse,
  {
    body,
    contentType,
    sourceUrl,
    isStatic,
    maxAge,
    config,
    buildId,
  }: {
    body: Buffer;
    contentType: string;
    sourceUrl: string;
    isStatic: boolean;
    maxAge: number;
    config: ImageConfig;
    buildId: string | undefined;
  },
): void {
  const cacheControl = imageCacheControl(maxAge, isStatic);
  const etag = imageEtag(body);
  const cacheTag = cdnCacheTag(cacheControl, buildId);
  // RFC 7232: a 304 repeats the headers that govern caching (Cache-Control, ETag, Vary)
  // and omits the representation metadata. This is what `next start` sends, verified.
  if (ifNoneMatchMatches(req.headers["if-none-match"] as string | undefined, etag)) {
    res.writeHead(304, {
      vary: "Accept",
      "cache-control": cacheControl,
      etag,
      ...cacheTag,
    });
    res.end();
    return;
  }
  res.writeHead(200, {
    // The bytes depend on the client's Accept — without Vary, Cloud CDN caches whichever
    // variant the first visitor got and serves it to everyone.
    vary: "Accept",
    "cache-control": cacheControl,
    etag,
    "content-type": contentType,
    // Next sends this on every optimizer 200, not just SVG: an optimizer URL is never a
    // page, so a browser that navigates to one downloads it instead of rendering it.
    "content-disposition": imageContentDisposition(
      sourceUrl,
      contentType,
      config.contentDispositionType,
    ),
    "content-security-policy": config.contentSecurityPolicy,
    // Explicit, exactly as Next sets it — and required for HEAD: Node marks a HEAD
    // response as having no body and then emits NEITHER Content-Length nor
    // Transfer-Encoding, so a HEAD that should report the payload size reported nothing
    // (measured against `next start`, which answers HEAD with Content-Length: 6224 for
    // the fixture's /test.png at w=384).
    "content-length": String(body.length),
    ...cacheTag,
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

// True when the app has a classic incremental cacheHandler registered (next.config.cacheHandler).
// The adapter registers ours (dist/cache-handler.cjs) only when the cache is enabled AND there's no
// edge middleware; when registered, that handler owns the PPR shell so dispatch must NOT inject the
// build-time postponed token. Reading the resolved config (rather than VALKEY_URL) tracks exactly
// that build decision — a cache + edge-middleware app has VALKEY_URL but no registered handler.
function hasRegisteredCacheHandler(cwd: string): boolean {
  try {
    const rsfPath = path.join(cwd, ".next", "required-server-files.json");
    if (!existsSync(rsfPath)) return false;
    const rsf = JSON.parse(readFileSync(rsfPath, "utf-8"));
    return Boolean(rsf?.config?.cacheHandler);
  } catch {
    return false;
  }
}

// Resolve `relPath` under `root`, returning null if it escapes the root (traversal).
function resolveWithinRoot(root: string, relPath: string): string | null {
  const rel = relPath.startsWith("/") ? relPath : `/${relPath}`;
  const resolved = path.resolve(root, `.${rel}`);
  if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped && mapped[1]) return isPrivateIPv4(mapped[1]);
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique-local fc00::/7
  return false;
}

function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // unparseable → treat as unsafe
}

// Resolve a hostname and confirm every address it maps to is publicly routable.
// Blocks SSRF to loopback/private/link-local/metadata targets even when the host is
// allowlisted by name (defends against DNS-rebind). IP literals are checked directly.
async function hostResolvesToPublicOnly(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return !isPrivateAddress(hostname);
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.length === 0) return false;
    return records.every((r) => !isPrivateAddress(r.address));
  } catch {
    return false;
  }
}

function hostnameMatchesPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith("**.")) {
    const suffix = pattern.slice(3);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    if (!hostname.endsWith(`.${suffix}`)) return false;
    const label = hostname.slice(0, hostname.length - suffix.length - 1);
    return label.length > 0 && !label.includes(".");
  }
  return hostname === pattern;
}

function pathnameMatchesPattern(pathname: string, pattern: string): boolean {
  const re =
    "^" +
    pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\uffff")
      .replace(/\*/g, "[^/]*")
      .replace(/\uffff/g, ".*") +
    "$";
  return new RegExp(re).test(pathname);
}

// True only if `target` matches the app's configured remotePatterns/domains allowlist.
function isExternalImageAllowed(target: URL, config: ImageConfig): boolean {
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  const host = target.hostname;
  if (config.domains.includes(host)) return true;
  for (const p of config.remotePatterns) {
    if (!p || typeof p.hostname !== "string") continue;
    if (p.protocol && `${p.protocol}:` !== target.protocol) continue;
    if (!hostnameMatchesPattern(host, p.hostname)) continue;
    if (p.port && p.port !== target.port) continue;
    if (p.pathname && !pathnameMatchesPattern(target.pathname, p.pathname)) continue;
    return true;
  }
  return false;
}

// Fetch an external image while following redirects MANUALLY, re-validating every hop
// against the allowlist and the public-address check. `fetch`'s default redirect:"follow"
// would let an allowlisted host 302 to an internal/metadata address, bypassing the SSRF
// guards — so we intercept each Location and re-run the same checks before following it.
type FetchedImage = {
  ok: boolean;
  status: number;
  contentType: string;
  // The upstream's own Cache-Control. Next raises the optimizer response's max-age to the
  // upstream's when it is longer than images.minimumCacheTTL, so it has to travel back.
  cacheControl: string | null;
  body: Buffer;
};

// A DNS lookup that ONLY yields public addresses. Passed to http(s).request so
// the address the socket actually connects to is the one we validated — closing
// the TOCTOU/DNS-rebind window where a separate validation lookup could return
// a public IP while the connection lookup returns a private/link-local one.
function pinnedPublicLookup(
  hostname: string,
  options: import("node:dns").LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | import("node:dns").LookupAddress[],
    family?: number,
  ) => void,
): void {
  dns
    .lookup(hostname, { all: true })
    .then((records) => {
      const publicRecords = records.filter((r) => !isPrivateAddress(r.address));
      if (publicRecords.length === 0) {
        callback(
          Object.assign(new Error("host resolves to non-public address"), { code: "EAI_FAIL" }),
          "",
          undefined,
        );
        return;
      }
      if (options.all) {
        callback(null, publicRecords, undefined);
      } else {
        const first = publicRecords[0]!;
        callback(null, first.address, first.family);
      }
    })
    .catch((err) => callback(err as NodeJS.ErrnoException, "", undefined));
}

// Fetch an allowlisted external image with SSRF protections: allowlist check,
// public-only pinned DNS, manual redirect re-validation, and a hard byte cap so
// a hostile origin can't stream an unbounded body into pod memory.
async function fetchExternalImageSafely(
  initial: URL,
  config: ImageConfig,
): Promise<FetchedImage | { error: string }> {
  const MAX_REDIRECTS = 3;
  const { request: httpsRequest } = await import("node:https");
  const { request: httpRequest2 } = await import("node:http");
  let target = initial;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isExternalImageAllowed(target, config)) return { error: "image host not allowed" };
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { error: "image host not allowed" };
    }
    // Pre-check keeps a fast, clear rejection; the pinned lookup below is the
    // actual guarantee for the connection that happens.
    if (!(await hostResolvesToPublicOnly(target.hostname))) {
      return { error: "image host not allowed" };
    }

    const request = target.protocol === "https:" ? httpsRequest : httpRequest2;
    const result = await new Promise<FetchedImage | { error: string } | { redirect: string }>(
      (resolve) => {
        const req = request(
          target.toString(),
          { lookup: pinnedPublicLookup, timeout: 15_000 },
          (imgRes) => {
            const status = imgRes.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              imgRes.resume(); // drain
              const location = imgRes.headers.location;
              if (!location) return resolve({ error: "redirect without location" });
              return resolve({ redirect: location });
            }
            const chunks: Buffer[] = [];
            let total = 0;
            imgRes.on("data", (c: Buffer) => {
              total += c.length;
              if (total > MAX_BODY_BYTES) {
                imgRes.destroy();
                resolve({ error: "image exceeds size limit" });
                return;
              }
              chunks.push(c);
            });
            imgRes.on("end", () =>
              resolve({
                ok: status >= 200 && status < 300,
                status,
                contentType: imgRes.headers["content-type"] ?? "image/jpeg",
                cacheControl: imgRes.headers["cache-control"] ?? null,
                body: Buffer.concat(chunks),
              }),
            );
            imgRes.on("error", () => resolve({ error: "image fetch failed" }));
          },
        );
        req.on("timeout", () => {
          req.destroy();
          resolve({ error: "image fetch timed out" });
        });
        req.on("error", () => resolve({ error: "image fetch failed" }));
        req.end();
      },
    );

    if ("redirect" in result) {
      if (hop === MAX_REDIRECTS) return { error: "too many redirects" };
      try {
        target = new URL(result.redirect, target);
      } catch {
        return { error: "invalid redirect location" };
      }
      continue; // re-validate the new target at the top of the loop
    }
    return result;
  }
  return { error: "too many redirects" };
}

// middleware-manifest.json keys app-router edge functions by their SOURCE page path,
// which KEEPS route groups and parallel-route slots — `app/(group)/twitter-image.tsx`
// is stored as `/(group)/twitter-image-1ow20b/route`. The edge route runner looks
// functions up by the URL pathname (`/twitter-image-1ow20b`), which never contains
// those segments, so EVERY edge route under a route group threw "Edge function not
// found in middleware-manifest.json" → 500 (app-dir/metadata-dynamic-routes' grouped
// `twitter-image` did exactly this while the ungrouped `/twitter-image2` worked).
//
// Return a lookup that tries the literal key first and then a group/slot-stripped
// index. Only keys that actually change are indexed, so a manifest without groups adds
// nothing, a real key can never be shadowed by a stripped one, and an ambiguous
// collision (two groups collapsing to one URL — which Next itself rejects at build
// time) keeps the FIRST entry rather than silently flipping between builds.
export function createEdgeFunctionLookup<T>(
  functions: Record<string, T>,
): (key: string) => T | undefined {
  const stripped = new Map<string, T>();
  for (const [key, entry] of Object.entries(functions)) {
    // N17: anchor both strips to a WHOLE segment — an interception marker is GLUED to its
    // segment (`(...)post`, `(.)modal`) and IS part of the route id; only `(group)` and
    // `@slot` segments are invisible in the URL. Unanchored, the group pattern also ate the
    // marker: `/foo/@modal/(...)post/[id]/page` collapsed to `/foo/[id]/page`, so every
    // intercepting EDGE route 500'd (function never found) AND the bogus key could shadow a
    // real `/foo/[id]`. Mirrors handler-loader.ts entryKeyToPathname.
    const bare = key.replace(/\/\([^/]*\)(?=\/|$)/g, "").replace(/\/@[^/]+(?=\/|$)/g, "");
    if (bare !== key && !(bare in functions) && !stripped.has(bare)) stripped.set(bare, entry);
  }
  return (key: string) => functions[key] ?? stripped.get(key);
}

// Boot the pool server. Exported (instead of a self-invoking main) so the startup
// smoke test can boot against a synthetic staged dir; the module self-runs only when
// executed directly (see the guard at the bottom).
export async function startPoolServer(): Promise<ReturnType<typeof createPoolServer>> {
  // A rejected fire-and-forget shouldn't take the pod down — log and continue (per-request
  // failures are already caught by the request handler).
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  // A TRULY uncaught exception, however, means Node can no longer guarantee this process's
  // invariants — but /healthz would keep returning 200, so Kubernetes would keep routing
  // traffic to a corrupted pod. Crash so the kubelet restarts it. (Request-level errors are
  // caught in the handler and never reach here.)
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception — terminating so Kubernetes restarts the pod:", err);
    process.exit(1);
  });

  // Load .env files (Next.js does this in next start, but we're standalone)
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  } catch {
    // @next/env may not be available — .env files won't be loaded automatically
  }

  // Initialize Next.js runtime BEFORE anything else
  await ensureNextNodeEnvironment();
  const poolName = process.env.POOL_NAME;
  if (!poolName) throw new Error("POOL_NAME environment variable is required");

  const buildId = process.env.NEXT_BUILD_ID;
  if (!buildId) throw new Error("NEXT_BUILD_ID environment variable is required");

  // Install the Valkey-backed `use cache` handler BEFORE any app module (and therefore Next's
  // one-time cache-handler initialization) loads, so cache components / PPR `use cache` entries
  // are shared across replicas with cross-replica tag revalidation. Gated on the injected
  // connection URL; when absent the app falls back to Next's default in-process handler.
  const valkeyUrl = process.env.VALKEY_URL;
  let valkeyHandler: ReturnType<typeof registerValkeyCacheHandler> | undefined;
  if (valkeyUrl) {
    valkeyHandler = registerValkeyCacheHandler({
      url: valkeyUrl,
      buildId,
      ...(process.env.VALKEY_AUTH ? { password: process.env.VALKEY_AUTH } : {}),
      ...(process.env.VALKEY_CA_CERT ? { caCert: process.env.VALKEY_CA_CERT } : {}),
    });
    console.log("[pool-server] Valkey use-cache handler registered (build " + buildId + ")");
  }

  // `instrumentation.js` register(), awaited before anything is served — see
  // registerInstrumentationHook. Placed here deliberately: AFTER the node-env shims and the
  // cache-handler install (both must precede any app module, and the hook IS app code), and
  // BEFORE the HTTP server is created, so a hook that patches `node:http` or installs a
  // tracer provider sees a clean process. That is a strictly stronger ordering guarantee
  // than `next start`, which binds the port first and queues arriving requests.
  await registerInstrumentationHook();

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const releaseName = process.env.RELEASE_NAME ?? "nextjs";
  const configDir = process.env.CONFIG_DIR ?? "/config";

  // Load pool manifest (mounted as ConfigMap or baked into container)
  const poolManifestPath = path.join(configDir, `pool-manifest-${poolName}.json`);
  if (!existsSync(poolManifestPath)) {
    throw new Error(`Pool manifest not found: ${poolManifestPath}`);
  }
  const poolManifest: PoolManifest = JSON.parse(readFileSync(poolManifestPath, "utf-8"));

  // Load routing manifest (for local route resolution in Phase 1)
  const routingManifestPath = path.join(configDir, "routing-manifest.json");
  if (!existsSync(routingManifestPath)) {
    throw new Error(`Routing manifest not found: ${routingManifestPath}`);
  }
  const routingManifest: RoutingManifest = JSON.parse(readFileSync(routingManifestPath, "utf-8"));

  // Load static assets manifest
  const staticAssetsPath = path.join(configDir, "static-assets.json");
  const staticAssets: StaticAssetEntry[] = existsSync(staticAssetsPath)
    ? JSON.parse(readFileSync(staticAssetsPath, "utf-8"))
    : [];
  // Whether dispatch's static-manifest lookup would find this pathname (a SUBSET of
  // dispatch's own candidates — exact, trailing-slash variant, and the "/index" root
  // alias — so `true` here guarantees dispatch finds an entry). Public files now live
  // in the manifest (see emit/static-assets.ts), so a covered pathname must flow
  // through dispatcher.dispatch, which merges the resolved routing verdict; the disk
  // fallback (servePublicFileFromDisk) is reserved for pathnames this returns false for.
  const staticManifestCovers = (pathname: string): boolean =>
    staticAssets.some(
      (a) =>
        a.pathname === pathname ||
        a.pathname === (pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/") ||
        (pathname === "/" && a.pathname === "/index"),
    );

  // Allowlist for external /_next/image sources (SSRF guard).
  const imageConfig = loadImageConfig(process.cwd());

  // A path-based assetPrefix (e.g. "/assets") prefixes `_next/static` URLs; strip it so those
  // requests are served/404'd like un-prefixed ones. (URL assetPrefixes point at a separate host,
  // so those requests never reach the pool.)
  let assetPrefix = "";
  try {
    const rsf = JSON.parse(
      readFileSync(path.join(process.cwd(), ".next", "required-server-files.json"), "utf-8"),
    );
    const ap = String(rsf?.config?.assetPrefix ?? "");
    if (ap.startsWith("/")) assetPrefix = ap.replace(/\/$/, "");
  } catch {
    // no assetPrefix
  }

  // Set preview/draft mode env vars from prerender manifest.
  // The web adapter reads these via getEdgePreviewProps() — without them,
  // middleware invocation crashes with "previewProps missing previewModeId".
  // Also collect strict (fallback: false / dynamicParams: false) dynamic routes:
  // a request matching such a route's regex but NOT in the prerendered set must
  // 404, mirroring `next start` — our loopback handler invocation doesn't
  // reproduce that check on its own.
  const prerenderManifestPath = path.join(process.cwd(), ".next", "prerender-manifest.json");
  const strictDynamicRoutes: { pageRegex: RegExp }[] = [];
  const prerenderedPaths = new Set<string>();
  if (existsSync(prerenderManifestPath)) {
    try {
      const prerenderManifest = JSON.parse(readFileSync(prerenderManifestPath, "utf-8"));
      const preview = prerenderManifest.preview;
      if (preview) {
        if (preview.previewModeId) process.env.__NEXT_PREVIEW_MODE_ID = preview.previewModeId;
        if (preview.previewModeSigningKey)
          process.env.__NEXT_PREVIEW_MODE_SIGNING_KEY = preview.previewModeSigningKey;
        if (preview.previewModeEncryptionKey)
          process.env.__NEXT_PREVIEW_MODE_ENCRYPTION_KEY = preview.previewModeEncryptionKey;
      }
      // i18n prerender routes are locale-prefixed (/en/blog/x) while the
      // strict-route regex and default-locale requests are unprefixed — store
      // both forms so a generated path is recognized regardless of prefixing.
      const i18nLocales = (routingManifest.i18n as { locales?: string[] } | null)?.locales ?? [];
      for (const p of Object.keys(prerenderManifest.routes ?? {})) {
        prerenderedPaths.add(p);
        const seg = p.split("/", 2)[1]?.toLowerCase();
        if (seg && i18nLocales.some((l) => l.toLowerCase() === seg)) {
          prerenderedPaths.add(p.slice(seg.length + 1) || "/");
        }
      }
      for (const [, route] of Object.entries<Record<string, unknown>>(
        prerenderManifest.dynamicRoutes ?? {},
      )) {
        if (route.fallback === false && typeof route.routeRegex === "string") {
          strictDynamicRoutes.push({
            pageRegex: new RegExp(route.routeRegex),
          });
        }
      }
    } catch {
      // Non-fatal — draft mode just won't work
    }
  }

  // Load the middleware manifest — contains edge function names, files, and assets.
  // This is used by the edge sandbox to find the right _ENTRIES key.
  const middlewareManifestPath = path.join(
    process.cwd(),
    ".next",
    "server",
    "middleware-manifest.json",
  );
  const middlewareManifest: {
    middleware: Record<
      string,
      {
        name: string;
        files: string[];
        wasm?: any[];
        assets?: any[];
        matchers?: MiddlewareMatcher[];
      }
    >;
    functions: Record<string, { name: string; files: string[]; wasm?: any[]; assets?: any[] }>;
  } = existsSync(middlewareManifestPath)
    ? JSON.parse(readFileSync(middlewareManifestPath, "utf-8"))
    : { middleware: {}, functions: {} };

  // Initialize edge sandbox (shared by edge middleware + edge route handlers)
  let edgeSandboxRun:
    | ((params: any) => Promise<{ response: Response; waitUntil: Promise<void> }>)
    | null = null;
  const distDir = path.join(process.cwd(), ".next");
  try {
    const { createRequire: cr } = await import("node:module");
    const appReq = cr(path.join(process.cwd(), "package.json"));
    const sandbox = appReq("next/dist/server/web/sandbox") as {
      run: (params: any) => Promise<{ response: Response; waitUntil: Promise<void> }>;
    };
    edgeSandboxRun = (params) =>
      sandbox.run({
        ...params,
        useCache: true,
        distDir,
        // Match NextNodeServer.runEdgeFunction: Node entrypoints publish their
        // request-scoped IncrementalCache on globalThis, and every edge sandbox
        // must receive that shared instance. Without it each edge function
        // creates an isolated cache, so fetch/unstable_cache entries never
        // survive across routes and edge revalidateTag/revalidatePath cannot
        // invalidate the Node-rendered page cache.
        incrementalCache:
          params.incrementalCache ??
          (globalThis as typeof globalThis & { __incrementalCache?: unknown }).__incrementalCache,
        clientAssetToken: "",
      });
    console.log("Edge sandbox initialized");
  } catch {
    // Edge sandbox not available
  }

  // The edge sandbox loads an entry's WASM/asset bindings by their `filePath`, but the middleware
  // manifest stores those relative to distDir — and the sandbox resolves them against the pool's
  // CWD, not .next/. Left relative, `next/og`'s yoga/resvg WASM fails with ENOENT and the handler
  // 500s. Absolutize the binding paths so they're found.
  const resolveEdgeEntryAssets = <T extends { wasm?: unknown[]; assets?: unknown[] }>(
    entry: T,
  ): T => {
    const abs = (arr?: unknown[]): unknown[] =>
      (arr ?? []).map((b) => {
        const binding = b as { filePath?: string };
        return binding?.filePath
          ? { ...binding, filePath: path.join(distDir, binding.filePath) }
          : b;
      });
    return { ...entry, wasm: abs(entry.wasm), assets: abs(entry.assets) };
  };

  // App-scoped next/dist/server/body-streams#getCloneableBody. Both the edge
  // sandbox (sandbox.run reads request.body.cloneBodyStream()) and the node
  // middleware web adapter require a POST body to be a CloneableBody, not a raw
  // stream. Resolve from the app's next so the representation matches its
  // runtime. Without this, middleware invocation threw on every body request —
  // previously masked by fail-open (middleware silently skipped), now surfaced.
  let getCloneableBody: ((readable: unknown) => unknown) | null = null;
  try {
    const appReq2 = createRequire(path.join(process.cwd(), "package.json"));
    const bodyStreams = appReq2("next/dist/server/body-streams") as {
      getCloneableBody?: (readable: unknown) => unknown;
    };
    getCloneableBody = bodyStreams.getCloneableBody ?? null;
  } catch {
    console.warn(
      "[pool-server] getCloneableBody unavailable — middleware may not run on POST bodies",
    );
  }
  // Wrap a body (Buffer | web ReadableStream | undefined) as a CloneableBody.
  const wrapCloneableBody = (body: Buffer | ReadableStream<Uint8Array> | undefined): unknown => {
    if (!body || !getCloneableBody) return body;
    const { Readable } = require("node:stream") as typeof import("node:stream");
    const nodeReadable = Buffer.isBuffer(body)
      ? Readable.from(body)
      : Readable.fromWeb(body as import("node:stream/web").ReadableStream);
    return getCloneableBody(nodeReadable);
  };

  // Optionally load middleware module
  let middlewareModule = null;
  let edgeMiddlewareRunner:
    | ((ctx: {
        url: URL;
        headers: Headers;
        method: string;
        body?: ReadableStream<Uint8Array>;
      }) => Promise<Response | null>)
    | null = null;
  // Load a compiled middleware module, resolving the top-level-await wrapper.
  // When middleware source has a top-level await, Next compiles module.exports
  // as a Promise of the real exports. import() surfaces that Promise as the
  // default export; without awaiting it, path detection finds no middleware
  // function and the middleware silently no-ops (every request bypasses it).
  const resolveMiddlewareModule = async (mwPath: string) => {
    const mod = await import(pathToFileURL(mwPath).href);
    if (mod?.default && typeof (mod.default as { then?: unknown }).then === "function") {
      return await (mod.default as Promise<Record<string, unknown>>);
    }
    return mod;
  };

  if (routingManifest.middleware) {
    const mwPath = path.resolve(process.cwd(), routingManifest.middleware.filePath);
    const isEdge = routingManifest.middleware.runtime === "edge";
    // Find edge middleware info from the middleware manifest
    const mwManifestEntry = Object.values(middlewareManifest.middleware)[0];

    if (!existsSync(mwPath)) {
      throw new Error(
        `Configured middleware not found at ${mwPath}. Refusing to start the pool: ` +
          `serving without it would bypass the application's middleware policy.`,
      );
    } else if (isEdge && edgeSandboxRun && mwManifestEntry) {
      // Edge middleware: use the sandbox with the correct name/files from the manifest
      const mwName = mwManifestEntry.name;
      const mwFiles = mwManifestEntry.files.map((f: string) => path.join(distDir, f));
      edgeMiddlewareRunner = async (ctx) => {
        const headerObj: Record<string, string> = {};
        for (const [k, v] of ctx.headers.entries()) {
          if (!k.startsWith(":")) headerObj[k] = v;
        }
        const result = await edgeSandboxRun!({
          name: mwName,
          paths: mwFiles,
          request: {
            url: ctx.url.toString(),
            method: ctx.method,
            headers: headerObj,
            body:
              ctx.method !== "GET" && ctx.method !== "HEAD"
                ? wrapCloneableBody(ctx.body)
                : undefined,
            // Next's web adapter builds request.nextUrl from this — without it,
            // locale/basePath prefixes aren't stripped and middleware pathname
            // checks silently never match.
            nextConfig: manifestNextConfig(routingManifest),
          },
          edgeFunctionEntry: resolveEdgeEntryAssets(mwManifestEntry),
        });
        // Keep the middleware invocation alive through after()/cache side effects. The routing
        // verdict is already available, but returning before this promise settles lets a platform
        // terminate the request context and lose the work. This is lifecycle ownership, not cache
        // storage: Valkey remains the shared middle cache in production.
        await result.waitUntil?.catch((error) => {
          console.error("[pool-server] edge middleware background work failed:", error);
        });
        return result.response;
      };
      console.log(`Edge middleware sandbox ready (name=${mwName}, files=${mwFiles.length})`);
    } else if (isEdge) {
      console.warn(
        "Edge middleware found but sandbox not available, falling back to Node.js loading",
      );
      middlewareModule = await resolveMiddlewareModule(mwPath);
      console.log("Middleware module loaded (Node.js fallback)");
    } else {
      middlewareModule = await resolveMiddlewareModule(mwPath);
      console.log("Middleware module loaded");
    }

    if (!edgeMiddlewareRunner && !hasCallableMiddlewareExport(middlewareModule)) {
      throw new Error(
        `Configured middleware at ${mwPath} has no callable export. Refusing to start the pool.`,
      );
    }
  }

  // Edge route runner — uses the middleware manifest's `functions` to get the correct
  // name and files for each edge-compiled route handler.
  let edgeRouteRunner:
    | ((params: any) => Promise<{ response: Response; waitUntil: Promise<void> }>)
    | null = null;
  if (edgeSandboxRun && Object.keys(middlewareManifest.functions).length > 0) {
    const lookupEdgeFunction = createEdgeFunctionLookup(middlewareManifest.functions);

    edgeRouteRunner = (params) => {
      // Look up the edge function in the manifest by pathname. Pages-router
      // entries are keyed by the bare pathname; app-router pages/route handlers
      // are keyed "<pathname>/page" / "<pathname>/route". RSC output ids
      // (.rsc / segment payloads) map to their parent page's edge function —
      // the rsc request headers drive flight-payload negotiation.
      const rsc = getRscConfig(routingManifest);
      let fnEntry;
      for (const name of [params.name, ...rscParentCandidates(params.name, rsc)]) {
        const base = name === "/" ? "" : name;
        fnEntry =
          lookupEdgeFunction(name) ??
          lookupEdgeFunction(`${base}/page`) ??
          lookupEdgeFunction(`${base}/route`);
        if (fnEntry) break;
      }
      if (!fnEntry) {
        throw new Error(`Edge function not found in middleware-manifest.json: ${params.name}`);
      }
      return edgeSandboxRun!({
        ...params,
        name: fnEntry.name,
        paths: fnEntry.files.map((f: string) => path.join(distDir, f)),
        edgeFunctionEntry: resolveEdgeEntryAssets(fnEntry),
        request: {
          nextConfig: manifestNextConfig(routingManifest),
          ...params.request,
          // The sandbox reads request.body via .cloneBodyStream() — wrap the
          // (possibly Buffer) body as a CloneableBody. undefined passes through.
          ...(params.request?.body !== undefined
            ? { body: wrapCloneableBody(params.request.body) }
            : {}),
        },
      });
    };
    console.log(
      `Edge route runner ready (${Object.keys(middlewareManifest.functions).length} functions)`,
    );
  }

  const handlerLoader = createHandlerLoader(poolManifest);
  // Middleware matchers (source regexp + has/missing) gate whether middleware runs — and,
  // downstream, whether a route is forced `no-cache` for the CDN. Read them from the ADAPTER's
  // routing manifest (built from the build's `outputs.middleware.config.matchers`), NOT Next's
  // `middleware-manifest.json`: the latter only holds EDGE middleware and is EMPTY for a
  // Node-runtime `proxy.ts`, which left middlewareMatchers `undefined` → matchesMiddleware
  // fail-broad-covered EVERY request (incl. `_next/static`) → every response forced `no-cache`
  // → the CDN cached nothing. The routing manifest carries matchers for both node and edge.
  const middlewareMatchers: MiddlewareMatcher[] | undefined = routingManifest.middleware?.matchers;

  const internalSecret = process.env.INTERNAL_HEADER_SECRET || undefined;
  routingManifest.pathnames = [
    ...new Set([...routingManifest.pathnames, ...collectPublicPathnames(process.cwd())]),
  ].sort();
  const resolver = createLocalResolver(
    routingManifest,
    middlewareModule,
    edgeMiddlewareRunner,
    getCloneableBody,
    middlewareMatchers,
  );
  const appRequire = createRequire(path.join(process.cwd(), "package.json"));
  const { createRequestResponseMocks } = appRequire("next/dist/server/lib/mock-request") as {
    createRequestResponseMocks(options: {
      url: string;
      headers: Record<string, string | string[]>;
    }): {
      req: unknown;
      res: {
        statusCode: number;
        hasStreamed: Promise<unknown>;
        getHeader(name: string): string | string[] | number | undefined;
      };
    };
  };
  let handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  const revalidate = async ({
    urlPath,
    headers,
    opts,
  }: {
    urlPath: string;
    headers: Record<string, string | string[]>;
    opts: { unstable_onlyGenerated?: boolean };
  }): Promise<void> => {
    const mocked = createRequestResponseMocks({
      url: urlPath,
      headers: { host: "127.0.0.1", ...headers },
    });
    await handleRequest(
      mocked.req as unknown as IncomingMessage,
      mocked.res as unknown as ServerResponse,
    );
    await mocked.res.hasStreamed;

    const cacheHeader = mocked.res.getHeader("x-nextjs-cache");
    if (
      cacheHeader !== "REVALIDATED" &&
      mocked.res.statusCode !== 200 &&
      !(mocked.res.statusCode === 404 && opts.unstable_onlyGenerated)
    ) {
      throw new Error(`Invalid revalidate response ${mocked.res.statusCode} for ${urlPath}`);
    }
  };
  // Next's local deploy-test harness (NEXT_ENABLE_ADAPTER=1) has neither Cloud CDN nor Valkey, so
  // it stands in Next's built-in filesystem cache for the platform cache and expects `next start`
  // response headers. This is E2E-only and MUST NOT be true in a real deployment — the second guard
  // (no VALKEY_URL) ensures production, which always sets it, never takes these branches. Single
  // source of truth so the three safety-critical flags below can never diverge.
  const emulateNextServer =
    process.env.NEXT_ENABLE_ADAPTER === "1" && process.env.VALKEY_URL === undefined;
  // Build-pinned RSC negotiation config (header name + output suffixes). Hoisted so the N18
  // `_rsc` validation below reads the SAME header names the dispatcher negotiates on — an app
  // with a custom RSC header must not silently skip the check.
  const poolRscConfig = getRscConfig(routingManifest);
  const dispatcher = createDispatcher({
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName,
    edgeRouteRunner,
    pprRoutes: routingManifest.pprRoutes,
    pprCapableRoutes: routingManifest.pprCapableRoutes,
    rscConfig: poolRscConfig,
    outputIds: Object.keys(poolManifest.outputs),
    strictDynamicRoutes,
    prerenderedPaths,
    buildIdForData: buildId,
    internalSecret,
    basePath: routingManifest.basePath ?? "",
    i18nLocales: (routingManifest.i18n as { locales?: string[] } | null)?.locales ?? [],
    // Build timestamp anchoring the ISR seed-freshness window. Newer adapters write it
    // into the routing manifest; read defensively — older manifests (and any build
    // without it) fall back to pod-start anchoring inside the dispatcher.
    builtAt: (routingManifest as { builtAt?: string }).builtAt,
    revalidate,
    incrementalCacheShared: hasRegisteredCacheHandler(process.cwd()),
    // NEXT_ENABLE_ADAPTER is set by Next's local deploy-test harness. That harness has neither
    // Cloud CDN nor Valkey, so let Next's built-in filesystem incremental cache stand in for the
    // platform PPR-shell cache and exercise shell upgrades/RDC end to end. Production deliberately
    // does NOT take this branch: cache entries that are unsafe for Cloud CDN belong in Valkey via
    // the registered cacheHandler, never in process-local memory or an ephemeral pod filesystem.
    entrypointOwnsPprShell: emulateNextServer,
    // Explicit E2E-only stand-in for classic Pages fallback:true cache orchestration: serve the
    // build shell on the first miss, then let Next's filesystem cache return the materialized page.
    // NEVER use this with Valkey or in production; shared cache state cannot live in one pod.
    emulatePlatformCache: emulateNextServer,
    // Only used when no classic incremental handler is registered (e.g. edge-middleware apps): lets
    // revalidateTag invalidate a PPR shell by checking its baked tags against the shared manifest.
    ...(valkeyHandler
      ? {
          checkShellStale: (tags: string[]) =>
            valkeyHandler!.getExpiration(tags).then((e) => e > 0),
        }
      : {}),
  });

  // In GKE, the pool server is behind the ALB — the routing extension sets internal dispatch
  // headers and authenticates them with a shared secret (INTERNAL_HEADER_SECRET, injected from
  // a Secret). When the secret is set the pool trusts dispatch headers only if it matches;
  // TRUST_INTERNAL_HEADERS is the legacy no-secret fallback (still used by some test paths).
  const trustInternalHeaders = process.env.TRUST_INTERNAL_HEADERS === "1";

  handleRequest = async (req, res) => {
    let url: URL;
    try {
      // N10 (SECURITY): the authority must come from Host, never from the request target.
      // `new URL("//evil.example/x", base)` read the target as protocol-relative — it parsed
      // with host `evil.example`, so the pool served `/x` under the key `//evil.example/x`
      // (CDN key/content confusion) and emitted `Location: http://evil.example/x` for any
      // rule redirect (open redirect) — and threw outright for a bare `//`, which became a
      // 400 where `next start` 308s to `/`. parseRequestUrl splices the target after a
      // VALIDATED authority, so `//…` stays a path and collapseSlashesRedirect normalizes it.
      url = parseRequestUrl(req.url ?? "/", req.headers.host);
    } catch {
      // A malformed Host header (or absolute-form request-target) must not become a
      // 500 — it's the client's own protocol error.
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }

    // When middleware's `matcher` covers this path, it must run BEFORE the
    // filesystem fast paths — Next runs middleware for matched static/public
    // requests (e.g. a matcher on `/file.svg` or `/_next/static/css/:path*`).
    // The catch-all matcher excludes /_next/, so normal middleware still lets
    // static assets fast-path. Skip the fast paths in that case and let
    // resolve() run middleware.
    const mwReqHeaders = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") mwReqHeaders.set(k, v);
      else if (Array.isArray(v)) mwReqHeaders.set(k, v.join(", "));
    }
    const middlewareCovers =
      !!(middlewareModule || edgeMiddlewareRunner) &&
      matchesMiddleware(middlewareMatchers, url, mwReqHeaders);

    // next.config headers() + middleware response headers, serialized by the routing
    // extension (secret-gated: server.ts already stripped the header unless the request
    // proved trust). Parsed ONCE here — the forced cache-policy wrapper below must see an
    // explicit app-owned cache-control before any response is written, and the Phase-2
    // dispatch reuses the same parse. Deleted immediately so it can never leak to handlers.
    const extResolvedHeaders = parseResolvedHeaders(
      req.headers["x-resolved-headers"] as string | undefined,
    );
    delete req.headers["x-resolved-headers"];

    // The explicit app-owned cache-control for this request, if any: from the routing
    // extension's resolved verdict (Phase 2, above) or from local resolution (Phase 1
    // fills this in after resolve()). The forced-cache wrapper reads it lazily at
    // writeHead time — every response write happens after the owning phase populated it.
    let appCacheControl: string | null = extResolvedHeaders?.get("cache-control") ?? null;

    // Force the CDN caching verdict for three kinds of request (anything else keeps its origin
    // Cache-Control):
    //   • PPR routes stream a per-request dynamic resume onto the shell, so the response must
    //     never be edge-cached — `no-store`. Chunked encoding alone does NOT stop Cloud CDN
    //     from caching (proven), so this override is required. The routing service marks these
    //     with the trusted internal `x-nextjs-ppr` dispatch header.
    //   • Middleware-matched routes must reach the ext_proc extension every request (the
    //     verdict can change), so they must revalidate — `no-cache` (App Hosting model).
    //   • N18 (SECURITY) RSC requests whose `_rsc` cache-busting param does not authenticate
    //     their RSC headers — `no-store`. THE POOL IS THE RIGHT TIER for this, deliberately:
    //     it is the only one every request reaches (invariant #1: a request arriving without
    //     trusted dispatch headers is fully re-resolved here) AND the only one that owns the
    //     response's Cache-Control and Cache-Tag. The ext_proc routing service is post-cache on
    //     GXLB (docs/superpowers/plans/gcp-edge-compute-cdn-findings.md — the same ordering fact
    //     `forcedCdnCacheControl`'s middleware rule exists for), and it never sees a Phase-1
    //     request at all, so a check there alone would leave the invariant unenforced. It DOES
    //     cover its own immediate responses (middleware-authored bodies and rule redirects never
    //     touch a pool) — see routing-service/handler.ts.
    //     Restricted to GET/HEAD: no other method's response is shared-cacheable, and leaving
    //     POST alone keeps server actions (which carry router state headers) untouched.
    // `no-store` wins when a request falls into more than one of these.
    const rscHeadersUnvalidated =
      (req.method === "GET" || req.method === "HEAD") &&
      rscCacheBustingUnvalidated({
        header: (name) => req.headers[name],
        searchParams: url.searchParams,
        rsc: poolRscConfig,
      });
    const isPprRoute = req.headers["x-nextjs-ppr"] === "1";
    const forcedCacheControl = forcedCdnCacheControl({
      isPprRoute,
      middlewareCovers,
      emulateNextServer,
      rscHeadersUnvalidated,
    });
    if (forcedCacheControl) {
      const originalWriteHead = res.writeHead.bind(res);
      // Cache-control values seen BEFORE a later wrapper rewrote the headers argument.
      // dispatch's resolved-header merge stacks OVER this wrapper and MUTATES the
      // argument in place (replacing the serve site's cache-control with the resolved
      // value) — so by the time forceCacheControl runs, a handler's own `no-store` has
      // already been overwritten there. The writeHead setter below prefixes every
      // later-stacked wrapper with a recorder that snapshots the serve site's values
      // first; the never-weaken-`no-store` rule depends on this record.
      const preMergeCacheControls: string[] = [];
      const forceWriteHead = function forceCacheControl(...args: unknown[]) {
        // An EXPLICIT app-owned cache-control (next.config headers() / middleware response
        // headers, carried by the resolved routing verdict) overrides the middleware-matched
        // `no-cache` default — the app took ownership of the cache decision, matching
        // `next start`, which serves the headers() value on matched responses.
        // explicitCacheControlWins pins the precedence: never for the PPR `no-store`
        // verdict, and never weakening a response that itself declares `no-store`.
        if (
          explicitCacheControlWins({
            forced: forcedCacheControl,
            resolvedCacheControl: appCacheControl,
            responseCacheControls: [...preMergeCacheControls, ...observedCacheControls(args, res)],
          })
        ) {
          // dispatch's resolved-header merge only rewrites a headers ARGUMENT — a serve
          // site that used setHeader (or passed no headers arg) still needs the explicit
          // value stamped. And the CDN cache tag must be reconciled with the EFFECTIVE
          // cache-control (M13 rule: mutable cacheable ⇒ deploy-tagged so cutover can
          // invalidate it; uncacheable ⇒ never tagged): strip any tag a serve site
          // stamped from its pre-merge default, then re-derive from the app value.
          for (let i = 1; i < args.length; i++) {
            const arg = args[i];
            if (arg && typeof arg === "object") {
              args[i] = filterWriteHeadHeadersArg(
                arg,
                (name) => name.toLowerCase() === "cache-tag",
              );
            }
          }
          res.removeHeader("cache-tag");
          res.setHeader("cache-control", appCacheControl!);
          const reconciledTag = cdnCacheTag(appCacheControl!, buildId)["cache-tag"];
          if (reconciledTag) res.setHeader("cache-tag", reconciledTag);
          return originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
        }
        // forcedCacheControl is always no-cache/no-store (uncacheable), so a serve site's
        // preliminary cache-control AND its CDN cache-tag are both moot — strip both, so a
        // tag never lands on a response the CDN won't cache (the final-Cache-Control rule).
        // The headers argument may be an object, a tuple array, or a FLAT array
        // ([name1, value1, …]) — filterWriteHeadHeadersArg handles every shape Node
        // accepts (a tuple-only filter let the flat form sail past).
        for (let i = 1; i < args.length; i++) {
          const arg = args[i];
          if (arg && typeof arg === "object") {
            args[i] = filterWriteHeadHeadersArg(arg, (name) =>
              ["cache-control", "cache-tag"].includes(name.toLowerCase()),
            );
          }
        }
        res.removeHeader("cache-tag");
        res.setHeader("cache-control", forcedCacheControl);
        return originalWriteHead(...(args as Parameters<typeof originalWriteHead>));
      } as typeof res.writeHead;
      // Accessor instead of a plain assignment: later wrappers install themselves with
      // `res.writeHead = wrapped(res.writeHead.bind(res))` (dispatch's resolved-header
      // merge does exactly this), and the merge mutates the headers argument before this
      // wrapper can read it. The setter re-wraps anything stacked later with the
      // pre-merge cache-control recorder; the getter keeps normal stacking intact.
      let stackedWriteHead: typeof res.writeHead = forceWriteHead;
      Object.defineProperty(res, "writeHead", {
        configurable: true,
        get() {
          return stackedWriteHead;
        },
        set(next: typeof res.writeHead) {
          stackedWriteHead = function recordPreMergeCacheControls(...args: unknown[]) {
            preMergeCacheControls.push(...observedCacheControls(args, res));
            return (next as (...a: unknown[]) => ServerResponse).apply(res, args);
          } as typeof res.writeHead;
        },
      });
    }

    // Serve _next/static/* and _next/data/* directly from filesystem.
    // In production, CDN handles these. In standalone/emulate mode, the pool server must serve them.
    const staticPathname =
      assetPrefix && url.pathname.startsWith(assetPrefix + "/_next/static/")
        ? url.pathname.slice(assetPrefix.length)
        : url.pathname;
    if (!middlewareCovers && staticPathname.startsWith("/_next/static/")) {
      const filePath = path.join(
        process.cwd(),
        ".next",
        "static",
        staticPathname.slice("/_next/static/".length),
      );
      if (existsSync(filePath)) {
        const content = readFileSync(filePath);
        // Mirror Next's own server: service workers are revalidated (not immutable) and get
        // Service-Worker-Allowed; every other _next/static asset is immutable.
        const { cacheControl, headers } = nextStaticAssetHeaders(
          staticPathname,
          routingManifest.basePath ?? "",
        );
        const etag = staticAssetEtag(content);
        const responseHeaders = {
          "content-type": getContentType(staticPathname),
          "cache-control": cacheControl,
          etag,
          ...(headers ?? {}),
        };
        if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
          res.writeHead(304, responseHeaders);
          res.end();
          return;
        }
        res.writeHead(200, responseHeaders);
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      // A missing `/_next/static/*` asset is a plain 404 — these paths are never app routes, so
      // don't fall through to render the app's (HTML) 404 page. Matches Next's own router-server.
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    // Pages Router SSG data routes: /_next/data/<buildId>/<page>.json.
    // SSG data JSONs exist only in the build output (no manifest entry), so
    // serve them from disk — but only when no pool output owns the data
    // pathname: GSSP and ISR pages have function outputs keyed by their data
    // URL, and those must go through dispatch so the handler (and its
    // incremental cache) produces the payload.
    const basePath = routingManifest.basePath ?? "";
    const dataPrefix = `${basePath}/_next/data/${buildId}/`;
    let pagesDataRoutingUrl: URL | undefined;
    if (!middlewareCovers && url.pathname.startsWith(dataPrefix)) {
      const dataPath = url.pathname.slice(dataPrefix.length);
      // Map the data URL to its page: /_next/data/<id>/en/blog/x.json → /en/blog/x
      const pagePathWithoutBase = "/" + dataPath.replace(/\.json$/, "");
      const pagePath =
        pagePathWithoutBase === "/index" ? basePath || "/" : `${basePath}${pagePathWithoutBase}`;
      const owned =
        handlerLoader.has(url.pathname) ||
        handlerLoader.has(pagePath) ||
        templateOutputCandidates(pagePath, Object.keys(poolManifest.outputs)).some((t) =>
          handlerLoader.has(t),
        );
      // GSSP/ISR data is owned by a handler (and its incremental cache) —
      // fall through to dispatch for those; serve only truly static SSG data.
      if (!owned) {
        const filePath = path.join(process.cwd(), ".next", "server", "pages", dataPath);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
          });
          res.end(content);
          return;
        }
      } else {
        // Route lookup operates on the public page pathname, while the Pages
        // entrypoint must still observe the original `/_next/data/...` URL so
        // it negotiates JSON. Keep req.url untouched and use this URL only to
        // locate the owning page/dynamic template.
        pagesDataRoutingUrl = new URL(url);
        // N11: with `trailingSlash: true` the page form of a data URL must carry the slash.
        // Next's own add-slash 308 rule (routeGraph.beforeMiddleware) would otherwise fire on
        // the slash-less page path and answer the DATA request with a redirect to the HTML
        // page, breaking client-side navigation. Mirrors prepareRequest's data-URL mapping.
        pagesDataRoutingUrl.pathname =
          routingManifest.trailingSlash && pagePath !== "/" && !pagePath.endsWith("/")
            ? `${pagePath}/`
            : pagePath;
      }
    }

    // Basic image optimization: /_next/image?url=...&w=...&q=...
    // Fetches the source image and serves it (with optimization if Sharp is available).
    if (url.pathname === "/_next/image") {
      const imageUrl = url.searchParams.get("url");

      if (!imageUrl) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Bad Request: missing url parameter");
        return;
      }

      // Validate w/q against Next's resolved image config before they reach Sharp — see
      // validateImageSizeAndQuality for the port and the measurements. Two things ride on
      // this: an unbounded `w` (w=999999) drives Sharp into a huge allocation, and every
      // ACCEPTED (w, q) pair is an additional CDN cache entry plus an additional encode,
      // so the allowed sets are the amplification bound as much as they are parity.
      const params = validateImageSizeAndQuality(url.searchParams, imageConfig);
      if ("errorMessage" in params) {
        res.writeHead(400, { "content-type": "text/plain" });
        // Byte-for-byte the body `next start` sends. (It sends no Content-Type at all on
        // these 400s; text/plain is kept here so a browser can't sniff the message.)
        res.end(params.errorMessage);
        return;
      }
      const { width, quality } = params;
      // Reject self-referential optimizer URLs (…?url=/_next/image…): they loop back into
      // this handler and recurse until the pod exhausts sockets/memory.
      if (imageUrl.split("?")[0] === "/_next/image") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Bad Request: recursive image url");
        return;
      }

      try {
        // Resolve the image: internal (relative) or external (absolute URL)
        let imageBuffer: Buffer;
        let contentType: string;
        let selfFetchContentType: string | null = null;
        // The upstream's own Cache-Control, when there is an upstream (a route-served or
        // external image). Next raises the response's max-age to it when it asks for
        // longer than images.minimumCacheTTL.
        let upstreamCacheControl: string | null = null;
        // Next's `isStatic`: a build-emitted, content-addressed source under
        // /_next/static/**/media is immutable, so the optimized derivative is too.
        let isStaticSource = false;

        if (imageUrl.startsWith("/")) {
          // Internal image: read from filesystem. Confine the path to public/ or
          // .next/static/ — a raw `?url=/../../etc/passwd` must not traverse out.
          const decodedImagePath = decodePublicPathname(imageUrl);
          if (decodedImagePath === null) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Bad Request: malformed image path");
            return;
          }
          const publicRoot = path.join(process.cwd(), "public");
          const staticRoot = path.join(process.cwd(), ".next", "static");
          const publicFile = resolveWithinRoot(publicRoot, decodedImagePath);
          const staticFile = decodedImagePath.startsWith("/_next/static/")
            ? resolveWithinRoot(staticRoot, decodedImagePath.slice("/_next/static/".length))
            : null;

          // A null result means the path escaped its root — reject traversal.
          if (
            publicFile === null ||
            (decodedImagePath.startsWith("/_next/static/") && staticFile === null)
          ) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Bad Request: invalid image path");
            return;
          }

          // Matches Next's `isStatic` check (`${basePath}/_next/static/media` and the
          // `immutable/media` variant), evaluated on the DECODED path so an encoded
          // prefix can't claim immutability for a public/ file.
          isStaticSource =
            decodedImagePath.startsWith("/_next/static/media/") ||
            decodedImagePath.startsWith("/_next/static/immutable/media/");

          if (existsSync(publicFile) && !statSync(publicFile).isDirectory()) {
            imageBuffer = readFileSync(publicFile);
          } else if (staticFile && existsSync(staticFile) && !statSync(staticFile).isDirectory()) {
            imageBuffer = readFileSync(staticFile);
          } else {
            // Fetch from ourselves (same-origin relative image, e.g. served by a route).
            // Bound it: a 5s timeout so a slow/hung origin can't pin the request, and a
            // size cap so an oversized body can't exhaust memory.
            const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
            const selfUrl = `http://127.0.0.1:${port}${imageUrl}`;
            const imgRes = await fetch(selfUrl, {
              signal: AbortSignal.timeout(5000),
              // The EXTERNAL path re-validates every redirect hop against the SSRF
              // allowlist; this loopback fetch has no such machinery. Refuse redirects
              // outright rather than let a same-origin route bounce the optimizer to
              // an unvetted target (or back into the optimizer itself).
              redirect: "manual",
            });
            if (imgRes.status >= 300 && imgRes.status < 400) {
              res.writeHead(502, { "content-type": "text/plain" });
              res.end("Failed to fetch image: redirect not followed");
              return;
            }
            if (!imgRes.ok) {
              res.writeHead(imgRes.status, { "content-type": "text/plain" });
              res.end(`Image not found: ${imageUrl}`);
              return;
            }
            const declaredLen = parseInt(imgRes.headers.get("content-length") ?? "", 10);
            if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
              res.writeHead(413, { "content-type": "text/plain" });
              res.end("Image too large");
              return;
            }
            const streamedBody = await readWebBodyWithLimit(imgRes.body, MAX_IMAGE_BYTES);
            if (streamedBody === null) {
              res.writeHead(413, { "content-type": "text/plain" });
              res.end("Image too large");
              return;
            }
            imageBuffer = streamedBody;
            // A route-served image has no meaningful extension (e.g. /api/tiny-png) —
            // the response's own Content-Type is the fallback, not an extension guess.
            selfFetchContentType = imgRes.headers.get("content-type");
            upstreamCacheControl = imgRes.headers.get("cache-control");
          }
          contentType = selfFetchContentType ?? getContentType(decodedImagePath);
        } else {
          // External image: only fetch allowlisted http(s) hosts, and only after
          // confirming the host resolves to a public address (SSRF / DNS-rebind guard).
          let target: URL;
          try {
            target = new URL(imageUrl);
          } catch {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end("Bad Request: invalid image url");
            return;
          }
          const fetched = await fetchExternalImageSafely(target, imageConfig);
          if ("error" in fetched) {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end(`Bad Request: ${fetched.error}`);
            return;
          }
          if (!fetched.ok) {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end(`Failed to fetch external image: ${imageUrl}`);
            return;
          }
          imageBuffer = fetched.body;
          contentType = fetched.contentType;
          upstreamCacheControl = fetched.cacheControl;
        }

        // `public, max-age=<maxAge>, must-revalidate` — Next's floor is
        // images.minimumCacheTTL (default 14400), raised to the upstream's own max-age
        // when the upstream asks for longer. The previous hardcoded `max-age=60` made
        // every optimizer response effectively uncacheable at the CDN: a 60-second
        // freshness window means the pool re-decodes and re-encodes the same image for
        // essentially every visitor.
        const imageMaxAgeSeconds = imageMaxAge(imageConfig.minimumCacheTTL, upstreamCacheControl);

        // `next start` parity: Next derives the source format from the BYTES
        // (detectContentType), never from the URL or the upstream header — an
        // extensionless route serving a PNG must stay PNG through negotiation
        // (deriving it from the URL re-encoded /api/tiny-png's PNG to JPEG), and the
        // SVG gate below must fire on actual SVG bytes even under a lying name.
        // Where Next 400s an unrecognized signature outright (after a sharp-metadata
        // second guess we don't have), we keep the header/extension fallback — the
        // `image/*` gate immediately below still rejects anything non-image, and the
        // encode path fails closed on bytes sharp can't read.
        const sniffedContentType = detectImageContentType(imageBuffer);
        contentType = sniffedContentType ?? contentType;

        // `next start` parity, and Next's FIRST check: a source that isn't an image at
        // all (a text/html route, a PDF) is a 400 with this exact body — not a 502 from
        // sharp choking on it further down, and never passthrough (serving an HTML body
        // back under its own content type would make /_next/image an XSS channel).
        if (!isOptimizableImageContentType(contentType)) {
          res.writeHead(400, { "content-type": "text/plain" });
          // Byte-for-byte the body `next start` sends for this case.
          res.end("The requested resource isn't a valid image.");
          return;
        }

        // `next start` parity: SVG never goes through the optimizer by default — Next
        // 400s it unless images.dangerouslyAllowSVG is set, and then serves it with
        // Content-Disposition: attachment plus the configured CSP so a crafted SVG
        // can't run script in the site's origin. This gate runs BEFORE any sharp
        // handling: the verdict must not depend on the optimizer being present.
        if (contentType.toLowerCase().includes("svg")) {
          if (!imageConfig.dangerouslyAllowSVG) {
            res.writeHead(400, { "content-type": "text/plain" });
            // Byte-for-byte the body `next start` sends for this case.
            res.end('"url" parameter is valid but image type is not allowed');
            return;
          }
          // The SVG branch is not special-cased for headers any more: `next start` sends
          // the same Content-Disposition/CSP/ETag/Cache-Control set on every optimizer
          // 200, SVG included (the filename now carries the real source name and `.svg`
          // instead of the placeholder `attachment; filename="image"`).
          sendImageResponse(req, res, {
            body: imageBuffer,
            contentType,
            sourceUrl: imageUrl,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
            config: imageConfig,
            buildId,
          });
          return;
        }

        const accept = String(req.headers["accept"] ?? "");
        // Negotiate the output format like Next's optimizer (see image-utils). This runs
        // BEFORE the sharp gate on purpose: Next's BYPASS_TYPES (ICO/BMP/ICNS/JXL/HEIC)
        // and animated sources are returned verbatim and need no optimizer at all —
        // several of them sharp cannot even decode — so requiring sharp here would 503 a
        // request `next start` answers 200. The type driving this decision is byte-sniffed
        // (above), never the URL, so passthrough can't be steered by a lying extension;
        // the ANIMATION decision is likewise made on the bytes.
        const { encode, contentType: outType } = negotiateImageFormat(accept, contentType, {
          formats: imageConfig.formats,
          sourceBytes: imageBuffer,
        });
        if (encode === "passthrough") {
          sendImageResponse(req, res, {
            body: imageBuffer,
            contentType: outType,
            sourceUrl: imageUrl,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
            config: imageConfig,
            buildId,
          });
          return;
        }

        // Optimize with Sharp. A MISSING sharp still fails closed with a 503: it means the
        // image stack is broken (production images always ship sharp), not that unvalidated
        // passthrough is safe. A sharp that loads but cannot DECODE the input falls back to
        // the source bytes — see the catch below, which is where `next start` parity lives
        // and where the safety conditions on that fallback are spelled out.
        const sharp = loadSharpOnce();
        if (!sharp) {
          // The load failure (with its cause) was logged once by loadSharpOnce.
          res.writeHead(503, { "content-type": "text/plain" });
          res.end("Image optimization unavailable");
          return;
        }
        try {
          // Both are already validated against the app's allowed sets (q is 1..100 and in
          // images.qualities; w is one of deviceSizes/imageSizes), so no defaulting here.
          const q = quality;
          // Encoder options mirror Next's `optimizeImage` exactly — they are not cosmetic.
          // Measured on the upstream image-optimizer fixture at w=384/q=75 vs `next start`:
          // a bare `.png()` produced 21319 B where Next produces 5513 B, and `.jpeg()`
          // without mozjpeg 2913 B vs 1989 B. `.rotate()` applies EXIF orientation before
          // the resize (Next does the same, in this order), and `.timeout()` bounds a
          // pathological decode the same 7 seconds Next allows.
          let pipeline = resizeForRequestedWidth(
            sharp(imageBuffer).timeout({ seconds: 7 }).rotate(),
            width,
          );
          switch (encode) {
            case "avif":
              // Next deliberately encodes AVIF 20 quality points lower than the request
              // asks and at effort 3 — AVIF at the same nominal quality is both larger
              // and dramatically slower than WebP.
              pipeline = pipeline.avif({ quality: Math.max(q - 20, 1), effort: 3 });
              break;
            case "webp":
              pipeline = pipeline.webp({ quality: q });
              break;
            case "png":
              pipeline = pipeline.png({ quality: q });
              break;
            case "gif":
              // Reached only for a PROVEN-static GIF whose client negotiated no other
              // format: Next re-encodes it as GIF rather than passing the source through.
              // Upstream sets no encoder at all here (`optimizeImage`'s if-chain covers
              // only avif/webp/png/jpeg) and relies on sharp writing back the input
              // format; `.gif()` is byte-identical for a GIF input — both 1629 B for the
              // fixture's /test.gif at w=384, matching `next start`.
              pipeline = pipeline.gif();
              break;
            case "tiff":
              // Same story as GIF: upstream leaves the encoder unset and sharp writes TIFF
              // back. `.tiff()` reproduces it byte-for-byte (2962 B for /test.tiff at
              // w=384/q=75, exactly `next start`), where the old `default: jpeg` fallthrough
              // silently converted the source to JPEG (1918 B).
              pipeline = pipeline.tiff();
              break;
            default:
              pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
          }
          const optimized = await pipeline.toBuffer();
          sendImageResponse(req, res, {
            body: optimized,
            contentType: outType,
            sourceUrl: imageUrl,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
            config: imageConfig,
            buildId,
          });
        } catch (err) {
          // Sharp loaded but could not process the input. `next start` FALLS BACK to the
          // source bytes here — "If we fail to optimize, fallback to the original image"
          // in imageOptimizer's catch — and that is not a corner case: it is the only way
          // upstream serves a JPEG 2000 at all (sharp/libvips answers "Input buffer
          // contains unsupported image format" for it, and image/jp2 is NOT in
          // BYPASS_TYPES). Measured on the fixture, `?url=/test.jp2&w=384&q=75`:
          // `next start` → 200 image/jp2, 242 B (the upstream bytes); the adapter used to
          // answer 502. The comment that previously sat here claimed upstream had no such
          // path — it was simply wrong about upstream.
          //
          // The fallback removed earlier WAS a real XSS vector, so it comes back with the
          // two conditions that vector needed and this one does not have:
          //   • the type must have been BYTE-SNIFFED (detectImageContentType). Upstream's
          //     `upstreamType` is always byte-derived — a source whose bytes match nothing
          //     is a 400 there — so gating on the sniff is upstream's own semantics, and it
          //     is what keeps an attacker-influenced `Content-Type`/extension guess (an
          //     HTML body from an allowlisted remote host named `.png`) on the 502 path
          //     instead of being echoed back under a type nobody verified.
          //   • it goes through sendImageResponse, so it carries the same
          //     `Content-Disposition: attachment` + images CSP + Vary/ETag set as every
          //     other optimizer 200 (SVG never reaches here at all — the
          //     dangerouslyAllowSVG gate 400s or serves it far above).
          // maxAge is images.minimumCacheTTL, NOT the upstream-raised value: upstream's
          // fallback deliberately ignores a longer upstream max-age (verified — a route
          // serving jp2 with `Cache-Control: public, max-age=99999` still answers
          // `max-age=14400, must-revalidate`, while the same route serving TIFF, which
          // optimizes successfully, answers `max-age=99999`).
          const message = err instanceof Error ? err.message : String(err);
          if (sniffedContentType) {
            // Loud: upstream is silent here, but a pod quietly serving unoptimized
            // originals is exactly the kind of regression that hides for months.
            console.warn(
              `[pool-server] /_next/image could not optimize ${imageUrl} (${contentType}) — ` +
                `serving the source bytes as next start does: ${message}`,
            );
            sendImageResponse(req, res, {
              body: imageBuffer,
              contentType: sniffedContentType,
              sourceUrl: imageUrl,
              isStatic: isStaticSource,
              maxAge: imageConfig.minimumCacheTTL,
              config: imageConfig,
              buildId,
            });
            return;
          }
          // No signature matched, so the only candidate type is the upstream header or the
          // URL's extension — a guess. Upstream 400s this case before sharp ever runs; the
          // adapter keeps the guess for the format decision but refuses to SERVE bytes
          // under it. Log the actual failure: the live 502s for /api/tiny-png were
          // undebuggable without it (the cause turned out to be a broken sharp module, see
          // loadSharpOnce — but a genuinely corrupt input lands here too).
          console.error(
            `[pool-server] /_next/image failed to process ${imageUrl} (${contentType}):`,
            message,
          );
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Failed to process image");
        }
        return;
      } catch (err) {
        console.error("Image optimization error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("Image optimization failed");
        }
        return;
      }
    }

    // public/ files deliberately have NO pre-routing fast path here. They are in the
    // static-assets manifest (see emit/static-assets.ts), so Phase 2 serves them via
    // dispatcher.dispatch and Phase 1 via resolve() → dispatch — both of which merge the
    // resolved routing verdict (next.config headers() / middleware response headers)
    // over the adapter's `public, max-age=3600` + deploy-tag default. A pre-parse disk
    // serve here returned the hardcoded default and silently dropped headers() and
    // middleware headers. servePublicFileFromDisk remains as the last resort for files
    // the manifest missed (both phases, below).

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    }

    let bodyBuffer: Buffer | null;
    try {
      bodyBuffer =
        req.method === "GET" || req.method === "HEAD" ? null : await readRequestBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // readRequestBody deliberately left the socket alive (paused, not destroyed):
        // destroying first turns the 413 into an ECONNRESET the client can't read.
        // Say we're closing, flush the response, and only then tear the socket down
        // so the remainder of the oversized upload can't pin the connection.
        res.writeHead(413, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
        });
        res.end("Payload Too Large");
        // 'finish' never fires if the socket dies first (client gone mid-flush) —
        // listen for 'close' too so the paused oversized upload can't pin the
        // connection. destroy() on an already-destroyed socket is a no-op.
        const teardown = () => {
          if (!req.destroyed) req.destroy();
        };
        res.once("finish", teardown);
        res.once("close", teardown);
        return;
      }
      throw err;
    }
    if (bodyBuffer) {
      // Next.js action-handler checks request meta first when the original
      // Node stream has already been consumed upstream.
      addRequestMeta(req as unknown as Record<PropertyKey, unknown>, "actionBody", bodyBuffer);
    }

    // Opt-in diagnostic only. NEVER log request bodies or router state: Server Action
    // bodies routinely carry credentials, tokens, and PII, and were previously written to
    // production logs on every action. Body length only, and only when explicitly enabled.
    if (
      process.env.ADAPTER_K8S_DEBUG_ACTIONS === "1" &&
      isServerActionRequest(headers, req.method ?? "GET")
    ) {
      console.log("[pool-server] action request", {
        url: url.pathname,
        method: req.method,
        nextAction: headers.get("next-action"),
        rsc: headers.get("rsc"),
        accept: headers.get("accept"),
        nextRouterStateTreeLength: headers.get("next-router-state-tree")?.length ?? 0,
        nextUrl: headers.get("next-url"),
        contentType: headers.get("content-type"),
        contentLength: headers.get("content-length"),
        bodyLength: bodyBuffer?.length ?? 0,
      });
    }

    // Phase 2+: if dispatch headers exist (from route extension), use them directly.
    // These are only present when the request passed the secret check in server.ts (else they
    // were stripped), so they can be trusted here.
    const extOutputId = req.headers["x-output-id"] as string | undefined;
    const extMwEvaluated = req.headers["x-mw-evaluated"] as string | undefined;
    delete req.headers["x-mw-evaluated"];
    // Skip the pool's own middleware ONLY when the trusted upstream POSITIVELY asserts it
    // evaluated the middleware stage (x-mw-evaluated ∈ ran/skip-nomatch/none). x-output-id
    // alone is NOT proof — a broken ext_proc or cross-pool proxy can emit routing headers
    // without having run middleware. Absent / `error` / unrecognized ⇒ fall through to
    // Phase 1 below so the pool evaluates middleware itself. Both headers are secret-gated
    // (untrusted ones were already stripped in server.ts), so this can't be forged.
    if (extOutputId && extMwEvaluated && MW_EVALUATED_TRUSTED.has(extMwEvaluated)) {
      const routeMatchesRaw = req.headers["x-route-matches"] as string | undefined;
      // Secret-gated (trusted) input, but a malformed value from an extension bug should not
      // 500 the request — fall back to no route params rather than throwing.
      let routeMatches: Record<string, string> | null = null;
      if (routeMatchesRaw) {
        try {
          routeMatches = JSON.parse(routeMatchesRaw);
        } catch {
          routeMatches = null;
        }
      }
      const pool = (req.headers["x-upstream-pool"] as string) ?? poolName;

      // Public files flow through dispatch via the static manifest (which merges
      // extResolvedHeaders — parsed and deleted above — into the response). Disk is the
      // LAST resort for a public file the manifest missed: without it a stale/absent
      // static-assets.json would turn the file into a 404 (dispatch has already written
      // its verdict by the time it misses, so this check must come first).
      if (
        !handlerLoader.has(extOutputId) &&
        !staticManifestCovers(extOutputId) &&
        servePublicFileFromDisk(req, res, extOutputId, extResolvedHeaders, buildId)
      ) {
        return;
      }

      // Rewrite invocation target stamped by the routing extension / cross-pool proxy
      // (secret-gated members of INTERNAL_DISPATCH_HEADERS, stripped from untrusted
      // clients in server.ts): the pool supplies the REWRITE TARGET to the generated
      // entrypoint as requestMeta (query / params / resolvedPathname) — the loopback
      // request URL itself stays the PUBLIC one, mirroring Next's base-server, because
      // req.url is what feeds req.url / router.asPath / usePathname. See
      // dispatch.ts invokeLocalHandlerOverHttp. Trusted input, but a malformed query
      // from an extension bug must not 500 the request — the invoker recovers the
      // query from the invocation path itself.
      const extInvokePath = req.headers["x-invoke-path"] as string | undefined;
      let extInvocationQuery: Record<string, string | string[]> | undefined;
      const extInvokeQueryRaw = req.headers["x-invoke-query"] as string | undefined;
      if (extInvokeQueryRaw) {
        try {
          extInvocationQuery = JSON.parse(extInvokeQueryRaw);
        } catch {
          extInvocationQuery = undefined;
        }
      }

      await dispatcher.dispatch(req, res, {
        kind: "route",
        pool,
        matchedPathname: extOutputId, // Use outputId/pathname from header
        routeMatches,
        resolvedHeaders: extResolvedHeaders,
        ...(extInvokePath ? { invokePath: extInvokePath } : {}),
        ...(extInvocationQuery ? { invocationQuery: extInvocationQuery } : {}),
      });
      return;
    }

    // Phase 1: resolve route locally
    const resolution = await resolver.resolve(
      pagesDataRoutingUrl ?? url,
      headers,
      req.method ?? "GET",
      createBufferedStream(bodyBuffer),
    );
    // The explicit app-owned cache-control discovered by local resolution (next.config
    // headers() / middleware response headers) — the forced-cache wrapper reads this at
    // writeHead time, which always happens after this point (Phase 2 populated it from
    // x-resolved-headers instead and returned above).
    if (appCacheControl === null && "resolvedHeaders" in resolution) {
      appCacheControl = resolution.resolvedHeaders?.get("cache-control") ?? null;
    }
    if (resolution.kind === "route" && !handlerLoader.has(resolution.matchedPathname)) {
      const resolvedPathname = resolution.invokePath
        ? new URL(resolution.invokePath, url).pathname
        : resolution.matchedPathname;
      // Manifest-covered pathnames flow through dispatch, which serves the manifest
      // entry and merges resolution.resolvedHeaders over the adapter default. Disk is
      // the LAST resort for a public file the manifest missed (or a rewrite target the
      // manifest can't key) — it applies the same resolved-header merge itself.
      if (
        !staticManifestCovers(resolution.matchedPathname) &&
        servePublicFileFromDisk(req, res, resolvedPathname, resolution.resolvedHeaders, buildId)
      ) {
        return;
      }
    }
    await dispatcher.dispatch(req, res, resolution);
  };

  // Create and start server
  const server = createPoolServer({
    port,
    trustInternalHeaders,
    internalSecret,
    onRequest: handleRequest,
  });

  await server.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down pool server...");
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return server;
}

// Self-run only when executed directly (node dist/pool-server.cjs), never on import
// (tests import startPoolServer). The production bundle is CJS, where require.main
// identifies the entry module; require/module are undefined under the ESM source
// loader (vitest), so the guard is false there even with this module imported.
// (import.meta is intentionally NOT used: esbuild leaves it empty in CJS output.)
const isDirectRun =
  typeof require !== "undefined" && typeof module !== "undefined" && require.main === module;
if (isDirectRun) {
  startPoolServer().catch((err) => {
    console.error("Pool server failed to start:", err);
    process.exit(1);
  });
}
