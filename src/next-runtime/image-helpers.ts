type AppRequire = (id: string) => unknown;

interface HashHelpers {
  getHash(items: (string | number | Buffer)[]): string;
  extractEtag(etag: string | null | undefined, buffer: Buffer): string;
}

/** Resolve from the app's Next installation, including the split 16.4 optimizer. */
export function loadImageHashHelpers(appRequire: AppRequire): HashHelpers {
  const legacy = appRequire("next/dist/server/image-optimizer") as Partial<HashHelpers>;
  if (typeof legacy.getHash === "function" && typeof legacy.extractEtag === "function") {
    return { getHash: legacy.getHash, extractEtag: legacy.extractEtag };
  }
  return appRequire("next/dist/server/image-optimizer/extract-etag") as HashHelpers;
}

export function loadImageSharp(
  appRequire: AppRequire,
  concurrency: number | null | undefined,
  operationCache: boolean | null | undefined,
): unknown {
  type Transform = {
    getSharp(
      concurrency: number | null | undefined,
      operationCache: boolean | null | undefined,
    ): unknown;
  };
  const legacy = appRequire("next/dist/server/image-optimizer") as Partial<Transform>;
  const transform =
    typeof legacy.getSharp === "function"
      ? (legacy as Transform)
      : (appRequire("next/dist/server/image-optimizer/transform") as Transform);
  return transform.getSharp(concurrency, operationCache);
}
