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
COPY . .
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
CMD ["node", "pool-server.cjs"]
`;
}

export function generatePoolDockerfile({
  poolName,
  nodeVersion,
  buildId,
}: {
  poolName: string;
  nodeVersion: string;
  buildId: string;
}): string {
  // context/ is prepared by the adapter with exactly what's needed.
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY context/ .
ENV NODE_ENV=production
ENV POOL_NAME=${poolName}
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
CMD ["node", "pool-server.cjs"]
`;
}
