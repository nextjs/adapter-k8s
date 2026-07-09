// src/pool-server/index.ts
import { readFileSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import dns from "node:dns/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolManifest, RoutingManifest } from "../types.js";
import { getRscConfig, manifestNextConfig, rscParentCandidates, templateOutputCandidates, type MiddlewareMatcher, type RscConfig } from "../routing-common.js";
import { createHandlerLoader } from "./handler-loader.js";
import { createLocalResolver } from "./resolve.js";
import { createDispatcher, getContentType } from "./dispatch.js";
import { createPoolServer } from "./server.js";

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
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      (req as NodeJS.ReadableStream & { destroy?: (e?: Error) => void }).destroy?.();
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
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

function toDebugPreview(body: Buffer | null): string {
  if (!body || body.length === 0) return "<empty>";
  const preview = body.subarray(0, 240).toString("utf8");
  return preview.replace(/\s+/g, " ").trim();
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
}

// Read the app's image config (external-host allowlist) from the build output.
// Next.js writes the resolved config to .next/required-server-files.json. When it's
// unavailable, external image fetches are denied by default.
function loadImageConfig(cwd: string): ImageConfig {
  const config: ImageConfig = { remotePatterns: [], domains: [] };
  try {
    const rsfPath = path.join(cwd, ".next", "required-server-files.json");
    if (existsSync(rsfPath)) {
      const rsf = JSON.parse(readFileSync(rsfPath, "utf-8"));
      const images = rsf?.config?.images ?? {};
      if (Array.isArray(images.remotePatterns)) config.remotePatterns = images.remotePatterns;
      if (Array.isArray(images.domains)) config.domains = images.domains;
    }
  } catch {
    // No image config — external images denied by default.
  }
  return config;
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
type FetchedImage = { ok: boolean; status: number; contentType: string; body: Buffer };

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
        callback(Object.assign(new Error("host resolves to non-public address"), { code: "EAI_FAIL" }), "", undefined);
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

async function main() {
  // K8s safety net: a single request's client disconnect or a rejected background task
  // must not take the whole pod down. Log and stay alive rather than process.exit — the
  // pool serves many concurrent requests and the liveness probe hits /healthz.
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
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
  const staticAssets = existsSync(staticAssetsPath)
    ? JSON.parse(readFileSync(staticAssetsPath, "utf-8"))
    : [];

  // Allowlist for external /_next/image sources (SSRF guard).
  const imageConfig = loadImageConfig(process.cwd());

  // Set preview/draft mode env vars from prerender manifest.
  // The web adapter reads these via getEdgePreviewProps() — without them,
  // middleware invocation crashes with "previewProps missing previewModeId".
  // Also collect strict (fallback: false / dynamicParams: false) dynamic routes:
  // a request matching such a route's regex but NOT in the prerendered set must
  // 404, mirroring `next start` — our loopback handler invocation doesn't
  // reproduce that check on its own.
  const prerenderManifestPath = path.join(process.cwd(), ".next", "prerender-manifest.json");
  const strictDynamicRoutes: { pageRegex: RegExp; dataRegex?: RegExp | undefined }[] = [];
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
            dataRegex:
              typeof route.dataRouteRegex === "string"
                ? new RegExp(route.dataRouteRegex)
                : undefined,
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
    middleware: Record<string, { name: string; files: string[]; wasm?: any[]; assets?: any[]; matchers?: MiddlewareMatcher[] }>;
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
        clientAssetToken: "",
      });
    console.log("Edge sandbox initialized");
  } catch {
    // Edge sandbox not available
  }

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
      console.warn(`Middleware file not found: ${mwPath}`);
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
          edgeFunctionEntry: mwManifestEntry,
        });
        // Don't let the sandbox's background work surface as an unhandled rejection.
        result.waitUntil?.catch(() => undefined);
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
  }

  // Edge route runner — uses the middleware manifest's `functions` to get the correct
  // name and files for each edge-compiled route handler.
  let edgeRouteRunner:
    | ((params: any) => Promise<{ response: Response; waitUntil: Promise<void> }>)
    | null = null;
  if (edgeSandboxRun && Object.keys(middlewareManifest.functions).length > 0) {
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
          middlewareManifest.functions[name] ??
          middlewareManifest.functions[`${base}/page`] ??
          middlewareManifest.functions[`${base}/route`];
        if (fnEntry) break;
      }
      if (!fnEntry) {
        throw new Error(`Edge function not found in middleware-manifest.json: ${params.name}`);
      }
      return edgeSandboxRun!({
        ...params,
        name: fnEntry.name,
        paths: fnEntry.files.map((f: string) => path.join(distDir, f)),
        edgeFunctionEntry: fnEntry,
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
  // Middleware matchers (source regexp + has/missing) gate whether middleware
  // runs for a request. From middleware-manifest.json (already loaded).
  const middlewareMatchers: MiddlewareMatcher[] | undefined = routingManifest.middleware
    ? Object.values(middlewareManifest.middleware)[0]?.matchers
    : undefined;

  const resolver = createLocalResolver(
    routingManifest,
    middlewareModule,
    edgeMiddlewareRunner,
    getCloneableBody,
    middlewareMatchers,
  );
  const dispatcher = createDispatcher({
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName,
    edgeRouteRunner,
    pprRoutes: routingManifest.pprRoutes,
    rscConfig: getRscConfig(routingManifest),
    outputIds: Object.keys(poolManifest.outputs),
    strictDynamicRoutes,
    prerenderedPaths,
    buildIdForData: buildId,
  });

  // In GKE, the pool server is behind the ALB — the routing extension sets internal dispatch
  // headers and authenticates them with a shared secret (INTERNAL_HEADER_SECRET, injected from
  // a Secret). When the secret is set the pool trusts dispatch headers only if it matches;
  // TRUST_INTERNAL_HEADERS is the legacy no-secret fallback (still used by some test paths).
  const trustInternalHeaders = process.env.TRUST_INTERNAL_HEADERS === "1";
  const internalSecret = process.env.INTERNAL_HEADER_SECRET || undefined;

  // Create and start server
  const server = createPoolServer({
    port,
    trustInternalHeaders,
    internalSecret,
    onRequest: async (req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);

      // Serve _next/static/* and _next/data/* directly from filesystem.
      // In production, CDN handles these. In standalone/emulate mode, the pool server must serve them.
      if (url.pathname.startsWith("/_next/static/")) {
        const filePath = path.join(
          process.cwd(),
          ".next",
          "static",
          url.pathname.slice("/_next/static/".length),
        );
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          res.writeHead(200, {
            "content-type": getContentType(url.pathname),
            "cache-control": "public, max-age=31536000, immutable",
          });
          res.end(content);
          return;
        }
      }

      // Pages Router SSG data routes: /_next/data/<buildId>/<page>.json.
      // SSG data JSONs exist only in the build output (no manifest entry), so
      // serve them from disk — but only when no pool output owns the data
      // pathname: GSSP and ISR pages have function outputs keyed by their data
      // URL, and those must go through dispatch so the handler (and its
      // incremental cache) produces the payload.
      const dataPrefix = `/_next/data/${buildId}/`;
      if (url.pathname.startsWith(dataPrefix)) {
        const dataPath = url.pathname.slice(dataPrefix.length);
        // Map the data URL to its page: /_next/data/<id>/en/blog/x.json → /en/blog/x
        const pagePath = "/" + dataPath.replace(/\.json$/, "");
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
        }
      }

      // Basic image optimization: /_next/image?url=...&w=...&q=...
      // Fetches the source image and serves it (with optimization if Sharp is available).
      if (url.pathname === "/_next/image") {
        const imageUrl = url.searchParams.get("url");
        const width = parseInt(url.searchParams.get("w") ?? "0", 10);
        const quality = parseInt(url.searchParams.get("q") ?? "75", 10);

        if (!imageUrl) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Bad Request: missing url parameter");
          return;
        }

        try {
          // Resolve the image: internal (relative) or external (absolute URL)
          let imageBuffer: Buffer;
          let contentType: string;

          if (imageUrl.startsWith("/")) {
            // Internal image: read from filesystem. Confine the path to public/ or
            // .next/static/ — a raw `?url=/../../etc/passwd` must not traverse out.
            const publicRoot = path.join(process.cwd(), "public");
            const staticRoot = path.join(process.cwd(), ".next", "static");
            const publicFile = resolveWithinRoot(publicRoot, imageUrl);
            const staticFile = imageUrl.startsWith("/_next/static/")
              ? resolveWithinRoot(staticRoot, imageUrl.slice("/_next/static/".length))
              : null;

            // A null result means the path escaped its root — reject traversal.
            if (
              publicFile === null ||
              (imageUrl.startsWith("/_next/static/") && staticFile === null)
            ) {
              res.writeHead(400, { "content-type": "text/plain" });
              res.end("Bad Request: invalid image path");
              return;
            }

            if (existsSync(publicFile) && !statSync(publicFile).isDirectory()) {
              imageBuffer = readFileSync(publicFile);
            } else if (
              staticFile &&
              existsSync(staticFile) &&
              !statSync(staticFile).isDirectory()
            ) {
              imageBuffer = readFileSync(staticFile);
            } else {
              // Fetch from ourselves (same-origin relative image, e.g. served by a route)
              const selfUrl = `http://127.0.0.1:${port}${imageUrl}`;
              const imgRes = await fetch(selfUrl);
              if (!imgRes.ok) {
                res.writeHead(imgRes.status, { "content-type": "text/plain" });
                res.end(`Image not found: ${imageUrl}`);
                return;
              }
              imageBuffer = Buffer.from(await imgRes.arrayBuffer());
            }
            contentType = getContentType(imageUrl);
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
          }

          // Try to optimize with Sharp if available
          try {
            const sharp = require("sharp");
            const optimized = await sharp(imageBuffer)
              .resize(width || undefined)
              .jpeg({ quality: quality || 75 })
              .toBuffer();
            res.writeHead(200, {
              "content-type": "image/jpeg",
              "cache-control": "public, max-age=60, must-revalidate",
            });
            res.end(optimized);
          } catch {
            // Sharp not available — serve unoptimized
            res.writeHead(200, {
              "content-type": contentType,
              "cache-control": "public, max-age=60, must-revalidate",
            });
            res.end(imageBuffer);
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

      // Serve public directory files (favicon.ico, robots.txt, etc.)
      // In production, CDN/GCS serves these. In standalone/emulate, pool server must.
      if (!url.pathname.startsWith("/_next/") && !url.pathname.startsWith("/api/")) {
        const publicPath = path.join(process.cwd(), "public", url.pathname);
        if (existsSync(publicPath) && !statSync(publicPath).isDirectory()) {
          const content = readFileSync(publicPath);
          res.writeHead(200, {
            "content-type": getContentType(url.pathname),
            "cache-control": "public, max-age=3600",
          });
          res.end(content);
          return;
        }
      }

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
          res.writeHead(413, { "content-type": "text/plain; charset=utf-8" });
          res.end("Payload Too Large");
          return;
        }
        throw err;
      }
      if (bodyBuffer) {
        // Next.js action-handler checks request meta first when the original
        // Node stream has already been consumed upstream.
        addRequestMeta(req as unknown as Record<PropertyKey, unknown>, "actionBody", bodyBuffer);
      }

      if (isServerActionRequest(headers, req.method ?? "GET")) {
        console.log("[pool-server] action request", {
          url: url.pathname,
          method: req.method,
          nextAction: headers.get("next-action"),
          rsc: headers.get("rsc"),
          accept: headers.get("accept"),
          nextRouterStateTreeLength: headers.get("next-router-state-tree")?.length ?? 0,
          nextRouterStateTreePreview: headers.get("next-router-state-tree")?.slice(0, 160),
          nextUrl: headers.get("next-url"),
          contentType: headers.get("content-type"),
          contentLength: headers.get("content-length"),
          bodyLength: bodyBuffer?.length ?? 0,
          bodyPreview: toDebugPreview(bodyBuffer),
        });
      }

      // Phase 2+: if dispatch headers exist (from route extension), use them directly.
      // These are only present when the request passed the secret check in server.ts (else they
      // were stripped), so they can be trusted here.
      const extOutputId = req.headers["x-output-id"] as string | undefined;
      if (extOutputId) {
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

        // next.config headers() + middleware response headers, serialized by the routing
        // extension. The dispatcher merges these into the response (they'd otherwise be dropped
        // on this path). Delete the header after parsing so it doesn't leak to the handler.
        const resolvedHeaders = parseResolvedHeaders(
          req.headers["x-resolved-headers"] as string | undefined,
        );
        delete req.headers["x-resolved-headers"];

        await dispatcher.dispatch(req, res, {
          kind: "route",
          pool,
          matchedPathname: extOutputId, // Use outputId/pathname from header
          routeMatches,
          resolvedHeaders,
        });
        return;
      }

      // Phase 1: resolve route locally
      const resolution = await resolver.resolve(
        url,
        headers,
        req.method ?? "GET",
        createBufferedStream(bodyBuffer),
      );
      await dispatcher.dispatch(req, res, resolution);
    },
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
}

main().catch((err) => {
  console.error("Pool server failed to start:", err);
  process.exit(1);
});
