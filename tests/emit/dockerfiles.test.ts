// tests/emit/dockerfiles.test.ts
import { describe, it, expect } from "vitest";
import { generateDockerfile, generatePoolDockerfile } from "../../src/emit/dockerfiles.js";

describe("generateDockerfile", () => {
  it('generates a valid Dockerfile for shared-image strategy', () => {
    const result = generateDockerfile({ containerStrategy: 'shared-image', nodeVersion: '22' });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('COPY .next .next');
    expect(result).toContain('COPY .k8s-adapter/pool-server.js .k8s-adapter/pool-server.js');
    expect(result).toContain('EXPOSE 3000');
  });
  });

  describe('generatePoolDockerfile', () => {
  it('generates a traced-assets Dockerfile copying only needed files', () => {
    const assets: Record<string, string> = {
      'node_modules/react/index.js': '/abs/node_modules/react/index.js',
      '.next/server/app/page.js': '/abs/.next/server/app/page.js',
    };
    const result = generatePoolDockerfile({
      poolName: 'ssr',
      assets,
      entrypoints: ['.next/server/app/page.js'],
      nodeVersion: '22',
    });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('COPY .next/server/app/page.js');
    expect(result).toContain('COPY node_modules/react/index.js');
    expect(result).toContain('COPY .k8s-adapter/pool-server.js .k8s-adapter/pool-server.js');
    expect(result).toContain('EXPOSE 3000');
  });
  });
