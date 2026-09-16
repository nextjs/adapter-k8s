import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImageCache } from "../../src/next-runtime/image-cache.js";
import {
  imageVariantKey,
  type ImageParams,
  type OptimizedImage,
} from "../../src/next-runtime/image-optimizer.js";
import {
  createValkeyClient,
  type ValkeyClient,
} from "../../src/pool-server/valkey-cache/client.js";

const require = createRequire(import.meta.url);
const { defaultConfig } = require("next/dist/server/config-shared");
const { getHash, ImageOptimizerCache } = require("next/dist/server/image-optimizer");
const REPO_ROOT = process.cwd();

function docker(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  }).trim();
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

const params: ImageParams = {
  href: "/logo.png",
  width: 384,
  quality: 75,
  mimeType: "image/png",
  sizes: [384],
  isAbsolute: false,
  isStatic: false,
  minimumCacheTTL: 0,
};

function image(body: string, maxAge = 30): OptimizedImage {
  return {
    buffer: Buffer.from(body),
    contentType: "image/png",
    etag: `encoded-${body}`,
    upstreamEtag: `source-${body}`,
    maxAge,
  };
}

describe.skipIf(!dockerAvailable)("image caching through the packaged Valkey handler", () => {
  const containerName = `adapter-k8s-image-cache-test-${process.pid}`;
  let temporaryRoot: string;
  let handlerBundle: Uint8Array;
  let client: ValkeyClient;
  let replicaIndex = 0;
  const background = new Set<Promise<unknown>>();
  const waitUntil = (promise: Promise<unknown>) => {
    background.add(promise);
    void promise.finally(() => background.delete(promise)).catch(() => undefined);
  };

  beforeAll(async () => {
    temporaryRoot = mkdtempSync(path.join(REPO_ROOT, ".image-cache-integration-"));
    const bundled = await build({
      entryPoints: [path.join(REPO_ROOT, "src/pool-server/valkey-cache/cache-handler-entry.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["next"],
      write: false,
    });
    handlerBundle = bundled.outputFiles[0]!.contents;
    docker([
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      "127.0.0.1::6379",
      "valkey/valkey:8-alpine",
    ]);
    const port = Number(
      docker(["port", containerName, "6379/tcp"]).split("\n")[0]!.split(":").pop(),
    );
    const url = `redis://127.0.0.1:${port}`;
    await vi.waitFor(
      () => {
        expect(docker(["exec", containerName, "valkey-cli", "ping"])).toBe("PONG");
      },
      { timeout: 10_000, interval: 100 },
    );
    vi.stubEnv("VALKEY_URL", url);
    vi.stubEnv("VALKEY_AUTH", "");
    vi.stubEnv("VALKEY_CA_CERT", "");
    vi.stubEnv("ADAPTER_K8S_DIST_DIR", ".next");
    client = createValkeyClient({ url });
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled(background);
    await client?.quit().catch(() => undefined);
    // Stopping this test's container closes the private connections held by the bundled
    // handler instances too; those clients reconnect only when another command is sent.
    try {
      docker(["rm", "-f", containerName]);
    } catch {
      // Container startup may have failed before a container existed.
    }
    vi.unstubAllEnvs();
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  });

  async function replica(buildId: string, minimumCacheTTL = 0, maximumDiskCacheSize = 0) {
    const projectDir = path.join(temporaryRoot, `replica-${replicaIndex++}`);
    const distDir = path.join(projectDir, ".next");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(path.join(projectDir, ".k8s-adapter"));
    writeFileSync(path.join(projectDir, "package.json"), '{"type":"module"}');
    const cacheHandler = path.join(projectDir, ".k8s-adapter", "cache-handler.cjs");
    writeFileSync(cacheHandler, handlerBundle);
    // Each replica has its own bundled entry module and therefore its own connection
    // and handler singleton, just as separate pool processes do in Kubernetes.
    vi.stubEnv("NEXT_BUILD_ID", buildId);
    const cache = await createImageCache({
      projectDir,
      distDir,
      buildId,
      config: {
        ...defaultConfig,
        cacheHandler: path.relative(distDir, cacheHandler),
        cacheMaxMemorySize: 0,
        images: {
          ...defaultConfig.images,
          customCacheHandler: true,
          maximumDiskCacheSize,
          minimumCacheTTL,
        },
      },
    });
    return { cache, distDir };
  }

  it("shares optimized bytes across replicas and keeps a new build isolated", async () => {
    const first = await replica("image-shared");
    const second = await replica("image-shared");
    const replacement = await replica("image-replacement");
    const original = image("from-first-replica");
    expect(await first.cache.get(params, async () => original, waitUntil)).toEqual({
      image: original,
      status: "MISS",
    });
    const generate = vi.fn(async () => image("unexpected"));
    expect(await second.cache.get(params, generate, waitUntil)).toEqual({
      image: original,
      status: "HIT",
    });
    expect(generate).not.toHaveBeenCalled();
    const newImage = image("from-new-build");
    expect(await replacement.cache.get(params, async () => newImage, waitUntil)).toEqual({
      image: newImage,
      status: "MISS",
    });
    expect((await first.cache.get(params, generate, waitUntil)).image.buffer).toEqual(
      original.buffer,
    );
    for (const instance of [first, second, replacement]) {
      expect(existsSync(path.join(instance.distDir, "cache", "images"))).toBe(false);
    }
  });

  it("uses the image disk cache when the packaged handler rejects the build ID", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { cache, distDir } = await replica("unsafe:build", 0, 1024);
      const original = image("from-disk");
      const generate = vi.fn(async () => original);
      expect(await cache.get(params, generate, waitUntil)).toEqual({
        image: original,
        status: "MISS",
      });
      await Promise.allSettled(background);
      expect(await cache.get(params, generate, waitUntil)).toEqual({
        image: original,
        status: "HIT",
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(existsSync(path.join(distDir, "cache", "images"))).toBe(true);
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining("NEXT_BUILD_ID is unsafe"),
        expect.any(String),
      );
    } finally {
      log.mockRestore();
    }
  });

  it("applies the minimum TTL and refreshes stale shared images", async () => {
    const buildId = "image-expiry";
    const first = await replica(buildId, 1);
    const second = await replica(buildId, 1);
    const original = image("before-expiry", 0);
    await first.cache.get(params, async () => original, waitUntil);
    const key = `k8s:${buildId}:inc:${getHash([JSON.stringify([buildId, ImageOptimizerCache.getCacheKey(params), imageVariantKey(params)])])}`;
    const stored = JSON.parse((await client.get(key))!);
    expect(stored.value.kind).toBe("IMAGE");
    expect(stored.value.revalidate).toBe(1);
    expect(await client.ttl(key)).toBeGreaterThanOrEqual(60);
    expect(await client.ttl(key)).toBeLessThanOrEqual(61);
    const generate = vi.fn(async () => image("unexpected"));
    const hit = await second.cache.get(params, generate, waitUntil);
    expect(hit.status).toBe("HIT");
    expect(hit.image.maxAge).toBe(1);
    expect(generate).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const refresh = Promise.withResolvers<OptimizedImage>();
    const regenerate = vi.fn(async (previous) => {
      expect(previous?.value.upstreamEtag).toBe(original.upstreamEtag);
      return refresh.promise;
    });
    const stale = await second.cache.get(params, regenerate, waitUntil);
    expect(stale.status).toBe("STALE");
    expect(stale.image.buffer).toEqual(original.buffer);
    const updated = image("after-expiry");
    refresh.resolve(updated);
    await Promise.allSettled(background);
    expect(regenerate).toHaveBeenCalledOnce();
    expect(await first.cache.get(params, generate, waitUntil)).toEqual({
      image: updated,
      status: "HIT",
    });
    expect(generate).not.toHaveBeenCalled();
  });
});
