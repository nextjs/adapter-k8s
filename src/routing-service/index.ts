import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RoutingManifest } from "../types.js";
import { createRequestHandler } from "./handler.js";
import { createRoutingServer, startHealthServer } from "./server.js";

async function main() {
  // Load .env files
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  } catch {}

  const buildId = process.env.NEXT_BUILD_ID;
  if (!buildId) throw new Error("NEXT_BUILD_ID environment variable is required");

  const port = parseInt(process.env.PORT ?? "8443", 10);
  const configDir = process.env.CONFIG_DIR ?? "/config";
  // Fail-open by default (preserves historical behavior). Set ROUTING_FAIL_OPEN=false
  // to fail closed (respond 500) when the routing handler throws.
  const failOpen = process.env.ROUTING_FAIL_OPEN !== "false";

  // Load routing manifest
  const manifestPath = path.join(configDir, "routing-manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Routing manifest not found: ${manifestPath}`);
  }
  const manifest: RoutingManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  // Load middleware module (if present)
  let middlewareModule = null;
  if (manifest.middleware) {
    const mwPath = path.resolve(process.cwd(), manifest.middleware.filePath);
    if (existsSync(mwPath)) {
      middlewareModule = await import(pathToFileURL(mwPath).href);
      console.log("Middleware module loaded");
    } else {
      console.warn(`Middleware file not found: ${mwPath}`);
    }
  }

  // Per-request budget: shed slow requests before the ext_proc deadline (default 4s,
  // under GCP's 5s callout timeout). Set 0 to disable.
  const timeoutMs = parseInt(process.env.ROUTING_REQUEST_TIMEOUT_MS ?? "4000", 10);

  // Create handler and server
  const handler = createRequestHandler(manifest, middlewareModule);
  const server = createRoutingServer({ handler, port, failOpen, timeoutMs });

  await server.start();

  // Real health endpoint (httpGet probe) — evicts a wedged/broken pod that a TCP
  // probe would leave in the NEG. Ready only once the ext_proc server is listening.
  let ready = true;
  const healthPort = parseInt(process.env.HEALTH_PORT ?? "8081", 10);
  const health = startHealthServer(healthPort, () => ready);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down routing service...");
    ready = false;
    await health.close().catch(() => {});
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Routing service failed to start:", err);
  process.exit(1);
});
