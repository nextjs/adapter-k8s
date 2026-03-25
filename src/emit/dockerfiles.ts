// src/emit/dockerfiles.ts

export function generateDockerfile({
  containerStrategy,
  nodeVersion,
}: {
  containerStrategy: "shared-image" | "traced-assets";
  nodeVersion: string;
}): string {
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY .next .next
COPY node_modules node_modules
COPY package.json package.json
COPY .k8s-adapter/pool-server.js .k8s-adapter/pool-server.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", ".k8s-adapter/pool-server.js"]
`;
}

export function generatePoolDockerfile({
  poolName,
  assets,
  entrypoints,
  nodeVersion,
}: {
  poolName: string;
  assets: Record<string, string>;
  entrypoints: string[];
  nodeVersion: string;
}): string {
  // Deduplicate and sort for deterministic output
  const allPaths = [...new Set([...Object.keys(assets), ...entrypoints])].sort();

  const copyLines = allPaths
    .map((relativePath) => `COPY ${relativePath} ${relativePath}`)
    .join("\n");

  return `FROM node:${nodeVersion}-slim
WORKDIR /app
${copyLines}
COPY .k8s-adapter/pool-server.js .k8s-adapter/pool-server.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", ".k8s-adapter/pool-server.js"]
`;
}
