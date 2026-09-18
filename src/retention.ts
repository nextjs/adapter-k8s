import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RETENTION_MAX_BYTES = 800_000;
export interface BuildInventory {
  buildId: string;
  deploymentId: string;
  defaultPool: string;
  pools: string[];
  gracePeriodSeconds: number;
  responseHeadTimeoutMs?: number;
  assets: string[];
  actions: string[];
}
export interface RetainedBuild extends BuildInventory {
  origin: string;
  expiresAt: number;
}

export function validateInventory(value: unknown): asserts value is BuildInventory {
  const v = value as BuildInventory;
  if (
    !v ||
    typeof v.buildId !== "string" ||
    !/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,62}$/.test(v.buildId) ||
    typeof v.deploymentId !== "string" ||
    v.deploymentId.length > 256 ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v.defaultPool) ||
    !Array.isArray(v.pools) ||
    !v.pools.includes(v.defaultPool) ||
    !v.pools.every(
      (p) => typeof p === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p),
    ) ||
    !Number.isInteger(v.gracePeriodSeconds) ||
    v.gracePeriodSeconds < 1 ||
    v.gracePeriodSeconds > 3600 ||
    (v.responseHeadTimeoutMs !== undefined &&
      (!Number.isSafeInteger(v.responseHeadTimeoutMs) ||
        v.responseHeadTimeoutMs < 1 ||
        v.responseHeadTimeoutMs > 86_400_000)) ||
    !Array.isArray(v.assets) ||
    !v.assets.every(
      (p) =>
        typeof p === "string" &&
        p.length < 2048 &&
        /^(?:\/[^?#]*)?\/_next\/static\/immutable\/[^?#]+$/.test(p),
    ) ||
    !Array.isArray(v.actions) ||
    !v.actions.every((p) => typeof p === "string" && /^[a-f0-9]{40,64}$/.test(p))
  ) {
    throw new Error("Invalid retained build inventory");
  }
}

export function inventorySignature(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update("retention-inventory:v1\0")
    .update(payload)
    .digest("hex");
}

/** ConfigMap write access must not grant authority to forward cookies or skip middleware. */
export function signRetention(builds: RetainedBuild[], secret: string) {
  const payload = JSON.stringify(builds);
  return {
    payload,
    signature: createHmac("sha256", secret).update("retention:v1\0").update(payload).digest("hex"),
  };
}

export function createRetentionReader(options: {
  file?: string;
  buildId: string;
  secret?: string;
}) {
  let cached: RetainedBuild[] = [];
  let refreshAt = 0;
  let refreshing: Promise<void> | undefined;
  return async (
    url: URL,
    method: string,
    deploymentId?: string,
    action?: string,
  ): Promise<RetainedBuild | undefined> => {
    const { file, secret } = options;
    if (!file || !secret) return;
    const now = Date.now();
    if (now >= refreshAt && !refreshing) {
      refreshing = (async () => {
        let next: RetainedBuild[] = [];
        try {
          const raw = await readFile(file, "utf8");
          if (Buffer.byteLength(raw) > RETENTION_MAX_BYTES) return;
          const record = JSON.parse(raw)[options.buildId];
          if (typeof record?.payload !== "string" || !/^[a-f0-9]{64}$/.test(record.signature))
            return;
          const expected = createHmac("sha256", secret)
            .update("retention:v1\0")
            .update(record.payload)
            .digest();
          if (!timingSafeEqual(expected, Buffer.from(record.signature, "hex"))) return;
          const builds = JSON.parse(record.payload) as RetainedBuild[];
          if (!Array.isArray(builds) || builds.length !== 2) return;
          for (const build of builds) {
            validateInventory(build);
            const origin = new URL(build.origin);
            if (
              origin.protocol !== "http:" ||
              origin.username ||
              origin.password ||
              origin.pathname !== "/" ||
              origin.search ||
              origin.hash ||
              !Number.isSafeInteger(build.expiresAt)
            )
              return;
          }
          if (
            builds.filter((b) => b.buildId === options.buildId).length !== 1 ||
            builds[0]!.buildId === builds[1]!.buildId
          )
            return;
          next = builds;
        } catch {
          /* Missing or unverifiable state falls back to this build's full routing. */
        } finally {
          cached = next;
          refreshAt = Date.now() + 250;
        }
      })().finally(() => {
        refreshing = undefined;
      });
    }
    await refreshing;
    const own = cached.find((b) => b.buildId === options.buildId);
    const peer = cached.find((b) => b.buildId !== options.buildId && b.expiresAt > Date.now());
    if (!own || !peer) return;
    const hint = deploymentId || url.searchParams.get("dpl");
    if (hint === own.deploymentId) return;
    if (hint === peer.deploymentId && method === "POST" && action && peer.actions.includes(action))
      return peer;
    if (
      (method === "GET" || method === "HEAD") &&
      !own.assets.includes(url.pathname) &&
      peer.assets.includes(url.pathname)
    )
      return peer;
    if (
      method === "POST" &&
      action &&
      !own.actions.includes(action) &&
      peer.actions.includes(action)
    )
      return peer;
    return;
  };
}
