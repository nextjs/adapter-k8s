// tests/pool-server/dispatch.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createDispatcher } from '../../src/pool-server/dispatch.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ResolveResult } from '../../src/pool-server/resolve.js';

function mockReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return {
    url,
    method: 'GET',
    headers: { host: 'localhost', ...headers },
    pipe: vi.fn(),
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string; _ended: boolean } {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    _ended: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string) { res._headers[key] = value; return res; },
    write(chunk: string) { res._body += chunk; return true; },
    end(body?: string) { if (body) res._body += body; res._ended = true; },
    headersSent: false,
    writableEnded: false,
  };
  return res as unknown as ServerResponse & typeof res;
}

describe('createDispatcher', () => {
  it('dispatches route to handler', async () => {
    const handler = vi.fn();
    const handlerLoader = {
      load: vi.fn().mockResolvedValue(handler),
      has: vi.fn().mockReturnValue(true),
    };

    const dispatcher = createDispatcher({
      handlerLoader,
      poolName: 'ssr',
      buildId: 'test123',
      staticAssets: [],
    });

    const req = mockReq('/about');
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: 'route',
      pool: 'ssr',
      matchedPathname: '/about',
      routeMatches: null,
      resolvedHeaders: undefined,
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);

    expect(handlerLoader.load).toHaveBeenCalledWith('/about');
    expect(handler).toHaveBeenCalledWith(req, res, expect.objectContaining({
      requestMeta: expect.objectContaining({ matchedPathname: '/about' }),
    }));
  });

  it('handles redirects', async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn() } as any,
      poolName: 'ssr',
      buildId: 'test123',
      staticAssets: [],
    });

    const req = mockReq('/old');
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: 'redirect',
      url: new URL('http://localhost/new'),
      status: 301,
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    expect(res._status).toBe(301);
    expect(res._headers['location']).toBe('http://localhost/new');
  });

  it('returns 502 for external rewrites', async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn() } as any,
      poolName: 'ssr',
      buildId: 'test123',
      staticAssets: [],
    });

    const req = mockReq('/proxy');
    const res = mockRes();
    const resolution: ResolveResult = {
      kind: 'external-rewrite',
      url: new URL('https://external.example.com/api'),
    };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    expect(res._status).toBe(502);
    expect(res._body).toContain('External rewrites are not supported');
  });

  it('returns 404 for not-found', async () => {
    const dispatcher = createDispatcher({
      handlerLoader: { load: vi.fn(), has: vi.fn() } as any,
      poolName: 'ssr',
      buildId: 'test123',
      staticAssets: [],
    });

    const req = mockReq('/nonexistent');
    const res = mockRes();
    const resolution: ResolveResult = { kind: 'not-found' };

    await dispatcher.dispatch(req, res as unknown as ServerResponse, resolution);
    expect(res._status).toBe(404);
  });
});
