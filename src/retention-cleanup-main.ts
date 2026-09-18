import { readFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import {
  cleanupExpiredRetention,
  type ClusterObject,
  type CleanupApi,
} from "./retention-expiry.js";

/** Small in-cluster client: verified TLS, bounded responses, and no token on argv/logs. */
export function inClusterCleanupApi(env: NodeJS.ProcessEnv = process.env): CleanupApi {
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = Number(env.KUBERNETES_SERVICE_PORT_HTTPS ?? "443");
  if (!host || !isIP(host) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid Kubernetes API endpoint");
  const directory = "/var/run/secrets/kubernetes.io/serviceaccount";
  const ca = readFileSync(`${directory}/ca.crt`);
  async function call(path: string, operations?: unknown[]): Promise<ClusterObject> {
    const token = readFileSync(`${directory}/token`, "utf8").trim();
    const body = operations ? JSON.stringify(operations) : undefined;
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: host,
          port,
          ca,
          path,
          method: body ? "PATCH" : "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(body
              ? {
                  "content-type": "application/json-patch+json",
                  "content-length": Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 8 * 1024 * 1024) {
              req.destroy(new Error("Kubernetes response too large"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(
                Object.assign(new Error(`Kubernetes API returned ${response.statusCode}`), {
                  status: response.statusCode,
                }),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new Error("Invalid Kubernetes response"));
            }
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("Kubernetes API deadline exceeded")),
        10_000,
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(body);
    });
  }
  return {
    get: (path) => call(path),
    patch: async (path, operations) => {
      await call(path, operations);
    },
  };
}

if (!process.env.VITEST) {
  cleanupExpiredRetention(
    inClusterCleanupApi(),
    process.env.RELEASE_NAME ?? "",
    process.env.NAMESPACE ?? "",
  ).catch((error) => {
    console.error(
      `Retention cleanup failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
