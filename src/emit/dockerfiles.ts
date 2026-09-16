// src/emit/dockerfiles.ts
import { DEFAULT_TARGET_PLATFORM, targetNodeCpu, type TargetPlatform } from "../target-platform.js";

// Node 24 is the tested runtime and required image: scoped regexp modifiers preserve Next's
// split custom-route/filesystem-route case policy across @next/routing's single global flag.
export const DEFAULT_EMITTED_NODE_VERSION = "24";

/**
 * S31 (SUPPLY CHAIN). Optional immutable digest for the emitted base image, e.g.
 * `sha256:…`. When set, every emitted `FROM` becomes `node:<version>-slim@<digest>` so a
 * rebuild of the same source cannot silently pick up a different base — a `node:24-slim` tag
 * moves on every upstream patch release, and compromise of that tag is code execution inside
 * every pool and the routing service.
 *
 * NOT defaulted to a pinned value on purpose: a digest baked into this repo would go stale the
 * moment upstream publishes a security patch, and an adapter that pins its users to an
 * unpatched base is worse than one that tracks the tag. This is the seam for a deployer who
 * wants reproducibility (set ADAPTER_K8S_NODE_BASE_DIGEST in CI and update it deliberately);
 * the honest default is to track the tag and rely on `imagePullPolicy` plus rebuilds.
 */
export const NODE_BASE_DIGEST_ENV = "ADAPTER_K8S_NODE_BASE_DIGEST";

function baseImageRef(): string {
  const digest = process.env[NODE_BASE_DIGEST_ENV];
  if (!digest) return `node:${DEFAULT_EMITTED_NODE_VERSION}-slim`;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(
      `Invalid ${NODE_BASE_DIGEST_ENV}: ${JSON.stringify(digest)} — expected sha256:<64 hex>. ` +
        `It is interpolated into the emitted Dockerfile's FROM line.`,
    );
  }
  return `node:${DEFAULT_EMITTED_NODE_VERSION}-slim@${digest}`;
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

// The in-image sharp install, shared by both emitted app Dockerfiles.
// Keep it outside /app: npm would otherwise prune traced packages that are deliberately
// absent from the minimal staged package.json before the container ever starts.
function sharpInstallStep(installSharpVersion: string, targetPlatform: TargetPlatform): string {
  assertSafeSharpVersion(installSharpVersion);
  const cpu = targetNodeCpu(targetPlatform);
  return `# Build host had no ${targetPlatform} sharp binding to stage — install it in-image so
# /_next/image gets the native package matching this single-platform image.
RUN npm install --prefix /tmp/adapter-k8s-sharp --no-save --no-audit --no-fund \\
    --os=linux --cpu=${cpu} --libc=glibc sharp@${installSharpVersion} \\
 && cp -R /tmp/adapter-k8s-sharp/node_modules/. /app/node_modules/ \\
 && rm -rf /tmp/adapter-k8s-sharp \\
 && npm cache clean --force
`;
}

export function generateDockerfile({
  containerStrategy: _containerStrategy,
  targetPlatform = DEFAULT_TARGET_PLATFORM,
  buildId,
  installSharpVersion,
}: {
  containerStrategy: "shared-image" | "traced-assets";
  targetPlatform?: TargetPlatform;
  buildId: string;
  /**
   * See generatePoolDockerfile. N50 (review #30): the shared-image context copies the app's
   * node_modules, which contains the BUILD HOST's @img/* platform packages — on a
   * host platform, which may not match the selected Linux/glibc target,
   * so this strategy needs the same in-image install fallback.
   */
  installSharpVersion?: string;
}): string {
  // `=== undefined` (not falsy): an EMPTY version string must reach the validator, which
  // rejects it, rather than silently skipping the install step.
  const sharpInstall =
    installSharpVersion === undefined ? "" : sharpInstallStep(installSharpVersion, targetPlatform);
  return `FROM ${baseImageRef()}
WORKDIR /app
COPY --chown=node:node . .
${sharpInstall}ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

export function generatePoolDockerfile({
  poolName,
  targetPlatform = DEFAULT_TARGET_PLATFORM,
  buildId,
  installSharpVersion,
}: {
  poolName: string;
  targetPlatform?: TargetPlatform;
  buildId: string;
  /**
   * When the build host could not supply the target platform's native sharp packages
   * (adapter.ts stageSharpRuntimePackages), install sharp inside the image —
   * npm running in the target container resolves the correct platform binding.
   * Pinned to the app's resolved sharp version so the native ABI matches the
   * staged sharp JS package.
   */
  installSharpVersion?: string;
}): string {
  // `=== undefined` (not falsy): an EMPTY version string must reach the validator, which
  // rejects it, rather than silently skipping the install step.
  const sharpInstall =
    installSharpVersion === undefined ? "" : sharpInstallStep(installSharpVersion, targetPlatform);
  // context/ is prepared by the adapter with exactly what's needed.
  return `FROM ${baseImageRef()}
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

/** Parent image for traced-assets builds with more than one pool. */
export function generatePoolBaseDockerfile({
  targetPlatform = DEFAULT_TARGET_PLATFORM,
  buildId,
  installSharpVersion,
}: {
  targetPlatform?: TargetPlatform;
  buildId: string;
  installSharpVersion?: string;
}): string {
  const sharpInstall =
    installSharpVersion === undefined ? "" : sharpInstallStep(installSharpVersion, targetPlatform);
  return `FROM ${baseImageRef()}
WORKDIR /app
COPY --chown=node:node dependencies/ .
${sharpInstall}COPY --chown=node:node content/ .
COPY --chown=node:node fetch-cache/ .
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

/** Thin pool delta layered over the local parent built by the deploy command. */
export function generateLayeredPoolDockerfile({
  poolName,
  buildId,
}: {
  poolName: string;
  buildId: string;
}): string {
  return `ARG POOL_BASE_IMAGE=localhost/adapter-k8s-pool-base-required--update-cli:latest
FROM \${POOL_BASE_IMAGE}
COPY --chown=node:node context/ .
ENV POOL_NAME=${poolName}
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

export function generateRoutingServiceDockerfile({ buildId }: { buildId: string }): string {
  // GCP ext_proc callouts reach the routing service over HTTP/2 *with TLS* (a plaintext
  // gRPC health check still passes, which is why an h2c server looks healthy but the
  // callout silently fails). The cert is NOT baked into the image: the routing service
  // generates a per-replica self-signed cert at container start (GCP does not validate
  // the backend certificate for callouts) and writes it under /tmp/tls, which the pod
  // spec backs with an emptyDir (the root filesystem is read-only). openssl is kept
  // installed for that runtime generation. server.ts serves TLS when TLS_CERT_FILE/
  // TLS_KEY_FILE exist, and plaintext h2c otherwise (local emulate).
  return `FROM ${baseImageRef()}
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \\
 && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node context/ .
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
# S1 (SECURITY). The IMMUTABLE, build-authored copy of this build's routing manifest.
# The pod spec overrides CONFIG_DIR to /config and mounts the mutable
# <release>-routing-manifest ConfigMap there, so the mount SHADOWS the staged copy — and
# the manifest carries the middleware matchers that decide whether the edge stamps the
# trusted \`x-mw-evaluated: skip-nomatch\` verdict (plus the internal secret) that makes the
# pool skip its own middleware. Anyone with configmaps/update could therefore turn the
# secret-holding stamper into an attacker-controlled one. This env names the baked copy at
# a path the mount cannot shadow so index.ts can refuse to serve a manifest that does not
# match the image it shipped with. Rollback reverts the routing IMAGE alongside the
# snapshot ConfigMap, so the pair always matches for a legitimate revert.
ENV BAKED_CONFIG_DIR=/app/config
ENV TLS_CERT_FILE=/tmp/tls/tls-cert.pem
ENV TLS_KEY_FILE=/tmp/tls/tls-key.pem
EXPOSE 8443
USER node
CMD ["node", "routing-service.cjs"]
`;
}
