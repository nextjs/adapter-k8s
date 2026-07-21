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
COPY --chown=node:node . .
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
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
COPY --chown=node:node context/ .
ENV NODE_ENV=production
ENV POOL_NAME=${poolName}
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
EXPOSE 3000
USER node
CMD ["node", "pool-server.cjs"]
`;
}

export function generateRoutingServiceDockerfile({
  nodeVersion,
  buildId,
}: {
  nodeVersion: string;
  buildId: string;
}): string {
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
