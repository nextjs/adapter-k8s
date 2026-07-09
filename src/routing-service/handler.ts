import { resolveRoutes, responseToMiddlewareResult } from "@next/routing";
import type { RoutingManifest } from "../types.js";
import type { ProcessingResponse, HeaderValue } from "./ext-proc-types.js";
import {
  buildImmediateResponse,
  buildHeaderMutationResponse,
  type HeaderMutationEntry,
} from "./response-builders.js";
import {
  lookupPool,
  manifestNextConfig,
  matchesMiddleware,
  normalizeMatchedPathname,
  normalizeResolvedRedirect,
  preferConcreteOutput,
  prepareRequest,
  resolveRscOutput,
  INTERNAL_DISPATCH_HEADERS,
  INTERNAL_SECRET_HEADER,
  type RscConfig,
} from "../routing-common.js";

type LoadedModule = Record<string, unknown>;

function getHeader(headers: HeaderValue[], key: string): string | undefined {
  const h = headers.find((h) => h.key === key);
  if (!h) return undefined;
  if (h.value) return h.value;
  if (h.rawValue) return h.rawValue.toString("utf-8");
  return undefined;
}

// Serialize the resolved response headers (next.config `headers()` + middleware response
// headers) into a single JSON internal header. The pool applies these to the RESPONSE
// (dispatch.ts merges resolvedHeaders via a writeHead wrapper). Emitting them as individual
// request-header mutations — as this handler used to — both drops them (they never reach the
// response) and leaks their values into the upstream request under their real names.
function serializeResolvedHeaders(resolved: Headers): string | null {
  const obj: Record<string, string | string[]> = {};
  for (const [key, value] of resolved.entries()) {
    // Headers.entries() folds repeated Set-Cookie into one comma-joined value; collect them
    // separately below so each cookie survives intact.
    if (key.toLowerCase() === "set-cookie") continue;
    obj[key] = value;
  }
  const cookies = resolved.getSetCookie?.() ?? [];
  if (cookies.length > 0) obj["set-cookie"] = cookies;
  if (Object.keys(obj).length === 0) return null;
  return JSON.stringify(obj);
}

export function createRequestHandler(
  manifest: RoutingManifest,
  middlewareModule: LoadedModule | null,
) {
  // Shared secret authenticating the internal dispatch headers to the pool. Present in GKE
  // (injected from a Secret); absent in emulate/tests, where the pool trusts nothing over the
  // wire and re-resolves locally. Read once — the deployment env is fixed for the process.
  const internalSecret = process.env.INTERNAL_HEADER_SECRET || undefined;
  const rscConfig = (manifest.routeGraph as { rsc?: RscConfig } | undefined)?.rsc;

  return async function handleRequest(requestHeaders: HeaderValue[]): Promise<ProcessingResponse> {
    const path = getHeader(requestHeaders, ":path") ?? "/";
    const method = getHeader(requestHeaders, ":method") ?? "GET";
    const scheme = getHeader(requestHeaders, ":scheme") ?? "https";
    const authority = getHeader(requestHeaders, ":authority") ?? "localhost";
    const url = new URL(`${scheme}://${authority}${path}`);

    const headers = new Headers(
      requestHeaders
        .filter((h) => !h.key.startsWith(":"))
        .map((h) => [h.key, h.value ?? h.rawValue?.toString("utf-8") ?? ""] as [string, string]),
    );

    // Shared request normalization (decode-400, slash-collapse 308, locale
    // prefixing) — one sequence with the pool resolver (routing-common.ts).
    const prep = prepareRequest(url, headers, manifest);
    if (prep.kind === "error") {
      return buildImmediateResponse(prep.status, { "content-type": "text/plain; charset=utf-8" });
    }
    if (prep.kind === "redirect") {
      return buildImmediateResponse(prep.status, { location: prep.url.toString() });
    }
    const resolveUrl = prep.url;

    // Body-capable requests (non-GET/HEAD) with middleware are NOT resolved at the edge: the
    // header-phase ext_proc callout never sees the request body, so body-reading middleware
    // would decide on an empty body. Instead we hand off to the pool's Phase-1 resolver, which
    // has the real buffered body. Crucially we do NOT just pass through — we CLEAR every
    // internal dispatch header (no secret, so the pool wouldn't trust them anyway, but this is
    // the first line of defense) so a client can't smuggle a spoofed x-output-id past the
    // extension and have the pool dispatch straight to a handler, bypassing middleware auth.
    // No secret is added, so the pool treats the request as untrusted → runs Phase 1.
    if (middlewareModule && method !== "GET" && method !== "HEAD") {
      return buildHeaderMutationResponse(
        [],
        [...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER],
      );
    }

    let middlewareResponse: Response | undefined;
    // Fail CLOSED on middleware throw — see pool-server/resolve.ts. A crashing
    // middleware must 500, not silently emit trusted dispatch headers that let
    // the request bypass the auth/redirects/rewrites middleware implements.
    let middlewareThrew = false;

    const resolution = await resolveRoutes({
      url: resolveUrl,
      buildId: manifest.buildId,
      basePath: manifest.basePath,
      requestBody: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      headers,
      pathnames: manifest.pathnames,
      i18n: (manifest.i18n || undefined) as any,
      routes: manifest.routeGraph,
      // Next.js middleware modules have multiple shapes depending on compilation
      // target. The ordering here MUST match pool-server/resolve.ts (paths 1/2/3);
      // web-adapter first is load-bearing — the legacy path strips control headers
      // from the response, which makes responseToMiddlewareResult misinterpret it.
      // The routing-service runs Node middleware only, so there is no edge-sandbox
      // path 0 here.
      invokeMiddleware: middlewareModule
        ? async (ctx) => {
            try {
              // Honor the middleware `matcher` config (parity with the pool
              // resolver) — skip middleware for requests it doesn't match.
              if (!matchesMiddleware(manifest.middleware?.matchers, ctx.url, ctx.headers)) {
                return {};
              }

              let response: Response | null = null;

              const adapterFn =
                typeof middlewareModule.default === "function"
                  ? (middlewareModule.default as (...args: unknown[]) => unknown)
                  : typeof middlewareModule === "function"
                    ? (middlewareModule as unknown as (...args: unknown[]) => unknown)
                    : null;

              const handlerFn =
                (middlewareModule as Record<string, unknown>).proxy ||
                (middlewareModule as Record<string, unknown>).middleware ||
                middlewareModule;

              const legacyMiddlewareFn =
                typeof (middlewareModule.default as Record<string, unknown> | undefined)
                  ?.default === "function"
                  ? ((middlewareModule.default as Record<string, unknown>).default as (
                      ...args: unknown[]
                    ) => unknown)
                  : null;

              if (!adapterFn && !handlerFn && !legacyMiddlewareFn) return {};

              const waitUntil = (waitable: Promise<unknown>) => {
                void waitable.catch(() => undefined);
              };

              // Path 1: Web adapter (default({ handler, request, page }))
              if (adapterFn && handlerFn) {
                const requestHeaders = Object.fromEntries(
                  [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                );
                const result = await (adapterFn as any)({
                  handler: handlerFn,
                  request: {
                    url: ctx.url.toString(),
                    method,
                    headers: requestHeaders,
                    body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                    signal: new AbortController().signal,
                    nextConfig: manifestNextConfig(manifest),
                    waitUntil,
                  },
                  page: "middleware",
                });

                response =
                  result?.response instanceof Response
                    ? result.response
                    : result instanceof Response
                      ? result
                      : null;
              }

              // Path 2: Legacy middleware (default.default)
              if (!response && legacyMiddlewareFn) {
                const requestHeaders = Object.fromEntries(
                  [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                );
                const result = await (legacyMiddlewareFn as any)({
                  request: {
                    url: ctx.url.toString(),
                    method,
                    headers: requestHeaders,
                    body: method !== "GET" && method !== "HEAD" ? ctx.requestBody : undefined,
                    destination: "document",
                    credentials: "same-origin",
                    bodyUsed: false,
                    mode: "navigate",
                    redirect: "follow",
                  },
                });

                if (result?.waitUntil) {
                  await result.waitUntil;
                }

                response =
                  result?.response instanceof Response
                    ? result.response
                    : result instanceof Response
                      ? result
                      : null;
              }

              // Path 3: Direct handler invocation
              if (!response && typeof handlerFn === "function") {
                const requestInit: RequestInit & { duplex?: "half" } = {
                  method,
                  headers: new Headers(
                    [...ctx.headers.entries()].filter(([k]) => !k.startsWith(":")),
                  ),
                  duplex: "half",
                };
                if (method !== "GET" && method !== "HEAD") {
                  requestInit.body = ctx.requestBody;
                }
                const middlewareRequest = new Request(ctx.url.toString(), requestInit);
                const result = await (handlerFn as any)(middlewareRequest, { waitUntil });

                response =
                  result instanceof Response
                    ? result
                    : result?.response instanceof Response
                      ? result.response
                      : null;
              }

              if (response) {
                middlewareResponse = response;
                return responseToMiddlewareResult(
                  response.clone(),
                  new Headers(ctx.headers),
                  ctx.url,
                );
              }
              return {};
            } catch (err) {
              console.error("[routing-service] Middleware execution failed:", err);
              middlewareThrew = true;
              return { bodySent: true };
            }
          }
        : async () => ({}),
    });

    if (middlewareThrew) {
      return buildImmediateResponse(500, { "content-type": "text/plain; charset=utf-8" });
    }

    // Redirects (rule/detection + Location-in-resolvedHeaders) — shared
    // normalization with the pool resolver. Forward resolvedHeaders (middleware
    // Set-Cookie, custom redirect headers) so the edge matches the pool phase.
    const redirect = normalizeResolvedRedirect(resolution, prep, manifest);
    if (redirect) {
      if (redirect.kind === "retry") {
        // Spurious internal trailing-slash redirect — resolve the real target.
        const retried = requestHeaders.map((h) =>
          h.key === ":path"
            ? { ...h, value: redirect.retryUrl.pathname + redirect.retryUrl.search }
            : h,
        );
        return handleRequest(retried);
      }
      const responseHeaders: Record<string, string> = { location: redirect.url.toString() };
      const setCookies = redirect.resolvedHeaders?.getSetCookie?.() ?? [];
      if (redirect.resolvedHeaders) {
        for (const [key, value] of redirect.resolvedHeaders.entries()) {
          const k = key.toLowerCase();
          if (k === "location" || k === "set-cookie" || k === "content-length") continue;
          responseHeaders[key] = value;
        }
      }
      return buildImmediateResponse(redirect.status, responseHeaders, undefined, setCookies);
    }

    if (resolution.middlewareResponded && middlewareResponse != null) {
      const mwRes = middlewareResponse as Response;
      const respHeaders: Record<string, string> = {};
      for (const [key, value] of mwRes.headers.entries()) {
        // Headers.entries() folds multiple Set-Cookie into one comma-joined
        // value; skip them here and forward each intact via getSetCookie().
        if (key.toLowerCase() === "set-cookie") continue;
        respHeaders[key] = value;
      }
      const setCookies = mwRes.headers.getSetCookie();
      return buildImmediateResponse(mwRes.status, respHeaders, await mwRes.text(), setCookies);
    }

    if (resolution.externalRewrite) {
      return buildImmediateResponse(
        502,
        { "content-type": "text/plain; charset=utf-8" },
        `External rewrites are not supported in adapter-k8s v1. ` +
          `Attempted rewrite to: ${resolution.externalRewrite.toString()}\n` +
          `Use a Route Handler to proxy external APIs instead.`,
      );
    }

    // Pool ownership is looked up on the BASE pathname (RSC variants live in the same pool as
    // their page). The output id, however, must be the RSC-mapped variant so the handler
    // returns a flight payload instead of HTML — mirrors pool-server/resolve.ts.
    let basePathname = normalizeMatchedPathname(
      resolution.resolvedPathname ?? resolution.invocationTarget?.pathname ?? path,
      manifest.poolAssignments,
    );
    // Concrete prerendered outputs win over dynamic templates (decoded lookup).
    // Mirrors pool-server/resolve.ts.
    basePathname =
      preferConcreteOutput(resolveUrl.pathname, basePathname, manifest.poolAssignments) ?? basePathname;
    const outputId = resolveRscOutput(basePathname, headers, rscConfig, manifest.poolAssignments);

    const mutations: HeaderMutationEntry[] = [];
    // Every internal dispatch header the extension does NOT set this response must be actively
    // removed, so a client can't smuggle one past the extension (setHeaders only overwrites the
    // keys it lists). We start by clearing all of them, then un-clear each key we set below.
    const clear = new Set<string>([...INTERNAL_DISPATCH_HEADERS, INTERNAL_SECRET_HEADER]);
    const setDispatch = (key: string, value: string) => {
      mutations.push({ key, value });
      clear.delete(key);
    };

    // next.config headers() + middleware response headers → carried as one JSON header and
    // applied to the RESPONSE by the pool (NOT emitted as request-header mutations).
    if (resolution.resolvedHeaders) {
      const serialized = serializeResolvedHeaders(resolution.resolvedHeaders);
      if (serialized) setDispatch("x-resolved-headers", serialized);
    }

    const i18nLocales = (manifest.i18n as any)?.locales as string[] | undefined;
    const pool =
      lookupPool(
        manifest.poolAssignments,
        resolution.resolvedPathname,
        resolution.invocationTarget?.pathname ?? path,
        i18nLocales,
      ) ?? "default";
    setDispatch("x-upstream-pool", pool);

    // x-output-id tells the pool server which handler to invoke directly,
    // bypassing local resolveRoutes() (avoids double resolution + middleware)
    setDispatch("x-output-id", outputId);
    setDispatch("x-matched-pathname", outputId);
    if (resolution.routeMatches) {
      setDispatch("x-route-matches", JSON.stringify(resolution.routeMatches));
    }

    if (basePathname in manifest.pprRoutes) {
      setDispatch("x-nextjs-ppr", "1");
    }

    // Authenticate the dispatch headers to the pool. Only the trusted extension knows the
    // secret; the pool ignores (strips) dispatch headers on any request whose secret doesn't
    // match, so a spoofed x-output-id on a CEL-excluded path or during a fail-open outage is
    // rejected. Absent in emulate/tests (no secret configured) — the pool re-resolves locally.
    if (internalSecret) {
      mutations.push({ key: INTERNAL_SECRET_HEADER, value: internalSecret });
      clear.delete(INTERNAL_SECRET_HEADER);
    }

    return buildHeaderMutationResponse(mutations, [...clear]);
  };
}
