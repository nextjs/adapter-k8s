import { describe, it, expect } from 'vitest';
import { generateCelExpression, extractStaticPrefix } from '../src/cel.js';
import { mockOutputs, mockStaticFile, mockPrerender, mockAppPage, mockAppRoute } from './helpers/mock-outputs.js';

describe('extractStaticPrefix', () => {
  it('extracts prefix from dynamic route regex', () => {
    expect(extractStaticPrefix('^/blog/([^/]+?)(?:/)?$')).toBe('/blog/');
  });
  it('extracts prefix from nested dynamic route', () => {
    expect(extractStaticPrefix('^/api/users/([^/]+?)/posts(?:/)?$')).toBe('/api/users/');
  });
  it('returns null for root-level dynamic route', () => {
    expect(extractStaticPrefix('^/([^/]+?)(?:/)?$')).toBe('/');
  });
  it('returns null for unparseable regex', () => {
    expect(extractStaticPrefix('(?:)')).toBeNull();
  });
});

describe('generateCelExpression', () => {
  it('generates exclusion list when middleware exists', () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: '/favicon.ico' }),
        mockStaticFile({ pathname: '/robots.txt' }),
      ],
      middleware: {
        id: 'middleware', filePath: '/dist/server/middleware.js', pathname: '/middleware',
        type: 8 as any, config: { matchers: [] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).toContain("request.path == '/robots.txt'");
    expect(cel).toMatch(/^\!\(/);
  });

  it('does not exclude public files matched by middleware matchers', () => {
    const outputs = mockOutputs({
      staticFiles: [
        mockStaticFile({ pathname: '/favicon.ico' }),
        mockStaticFile({ pathname: '/api-docs.html' }),
      ],
      middleware: {
        id: 'middleware', filePath: '/dist/server/middleware.js', pathname: '/middleware',
        type: 8 as any, config: { matchers: [{ sourceRegex: '^/api-docs.*$' }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path == '/favicon.ico'");
    expect(cel).not.toContain('api-docs');
  });

  it('generates inclusion list when no middleware', () => {
    const outputs = mockOutputs({
      appPages: [mockAppPage({ pathname: '/about' })],
      appRoutes: [mockAppRoute({ pathname: '/api/hello' })],
      prerenders: [
        mockPrerender({
          pathname: '/blog/hello',
          fallback: { filePath: '/dist/blog.html', initialRevalidateSeconds: 60 } as any,
        }),
      ],
    });
    const cel = generateCelExpression({
      outputs,
      dynamicRoutes: [{ sourceRegex: '^/blog/([^/]+?)(?:/)?$' }] as any,
    });
    expect(cel).toContain("request.path.startsWith('/blog/')");
    expect(cel).toContain("request.path.startsWith('/_next/image')");
    expect(cel).not.toMatch(/^\!\(/);
  });

  it('returns false when nothing needs ext_proc', () => {
    const outputs = mockOutputs({
      staticFiles: [mockStaticFile({ pathname: '/_next/static/chunk.js' })],
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toBe('false');
  });

  it('excludes _next/static even when middleware matches everything', () => {
    const outputs = mockOutputs({
      middleware: {
        id: 'middleware', filePath: '/dist/server/middleware.js', pathname: '/middleware',
        type: 8 as any, config: { matchers: [{ sourceRegex: '^/.*$' }] },
      } as any,
    });
    const cel = generateCelExpression({ outputs, dynamicRoutes: [] });
    expect(cel).toContain("request.path.startsWith('/_next/static/')");
  });
});
