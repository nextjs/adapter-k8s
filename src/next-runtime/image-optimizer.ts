import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { ImageConfigComplete } from "next/dist/shared/lib/image-config.js";
import type { NextConfigRuntime } from "next/dist/server/config-shared.js";
import type * as ImageOptimizer from "next/dist/server/image-optimizer.js";

export type ImageConfig = ImageConfigComplete;
type ImageLocalPattern = NonNullable<ImageConfig["localPatterns"]>[number];
export type ImageParams = ImageOptimizer.ImageParamsResult;
export type PreviousImageCacheEntry =
  | import("next/dist/server/response-cache/index.js").IncrementalResponseCacheEntry
  | null;
export type OptimizedImage = Awaited<ReturnType<typeof ImageOptimizer.imageOptimizer>>;

export function imageVariantKey(params: ImageParams): string {
  // Next's hash concatenates URL and width without separators: /image20 at 48
  // collides with /image at 2048. Preserve tuple boundaries before sharing work.
  return JSON.stringify([params.href, params.width, params.quality, params.mimeType]);
}

function toAllowedSizes(values: unknown[]): number[] {
  return values.filter(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10000,
  );
}

function loadImageConfig(images: Record<string, any>, defaults: ImageConfig): ImageConfig {
  const config: ImageConfig = { ...defaults, localPatterns: undefined };
  try {
    if (Array.isArray(images.remotePatterns)) config.remotePatterns = images.remotePatterns;
    if (Array.isArray(images.domains)) config.domains = images.domains;
    // PRESENCE again, not truthiness: absent ⇒ allow every local image (upstream's
    // `!localPatterns` short-circuit); present-but-empty ⇒ allow none. Entries are kept
    // only in the shape upstream's `matchLocalPattern` reads, so a junk entry can neither
    // widen the allowlist nor throw inside the matcher.
    if (Array.isArray(images.localPatterns)) {
      config.localPatterns = images.localPatterns.filter(
        (pattern: unknown): pattern is ImageLocalPattern =>
          typeof pattern === "object" &&
          pattern !== null &&
          ((pattern as ImageLocalPattern).pathname === undefined ||
            typeof (pattern as ImageLocalPattern).pathname === "string") &&
          ((pattern as ImageLocalPattern).search === undefined ||
            typeof (pattern as ImageLocalPattern).search === "string"),
      );
    }
    // PRESENCE, not truthiness: `imageSizes: []` is valid config meaning "only
    // deviceSizes are allowed", and falling back to Next's default list for it would
    // silently WIDEN the accepted width set past what the app configured. Entries are
    // filtered to the shape Next's config schema guarantees (int 1..10000) because they
    // bound a sharp allocation.
    if (Array.isArray(images.deviceSizes)) config.deviceSizes = toAllowedSizes(images.deviceSizes);
    if (Array.isArray(images.imageSizes)) config.imageSizes = toAllowedSizes(images.imageSizes);
    // `images.qualities` (schema: 1..20 ints in 1..100, so never legitimately empty).
    // An unreadable/empty list keeps Next's default [75] rather than disabling the
    // check — the narrow direction.
    if (Array.isArray(images.qualities)) {
      const qualities = images.qualities.filter(
        (value: unknown): value is number =>
          typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100,
      );
      if (qualities.length) config.qualities = qualities;
    }
    config.unoptimized = images.unoptimized === true;
    config.dangerouslyAllowLocalIP = images.dangerouslyAllowLocalIP === true;
    config.customCacheHandler = images.customCacheHandler === true;
    if (typeof images.loader === "string") config.loader = images.loader as ImageConfig["loader"];
    for (const key of [
      "maximumRedirects",
      "maximumResponseBody",
      "maximumDiskCacheSize",
    ] as const) {
      const value = images[key];
      if (Number.isSafeInteger(value) && value >= 0) config[key] = value;
    }
    config.dangerouslyAllowSVG = images.dangerouslyAllowSVG === true;
    if (typeof images.contentSecurityPolicy === "string" && images.contentSecurityPolicy)
      config.contentSecurityPolicy = images.contentSecurityPolicy;
    if (images.contentDispositionType === "inline") config.contentDispositionType = "inline";
    // Validate at the point of consumption: these two steer a response header and the
    // encoder, so keep only values this pipeline can honor. An unrecognized `formats`
    // entry is dropped (never handed to sharp); an all-unrecognized list falls back to
    // Next's default rather than disabling negotiation entirely.
    if (Array.isArray(images.formats)) {
      const supported = images.formats.filter(
        (format: unknown): format is "image/avif" | "image/webp" =>
          format === "image/webp" || format === "image/avif",
      );
      if (supported.length) config.formats = supported;
    }
    if (
      typeof images.minimumCacheTTL === "number" &&
      Number.isSafeInteger(images.minimumCacheTTL) &&
      images.minimumCacheTTL >= 0
    ) {
      config.minimumCacheTTL = images.minimumCacheTTL;
    }
  } catch {
    // No image config — external images denied by default, sizes fall back to defaults,
    // SVG stays denied (fail-safe direction).
  }
  return config;
}

/** Resolve private helpers from the app so optimizer JavaScript and staged Sharp stay paired. */
export function createImageOptimizer(projectDir: string, distDir: string) {
  const appRequire = createRequire(path.join(projectDir, "package.json"));
  const upstream = appRequire("next/dist/server/image-optimizer") as typeof ImageOptimizer;
  const { defaultConfig } = appRequire(
    "next/dist/server/config-shared",
  ) as typeof import("next/dist/server/config-shared.js");
  const { hasRemoteMatch } = appRequire(
    "next/dist/shared/lib/match-remote-pattern",
  ) as typeof import("next/dist/shared/lib/match-remote-pattern.js");
  const { getExtension } = appRequire(
    "next/dist/server/serve-static",
  ) as typeof import("next/dist/server/serve-static.js");
  const configPath = path.join(distDir, "required-server-files.json");
  let saved: Partial<NextConfigRuntime> = {};
  try {
    if (existsSync(configPath)) {
      saved = JSON.parse(readFileSync(configPath, "utf8")).config ?? {};
    }
  } catch {
    // Keep restrictive defaults when build configuration cannot be read.
  }
  const config = {
    ...defaultConfig,
    ...saved,
    experimental: { ...defaultConfig.experimental, ...saved.experimental },
    images: loadImageConfig(saved.images ?? {}, defaultConfig.images),
  } as NextConfigRuntime;
  let sharpReady: boolean | undefined;
  return {
    config,
    upstream,
    isRemoteAllowed(target: URL) {
      return (
        (target.protocol === "http:" || target.protocol === "https:") &&
        hasRemoteMatch(config.images.domains, config.images.remotePatterns, target)
      );
    },
    validate(req: IncomingMessage, search: URLSearchParams) {
      const query: Record<string, string | string[]> = {};
      for (const key of new Set(search.keys())) {
        const values = search.getAll(key);
        query[key] = values.length === 1 ? values[0]! : values;
      }
      try {
        return upstream.ImageOptimizerCache.validateParams(req, query, config, false);
      } catch {
        // A malformed percent escape must remain a client error, never a process failure.
        return { errorMessage: '"url" parameter is invalid' };
      }
    },
    async optimize(
      buffer: Buffer,
      contentType: string,
      cacheControl: string | null,
      etag: string | null,
      params: ImageParams,
      previousCacheEntry?: PreviousImageCacheEntry,
    ) {
      // Missing native code is a broken deployment, not an optimization failure that
      // should silently serve originals. Memoize failures too (canary.97 incident).
      if (sharpReady === undefined) {
        try {
          upstream.getSharp(
            config.experimental.imgOptConcurrency,
            config.experimental.imgOptOperationCache,
          );
          sharpReady = true;
        } catch {
          sharpReady = false;
          console.error("[pool-server] Sharp is unavailable; check the staged runtime image");
        }
      }
      if (!sharpReady) throw new upstream.ImageError(503, "Image optimization unavailable");
      return upstream.imageOptimizer(
        { buffer, contentType, cacheControl, etag: upstream.extractEtag(etag, buffer) },
        params,
        config,
        { isDev: false, silent: true, ...(previousCacheEntry ? { previousCacheEntry } : {}) },
      );
    },
    send(
      req: IncomingMessage,
      res: ServerResponse,
      href: string,
      image: OptimizedImage,
      isStatic: boolean,
      status: "MISS" | "HIT" | "STALE" = "MISS",
    ) {
      upstream.sendResponse(
        req,
        res,
        href,
        getExtension(image.contentType) ?? "bin",
        image.buffer,
        image.etag,
        isStatic,
        status,
        config.images,
        image.maxAge,
        false,
      );
    },
  };
}
