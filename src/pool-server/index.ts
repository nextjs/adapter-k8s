// src/pool-server/index.ts
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PoolManifest, RoutingManifest } from "../types.js";
import { createHandlerLoader } from "./handler-loader.js";
import { createLocalResolver } from "./resolve.js";
import { createDispatcher } from "./dispatch.js";
import { createPoolServer } from "./server.js";

// Initialize Next.js Node runtime shims (AsyncLocalStorage, hooks, crypto polyfills).
// This MUST run before any Next.js handler modules are imported.
// Follows the AWS adapter's ensureNextNodeEnvironment pattern.
async function ensureNextNodeEnvironment(): Promise<void> {
  const req = createRequire(path.join(process.cwd(), "package.json"));
  const candidates = [
    "next/setup-node-env",
    "next/dist/build/adapter/setup-node-env.external",
    "next/dist/server/node-environment",
  ];

  for (const candidate of candidates) {
    try {
      req(candidate);
      return;
    } catch {
      // Try the next candidate.
    }
  }

  console.warn(
    "[pool-server] Could not load Next.js node environment shims from app dependencies — AsyncLocalStorage may not work"
  );
}

async function main() {
  // Load .env files (Next.js does this in next start, but we're standalone)
  try {
    const { loadEnvConfig } = require("@next/env");
    loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
  } catch {
    // @next/env may not be available — .env files won't be loaded automatically
  }

  // Initialize Next.js runtime BEFORE anything else
  await ensureNextNodeEnvironment();
  const poolName = process.env.POOL_NAME;
  if (!poolName) throw new Error("POOL_NAME environment variable is required");

  const buildId = process.env.NEXT_BUILD_ID;
  if (!buildId)
    throw new Error("NEXT_BUILD_ID environment variable is required");

  const port = parseInt(process.env.PORT ?? "3000", 10);
  const releaseName = process.env.RELEASE_NAME ?? "nextjs";
  const configDir = process.env.CONFIG_DIR ?? "/config";

  // Load pool manifest (mounted as ConfigMap or baked into container)
  const poolManifestPath = path.join(
    configDir,
    `pool-manifest-${poolName}.json`,
  );
  if (!existsSync(poolManifestPath)) {
    throw new Error(`Pool manifest not found: ${poolManifestPath}`);
  }
  const poolManifest: PoolManifest = JSON.parse(
    readFileSync(poolManifestPath, "utf-8"),
  );

  // Load routing manifest (for local route resolution in Phase 1)
  const routingManifestPath = path.join(configDir, "routing-manifest.json");
  if (!existsSync(routingManifestPath)) {
    throw new Error(`Routing manifest not found: ${routingManifestPath}`);
  }
  const routingManifest: RoutingManifest = JSON.parse(
    readFileSync(routingManifestPath, "utf-8"),
  );

  // Load static assets manifest
  const staticAssetsPath = path.join(configDir, "static-assets.json");
  const staticAssets = existsSync(staticAssetsPath)
    ? JSON.parse(readFileSync(staticAssetsPath, "utf-8"))
    : [];

  // Optionally load middleware module
  let middlewareModule = null;
  if (routingManifest.middleware) {
    const mwPath = path.resolve(process.cwd(), routingManifest.middleware.filePath);
    if (existsSync(mwPath)) {
      middlewareModule = await import(pathToFileURL(mwPath).href);
      console.log("Middleware module loaded");
    } else {
      console.warn(`Middleware file not found: ${mwPath}`);
    }
  }

  // Create components
  const handlerLoader = createHandlerLoader(poolManifest);
  const resolver = createLocalResolver(routingManifest, middlewareModule);
  const dispatcher = createDispatcher({
    handlerLoader,
    poolName,
    buildId,
    staticAssets,
    releaseName,
  });

  // Create and start server
  const server = createPoolServer({
    port,
    onRequest: async (req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host ?? "localhost"}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value))
          value.forEach((v) => headers.append(key, v));
      }

      // Phase 2+: if dispatch headers exist (from route extension), use them directly
      const extOutputId = req.headers["x-output-id"] as string | undefined;
      if (extOutputId) {
        const matchedPathname =
          (req.headers["x-matched-pathname"] as string) ?? url.pathname;
        const routeMatchesRaw = req.headers["x-route-matches"] as string | undefined;
        const routeMatches = routeMatchesRaw ? JSON.parse(routeMatchesRaw) : null;
        const pool = (req.headers["x-upstream-pool"] as string) ?? poolName;

        await dispatcher.dispatch(req, res, {
          kind: "route",
          pool,
          matchedPathname: extOutputId, // Use outputId/pathname from header
          routeMatches,
          resolvedHeaders: undefined,
        });
        return;
      }

      // Phase 1: resolve route locally
      const requestBody = new ReadableStream({
        start(controller) {
          req.on("data", (chunk) => controller.enqueue(chunk));
          req.on("end", () => controller.close());
          req.on("error", (err) => controller.error(err));
        },
      });

      const resolution = await resolver.resolve(
        url,
        headers,
        req.method ?? "GET",
        requestBody,
      );
      await dispatcher.dispatch(req, res, resolution);
    },
  });

  await server.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Shutting down pool server...");
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Pool server failed to start:", err);
  process.exit(1);
});
