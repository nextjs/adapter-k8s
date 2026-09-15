import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RoutingManifest } from "../types.js";
import { assertValidRoutingManifest } from "../routing-common.js";
import {
  assertSupportedNextVersion,
  SUPPORTED_NEXT_RELEASE_LINE,
} from "../next-runtime/version.js";
import { createRequestHandler } from "./handler.js";
import { createRoutingServer, startHealthServer } from "./server.js";

// The TLS identity is generated per-replica at container start, NOT baked into the image at
// build time (where every replica would share one key and anyone with registry pull could
// extract it). When TLS_CERT_FILE/TLS_KEY_FILE are configured but absent (the deployment points
// them at an emptyDir such as /tmp/tls), mint a self-signed pair with openssl. Parent dirs are
// created so a read-only /app is tolerated. Any failure — openssl missing, unwritable path —
// CRASHES the process: a plaintext h2c server still passes the TCP/health probes (they don't
// speak TLS), so the pod would stay in the NEG looking healthy while every ext_proc callout
// (which requires HTTP/2 over TLS) silently fails.
//
// Fail-closed is UNCONDITIONAL here:
//  - exactly one of TLS_CERT_FILE/TLS_KEY_FILE set (env/chart skew) → crash. Half a TLS
//    config is a broken deployment, and falling through used to start plaintext h2c with
//    no opt-in at all.
//  - neither set → crash unless ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1. Plaintext is
//    ALWAYS an explicit opt-in, set only by the CLI's local-emulation path (emulate.ts).
/**
 * S1 (SECURITY). Refuse to serve a routing manifest that does not match the one this IMAGE
 * shipped with.
 *
 * The routing service reads its manifest from `CONFIG_DIR`, which the pod spec points at the
 * mutable `<release>-routing-manifest` ConfigMap — while the POOL reads the copy baked into
 * its own image (no configMap volume, no CONFIG_DIR override). That asymmetry was exploitable:
 * the manifest carries the middleware `matchers`, so rewriting them so nothing matches makes
 * `matchesMiddleware` false, the edge stamps the TRUSTED `x-mw-evaluated: skip-nomatch`
 * verdict *together with the internal secret*, and the pool — which trusts `skip-nomatch`
 * (MW_EVALUATED_TRUSTED) — skips its own middleware too. Auth bypass at BOTH tiers from
 * nothing more than `configmaps/update` in the namespace, which is a far weaker grant than
 * the pod-creation power the route-ext Job's own notes already track. The same edit also
 * enables arbitrary rule redirects at the load balancer.
 *
 * The Dockerfile stages this build's manifest at BAKED_CONFIG_DIR (`/app/config`), a path the
 * `/config` mount cannot shadow, so the image itself is the authority. Compared by SHA-256 of
 * the parsed-and-recanonicalized JSON rather than raw bytes: helm's block scalar round-trip
 * normalizes trailing whitespace, and the retention/snapshot copy is re-serialized by kubectl.
 *
 * Fail-closed, and unconditionally so:
 *  - digest mismatch → throw. A mounted manifest that isn't this build's is either tampering
 *    or a rollback that reverted the ConfigMap without reverting the image; neither may serve.
 *  - BAKED_CONFIG_DIR set but the file missing → throw (broken image).
 *  - BAKED_CONFIG_DIR unset → skip. Only local emulate/tests run without it, and an attacker
 *    cannot unset it: it is baked into the image and the root filesystem is read-only.
 */
export function assertManifestMatchesImage(mountedManifestPath: string): void {
  const bakedDir = process.env.BAKED_CONFIG_DIR;
  if (!bakedDir) return; // emulate / tests — no baked copy to compare against
  const bakedPath = path.join(bakedDir, "routing-manifest.json");
  if (path.resolve(bakedPath) === path.resolve(mountedManifestPath)) return; // reading the baked copy itself
  if (!existsSync(bakedPath)) {
    throw new Error(
      `BAKED_CONFIG_DIR is set to ${bakedDir} but ${bakedPath} does not exist. The image must ` +
        `carry the routing manifest it was built with so a mounted manifest can be verified ` +
        `against it; refusing to start rather than trust the mount.`,
    );
  }
  const digest = (file: string): string => {
    // Canonicalize before hashing so YAML/kubectl round-tripping cannot fail a legitimate
    // manifest: only the CONTENT is being compared, not its formatting.
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  };
  let mountedDigest: string;
  let bakedDigest: string;
  try {
    mountedDigest = digest(mountedManifestPath);
    bakedDigest = digest(bakedPath);
  } catch (err) {
    throw new Error(
      `Could not verify the mounted routing manifest against the build's own copy ` +
        `(${bakedPath}): ${err instanceof Error ? err.message : String(err)}. Refusing to ` +
        `start — an unverifiable manifest decides whether middleware runs.`,
    );
  }
  if (mountedDigest !== bakedDigest) {
    throw new Error(
      `Routing manifest mismatch: ${mountedManifestPath} (sha256 ${mountedDigest.slice(0, 16)}…) ` +
        `does not match the manifest this image was built with (${bakedPath}, sha256 ` +
        `${bakedDigest.slice(0, 16)}…). The manifest decides whether this tier stamps the ` +
        `trusted "middleware already evaluated" verdict, so serving an unrecognized one would ` +
        `let the pool skip middleware on routes this build says are covered. If this is a ` +
        `rollback, revert the routing Deployment's IMAGE to the build whose manifest is ` +
        `mounted (\`adapter-k8s rollback\` does both); if it is not, the ConfigMap has been ` +
        `modified out of band.`,
    );
  }
}

/** Transport for the ext_proc listener. */
export type RoutingTransport = "tls" | "h2c";

/**
 * S26. Which transport the ext_proc listener serves.
 *
 * GKE's callout arrives from Google's frontend and REQUIRES HTTP/2 over TLS. An in-cluster
 * Envoy Gateway dials the backend as plain h2c unless a BackendTLSPolicy says otherwise — and
 * the emitted image bakes TLS_CERT_FILE/TLS_KEY_FILE, so the previous logic (honour the
 * plaintext opt-in only when BOTH are unset) could never take effect there. MEASURED: the
 * service self-signed, served h2 TLS, and every callout failed while the :8081 health server
 * stayed green — a deployment that looks healthy and routes nothing.
 *
 * So the transport is stated explicitly rather than inferred. `h2c` is a legitimate PRODUCTION
 * posture here, not a debug escape hatch, but it is only safe because the emitted NetworkPolicy
 * admits :8443 solely from the release's own Envoy proxy pods — a REQUIRED trust boundary, and the
 * reason the two ship together deliberately.
 *
 * The dispatch-proof change (INTERNAL_DISPATCH_PROOF_HEADER, routing-common.ts) narrowed the
 * consequence of reaching this port without removing the requirement: the reply carries a
 * per-request HMAC proof — valid for exactly the request that was resolved, over every routing
 * input the pool acts on — instead of the raw, replayable secret. This service still
 * authenticates NO callers, so anything that can open a stream here can have a request of its own
 * choosing resolved and signed. Reachability is no longer a release-wide credential; it is still
 * a signing oracle plus unmetered middleware compute.
 */
export function routingTransport(): RoutingTransport {
  const declared = process.env.ROUTING_TRANSPORT?.trim();
  if (!declared) return "tls";
  if (declared === "tls" || declared === "h2c") return declared;
  throw new Error(
    `Routing service: ROUTING_TRANSPORT=${JSON.stringify(declared)} is not recognized. ` +
      `Expected "tls" (GKE / any callout arriving over TLS) or "h2c" (in-cluster Envoy Gateway, ` +
      `where the NetworkPolicy restricts :8443 to the release's own proxy pods).`,
  );
}

export function ensureTlsIdentity(): void {
  // Checked FIRST: an explicit h2c transport wins over whatever the image baked in, which is
  // the whole point — the generic Deployment cannot unset an image ENV, only override it.
  if (routingTransport() === "h2c") return;
  const certFile = process.env.TLS_CERT_FILE;
  const keyFile = process.env.TLS_KEY_FILE;
  if (!certFile || !keyFile) {
    if (certFile || keyFile) {
      // Exactly one of the pair is set — env/chart skew. Never fall through to
      // plaintext (and the opt-in does not rescue a half-configured TLS identity).
      throw new Error(
        `Routing service: TLS misconfiguration — exactly one of TLS_CERT_FILE/TLS_KEY_FILE ` +
          `is set (TLS_CERT_FILE=${certFile ? JSON.stringify(certFile) : "unset"}, ` +
          `TLS_KEY_FILE=${keyFile ? JSON.stringify(keyFile) : "unset"}). Set both (GKE) or ` +
          `neither with ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 (local emulation only).`,
      );
    }
    if (process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT === "1") return;
    throw new Error(
      `Routing service: TLS_CERT_FILE/TLS_KEY_FILE are not configured. GCP ext_proc callouts ` +
        `require HTTP/2 over TLS — refusing to start plaintext (the pod would look healthy ` +
        `while every callout fails). Set both TLS_CERT_FILE and TLS_KEY_FILE, or set ` +
        `ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 to opt in to plaintext (local emulation only).`,
    );
  }
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
    const detail = err instanceof Error ? err.message : String(err);
    if (process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT === "1") {
      console.warn(
        `Routing service: could not generate TLS identity (${detail}); ` +
          `ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 is set — starting plaintext h2c anyway.`,
      );
      return;
    }
    throw new Error(
      `Routing service: could not generate TLS identity (${detail}). GCP ext_proc callouts ` +
        `require HTTP/2 over TLS — refusing to start plaintext (the pod would look healthy ` +
        `while every callout fails). Set ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 to override ` +
        `(local emulation only).`,
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
  // N40. Parse errors used to surface as a bare SyntaxError with no context, and a
  // STRUCTURALLY wrong (but parseable) manifest — or one carrying a route `sourceRegex` this
  // runtime's V8 rejects — was accepted here and only failed later, inside resolveRoutes, on
  // every request. With middleware present `failOpen` is false, so that is a 500 on everything
  // while `/healthz` keeps answering 200 and nothing evicts the pod. Validate at boot, in front
  // of the readiness gate, exactly as the TLS identity and the middleware module already are.
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err) {
    throw new Error(
      `Routing manifest at ${manifestPath} is not valid JSON: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  assertValidRoutingManifest(parsedManifest, manifestPath);
  assertManifestMatchesImage(manifestPath);
  const manifest: RoutingManifest = parsedManifest as RoutingManifest;
  const nextSupport = assertSupportedNextVersion(
    manifest.nextVersion,
    `Routing manifest at ${manifestPath}`,
  );
  if (nextSupport.prerelease) {
    console.warn(
      `[routing-service] Next.js ${manifest.nextVersion} is accepted for the pinned upstream ` +
        `conformance lane; stable releases support ${SUPPORTED_NEXT_RELEASE_LINE}.`,
    );
  }

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
  const listenHost = process.env.ADAPTER_K8S_LISTEN_HOST;

  // Create handler and server. Mint the TLS identity first so createRoutingServer sees the
  // cert files (or their deliberate absence, after a generation failure) when it picks its
  // transport.
  const handler = createRequestHandler(manifest, middlewareModule, { timeoutMs });
  ensureTlsIdentity();
  const server = createRoutingServer({ handler, port, host: listenHost, failOpen, timeoutMs });

  await server.start();

  // Real health endpoint (httpGet probe) — evicts a wedged/broken pod that a TCP
  // probe would leave in the NEG. Ready only once the ext_proc server is listening.
  let ready = true;
  const healthPort = parseInt(process.env.HEALTH_PORT ?? "8081", 10);
  const health = startHealthServer(healthPort, () => ready, listenHost);

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

// Run main() only when executed directly (node dist/routing-service.cjs) — the
// bundle is CJS, where require.main === module identifies the entry. Under ESM
// (vitest imports of the helpers above) require is undefined and the guard is
// false, so importing this module never starts a server.
if (typeof require !== "undefined" && require.main === module) {
  main().catch((err) => {
    console.error("Routing service failed to start:", err);
    process.exit(1);
  });
}
