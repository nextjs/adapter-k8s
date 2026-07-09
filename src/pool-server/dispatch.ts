// src/pool-server/dispatch.ts
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { pipeline } from "node:stream";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HandlerLoader } from "./handler-loader.js";
import type { ResolveResult } from "./resolve.js";
import type { StaticAssetEntry } from "../types.js";
import { rscParentCandidates, templateOutputCandidates, type RscConfig } from "../routing-common.js";

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
): Promise<void> {
  outerRes.writeHead(innerRes.statusCode ?? 200, innerRes.headers);
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

async function invokeLocalHandlerOverHttp({
  handler,
  req,
  res,
  matchedPathname,
  routeMatches,
  bufferedBody,
}: {
  handler: HandlerLoader extends { load(outputId: string): Promise<infer T> } ? T : never;
  req: IncomingMessage;
  res: ServerResponse;
  matchedPathname: string;
  routeMatches: Record<string, string> | null;
  bufferedBody: Buffer | undefined;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer((innerReq, innerRes) => {
      void (async () => {
        try {
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
            },
          });

          if (maybeResult instanceof Response) {
            innerRes.writeHead(maybeResult.status, webHeadersToNodeHeaders(maybeResult.headers));
            if (maybeResult.body) {
              const reader = maybeResult.body.getReader();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (value) innerRes.write(Buffer.from(value));
                }
              } finally {
                reader.releaseLock();
              }
            }
            innerRes.end();
            return;
          }

          if (!innerRes.writableEnded) {
            innerRes.end();
          }
        } catch (error) {
          if (!innerRes.headersSent) {
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
          void writeInnerResponse(res, clientRes)
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
  pprRoutes?: Record<string, { postponedState: string }>;
  rscConfig?: RscConfig | undefined;
  /** All output ids in this pool's manifest — used to map concrete prerender
   * paths back to their dynamic-route template handler (outputs of dynamic
   * routes are keyed by template, e.g. "/blog/[slug]"). */
  outputIds?: string[];
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
  } = options;

  return {
    async dispatch(
      req: IncomingMessage,
      res: ServerResponse,
      resolution: ResolveResult,
    ): Promise<void> {
      // A client that disconnects mid-response emits 'error' on the socket; without a
      // listener Node crashes the process. Guard the outer client response up front.
      guardStreamErrors(res);

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
                "content-type": getContentType(staticAsset.pathname),
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
          // Try to invoke the app's /_not-found handler for a styled 404 page
          if (handlerLoader.has("/_not-found")) {
            try {
              const handler = await handlerLoader.load("/_not-found");
              const bufferedBody = (
                req as IncomingMessage & {
                  [NEXT_REQUEST_META]?: { actionBody?: Buffer };
                }
              )[NEXT_REQUEST_META]?.actionBody;

              await localHandlerInvoker({
                handler,
                req,
                res,
                matchedPathname: "/_not-found",
                routeMatches: null,
                bufferedBody,
              });
              return;
            } catch {
              // Fall through to plain text 404
            }
          }
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Not Found");
          return;
        }

        case "route": {
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
            return proxyToPool(req, res, resolution, releaseName, buildId);
          }

          // If no handler exists for this output, fall through to 404
          if (!handlerLoader.has(handlerPathname)) {
            if (handlerLoader.has("/_not-found")) {
              const notFoundHandler = await handlerLoader.load("/_not-found");
              const bufferedBody = (
                req as IncomingMessage & {
                  [NEXT_REQUEST_META]?: { actionBody?: Buffer };
                }
              )[NEXT_REQUEST_META]?.actionBody;
              await localHandlerInvoker({
                handler: notFoundHandler,
                req,
                res,
                matchedPathname: "/_not-found",
                routeMatches: null,
                bufferedBody,
              });
              return;
            }
            console.log(
              `[dispatch] 404: no handler for matchedPathname="${handlerPathname}" url="${req.url}"`,
            );
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("Not Found");
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
            const filePath = path.resolve(process.cwd(), outputInfo.filePath);
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
                    ...(resolution.routeMatches && { params: resolution.routeMatches }),
                  },
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

          // For PPR routes, set the postponed state on request metadata.
          // The handler reads this to resume streaming dynamic content after the static shell.
          const pprInfo = pprRoutes[handlerPathname] ?? pprRoutes[resolution.matchedPathname];
          if (pprInfo?.postponedState) {
            const meta = ((req as any)[NEXT_REQUEST_META] as Record<string, unknown>) ?? {};
            meta.postponed = pprInfo.postponedState;
            (req as any)[NEXT_REQUEST_META] = meta;
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
