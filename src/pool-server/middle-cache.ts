import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { StaticAssetEntry } from "../types.js";

export const MIDDLE_CACHE_REQUEST_HEADER = "x-adapter-middle-cache";
export const MIDDLE_CACHE_ASSET_HEADER = "x-adapter-asset";
const handoffs = new WeakMap<ServerResponse, string>();
const requests = new WeakSet<IncomingMessage>();

export function acceptMiddleCacheRequest(req: IncomingMessage): void {
  if (
    process.env.ADAPTER_K8S_MIDDLE_CACHE === "1" &&
    req.headers[MIDDLE_CACHE_REQUEST_HEADER] === "1"
  )
    requests.add(req);
  delete req.headers[MIDDLE_CACHE_REQUEST_HEADER];
  delete req.headers[MIDDLE_CACHE_ASSET_HEADER];
}

/** Only the file-serving branch can authorize a handoff. App headers cannot mint one. */
export function middleCacheHandoff(res: ServerResponse): string | undefined {
  return handoffs.get(res);
}

export function handOffStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  asset: StaticAssetEntry,
  headers: Record<string, string | string[]>,
): boolean {
  if (
    process.env.ADAPTER_K8S_MIDDLE_CACHE !== "1" ||
    !requests.has(req) ||
    (req.method !== "GET" && req.method !== "HEAD") ||
    asset.prerender ||
    (asset.status !== undefined && asset.status !== 200)
  )
    return false;

  // IDs name build-manifest entries, never request paths. The sidecar independently checks
  // its baked manifest and opens files beneath /app with traversal-resistant os.Root.
  handoffs.set(res, createHash("sha256").update(asset.filePath).digest("hex"));
  res.writeHead(200, { ...headers, "content-length": "0" });
  res.end();
  return true;
}
