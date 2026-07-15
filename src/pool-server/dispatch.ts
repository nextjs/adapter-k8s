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

// Swallow socket errors on a client stream. A mid-response client disconnect emits an
// 'error' on req/res; with no listener Node rethrows it as an uncaught 'error' event and
// takes the whole process down. There's nothing to recover — the connection is gone.
function guardStreamErrors(stream: IncomingMessage | ServerResponse): void {
  if (typeof (stream as { on?: unknown }).on === "function") {
    stream.on("error", () => undefined);
  }
}

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

async function writeInnerResponse(
  outerRes: ServerResponse,
  innerRes: IncomingMessage,
  forceStatus?: number,
): Promise<void> {
  const headers = { ...innerRes.headers };
  // Entrypoints emit origin-oriented s-maxage/private cache directives for
  // incremental responses. In adapter deploy mode the platform cache owns ISR,
  // while the browser-facing response must always revalidate. Next marks this
  // response class explicitly, so avoid altering SSR, APIs, or user headers.
  if (headers["x-nextjs-cache"] !== undefined) {
    headers["cache-control"] = "public, max-age=0, must-revalidate";
  }
  outerRes.writeHead(forceStatus ?? innerRes.statusCode ?? 200, headers);
  for await (const chunk of innerRes) {
    const canContinue = await writeChunkSafely(outerRes, chunk as Buffer);
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
  invocationQuery,
  forceStatus,
  render404,
  renderError,
  revalidate,
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
  /** Query resolved by @next/routing, excluding internal capture placeholders. */
  invocationQuery?: Record<string, string | string[]>;
  /** Override the response status regardless of what the handler set — used to make a not-found
   * render return 404 even when the underlying page handler (e.g. Pages Router `/404`) renders 200. */
  forceStatus?: number;
  /** Adapter-provided 404 renderer used when a Pages handler returns `notFound: true`. */
  render404?: Render404;
  /** Adapter-provided error renderer used when an entrypoint throws before sending a response. */
  renderError?: RenderError;
  /** In-process on-demand revalidation, matching Next's documented requestMeta contract. */
  revalidate?: Revalidate;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
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
          let invocationMeta: Record<string, unknown> = invocationQuery
            ? { query: invocationQuery }
            : {};
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
              query: invocationQuery ?? query,
              // The documented contract distinguishes the matched route
              // template from the concrete internal invocation target.
              resolvedPathname: matchedPathname,
              rewrittenPathname: target.pathname,
            };
          }
          const maybeResult = await (handler as any)(innerReq, innerRes, {
            waitUntil(waitable: Promise<unknown>) {
              void waitable.catch(() => undefined);
            },
            requestMeta: {
              relativeProjectDir: ".",
              hostname: req.headers.host?.split(":")[0] ?? "127.0.0.1",
              outputId: matchedPathname,
              matchedPathname,
              routeMatches,
              ...invocationMeta,
              ...(outerMeta.postponed ? { postponed: outerMeta.postponed } : {}),
              ...(render404 ? { render404 } : {}),
              ...(revalidate ? { revalidate } : {}),
            },
          });

          if (maybeResult instanceof Response) {
            await writeWebResponseToNode(innerRes, maybeResult);
            return;
          }

          if (!innerRes.writableEnded) {
            innerRes.end();
          }
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
          const methodNotAllowed =
            req.method !== "GET" &&
            req.method !== "HEAD" &&
            clientRes.headers["x-nextjs-cache"] !== undefined;
          void writeInnerResponse(
            res,
            clientRes,
            forceStatus ?? (methodNotAllowed ? 405 : undefined),
          )
            .then(() => {
              server.close(() => resolve());
            })
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
    } catch {
      // Fall through to the next candidate.
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
  pprRoutes?: Record<string, { postponedState: string; tags?: string[] }>;
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
  /** Re-enter the pool request pipeline for Pages API `res.revalidate()` without a network hop. */
  revalidate?: Revalidate;
  /** Configured public basePath. Output ids and static 404 assets may be basePath-prefixed. */
  basePath?: string;
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
    checkShellStale,
    revalidate,
    basePath = "",
  } = options;

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
        asset.pathname === (basePath ? `${basePath}/404` : "/404") ||
        asset.pathname === "/404",
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

    for (const errorPath of ["/500", "/_error"]) {
      if (!handlerLoader.has(errorPath)) continue;
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
        return;
      } catch (renderError) {
        console.error(`[pool-server] failed to render ${errorPath}:`, renderError);
      }
    }

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
      if (resolution.kind === "route" && req.url) {
        const requestPathname = new URL(req.url, "http://localhost").pathname;
        if (requestPathname.startsWith(`${basePath}/_next/data/`)) {
          const publicMatchedPathname = stripBasePath(resolution.matchedPathname, basePath);
          res.setHeader(
            "x-nextjs-matched-path",
            publicMatchedPathname === "/index" ? "/" : publicMatchedPathname,
          );
        }
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
                const existing = handlerHeaders["set-cookie"];
                const arr: string[] = [];
                if (existing) {
                  if (Array.isArray(existing)) arr.push(...existing);
                  else arr.push(existing);
                }
                for (const c of value.split(/,(?=[^;]*=)/)) {
                  arr.push(c.trim());
                }
                handlerHeaders["set-cookie"] = arr;
              } else if (!(key in handlerHeaders)) {
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

      // 1. Serve static assets from the manifest — build assets, public/ files,
      // and prerenders that have NO handler (fully-static pages-router SSG emits
      // no function; the build file is the only source and can never be
      // revalidated). Prerenders WITH a handler always go through it: Next's
      // incremental cache serves hits cheaply and owns all the semantics the
      // manifest file can't (ISR staleness, revalidatePath/Tag — including from
      // after(), draft mode, PPR resume). Non-GET/HEAD methods also fall
      // through — server actions POST to the page's own pathname.
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
        const isReadMethod = req.method === "GET" || req.method === "HEAD";
        // Handler-less prerenders (pages SSG emits no function) are served from
        // the manifest file for ANY method — upstream serves SSG pages on POST
        // too — but only when this pool owns the route; a wrong-pool guess must
        // fall through so proxyToPool can recover (PPR shells especially must
        // not be served incomplete by a non-owning pool). Build assets and
        // public/ files stay GET/HEAD-only: upstream 404s writes to them.
        const serveHandlerlessPrerender =
          staticAsset?.prerender && !hasHandler && resolution.pool === poolName;
        const serveStaticFile = staticAsset && !staticAsset.prerender && isReadMethod;

        if (staticAsset && (serveStaticFile || serveHandlerlessPrerender)) {
          const fullPath = path.resolve(process.cwd(), staticAsset.filePath);
          if (existsSync(fullPath)) {
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
                "content-type": getContentType(staticAsset.filePath),
              },
              assetHeaders || {},
            );
            res.writeHead(staticAsset.status ?? 200, headers);
            res.end(content);
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
          headers["location"] = resolution.url.toString();
          res.writeHead(resolution.status, headers);
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

          // Apply middleware's mutated request headers on top of the original.
          // responseToMiddlewareResult processes x-middleware-set-cookie,
          // x-middleware-override-headers, and x-middleware-request-* headers.
          // We merge them into the original headers rather than replacing —
          // let the Next.js handler handle any stripping/filtering internally.
          if (resolution.middlewareRequestHeaders) {
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
                  const existing = req.headers.cookie ?? "";
                  req.headers.cookie = [existing, ...parts].filter(Boolean).join("; ");
                }
                continue;
              }
              // Skip internal x-middleware-* control headers
              if (key.startsWith("x-middleware-")) continue;
              req.headers[key] = value;
            }
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
          const outputInfo = handlerLoader.get(handlerPathname);
          if (edgeRouteRunner && outputInfo?.runtime === "edge") {
            const headerObj: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
              if (typeof value === "string") headerObj[key] = value;
              else if (Array.isArray(value)) headerObj[key] = value.join(", ");
            }
            const fullUrl = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
            const declaredParams = new Set<string>();
            for (const match of handlerPathname.matchAll(
              /\[\[?\.\.\.([^\]]+)\]\]?|\[([^\]]+)\]/g,
            )) {
              const paramName = match[1] ?? match[2];
              if (paramName) declaredParams.add(paramName);
            }
            const edgeRouteParams: Record<string, string> = {};
            const edgeRouteQueryParams: Record<string, string> = {};
            for (const key of declaredParams) {
              const internalKey = `nxtP${key}`;
              const value =
                resolution.routeMatches?.[key] ?? resolution.routeMatches?.[internalKey];
              if (value !== undefined) {
                edgeRouteParams[key] = value;
                // @next/routing uses nxtP<name> as the transport key. The
                // Pages edge entrypoint consumes it, removes the internal key,
                // and exposes the value as query.<name>.
                edgeRouteQueryParams[internalKey] = value;
              }
            }
            // NextNodeServer.runEdgeFunction merges dynamic params into the
            // request URL query for Pages Router edge functions as well as
            // passing page.params. Pages getServerSideProps/API handlers build
            // `ctx.query` from that URL; page.params alone only populates
            // `ctx.params`. App Router deliberately does not receive this
            // merge because rewrite params can change its RSC payload.
            if (
              (outputInfo.type === "PAGES" || outputInfo.type === "PAGES_API") &&
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
              // The edge sandbox's background work must not surface as an unhandled
              // rejection (which would crash the process); we don't await it.
              result.waitUntil?.catch(() => undefined);
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
          const pprInfo = pprRoutes[handlerPathname] ?? pprRoutes[resolution.matchedPathname];
          if (pprInfo?.postponedState && !incrementalCacheShared) {
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
            const shellStale =
              checkShellStale && pprInfo.tags && pprInfo.tags.length > 0
                ? await checkShellStale(pprInfo.tags)
                : false;
            if (!isServerAction && !shellStale) {
              const meta = ((req as any)[NEXT_REQUEST_META] as Record<string, unknown>) ?? {};
              meta.postponed = pprInfo.postponedState;
              (req as any)[NEXT_REQUEST_META] = meta;
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
            ...(resolution.invocationQuery
              ? { invocationQuery: resolution.invocationQuery }
              : {}),
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

export type Dispatcher = ReturnType<typeof createDispatcher>;
