import { resolveRoutes, responseToMiddlewareResult } from '@next/routing';
import type { RoutingManifest } from '../types.js';
import type { ProcessingResponse, HeaderValue } from './ext-proc-types.js';
import {
  buildImmediateResponse,
  buildHeaderMutationResponse,
  type HeaderMutationEntry,
} from './response-builders.js';

type LoadedModule = Record<string, unknown>;

function getHeader(headers: HeaderValue[], key: string): string | undefined {
  const h = headers.find(h => h.key === key);
  if (!h) return undefined;
  if (h.value) return h.value;
  if (h.rawValue) return h.rawValue.toString('utf-8');
  return undefined;
}

export function createRequestHandler(
  manifest: RoutingManifest,
  middlewareModule: LoadedModule | null,
) {
  return async function handleRequest(
    requestHeaders: HeaderValue[],
  ): Promise<ProcessingResponse> {
    const path = getHeader(requestHeaders, ':path') ?? '/';
    const method = getHeader(requestHeaders, ':method') ?? 'GET';
    const scheme = getHeader(requestHeaders, ':scheme') ?? 'https';
    const authority = getHeader(requestHeaders, ':authority') ?? 'localhost';
    const url = new URL(`${scheme}://${authority}${path}`);

    const headers = new Headers(
      requestHeaders
        .filter(h => !h.key.startsWith(':'))
        .map(h => [h.key, h.value ?? h.rawValue?.toString('utf-8') ?? ''] as [string, string]),
    );

    let middlewareResponse: Response | undefined;

    const resolution = await resolveRoutes({
      url,
      buildId: manifest.buildId,
      basePath: manifest.basePath,
      requestBody: new ReadableStream({ start(c) { c.close(); } }),
      headers,
      pathnames: manifest.pathnames,
      i18n: (manifest.i18n || undefined) as any,
      routes: manifest.routeGraph,
      invokeMiddleware: middlewareModule
        ? async (ctx) => {
            const request = new Request(ctx.url.toString(), {
              method,
              headers: new Headers(ctx.headers),
              body: null,
            });
            const handlerFn = typeof middlewareModule.default === 'function'
              ? middlewareModule.default
              : (middlewareModule.default as Record<string, unknown>)?.default;
            if (typeof handlerFn !== 'function') return {};
            const result = await (handlerFn as any)({ request });
            if (result.waitUntil) await result.waitUntil;
            if (result.response) {
              middlewareResponse = result.response;
              return responseToMiddlewareResult(
                result.response.clone(),
                new Headers(ctx.headers),
                ctx.url,
              );
            }
            return {};
          }
        : async () => ({}),
    });

    if (resolution.redirect) {
      return buildImmediateResponse(resolution.redirect.status, {
        location: resolution.redirect.url.toString(),
      });
    }

    if (resolution.middlewareResponded && middlewareResponse != null) {
      const mwRes = middlewareResponse as Response;
      const respHeaders: Record<string, string> = {};
      for (const [key, value] of mwRes.headers.entries()) {
        respHeaders[key] = value;
      }
      return buildImmediateResponse(
        mwRes.status,
        respHeaders,
        await mwRes.text(),
      );
    }

    if (resolution.externalRewrite) {
      return buildImmediateResponse(
        502,
        { 'content-type': 'text/plain; charset=utf-8' },
        `External rewrites are not supported in adapter-k8s v1. ` +
        `Attempted rewrite to: ${resolution.externalRewrite.toString()}\n` +
        `Use a Route Handler to proxy external APIs instead.`,
      );
    }

    const matchedPathname = resolution.resolvedPathname
      ?? resolution.invocationTarget?.pathname
      ?? path;

    const mutations: HeaderMutationEntry[] = [];

    if (resolution.resolvedHeaders) {
      for (const [key, value] of resolution.resolvedHeaders.entries()) {
        mutations.push({ key, value });
      }
    }

    const pool = manifest.poolAssignments[matchedPathname]
      ?? Object.values(manifest.poolAssignments)[0]
      ?? 'default';
    mutations.push({ key: 'x-upstream-pool', value: pool });

    mutations.push({ key: 'x-matched-pathname', value: matchedPathname });
    if (resolution.routeMatches) {
      mutations.push({
        key: 'x-route-matches',
        value: JSON.stringify(resolution.routeMatches),
      });
    }

    if (matchedPathname in manifest.pprRoutes) {
      mutations.push({ key: 'x-nextjs-ppr', value: '1' });
    }

    return buildHeaderMutationResponse(mutations);
  };
}
