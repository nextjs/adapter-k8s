// src/pool-server/index.ts
import { createReadStream, readFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { pipeline } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolManifest, RoutingManifest, StaticAssetEntry } from "../types.js";
import {
  getRscConfig,
  INTERNAL_EXECUTION_DEADLINE_HEADER,
  manifestNextConfig,
  middlewareMayCoverPath,
  INTERNAL_DISPATCH_HEADERS,
  MW_EVALUATED_TRUSTED,
  parseRequestUrl,
  rscCacheBustingUnvalidated,
  rscParentCandidates,
  stripBasePath,
  templateOutputCandidates,
  trailingSlashVariants,
  type MiddlewareMatcher,
} from "../routing-common.js";
import { createHandlerLoader } from "./handler-loader.js";
import { collectPublicPathnames } from "./public-files.js";
import { restoreFetchCacheSeed } from "./fetch-cache-seed.js";
import { cdnCacheTag } from "../cdn-tags.js";
import {
  createLocalResolver,
  hasCallableMiddlewareExport,
  resolvePlatformRequest,
  targetsSamePlatformUrl,
} from "./resolve.js";
import {
  applyMiddlewareRequestHeaders,
  createDispatcher,
  getContentType,
  installResolvedResponseHeaders,
  isVerifiedPreviewRequest,
  mergeResolvedHeadersIntoHeadersArg,
} from "./dispatch.js";
import { nextStaticAssetHeaders } from "../static-asset-headers.js";
import {
  ifNoneMatchMatches,
  STATIC_STREAM_THRESHOLD_BYTES,
  staticAssetEtagForFile,
} from "./http-cache.js";
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
  type ImageLocalPattern,
  validateImageSizeAndQuality,
  validateImageUrlParam,
  isOptimizableImageContentType,
  negotiateImageFormat,
  negotiateImageMimeType,
  resizeForRequestedWidth,
} from "./image-utils.js";
import {
  applyRequestTrustBoundary,
  createPoolServer,
  filterWriteHeadHeadersArg,
  LIVENESS_PATH,
  READINESS_PATH,
  type ReadinessState,
} from "./server.js";
import { readWebBodyWithLimit } from "./body-limit.js";
import {
  registerValkeyCacheHandler,
  seedSandboxCacheHandlerRegistry,
} from "./valkey-cache/register.js";
import { createValkeyClient } from "./valkey-cache/client.js";
import { ValkeyIncrementalCacheHandler } from "./valkey-cache/incremental-cache-handler.js";
import { createBuildSeedLookup } from "./valkey-cache/build-seed-index.js";
import {
  createPprRouteMatcher,
  explicitCacheControlWins,
  forcedCdnCacheControl,
} from "./cache-policy.js";

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
//
// N32: the outcome is REPORTED, not merely logged, so `/readyz` can answer 503 for it — "keeps
// answering /healthz while every app route 500s" is precisely the state the blue/green gate used
// to read as a healthy build. "absent" (no hook) and "registrar-missing" (this Next version moved
// the registrar; Next's own lazy per-request path still runs the hook, once) are both serving
// states; only "failed" is not.
type InstrumentationStatus = "ok" | "absent" | "registrar-missing" | "failed";

async function registerInstrumentationHook(): Promise<InstrumentationStatus> {
  // distDir is `.next` everywhere in the pool (staging, manifests, the edge sandbox);
  // upstream passes a project-relative distDir here too.
  const distDir = ".next";
  const cwd = process.cwd();
  // `ensureInstrumentationRegistered` already tolerates a missing hook, but checking first
  // keeps the "no instrumentation" case from depending on error-code sniffing at all.
  if (!existsSync(path.join(cwd, distDir, "server", "instrumentation.js"))) return "absent";

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
    return "registrar-missing";
  }
  if (typeof ensureInstrumentationRegistered !== "function") {
    console.error(
      `[pool-server] ${MODULE_ID} does not export ensureInstrumentationRegistered — ` +
        `instrumentation register() will run lazily on the first request instead of at startup`,
    );
    return "registrar-missing";
  }

  try {
    // Awaited: a hook that never settles holds the pod out of readiness, which fails the
    // blue/green gate rather than cutting traffic to a half-initialized build. `next start`
    // is equivalent — its requests queue behind the same unresolved promise.
    await ensureInstrumentationRegistered(cwd, distDir);
    console.log("[pool-server] instrumentation register() completed");
    return "ok";
  } catch (err) {
    console.error(
      "[pool-server] instrumentation register() FAILED — the pool will keep serving " +
        "/healthz and static assets, but Next re-awaits this same rejected registration " +
        "per request, so app routes will 500 (this is what next start does too). N32: /readyz " +
        "now reports 503 for this state so the blue/green gate cannot promote this build:",
      err,
    );
    return "failed";
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

// N34: the per-request cap above bounds ONE upload; nothing bounded their SUM. ~40 concurrent
// maximal uploads is a 1 GB spike on a pod whose memory limit is a fraction of that, and the
// OOMKill that follows is read by the blue/green gate as a healthy pod dying under traffic —
// i.e. an unauthenticated way to fail a deploy, not just to degrade one. This is a process-wide
// admission budget: once the bytes currently buffered across all in-flight requests would exceed
// it, further uploads are refused with 503 + Retry-After rather than accepted into memory.
// Default 100 MiB (4× the per-request cap, so a single maximal upload always fits).
const MAX_INFLIGHT_BODY_BYTES = Math.max(
  MAX_BODY_BYTES,
  parseInt(process.env.ADAPTER_K8S_MAX_INFLIGHT_BODY_BYTES ?? "", 10) || 104_857_600,
);
let inflightBodyBytes = 0;

// N35: ONE cap for every image the optimizer buffers, whatever the source. There were two, and
// they disagreed: the external fetch used MAX_BODY_BYTES (25 MiB, the REQUEST body cap) while the
// loopback self-fetch used a local 20 MiB constant — so the same oversize source was a 413 or a
// 25 MiB allocation depending on which side of `isAbsolute` it arrived on. Both bound the same
// resource (one pod-memory buffer that sharp then decodes), so they are the same number.
const MAX_IMAGE_BYTES = Math.max(
  1,
  parseInt(process.env.ADAPTER_K8S_MAX_IMAGE_BYTES ?? "", 10) || 20 * 1024 * 1024,
);

// N35: an ABSOLUTE deadline for the whole external-image fetch, redirect hops included. The
// per-hop `{ timeout: 15_000 }` below is an IDLE timeout that every arriving byte resets, so a
// host trickling one byte every 14 s pinned the socket, the growing `chunks[]` (up to the cap
// above) and the client connection indefinitely — and ×4, because each redirect hop got a fresh
// idle timer. Upstream's failure mode for a slow upstream is 504, which is what this maps to.
const IMAGE_FETCH_DEADLINE_MS = Math.max(
  1000,
  parseInt(process.env.ADAPTER_K8S_IMAGE_FETCH_DEADLINE_MS ?? "", 10) || 15_000,
);

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds ADAPTER_K8S_MAX_BODY_BYTES");
    this.name = "BodyTooLargeError";
  }
}

class BodyBudgetExceededError extends Error {
  constructor() {
    super("in-flight request bodies exceed ADAPTER_K8S_MAX_INFLIGHT_BODY_BYTES");
    this.name = "BodyBudgetExceededError";
  }
}

// N34: hold the budget charge for as long as the buffer is actually held — the buffered body is
// attached to the request as `actionBody` and lives until the response completes, so releasing it
// the moment the upload finished would bound only bytes IN TRANSIT, not bytes resident.
function releaseBodyBudgetWhenResponseCompletes(res: ServerResponse, bytes: number): void {
  if (bytes <= 0) return;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inflightBodyBytes -= bytes;
  };
  if (typeof (res as { once?: unknown }).once === "function") {
    res.once("close", release);
    res.once("finish", release);
  } else {
    // A response double with no EventEmitter surface (unit tests) cannot signal completion;
    // release immediately rather than leaking the charge for the life of the process.
    release();
  }
}

async function readRequestBody(
  req: NodeJS.ReadableStream,
  res: ServerResponse,
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
  // N34: bytes this read has charged to the process-wide budget. Released immediately if the read
  // fails, and otherwise when the response completes (the buffer outlives this function).
  // Charging INCREMENTALLY rather than reserving content-length up front is deliberate: a declared
  // length is client-controlled and may be absent, forged, or contradicted by chunked framing.
  let charged = 0;
  // Explicit listener pump instead of `for await`: an early exit from a stream async
  // iterator DESTROYS the stream (and, for IncomingMessage, the socket), which turned
  // a deliverable 413 into an ECONNRESET the client couldn't read. On oversize we
  // pause and throw; the caller writes 413 + `connection: close` and only then
  // destroys the socket after the response has been flushed.
  try {
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
        inflightBodyBytes += buf.length;
        charged += buf.length;
        if (inflightBodyBytes > MAX_INFLIGHT_BODY_BYTES) {
          cleanup();
          stream.pause?.();
          reject(new BodyBudgetExceededError());
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
  } catch (err) {
    // Nothing is retained on a failed read — release immediately.
    inflightBodyBytes -= charged;
    throw err;
  }
  releaseBodyBudgetWhenResponseCompletes(res, charged);
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

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) value.forEach((entry) => headers.append(key, entry));
  }
  return headers;
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

// N31: a disk/manifest asset serve answers GET/HEAD only. `next start`'s router-server gates
// every static output this way (`res.setHeader('Allow', ['GET','HEAD']); res.statusCode = 405`
// before serveStatic), and the pool had the gate in exactly one of its three serve sites —
// dispatch's manifest serve — so POST/PUT/DELETE to a `_next/static` chunk or a public/ file
// returned 200 with the full body and the deploy cache-tag, after reading and discarding the
// request body. Measured on both servers 2026-07-25.
function isReadMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

// `Allow: GET, HEAD` as one field, matching dispatch's existing 405 for a prerender write.
// `next start` emits the two values as two `Allow` field lines, which RFC 9110 §5.3 defines as
// equivalent to the comma-joined form. Deliberate divergence on ONE point: `next start` answers
// OPTIONS on a static output with 400 (its 405 handler re-enters the router to render a `/405`
// page, and that nested render is what mangles the status — measured); 405 is the status its own
// gate sets, and the RFC-correct answer, so the adapter reports it for every non-read method.
function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405, { allow: "GET, HEAD", "content-length": "0" });
  res.end();
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
  // N31: GET/HEAD only, and the existence check comes FIRST so a write to a path with no public
  // file still falls through to routing (which is `next start`'s ordering: it 405s only once the
  // static output matched). Measured on `next start`: POST/PUT/DELETE on a public file → 405 with
  // `Allow: GET, HEAD`; the adapter answered 200 with the full body and the deploy cache-tag.
  // This is the live path for `fixtures/main`, whose static-assets.json carries no public entries.
  if (!isReadMethod(req.method)) {
    methodNotAllowed(res);
    return true;
  }
  // S14: hash once per file per process, and only read the bytes when the digest is not
  // already known — a conditional request (which these `max-age=0, must-revalidate` responses
  // invite on essentially every client request) then costs a stat, not a full read plus a full
  // SHA-1 of the body.
  const publicStat = statSync(publicFile);
  const etag = staticAssetEtagForFile(publicFile, publicStat, () => readFileSync(publicFile));
  let responseHeaders: Record<string, string | string[]> = {
    "content-type": getContentType(decodedPathname!),
    // N31: `next start` serves a public/ file `public, max-age=0` (measured), NOT a positive
    // max-age: these files change across deploys at the SAME url, so a browser copy with an
    // hour of freshness survives a cutover and no cache-tag invalidation can reach it (a
    // browser cache has no tags). `must-revalidate` is added on top so a shared cache cannot
    // serve it stale either; the ETag below makes each revalidation a 304. Keep this in step
    // with the manifest default in emit/static-assets.ts — the manifest is the canonical path
    // for public files and this disk serve is only the last resort for one it missed.
    "cache-control": "public, max-age=0, must-revalidate",
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
  // N31: Content-Length is REQUIRED for HEAD — see the same fix at the `_next/static` serve
  // site and in sendImageResponse. Stamped last so it always describes the bytes we send.
  responseHeaders["content-length"] = String(publicStat.size);
  res.writeHead(200, responseHeaders);
  // S14: HEAD needs no body at all, and a body large enough to matter is STREAMED rather than
  // buffered — `readFileSync` held the whole file resident per concurrent request and blocked
  // the event loop for the length of the read.
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  if (publicStat.size > STATIC_STREAM_THRESHOLD_BYTES) {
    pipeline(createReadStream(publicFile), res, () => undefined);
    return true;
  }
  res.end(readFileSync(publicFile));
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
  /**
   * S18. Next.js defines `remotePatterns.search` as an EXACT query-string restriction
   * (including the leading `?`, and `""` meaning "no query string at all"). It was dropped
   * from this type, so `isExternalImageAllowed` compared only protocol/host/port/pathname:
   * an app allowlisting `/proxy?tenant=public` also allowed `?tenant=private`, i.e. every
   * other query the upstream honors.
   */
  search?: string;
}

interface ImageConfig {
  remotePatterns: ImageRemotePattern[];
  domains: string[];
  // `images.localPatterns` — the allowlist for RELATIVE `?url=` values. `undefined` means
  // "no localPatterns configured", which upstream's `hasLocalMatch` treats as allow-all.
  // Next's RESOLVED config is never actually undefined: it materializes
  // `[{ pathname: "**", search: "" }]`, and that `search: ""` is live behavior rather than a
  // formality — it is why `next start` answers `?url=/test.png%3Ffoo%3D1` with
  // `400 "url" parameter is not allowed` (measured 2026-07-25). An explicitly EMPTY list
  // rejects every local image, exactly as `[].some(...)` does upstream.
  localPatterns: ImageLocalPattern[] | undefined;
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
// sharp is EXTERNAL in the pool bundle (canary.97 post-mortem: inlining the adapter
// repo's pack-time sharp JS next to the APP's staged @img binaries cross-versioned the
// pair and 503'd every /_next/image the moment upstream bumped sharp) — the require
// resolves the APP's own staged sharp at runtime. Memoization still matters: when the
// native binding is missing, the FIRST require throws but a broken partially-initialized
// module can be returned to LATER requires. Live this showed up as one honest 503
// followed by misleading 502s (build XchOtaGFu6GdFrcdujVc0). Memoizing keeps the failure
// mode consistent and logs WHY once.
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
    localPatterns: undefined,
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
      // PRESENCE again, not truthiness: absent ⇒ allow every local image (upstream's
      // `!localPatterns` short-circuit); present-but-empty ⇒ allow none. Entries are kept
      // only in the shape upstream's `matchLocalPattern` reads, so a junk entry can neither
      // widen the allowlist nor throw inside the matcher.
      if (Array.isArray(images.localPatterns)) {
        config.localPatterns = images.localPatterns.filter(
          (pattern: unknown): pattern is ImageLocalPattern =>
            typeof pattern === "object" &&
            pattern !== null &&
            ((pattern as ImageLocalPattern).pathname === undefined ||
              typeof (pattern as ImageLocalPattern).pathname === "string") &&
            ((pattern as ImageLocalPattern).search === undefined ||
              typeof (pattern as ImageLocalPattern).search === "string"),
        );
      }
      // PRESENCE, not truthiness: `imageSizes: []` is valid config meaning "only
      // deviceSizes are allowed", and falling back to Next's default list for it would
      // silently WIDEN the accepted width set past what the app configured. Entries are
      // filtered to the shape Next's config schema guarantees (int 1..10000) because they
      // bound a sharp allocation.
      if (Array.isArray(images.deviceSizes))
        config.deviceSizes = toAllowedSizes(images.deviceSizes);
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

/**
 * S16 → S32 (AVAILABILITY). Admission control for `/_next/image`, taken BEFORE the source is
 * read rather than before the encode.
 *
 * S16 put a 4-slot semaphore in front of sharp, because `/_next/image` had no process-wide
 * budget at all and a single client can walk the whole variant space (every public image ×
 * every configured width × every Accept) without ever repeating a key, so nothing upstream
 * throttles it either. S32 is the correction to that fix: the source read/fetch happened FIRST
 * (`imageBuffer` was assigned before the acquire), so what S16 actually bounded was concurrent
 * *encodes* — resident source memory stayed bounded only by queue depth × MAX_IMAGE_BYTES,
 * every waiter parked on the semaphore holding its own full copy, with the 5 s shed deadline as
 * the only cap on how long. On a pod whose default memory limit is 512 MiB that is still an OOM
 * path, merely a slower one, and an OOMKill under traffic is read by the blue/green gate as a
 * healthy pod dying — an unauthenticated way to fail a deploy, not just to degrade one. Same
 * reasoning as the N34 request-body budget, and this budget is deliberately built in its shape.
 *
 * So admission now covers source acquisition AND encode as ONE gate — a queued request holds
 * nothing but its request state — with two knobs, because a slot count alone does not bound
 * bytes:
 *   • MAX_CONCURRENT_IMAGE_OPTIMIZATIONS — how many sources may be in flight at once, which is
 *     what bounds concurrent libvips working sets.
 *   • MAX_INFLIGHT_IMAGE_BYTES — a process-wide byte budget over those sources. Admission
 *     reserves the WORST CASE (MAX_IMAGE_BYTES), because the size of a source is unknowable
 *     before reading it, and trues the reservation down (or up) to the real size once the bytes
 *     are in hand. Without this knob the memory bound would be slots × MAX_IMAGE_BYTES
 *     (4 × 20 MiB by default) with no way to tighten it independently of concurrency.
 *
 * Still a semaphore, not a queue-forever: waiters have a deadline, and a request that cannot be
 * admitted in time is shed with 503 *before it has read anything*. The failure mode stays "some
 * image requests are refused under load" rather than "the pod OOMs and takes every route down
 * with it".
 *
 * One consequence of gating the read rather than the encode: the passthrough answers — allowed
 * SVG, BYPASS_TYPES, animated sources — now need admission too, where under S16 they were served
 * without ever touching the semaphore. That is the point rather than a side effect. They buffer
 * a full source exactly like an encoded one does, so they were the cheapest way to drive the
 * unbounded path; the cost is that a saturated pod can now shed a request `next start` would
 * answer, which is the same trade the encode semaphore already made.
 *
 * Admission is released when the optimization completes, NOT when the response finishes writing
 * (which is what the N34 body budget does, deliberately, for the request bodies it charges).
 * The difference is which resource is scarce: N34 holds a byte charge because the buffer it
 * charged for stays resident for the whole response, whereas holding a CONCURRENCY slot across
 * the response write would let four slow readers pin the entire optimizer while holding no
 * source memory at all. What outlives release here is the encoded derivative, a fraction of the
 * source it came from.
 */
const MAX_CONCURRENT_IMAGE_OPTIMIZATIONS = Math.max(
  1,
  parseInt(process.env.ADAPTER_K8S_MAX_CONCURRENT_IMAGE_OPTIMIZATIONS ?? "", 10) || 4,
);
// The budget can never be smaller than one maximal source, or a single legitimate request could
// never be admitted at all (the same floor MAX_INFLIGHT_BODY_BYTES applies to MAX_BODY_BYTES).
const MAX_INFLIGHT_IMAGE_BYTES = Math.max(
  MAX_IMAGE_BYTES,
  parseInt(process.env.ADAPTER_K8S_MAX_INFLIGHT_IMAGE_BYTES ?? "", 10) || 67_108_864, // 64 MiB
);
const IMAGE_ADMISSION_DEADLINE_MS = Math.max(
  1,
  parseInt(process.env.ADAPTER_K8S_IMAGE_ADMISSION_DEADLINE_MS ?? "", 10) || 5_000,
);
let activeImageOptimizations = 0;
let reservedImageBytes = 0;
const imageAdmissionWaiters: Array<() => void> = [];
// Counters, not gauges: the shed count is the signal that the pod is refusing image work, and
// the join count is what proves the single-flight below is actually collapsing duplicates. Both
// are read by tests (asserting on admission accounting is reliable where heap assertions are
// not) and both are cheap enough to keep in production.
let admittedImageOptimizations = 0;
let shedImageOptimizations = 0;
let joinedImageOptimizations = 0;

interface ImageAdmission {
  /**
   * Replace this admission's worst-case reservation with the number of source bytes actually
   * held. Called as soon as the source is in hand. Every external, self-fetch and local-file path
   * is now capped before or while it reads, so this can only reduce the worst-case reservation.
   */
  settleSourceBytes(bytes: number): void;
  release(): void;
}

// Admit from the head, and stop at the first waiter that does not fit rather than scanning past
// it for one that does: strict FIFO is what keeps a request for a large source from being
// starved indefinitely by a stream of small ones. Called on every release AND on every true-up,
// since a true-up can free budget without freeing a slot.
function pumpImageAdmissionQueue(): void {
  while (
    imageAdmissionWaiters.length > 0 &&
    activeImageOptimizations < MAX_CONCURRENT_IMAGE_OPTIMIZATIONS &&
    reservedImageBytes + MAX_IMAGE_BYTES <= MAX_INFLIGHT_IMAGE_BYTES
  ) {
    imageAdmissionWaiters.shift()!();
  }
}

function grantImageAdmission(): ImageAdmission {
  activeImageOptimizations++;
  admittedImageOptimizations++;
  let charged = MAX_IMAGE_BYTES;
  reservedImageBytes += charged;
  let released = false;
  return {
    settleSourceBytes(bytes: number): void {
      if (released) return;
      reservedImageBytes += bytes - charged;
      charged = bytes;
      pumpImageAdmissionQueue();
    },
    release(): void {
      if (released) return;
      released = true;
      activeImageOptimizations--;
      reservedImageBytes -= charged;
      pumpImageAdmissionQueue();
    },
  };
}

async function acquireImageAdmission(): Promise<ImageAdmission | null> {
  if (
    imageAdmissionWaiters.length === 0 &&
    activeImageOptimizations < MAX_CONCURRENT_IMAGE_OPTIMIZATIONS &&
    reservedImageBytes + MAX_IMAGE_BYTES <= MAX_INFLIGHT_IMAGE_BYTES
  ) {
    return grantImageAdmission();
  }
  return new Promise<ImageAdmission | null>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = imageAdmissionWaiters.indexOf(admit);
      if (idx !== -1) imageAdmissionWaiters.splice(idx, 1);
      shedImageOptimizations++;
      resolve(null);
    }, IMAGE_ADMISSION_DEADLINE_MS);
    timer.unref?.();
    function admit(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(grantImageAdmission());
    }
    imageAdmissionWaiters.push(admit);
  });
}

/**
 * What one unit of shared optimizer work produces. It is a VALUE rather than a write to `res`
 * because S32(b) lets N requests share it: everything that depends on the individual request
 * (If-None-Match → 304, HEAD, and the error body) is applied by each caller afterwards.
 */
type ImageOptimizationOutcome =
  | { kind: "image"; body: Buffer; contentType: string; isStatic: boolean; maxAge: number }
  | { kind: "error"; status: number; body: string };

/**
 * S32(b). Single-flight on a PRE-I/O key, so concurrent identical requests share one fetch and
 * one encode instead of N of each.
 *
 * The key is the request shape known before any I/O: normalized `?url=`, width, quality and the
 * NEGOTIATED output mime. Deliberately not source identity (ETag/Last-Modified/final redirected
 * URL): those are known only after fetching — FetchedImage does not even carry them — so a key
 * built from them cannot dedupe the fetch, which is the expensive half. It is upstream's model
 * too: `ImageOptimizerCache.getCacheKey` is URL-based and uses source validators as
 * *revalidation* metadata, not as key material.
 *
 * Sharing is safe because the work is client-independent by construction: the local branch reads
 * from disk, and a middleware-covered or route-served source is self-fetched over loopback with
 * NONE of the client's headers (see the self-fetch below), so two clients requesting the same
 * key already received byte-identical output before this existed. The window is only the
 * in-flight one — nothing is retained after the promise settles, so a source that changes
 * between requests behaves exactly as it did.
 */
const inflightImageOptimizations = new Map<string, Promise<ImageOptimizationOutcome>>();

function runOrJoinImageOptimization(
  key: string,
  run: () => Promise<ImageOptimizationOutcome>,
): Promise<ImageOptimizationOutcome> {
  const joined = inflightImageOptimizations.get(key);
  if (joined) {
    joinedImageOptimizations++;
    return joined;
  }
  // The map entry is cleared on BOTH outcomes, so a rejection cannot poison the key for the
  // life of the process: the next request re-runs the work. Every waiter awaits this same
  // promise, which is also why a rejection here is never an unhandled one.
  const started = run().finally(() => {
    inflightImageOptimizations.delete(key);
  });
  inflightImageOptimizations.set(key, started);
  return started;
}

/**
 * The S32 admission/single-flight accounting, exported for tests. Asserting on this is the
 * reliable way to pin a memory bound — a heap assertion is flaky, and a test that only counted
 * encodes would pass while a duplicated FETCH (the expensive half) went unnoticed.
 */
export function imageOptimizerAdmissionStats(): {
  active: number;
  queued: number;
  reservedBytes: number;
  admitted: number;
  shed: number;
  joined: number;
  inflightKeys: number;
} {
  return {
    active: activeImageOptimizations,
    queued: imageAdmissionWaiters.length,
    reservedBytes: reservedImageBytes,
    admitted: admittedImageOptimizations,
    shed: shedImageOptimizations,
    joined: joinedImageOptimizations,
    inflightKeys: inflightImageOptimizations.size,
  };
}

/**
 * S26. Origin + pathname only, with a marker when a query string was dropped. Keeps the log
 * useful for debugging (which source failed) without printing credentials or letting a decoded
 * newline forge a log line.
 */
export function redactImageUrlForLog(url: string): string {
  try {
    const parsed = new URL(url, "http://n");
    const base = url.startsWith("/") ? parsed.pathname : `${parsed.origin}${parsed.pathname}`;
    return parsed.search ? `${base}?<redacted>` : base;
  } catch {
    return "<unparseable url>";
  }
}

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
// True when the BUILD prerendered `/_not-found` — read from the prerender manifest, which
// is the exact discriminator between the two upstream suites (both ship an EMPTY
// next.config, so no config flag separates them):
//   • not-found-non-document:         manifest.routes["/_not-found"] present (static
//     prerender) → the deployed contract serves that prerender even for non-HTML
//     subresource requests, so a handler fallback must still render the HTML document.
//   • not-found-non-document-dynamic: absent (the app's not-found is dynamic) → keep
//     `next start`'s text/plain answer for subresources.
// `next.config.partialPrefetching` from the resolved build config — see the dispatcher
// option of the same name.
function partialPrefetchingEnabled(cwd: string): boolean {
  try {
    const rsfPath = path.join(cwd, ".next", "required-server-files.json");
    if (!existsSync(rsfPath)) return false;
    const rsf = JSON.parse(readFileSync(rsfPath, "utf-8")) as {
      config?: { partialPrefetching?: boolean };
    };
    return rsf?.config?.partialPrefetching === true;
  } catch {
    return false;
  }
}

function notFoundIsPrerenderedBuild(cwd: string): boolean {
  try {
    const manifestPath = path.join(cwd, ".next", "prerender-manifest.json");
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      routes?: Record<string, unknown>;
    };
    return manifest?.routes?.["/_not-found"] !== undefined;
  } catch {
    return false;
  }
}

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

/**
 * Resolve `relPath` under `root`, returning null if it escapes the root (traversal).
 *
 * S30 (SECURITY). The lexical `path.resolve` check answers "does this PATH STRING stay under
 * the root", which is not the same question as "does the file it opens stay under the root": a
 * symlink inside the root whose target is outside it passes lexically, and the subsequent
 * `readFileSync` follows it. In a deployed image that is unreachable — collectPublicPathnames
 * skips escaping symlinks at build time, so they never enter the inventory or the staged
 * context — but it IS reachable under `emulate`/local dev, where the server runs against the
 * working tree. Resolve the real path and re-check, so containment holds wherever this runs.
 *
 * The realpath is only attempted when the file exists; a miss keeps the lexical answer so a
 * 404 stays a 404 rather than becoming an error.
 */
function resolveWithinRoot(root: string, relPath: string): string | null {
  const rel = relPath.startsWith("/") ? relPath : `/${relPath}`;
  const resolved = path.resolve(root, `.${rel}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  try {
    const realRoot = realpathSync(root);
    const realTarget = realpathSync(resolved);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  } catch {
    // Either the root or the candidate does not exist — the lexical verdict stands and the
    // caller's own existsSync decides.
  }
  return resolved;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  const d = parts[3] ?? 0;

  // SECURITY: this is a GLOBAL-address allow policy, despite the historical function name.
  // Keep it aligned with the IANA IPv4 Special-Purpose Address Registry (checked 2026-07-30),
  // not just the familiar RFC1918 ranges. The image fetcher uses this one predicate for URL
  // literals, DNS preflight, redirect hops and the socket-pinned lookup; an omission therefore
  // becomes an SSRF route in all four places. More-specific globally reachable assignments
  // inside 192.0.0.0/24 are the only exceptions to that parent block.
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0 && c === 0) {
    if (d === 9 || d === 10) return false; // PCP/TURN anycast: globally reachable
    return true; // IETF protocol assignments, otherwise non-global
  }
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // deprecated 6to4 relay anycast
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * S23 (SECURITY). Classify an IPv6 address by PARSING it, not by matching prefixes.
 *
 * The previous version tested string prefixes and recognized an IPv4-mapped address only in
 * its DOTTED form (`^::ffff:(\d+\.\d+\.\d+\.\d+)$`). Three gaps followed:
 *  - the WHATWG URL parser NORMALIZES `[::ffff:169.254.169.254]` to the HEX form
 *    `::ffff:a9fe:a9fe`, so that branch was dead on anything that came through a URL;
 *  - `fe80` matched by prefix missed the rest of `fe80::/10` (`fe90::1` read as public);
 *  - IPv4-compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::/96`) were unclassified — the latter
 *    is the one that actually routes on a cluster with DNS64/NAT64, no bracket-stripping
 *    needed.
 *
 * Not exploitable as it stood — IPv6 literals die earlier because `URL.hostname` keeps the
 * brackets and `dns.lookup("[…]")` fails, and glibc renders IPv4-mapped DNS answers dotted,
 * which the old regex did catch. Both of those are accidents of layers this function does not
 * control (Node's own `urlToHttpOptions` strips exactly those brackets), which is precisely
 * why the predicate should not depend on them.
 */
function parseIPv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  // A trailing dotted quad (`::ffff:1.2.3.4`, `::1.2.3.4`) contributes the low 32 bits.
  let tail: number[] = [];
  const dotted = addr.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted?.[1]) {
    const octets = dotted[1].split(".").map((o) => Number(o));
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    addr = addr.slice(0, addr.length - dotted[1].length) + "0:0";
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0] ?? "");
  const rest = halves.length === 2 ? toGroups(halves[1] ?? "") : null;
  if (!head || (halves.length === 2 && !rest)) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest!.length;
    if (fill < 0) return null;
    groups = [...head, ...Array.from({ length: fill }, () => 0), ...rest!];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

function isPrivateIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return true; // unparseable → unsafe
  const isZero = (upto: number): boolean => g.slice(0, upto).every((x) => x === 0);
  // Loopback ::1 and unspecified ::
  if (isZero(7) && (g[7] === 1 || g[7] === 0)) return true;
  // IPv4-mapped ::ffff:a.b.c.d — in EITHER spelling, since both parse to the same groups.
  if (isZero(5) && g[5] === 0xffff) {
    return isPrivateIPv4(ipv4FromGroups(g));
  }
  // IPv4-compatible ::a.b.c.d (deprecated, but classify rather than guess).
  if (isZero(6) && (g[6] !== 0 || g[7] !== 0)) {
    return isPrivateIPv4(ipv4FromGroups(g));
  }
  // NAT64 well-known prefix 64:ff9b::/96 — routes to the embedded IPv4 wherever a NAT64
  // gateway exists, which includes IPv6-only GKE clusters using DNS64.
  if (g[0] === 0x0064 && g[1] === 0xff9b && isZeroRange(g, 2, 6)) {
    return isPrivateIPv4(ipv4FromGroups(g));
  }
  // The local-use NAT64 prefix is explicitly not globally reachable.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0x0001) return true;
  // 6to4 2002::/16 embeds an IPv4 address in the next 32 bits.
  if (g[0] === 0x2002) {
    return isPrivateIPv4(`${g[1]! >> 8}.${g[1]! & 0xff}.${g[2]! >> 8}.${g[2]! & 0xff}`);
  }

  // SECURITY: default-deny IPv6 space outside the currently allocated global-unicast 2000::/3
  // block. This covers unspecified/reserved, discard-only, unique-local, site/link-local and
  // multicast space without betting the SSRF boundary on a familiar-prefix shortlist.
  if ((g[0]! & 0xe000) !== 0x2000) return true;

  // IANA's 2001::/23 protocol-assignment parent is non-global unless a more-specific registry
  // entry says otherwise. Keep those public anycast/protocol exceptions explicit so a new
  // special-purpose assignment fails closed until this table is reviewed.
  if (g[0] === 0x2001 && (g[1]! & 0xfe00) === 0) {
    const exactAnycast =
      g[1] === 0x0001 &&
      isZeroRange(g, 2, 7) &&
      (g[7] === 0x0001 || g[7] === 0x0002 || g[7] === 0x0003);
    const globallyReachableProtocolAssignment =
      g[1] === 0x0003 ||
      (g[1] === 0x0004 && g[2] === 0x0112) ||
      (g[1]! & 0xfff0) === 0x0020 ||
      (g[1]! & 0xfff0) === 0x0030;
    if (!exactAnycast && !globallyReachableProtocolAssignment) return true;
  }

  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x3fff && (g[1]! & 0xf000) === 0) return true; // documentation 3fff::/20
  return false;
}

/**
 * Exported for tests. The historical name is retained to avoid churn, but `true` means
 * non-global/special-purpose, not only RFC1918 private space.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // unparseable → treat as unsafe
}

function ipv4FromGroups(g: number[]): string {
  return `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
}

function isZeroRange(g: number[], from: number, to: number): boolean {
  for (let i = from; i < to; i++) if (g[i] !== 0) return false;
  return true;
}

async function hostResolvesToPublicOnly(hostname: string): Promise<boolean> {
  // S23: `URL.hostname` keeps the brackets on an IPv6 literal, and Node's own
  // urlToHttpOptions strips them before connecting — so strip them HERE too and classify the
  // address, rather than relying on `dns.lookup("[…]")` happening to fail.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare)) return !isPrivateAddress(bare);
  try {
    const records = await dns.lookup(bare, { all: true });
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

// `images.localPatterns` uses picomatch globs, and upstream compiles them with the very
// module Next ships (`next/dist/compiled/picomatch`, `makeRe(pattern, { dot: true })`). Use
// that same module, resolved from the APP (the pool already resolves several next/dist
// modules this way), so the allowlist cannot drift from upstream's on glob syntax the
// repo's own `*`/`**` translator doesn't cover (braces, char classes, extglobs). Loaded once
// and cached — success OR failure.
type PicomatchMakeRe = (glob: string, options: { dot: boolean }) => RegExp;
let picomatchMakeRe: PicomatchMakeRe | null | undefined;
function loadPicomatchMakeReOnce(): PicomatchMakeRe | null {
  if (picomatchMakeRe !== undefined) return picomatchMakeRe;
  picomatchMakeRe = null;
  try {
    const appRequire = createRequire(path.join(process.cwd(), "package.json"));
    const picomatch = appRequire("next/dist/compiled/picomatch") as {
      makeRe?: PicomatchMakeRe;
    };
    if (typeof picomatch.makeRe === "function") picomatchMakeRe = picomatch.makeRe;
  } catch (err) {
    // Degrade to the repo's own glob translator rather than failing the allowlist in either
    // direction. Loud, because the fallback only approximates picomatch.
    console.warn(
      "[pool-server] could not load next/dist/compiled/picomatch — images.localPatterns will " +
        "be matched with the adapter's approximate `*`/`**` translator:",
      err instanceof Error ? err.message : err,
    );
  }
  return picomatchMakeRe;
}

const localPatternMatchers = new Map<string, (pathname: string) => boolean>();
function localPathnameMatcher(glob: string): (pathname: string) => boolean {
  const cached = localPatternMatchers.get(glob);
  if (cached) return cached;
  const makeRe = loadPicomatchMakeReOnce();
  let matcher: (pathname: string) => boolean = (pathname) => pathnameMatchesPattern(pathname, glob);
  if (makeRe) {
    try {
      const re = makeRe(glob, { dot: true });
      matcher = (pathname) => re.test(pathname);
    } catch {
      // An unparseable glob keeps the fallback; it must not throw out of the optimizer.
    }
  }
  localPatternMatchers.set(glob, matcher);
  return matcher;
}

// Upstream's `hasLocalMatch` + `matchLocalPattern` (shared/lib/match-local-pattern.ts):
// no configured patterns ⇒ every local image is allowed; otherwise the url must match one
// pattern on BOTH `search` (exact string compare, so the default `search: ""` forbids a
// query string on a local image url) and `pathname` (picomatch glob, default `**`).
function hasLocalImageMatch(
  urlPathAndQuery: string,
  patterns: ImageLocalPattern[] | undefined,
): boolean {
  if (!patterns) return true;
  let url: URL;
  try {
    // Upstream's base is literally `http://n`; it also NORMALIZES the pathname, which is
    // what makes `?url=/../../etc/passwd` a `/etc/passwd` miss upstream rather than a
    // traversal. The adapter keeps its own resolveWithinRoot guard regardless.
    url = new URL(urlPathAndQuery, "http://n");
  } catch {
    return false;
  }
  return patterns.some((pattern) => {
    if (pattern.search !== undefined && pattern.search !== url.search) return false;
    return localPathnameMatcher(pattern.pathname ?? "**")(url.pathname);
  });
}

// `next start` sends NO Content-Type on ANY /_next/image error — next-server answers the
// validateParams 400 with `res.body(msg).send()` and every ImageError through the same
// path, so the wire is `400 Bad Request` + `Transfer-Encoding: chunked` + the body and
// nothing else (measured with curl against `next start` 2026-07-25). The adapter used to
// stamp `content-type: text/plain` on all of them.
//
// Dropping it is safe HERE and only here because every body routed through this helper is a
// FIXED string: the three error paths that used to interpolate the request's own `?url=`
// value (`Image not found: <url>`, `Failed to fetch external image: <url>`, and the
// unbounded 3 kB echo the missing length cap allowed) were replaced with upstream's
// non-reflecting wording in the same pass. Do not reintroduce request-controlled text in an
// error body without also restoring a Content-Type.
function sendImageError(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {});
  res.end(body);
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
    // S18: exact match when configured — upstream compares the whole `search` string, so the
    // default `search: ""` forbids ANY query on the allowlisted URL.
    if (p.search !== undefined && p.search !== target.search) continue;
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

// Why a discriminated KIND rather than the human string this used to return: the string was
// interpolated straight into the 400 body (`Bad Request: image fetch timed out`), which both
// leaked an internal reason to the client and made every upstream failure a 400 where
// `next start` distinguishes 400 / 413 / 504 / 508 / the upstream's own status. The kind is
// mapped to (status, upstream body) at the one call site; the reason is logged, not sent.
type ImageFetchErrorKind =
  | "not-allowed"
  | "timed-out"
  | "too-many-redirects"
  | "too-large"
  | "fetch-failed"
  | "redirect-without-location";

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
): Promise<FetchedImage | { error: ImageFetchErrorKind }> {
  const MAX_REDIRECTS = 3;
  const { request: httpsRequest } = await import("node:https");
  const { request: httpRequest2 } = await import("node:http");
  let target = initial;
  // N35: one absolute deadline for the WHOLE fetch, redirect chain included (see
  // IMAGE_FETCH_DEADLINE_MS). Every wait below is bounded by whatever is left of it.
  const deadline = Date.now() + IMAGE_FETCH_DEADLINE_MS;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() >= deadline) return { error: "timed-out" };
    if (!isExternalImageAllowed(target, config)) return { error: "not-allowed" };
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      return { error: "not-allowed" };
    }
    // Pre-check keeps a fast, clear rejection; the pinned lookup below is the
    // actual guarantee for the connection that happens.
    // S16: inside the deadline. This await sat OUTSIDE it, so c-ares retry time against an
    // allowlisted domain with dead nameservers added unbounded latency per hop on top of
    // IMAGE_FETCH_DEADLINE_MS — the one wait in this function the "one absolute deadline for
    // the WHOLE fetch" comment did not actually cover.
    const dnsVerdict = await Promise.race([
      hostResolvesToPublicOnly(target.hostname),
      new Promise<"deadline">((resolve) =>
        setTimeout(() => resolve("deadline"), Math.max(0, deadline - Date.now())).unref?.(),
      ),
    ]);
    if (dnsVerdict === "deadline") return { error: "timed-out" };
    if (!dnsVerdict) {
      return { error: "not-allowed" };
    }

    const request = target.protocol === "https:" ? httpsRequest : httpRequest2;
    const result = await new Promise<
      FetchedImage | { error: ImageFetchErrorKind } | { redirect: string }
    >((resolve) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve({ error: "timed-out" });
        return;
      }
      const req = request(
        target.toString(),
        // The idle timeout is KEPT as well — it is the cheaper signal for a dead peer — but it
        // is now capped by whatever remains of the absolute deadline, so it can never outlive it.
        { lookup: pinnedPublicLookup, timeout: Math.min(15_000, remaining) },
        (imgRes) => {
          const status = imgRes.statusCode ?? 502;
          if (status >= 300 && status < 400) {
            imgRes.resume(); // drain
            const location = imgRes.headers.location;
            if (!location) return settle({ error: "redirect-without-location" });
            return settle({ redirect: location });
          }
          const chunks: Buffer[] = [];
          let total = 0;
          imgRes.on("data", (c: Buffer) => {
            total += c.length;
            if (total > MAX_IMAGE_BYTES) {
              imgRes.destroy();
              settle({ error: "too-large" });
              return;
            }
            chunks.push(c);
          });
          imgRes.on("end", () =>
            settle({
              ok: status >= 200 && status < 300,
              status,
              contentType: imgRes.headers["content-type"] ?? "image/jpeg",
              cacheControl: imgRes.headers["cache-control"] ?? null,
              body: Buffer.concat(chunks),
            }),
          );
          imgRes.on("error", () => settle({ error: "fetch-failed" }));
        },
      );
      // The absolute deadline fires regardless of how much the peer is trickling: destroy the
      // socket (which also stops `chunks` growing) and report the timeout once.
      const deadlineTimer = setTimeout(() => {
        req.destroy();
        settle({ error: "timed-out" });
      }, remaining);
      // `deadlineTimer.unref` keeps a pending fetch from holding the event loop open in tests.
      deadlineTimer.unref?.();
      let settled = false;
      function settle(
        value: FetchedImage | { error: ImageFetchErrorKind } | { redirect: string },
      ): void {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        resolve(value);
      }
      req.on("timeout", () => {
        req.destroy();
        settle({ error: "timed-out" });
      });
      req.on("error", () => settle({ error: "fetch-failed" }));
      req.end();
    });

    if ("redirect" in result) {
      if (hop === MAX_REDIRECTS) return { error: "too-many-redirects" };
      try {
        target = new URL(result.redirect, target);
      } catch {
        // Upstream's guard is `URL.canParse(location, href)`; an unparseable Location makes
        // it fall through to the `!res.ok` branch, i.e. the same "upstream response is
        // invalid" verdict a missing Location gets.
        return { error: "redirect-without-location" };
      }
      continue; // re-validate the new target at the top of the loop
    }
    return result;
  }
  return { error: "too-many-redirects" };
}

// Upstream's status + body for each way an external fetch can fail
// (`fetchExternalImage`, measured where reachable — e.g. an allowlisted host answering 404
// gives `404 "url" parameter is valid but upstream response is invalid`, and a private-IP
// target gives `400 "url" parameter is not allowed`). ImageError coerces any status < 400
// to 500, which is why a redirect with an unusable Location lands on 500.
const IMAGE_FETCH_ERROR_RESPONSE: Record<ImageFetchErrorKind, { status: number; body: string }> = {
  "not-allowed": { status: 400, body: '"url" parameter is not allowed' },
  "timed-out": {
    status: 504,
    body: '"url" parameter is valid but upstream response timed out',
  },
  "too-many-redirects": {
    status: 508,
    body: '"url" parameter is valid but upstream response is invalid',
  },
  "too-large": {
    status: 413,
    body: '"url" parameter is valid but upstream response is invalid',
  },
  "fetch-failed": {
    status: 500,
    body: '"url" parameter is valid but upstream response is invalid',
  },
  "redirect-without-location": {
    status: 500,
    body: '"url" parameter is valid but upstream response is invalid',
  },
};

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
  // Pool-side classic incremental-cache handle for the PPR materialization layer. Distinct
  // from the app-registered handler instance (different module graph) but the same keyspace,
  // tag manifest, and seed semantics — Valkey is the shared truth. Constructed lazily-safe:
  // any failure leaves the dispatcher without a platformCache, which is exactly the old
  // behavior.
  let platformCacheHandler: ValkeyIncrementalCacheHandler | undefined;
  if (valkeyUrl) {
    try {
      platformCacheHandler = new ValkeyIncrementalCacheHandler({
        client: createValkeyClient({
          url: valkeyUrl,
          ...(process.env.VALKEY_AUTH ? { password: process.env.VALKEY_AUTH } : {}),
          ...(process.env.VALKEY_CA_CERT ? { caCert: process.env.VALKEY_CA_CERT } : {}),
        }),
        buildId,
        seedLookup: createBuildSeedLookup(),
      });
    } catch (error) {
      console.warn(
        "[pool-server] platform cache handle unavailable — PPR materialization disabled:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const instrumentationStatus = await registerInstrumentationHook();

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const releaseName = process.env.RELEASE_NAME ?? "nextjs";
  const configDir = process.env.CONFIG_DIR ?? "/config";

  // The writable emptyDir at /app/.next/cache shadows anything the image ships there, so
  // the build's fetch-cache rides at .k8s-adapter/fetch-cache-seed and is restored into
  // the runtime location before anything can read it (see fetch-cache-seed.ts).
  restoreFetchCacheSeed(process.cwd());

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
  const runtimeStaticTemplates = new Set<string>();
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
      for (const [template, route] of Object.entries<Record<string, unknown>>(
        prerenderManifest.dynamicRoutes ?? {},
      )) {
        if (route.fallback === false && typeof route.routeRegex === "string") {
          strictDynamicRoutes.push({
            pageRegex: new RegExp(route.routeRegex),
          });
        }
        // `fallback: null` on an APP route (dataRoute *.rsc): Next may statically GENERATE
        // never-prerendered concrete paths at runtime — under a shared cache these render
        // non-minimal so Next's own response-cache write materializes them (dispatch's
        // runtimeStaticTemplates rung; sub-shell-generation-middleware parity).
        if (
          route.fallback === null &&
          typeof route.dataRoute === "string" &&
          route.dataRoute.endsWith(".rsc")
        ) {
          runtimeStaticTemplates.add(template);
        }
      }
    } catch {
      // Non-fatal — draft mode just won't work
    }
  }
  if (process.env.ADAPTER_K8S_CACHE_TRACE === "1") {
    console.log(
      `[cache-trace] ${JSON.stringify({ op: "startup", runtimeStaticTemplates: [...runtimeStaticTemplates] })}`,
    );
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
  let edgeSandboxLoadError: Error | undefined;
  const distDir = path.join(process.cwd(), ".next");
  try {
    const { createRequire: cr } = await import("node:module");
    const appReq = cr(path.join(process.cwd(), "package.json"));
    const sandbox = appReq("next/dist/server/web/sandbox") as {
      run: (params: any) => Promise<{ response: Response; waitUntil: Promise<void> }>;
    };
    // Node-side IncrementalCache for edge invocations on a cold replica (see the wiring note
    // below). Mirrors NextNodeServer.getIncrementalCache: the app's own IncrementalCache class,
    // the REGISTERED cacheHandler (required-server-files config, resolved against distDir), and
    // a minimal prerender-manifest surface. Lazy + memoized; any failure returns undefined,
    // which is exactly the previous behavior (edge runs with an isolated cache).
    let fallbackIncrementalCache: unknown;
    let fallbackIncrementalCacheFailed = false;
    const getFallbackIncrementalCache = (): unknown => {
      if (fallbackIncrementalCache !== undefined || fallbackIncrementalCacheFailed) {
        return fallbackIncrementalCache;
      }
      try {
        const rsf = JSON.parse(
          readFileSync(path.join(distDir, "required-server-files.json"), "utf-8"),
        );
        const cacheHandlerRel: string | undefined = rsf?.config?.cacheHandler;
        if (!cacheHandlerRel) {
          fallbackIncrementalCacheFailed = true;
          return undefined;
        }
        const { IncrementalCache } = appReq("next/dist/server/lib/incremental-cache") as {
          IncrementalCache: new (options: Record<string, unknown>) => unknown;
        };
        const CurCacheHandler = appReq(
          path.isAbsolute(cacheHandlerRel)
            ? cacheHandlerRel
            : path.resolve(distDir, cacheHandlerRel),
        );
        fallbackIncrementalCache = new IncrementalCache({
          fs: appReq("next/dist/server/lib/node-fs-methods").nodeFs,
          dev: false,
          flushToDisk: false,
          fetchCache: true,
          minimalMode: false,
          serverDistDir: path.join(distDir, "server"),
          requestHeaders: {},
          getPrerenderManifest: () => ({
            version: -1,
            routes: {},
            dynamicRoutes: {},
            notFoundRoutes: [],
            preview: { previewModeId: "", previewModeSigningKey: "", previewModeEncryptionKey: "" },
          }),
          CurCacheHandler: CurCacheHandler?.default ?? CurCacheHandler,
        });
      } catch (error) {
        fallbackIncrementalCacheFailed = true;
        console.warn(
          "[pool-server] could not build the fallback IncrementalCache for edge invocations; " +
            "edge revalidateTag on a cold replica will not reach the shared cache:",
          error instanceof Error ? error.message : String(error),
        );
      }
      return fallbackIncrementalCache;
    };
    const sandboxContext = appReq("next/dist/server/web/sandbox/context") as {
      getModuleContext: (options: {
        moduleName: string;
        onWarning: (w: unknown) => void;
        onError: (e: unknown) => void;
        useCache: boolean;
        edgeFunctionEntry: unknown;
        distDir: string;
      }) => Promise<{ runtime: { context: { globalThis: Record<symbol, unknown> } } }>;
    };
    edgeSandboxRun = async (params) => {
      // Seed the sandbox realm's `use cache` handler registry BEFORE the entry modules
      // evaluate in it. getModuleContext is cached by moduleName and does NOT evaluate the
      // entry files (sandbox.run does, afterwards), so this hands the fresh realm the
      // node-side Valkey handlers in time: without it, edge-runtime after() revalidatePath
      // found zero handlers in the sandbox and the write vanished — an edge-middleware app
      // registers no classic cacheHandler, so there is no incrementalCache fallback either
      // (measured live: next-after-app-deploy, all edge + middleware cases).
      const { runtime } = await sandboxContext.getModuleContext({
        moduleName: params.name,
        onWarning: () => {},
        onError: () => {},
        useCache: true,
        edgeFunctionEntry: params.edgeFunctionEntry,
        distDir,
      });
      seedSandboxCacheHandlerRegistry(runtime.context.globalThis);
      return sandbox.run({
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
          (globalThis as typeof globalThis & { __incrementalCache?: unknown }).__incrementalCache ??
          // COLD-REPLICA FIX (2026-07-30): `__incrementalCache` is published by NODE
          // entrypoints on their first invocation, so on a pod where no node route has run
          // yet an edge function got NO incremental cache here — and inside the sandbox the
          // bundled cache handler detects EdgeRuntime and goes INERT (cache-handler-entry.ts),
          // so an edge route handler's `revalidateTag` wrote into a void and the invalidation
          // was lost cluster-wide. Measured on GKE: upstream app-static's "revalidate tag
          // correctly with edge route handler" timed out forever. Build a real Node-side
          // IncrementalCache backed by the registered handler, once, lazily.
          getFallbackIncrementalCache(),
        clientAssetToken: "",
      });
    };
    console.log("Edge sandbox initialized");
  } catch (err) {
    // Do NOT swallow this. For a node-runtime app an unavailable sandbox is genuinely
    // harmless, but for an edge-middleware app it is fatal — and the downstream symptom
    // ("middleware has no callable export") blames the app's own middleware, which is fine.
    // Live on GKE the actual cause was a missing @swc/helpers in the traced image, and
    // finding that took a probe pod because this handler discarded it.
    edgeSandboxLoadError = err instanceof Error ? err : new Error(String(err));
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
        "Edge middleware found but sandbox not available, falling back to Node.js loading" +
          (edgeSandboxLoadError ? ` (${edgeSandboxLoadError.message})` : ""),
      );
      middlewareModule = await resolveMiddlewareModule(mwPath);
      console.log("Middleware module loaded (Node.js fallback)");
    } else {
      middlewareModule = await resolveMiddlewareModule(mwPath);
      console.log("Middleware module loaded");
    }

    if (!edgeMiddlewareRunner && !hasCallableMiddlewareExport(middlewareModule)) {
      // An EDGE entry reaching here means the sandbox never loaded: the module is a webpack
      // edge wrapper, which Node cannot call, so "no callable export" is a true statement
      // about a file that was never meant to be loaded this way. Lead with the real cause —
      // it is nearly always a dependency missing from the container image, not the app.
      if (isEdge) {
        throw new Error(
          `Edge middleware at ${mwPath} could not be run: the Next.js edge sandbox failed to ` +
            `load, and the Node.js fallback found no callable export (an edge bundle is not ` +
            `callable from Node). This usually means the container image is missing a runtime ` +
            `dependency of next/dist/server/web/sandbox. Underlying error: ` +
            `${edgeSandboxLoadError?.message ?? "sandbox unavailable, no error recorded"}`,
        );
      }
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
  // In GKE, the pool server is behind the ALB — the routing extension sets internal dispatch
  // headers and authenticates them with a shared secret (INTERNAL_HEADER_SECRET, injected from
  // a Secret). When the secret is set the pool trusts dispatch headers only if it matches;
  // TRUST_INTERNAL_HEADERS is the legacy no-secret fallback (still used by some test paths).
  // Declared here (rather than beside the server construction) because `revalidate` below is the
  // second entrance to the same trust boundary and must be configured identically.
  const trustInternalHeaders = process.env.TRUST_INTERNAL_HEADERS === "1";

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
    // N33: this is the SECOND door into handleRequest (Pages `res.revalidate()` re-enters the
    // pipeline in-process), and it used to skip everything createPoolServer installs — the
    // untrusted-dispatch-header strip, the internal-response-header strip, and guardStreamErrors —
    // while handleRequest still reads `x-output-id`/`x-mw-evaluated` as trusted. Not exploitable
    // today (Next builds those internal headers itself) but a trust boundary with two entrances,
    // one of them unguarded, is one bad `headers` pass-through away from being one. Both callers
    // now share the same boundary function.
    applyRequestTrustBoundary(
      mocked.req as unknown as IncomingMessage,
      mocked.res as unknown as ServerResponse,
      { internalSecret, trustInternalHeaders },
    );
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
  // Register the same fn on the router-server-methods global (the slot every sibling
  // adapter leaves unfilled — sibling survey 2026-08-01): route modules resolve
  // routerServerContext[relativeProjectDir] from this symbol when no requestMeta channel is
  // present, and the edge sandbox mirrors the symbol into its context (sandbox.js), so edge
  // API routes get the in-process res.revalidate() path too.
  {
    const routerGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;
    const RouterServerContextSymbol = Symbol.for("@next/router-server-methods");
    const existing =
      (routerGlobal[RouterServerContextSymbol] as Record<string, unknown> | undefined) ?? {};
    routerGlobal[RouterServerContextSymbol] = {
      ...existing,
      ".": { ...(existing["."] as object | undefined), revalidate },
    };
  }
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
  // N30 (SECURITY/CACHE): the pool's OWN PPR inventory, so the `no-store` verdict survives every
  // path that never sees the ext_proc tier's `x-nextjs-ppr` header. See createPprRouteMatcher.
  const isLocallyKnownPprRoute = createPprRouteMatcher({
    pprRoutes: routingManifest.pprRoutes,
    pprCapableRoutes: routingManifest.pprCapableRoutes,
    basePath: routingManifest.basePath ?? "",
    i18nLocales: (routingManifest.i18n as { locales?: string[] } | null)?.locales ?? [],
    rscConfig: poolRscConfig,
  });
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
    runtimeStaticTemplates,
    prerenderedPaths,
    // Next's OWN build id (manifest) — clients build /_next/data URLs from the id Next
    // inlined, which under deploymentId mode is NOT the adapter's effective NEXT_BUILD_ID.
    buildIdForData: routingManifest.buildId ?? buildId,
    internalSecret,
    basePath: routingManifest.basePath ?? "",
    i18nLocales: (routingManifest.i18n as { locales?: string[] } | null)?.locales ?? [],
    // Build timestamp anchoring the ISR seed-freshness window. Newer adapters write it
    // into the routing manifest; read defensively — older manifests (and any build
    // without it) fall back to pod-start anchoring inside the dispatcher.
    builtAt: (routingManifest as { builtAt?: string }).builtAt,
    routeExecutionTimeouts: routingManifest.routeExecutionTimeouts,
    poolResponseHeadTimeouts: routingManifest.poolResponseHeadTimeouts,
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
    // Cache-components builds prerender /_not-found; the deployed contract then serves that
    // prerender for subresource requests (not-found-non-document), while a dynamic app keeps
    // next start's text/plain (not-found-non-document-dynamic).
    notFoundIsPrerendered: notFoundIsPrerenderedBuild(process.cwd()),
    partialPrefetching: partialPrefetchingEnabled(process.cwd()),
    ...(valkeyHandler
      ? {
          checkShellStale: (tags: string[]) =>
            valkeyHandler!.getExpiration(tags).then((e) => e > 0),
        }
      : {}),
    // PPR MATERIALIZATION (see dispatch.ts platformCache): the pool's own READ-ONLY view of
    // the shared incremental cache. Reads go through the classic Valkey handler (get() owns
    // tag staleness and falls back to the build seed via the SAME fs-mirror the registered
    // in-app handler uses). Nothing writes through this interface — regeneration re-enters
    // Next via the registered `revalidate()` and Next's own handler persists the entry.
    // Regeneration fires whenever the build has a preview identity (__NEXT_PREVIEW_MODE_ID,
    // loaded unconditionally from the prerender manifest at startup) — it is always-on, not
    // flag-gated.
    ...(platformCacheHandler
      ? {
          platformCache: {
            // getPeek, NOT get: dispatch reads entries to SERVE them and never
            // revalidates from these paths — get()'s single-flight lock consumption
            // starved the entrypoint's own revalidation (told FRESH, never regenerated;
            // rdc stale-forever, traced 2026-08-04). Only Next's own reads through the
            // registered cacheHandler may spend the lock.
            read: (key: string, ctx?: { kind?: string }) =>
              platformCacheHandler!.getPeek(key, ctx ?? {}),
            readStored: (key: string, ctx?: { kind?: string }) =>
              platformCacheHandler!.getStored(key, ctx ?? {}),
            readSeed: (key: string, ctx?: { kind?: string }) =>
              platformCacheHandler!.getSeed(key, ctx ?? {}),
          },
        }
      : {}),
  });

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
    // S2 (SECURITY). Coverage here is PATH-ONLY — `has`/`missing` deliberately ignored.
    //
    // A full `matchesMiddleware` verdict is per-REQUEST, because those conditions read this
    // request's own cookies and headers. But every consumer in this function decides something
    // whose effect outlives one request: the forced CDN cache-control verdict, and the
    // static/`_next/data` fast paths that skip resolution. The CDN entry they govern is SHARED,
    // and the cache key holds neither `Cookie` nor `Authorization` — so the request that does
    // NOT match a conditional matcher would fill the cache with a shared-cacheable body that
    // the request which DOES match then hits, ahead of the post-cache extension, with
    // middleware never running. Treating a conditionally-covered path as covered is the only
    // verdict that is correct for a shared consequence.
    //
    // The decision to actually RUN middleware is not made here — it belongs to resolve(), which
    // evaluates the conditions per request as `next start` does. See routing-common.ts
    // (matchesMiddleware vs middlewareMayCoverPath).
    const middlewareMayCover =
      !!(middlewareModule || edgeMiddlewareRunner) &&
      middlewareMayCoverPath(middlewareMatchers, url);

    // A path-based assetPrefix (e.g. "/assets") prefixes `_next/static` URLs; strip it so those
    // requests are served/404'd like un-prefixed ones. (URL assetPrefixes point at a separate host,
    // so those requests never reach the pool.) Computed here rather than at the serve site because
    // the PPR verdict below has to know whether this request is a filesystem serve at all.
    const basePath = routingManifest.basePath ?? "";
    const staticPathname =
      assetPrefix && url.pathname.startsWith(assetPrefix + "/_next/static/")
        ? url.pathname.slice(assetPrefix.length)
        : url.pathname;
    // True for a request the pool answers from disk/the static manifest as a PLAIN asset —
    // `/_next/*` (chunks, data payloads, the optimizer) and manifest entries that are not
    // prerenders (public/ files, build assets). Prerenders are deliberately NOT plain assets: a
    // PPR route has a manifest entry of its own and must keep its PPR verdict. Without this
    // exclusion a root optional catch-all PPR template (`/[[...slug]]`) matches every asset URL
    // and would force `no-store` onto immutable chunks that `next start` serves `immutable`.
    const servedAsPlainAsset =
      staticPathname.startsWith("/_next/") ||
      stripBasePath(url.pathname, basePath).startsWith("/_next/") ||
      staticAssets.some(
        (a) =>
          !a.prerender &&
          (a.pathname === url.pathname ||
            a.pathname ===
              (url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname + "/")),
      );

    // next.config headers() + middleware response headers, serialized by the routing
    // extension (secret-gated: server.ts already stripped the header unless the request
    // proved trust). Parsed ONCE here — the forced cache-policy wrapper below must see an
    // explicit app-owned cache-control before any response is written, and the Phase-2
    // dispatch reuses the same parse. Deleted immediately so it can never leak to handlers.
    const extResolvedHeaders = parseResolvedHeaders(
      req.headers["x-resolved-headers"] as string | undefined,
    );
    delete req.headers["x-resolved-headers"];
    // N40 (SECURITY). The middleware's FINAL request-header set, stamped by the routing
    // extension (routing-service/handler.ts) and secret-gated exactly like
    // `x-resolved-headers` — server.ts already stripped it unless the request proved trust.
    // `responseToMiddlewareResult` has already resolved the override list into it, so this is
    // the authoritative REPLACEMENT set for `req.headers` (a header absent from the set means
    // DELETED); dispatch.ts installs it that way for Phase 1
    // (`resolution.middlewareRequestHeaders`) and the Phase-2 branch below now feeds the same
    // field. Without it, `NextResponse.next({ request: { headers } })` was a total no-op in
    // production — a middleware that strips a spoofed `x-user-id` or stamps
    // `x-authenticated-user` accomplished NEITHER at the edge, while `x-mw-evaluated: ran`
    // told this pool the middleware stage was already complete, so the client's spoofed header
    // reached the handler unmodified. Parsed with the SAME reader as `x-resolved-headers` (one
    // wire shape) and deleted immediately so it can never leak to a handler on either phase.
    const extMwRequestHeaders = parseResolvedHeaders(
      req.headers["x-mw-request-headers"] as string | undefined,
    );
    delete req.headers["x-mw-request-headers"];

    // The explicit app-owned cache-control for this request, if any: from the routing
    // extension's resolved verdict (Phase 2, above) or from local resolution (Phase 1
    // fills this in after resolve()). The forced-cache wrapper reads it lazily at
    // writeHead time — every response write happens after the owning phase populated it.
    let appCacheControl: string | null = extResolvedHeaders?.get("cache-control") ?? null;

    // Force the CDN caching verdict for three kinds of request (anything else keeps its origin
    // Cache-Control):
    //   • PPR routes stream a per-request dynamic resume onto the shell, so the response must
    //     never be edge-cached — `no-store`. Chunked encoding alone does NOT stop Cloud CDN
    //     from caching (proven), so this override is required. N30: the verdict is computed
    //     LOCALLY from this build's PPR inventory; the routing service's `x-nextjs-ppr`
    //     dispatch header is only a hint that can confirm it, never the sole source.
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
    // N30 (SECURITY/CACHE): compute the PPR verdict LOCALLY and treat `x-nextjs-ppr` as a hint.
    // The header is stamped only by the ext_proc tier, so relying on it lost the verdict on every
    // pool-only path (ext_proc fail-open, CEL-excluded path, an app with no middleware and hence
    // no extension at all, a timeout shed, a body request, a cross-pool hop) — and the fail-safe
    // path then passed the entrypoint's `s-maxage=31536000` through with NO cache-tag, so Cloud
    // CDN stored an unfinished shell for a year that cutover invalidation could never purge (the
    // M13 stale-apex class). `next start` answers a PPR document `private, no-cache, no-store,
    // max-age=0, must-revalidate` (measured, Next 16.2.10). The trusted output id is preferred
    // when present (it is the exact route the upstream resolved); otherwise the request pathname
    // is matched against the local PPR inventory. Untrusted dispatch headers were already
    // stripped in server.ts, so reading x-output-id here cannot be steered by a client.
    const extPprOutputId = req.headers["x-output-id"];
    const isPprRoute =
      req.headers["x-nextjs-ppr"] === "1" ||
      (typeof extPprOutputId === "string" && isLocallyKnownPprRoute(extPprOutputId)) ||
      (!servedAsPlainAsset && isLocallyKnownPprRoute(url.pathname));
    const forcedCacheControl = forcedCdnCacheControl({
      isPprRoute,
      // S2: path-only. A conditionally-covered route must be treated as covered here —
      // the cache entry this decides is shared across requests whose has/missing verdicts
      // differ, and the cache key cannot partition on a cookie.
      middlewareCovers: middlewareMayCover,
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
    if (!middlewareMayCover && staticPathname.startsWith("/_next/static/")) {
      const filePath = path.join(
        process.cwd(),
        ".next",
        "static",
        staticPathname.slice("/_next/static/".length),
      );
      if (existsSync(filePath)) {
        // N31: a build asset answers GET/HEAD only. `next start`'s router-server sets
        // `Allow: GET, HEAD` and 405s every other method BEFORE serveStatic (measured:
        // POST/PUT/DELETE on a chunk → 405; the adapter used to answer 200 with the full body
        // AND the deploy cache-tag, having read and discarded the request body). Placed before
        // the read so an oversized write to an asset URL is refused without buffering it.
        if (!isReadMethod(req.method)) {
          methodNotAllowed(res);
          return;
        }
        // Mirror Next's own server: service workers are revalidated (not immutable) and get
        // Service-Worker-Allowed; every other _next/static asset is immutable.
        const { cacheControl, headers } = nextStaticAssetHeaders(staticPathname, basePath);
        // S14: memoized per file — see staticAssetEtagForFile. Build chunks are immutable
        // within a build, so re-hashing them per request was pure waste (and a full
        // synchronous read of a multi-hundred-KiB chunk on the event loop each time).
        const staticStat = statSync(filePath);
        const etag = staticAssetEtagForFile(filePath, staticStat, () => readFileSync(filePath));
        const responseHeaders = {
          "content-type": getContentType(staticPathname),
          "cache-control": cacheControl,
          etag,
          ...headers,
        };
        if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
          res.writeHead(304, responseHeaders);
          res.end();
          return;
        }
        res.writeHead(200, {
          ...responseHeaders,
          // N31: REQUIRED for HEAD — Node marks a HEAD response as body-less and then emits
          // NEITHER Content-Length NOR Transfer-Encoding, so a HEAD reported no size at all
          // where `next start` answers with the real Content-Length (measured: 309404 for a
          // fixture chunk). Same bug the image optimizer already fixed; see sendImageResponse.
          "content-length": String(staticStat.size),
        });
        // S14: HEAD sends no body; a large asset is streamed rather than held resident.
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        if (staticStat.size > STATIC_STREAM_THRESHOLD_BYTES) {
          pipeline(createReadStream(filePath), res, () => undefined);
          return;
        }
        res.end(readFileSync(filePath));
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
    // Next's own build id (see buildIdForData above) — clients inline it into data URLs.
    const dataPrefix = `${basePath}/_next/data/${routingManifest.buildId ?? buildId}/`;
    let pagesDataRoutingUrl: URL | undefined;
    if (!middlewareMayCover && url.pathname.startsWith(dataPrefix)) {
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
        // N30 (SECURITY): this serve is `.next/server/pages` — the ENTIRE Pages server build.
        // With no `.json` requirement and no inventory check it was a read primitive over that
        // directory for anyone who knows the build id (it is public, in every asset URL).
        // Measured against `next start` on a real fixture: `/_next/data/<id>/_app.js` → 200 with
        // the compiled server bundle, `_app.js.map` → 200 (⇒ original TypeScript source),
        // `_app.js.nft.json` → 200 with absolute build-machine paths; `next start` 404s all
        // three. Note `.json` ALONE is not enough — `_app.js.nft.json` ends in `.json` — so the
        // page the data URL maps to must also be a real prerender of this build. `next start`
        // 404s a data URL for a page with no data route too (measured: `/index.json` for a
        // static `/` with no getStaticProps, and the un-prefixed `/ssg.json` in an i18n app),
        // which is exactly what this inventory check reproduces.
        const dataPageIsPrerendered =
          trailingSlashVariants(pagePath).some((variant) => prerenderedPaths.has(variant)) ||
          staticAssets.some(
            (a) =>
              a.prerender &&
              (a.pathname === pagePath ||
                a.pathname === (pagePath === (basePath || "/") ? `${basePath}/index` : pagePath)),
          );
        // Containment is re-asserted at the point of consumption even though WHATWG URL
        // normalization already collapses `..`/`%2e%2e` and never decodes `%2f`.
        const filePath = dataPath.endsWith(".json")
          ? resolveWithinRoot(path.join(process.cwd(), ".next", "server", "pages"), dataPath)
          : null;
        // Draft mode bypasses the static serve (survey Tier 1 #2): an AUTHENTICATED
        // `__prerender_bypass` cookie (validated constant-time against the build's
        // previewModeId, same gate as the strict-404 yield in dispatch.ts) must fall through
        // to a live render, exactly as `next start` does. An invalid cookie value changes
        // nothing — honoring arbitrary values would let any client bust this tier.
        if (
          dataPageIsPrerendered &&
          filePath &&
          existsSync(filePath) &&
          !isVerifiedPreviewRequest(req)
        ) {
          const content = readFileSync(filePath);
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=0, must-revalidate",
            "content-length": String(content.length),
          });
          res.end(req.method === "HEAD" ? undefined : content);
          return;
        }
        // Anything else falls through to normal resolution exactly as before — deliberately,
        // not a flat 404: a data route owned by ANOTHER pool has no handler and no file here and
        // must still reach the cross-pool proxy, and an unknown data URL then gets the app's own
        // 404 page, which is what `next start` answers (404, text/html, the rendered 404).
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

    const headers = requestHeaders(req);

    let bodyBuffer: Buffer | null;
    try {
      bodyBuffer = isReadMethod(req.method) ? null : await readRequestBody(req, res);
    } catch (err) {
      const overLimit = err instanceof BodyTooLargeError;
      const overBudget = err instanceof BodyBudgetExceededError;
      if (overLimit || overBudget) {
        // readRequestBody deliberately left the socket alive (paused, not destroyed):
        // destroying first turns the 413 into an ECONNRESET the client can't read.
        // Say we're closing, flush the response, and only then tear the socket down
        // so the remainder of the oversized upload can't pin the connection.
        //
        // N34: the process-wide budget answers 503 + Retry-After, not 413 — the request itself
        // was within the per-request limit; the POD is out of admission capacity. That is the
        // distinction a client (and an operator reading logs) needs, and 503 is the status a
        // load balancer will retry elsewhere.
        if (overBudget) {
          console.warn(
            `[pool-server] refusing upload: in-flight request bodies would exceed ` +
              `${MAX_INFLIGHT_BODY_BYTES} bytes (ADAPTER_K8S_MAX_INFLIGHT_BODY_BYTES)`,
          );
        }
        res.writeHead(overBudget ? 503 : 413, {
          "content-type": "text/plain; charset=utf-8",
          connection: "close",
          ...(overBudget ? { "retry-after": "1", "cache-control": "no-store" } : {}),
        });
        res.end(overBudget ? "Service Unavailable" : "Payload Too Large");
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

    const requestHasBasePath =
      !basePath || url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    const imagePlatformPath = requestHasBasePath
      ? stripBasePath(url.pathname, basePath)
      : url.pathname;
    const isImageRequest =
      requestHasBasePath &&
      (imagePlatformPath === "/_next/image" || imagePlatformPath === "/_next/image/");
    const upstreamMiddlewareVerdict = req.headers["x-mw-evaluated"];
    const upstreamAlreadyResolved =
      typeof upstreamMiddlewareVerdict === "string" &&
      MW_EVALUATED_TRUSTED.has(upstreamMiddlewareVerdict);
    const upstreamInvokePath = req.headers["x-invoke-path"];
    const upstreamRewrotePlatform =
      upstreamAlreadyResolved &&
      typeof upstreamInvokePath === "string" &&
      !targetsSamePlatformUrl(upstreamInvokePath, url);
    const shouldHandleImage = isImageRequest && !upstreamRewrotePlatform;

    // Next routing runs before the optimizer for every method. Redirects, middleware-authored
    // responses and rewrites away from the optimizer are terminal. An unchanged app catch-all is
    // not: BaseServer gives its platform image route priority over the selected page output.
    if (shouldHandleImage && upstreamAlreadyResolved) {
      // A trusted routing extension already ran this phase. Reuse its result rather than running
      // middleware twice; body-capable requests never carry this assertion because the header-only
      // extension deliberately hands those to the pool for local resolution.
      applyMiddlewareRequestHeaders(req, extMwRequestHeaders);
      installResolvedResponseHeaders(res, extResolvedHeaders);
    } else if (shouldHandleImage) {
      const resolution = await resolvePlatformRequest(
        resolver,
        url,
        headers,
        req.method ?? "GET",
        createBufferedStream(bodyBuffer),
      );
      if (resolution.kind !== "continue-platform") {
        await dispatcher.dispatch(req, res, resolution);
        return;
      }
      applyMiddlewareRequestHeaders(req, resolution.middlewareRequestHeaders);
      installResolvedResponseHeaders(res, resolution.resolvedHeaders);
      if (appCacheControl === null) {
        appCacheControl = resolution.resolvedHeaders?.get("cache-control") ?? null;
      }
    }

    // Basic image optimization: /_next/image?url=...&w=...&q=...
    // Fetches the source image and serves it (with optimization if Sharp is available).
    // Both forms: a custom images.loaderFile commonly emits `/_next/image/?url=…` (the
    // upstream loader-config fixture does), and `trailingSlash: true` apps mirror it. The
    // exact match silently bypassed the optimizer for the slash form (canary.97 catch-up ②).
    if (shouldHandleImage) {
      // The `url` gate FIRST, then `w`/`q` — upstream's order, and observable: with
      // `?url=/_next/image&w=16` `next start` answers "cannot be recursive" while the
      // adapter used to answer `"w" parameter (width) of 16 is not allowed`. See
      // validateImageUrlParam for the port, the measurements, and what each branch guards
      // (the recursion cap, the 3072-byte length cap, the protocol-relative refusal, and
      // both allowlists).
      const urlParam = validateImageUrlParam(url.searchParams, {
        hasLocalMatch: (value) => hasLocalImageMatch(value, imageConfig.localPatterns),
        isRemoteAllowed: (target) => isExternalImageAllowed(target, imageConfig),
      });
      if ("errorMessage" in urlParam) {
        sendImageError(res, 400, urlParam.errorMessage);
        return;
      }
      const imageUrl = urlParam.url;
      // S26. What is safe to LOG. `params.get("url")` percent-DECODES, so `imageUrl` carries
      // the raw query string of an absolute source — routinely a pre-signed credential
      // (`X-Goog-Signature`, an AWS presign) — and any `%0a` in it has already become a real
      // newline, i.e. log forging. server.ts logs only the pathname for exactly this reason;
      // the optimizer's two log lines printed the whole thing.
      const loggableImageUrl = redactImageUrlForLog(imageUrl);

      // Validate w/q against Next's resolved image config before they reach Sharp — see
      // validateImageSizeAndQuality for the port and the measurements. Two things ride on
      // this: an unbounded `w` (w=999999) drives Sharp into a huge allocation, and every
      // ACCEPTED (w, q) pair is an additional CDN cache entry plus an additional encode,
      // so the allowed sets are the amplification bound as much as they are parity.
      const params = validateImageSizeAndQuality(url.searchParams, imageConfig);
      if ("errorMessage" in params) {
        // Byte-for-byte the body `next start` sends, and — like every other optimizer error
        // — with no Content-Type at all (see sendImageError).
        sendImageError(res, 400, params.errorMessage);
        return;
      }
      const { width, quality } = params;
      const accept = String(req.headers["accept"] ?? "");

      // The optimizer pipeline as ONE unit of work: acquire the source, sniff it, negotiate the
      // output format, encode. It takes its admission (S32) as an argument because the source
      // read below is the thing being bounded, and it RETURNS an outcome instead of writing to
      // `res` because up to N requests share this one run (runOrJoinImageOptimization).
      //
      // It reads the leader request's `accept` — sound, and not an accident of who arrived
      // first: the single-flight key pins negotiateImageMimeType(accept, formats), which is the
      // only thing negotiation consults the header for, so every request sharing a key
      // negotiates the same output.
      const optimizeImage = async (
        admission: ImageAdmission,
      ): Promise<ImageOptimizationOutcome> => {
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

        // Upstream's own `isAbsolute`, decided once by validateImageUrlParam, rather than a
        // second `startsWith("/")` test that could drift from the one that validated it.
        if (!urlParam.isAbsolute) {
          // Internal image: read from filesystem. The path is the url's DECODED PATHNAME
          // (validateImageUrlParam), not the raw url — which is upstream's derivation and
          // the reason `?url=/test.png%23a`, `?url=/test.png%3F` and a trailing `%0A` all
          // resolve to public/test.png the way `next start` does instead of 400ing on a
          // literal `public/test.png#a` miss. resolveWithinRoot below stays the traversal
          // guard, and still has work to do: WHATWG normalization collapses `..` AND
          // `%2e%2e` dot segments (both are "double-dot path segments" to the parser, so
          // `/%2e%2e/x` becomes `/x` — measured), but an ENCODED SEPARATOR does not decode
          // until afterwards, so `/..%2f..%2fpackage.json` reaches here intact and must be
          // refused. Pinned by test in tests/pool-server/index.image.test.ts.
          const decodedImagePath = urlParam.pathname;
          const filesystemImagePath = stripBasePath(decodedImagePath, basePath);
          const publicImagePath =
            basePath &&
            decodedImagePath !== basePath &&
            !decodedImagePath.startsWith(`${basePath}/`)
              ? `${basePath}${decodedImagePath}`
              : decodedImagePath;
          const publicRoot = path.join(process.cwd(), "public");
          const staticRoot = path.join(process.cwd(), ".next", "static");
          const publicFile = resolveWithinRoot(publicRoot, filesystemImagePath);
          const staticFile = filesystemImagePath.startsWith("/_next/static/")
            ? resolveWithinRoot(staticRoot, filesystemImagePath.slice("/_next/static/".length))
            : null;

          // A null result means the path escaped its root — reject traversal.
          if (
            publicFile === null ||
            (filesystemImagePath.startsWith("/_next/static/") && staticFile === null)
          ) {
            // No exact upstream counterpart: upstream NORMALIZES `..` away in
            // `new URL(url, "http://n")` and then simply misses the file, answering
            // `400 The requested resource isn't a valid image.`. This adapter refuses the
            // traversal outright instead of normalizing it, so it borrows upstream's
            // closest 400 wording rather than inventing one.
            return { kind: "error", status: 400, body: '"url" parameter is not allowed' };
          }

          // Matches Next's `isStatic` check (`${basePath}/_next/static/media` and the
          // `immutable/media` variant), evaluated on the DECODED path so an encoded
          // prefix can't claim immutability for a public/ file.
          isStaticSource =
            filesystemImagePath.startsWith("/_next/static/media/") ||
            filesystemImagePath.startsWith("/_next/static/immutable/media/");

          // S3 (SECURITY + PARITY). Does middleware cover the SOURCE pathname? If so the disk
          // read below would serve bytes middleware was supposed to gate: the sibling fast
          // paths (`/_next/static/`, `/_next/data/`) both refuse to short-circuit a covered
          // path, and this one did not — so `GET /_next/image?url=/gated.png` returned
          // `public/gated.png` even when middleware on `/gated.png` denies the request, and
          // sendImageResponse then made those bytes CDN-cacheable.
          //
          // It is also what `next start` does: upstream's fetchInternalImage
          // (next/server/image-optimizer.ts) resolves a relative source through
          // `this.routerServerHandler` — the FULL request pipeline, middleware included — not
          // a filesystem read. Falling through to the loopback self-fetch below is exactly
          // that re-entry, and it already exists for sources that miss on disk.
          //
          // Path-only coverage (middlewareMayCoverPath) is deliberate: the optimizer's own
          // response is cacheable, so a conditionally-covered source must take the re-entry
          // for every request, not just the ones whose has/missing match (see S2).
          const sourceCoveredByMiddleware =
            !!(middlewareModule || edgeMiddlewareRunner) &&
            middlewareMayCoverPath(middlewareMatchers, new URL(`${url.origin}${publicImagePath}`));

          let localImageFile: string | null = null;
          let localImageSize = 0;
          if (!sourceCoveredByMiddleware && existsSync(publicFile)) {
            const publicStat = statSync(publicFile);
            if (!publicStat.isDirectory()) {
              localImageFile = publicFile;
              localImageSize = publicStat.size;
            }
          }
          if (
            !localImageFile &&
            !sourceCoveredByMiddleware &&
            staticFile &&
            existsSync(staticFile)
          ) {
            const staticStat = statSync(staticFile);
            if (!staticStat.isDirectory()) {
              localImageFile = staticFile;
              localImageSize = staticStat.size;
            }
          }

          if (localImageFile) {
            // S42 (AVAILABILITY). Admission reserves MAX_IMAGE_BYTES before source I/O, but the
            // old local fast paths allocated the whole file and only trued-up accounting after
            // the fact. A build-authored oversized public or .next/static image therefore
            // bypassed both the per-image cap and the process-wide reservation. Stat first and
            // refuse it before readFileSync can allocate or block on those bytes.
            if (localImageSize > MAX_IMAGE_BYTES) {
              return {
                kind: "error",
                status: 413,
                body: '"url" parameter is valid but internal response is invalid',
              };
            }
            imageBuffer = readFileSync(localImageFile);
          } else {
            // Fetch from ourselves (same-origin relative image, e.g. served by a route).
            // Bound it: a 5s timeout so a slow/hung origin can't pin the request, and the
            // SHARED MAX_IMAGE_BYTES cap (N35) so an oversized body can't exhaust memory —
            // the same number the external path enforces, which it previously did not.
            //
            // The re-entry URL is the RAW validated `url` param, not the decoded pathname:
            // upstream's fetchInternalImage hands the raw url to the full request pipeline,
            // so `?url=%2Fapi%2Fog%3Ftitle%3DX` must reach the route as /api/og?title=X —
            // the decoded pathname has the query stripped and re-decodes `%23`/`%3F` into
            // characters that re-parse as fragment/query separators. basePath is prefixed
            // exactly when the decoded-pathname check above decided it was missing.
            const loopbackUrl =
              publicImagePath === decodedImagePath ? urlParam.url : `${basePath}${urlParam.url}`;
            const selfUrl = `http://127.0.0.1:${port}${loopbackUrl}`;
            const imgRes = await fetch(selfUrl, {
              signal: AbortSignal.timeout(5000),
              // The EXTERNAL path re-validates every redirect hop against the SSRF
              // allowlist; this loopback fetch has no such machinery. Refuse redirects
              // outright rather than let a same-origin route bounce the optimizer to
              // an unvetted target (or back into the optimizer itself).
              redirect: "manual",
            });
            if (imgRes.status >= 300 && imgRes.status < 400) {
              // Adapter-specific, so the adapter's own wording stays: upstream's internal
              // fetch is in-process and has no redirect to refuse, and 502 says what
              // happened (an upstream we would not follow) better than upstream's generic
              // 500. Only the Content-Type is dropped, for consistency with every other
              // optimizer error.
              return {
                kind: "error",
                status: 502,
                body: "Failed to fetch image: redirect not followed",
              };
            }
            // Deliberately NO `!imgRes.ok` rejection: upstream's `fetchInternalImage` only
            // checks that a status exists and that the body is non-empty, so a route
            // answering 404/500 flows on to the byte sniff and comes back as
            // `400 The requested resource isn't a valid image.` — measured for a missing
            // local file (`?url=/does-not-exist.png`) and for a `%00` in the path, both of
            // which this adapter used to answer with a 404 whose body ECHOED the url.
            // isOptimizableImageContentType below, not this branch, is what keeps an error
            // page's bytes from ever being served back.
            const declaredLen = parseInt(imgRes.headers.get("content-length") ?? "", 10);
            if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
              return {
                kind: "error",
                status: 413,
                body: '"url" parameter is valid but internal response is invalid',
              };
            }
            const streamedBody = await readWebBodyWithLimit(imgRes.body, MAX_IMAGE_BYTES);
            if (streamedBody === null) {
              return {
                kind: "error",
                status: 413,
                body: '"url" parameter is valid but internal response is invalid',
              };
            }
            if (streamedBody.length === 0) {
              // Upstream's `mocked.res.buffers.length === 0` branch.
              return {
                kind: "error",
                status: 400,
                body: '"url" parameter is valid but internal response is invalid',
              };
            }
            imageBuffer = streamedBody;
            // A route-served image has no meaningful extension (e.g. /api/tiny-png) —
            // the response's own Content-Type is the fallback, not an extension guess.
            selfFetchContentType = imgRes.headers.get("content-type");
            upstreamCacheControl = imgRes.headers.get("cache-control");
          }
          contentType = selfFetchContentType ?? getContentType(filesystemImagePath);
        } else {
          // External image: only fetch allowlisted http(s) hosts, and only after
          // confirming the host resolves to a public address (SSRF / DNS-rebind guard).
          // The URL was parsed, protocol-checked and allowlist-checked by
          // validateImageUrlParam above; fetchExternalImageSafely re-checks the allowlist
          // (and the public-address rule) for the initial target AND every redirect hop.
          const fetched = await fetchExternalImageSafely(urlParam.target, imageConfig);
          if ("error" in fetched) {
            // The reason is logged, never sent — see IMAGE_FETCH_ERROR_RESPONSE.
            console.error(`[pool-server] /_next/image upstream fetch failed: ${fetched.error}`);
            const mapped = IMAGE_FETCH_ERROR_RESPONSE[fetched.error];
            return { kind: "error", status: mapped.status, body: mapped.body };
          }
          if (!fetched.ok) {
            // Upstream forwards the UPSTREAM's status here (an allowlisted host answering
            // 404 gives a 404, measured), and ImageError coerces anything < 400 to 500.
            console.error(
              `[pool-server] /_next/image upstream responded ${fetched.status} for an ` +
                `allowlisted external image`,
            );
            return {
              kind: "error",
              status: fetched.status >= 400 ? fetched.status : 500,
              body: '"url" parameter is valid but upstream response is invalid',
            };
          }
          imageBuffer = fetched.body;
          contentType = fetched.contentType;
          upstreamCacheControl = fetched.cacheControl;
        }

        // S32: the source is resident from here on, so replace the worst-case reservation with
        // what it actually costs. One call for every branch above — a disk read, a loopback
        // self-fetch and an external fetch all end up holding exactly one buffer.
        admission.settleSourceBytes(imageBuffer.length);

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
          // Byte-for-byte the body `next start` sends for this case.
          return {
            kind: "error",
            status: 400,
            body: "The requested resource isn't a valid image.",
          };
        }

        // `next start` parity: SVG never goes through the optimizer by default — Next
        // 400s it unless images.dangerouslyAllowSVG is set, and then serves it with
        // Content-Disposition: attachment plus the configured CSP so a crafted SVG
        // can't run script in the site's origin. This gate runs BEFORE any sharp
        // handling: the verdict must not depend on the optimizer being present.
        if (contentType.toLowerCase().includes("svg")) {
          if (!imageConfig.dangerouslyAllowSVG) {
            // Byte-for-byte the body `next start` sends for this case.
            return {
              kind: "error",
              status: 400,
              body: '"url" parameter is valid but image type is not allowed',
            };
          }
          // The SVG branch is not special-cased for headers any more: `next start` sends
          // the same Content-Disposition/CSP/ETag/Cache-Control set on every optimizer
          // 200, SVG included (the filename now carries the real source name and `.svg`
          // instead of the placeholder `attachment; filename="image"`).
          return {
            kind: "image",
            body: imageBuffer,
            contentType,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
          };
        }

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
          return {
            kind: "image",
            body: imageBuffer,
            contentType: outType,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
          };
        }

        // Optimize with Sharp. A MISSING sharp still fails closed with a 503: it means the
        // image stack is broken (production images always ship sharp), not that unvalidated
        // passthrough is safe. A sharp that loads but cannot DECODE the input falls back to
        // the source bytes — see the catch below, which is where `next start` parity lives
        // and where the safety conditions on that fallback are spelled out.
        const sharp = loadSharpOnce();
        if (!sharp) {
          // The load failure (with its cause) was logged once by loadSharpOnce. No upstream
          // counterpart — upstream cannot start without sharp — so the wording is the
          // adapter's own; only the absent Content-Type is borrowed.
          return { kind: "error", status: 503, body: "Image optimization unavailable" };
        }
        // S32: no acquire here any more. The slot that used to be taken at THIS point — after
        // the source was already resident — is now taken by the caller before any of the above
        // runs, which is the whole correction (see the admission block).
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
          return {
            kind: "image",
            body: optimized,
            contentType: outType,
            isStatic: isStaticSource,
            maxAge: imageMaxAgeSeconds,
          };
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
          //   • it is returned as a normal `image` outcome, so it goes through
          //     sendImageResponse and carries the same
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
              `[pool-server] /_next/image could not optimize ${loggableImageUrl} (${contentType}) — ` +
                `serving the source bytes as next start does: ${message}`,
            );
            return {
              kind: "image",
              body: imageBuffer,
              contentType: sniffedContentType,
              isStatic: isStaticSource,
              maxAge: imageConfig.minimumCacheTTL,
            };
          }
          // No signature matched, so the only candidate type is the upstream header or the
          // URL's extension — a guess. Upstream 400s this case before sharp ever runs; the
          // adapter keeps the guess for the format decision but refuses to SERVE bytes
          // under it. Log the actual failure: the live 502s for /api/tiny-png were
          // undebuggable without it (the cause turned out to be a broken sharp module, see
          // loadSharpOnce — but a genuinely corrupt input lands here too).
          console.error(
            `[pool-server] /_next/image failed to process ${loggableImageUrl} (${contentType}):`,
            message,
          );
          return { kind: "error", status: 502, body: "Failed to process image" };
        }
      };

      // S32(b): the single-flight key, built from what is known BEFORE any I/O. The url
      // component is the exact string the I/O below will use — the raw `?url=` for a local
      // source (the loopback self-fetch replays it verbatim, query included) and the
      // WHATWG-normalized target for an absolute one (which is the string
      // fetchExternalImageSafely requests). Nothing here is normalized more aggressively than
      // the I/O is, so two requests can only share a key if they would have done the same work.
      // `width`/`quality` are validated integers and the mime comes from a fixed set, so the
      // leading fields cannot contain the separator and the key is unambiguous however exotic
      // the url is.
      const outputMimeForKey = negotiateImageMimeType(accept, imageConfig.formats) ?? "source";
      const optimizeKey = `${width}|${quality}|${outputMimeForKey}|${
        urlParam.isAbsolute ? urlParam.target.toString() : urlParam.url
      }`;

      let outcome: ImageOptimizationOutcome;
      try {
        outcome = await runOrJoinImageOptimization(optimizeKey, async () => {
          // S32(a): admission BEFORE the source read, so a queued request holds nothing but its
          // request state. Only the request that actually runs the work takes a slot; the ones
          // that join an in-flight key hold no source memory at all and so need none.
          const admission = await acquireImageAdmission();
          if (!admission) {
            // Shed rather than park: same 503 the encode semaphore used to answer with, now
            // answered before a single byte of source has been read.
            return { kind: "error", status: 503, body: "Image optimization unavailable" };
          }
          try {
            return await optimizeImage(admission);
          } finally {
            admission.release();
          }
        });
      } catch (err) {
        console.error("Image optimization error:", err);
        if (!res.headersSent) {
          sendImageError(res, 500, "Image optimization failed");
        }
        return;
      }
      if (outcome.kind === "error") {
        sendImageError(res, outcome.status, outcome.body);
        return;
      }
      // Everything request-SPECIFIC happens here, outside the shared work: If-None-Match → 304,
      // HEAD, and the Content-Disposition filename (derived from `?url=`, which is in the key).
      sendImageResponse(req, res, {
        body: outcome.body,
        contentType: outcome.contentType,
        sourceUrl: imageUrl,
        isStatic: outcome.isStatic,
        maxAge: outcome.maxAge,
        config: imageConfig,
        buildId,
      });
      return;
    }

    // public/ files deliberately have NO pre-routing fast path here. They are in the
    // static-assets manifest (see emit/static-assets.ts), so Phase 2 serves them via
    // dispatcher.dispatch and Phase 1 via resolve() → dispatch — both of which merge the
    // resolved routing verdict (next.config headers() / middleware response headers)
    // over the adapter's `public, max-age=0, must-revalidate` + deploy-tag default (N50:
    // the manifest's public-file default was `max-age=3600`, which `next start` never
    // sends — measured `public, max-age=0` on 16.2.10 — and it now matches the value this
    // file already uses at :489). A pre-parse disk
    // serve here returned the hardcoded default and silently dropped headers() and
    // middleware headers. servePublicFileFromDisk remains as the last resort for files
    // the manifest missed (both phases, below).

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
      const extDeadlineRaw = req.headers[INTERNAL_EXECUTION_DEADLINE_HEADER] as string | undefined;
      const extDeadlineParsed = extDeadlineRaw === undefined ? Number.NaN : Number(extDeadlineRaw);
      const extDeadlineAt =
        Number.isSafeInteger(extDeadlineParsed) && extDeadlineParsed > 0
          ? extDeadlineParsed
          : undefined;
      let extInvocationQuery: Record<string, string | string[]> | undefined;
      const extInvokeQueryRaw = req.headers["x-invoke-query"] as string | undefined;
      if (extInvokeQueryRaw) {
        try {
          extInvocationQuery = JSON.parse(extInvokeQueryRaw);
        } catch {
          extInvocationQuery = undefined;
        }
      }

      // S22. Every dispatch header has now been READ into a local — delete the whole
      // vocabulary before anything downstream sees it. Only `x-mw-evaluated` (and the two
      // parsed above) used to be removed, so `x-output-id`, `x-upstream-pool`,
      // `x-route-matches`, `x-nextjs-ppr`, `x-invoke-path` and `x-invoke-query` reached
      // Node and edge handlers as ordinary request headers: any app that logs, reflects or
      // forwards its request headers leaked the internal routing state (including the
      // rewrite destination and its query). These values are transport, not request data —
      // the pool passes what handlers need through requestMeta instead.
      for (const h of INTERNAL_DISPATCH_HEADERS) delete req.headers[h];

      await dispatcher.dispatch(req, res, {
        kind: "route",
        pool,
        matchedPathname: extOutputId, // Use outputId/pathname from header
        routeMatches,
        resolvedHeaders: extResolvedHeaders,
        // N40: the same field Phase 1 populates, so dispatch.ts's existing "apply middleware's
        // final request-header set as a REPLACEMENT, not a merge" block runs unchanged — and,
        // being upstream of the cross-pool proxy, the rewritten headers survive a pool hop
        // exactly as they do in Phase 1.
        ...(extMwRequestHeaders ? { middlewareRequestHeaders: extMwRequestHeaders } : {}),
        ...(extInvokePath ? { invokePath: extInvokePath } : {}),
        ...(extInvocationQuery ? { invocationQuery: extInvocationQuery } : {}),
        ...(extDeadlineAt ? { executionDeadlineAt: extDeadlineAt } : {}),
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

  // N32: the readiness state behind `/readyz`. `/healthz` proves only that a socket is
  // listening — see READINESS_PATH in server.ts for the failure this exists to stop.
  // "serving" means BOTH:
  //   • the app's instrumentation register() did not throw (a rejected registration is memoized
  //     by Next and re-awaited per request, so every app route 500s forever), and
  //   • at least one of this pool's route modules actually `import()`ed. A build whose Next
  //     output cannot be loaded (missing chunk, broken native dep, TLA that rejects) answered
  //     /healthz 200 while every route 500'd.
  let readinessReason =
    instrumentationStatus === "failed"
      ? "instrumentation register() failed"
      : "route modules not yet verified";
  let routeModulesVerified = false;
  const readiness = (): ReadinessState => ({
    ready: instrumentationStatus !== "failed" && routeModulesVerified,
    reason: readinessReason,
  });

  // Create and start server
  const server = createPoolServer({
    port,
    poolName,
    trustInternalHeaders,
    internalSecret,
    onRequest: handleRequest,
    readiness,
    // A probe path the APP owns must not be silently shadowed (it was: the old check also
    // ignored a query string, so `/healthz` was intercepted and `/healthz?x=1` was not).
    appOwnsProbePath: (pathname) =>
      handlerLoader.has(pathname) ||
      routingManifest.pathnames.includes(pathname) ||
      staticManifestCovers(pathname),
  });

  await server.start();

  // Verify a route module loads. Deliberately AFTER listen: the pod must answer /healthz (so the
  // kubelet's liveness probe does not restart it mid-verification) while /readyz withholds
  // traffic. Only NODE outputs are candidates — an edge output's module registers itself in the
  // process-global `_ENTRIES`, and loading one at boot would change which entry the
  // handler-loader's single-entry fallback resolves. The load is cached, so the first real
  // request reuses it.
  // Entries, not values: the handler-loader keys strictly on the MANIFEST KEY, and under a
  // basePath the key ("/base/ssr") differs from Next's output id ("/ssr"). Probing by `.id`
  // meant NO basePath build could ever load its probe ("Unknown output ID"), /readyz sat 503,
  // and the blue/green gate timed out every basePath rollout — the full run's entire
  // ~20-suite basePath cluster was this one lookup.
  const verifiableOutputs = Object.entries(poolManifest.outputs).filter(
    ([, output]) => output.runtime !== "edge",
  );
  if (instrumentationStatus === "failed") {
    console.error(
      "[pool-server] NOT READY: instrumentation register() failed — /readyz will report 503 " +
        "so the blue/green gate cannot promote this build (app routes would 500)",
    );
  } else if (verifiableOutputs.length === 0) {
    // A pool with no Node outputs (pure static, or edge-only) has no module to prove; the
    // manifests loaded and the handler loader is initialised, which is all "serving" can mean.
    routeModulesVerified = true;
    readinessReason = "no node route modules to verify (manifests loaded)";
    console.log(`[pool-server] READY: ${readinessReason}`);
  } else {
    const [probeKey] = verifiableOutputs[0]!;
    try {
      await handlerLoader.load(probeKey);
      routeModulesVerified = true;
      readinessReason = `route module loaded (${probeKey})`;
      console.log(`[pool-server] READY: ${readinessReason}`);
    } catch (err) {
      readinessReason = `route module ${probeKey} failed to load`;
      console.error(
        `[pool-server] NOT READY: ${readinessReason} — /readyz will report 503. ` +
          `Every request for this pool's routes would 500:`,
        err,
      );
    }
  }

  // Graceful shutdown. Three separate defects lived in the previous three lines:
  //   • `server.close()` REJECTS with ERR_SERVER_NOT_RUNNING when it is already closing, so a
  //     second SIGTERM produced an unhandled rejection instead of a clean exit;
  //   • it never RESOLVES while any connection is open (a streaming response, or an idle
  //     keep-alive socket), so `process.exit(0)` was unreachable and every rollout waited out
  //     `terminationGracePeriodSeconds` for SIGKILL;
  //   • readiness kept reporting 200 while draining, so the load balancer kept sending new work.
  let shuttingDown = false;
  const SHUTDOWN_GRACE_MS = Math.max(
    100,
    parseInt(process.env.ADAPTER_K8S_SHUTDOWN_GRACE_MS ?? "", 10) || 15_000,
  );
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Fail readiness FIRST so the LB/kubelet stops routing new requests while in-flight ones
    // finish. Liveness deliberately stays 200 — a draining pod is not a broken pod.
    routeModulesVerified = false;
    readinessReason = "shutting down";
    console.log("Shutting down pool server...");
    // Belt and braces: `stop()` is itself bounded, but an exit path must not depend on any
    // promise settling. A signal handler that can hang is how the old three lines failed.
    const hardExit = setTimeout(() => {
      console.warn(
        `[pool-server] shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms — exiting anyway`,
      );
      process.exit(0);
    }, SHUTDOWN_GRACE_MS + 1_000);
    hardExit.unref?.();
    // Drops idle keep-alive sockets at once, tears down anything still streaming at the halfway
    // mark, swallows the "already closing" rejection, and always settles — see server.stop().
    await server.stop({ graceMs: SHUTDOWN_GRACE_MS });
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.log(`[pool-server] liveness ${LIVENESS_PATH}, readiness ${READINESS_PATH}`);

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
