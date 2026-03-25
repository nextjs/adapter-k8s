// tests/emit/dockerfiles.test.ts
import { describe, it, expect } from "vitest";
import { generateDockerfile, generatePoolDockerfile } from "../../src/emit/dockerfiles.js";

describe("generateDockerfile", () => {
  it('generates a valid Dockerfile for shared-image strategy', () => {
    const result = generateDockerfile({ containerStrategy: 'shared-image', nodeVersion: '22', buildId: 'abc123' });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('WORKDIR /app');
    expect(result).toContain('COPY . .');
    expect(result).toContain('NEXT_BUILD_ID=abc123');
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });
});

describe('generatePoolDockerfile', () => {
  it('generates a traced-assets Dockerfile with COPY context/ .', () => {
    const result = generatePoolDockerfile({
      poolName: 'ssr',
      nodeVersion: '22',
      buildId: 'abc123',
    });
    expect(result).toContain('FROM node:22-slim');
    expect(result).toContain('WORKDIR /app');
    expect(result).toContain('COPY context/ .');
    expect(result).toContain('POOL_NAME=ssr');
    expect(result).toContain('NEXT_BUILD_ID=abc123');
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });
});
