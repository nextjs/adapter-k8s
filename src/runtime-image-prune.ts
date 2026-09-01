import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

export interface PrunedRuntimeFiles {
  files: number;
  bytes: number;
}

async function pruneMatchingRuntimeFiles(
  root: string,
  shouldPrune: (relativePath: string) => boolean,
): Promise<PrunedRuntimeFiles> {
  const candidates: Array<{ path: string; bytes: number }> = [];
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute);
      if (!shouldPrune(relative)) continue;
      const info = await lstat(absolute);
      candidates.push({ path: absolute, bytes: info.size });
    }
  }

  const concurrency = 32;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!;
      await rm(candidate.path, { force: true });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, async () => worker()),
  );

  return {
    files: candidates.length,
    bytes: candidates.reduce((total, candidate) => total + candidate.bytes, 0),
  };
}

function buildOnlyNextFile(relativePath: string, keepSourceMaps: boolean): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return (
    normalized.startsWith("dist/docs/") ||
    (!keepSourceMaps && normalized.endsWith(".map")) ||
    normalized.endsWith(".d.ts") ||
    normalized.endsWith(".d.mts") ||
    normalized.endsWith(".d.cts")
  );
}

/**
 * Remove files that Next's production standalone trace also excludes. Keep JavaScript, manifests,
 * native assets, and licenses byte-for-byte; this only drops source maps, declarations, and the
 * packaged internal documentation from the private runtime copy staged into a pool image.
 */
export async function pruneNextRuntimePackage(
  root: string,
  options: { keepSourceMaps?: boolean } = {},
): Promise<PrunedRuntimeFiles> {
  return pruneMatchingRuntimeFiles(root, (relativePath) =>
    buildOnlyNextFile(relativePath, options.keepSourceMaps === true),
  );
}

/**
 * Production containers execute generated server JavaScript without Node's source-map flag.
 * Keep declarations and executable chunks untouched, but omit their build-only source maps.
 */
export async function pruneRuntimeSourceMaps(root: string): Promise<PrunedRuntimeFiles> {
  return pruneMatchingRuntimeFiles(root, (relativePath) => relativePath.endsWith(".map"));
}
