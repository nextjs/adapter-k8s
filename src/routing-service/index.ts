import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RoutingManifest } from "../types.js";
import { createRequestHandler } from "./handler.js";
import { createRoutingServer, startHealthServer } from "./server.js";

// The TLS identity is generated per-replica at container start, NOT baked into the image at
// build time (where every replica would share one key and anyone with registry pull could
// extract it). When TLS_CERT_FILE/TLS_KEY_FILE are configured but absent (the deployment points
// them at an emptyDir such as /tmp/tls), mint a self-signed pair with openssl. Parent dirs are
// created so a read-only /app is tolerated. Any failure — openssl missing, unwritable path —
// falls back to the existing plaintext h2c behavior (emulate parity) instead of crashing.
function ensureTlsIdentity(): void {
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (!certFile || !keyFile) return;
  if (existsSync(certFile) && existsSync(keyFile)) return;
  const release = process.env.RELEASE_NAME ?? "nextjs";
  const namespace = process.env.NAMESPACE ?? "default";
  const serviceName = `${release}-routing-service`;
  try {
    mkdirSync(path.dirname(certFile), { recursive: true });
    mkdirSync(path.dirname(keyFile), { recursive: true });
    // execFileSync with an argv array — never a shell string — so the release/namespace
    // values can never become command injection.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "3650",
        "-subj",
        `/CN=${serviceName}`,
        "-addext",
        `subjectAltName=DNS:${serviceName}.${namespace}.svc.cluster.local`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    console.log(`Routing service: generated self-signed TLS identity at ${certFile}`);
  } catch (err) {
    console.warn(
      `Routing service: could not generate TLS identity (${err instanceof Error ? err.message : String(err)}); falling back to plaintext h2c`,
    );
  }
}

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

  // Load middleware module (if present). This MUST mirror the pool's top-level-await
  // unwrap (pool-server resolveMiddlewareModule): Next compiles TLA middleware as
  // module.exports = Promise<realExports>, so a plain import() surfaces that Promise as
  // `default`. Without awaiting it, the handler's middleware detection finds no callable
  // function and SILENTLY no-ops — and because the routing service then emits trusted
  // dispatch headers, the pool skips middleware too, bypassing auth on GET/HEAD. And a
  // configured-but-missing middleware must fail closed, not warn-and-continue, for the
  // same reason: running ext_proc without the middleware it exists to enforce is a bypass.
  let middlewareModule = null;
  if (manifest.middleware) {
    const mwPath = path.resolve(process.cwd(), manifest.middleware.filePath);
    if (!existsSync(mwPath)) {
      throw new Error(
        `Configured middleware not found at ${mwPath}. Refusing to start the routing ` +
          `service: serving ext_proc without the middleware it must enforce would ` +
          `silently bypass it (and the pool trusts that ext_proc already ran).`,
      );
    }
    const mod = await import(pathToFileURL(mwPath).href);
    middlewareModule =
      mod?.default && typeof (mod.default as { then?: unknown }).then === "function"
        ? await (mod.default as Promise<Record<string, unknown>>)
        : mod;
    console.log("Middleware module loaded");
  }

  // Per-request budget: shed slow requests before the ext_proc deadline (default 4s,
  // under GCP's 5s callout timeout). Set 0 to disable.
  const timeoutMs = parseInt(process.env.ROUTING_REQUEST_TIMEOUT_MS ?? "4000", 10);

  // Create handler and server. Mint the TLS identity first so createRoutingServer sees the
  // cert files (or their deliberate absence, after a generation failure) when it picks its
  // transport.
  const handler = createRequestHandler(manifest, middlewareModule);
  ensureTlsIdentity();
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
