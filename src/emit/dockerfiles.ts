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

export function generateRoutingServiceDockerfile({
  nodeVersion,
  buildId,
}: {
  nodeVersion: string;
  buildId: string;
}): string {
  // GCP ext_proc callouts reach the routing service over HTTP/2 *with TLS* (a plaintext
  // gRPC health check still passes, which is why an h2c server looks healthy but the
  // callout silently fails). Generate a self-signed cert at build — GCP does not validate
  // the backend certificate for callouts. server.ts serves TLS when TLS_CERT_FILE/
  // TLS_KEY_FILE exist, and plaintext h2c otherwise (local emulate).
  return `FROM node:${nodeVersion}-slim
WORKDIR /app
COPY context/ .
RUN apt-get update && apt-get install -y --no-install-recommends openssl \\
 && openssl req -x509 -newkey rsa:2048 -nodes -keyout /app/tls-key.pem -out /app/tls-cert.pem \\
      -days 3650 -subj "/CN=routing-service" \\
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV NEXT_BUILD_ID=${buildId}
ENV CONFIG_DIR=/app/config
ENV TLS_CERT_FILE=/app/tls-cert.pem
ENV TLS_KEY_FILE=/app/tls-key.pem
EXPOSE 8443
CMD ["node", "routing-service.cjs"]
`;
}
