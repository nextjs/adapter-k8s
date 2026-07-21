// src/emit/dockerignore.ts

// Emitted into every Docker build context so that `.env` files — which may hold
// secrets (DB URLs, non-NEXT_PUBLIC API keys) — are never baked into image
// layers, even though the Dockerfiles do an unconditional `COPY . .` /
// `COPY context/ .`. Env is instead supplied to the running container via
// Kubernetes (ConfigMap/Secret + envFrom); the pool-server and routing-service
// call @next/env loadEnvConfig at startup, which simply finds no file and falls
// back to process.env. `**/` covers both context layouts (root-level `.env` in
// shared-context, `context/.env` in the pool and routing-service contexts).
// `.env.example` is NOT re-included: example files can drift into real-looking
// credentials over time, and nothing at runtime needs them inside the image.
export function generateDockerignore(): string {
  return `# Keep .env secrets out of image layers — env is injected via Kubernetes at runtime.
**/.env
**/.env.*
`;
}
