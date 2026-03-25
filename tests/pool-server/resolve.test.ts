// tests/pool-server/resolve.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createLocalResolver } from '../../src/pool-server/resolve.js';
import { mockRouting } from '../helpers/mock-outputs.js';
import type { RoutingManifest } from '../../src/types.js';

vi.mock('@next/routing', async () => {
  const actual = await vi.importActual('@next/routing');
  return {
    ...actual,
    resolveRoutes: vi.fn(),
  };
});
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
    pathnames: ['/', '/about', '/api/hello', '/old-page'],
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

describe('createLocalResolver', () => {
  it('resolves a known static route', async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      resolvedPathname: '/about',
      invocationTarget: { pathname: '/about' },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL('http://localhost/about'),
      new Headers(),
    );
    expect(result.kind).toBe('route');
    if (result.kind === 'route') {
      expect(result.pool).toBe('ssr');
    }
  });

  it('returns redirect when resolveRoutes returns redirect', async () => {
    const manifest = makeManifest();
    (resolveRoutes as any).mockResolvedValue({
      redirect: { url: new URL('http://localhost/new-page'), status: 301 },
    });
    const resolver = createLocalResolver(manifest);
    const result = await resolver.resolve(
      new URL('http://localhost/old-page'),
      new Headers(),
    );
    expect(result.kind).toBe('redirect');
    if (result.kind === 'redirect') {
      expect(result.status).toBe(301);
      expect(result.url.pathname).toBe('/new-page');
    }
  });
});
