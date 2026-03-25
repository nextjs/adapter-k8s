// src/emit/dockerfiles.ts

export function generateDockerfile({
  containerStrategy,
  nodeVersion,
  buildId,
}: {
  containerStrategy: "shared-image" | "traced-assets";
  nodeVersion: string;
  buildId: string;
}): string {
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY .next .next
COPY node_modules node_modules
COPY package.json package.json
COPY .k8s-adapter/output/pool-server.cjs .k8s-adapter/pool-server.cjs
COPY .k8s-adapter/output/pool-manifest-*.json /config/
COPY .k8s-adapter/output/routing-manifest.json /config/routing-manifest.json
COPY .k8s-adapter/output/static-assets.json /config/static-assets.json
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
# POOL_NAME is set per-Deployment in the Helm chart, not baked into the image
EXPOSE 3000
CMD ["node", ".k8s-adapter/pool-server.cjs"]
`;
}

export function generatePoolDockerfile({
  poolName,
  assets,
  entrypoints,
  nodeVersion,
  buildId,
  middlewarePath,
  staticPaths = [],
}: {
  poolName: string;
  assets: Record<string, string>;
  entrypoints: string[];
  nodeVersion: string;
  buildId: string;
  middlewarePath?: string | null;
  staticPaths?: string[];
}): string {
  // Deduplicate and sort for deterministic output
  const allPaths = [
    ...new Set([...Object.keys(assets), ...entrypoints, ...staticPaths]),
  ].sort();

  const copyLines = allPaths
    .map((relativePath) => `COPY ${relativePath} ${relativePath}`)
    .join("\n");

  const middlewareCopy = middlewarePath
    ? `COPY ${middlewarePath} ${middlewarePath}\n`
    : "";

  return `FROM node:${nodeVersion}-slim
WORKDIR /app
${copyLines}
${middlewareCopy}COPY package.json package.json
# @next/routing is a pool-server dependency, not traced from handler modules
COPY node_modules/@next/routing node_modules/@next/routing
COPY .k8s-adapter/output/pool-server.cjs .k8s-adapter/pool-server.cjs
COPY .k8s-adapter/output/pool-manifest-${poolName}.json /config/pool-manifest-${poolName}.json
COPY .k8s-adapter/output/routing-manifest.json /config/routing-manifest.json
COPY .k8s-adapter/output/static-assets.json /config/static-assets.json
ENV NODE_ENV=production
ENV POOL_NAME=${poolName}
ENV NEXT_BUILD_ID=${buildId}
EXPOSE 3000
CMD ["node", ".k8s-adapter/pool-server.cjs"]
`;
}
