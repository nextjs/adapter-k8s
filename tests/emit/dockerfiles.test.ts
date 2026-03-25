// tests/emit/dockerfiles.test.ts
import { describe, it, expect } from "vitest";
import { generateDockerfile, generatePoolDockerfile } from "../../src/emit/dockerfiles.js";

describe("generateDockerfile", () => {
  it('generates a valid Dockerfile for shared-image strategy', () => {
    const result = generateDockerfile({ containerStrategy: 'shared-image', nodeVersion: '22', buildId: 'abc123' });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('WORKDIR /app');
    expect(result).toContain('COPY .next .next');
    expect(result).toContain('pool-server.cjs');
    expect(result).toContain('routing-manifest.json');
    expect(result).toContain('static-assets.json');
    expect(result).toContain('NEXT_BUILD_ID=abc123');
    expect(result).toContain('CMD ["node", ".k8s-adapter/pool-server.cjs"]');
  });
});

describe('generatePoolDockerfile', () => {
  it('generates a traced-assets Dockerfile with pool-server, manifest, and @next/routing', () => {
    const result = generatePoolDockerfile({
      poolName: 'ssr',
      assets: { 'node_modules/react/index.js': '/abs/node_modules/react/index.js' },
      entrypoints: ['.next/server/app/page.js'],
      nodeVersion: '22',
      buildId: 'abc123',
      middlewarePath: '.next/server/middleware.js',
      staticPaths: ['static/file.js'],
    });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('WORKDIR /app');
    expect(result).toContain('package.json');
    expect(result).toContain('pool-server.cjs');
    expect(result).toContain('pool-manifest-ssr.json');
    expect(result).toContain('routing-manifest.json');
    expect(result).toContain('static-assets.json');
    expect(result).toContain('node_modules/@next/routing');
    expect(result).toContain('COPY .next/server/middleware.js .next/server/middleware.js');
    expect(result).toContain('COPY static/file.js static/file.js');
    expect(result).toContain('POOL_NAME=ssr');
    expect(result).toContain('NEXT_BUILD_ID=abc123');
    expect(result).toContain('CMD ["node", ".k8s-adapter/pool-server.cjs"]');
  });
});
