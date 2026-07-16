// src/pool-server/dispatch.ts
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { pipeline } from "node:stream";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HandlerLoader } from "./handler-loader.js";
import type { ResolveResult } from "./resolve.js";
import type { StaticAssetEntry } from "../types.js";
import {
  INTERNAL_SECRET_HEADER,
  rscParentCandidates,
  stripBasePath,
  templateOutputCandidates,
  type RscConfig,
} from "../routing-common.js";
import { cdnCacheTag } from "../cdn-tags.js";
import { ifNoneMatchMatches, staticAssetEtag } from "./http-cache.js";

const NEXT_REQUEST_META = Symbol.for("NextInternalRequestMeta");

function toNodeHeaders(req: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "undefined") continue;
    headers[key] = value;
  }
  return headers;
}

// Convert a web `Headers` to a Node headers object, preserving multiple Set-Cookie
// values as an array. `Headers.entries()` collapses repeated Set-Cookie into a single
// comma-joined string, which would drop all but the last cookie once written to a client.
function webHeadersToNodeHeaders(webHeaders: Headers): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of webHeaders.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    headers[key] = value;
  }
  const setCookies =
    webHeaders.getSetCookie?.() ??
    (webHeaders.has("set-cookie")
      ? webHeaders
          .get("set-cookie")!
          .split(/,(?=[^;]*=)/)
          .map((c) => c.trim())
      : []);
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  return headers;
}

function middlewareRedirectLocation(req: IncomingMessage, target: URL): string {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ??
    req.headers.host ??
    "localhost";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol =
    (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(",")[0]?.trim() ||
    "http";
  const requestOrigin = new URL(`${protocol}://${host}`).origin;
  return target.origin === requestOrigin
    ? `${target.pathname}${target.search}${target.hash}`
    : target.toString();
}

// Swallow socket errors on a client stream. A mid-response client disconnect emits an
// 'error' on req/res; with no listener Node rethrows it as an uncaught 'error' event and
// takes the whole process down. There's nothing to recover — the connection is gone.
function guardStreamErrors(stream: IncomingMessage | ServerResponse): void {
  if (typeof (stream as { on?: unknown }).on === "function") {
    stream.on("error", () => undefined);
  }
}

// Keep Pages fallback:true shells away from crawlers that require a complete blocking render.
// This mirrors Next 16's isBot union (Googlebot plus HTML_LIMITED_BOT_UA_RE). It lives here rather
// than importing a private next/dist module so the adapter bundle is not coupled to an unstable
// internal file path; the upstream prerender-crawler E2E locks behavior across canary updates.
const FALLBACK_BLOCKING_BOT_UA_RE =
  /Googlebot(?!-)|Googlebot$|[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight/i;

// Write a chunk to the client, bailing out if the socket has gone away. Returns false
// when streaming should stop (socket destroyed/ended), true when it's safe to continue.
async function writeChunkSafely(res: ServerResponse, chunk: Buffer): Promise<boolean> {
  if (res.writableEnded || res.destroyed) return false;
  let flushed: boolean;
  try {
    flushed = res.write(chunk);
  } catch {
    return false;
  }
  if (!flushed) {
    // Wait for drain, but stop waiting if the socket closes/errors first (else we hang).
    await new Promise<void>((resolve) => {
      const done = () => {
        res.off("drain", done);
        res.off("close", done);
        res.off("error", done);
        resolve();
      };
      res.once("drain", done);
      res.once("close", done);
      res.once("error", done);
    });
  }
  return !res.writableEnded && !res.destroyed;
}

function mergeResponseHeaders(
  prefix: Record<string, string | string[]> | undefined,
  response: IncomingMessage["headers"],
): Record<string, string | string[] | undefined> {
  const merged: Record<string, string | string[] | undefined> = {};
  // HTTP field names are case-insensitive. PPR shell metadata preserves the casing emitted at
  // build time, while Node normalizes the resume response to lowercase. A plain object spread
  // therefore sends both `Link` and `link`, doubling React's configured header budget and possibly
  // overflowing Node's HTTP parser. Normalize at the shell/resume boundary and let the live resume
  // value replace the persisted copy, matching a normal single-render response.
  for (const headers of [prefix, response]) {
    if (!headers) continue;
    for (const [name, value] of Object.entries(headers)) {
      merged[name.toLowerCase()] = value;
    }
  }
  return merged;
}

async function writeInnerResponse(
  outerRes: ServerResponse,
  innerRes: IncomingMessage,
  forceStatus?: number,
  prefix?: {
    body: Buffer;
    headers?: Record<string, string | string[]>;
    status?: number;
  },
  normalizePrerenderCacheControl = false,
): Promise<void> {
  // A direct adapter entrypoint can produce either of two valid shapes from postponed state:
  // a resume tail (which needs the persisted shell prepended), or a complete HTML document (the
  // partial-fallback chain already replayed its prelude). Peek at the first chunk before committing
  // headers so we do not concatenate two documents for the latter shape.
  const iterator = innerRes[Symbol.asyncIterator]();
  const first = await iterator.next();
  const firstChunk = first.done ? undefined : Buffer.from(first.value as Buffer);
  const handlerRenderedDocument =
    !!prefix &&
    !!firstChunk &&
    /^\s*(?:<!doctype\s+html(?:\s[^>]*)?>|<html(?:\s|>))/i.test(
      firstChunk.toString("utf8", 0, Math.min(firstChunk.length, 256)),
    );
  const effectivePrefix = handlerRenderedDocument ? undefined : prefix;
  const headers = mergeResponseHeaders(effectivePrefix?.headers, innerRes.headers);
  // Next uses this header to transport cache tags between its entrypoint and incremental cache.
  // It is internal bookkeeping, can expose route/tag structure, and `next start` removes it before
  // the public response. The adapter owns that server boundary, so never forward it to clients.
  delete headers["x-next-cache-tags"];
  // The combined response is shell bytes followed by resume bytes, so neither
  // component's content length describes the final body.
  if (effectivePrefix) delete headers["content-length"];
  // Entrypoints emit origin-oriented s-maxage/private cache directives for
  // incremental responses. In adapter deploy mode the platform cache owns ISR,
  // while the browser-facing response must always revalidate. Next marks this
  // response class explicitly, so avoid altering SSR, APIs, or user headers.
  if (normalizePrerenderCacheControl || headers["x-nextjs-cache"] !== undefined) {
    headers["cache-control"] = "public, max-age=0, must-revalidate";
    delete headers["cache-tag"];
  }
  outerRes.writeHead(forceStatus ?? effectivePrefix?.status ?? innerRes.statusCode ?? 200, headers);
  if (effectivePrefix && !(await writeChunkSafely(outerRes, effectivePrefix.body))) {
    innerRes.destroy();
    return;
  }
  if (firstChunk && !(await writeChunkSafely(outerRes, firstChunk))) {
    innerRes.destroy();
    return;
  }
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const canContinue = await writeChunkSafely(outerRes, next.value as Buffer);
    if (!canContinue) {
      // Client is gone — stop reading the inner response and let it be discarded.
      innerRes.destroy();
      return;
    }
  }
  if (!outerRes.writableEnded) outerRes.end();
}

type Render404 = (
  req: IncomingMessage,
  res: ServerResponse,
  parsedUrl?: { pathname?: string | null; query?: Record<string, unknown> },
  setHeaders?: boolean,
) => Promise<void>;

type RenderError = (req: IncomingMessage, res: ServerResponse, error: Error) => Promise<void>;

type Revalidate = (config: {
  urlPath: string;
  headers: Record<string, string | string[]>;
  opts: { unstable_onlyGenerated?: boolean };
}) => Promise<void>;

async function writeWebResponseToNode(
  res: ServerResponse,
  response: Response,
  forceStatus?: number,
): Promise<void> {
  res.writeHead(forceStatus ?? response.status, webHeadersToNodeHeaders(response.headers));
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!res.writableEnded) res.end();
}

async function invokeLocalHandlerOverHttp({
  handler,
  req,
  res,
  matchedPathname,
  routeMatches,
  bufferedBody,
  invocationPath,
  routeParamPathname,
  invocationQuery,
  responsePrefix,
  invocationHeaders,
  discardResponse,
  minimalMode = false,
  normalizePrerenderCacheControl = false,
  forceStatus,
  invokeStatus,
  render404,
  renderError,
  revalidate,
  i18nLocales,
}: {
  handler: HandlerLoader extends { load(outputId: string): Promise<infer T> } ? T : never;
  req: IncomingMessage;
  res: ServerResponse;
  matchedPathname: string;
  routeMatches: Record<string, string> | null;
  bufferedBody: Buffer | undefined;
  /** Concrete internal rewrite target. The loopback request keeps the public URL; this target is
   * supplied through documented request metadata for route params/query resolution. */
  invocationPath?: string;
  /** Concrete route selected by routing before it is mapped back to an executable dynamic output.
   * This may retain an i18n prefix that invocationPath intentionally removes from handler URL
   * metadata. Use it only to recover dynamic params from the output template. */
  routeParamPathname?: string;
  /** Query resolved by @next/routing, excluding internal capture placeholders. */
  invocationQuery?: Record<string, string | string[]>;
  /** Build-time PPR shell prepended to the handler's resumed render stream. */
  responsePrefix?: {
    filePath: string;
    headers?: Record<string, string | string[]>;
    status?: number;
  };
  /** Headers prescribed by the build output's internal invocation chain (for example next-resume). */
  invocationHeaders?: Record<string, string>;
  /** Drain the entrypoint response without forwarding it. Used only by the explicitly E2E-gated
   * platform-cache simulation to let a segment prefetch schedule a background shell fill. */
  discardResponse?: boolean;
  /** Next direct-entrypoint runtime mode. False is reserved for the E2E filesystem stand-in. */
  minimalMode?: boolean;
  /** The adapter knows this Pages response is backed by a prerender even when the generated direct
   * entrypoint omits x-nextjs-cache. Keep mutable ISR in Valkey, not Cloud CDN. */
  normalizePrerenderCacheControl?: boolean;
  /** Override the response status regardless of what the handler set — used to make a not-found
   * render return 404 even when the underlying page handler (e.g. Pages Router `/404`) renders 200. */
  forceStatus?: number;
  /** Status supplied to Next's internal error entrypoint through documented request metadata. */
  invokeStatus?: number;
  /** Adapter-provided 404 renderer used when a Pages handler returns `notFound: true`. */
  render404?: Render404;
  /** Adapter-provided error renderer used when an entrypoint throws before sending a response. */
  renderError?: RenderError;
  /** In-process on-demand revalidation, matching Next's documented requestMeta contract. */
  revalidate?: Revalidate;
  /** Pages i18n locale prefixes are protocol routing state, not dynamic page params. */
  i18nLocales?: string[];
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pendingWaitUntil = new Set<Promise<void>>();
    const trackWaitUntil = (waitable: Promise<unknown>): void => {
      const observed: Promise<void> = Promise.resolve(waitable)
        .then(() => undefined)
        .catch((error): void => {
          console.error(`[pool-server] background work failed for ${matchedPathname}:`, error);
        })
        .finally(() => {
          pendingWaitUntil.delete(observed);
        });
      pendingWaitUntil.add(observed);
    };
    const settleWaitUntil = async (): Promise<void> => {
      // A settled callback can enqueue another callback, so drain to a fixed point. The response
      // has already been streamed to the client; this only keeps the invocation/server lifecycle
      // alive until Next's cache writes, revalidations, and after() work have completed.
      while (pendingWaitUntil.size > 0) {
        await Promise.all([...pendingWaitUntil]);
      }
    };
    const server = createServer((innerReq, innerRes) => {
      void (async () => {
        try {
          // The PPR resume token is set on the OUTER req's meta symbol by the caller
          // (see the pprRoutes branch below). The loopback createServer only carries req/res
          // streaming — `ctx` here is a direct JS argument, so we thread `postponed` through it
          // rather than relying on the symbol surviving the hop (it does not). The generated
          // app-page handler calls setRequestMeta(req, ctx.requestMeta) then reads
          // getRequestMeta(req, 'postponed') and resumes the dynamic holes onto the prebuilt
          // shell, streamed. Spike-proven: injecting just `postponed` streams a correct resume
          // (no minimal mode / resolvedPathname needed). See the PPR/cache-components design doc.
          const outerMeta =
            ((req as IncomingMessage & { [NEXT_REQUEST_META]?: { postponed?: string } })[
              NEXT_REQUEST_META
            ] as { postponed?: string } | undefined) ?? {};
          const publicRequestUrl = new URL(
            req.url ?? "/",
            `http://${req.headers.host ?? "localhost"}`,
          );
          const publicRequestPathname = publicRequestUrl.pathname;
          const concreteInvocationPath = invocationPath
            ? new URL(invocationPath, "http://localhost").pathname
            : (pagesDataRequestPathnameToPagePath(publicRequestPathname, i18nLocales) ??
              publicRequestPathname);
          const params = extractRouteParams(
            matchedPathname,
            routeMatches,
            routeParamPathname ?? concreteInvocationPath,
          );
          let invocationMeta: Record<string, unknown> = {
            // Always provide the concrete decoded/interpolated target. Direct dynamic requests do
            // not have an `invocationPath`, but the entrypoint still needs this to match the right
            // prerender/fallback record rather than treating the route template as the request.
            resolvedPathname: concreteInvocationPath,
            // Generated App Route handlers use initURL to construct request.nextUrl. Preserve the
            // public host and port for ordinary requests; falling back to bare http://localhost
            // makes an absolute 307/308 form redirect escape to port 80. Server Actions are
            // intentionally excluded: their generated entrypoint owns a separate worker-forwarding
            // URL protocol, and injecting initURL there turns single-pass action redirects into an
            // extra network request (and breaks cross-worker action forwarding).
            ...(req.headers["next-action"] === undefined
              ? { initURL: publicRequestUrl.toString() }
              : {}),
            ...(invocationQuery ? { query: invocationQuery } : {}),
            ...(invokeStatus !== undefined ? { invokeStatus } : {}),
          };
          if (params) invocationMeta.params = params;
          if (new URL(req.url ?? "/", "http://localhost").pathname.includes("/_next/data/")) {
            invocationMeta.isNextDataReq = true;
          }
          if (invocationPath) {
            const target = new URL(invocationPath, `http://${req.headers.host ?? "localhost"}`);
            const query: Record<string, string | string[]> = {};
            for (const [key, value] of target.searchParams) {
              const previous = query[key];
              query[key] =
                previous === undefined
                  ? value
                  : Array.isArray(previous)
                    ? [...previous, value]
                    : [previous, value];
            }
            invocationMeta = {
              ...invocationMeta,
              query: invocationQuery ?? query,
              // `matchedPathname`/`outputId` carry the executable route template. The documented
              // request-meta contract instead defines `resolvedPathname` as decoded and with
              // dynamic params interpolated, so it must carry the concrete invocation target.
              resolvedPathname: target.pathname,
              rewrittenPathname: target.pathname,
            };
          }
          const maybeResult = await (handler as any)(innerReq, innerRes, {
            waitUntil(waitable: Promise<unknown>) {
              trackWaitUntil(waitable);
            },
            requestMeta: {
              relativeProjectDir: ".",
              hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
              minimalMode,
              outputId: matchedPathname,
              matchedPathname,
              routeMatches,
              ...invocationMeta,
              ...(outerMeta.postponed ? { postponed: outerMeta.postponed } : {}),
              // Cache Components entrypoints use the presence of the documented V2 callback to
              // select adapter/minimal-mode cache semantics (including RDC generation). Returning
              // false means the adapter observed the entry but did not write the HTTP response.
              onCacheEntryV2: async () => false,
              ...(render404 ? { render404 } : {}),
              ...(revalidate ? { revalidate } : {}),
            },
          });

          if (maybeResult instanceof Response) {
            await writeWebResponseToNode(innerRes, maybeResult);
            return;
          }
          // Node entrypoints own the response lifecycle. A Pages API handler may return while
          // an outbound stream is still piping into `res`; ending here truncates that body to
          // empty. The loopback client naturally completes when the entrypoint finishes `res`.
        } catch (error) {
          console.error(`[pool-server] handler error for ${matchedPathname}:`, error);
          if (!innerRes.headersSent) {
            if (renderError) {
              await renderError(
                innerReq,
                innerRes,
                error instanceof Error ? error : new Error(String(error)),
              );
              return;
            }
            innerRes.statusCode = 500;
            innerRes.end("Internal Server Error");
          } else if (!innerRes.writableEnded) {
            innerRes.end();
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate loopback port")));
        return;
      }

      const reqHeaders = toNodeHeaders(req);
      Object.assign(reqHeaders, invocationHeaders);
      // We forward a fixed-length buffered body, so drop any transfer-encoding the
      // original request carried (e.g. `chunked`). Node's HTTP parser rejects a request
      // that has BOTH transfer-encoding and content-length, yielding a spurious 400
      // before the handler runs. Delete case-insensitively.
      for (const key of Object.keys(reqHeaders)) {
        if (key.toLowerCase() === "transfer-encoding") {
          delete reqHeaders[key];
        }
      }
      // Ensure content-length matches the buffered body (the original stream is consumed)
      if (bufferedBody) {
        reqHeaders["content-length"] = String(bufferedBody.length);
      } else if (req.method !== "GET" && req.method !== "HEAD") {
        // Body was consumed but no buffer — send empty body
        reqHeaders["content-length"] = "0";
      }

      const clientReq = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          method: req.method,
          path: req.url,
          headers: reqHeaders,
        },
        (clientRes) => {
          const closeThenSettle = (onError: (error: unknown) => void): void => {
            // App Router wires after() through res.on("close"). Close the loopback response first
            // so that callback can register its waitUntil promise, then drain the complete batch.
            // Draining before server.close races the close callback and silently loses after().
            server.close(() => {
              void settleWaitUntil().then(resolve).catch(onError);
            });
          };
          if (discardResponse) {
            void (async () => {
              for await (const _chunk of clientRes) {
                // Drain the response so the loopback connection can close cleanly.
              }
            })()
              .then(() => closeThenSettle(reject))
              .catch((error) => server.close(() => reject(error)));
            return;
          }
          void writeInnerResponse(
            res,
            clientRes,
            forceStatus,
            responsePrefix
              ? {
                  body: readFileSync(responsePrefix.filePath),
                  ...(responsePrefix.headers ? { headers: responsePrefix.headers } : {}),
                  ...(responsePrefix.status ? { status: responsePrefix.status } : {}),
                }
              : undefined,
            normalizePrerenderCacheControl,
          )
            .then(() => closeThenSettle(reject))
            .catch((error) => {
              server.close(() => reject(error));
            });
        },
      );

      clientReq.once("error", (error) => {
        server.close(() => reject(error));
      });

      if (bufferedBody && bufferedBody.length > 0) {
        clientReq.end(bufferedBody);
      } else {
        clientReq.end();
      }
    });
  });
}

export function extractRouteParams(
  matchedPathname: string,
  routeMatches: Record<string, string> | null,
  concretePathname?: string,
): Record<string, string | string[]> | undefined {
  const params: Record<string, string | string[]> = {};
  for (const match of matchedPathname.matchAll(/\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    const value = routeMatches?.[name] ?? routeMatches?.[`nxtP${name}`];
    if (value === undefined || /^\$nxtP/.test(value)) continue;
    if (match[1]) {
      const segments = value.split("/");
      // With `trailingSlash: true`, @next/routing can preserve the terminal slash in a
      // catch-all capture (for example `a/b/`). It is a pathname delimiter, not an
      // additional empty route parameter. Keep interior empty segments untouched so this
      // normalization remains limited to the routing artifact we actually observed.
      while (segments.at(-1) === "") segments.pop();
      if (segments.length === 0) continue;
      params[name] = segments.map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    } else {
      // @next/routing transports dynamic captures in URL-encoded form. Generated entrypoints
      // expect requestMeta.params to contain the decoded segment, including an encoded slash as
      // one ordinary dynamic-param value. Catch-alls already decode each segment above; applying
      // the same single decode here prevents `%2F` becoming `%252F` during cache-key generation.
      try {
        params[name] = decodeURIComponent(value);
      } catch {
        params[name] = value;
      }
    }
  }

  // @next/routing may match a partially specialized PPR output such as
  // `/with-root-param/en/posts/[id].rsc`. Its routeMatches contains `id`, but the
  // executable handler template also needs the already-specialized root param `lang`.
  // Recover only missing values from the concrete invocation pathname.
  if (concretePathname && matchedPathname.includes("[")) {
    const names: { name: string; catchAll: boolean }[] = [];
    let pattern = "";
    const templatePathname = matchedPathname.endsWith(".rsc")
      ? matchedPathname.slice(0, -".rsc".length)
      : matchedPathname;
    for (const rawSegment of templatePathname.split("/").slice(1)) {
      // Interception markers select a route-tree branch but do not consume a public URL segment.
      // `/[locale]/(.)[username]/p/[id].rsc` therefore matches `/en/foo/p/1`; treating `(.)` or
      // the `.rsc` output suffix as pathname text prevents recovery of the otherwise-missing
      // `locale` param and makes the generated App entrypoint throw an invariant error.
      const segment = rawSegment.replace(/^(?:\(\.{1,3}\))+/, "");
      const optionalCatchAll = /^\[\[\.\.\.(.+)\]\]$/.exec(segment);
      const catchAll = /^\[\.\.\.(.+)\]$/.exec(segment);
      const dynamic = /^\[(.+)\]$/.exec(segment);
      if (optionalCatchAll) {
        names.push({ name: optionalCatchAll[1]!, catchAll: true });
        pattern += "(?:/(.*))?";
      } else if (catchAll) {
        names.push({ name: catchAll[1]!, catchAll: true });
        pattern += "/(.+)";
      } else if (dynamic) {
        names.push({ name: dynamic[1]!, catchAll: false });
        pattern += "/([^/]+)";
      } else {
        pattern += "/" + segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    const concreteMatch = new RegExp(`^${pattern}/?$`).exec(concretePathname);
    if (concreteMatch) {
      names.forEach(({ name, catchAll }, index) => {
        if (params[name] !== undefined) return;
        const raw = concreteMatch[index + 1];
        if (raw === undefined || raw === "") return;
        const decode = (value: string) => {
          try {
            return decodeURIComponent(value);
          } catch {
            return value;
          }
        };
        if (catchAll) {
          const segments = raw.split("/");
          // The optional terminal slash belongs to the pathname, not the catch-all value.
          // This fallback is used when @next/routing's internal alias normalizes a param name
          // (for example `product-params` -> `nxtPproductparams`) and cannot be read by name.
          while (segments.at(-1) === "") segments.pop();
          if (segments.length > 0) params[name] = segments.map(decode);
        } else {
          params[name] = decode(raw);
        }
      });
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * Convert the public Pages Router data protocol URL back to the page pathname used by the
 * entrypoint's request metadata. Keep `req.url` itself untouched: Pages needs to observe
 * `/_next/data/...` to negotiate JSON, while `resolvedPathname` and dynamic-param recovery must
 * describe the public page. In particular, treating `/_next/data/<id>/index.json` as the concrete
 * path for a root `[[...slug]]` route leaks the protocol segments into `params.slug`.
 */
export function pagesDataRequestPathnameToPagePath(
  pathname: string,
  i18nLocales: string[] = [],
): string | null {
  const marker = "/_next/data/";
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex < 0) return null;

  const basePath = pathname.slice(0, markerIndex);
  const buildAndDataPath = pathname.slice(markerIndex + marker.length);
  const separatorIndex = buildAndDataPath.indexOf("/");
  if (separatorIndex < 1) return null;

  const dataPath = buildAndDataPath.slice(separatorIndex + 1);
  if (!dataPath.endsWith(".json")) return null;

  let pagePath = dataPath.slice(0, -".json".length);
  if (pagePath === "index") return basePath || "/";

  // Pages' i18n data protocol includes the locale before the actual page path
  // (`/_next/data/<id>/fr/about.json`). The generated entrypoint infers locale from the untouched
  // public URL; requestMeta.resolvedPathname must describe `/about`, otherwise a root optional
  // catch-all incorrectly receives `{ slug: ["fr"] }` during locale navigation.
  const [firstSegment, ...remainingSegments] = pagePath.split("/");
  if (i18nLocales.some((locale) => locale.toLowerCase() === firstSegment?.toLowerCase())) {
    pagePath = remainingSegments.join("/") || "index";
  }

  if (pagePath === "index") return basePath || "/";
  // `${basePath}/${pagePath}` always contains the leading "/", so it is never falsy.
  return `${basePath}/${pagePath}`;
}

function pagesDataPathToPagePath(
  pathname: string,
  basePath: string,
  buildId: string,
): string | null {
  const prefix = `${basePath}/_next/data/${buildId}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".json")) return null;
  const dataPath = pathname.slice(prefix.length, -".json".length);
  const pagePath = dataPath === "index" ? "/" : `/${dataPath}`;
  return `${basePath}${pagePath === "/" ? "" : pagePath}` || "/";
}

type LocalHandlerInvoker = typeof invokeLocalHandlerOverHttp;

// Render the best available custom 404, then fall back to plain text. Order: App Router handler
// (`/_not-found`), Pages Router handler (`/404`), a prerendered Pages Router `/404.html` from the
// static manifest, then plain text. Previously only `/_not-found` was attempted, so a pages-router
// app with a custom `pages/404` (which prerenders to a static `404.html`) got a bare "Not Found".
async function serveNotFound(
  handlerLoader: HandlerLoader,
  localHandlerInvoker: LocalHandlerInvoker,
  staticAssets: StaticAssetEntry[],
  req: IncomingMessage,
  res: ServerResponse,
  bufferedBody: Buffer | undefined,
  basePath = "",
): Promise<void> {
  const notFoundPaths = [
    ...(basePath ? [`${basePath}/_not-found`, `${basePath}/404`] : []),
    "/_not-found",
    "/404",
  ];
  for (const notFoundPath of notFoundPaths) {
    if (!handlerLoader.has(notFoundPath)) continue;
    try {
      const handler = await handlerLoader.load(notFoundPath);
      await localHandlerInvoker({
        handler,
        req,
        res,
        matchedPathname: notFoundPath,
        routeMatches: null,
        bufferedBody,
        // A Pages Router `/404` entrypoint renders like a normal page, so force the status here.
        forceStatus: 404,
      });
      return;
    } catch (error) {
      // A broken custom 404 must not take down the request, but swallowing this made adapter
      // contract mismatches indistinguishable from a genuinely absent not-found output.
      console.error(`[pool-server] failed to invoke not-found handler ${notFoundPath}:`, error);
      // Fall through to the next candidate or the prerendered 404.
    }
  }
  // Prerendered Pages Router 404 (static `404.html`) — serve its body with a 404 status.
  const prerendered404 = staticAssets.find(
    (a) => a.pathname === (basePath ? `${basePath}/404` : "/404") || a.pathname === "/404",
  );
  if (prerendered404) {
    const fullPath = path.resolve(process.cwd(), prerendered404.filePath);
    if (existsSync(fullPath) && !res.writableEnded) {
      res.writeHead(404, {
        "content-type": "text/html; charset=utf-8",
        ...(prerendered404.headers as Record<string, string> | undefined),
      });
      res.end(readFileSync(fullPath));
      return;
    }
  }
  // Some Pages builds (notably an app-wide getInitialProps) expose no standalone `/404` output:
  // Next's router renders the 404 through `/_error` with invokeStatus metadata. This is the
  // documented entrypoint contract, and must come after an explicit/prerendered custom 404.
  if (handlerLoader.has("/_error")) {
    try {
      const handler = await handlerLoader.load("/_error");
      await localHandlerInvoker({
        handler,
        req,
        res,
        matchedPathname: "/_error",
        routeMatches: null,
        bufferedBody,
        invokeStatus: 404,
        forceStatus: 404,
      });
      return;
    } catch (error) {
      console.error("[pool-server] failed to invoke Pages /_error for not-found:", error);
    }
  }
  if (!res.writableEnded) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

function sanitizeK8sName(name: string): string {
  let sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, "-");
  if (!/^[a-z]/.test(sanitized)) sanitized = `b-${sanitized}`;
  sanitized = sanitized.replace(/-+$/, "");
  return sanitized.slice(0, 63);
}

// Edge route runner: uses Next.js's edge sandbox to execute edge-compiled route handlers.
// Returns a web Response which we convert back to Node's ServerResponse.
type EdgeRouteRunner = (params: {
  name: string;
  paths: string[];
  request: Record<string, unknown>;
}) => Promise<{ response: Response; waitUntil: Promise<void> }>;

export interface DispatcherOptions {
  handlerLoader: HandlerLoader;
  poolName: string;
  buildId: string;
  staticAssets: StaticAssetEntry[];
  releaseName?: string;
  localHandlerInvoker?: LocalHandlerInvoker;
  edgeRouteRunner?: EdgeRouteRunner | null;
  pprRoutes?: Record<
    string,
    {
      postponedState: string;
      fallbackFilePath: string;
      chainHeaders?: Record<string, string>;
      initialHeaders?: Record<string, string | string[]>;
      initialStatus?: number;
      tags?: string[];
    }
  >;
  /** Returns true if any of a PPR shell's baked cache tags have been revalidated since deploy (read
   * live from the shared Valkey manifest). Used only when NO classic incremental cacheHandler is
   * registered (e.g. an edge-middleware app): it withholds the stale build-time postponed token so
   * `revalidateTag` still forces a fresh shell render. Absent when there's no shared cache. */
  checkShellStale?: (tags: string[]) => Promise<boolean>;
  rscConfig?: RscConfig | undefined;
  /** All output ids in this pool's manifest — used to map concrete prerender
   * paths back to their dynamic-route template handler (outputs of dynamic
   * routes are keyed by template, e.g. "/blog/[slug]"). */
  outputIds?: string[];
  /** Dynamic routes with fallback:false / dynamicParams:false — a matching path
   * not in prerenderedPaths must 404 (mirrors `next start`). */
  strictDynamicRoutes?: { pageRegex: RegExp; dataRegex?: RegExp | undefined }[];
  prerenderedPaths?: Set<string>;
  buildIdForData?: string;
  /** Shared secret used to authenticate cluster-internal cross-pool dispatch headers. */
  internalSecret?: string | undefined;
  /** True when a classic incremental `cacheHandler` is registered (via next.config.cacheHandler)
   * and therefore owns the PPR shell. When set, we DON'T inject the build-time postponed token —
   * the incremental cache serves + revalidates the shell instead. This must track the SAME build
   * decision that registers the handler (cache enabled AND no edge middleware), not merely whether
   * VALKEY_URL is present: a cache + edge-middleware app has VALKEY_URL but no classic handler, and
   * must keep injecting to preserve PPR resume. */
  incrementalCacheShared?: boolean;
  /** Test-harness-only equivalent of `incrementalCacheShared`: let the Next entrypoint own PPR
   * shell lookup/upgrades using its built-in filesystem cache. The real adapter must use the
   * registered Valkey incremental handler for this role; this option only simulates that missing
   * platform layer in Next's local deploy E2E and must never be enabled in production. */
  entrypointOwnsPprShell?: boolean;
  /** Test-harness-only stand-in for the platform cache miss/hit lifecycle. Production must leave
   * this false: Valkey, never process-local memory, owns mutable fallback materialization. */
  emulatePlatformCache?: boolean;
  /** Re-enter the pool request pipeline for Pages API `res.revalidate()` without a network hop. */
  revalidate?: Revalidate;
  /** Configured public basePath. Output ids and static 404 assets may be basePath-prefixed. */
  basePath?: string;
  /** Configured Pages Router locales, used to keep locale protocol prefixes out of route params. */
  i18nLocales?: string[];
}

export function createDispatcher(options: DispatcherOptions) {
  const {
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName = "nextjs",
    localHandlerInvoker = invokeLocalHandlerOverHttp,
    edgeRouteRunner = null,
    pprRoutes = {},
    rscConfig,
    outputIds = [],
    strictDynamicRoutes = [],
    prerenderedPaths = new Set<string>(),
    buildIdForData = "",
    internalSecret,
    incrementalCacheShared = false,
    entrypointOwnsPprShell = false,
    emulatePlatformCache = false,
    checkShellStale,
    revalidate,
    basePath = "",
    i18nLocales = [],
  } = options;

  const deployedAt = Date.now();
  const entrypointOwnsPprCache = incrementalCacheShared || entrypointOwnsPprShell;
  const servedFallbackShells = new Set<string>();

  // Pages entrypoints call requestMeta.render404 when getStaticProps/getServerSideProps returns
  // notFound. In a custom adapter there is no Next router-server above the entrypoint, so provide
  // that missing layer explicitly and render into the SAME response. This also preserves request
  // metadata (locale, original URL, cookies) already attached by the calling pages entrypoint.
  const render404FromEntrypoint: Render404 = async (req, res) => {
    if (res.writableEnded) return;

    const renderHandler = async (notFoundPath: string): Promise<boolean> => {
      if (!handlerLoader.has(notFoundPath)) return false;
      try {
        const handler = await handlerLoader.load(notFoundPath);
        res.statusCode = 404;
        const maybeResult = await (handler as any)(req, res, {
          waitUntil(waitable: Promise<unknown>) {
            void waitable.catch(() => undefined);
          },
          requestMeta: {
            relativeProjectDir: ".",
            hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
            outputId: notFoundPath,
            matchedPathname: notFoundPath,
            routeMatches: null,
            invokeStatus: 404,
          },
        });
        if (maybeResult instanceof Response) {
          await writeWebResponseToNode(res, maybeResult, 404);
        } else if (!res.writableEnded) {
          res.end();
        }
        return true;
      } catch (error) {
        console.error(`[pool-server] failed to render ${notFoundPath}:`, error);
        return false;
      }
    };

    const notFoundPaths = [
      ...(basePath ? [`${basePath}/_not-found`, `${basePath}/404`] : []),
      "/_not-found",
      "/404",
    ];
    for (const notFoundPath of notFoundPaths) {
      if (await renderHandler(notFoundPath)) return;
    }

    // A Pages Router custom 404 is commonly fully prerendered and therefore
    // has no runtime handler. It must win over the generic `/_error` function.
    const prerendered404 = staticAssets.find(
      (asset) =>
        asset.pathname === (basePath ? `${basePath}/404` : "/404") || asset.pathname === "/404",
    );
    if (prerendered404) {
      const fullPath = path.resolve(process.cwd(), prerendered404.filePath);
      if (existsSync(fullPath)) {
        res.writeHead(404, {
          "content-type": "text/html; charset=utf-8",
          ...(prerendered404.headers as Record<string, string> | undefined),
        });
        res.end(readFileSync(fullPath));
        return;
      }
    }

    if (await renderHandler("/_error")) return;

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("This page could not be found");
  };

  const renderErrorFromEntrypoint: RenderError = async (req, res, error) => {
    if (res.writableEnded) return;

    const renderErrorHandler = async (errorPath: string): Promise<boolean> => {
      if (!handlerLoader.has(errorPath)) return false;
      try {
        const handler = await handlerLoader.load(errorPath);
        res.statusCode = 500;
        const maybeResult = await (handler as any)(req, res, {
          waitUntil(waitable: Promise<unknown>) {
            void waitable.catch(() => undefined);
          },
          requestMeta: {
            relativeProjectDir: ".",
            hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
            outputId: errorPath,
            matchedPathname: errorPath,
            routeMatches: null,
            invokeError: error,
            invokeStatus: 500,
          },
        });
        if (maybeResult instanceof Response) {
          await writeWebResponseToNode(res, maybeResult, 500);
        } else if (!res.writableEnded) {
          res.end();
        }
        return true;
      } catch (renderError) {
        console.error(`[pool-server] failed to render ${errorPath}:`, renderError);
        return false;
      }
    };

    if (await renderErrorHandler("/500")) return;

    // A custom Pages /500 is normally fully prerendered and may therefore have no callable output
    // in the adapter build. It must win over Next's generic /_error entrypoint just as a static
    // custom /404 wins on not-found. The original page error has already been logged upstream.
    const prerendered500 = staticAssets.find(
      (asset) =>
        asset.pathname === (basePath ? `${basePath}/500` : "/500") || asset.pathname === "/500",
    );
    if (prerendered500) {
      const fullPath = path.resolve(process.cwd(), prerendered500.filePath);
      if (existsSync(fullPath)) {
        res.writeHead(500, {
          "content-type": "text/html; charset=utf-8",
          ...(prerendered500.headers as Record<string, string> | undefined),
        });
        res.end(readFileSync(fullPath));
        return;
      }
    }

    if (await renderErrorHandler("/_error")) return;

    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("Internal Server Error");
  };

  return {
    async dispatch(
      req: IncomingMessage,
      res: ServerResponse,
      resolution: ResolveResult,
    ): Promise<void> {
      // A client that disconnects mid-response emits 'error' on the socket; without a
      // listener Node crashes the process. Guard the outer client response up front.
      guardStreamErrors(res);

      // Pages Router uses this response header to interpret middleware data-request
      // preflights and retain the matched route template. Next's router-server sets
      // it for both static and dynamic data routes.
      const requestPathname = req.url ? new URL(req.url, "http://localhost").pathname : "";
      const isPagesDataRequest = requestPathname.startsWith(`${basePath}/_next/data/`);
      if (resolution.kind === "route" && isPagesDataRequest) {
        const publicMatchedPathname = stripBasePath(resolution.matchedPathname, basePath);
        res.setHeader(
          "x-nextjs-matched-path",
          publicMatchedPathname === "/index" ? "/" : publicMatchedPathname,
        );
      }

      // Install writeHead wrapper early to merge resolved headers (from routing/middleware)
      // into ANY response — static assets, handler responses, and 404s (middleware
      // next() headers must reach the response even when no route matches).
      if (
        (resolution.kind === "route" || resolution.kind === "not-found") &&
        resolution.resolvedHeaders
      ) {
        const resolvedHeaders = resolution.resolvedHeaders;
        const origWriteHead = res.writeHead.bind(res);
        (res as any).writeHead = (status: number, ...args: any[]) => {
          // writeHead(status, headers) or writeHead(status, msg, headers)
          const headersArgIdx = typeof args[0] === "string" ? 1 : 0;
          const handlerHeaders = args[headersArgIdx] as
            | Record<string, string | string[]>
            | undefined;

          if (handlerHeaders) {
            for (const [key, value] of resolvedHeaders.entries()) {
              if (key.toLowerCase() === "set-cookie") {
                const existingKey = Object.keys(handlerHeaders).find(
                  (name) => name.toLowerCase() === "set-cookie",
                );
                const existing = existingKey ? handlerHeaders[existingKey] : undefined;
                const arr: string[] = [];
                if (existing) {
                  if (Array.isArray(existing)) arr.push(...existing);
                  else arr.push(existing);
                }
                for (const c of value.split(/,(?=[^;]*=)/)) {
                  arr.push(c.trim());
                }
                if (existingKey && existingKey !== "set-cookie") delete handlerHeaders[existingKey];
                handlerHeaders["set-cookie"] = arr;
              } else {
                // next.config headers() and explicit middleware response headers are the final
                // public response policy in Next's router-server. Adapter defaults (including
                // static/public cache-control) must not silently replace that app-owned value.
                // Compare case-insensitively because Node and Web Headers normalize differently.
                for (const existingKey of Object.keys(handlerHeaders)) {
                  if (existingKey.toLowerCase() === key.toLowerCase()) {
                    delete handlerHeaders[existingKey];
                  }
                }
                handlerHeaders[key] = value;
              }
            }
          }
          return origWriteHead(status, ...args);
        };
      }

      // Resolve the handler output id up front (shared by the static fast path
      // decision and the route dispatch below). Prerendered RSC variants
      // (.rsc / segment payloads) have no handler of their own — fall back to
      // the parent page handler, which serves the flight payload based on the
      // rsc request headers.
      let handlerPathname = resolution.kind === "route" ? resolution.matchedPathname : "";
      if (resolution.kind === "route" && !handlerLoader.has(handlerPathname)) {
        const candidates = [
          ...(basePath && handlerPathname === basePath ? [`${basePath}/index`] : []),
          // Pages Router's root function output is keyed as `/index`, while
          // public requests and prerenders use `/`.
          ...(handlerPathname === "/" ? ["/index"] : []),
          ...rscParentCandidates(handlerPathname, rscConfig),
          // Concrete prerender paths (e.g. "/blog/hello") map back to their
          // dynamic-route template handler ("/blog/[slug]") — ISR regeneration
          // and server actions on prerendered dynamic routes need the function.
          ...templateOutputCandidates(handlerPathname, outputIds),
        ];
        for (const candidate of candidates) {
          if (handlerLoader.has(candidate)) {
            handlerPathname = candidate;
            break;
          }
        }
      }
      const hasHandler = resolution.kind === "route" && handlerLoader.has(handlerPathname);
      const handlerOutputInfo = hasHandler ? handlerLoader.get(handlerPathname) : undefined;

      // Pages Router marks speculative middleware data requests explicitly. A
      // dynamic page must not run GSSP during that prefetch: Next returns an
      // empty, non-cacheable result with x-middleware-skip so the client will
      // perform the real request on navigation. In adapter/minimal mode the
      // generated entrypoint can classify the rewritten data URL as SSG, so
      // enforce the documented router protocol at the dispatch boundary where
      // the prerender inventory is authoritative.
      if (
        resolution.kind === "route" &&
        isPagesDataRequest &&
        req.headers["x-middleware-prefetch"]
      ) {
        const rewrittenDataPath = resolution.resolvedHeaders?.get("x-nextjs-rewrite");
        const dataPagePath = pagesDataPathToPagePath(
          rewrittenDataPath
            ? new URL(rewrittenDataPath, "http://localhost").pathname
            : requestPathname,
          basePath,
          buildIdForData || buildId,
        );
        const isPrerendered =
          dataPagePath !== null &&
          staticAssets.some(
            (asset) =>
              asset.prerender &&
              (asset.pathname === dataPagePath ||
                stripBasePath(asset.pathname, basePath) === stripBasePath(dataPagePath, basePath)),
          );
        if (!isPrerendered) {
          res.writeHead(200, {
            "x-middleware-skip": "1",
            "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
            "content-type": "application/json; charset=utf-8",
          });
          res.end("{}");
          return;
        }
      }

      // 1. Serve static assets from the manifest — build assets, public/ files,
      // and prerenders that have NO handler (fully-static pages-router SSG emits
      // no function; the build file is the only source and can never be
      // revalidated). Prerenders WITH a handler always go through it: Next's
      // incremental cache serves hits cheaply and owns all the semantics the
      // manifest file can't (ISR staleness, revalidatePath/Tag — including from
      // after(), draft mode, PPR resume). Non-GET/HEAD methods also fall
      // through — server actions POST to the page's own pathname.
      let dispatchStaticAsset: (typeof staticAssets)[number] | undefined;
      if (resolution.kind === "route") {
        const mp = resolution.matchedPathname;
        const isRSC = req.headers[rscConfig?.header ?? "rsc"] === "1";
        const staticAsset = staticAssets.find(
          (a) =>
            a.pathname === mp ||
            a.pathname === (mp.endsWith("/") ? mp.slice(0, -1) : mp + "/") ||
            // The Pages Router root prerender is keyed "/index"; a request
            // resolved to "/" (now that "/" is a recognized page) must find it.
            (mp === "/" && a.pathname === "/index") ||
            // Fully-static root outputs may remain keyed as `/` while public
            // routing resolves the configured basePath root (for example `/docs`).
            (basePath && mp === basePath && (a.pathname === "/" || a.pathname === "/index")) ||
            (basePath && mp === basePath && a.pathname === `${basePath}/index`) ||
            // RSC requests: serve the .rsc prerendered payload if available
            (isRSC && a.pathname === mp + ".rsc"),
        );
        dispatchStaticAsset = staticAsset;
        const isReadMethod = req.method === "GET" || req.method === "HEAD";
        const isPreviewRequest = (req.headers.cookie ?? "").includes("__prerender_bypass=");
        // Handler-less prerenders (pages SSG emits no function) are served from
        // the manifest file for ANY method — upstream serves SSG pages on POST
        // too — but only when this pool owns the route; a wrong-pool guess must
        // fall through so proxyToPool can recover (PPR shells especially must
        // not be served incomplete by a non-owning pool). Build assets and
        // public/ files stay GET/HEAD-only: upstream 404s writes to them.
        const serveHandlerlessPrerender =
          staticAsset?.prerender && !hasHandler && resolution.pool === poolName;
        // A concrete non-PPR prerender under a dynamic template is the initial response-cache
        // seed. Serve it while its build-time revalidate window is fresh; after expiry (or shared
        // tag invalidation), the handler regenerates and onCacheEntryV2 owns later completed
        // entries. PPR artifacts still require shell + resume and never take this path.
        const seedRevalidate = staticAsset?.revalidate;
        const seedWithinRevalidateWindow =
          seedRevalidate === false ||
          (typeof seedRevalidate === "number" &&
            seedRevalidate > 0 &&
            Date.now() - deployedAt < seedRevalidate * 1000);
        const rawSeedTags = staticAsset?.headers?.["x-next-cache-tags"];
        const seedTags =
          typeof rawSeedTags === "string"
            ? rawSeedTags
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean)
            : [];
        const seedTagsStale =
          seedWithinRevalidateWindow && checkShellStale && seedTags.length > 0
            ? await checkShellStale(seedTags)
            : false;
        const serveConcretePrerenderSeed =
          isReadMethod &&
          !isPagesDataRequest &&
          !isPreviewRequest &&
          !!staticAsset?.prerender &&
          seedWithinRevalidateWindow &&
          !seedTagsStale &&
          !staticAsset.ppr &&
          // In NEXT_ENABLE_ADAPTER's no-Valkey harness, let the generated entrypoint load this
          // build seed into Next's filesystem incremental cache. That supported cache owns later
          // revalidatePath/updateTag transitions and reports the real x-nextjs-cache status. The
          // gate is unreachable in production, where Valkey owns the same lifecycle.
          !(emulatePlatformCache && hasHandler) &&
          handlerPathname !== mp &&
          resolution.pool === poolName;
        // Pages Router fallback:true emits a build-time HTML shell under the dynamic route
        // template. A first document request for a path outside getStaticPaths must receive that
        // shell; its subsequent /_next/data request invokes the handler and materializes the
        // concrete result in the platform cache. Minimal-mode entrypoints deliberately block-render
        // instead, so serving this emitted artifact is the adapter's documented fallback role.
        // Keep PPR out of this branch: PPR shells use postponed state and the resume protocol below.
        const servePagesDynamicFallbackShell =
          emulatePlatformCache &&
          isReadMethod &&
          !isPagesDataRequest &&
          !isPreviewRequest &&
          !FALLBACK_BLOCKING_BOT_UA_RE.test(req.headers["user-agent"] ?? "") &&
          !!staticAsset?.prerender &&
          !staticAsset.ppr &&
          /\[[^/]+\]/.test(staticAsset.pathname) &&
          handlerPathname === mp &&
          !servedFallbackShells.has(requestPathname) &&
          resolution.pool === poolName;
        // Segment-prefetch outputs are independent build-time cache entries, not executable
        // handlers. `handlerPathname` deliberately maps them back to the parent page so dynamic
        // RSC requests can run, but a segment-prefetch request must still read its exact seeded
        // entry. Sending it to the parent with a document postponed token makes the app-page
        // entrypoint reject the request (404) and loses the Resume Data Cache payload.
        const serveRscPrerenderVariant =
          isReadMethod &&
          isRSC &&
          !!staticAsset?.prerender &&
          handlerPathname !== mp &&
          resolution.pool === poolName;
        const serveStaticFile = staticAsset && !staticAsset.prerender && isReadMethod;

        // Pages Router prerenders cannot own Server Actions. Reject writes from the adapter's
        // build metadata instead of relying on x-nextjs-cache: generated direct Pages entrypoints
        // do not consistently expose that internal response header. App prerenders still invoke
        // their handler so Server Actions remain supported.
        if (
          staticAsset?.prerender &&
          !isReadMethod &&
          (!hasHandler || handlerOutputInfo?.type === "PAGES")
        ) {
          res.writeHead(405, { allow: "GET, HEAD" });
          res.end();
          return;
        }

        if (
          entrypointOwnsPprShell &&
          serveRscPrerenderVariant &&
          typeof req.headers["next-router-segment-prefetch"] === "string"
        ) {
          // Next's deploy E2E has no Cloud CDN/Valkey platform layer. A real platform serves this
          // seeded segment immediately, then fills the more-specific route shell in its durable
          // middle cache. Reproduce only that missing orchestration here: keep the fast seeded
          // response, and run a document render whose output is discarded while Next writes the
          // upgraded shell to its filesystem cache. This branch is unreachable in production;
          // production cache ownership is the separately registered Valkey incremental handler.
          const backgroundHeaders = { ...req.headers };
          delete backgroundHeaders.rsc;
          delete backgroundHeaders["next-router-prefetch"];
          delete backgroundHeaders["next-router-segment-prefetch"];
          const backgroundReq = {
            method: "GET",
            url: req.url,
            headers: backgroundHeaders,
          } as IncomingMessage;
          void handlerLoader
            .load(handlerPathname)
            .then((handler) =>
              localHandlerInvoker({
                handler,
                req: backgroundReq,
                res,
                matchedPathname: handlerPathname,
                routeMatches: resolution.routeMatches,
                bufferedBody: undefined,
                discardResponse: true,
                render404: render404FromEntrypoint,
                renderError: renderErrorFromEntrypoint,
                ...(revalidate ? { revalidate } : {}),
              }),
            )
            .catch((error) => {
              console.error("[pool-server] background PPR shell fill failed:", error);
            });
        }

        if (
          staticAsset &&
          (serveStaticFile ||
            serveHandlerlessPrerender ||
            serveConcretePrerenderSeed ||
            servePagesDynamicFallbackShell ||
            serveRscPrerenderVariant)
        ) {
          const fullPath = path.resolve(process.cwd(), staticAsset.filePath);
          if (existsSync(fullPath)) {
            if (servePagesDynamicFallbackShell) {
              // NEXT_ENABLE_ADAPTER's deploy harness has no Valkey. Model one platform cache miss
              // per concrete URL; after the data request materializes the page, later documents
              // invoke Next's filesystem-cache stand-in. The explicit index.ts gate makes this
              // process-local marker unreachable in production.
              servedFallbackShells.add(requestPathname);
            }
            const content = readFileSync(fullPath);
            const assetHeaders = staticAsset.headers;
            const headers: Record<string, string | string[]> = Object.assign(
              {
                "cache-control": staticAsset.cacheControl,
                // Derive the type from the file being served, not the public
                // route: a prerendered page's pathname is extensionless (e.g.
                // "/" or "/index"), which getContentType maps to octet-stream —
                // so the browser downloads the HTML instead of rendering it.
                // The filePath (".next/server/pages/index.html") carries the
                // real extension. assetHeaders still overrides when present.
                "content-type": getStaticAssetContentType(
                  staticAsset.filePath,
                  staticAsset.pathname,
                ),
              },
              assetHeaders || {},
            );
            if (req.headers.rsc === "1") {
              const varyKey = Object.keys(headers).find((name) => name.toLowerCase() === "vary");
              const existingVary = varyKey ? headers[varyKey] : undefined;
              const varyTokens = new Set(
                (Array.isArray(existingVary) ? existingVary : [existingVary ?? ""])
                  .flatMap((value) => value.split(","))
                  .map((value) => value.trim().toLowerCase())
                  .filter(Boolean),
              );
              // Even a Pages prerender must vary from the App Router's RSC negotiation request.
              // Next's router-server normally adds these fields above static serving; a direct
              // adapter entrypoint has no such layer, so lock the protocol at this boundary.
              for (const token of [
                "rsc",
                "next-router-state-tree",
                "next-router-prefetch",
                "next-router-segment-prefetch",
              ]) {
                varyTokens.add(token);
              }
              if (varyKey && varyKey !== "vary") delete headers[varyKey];
              headers.vary = [...varyTokens].join(", ");
            }
            // Next's generated service-worker chunks are deliberately mutable and revalidated.
            // Static files bypass the Next server in this adapter, so the adapter must supply the
            // validator that Next's normal static-file server would have emitted. App-provided
            // ETags still win when an output explicitly owns one.
            const manifestEtagKey = Object.keys(headers).find(
              (name) => name.toLowerCase() === "etag",
            );
            const etag = String(
              resolution.resolvedHeaders?.get("etag") ??
                (manifestEtagKey ? headers[manifestEtagKey] : undefined) ??
                staticAssetEtag(content),
            );
            if (manifestEtagKey && manifestEtagKey !== "etag") delete headers[manifestEtagKey];
            headers.etag = etag;
            if (staticAsset.prerender) {
              // Next's generated entrypoint emits origin-cache directives (s-maxage/SWR) because
              // it normally owns ISR. In this adapter Valkey is the mutable ISR/PPR cache; Cloud
              // CDN must revalidate prerendered HTML rather than retaining a stale copy after a
              // Valkey regeneration. Apply the same client-facing policy as writeInnerResponse()
              // to build-time seeds and fallback shells, which bypass the entrypoint entirely.
              // This is production behavior, not an E2E-only environment-variable exception.
              headers["cache-control"] = "public, max-age=0, must-revalidate";
              delete headers["cache-tag"];
            }
            delete headers["x-next-cache-tags"];
            // Stamp the CDN cache tag from the EFFECTIVE cache-control (after assetHeaders
            // may have overridden it), and apply it last so it can't itself be overridden.
            // Mutable static (SSG HTML / public files) → tagged; immutable/max-age=0 → not.
            Object.assign(
              headers,
              cdnCacheTag(String(headers["cache-control"] ?? staticAsset.cacheControl), buildId),
            );
            if (ifNoneMatchMatches(req.headers["if-none-match"], etag)) {
              res.writeHead(304, headers);
              res.end();
              return;
            }
            res.writeHead(staticAsset.status ?? 200, headers);
            res.end(req.method === "HEAD" ? undefined : content);
            return;
          }
        }
      }

      switch (resolution.kind) {
        case "error": {
          res.writeHead(resolution.status, { "content-type": "text/plain; charset=utf-8" });
          res.end(resolution.status >= 500 ? "Internal Server Error" : "Bad Request");
          return;
        }

        case "redirect": {
          // Middleware/rule redirects can carry additional response headers
          // (e.g. NextResponse.redirect(url, { headers })) — forward them.
          const headers: Record<string, string | string[]> = resolution.resolvedHeaders
            ? webHeadersToNodeHeaders(resolution.resolvedHeaders)
            : {};
          delete headers["content-length"];
          const location = resolution.resolvedHeaders?.has("location")
            ? middlewareRedirectLocation(req, resolution.url)
            : resolution.url.toString();
          if (req.headers.rsc === "1") {
            // App Router flight requests cannot follow an HTTP redirect as an RSC payload. Next's
            // router-server converts it to a successful response carrying the internal redirect
            // field; the client router performs the navigation without a CORS/document fallback.
            delete headers["location"];
            headers["x-nextjs-redirect"] = location;
            res.writeHead(200, headers);
          } else {
            headers["location"] = location;
            res.writeHead(resolution.status, headers);
          }
          res.end();
          return;
        }

        case "middleware-response": {
          const mwRes = resolution.response;
          res.writeHead(mwRes.status, webHeadersToNodeHeaders(mwRes.headers));
          if (mwRes.body) {
            const reader = mwRes.body.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
              }
            } finally {
              reader.releaseLock();
            }
          }
          if (!res.writableEnded) res.end();
          return;
        }

        case "external-rewrite": {
          // Proxy the request to the external URL (middleware rewrite / next.config.js rewrite)
          const target = resolution.url;
          const proxyMod =
            target.protocol === "https:" ? await import("node:https") : await import("node:http");
          return new Promise<void>((resolve) => {
            const bufferedBody = (
              req as IncomingMessage & {
                [NEXT_REQUEST_META]?: { actionBody?: Buffer };
              }
            )[NEXT_REQUEST_META]?.actionBody;

            const proxyReq = proxyMod.request(
              {
                hostname: target.hostname,
                port: target.port || (target.protocol === "https:" ? 443 : 80),
                path: target.pathname + target.search,
                method: req.method,
                headers: {
                  ...req.headers,
                  host: target.host,
                },
              },
              (proxyRes) => {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                // pipeline handles errors on either end (e.g. client disconnect) and
                // cleans up both streams, unlike a bare .pipe().
                pipeline(proxyRes, res, () => resolve());
              },
            );

            proxyReq.on("error", (err) => {
              if (!res.headersSent) {
                res.writeHead(502, { "content-type": "text/plain" });
                res.end(`External rewrite failed: ${err.message}`);
              }
              resolve();
            });

            if (bufferedBody && bufferedBody.length > 0) {
              proxyReq.end(bufferedBody);
            } else if (req.method !== "GET" && req.method !== "HEAD") {
              pipeline(req, proxyReq, () => undefined);
            } else {
              proxyReq.end();
            }
          });
        }

        case "not-found": {
          // Render the app's custom 404 (App Router /_not-found or Pages Router /404), else plain text.
          const bufferedBody = (
            req as IncomingMessage & {
              [NEXT_REQUEST_META]?: { actionBody?: Buffer };
            }
          )[NEXT_REQUEST_META]?.actionBody;
          await serveNotFound(
            handlerLoader,
            localHandlerInvoker,
            staticAssets,
            req,
            res,
            bufferedBody,
            basePath,
          );
          return;
        }

        case "route": {
          // fallback: false / dynamicParams: false — a path matching a strict
          // dynamic route but not in the prerendered set 404s (as `next start`
          // does). Skipped for preview/revalidate requests, which legitimately
          // render non-generated paths on demand.
          if (strictDynamicRoutes.length > 0) {
            const reqPath = (resolution.invokePath || req.url || "/").split("?")[0] ?? "/";
            const dataPrefix = `${basePath}/_next/data/${buildIdForData}/`;
            const encodedPagePath = reqPath.startsWith(dataPrefix)
              ? "/" + reqPath.slice(dataPrefix.length).replace(/\.json$/, "")
              : reqPath;
            let pagePath = encodedPagePath;
            try {
              pagePath = decodeURIComponent(encodedPagePath);
            } catch {
              // Keep the encoded value; malformed escapes will simply fail the
              // prerender-manifest membership check below.
            }
            const isBypass =
              (req.headers.cookie ?? "").includes("__prerender_bypass=") ||
              "x-prerender-revalidate" in req.headers;
            if (
              !isBypass &&
              !prerenderedPaths.has(pagePath) &&
              strictDynamicRoutes.some((r) => r.pageRegex.test(pagePath))
            ) {
              await serveNotFound(
                handlerLoader,
                localHandlerInvoker,
                staticAssets,
                req,
                res,
                undefined,
                basePath,
              );
              return;
            }
          }

          // Apply middleware's final request-header set as a replacement, not a merge.
          // responseToMiddlewareResult processes x-middleware-set-cookie,
          // x-middleware-override-headers, and x-middleware-request-* headers.
          // The override list is authoritative: a listed header with no corresponding
          // x-middleware-request-* value means deletion. Merging would resurrect it.
          if (resolution.middlewareRequestHeaders) {
            const originalHost = req.headers.host;
            const nextHeaders: IncomingMessage["headers"] = {};
            for (const [key, value] of resolution.middlewareRequestHeaders.entries()) {
              if (key === "x-middleware-set-cookie") {
                // Parse Set-Cookie values and merge into cookie header so the
                // handler can read middleware-set cookies in the same request.
                const parts: string[] = [];
                for (const sc of value.split(/,(?=[^;]*=)/)) {
                  const nameVal = sc.trim().split(";")[0];
                  if (nameVal) parts.push(nameVal);
                }
                if (parts.length > 0) {
                  const existing = resolution.middlewareRequestHeaders.get("cookie") ?? "";
                  nextHeaders.cookie = [existing, ...parts].filter(Boolean).join("; ");
                }
                continue;
              }
              // Skip internal x-middleware-* control headers
              if (key.startsWith("x-middleware-")) continue;
              nextHeaders[key] = value;
            }
            if (!nextHeaders.host && originalHost) nextHeaders.host = originalHost;
            req.headers = nextHeaders;
          }

          // If this output belongs to another pool, proxy the request
          if (resolution.pool !== poolName && !handlerLoader.has(handlerPathname)) {
            return proxyToPool(req, res, resolution, releaseName, buildId, internalSecret);
          }

          // If no handler exists for this output, fall through to 404
          if (!handlerLoader.has(handlerPathname)) {
            if (!handlerLoader.has("/_not-found") && !handlerLoader.has("/404")) {
              console.log(
                `[dispatch] 404: no handler for matchedPathname="${handlerPathname}" url="${req.url}"`,
              );
            }
            const bufferedBody = (
              req as IncomingMessage & {
                [NEXT_REQUEST_META]?: { actionBody?: Buffer };
              }
            )[NEXT_REQUEST_META]?.actionBody;
            await serveNotFound(
              handlerLoader,
              localHandlerInvoker,
              staticAssets,
              req,
              res,
              bufferedBody,
              basePath,
            );
            return;
          }

          // Edge runtime routes: use the edge sandbox instead of the loopback HTTP server
          const outputInfo = handlerOutputInfo;
          if (edgeRouteRunner && outputInfo?.runtime === "edge") {
            const headerObj: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === "string") headerObj[key] = value;
              else if (Array.isArray(value)) headerObj[key] = value.join(", ");
            }
            // Edge Pages/API entrypoints observe the public request pathname,
            // even after a rewrite, but receive the rewrite-added query. Do
            // not replace req.url with the internal invocation target.
            const fullUrl = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
            if (resolution.invocationQuery) {
              for (const [key, value] of Object.entries(resolution.invocationQuery)) {
                fullUrl.searchParams.delete(key);
                for (const item of Array.isArray(value) ? value : [value]) {
                  fullUrl.searchParams.append(key, item);
                }
              }
            }
            const declaredParams = new Set<string>();
            for (const match of handlerPathname.matchAll(
              /\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g,
            )) {
              const paramName = match[1] ?? match[2];
              if (paramName) declaredParams.add(paramName);
            }
            const extractedEdgeParams =
              extractRouteParams(
                handlerPathname,
                resolution.routeMatches,
                resolution.invokePath ?? fullUrl.pathname,
              ) ?? {};
            const edgeRouteParams: Record<string, string | string[]> = {};
            const edgeRouteQueryParams: Record<string, string> = {};
            for (const key of declaredParams) {
              const internalKey = `nxtP${key}`;
              const routedValue =
                resolution.routeMatches?.[key] ?? resolution.routeMatches?.[internalKey];
              const value = extractedEdgeParams[key];
              if (value !== undefined) {
                edgeRouteParams[key] = value;
                // @next/routing uses nxtP<name> as the transport key. The
                // Edge entrypoints consume this transport key: Pages exposes it
                // as query.<name>, while EdgeRouteModuleWrapper reconstructs
                // App Route params from the URL search params.
                edgeRouteQueryParams[internalKey] =
                  routedValue ?? (Array.isArray(value) ? value.join("/") : value);
              }
            }
            // NextNodeServer.runEdgeFunction merges dynamic params into the
            // request URL query for Pages Router edge functions as well as
            // passing page.params. Pages getServerSideProps/API handlers build
            // `ctx.query` from that URL; page.params alone only populates
            // `ctx.params`. Edge App Routes also require the internal nxtP keys
            // because EdgeRouteModuleWrapper derives params from searchParams.
            // App Pages remain excluded: rewrite params can change their RSC
            // payload and their entrypoint consumes page.params directly.
            if (
              (outputInfo.type === "PAGES" ||
                outputInfo.type === "PAGES_API" ||
                outputInfo.type === "APP_ROUTE") &&
              Object.keys(edgeRouteQueryParams).length > 0
            ) {
              for (const [key, value] of Object.entries(edgeRouteQueryParams)) {
                fullUrl.searchParams.set(key, value);
              }
            }
            const filePath = path.resolve(process.cwd(), outputInfo.filePath);
            // Edge handlers use ctx.waitUntil for stale-while-revalidate and
            // other background cache work. Keep those promises observed but do
            // not await them before streaming the response. This is the same
            // lifecycle boundary NextNodeServer supplies to sandbox.run.
            const waitUntil = (waitable: Promise<unknown>): void => {
              void Promise.resolve(waitable).catch((error) => {
                console.error(`Edge background work failed for ${handlerPathname}:`, error);
              });
            };
            try {
              const result = await edgeRouteRunner({
                name: handlerPathname,
                paths: [filePath],
                request: {
                  url: fullUrl.toString(),
                  method: req.method,
                  headers: headerObj,
                  body:
                    req.method !== "GET" && req.method !== "HEAD"
                      ? (
                          req as IncomingMessage & { [NEXT_REQUEST_META]?: { actionBody?: Buffer } }
                        )[NEXT_REQUEST_META]?.actionBody
                      : undefined,
                  page: {
                    name: handlerPathname,
                    ...(Object.keys(edgeRouteParams).length > 0 && { params: edgeRouteParams }),
                  },
                  waitUntil,
                },
              });
              const edgeRes = result.response;
              res.writeHead(edgeRes.status, webHeadersToNodeHeaders(edgeRes.headers));
              if (edgeRes.body) {
                const reader = edgeRes.body.getReader();
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value && !(await writeChunkSafely(res, Buffer.from(value)))) break;
                  }
                } finally {
                  reader.releaseLock();
                }
              }
              if (!res.writableEnded) res.end();
              // The body is already complete, but the platform invocation must remain alive until
              // Edge after()/cache work settles. This mirrors the Node entrypoint lifecycle above
              // and prevents a pod/request teardown from dropping revalidation side effects.
              await result.waitUntil?.catch((error) => {
                console.error(`Edge background work failed for ${handlerPathname}:`, error);
              });
            } catch (err) {
              console.error(`Edge route handler failed for ${handlerPathname}:`, err);
              if (!res.headersSent) {
                res.writeHead(500, { "content-type": "text/plain" });
                res.end("Internal Server Error");
              }
            }
            return;
          }

          // For PPR routes, set the postponed state on request metadata so the handler resumes
          // the dynamic holes onto the prebuilt shell — BUT only when no classic incremental
          // cacheHandler is registered. When it is (incrementalCacheShared), that handler owns the
          // PPR shell (populated on first render, shared + revalidated cross-replica exactly like
          // `next start`); injecting the build-time disk token here would bypass that cache and
          // re-serve a stale shell after a cross-replica `revalidateTag`. A cache + edge-middleware
          // app has VALKEY_URL set but NO classic handler registered, so it keeps injecting here.
          // Prefer the route selected by @next/routing over its executable handler template.
          // PPR builds can emit both a generic shell (`/[lang]/[slug]`) and a more-specialized
          // shell (`/en/[slug]`). The handler is necessarily the generic template, but resuming
          // it with the generic postponed state for an `/en/*` request duplicates/misplaces the
          // root-param shell. Fall back to the handler key only when no specialized entry exists.
          const matchedPrerender = staticAssets.find(
            (asset) => asset.prerender && asset.pathname === resolution.matchedPathname,
          );
          const handlerPprInfo = [
            resolution.matchedPathname,
            handlerPathname,
            ...rscParentCandidates(resolution.matchedPathname, rscConfig),
            ...rscParentCandidates(handlerPathname, rscConfig),
          ]
            .map((candidate) => pprRoutes[candidate])
            .find((candidate) => candidate !== undefined);
          // A concrete non-PPR prerender under a PPR-capable dynamic handler is a blocking/static
          // branch of that route, not permission to reuse the handler template's generic shell.
          // Falling through to the generic postponed state leaks build-time layouts into requests
          // that Next intentionally classified as full renders.
          const manifestPprInfo =
            matchedPrerender && !matchedPrerender.ppr ? undefined : handlerPprInfo;
          const pprInfo = manifestPprInfo;
          let pprResponsePrefix:
            | {
                filePath: string;
                headers?: Record<string, string | string[]>;
                status?: number;
              }
            | undefined;
          let pprInvocationHeaders: Record<string, string> | undefined;
          if (pprInfo?.postponedState && !entrypointOwnsPprCache) {
            // Do NOT inject the resume token for Server Action requests. Next's app-page handler
            // only splits the postponed state out of the action body (via the
            // `x-next-resume-state-length` framing) when no `postponed` meta is already set —
            // injecting it here would leave the postponed prefix in the action body and corrupt
            // the action. Server actions carry the `next-action` header (or that length header).
            const isServerAction =
              !!req.headers["next-action"] || !!req.headers["x-next-resume-state-length"];
            // Without a classic handler owning the shell, still honor cross-replica revalidation:
            // if a tag baked into the shell has been revalidated since deploy (checked live against
            // the shared Valkey manifest), withhold the stale build-time token so the handler does a
            // fresh blocking render. Absent a shared cache, checkShellStale is undefined → inject.
            const pprTags = pprInfo.tags;
            const shellStale =
              checkShellStale && pprTags && pprTags.length > 0
                ? await checkShellStale(pprTags)
                : false;
            const shellPath = path.resolve(process.cwd(), pprInfo.fallbackFilePath);
            const shellAvailable = existsSync(shellPath);
            if (!isServerAction && !shellStale && shellAvailable) {
              const meta = ((req as any)[NEXT_REQUEST_META] as Record<string, unknown>) ?? {};
              meta.postponed = pprInfo.postponedState;
              (req as any)[NEXT_REQUEST_META] = meta;
              pprInvocationHeaders = pprInfo.chainHeaders;

              // Direct handler invocation with requestMeta.postponed returns only the resumed
              // dynamic stream. For document requests, prepend the build-time fallback shell so
              // the client receives the single `[shell][resume]` response required by the PPR
              // protocol. RSC requests consume only the resumed flight stream and must not get
              // HTML prepended.
              const isDocumentRequest =
                req.method === "GET" &&
                req.headers.rsc !== "1" &&
                req.headers["next-router-prefetch"] !== "1";
              if (isDocumentRequest) {
                pprResponsePrefix = {
                  filePath: shellPath,
                  ...(pprInfo.initialHeaders ? { headers: pprInfo.initialHeaders } : {}),
                  ...(pprInfo.initialStatus ? { status: pprInfo.initialStatus } : {}),
                };
              }
            }
          }

          // Load and invoke the handler directly
          const handler = await handlerLoader.load(handlerPathname);
          const bufferedBody = (
            req as IncomingMessage & {
              [NEXT_REQUEST_META]?: { actionBody?: Buffer };
            }
          )[NEXT_REQUEST_META]?.actionBody;

          await localHandlerInvoker({
            handler,
            req,
            res,
            matchedPathname: handlerPathname,
            routeMatches: resolution.routeMatches,
            bufferedBody,
            ...(resolution.invokePath ? { invocationPath: resolution.invokePath } : {}),
            // Next compiles an i18n index rewrite to a locale-prefixed concrete prerender, then
            // maps that artifact back to a locale-prefixed dynamic Pages handler. `invokePath`
            // deliberately strips an auto-added default locale, so it cannot recover the
            // handler's catch-all params. Preserve the resolver's concrete output solely for
            // param extraction. This is normal entrypoint metadata in production as well as the
            // NEXT_ENABLE_ADAPTER filesystem-cache harness; it does not alter req.url or caching.
            ...(resolution.matchedPathname !== handlerPathname &&
            !resolution.matchedPathname.includes("[")
              ? { routeParamPathname: resolution.matchedPathname }
              : {}),
            ...(resolution.invocationQuery ? { invocationQuery: resolution.invocationQuery } : {}),
            ...(i18nLocales.length > 0 ? { i18nLocales } : {}),
            ...(pprResponsePrefix ? { responsePrefix: pprResponsePrefix } : {}),
            ...(pprInvocationHeaders ? { invocationHeaders: pprInvocationHeaders } : {}),
            // Production invokes generated entrypoints in minimal mode because platform caching
            // lives outside Next: Cloud CDN may hold only public-safe variants, while Valkey owns
            // PPR/ISR/tag-sensitive entries. NEXT_ENABLE_ADAPTER's local harness has neither. Its
            // explicitly gated filesystem stand-in must use non-minimal mode only for routes with
            // a real build-emitted PPR shell so Next can read that shell locally. Routes whose
            // prerender metadata says `fallback: null` stay minimal and block-render; otherwise a
            // generic build shell is incorrectly served while the concrete URL renders later.
            // Use handler capability rather than `manifestPprInfo` here. A concrete document can
            // intentionally suppress build-token injection while a dynamic RSC request for the
            // same PPR-capable handler still needs Next's local cache to recover its RDC.
            minimalMode: !(
              (entrypointOwnsPprShell && !!handlerPprInfo) ||
              (emulatePlatformCache && !!dispatchStaticAsset?.prerender && !dispatchStaticAsset.ppr)
            ),
            normalizePrerenderCacheControl:
              !!dispatchStaticAsset?.prerender && handlerOutputInfo?.type === "PAGES",
            render404: render404FromEntrypoint,
            renderError: renderErrorFromEntrypoint,
            ...(revalidate ? { revalidate } : {}),
          });
          return;
        }
      }
    },
  };
}

function proxyToPool(
  req: IncomingMessage,
  res: ServerResponse,
  resolution: Extract<ResolveResult, { kind: "route" }>,
  releaseName: string,
  buildId: string,
  internalSecret?: string,
): Promise<void> {
  return new Promise((resolve) => {
    const targetHost = sanitizeK8sName(`${releaseName}-${resolution.pool}-${buildId}`);
    const proxyReq = httpRequest(
      {
        hostname: targetHost,
        port: 3000,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          "x-output-id": resolution.matchedPathname,
          "x-matched-pathname": resolution.matchedPathname,
          "x-route-matches": resolution.routeMatches ? JSON.stringify(resolution.routeMatches) : "",
          // This pool already ran the middleware stage in its Phase-1 resolve before deciding
          // to proxy; assert it so the target pool trusts the skip instead of re-running
          // middleware (which would double-apply cookies/redirects). Without this, the target's
          // x-mw-evaluated gate would fall through to a second evaluation.
          "x-mw-evaluated": "ran",
          ...(internalSecret ? { [INTERNAL_SECRET_HEADER]: internalSecret } : {}),
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        // pipeline handles errors on either end (e.g. client disconnect) and cleans up
        // both streams, unlike a bare .pipe().
        pipeline(proxyRes, res, () => resolve());
      },
    );

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Failed to proxy to pool "${resolution.pool}": ${err.message}`);
      }
      resolve();
    });

    const bufferedBody = (
      req as IncomingMessage & {
        [NEXT_REQUEST_META]?: { actionBody?: Buffer };
      }
    )[NEXT_REQUEST_META]?.actionBody;

    if (bufferedBody) {
      proxyReq.end(bufferedBody);
    } else {
      pipeline(req, proxyReq, () => undefined);
    }
  });
}

export function getContentType(pathname: string): string {
  const ext = path.extname(pathname).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    case ".rsc":
      return "text/x-component";
    case ".xml":
      return "application/xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".webmanifest":
      return "application/manifest+json";
    case ".wasm":
      return "application/wasm";
    case ".map":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case "":
      return "text/html; charset=utf-8"; // extensionless routes (/, /about, etc.)
    default:
      return "application/octet-stream";
  }
}

function getStaticAssetContentType(filePath: string, publicPathname: string): string {
  const artifactType = getContentType(filePath);
  if (artifactType !== "application/octet-stream") return artifactType;

  // Next stores prerendered metadata route bodies under opaque artifact names such as `.body`.
  // Their public pathname is the authoritative source of the media type. Keep this deliberately
  // narrow: a generic extensionless public asset may genuinely be binary and must not become HTML.
  if (
    /(?:^|\/)robots\.txt$/.test(publicPathname) ||
    /(?:^|\/)sitemap(?:\/\d+)?\.xml$/.test(publicPathname) ||
    /(?:^|\/)manifest\.(?:json|webmanifest)$/.test(publicPathname) ||
    /(?:^|\/)(?:icon|apple-icon|opengraph-image|twitter-image)(?:-[^/]+)?\.(?:png|svg|ico|jpe?g|gif|webp|avif)$/.test(
      publicPathname,
    )
  ) {
    return getContentType(publicPathname);
  }

  return artifactType;
}

export type Dispatcher = ReturnType<typeof createDispatcher>;
