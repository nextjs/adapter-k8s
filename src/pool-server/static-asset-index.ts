import type { StaticAssetEntry } from "../types.js";

type AssetKind = "all" | "plain" | "prerender";

interface IndexedAsset {
  entry: StaticAssetEntry;
  order: number;
}

/** Build outputs are immutable for a pool's lifetime. Keep their original order: an alias or
 * decoded pathname earlier in the manifest must still beat a later exact-path entry. */
export function createStaticAssetIndex(assets: readonly StaticAssetEntry[]) {
  const indexes: Record<AssetKind, Map<string, IndexedAsset>> = {
    all: new Map(),
    plain: new Map(),
    prerender: new Map(),
  };
  for (const [order, entry] of assets.entries()) {
    const indexed = { entry, order };
    if (!indexes.all.has(entry.pathname)) indexes.all.set(entry.pathname, indexed);
    const filtered = entry.prerender ? indexes.prerender : indexes.plain;
    if (!filtered.has(entry.pathname)) filtered.set(entry.pathname, indexed);
  }

  const find = (pathnames: readonly string[], kind: AssetKind = "all") => {
    let first: IndexedAsset | undefined;
    const index = indexes[kind];
    for (const pathname of pathnames) {
      const candidate = index.get(pathname);
      if (candidate && (!first || candidate.order < first.order)) first = candidate;
    }
    return first?.entry;
  };

  return {
    find,
    findRoute(pathnames: readonly string[], basePath = "", isRsc = false) {
      const candidates: string[] = [];
      for (const pathname of pathnames) {
        candidates.push(pathname, pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/");
        // The Pages Router root prerender is keyed "/index"; routing may resolve it to "/".
        if (pathname === "/") candidates.push("/index");
        // Fully-static roots may stay keyed as "/" while routing resolves the basePath root.
        if (basePath && pathname === basePath) candidates.push("/", "/index", `${basePath}/index`);
        // RSC requests also consider the prerendered flight payload, preserving manifest order.
        if (isRsc) candidates.push(pathname + ".rsc");
      }
      return find(candidates);
    },
    hasPlainPath(pathname: string) {
      return (
        indexes.plain.has(pathname) ||
        indexes.plain.has(pathname.endsWith("/") ? pathname.slice(0, -1) : pathname + "/")
      );
    },
  };
}

export type StaticAssetIndex = ReturnType<typeof createStaticAssetIndex>;
