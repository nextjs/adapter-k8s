import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfigRuntime } from "next/dist/server/config-shared.js";
import type { CacheHandler } from "next/dist/server/lib/incremental-cache/index.js";
import type {
  CachedRouteKind,
  IncrementalResponseCacheEntry,
} from "next/dist/server/response-cache/index.js";
import type { RouteKind } from "next/dist/server/route-kind.js";
import type { ImageParams, OptimizedImage } from "./image-optimizer.js";

const DEFAULT_DISK_CACHE_BYTES = 256 * 1024 * 1024;

export async function createImageCache({
  projectDir,
  distDir,
  buildId,
  config,
}: {
  projectDir: string;
  distDir: string;
  buildId: string;
  config: NextConfigRuntime;
}) {
  const appRequire = createRequire(path.join(projectDir, "package.json"));
  const { ImageOptimizerCache, getHash } = appRequire(
    "next/dist/server/image-optimizer",
  ) as typeof import("next/dist/server/image-optimizer.js");
  const { default: ResponseCache } = appRequire(
    "next/dist/server/response-cache",
  ) as typeof import("next/dist/server/response-cache/index.js");
  const { getExtension, getContentType } = appRequire(
    "next/dist/server/serve-static",
  ) as typeof import("next/dist/server/serve-static.js");
  const { formatDynamicImportPath } = appRequire(
    "next/dist/lib/format-dynamic-import-path",
  ) as typeof import("next/dist/lib/format-dynamic-import-path.js");
  const configuredDiskBytes = config.images.maximumDiskCacheSize;
  const cacheConfig: NextConfigRuntime = {
    ...config,
    images: {
      ...config.images,
      // Next defaults to half the filesystem's available space. A pod's 1 GiB cache
      // volume needs a smaller payload budget, leaving room for its fetch cache too.
      maximumDiskCacheSize:
        typeof configuredDiskBytes === "number" &&
        Number.isSafeInteger(configuredDiskBytes) &&
        configuredDiskBytes >= 0
          ? configuredDiskBytes
          : DEFAULT_DISK_CACHE_BYTES,
    },
  };
  let cacheHandler: CacheHandler | undefined;
  if (config.images.customCacheHandler && config.cacheHandler) {
    try {
      const handlerUrl = formatDynamicImportPath(distDir, config.cacheHandler);
      const isAdapterHandler =
        fileURLToPath(handlerUrl) === path.resolve(projectDir, ".k8s-adapter", "cache-handler.cjs");
      // The adapter's no-Valkey delegate is Next's ordinary FileSystemCache, which
      // cannot store IMAGE entries. Use the dedicated image disk cache in that case.
      if (!isAdapterHandler || process.env.VALKEY_URL) {
        const imported = await import(handlerUrl);
        const Handler = imported.default?.default ?? imported.default ?? imported;
        const handler: CacheHandler & { supportsImageCache?: boolean } = new Handler({
          dev: false,
          flushToDisk: config.experimental.isrFlushToDisk,
          serverDistDir: path.join(distDir, "server"),
          maxMemoryCacheSize: config.cacheMaxMemorySize,
          revalidatedTags: [],
          _requestHeaders: {},
        });
        // N82 can also decline Valkey with its URL configured. Check the selected
        // delegate rather than assuming that configuration made it image-capable.
        if (!isAdapterHandler || handler.supportsImageCache !== false) {
          cacheHandler = handler;
        }
      }
    } catch {
      // An app handler failure must not interrupt image serving or silently move
      // its entries into a different store. The disabled disk cache produces misses.
      cacheConfig.images.maximumDiskCacheSize = 0;
      console.error("[pool-server] Image cache handler could not load; serving images uncached");
    }
  }
  const incrementalCache = new ImageOptimizerCache({
    distDir,
    nextConfig: cacheConfig,
    ...(cacheHandler ? { cacheHandler } : {}),
  });
  const responseCache = new ResponseCache(false);

  return {
    async get(
      params: ImageParams,
      generate: (previous: IncrementalResponseCacheEntry | null) => Promise<OptimizedImage>,
      waitUntil: (promise: Promise<unknown>) => void,
    ): Promise<{ image: OptimizedImage; status: "MISS" | "HIT" | "STALE" }> {
      // Image URLs such as /logo.png can change at cutover. Scope every store,
      // including application-provided handlers, to the build that produced it.
      const key = getHash([buildId, ImageOptimizerCache.getCacheKey(params)]);
      const entry = await responseCache.get(
        key,
        async ({ previousCacheEntry, hasResolved }) => {
          let image: OptimizedImage;
          try {
            image = await generate(previousCacheEntry ?? null);
          } catch (error) {
            // ResponseCache logs background failures itself. Fetch errors can contain
            // signed source URLs, so only foreground errors reach the HTTP mapper intact.
            if (hasResolved) throw new Error("[pool-server] Image cache revalidation failed");
            throw error;
          }
          return {
            value: {
              kind: "IMAGE" as CachedRouteKind.IMAGE,
              buffer: image.buffer,
              etag: image.etag,
              upstreamEtag: image.upstreamEtag,
              extension: getExtension(image.contentType) ?? "bin",
            },
            cacheControl: { revalidate: image.maxAge, expire: undefined },
          };
        },
        {
          routeKind: "IMAGE" as RouteKind.IMAGE,
          incrementalCache,
          isFallback: false,
          waitUntil,
        },
      );
      if (entry?.value?.kind !== "IMAGE") {
        throw new Error("Image response cache returned no image");
      }
      return {
        image: {
          buffer: entry.value.buffer,
          contentType: getContentType(entry.value.extension) ?? "application/octet-stream",
          etag: entry.value.etag,
          upstreamEtag: entry.value.upstreamEtag,
          maxAge:
            typeof entry.cacheControl?.revalidate === "number" ? entry.cacheControl.revalidate : 0,
        },
        status: entry.isMiss ? "MISS" : entry.isStale ? "STALE" : "HIT",
      };
    },
  };
}
