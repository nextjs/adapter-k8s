// tests/emit/dockerfiles.test.ts
import { describe, it, expect } from "vitest";
import {
  generateDockerfile,
  generatePoolDockerfile,
  generateRoutingServiceDockerfile,
} from "../../src/emit/dockerfiles.js";

describe("generateDockerfile", () => {
  it("generates a valid Dockerfile for shared-image strategy", () => {
    const result = generateDockerfile({
      containerStrategy: "shared-image",
      nodeVersion: "22",
      buildId: "abc123",
    });
    expect(result).toContain("FROM node:22-slim");
    expect(result).toContain("WORKDIR /app");
    expect(result).toContain("COPY . .");
    expect(result).toContain("NEXT_BUILD_ID=abc123");
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });
});

describe("generatePoolDockerfile", () => {
  it("generates a traced-assets Dockerfile with COPY context/ .", () => {
    const result = generatePoolDockerfile({
      poolName: "ssr",
      nodeVersion: "22",
      buildId: "abc123",
    });
    expect(result).toContain("FROM node:22-slim");
    expect(result).toContain("WORKDIR /app");
    expect(result).toContain("COPY context/ .");
    expect(result).toContain("POOL_NAME=ssr");
    expect(result).toContain("NEXT_BUILD_ID=abc123");
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });
});

describe("generateRoutingServiceDockerfile", () => {
  it("generates a Dockerfile for the routing service", () => {
    const result = generateRoutingServiceDockerfile({ nodeVersion: "22", buildId: "abc123" });
    // GCP ext_proc callouts require HTTP/2 over TLS; the image bakes a self-signed cert.
    expect(result).toContain("openssl req -x509");
    expect(result).toContain("TLS_CERT_FILE=/app/tls-cert.pem");
    expect(result).toContain("TLS_KEY_FILE=/app/tls-key.pem");
    expect(result).toContain("FROM node:22-slim");
    expect(result).toContain("routing-service.cjs");
    expect(result).toContain("EXPOSE 8443");
    expect(result).toContain("ENV NEXT_BUILD_ID=abc123");
    expect(result).not.toContain("POOL_NAME");
  });
});
