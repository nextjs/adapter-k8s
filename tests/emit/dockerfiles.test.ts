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
    expect(result).toContain("COPY --chown=node:node . .");
    expect(result).toContain("NEXT_BUILD_ID=abc123");
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });

  it("runs as the non-root node user with node-owned app files", () => {
    const result = generateDockerfile({
      containerStrategy: "shared-image",
      nodeVersion: "22",
      buildId: "abc123",
    });
    expect(result).toContain("USER node");
    // USER must come after COPY (which chowns to node) and before CMD.
    expect(result.indexOf("USER node")).toBeGreaterThan(result.indexOf("COPY --chown=node:node"));
    expect(result.indexOf("USER node")).toBeLessThan(result.indexOf("CMD"));
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
    expect(result).toContain("COPY --chown=node:node context/ .");
    expect(result).toContain("POOL_NAME=ssr");
    expect(result).toContain("NEXT_BUILD_ID=abc123");
    expect(result).toContain("USER node");
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });
});

describe("generateRoutingServiceDockerfile", () => {
  it("generates a Dockerfile for the routing service", () => {
    const result = generateRoutingServiceDockerfile({ nodeVersion: "22", buildId: "abc123" });
    expect(result).toContain("FROM node:22-slim");
    expect(result).toContain("routing-service.cjs");
    expect(result).toContain("EXPOSE 8443");
    expect(result).toContain("ENV NEXT_BUILD_ID=abc123");
    expect(result).toContain("COPY --chown=node:node context/ .");
    expect(result).toContain("USER node");
    expect(result).not.toContain("POOL_NAME");
  });

  it("does not bake a TLS cert into the image — the runtime generates one under /tmp/tls", () => {
    const result = generateRoutingServiceDockerfile({ nodeVersion: "22", buildId: "abc123" });
    // The per-replica cert is generated at container start (another workstream owns that
    // runtime code); nothing cert-shaped may be baked into an image layer.
    expect(result).not.toContain("openssl req");
    expect(result).not.toContain("tls-cert.pem -out");
    // openssl stays installed for the runtime generation.
    expect(result).toContain("apt-get install -y --no-install-recommends openssl");
    // Cert paths point at the pod's /tmp emptyDir (root FS is read-only).
    expect(result).toContain("TLS_CERT_FILE=/tmp/tls/tls-cert.pem");
    expect(result).toContain("TLS_KEY_FILE=/tmp/tls/tls-key.pem");
  });
});
