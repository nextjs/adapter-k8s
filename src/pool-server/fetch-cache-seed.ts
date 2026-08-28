// Restore the build's fetch-cache into the pod's writable cache dir at boot.
//
// The image ships the BUILD's fetch-cache under `.k8s-adapter/fetch-cache-seed` rather than
// its runtime location (`<distDir>/cache/fetch-cache`) because the pod mounts a writable
// emptyDir at `/app/<distDir>/cache` (deployment.ts `next-cache`, required under
// readOnlyRootFilesystem) — anything baked into the image at the mounted path is simply
// INVISIBLE in the pod. Measured 2026-08-04: the image had the files, `kubectl exec` showed
// an empty dir, and both consumers read the runtime location — Next's FileSystemCache
// (file-system-cache.ts getFilePath) and the classic handler's FETCH seed
// (build-seed-index.ts fetchCacheSeed). Without the files, a post-revalidateTag FETCH read
// is a MISS, patch-fetch re-fetches under the prerender's abort signal, and the
// cache-components background revalidation dies under load (rdc stale-forever).
//
// The copy is per-file and never clobbers: a file already present in the emptyDir is a
// RUNTIME write (fresher than the build's) and must win. The validated manifest distDir is
// shared by the chart mount, this restore, and both seed readers.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export function restoreFetchCacheSeed(
  appRoot: string,
  distDir = path.join(appRoot, ".next"),
): void {
  const src = path.join(appRoot, ".k8s-adapter", "fetch-cache-seed");
  if (!existsSync(src)) return;
  const dest = path.join(distDir, "cache", "fetch-cache");
  try {
    mkdirSync(dest, { recursive: true });
    let restored = 0;
    for (const name of readdirSync(src)) {
      const srcFile = path.join(src, name);
      if (!statSync(srcFile).isFile()) continue;
      const destFile = path.join(dest, name);
      if (existsSync(destFile)) continue; // a runtime write is fresher than the build's
      copyFileSync(srcFile, destFile);
      restored++;
    }
    if (restored > 0) {
      console.log(`[pool-server] restored ${restored} build fetch-cache entries into ${dest}`);
    }
  } catch (error) {
    // Fail open: a botched restore degrades to the pre-seed behavior (cache misses),
    // never a crashed pod — but say so (M1).
    console.warn("[pool-server] failed to restore the build fetch-cache seed:", error);
  }
}
