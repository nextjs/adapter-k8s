// tests/emit/dockerfiles.test.ts
import { describe, it, expect } from "vitest";
import {
  generateDockerfile,
  generatePoolDockerfile,
  generateRoutingServiceDockerfile,
  DEFAULT_EMITTED_NODE_VERSION,
  MIN_EMITTED_NODE_MAJOR,
} from "../../src/emit/dockerfiles.js";

// N24 REGRESSION PIN: the routing manifest embeds inline regexp modifiers
// ("(?i:…)", manifest.ts caseInsensitiveSources) that V8 only accepts on Node 24+.
// A node:22 base image throws at manifest load and 500s EVERY request for any app
// with redirects()/headers()/rewrites(). These assertions make a base-image revert
// fail the suite instead of failing in production.
describe("emitted base image is Node >= 24 (inline (?i:) regex support)", () => {
  it("pins the default emitted base image to node:24", () => {
    expect(DEFAULT_EMITTED_NODE_VERSION).toBe("24");
    expect(MIN_EMITTED_NODE_MAJOR).toBe(24);
  });

  it("every emitted Dockerfile defaults to a node:24 base image", () => {
    const dockerfiles = [
      generateDockerfile({ containerStrategy: "shared-image", buildId: "abc123" }),
      generatePoolDockerfile({ poolName: "ssr", buildId: "abc123" }),
      generateRoutingServiceDockerfile({ buildId: "abc123" }),
    ];
    for (const dockerfile of dockerfiles) {
      expect(dockerfile).toMatch(/^FROM node:24-slim$/m);
      expect(dockerfile).not.toContain("node:22");
    }
  });

  it("rejects a base image below Node 24 (cannot compile the manifest's (?i:) wraps)", () => {
    expect(() =>
      generateDockerfile({ containerStrategy: "shared-image", nodeVersion: "22", buildId: "b" }),
    ).toThrow(/Node 24/);
    expect(() => generatePoolDockerfile({ poolName: "ssr", nodeVersion: "23", buildId: "b" })).toThrow(
      /inline regexp modifiers/,
    );
    expect(() => generateRoutingServiceDockerfile({ nodeVersion: "junk", buildId: "b" })).toThrow(
      /Unsupported emitted base image/,
    );
  });
});

describe("generateDockerfile", () => {
  it("generates a valid Dockerfile for shared-image strategy", () => {
    const result = generateDockerfile({
      containerStrategy: "shared-image",
      buildId: "abc123",
    });
    expect(result).toContain("FROM node:24-slim");
    expect(result).toContain("WORKDIR /app");
    expect(result).toContain("COPY --chown=node:node . .");
    expect(result).toContain("NEXT_BUILD_ID=abc123");
    expect(result).toContain('CMD ["node", "pool-server.cjs"]');
  });

  it("runs as the non-root node user with node-owned app files", () => {
    const result = generateDockerfile({
      containerStrategy: "shared-image",
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
      buildId: "abc123",
    });
    expect(result).toContain("FROM node:24-slim");
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
    const result = generateRoutingServiceDockerfile({ buildId: "abc123" });
    expect(result).toContain("FROM node:24-slim");
    expect(result).toContain("routing-service.cjs");
    expect(result).toContain("EXPOSE 8443");
    expect(result).toContain("ENV NEXT_BUILD_ID=abc123");
    expect(result).toContain("COPY --chown=node:node context/ .");
    expect(result).toContain("USER node");
    expect(result).not.toContain("POOL_NAME");
  });

  it("does not bake a TLS cert into the image — the runtime generates one under /tmp/tls", () => {
    const result = generateRoutingServiceDockerfile({ buildId: "abc123" });
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
