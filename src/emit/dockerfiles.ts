// src/emit/dockerfiles.ts

// N24: the emitted routing manifest wraps rewrite/redirect/header/fallback sources in
// inline regexp modifiers — `(?i:…)` (manifest.ts caseInsensitiveSources) — so custom
// routes match case-insensitively the way `next start` does. V8 only accepts inline
// modifiers from 12.7 (Node 23+): on a node:22 base, `new RegExp("(?i:/foo)")` throws
// at manifest load and the container 500s EVERY request for any app with redirects()/
// headers()/rewrites(). This is a known incident class here (Node 22 routing container
// vs Node 24-built `@next/routing` `(?i:)` regexes — all unmatched paths 500ed).
// mise.toml pins the build toolchain to Node 24; the runtime base MUST stay in V8
// parity. Do NOT downgrade below 24 — assertSupportedNodeVersion makes that fail the
// build (and the dockerfiles test suite) loudly instead of 500ing in production.
export const MIN_EMITTED_NODE_MAJOR = 24;
export const DEFAULT_EMITTED_NODE_VERSION = "24";

function assertSupportedNodeVersion(nodeVersion: string): void {
  const major = Number.parseInt(nodeVersion, 10);
  if (!Number.isInteger(major) || major < MIN_EMITTED_NODE_MAJOR) {
    throw new Error(
      `Unsupported emitted base image node:${nodeVersion}-slim: the routing manifest ` +
        `embeds inline regexp modifiers ("(?i:…)") that V8 only accepts on Node ` +
        `${MIN_EMITTED_NODE_MAJOR}+ — a node:${nodeVersion} container would throw at ` +
        `manifest load and 500 every request. Use Node ${MIN_EMITTED_NODE_MAJOR} or newer.`,
    );
  }
}

export function generateDockerfile({
  containerStrategy,
  nodeVersion = DEFAULT_EMITTED_NODE_VERSION,
  buildId,
}: {
  containerStrategy: "shared-image" | "traced-assets";
  nodeVersion?: string;
  buildId: string;
}): string {
  assertSupportedNodeVersion(nodeVersion);
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

// installSharpVersion lands inside a Dockerfile RUN instruction — validate at the
// point of consumption (repo convention): npm version strings only, so a tampered
// sharp package.json can't inject shell into the emitted Dockerfile.
function assertSafeSharpVersion(version: string): void {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(
      `Unsafe sharp version for the emitted Dockerfile: ${JSON.stringify(version)} — ` +
        `expected an npm version string ([0-9A-Za-z.+-] only).`,
    );
  }
}

export function generatePoolDockerfile({
  poolName,
  nodeVersion = DEFAULT_EMITTED_NODE_VERSION,
  buildId,
  installSharpVersion,
}: {
  poolName: string;
  nodeVersion?: string;
  buildId: string;
  /**
   * When the build host could not supply sharp's linux-x64 native packages
   * (adapter.ts stageSharpRuntimePackages), install sharp inside the image —
   * npm running in the target container resolves the correct platform binding.
   * Pinned to the app's resolved sharp version so the native ABI matches the
   * sharp JS inlined into pool-server.cjs.
   */
  installSharpVersion?: string;
}): string {
  assertSupportedNodeVersion(nodeVersion);
  if (installSharpVersion !== undefined) assertSafeSharpVersion(installSharpVersion);
  const sharpInstall = installSharpVersion
    ? `# Build host had no linux-x64 sharp binding to stage — install it in-image so
# /_next/image works (pool-server.cjs requires @img/sharp-linux-x64 at runtime).
RUN npm install --no-save --no-audit --no-fund sharp@${installSharpVersion} \\
 && npm cache clean --force
`
    : "";
  // context/ is prepared by the adapter with exactly what's needed.
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY --chown=node:node context/ .
${sharpInstall}ENV NODE_ENV=production
ENV POOL_NAME=${poolName}
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

export function generateRoutingServiceDockerfile({
  nodeVersion = DEFAULT_EMITTED_NODE_VERSION,
  buildId,
}: {
  nodeVersion?: string;
  buildId: string;
}): string {
  assertSupportedNodeVersion(nodeVersion);
  // GCP ext_proc callouts reach the routing service over HTTP/2 *with TLS* (a plaintext
  // gRPC health check still passes, which is why an h2c server looks healthy but the
  // callout silently fails). The cert is NOT baked into the image: the routing service
  // generates a per-replica self-signed cert at container start (GCP does not validate
  // the backend certificate for callouts) and writes it under /tmp/tls, which the pod
  // spec backs with an emptyDir (the root filesystem is read-only). openssl is kept
  // installed for that runtime generation. server.ts serves TLS when TLS_CERT_FILE/
  // TLS_KEY_FILE exist, and plaintext h2c otherwise (local emulate).
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY --chown=node:node context/ .
RUN apt-get update && apt-get install -y --no-install-recommends openssl \\
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
ENV TLS_CERT_FILE=/tmp/tls/tls-cert.pem
ENV TLS_KEY_FILE=/tmp/tls/tls-key.pem
EXPOSE 8443
USER node
CMD ["node", "routing-service.cjs"]
`;
}
