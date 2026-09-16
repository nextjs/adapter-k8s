import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextConfigRuntime } from "next/dist/server/config-shared.js";
import type { IncrementalResponseCacheEntry } from "next/dist/server/response-cache/index.js";
import { createImageCache } from "../../src/next-runtime/image-cache.js";
import {
  imageVariantKey,
  type ImageParams,
  type OptimizedImage,
} from "../../src/next-runtime/image-optimizer.js";

const require = createRequire(import.meta.url);
const { defaultConfig } = require("next/dist/server/config-shared");
const { resetDiskLRU } = require("next/dist/server/lib/disk-lru-cache.external");
const { getHash, ImageOptimizerCache } = require("next/dist/server/image-optimizer");

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

function image(body = "image1", maxAge = 60): OptimizedImage {
  return {
    buffer: Buffer.from(body),
    contentType: "image/png",
    etag: `encoded-${body}`,
    upstreamEtag: `source-${body}`,
    maxAge,
  };
}

describe("Next image response cache integration", () => {
  let projectDir: string;
  let distDir: string;
  const background = new Set<Promise<unknown>>();
  const waitUntil = (promise: Promise<unknown>) => {
    background.add(promise);
    void promise.finally(() => background.delete(promise)).catch(() => undefined);
  };

  beforeEach(() => {
    resetDiskLRU();
    vi.stubEnv("VALKEY_URL", "");
    projectDir = mkdtempSync(path.join(process.cwd(), ".image-cache-stage-"));
    distDir = path.join(projectDir, ".next");
    mkdirSync(distDir);
    writeFileSync(path.join(projectDir, "package.json"), '{"type":"module"}');
  });

  afterEach(async () => {
    await Promise.allSettled(background);
    resetDiskLRU();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function config(overrides: Partial<NextConfigRuntime> = {}): NextConfigRuntime {
    return {
      ...defaultConfig,
      ...overrides,
      images: { ...defaultConfig.images, minimumCacheTTL: 0, ...overrides.images },
      experimental: { ...defaultConfig.experimental, ...overrides.experimental },
    };
  }

  function cache(nextConfig = config(), buildId = "build1") {
    return createImageCache({ projectDir, distDir, buildId, config: nextConfig });
  }

  function customHandler(source: string, name = "image-handler.mjs") {
    const file = path.join(projectDir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
  }

  it("serves disk hits with the original bytes, etags and response lifetime", async () => {
    const store = await cache();
    const generate = vi.fn(async () => image());
    expect(await store.get(params, generate, waitUntil)).toEqual({
      image: image(),
      status: "MISS",
    });
    expect(await store.get(params, generate, waitUntil)).toEqual({ image: image(), status: "HIT" });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(null);
  });

  it("separates URL/width variants that collide in Next's cache key", async () => {
    const first = { ...params, href: "/logo.png20", width: 48 };
    const second = { ...params, href: "/logo.png", width: 2048 };
    expect(ImageOptimizerCache.getCacheKey(first)).toBe(ImageOptimizerCache.getCacheKey(second));
    const store = await cache();
    await store.get(first, async () => image("first"), waitUntil);
    expect(await store.get(second, async () => image("second"), waitUntil)).toEqual({
      image: image("second"),
      status: "MISS",
    });
    expect(await store.get(first, async () => image("unexpected"), waitUntil)).toEqual({
      image: image("first"),
      status: "HIT",
    });
  });

  it.each(["image/svg+xml", "image/gif", "image/jp2", "image/tiff"])(
    "preserves %s through a cache miss and hit",
    async (contentType) => {
      const store = await cache();
      const original = { ...image(), contentType };
      const generate = vi.fn(async () => original);
      expect(await store.get(params, generate, waitUntil)).toEqual({
        image: original,
        status: "MISS",
      });
      expect(await store.get(params, generate, waitUntil)).toEqual({
        image: original,
        status: "HIT",
      });
      expect(generate).toHaveBeenCalledOnce();
    },
  );

  it("returns stale bytes while refreshing and supplies previous source validators", async () => {
    const store = await cache();
    const initial = image("before", 1);
    await store.get(params, async () => initial, waitUntil);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 1_100);
    const refresh = Promise.withResolvers<OptimizedImage>();
    const started = Promise.withResolvers<IncrementalResponseCacheEntry | null>();
    const stale = await store.get(
      params,
      (previous) => {
        started.resolve(previous);
        return refresh.promise;
      },
      waitUntil,
    );
    expect(stale).toEqual({ image: initial, status: "STALE" });
    const previous = await started.promise;
    expect(previous?.value).toMatchObject({
      kind: "IMAGE",
      buffer: initial.buffer,
      etag: initial.etag,
      upstreamEtag: initial.upstreamEtag,
    });
    expect(previous?.cacheControl?.revalidate).toBe(1);
    expect(background.size).toBeGreaterThan(0);
    refresh.resolve(image("after"));
    await Promise.allSettled(background);
    const generate = vi.fn(async () => image("unexpected"));
    expect(await store.get(params, generate, waitUntil)).toEqual({
      image: image("after"),
      status: "HIT",
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it("separates disk entries belonging to different builds", async () => {
    const first = await cache(config(), "build1");
    const second = await cache(config(), "build2");
    await first.get(params, async () => image("first"), waitUntil);
    expect(await second.get(params, async () => image("second"), waitUntil)).toEqual({
      image: image("second"),
      status: "MISS",
    });
    expect(await first.get(params, async () => image("unexpected"), waitUntil)).toEqual({
      image: image("first"),
      status: "HIT",
    });
  });

  it("keeps stale images on refresh failure without logging source credentials", async () => {
    const store = await cache();
    const original = image("old", 1);
    await store.get(params, async () => original, waitUntil);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_100);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await store.get(
      params,
      async () => {
        throw new Error("https://example.test/image.png?token=private-token");
      },
      waitUntil,
    );
    expect(result).toEqual({ image: original, status: "STALE" });
    await Promise.allSettled(background);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().map(String).join(" ")).not.toContain("private-token");
    const retry = vi.fn(async () => image("unexpected"));
    expect((await store.get(params, retry, waitUntil)).status).toBe("HIT");
    expect(retry).not.toHaveBeenCalled();
  });

  it("evicts a previous disk entry when the configured payload budget is exceeded", async () => {
    const store = await cache(
      config({ images: { ...defaultConfig.images, maximumDiskCacheSize: 10 } }),
    );
    await store.get(params, async () => image("123456"), waitUntil);
    const nextParams = { ...params, href: "/second.png" };
    await store.get(nextParams, async () => image("abcdef"), waitUntil);
    const nextKey = getHash([
      JSON.stringify([
        "build1",
        ImageOptimizerCache.getCacheKey(nextParams),
        imageVariantKey(nextParams),
      ]),
    ]);
    await vi.waitFor(async () => {
      expect(await readdir(path.join(distDir, "cache", "images"))).toEqual([nextKey]);
    });
    expect((await store.get(params, async () => image("123456"), waitUntil)).status).toBe("MISS");
  });

  it.each(["zero budget", "disk flushing disabled"])(
    "does not persist images with %s",
    async (mode) => {
      const store = await cache(
        config({
          images: {
            ...defaultConfig.images,
            maximumDiskCacheSize: mode === "zero budget" ? 0 : 64,
          },
          experimental: {
            ...defaultConfig.experimental,
            isrFlushToDisk: mode !== "disk flushing disabled",
          },
        }),
      );
      const generate = vi.fn(async () => image());
      expect((await store.get(params, generate, waitUntil)).status).toBe("MISS");
      expect((await store.get(params, generate, waitUntil)).status).toBe("MISS");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(existsSync(path.join(distDir, "cache", "images"))).toBe(false);
    },
  );

  it("keeps serving images when the disk cache cannot be written", async () => {
    writeFileSync(path.join(distDir, "cache"), "not a directory");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = await cache();
    const generate = vi.fn(async () => image());
    for (let request = 0; request < 2; request++) {
      expect(await store.get(params, generate, waitUntil)).toEqual({
        image: image(),
        status: "MISS",
      });
    }
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, -1, Infinity, NaN, 1.5])(
    "uses a fixed disk budget for invalid or absent size %s",
    async (maximumDiskCacheSize) => {
      const fs = require("node:fs");
      const statfs = vi
        .spyOn(fs.promises, "statfs")
        .mockRejectedValue(new Error("filesystem probing forbidden"));
      const store = await cache(
        config({ images: { ...defaultConfig.images, maximumDiskCacheSize } }),
      );
      await store.get(params, async () => image(), waitUntil);
      expect((await store.get(params, async () => image("unexpected"), waitUntil)).status).toBe(
        "HIT",
      );
      expect(statfs).not.toHaveBeenCalled();
    },
  );

  it.each(["relative", "file URL", "CommonJS"])(
    "loads a %s handler once and shares entries across requests",
    async (kind) => {
      const logPath = path.join(projectDir, "handler-calls.jsonl");
      const declaration =
        kind === "CommonJS" ? "module.exports.default = class" : "export default class";
      const handler = customHandler(
        `
${kind === "CommonJS" ? 'const { appendFileSync } = require("node:fs");' : 'import { appendFileSync } from "node:fs";'}
const log = (event) => appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(event) + "\\n");
${declaration} {
  entries = new Map();
  constructor(context) { log({ constructor: context }); }
  async get(key, context) { log({ get: context }); return this.entries.get(key) ?? null; }
  async set(key, value, context) {
    log({ set: { kind: value.kind, revalidate: value.revalidate, context } });
    this.entries.set(key, { value, lastModified: Date.now() });
  }
}
`,
        kind === "CommonJS" ? "image-handler.cjs" : "image-handler.mjs",
      );
      const cacheHandler =
        kind === "file URL" ? pathToFileURL(handler).href : path.relative(distDir, handler);
      const nextConfig = config({
        cacheHandler,
        cacheMaxMemorySize: 0,
        images: { ...defaultConfig.images, customCacheHandler: true, minimumCacheTTL: 5 },
      });
      const store = await cache(nextConfig);
      const generate = vi.fn(async () => image("shared", 1));
      expect((await store.get(params, generate, waitUntil)).status).toBe("MISS");
      const hit = await store.get(params, generate, waitUntil);
      expect(hit.status).toBe("HIT");
      expect(hit.image).toEqual(image("shared", 5));
      expect(generate).toHaveBeenCalledOnce();
      const events = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.filter((event) => Object.hasOwn(event, "constructor"))).toEqual([
        {
          constructor: {
            dev: false,
            flushToDisk: true,
            serverDistDir: path.join(distDir, "server"),
            maxMemoryCacheSize: 0,
            revalidatedTags: [],
            _requestHeaders: {},
          },
        },
      ]);
      expect(events.find((event) => event.get)?.get).toEqual({ kind: "IMAGE", isFallback: false });
      expect(events.find((event) => event.set)?.set).toEqual({
        kind: "IMAGE",
        revalidate: 5,
        context: { cacheControl: { revalidate: 5 } },
      });
      expect(existsSync(path.join(distDir, "cache", "images"))).toBe(false);
    },
  );

  it("does not load an app's incremental handler without the image-cache opt-in", async () => {
    const handler = customHandler('throw new Error("must not import this handler");');
    const store = await cache(config({ cacheHandler: handler }));
    await store.get(params, async () => image(), waitUntil);
    expect((await store.get(params, async () => image("unexpected"), waitUntil)).status).toBe(
      "HIT",
    );
  });

  it("shares custom-store images between cache instances while isolating different builds", async () => {
    const handler = customHandler(`const entries = new Map();
export default class {
  async get(key) { return entries.get(key) ?? null; }
  async set(key, value) { entries.set(key, { value, lastModified: Date.now() }); }
}\n`);
    const nextConfig = config({
      cacheHandler: handler,
      images: { ...defaultConfig.images, minimumCacheTTL: 0, customCacheHandler: true },
    });
    const first = await cache(nextConfig, "build1");
    const replica = await cache(nextConfig, "build1");
    const replacement = await cache(nextConfig, "build2");
    await first.get(params, async () => image("first"), waitUntil);
    const generate = vi.fn(async () => image("unexpected"));
    expect(await replica.get(params, generate, waitUntil)).toEqual({
      image: image("first"),
      status: "HIT",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(await replacement.get(params, async () => image("second"), waitUntil)).toEqual({
      image: image("second"),
      status: "MISS",
    });
  });

  it("uses the image disk cache for the adapter-owned handler without Valkey", async () => {
    const handler = customHandler(
      'throw new Error("ordinary FileSystemCache cannot store images");',
      ".k8s-adapter/cache-handler.cjs",
    );
    const store = await cache(
      config({
        cacheHandler: path.relative(distDir, handler),
        images: { ...defaultConfig.images, customCacheHandler: true },
      }),
    );
    await store.get(params, async () => image(), waitUntil);
    expect((await store.get(params, async () => image("unexpected"), waitUntil)).status).toBe(
      "HIT",
    );
  });

  it.each(["import", "read and write"])(
    "serves uncached images when a custom handler fails during %s",
    async (failure) => {
      const handler = customHandler(
        failure === "import"
          ? 'throw new Error("handler unavailable");'
          : 'export default class { async get() { throw new Error("read unavailable"); } async set() { throw new Error("write unavailable"); } }',
      );
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const store = await cache(
        config({
          cacheHandler: handler,
          images: { ...defaultConfig.images, customCacheHandler: true },
        }),
      );
      const generate = vi.fn(async () => image());
      expect((await store.get(params, generate, waitUntil)).status).toBe("MISS");
      expect((await store.get(params, generate, waitUntil)).status).toBe("MISS");
      expect(generate).toHaveBeenCalledTimes(2);
      expect(existsSync(path.join(distDir, "cache", "images"))).toBe(false);
    },
  );
});
