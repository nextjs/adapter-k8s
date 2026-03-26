import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequestHandler } from '../../src/routing-service/handler.js';
import { mockRouting } from '../helpers/mock-outputs.js';
import type { RoutingManifest } from '../../src/types.js';
import type { HeaderValue } from '../../src/routing-service/ext-proc-types.js';

vi.mock('@next/routing', () => ({
  resolveRoutes: vi.fn(),
  responseToMiddlewareResult: vi.fn(),
}));

import { resolveRoutes } from '@next/routing';

function makeManifest(overrides: Partial<RoutingManifest> = {}): RoutingManifest {
  const routing = mockRouting();
  return {
    routeGraph: {
      beforeMiddleware: routing.beforeMiddleware,
      beforeFiles: routing.beforeFiles,
      afterFiles: routing.afterFiles,
      dynamicRoutes: routing.dynamicRoutes,
      onMatch: routing.onMatch,
      fallback: routing.fallback,
      shouldNormalizeNextData: routing.shouldNormalizeNextData,
      rsc: routing.rsc,
    },
    pathnames: ['/', '/about', '/api/hello'],
    i18n: null,
    buildId: 'test123',
    basePath: '',
    middleware: null,
    poolAssignments: { '/': 'ssr', '/about': 'ssr', '/api/hello': 'api' },
    pprRoutes: {},
    nextVersion: '16.2.0',
    ...overrides,
  };
}

function makeHeaders(path: string): HeaderValue[] {
  return [
    { key: ':path', value: path },
    { key: ':method', value: 'GET' },
    { key: ':scheme', value: 'https' },
    { key: ':authority', value: 'app.example.com' },
    { key: 'host', value: 'app.example.com' },
  ];
}

describe('createRequestHandler', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns header mutations for a normal route', async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: '/about',
      invocationTarget: { pathname: '/about', query: {} },
      routeMatches: undefined,
      resolvedHeaders: undefined,
    } as any);

    const response = await handler(makeHeaders('/about'));
    expect(response.requestHeaders).toBeDefined();
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const poolHeader = setHeaders.find(h => h.header.key === 'x-upstream-pool');
    expect(poolHeader!.header.value).toBe('ssr');
    const matchedHeader = setHeaders.find(h => h.header.key === 'x-matched-pathname');
    expect(matchedHeader!.header.value).toBe('/about');
  });

  it('returns immediate response for redirect', async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      redirect: { url: new URL('https://app.example.com/new'), status: 301 },
    } as any);

    const response = await handler(makeHeaders('/old'));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(301);
  });

  it('returns 502 for external rewrites', async () => {
    const handler = createRequestHandler(makeManifest(), null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      externalRewrite: new URL('https://external.com/api'),
    } as any);

    const response = await handler(makeHeaders('/proxy'));
    expect(response.immediateResponse).toBeDefined();
    expect(response.immediateResponse!.status!.code).toBe(502);
    expect(response.immediateResponse!.body).toContain('External rewrites');
  });

  it('sets x-nextjs-ppr header for PPR routes', async () => {
    const manifest = makeManifest({
      pprRoutes: { '/dashboard': { postponedState: 'abc', fallbackFilePath: '/dist/dashboard.html' } },
      poolAssignments: { '/dashboard': 'ssr' },
      pathnames: ['/dashboard'],
    });
    const handler = createRequestHandler(manifest, null);
    vi.mocked(resolveRoutes).mockResolvedValue({
      resolvedPathname: '/dashboard',
      invocationTarget: { pathname: '/dashboard', query: {} },
    } as any);

    const response = await handler(makeHeaders('/dashboard'));
    const setHeaders = response.requestHeaders!.response!.headerMutation!.setHeaders!;
    const pprHeader = setHeaders.find(h => h.header.key === 'x-nextjs-ppr');
    expect(pprHeader).toBeDefined();
    expect(pprHeader!.header.value).toBe('1');
  });
});
