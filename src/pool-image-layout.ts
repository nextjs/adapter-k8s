import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

export const SHARED_POOL_IMAGE_LAYOUT = "shared-base-v1" as const;
export type PoolImageLayout = typeof SHARED_POOL_IMAGE_LAYOUT;

export function parsePoolImageLayout(
  value: unknown,
  source = "build-metadata.json poolImageLayout",
): PoolImageLayout | undefined {
  if (value === undefined) return undefined;
  if (value === SHARED_POOL_IMAGE_LAYOUT) return value;
  throw new Error(
    `Unsupported ${source} ${JSON.stringify(value)}. Upgrade @next-community/adapter-k8s ` +
      `to a version that understands this image layout, or rebuild the application.`,
  );
}

export interface SharedPoolFilesResult {
  sharedFiles: number;
  sharedBytes: number;
  dependencyFiles: number;
  dependencyBytes: number;
  contentFiles: number;
  contentBytes: number;
  fetchCacheFiles: number;
  fetchCacheBytes: number;
}

interface SharedFile {
  relative: string;
  candidates: IndexedFile[];
}

const MAX_CONCURRENT_DIGESTS = 64;
const MAX_CONCURRENT_MUTATIONS = 32;

interface IndexedFile {
  absolute: string;
  size: number;
  mode: number;
}

async function regularFiles(
  root: string,
  relative = "",
  files = new Map<string, IndexedFile>(),
): Promise<Map<string, IndexedFile>> {
  const dir = path.join(root, relative);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) await regularFiles(root, child, files);
    else if (entry.isFile()) {
      const absolute = path.join(root, child);
      const info = await lstat(absolute);
      files.set(child, { absolute, size: info.size, mode: info.mode });
    }
  }
  return files;
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function dependencyLayerPath(relative: string): boolean {
  const parts = relative.split(path.sep);
  return (
    parts.includes("node_modules") ||
    relative === "package.json" ||
    relative === "pool-server.cjs" ||
    relative === path.join(".k8s-adapter", "cache-handler.cjs")
  );
}

function fetchCacheLayerPath(relative: string): boolean {
  return relative.startsWith(path.join(".k8s-adapter", "fetch-cache-seed") + path.sep);
}

function parentDirectories(relativeFile: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(relativeFile);
  while (current !== ".") {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories;
}

async function removeEmptiedDirectories(root: string, directories: Set<string>): Promise<void> {
  const deepestFirst = [...directories].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length,
  );
  for (const relative of deepestFirst) {
    try {
      await rmdir(path.join(root, relative));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw error;
    }
  }
}

async function runBounded<T>(
  values: readonly T[],
  limit: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < values.length) {
      const value = values[next++]!;
      await operation(value);
    }
  };
  const outcomes = await Promise.allSettled(
    Array.from({ length: Math.min(limit, values.length) }, async () => worker()),
  );
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failure) throw failure.reason;
}

/**
 * Move files that are identical at the same path in every pool into one OCI parent context.
 * A file with different bytes, mode, type, or presence stays in every pool delta.
 */
export async function factorSharedPoolFiles(
  poolContexts: string[],
  baseContext: string,
): Promise<SharedPoolFilesResult> {
  if (poolContexts.length < 2) {
    throw new Error("Shared pool image factoring requires at least two pool contexts.");
  }
  await rm(baseContext, { recursive: true, force: true });
  await Promise.all(
    ["dependencies", "content", "fetch-cache"].map((layer) =>
      mkdir(path.join(baseContext, layer), { recursive: true }),
    ),
  );
  const result: SharedPoolFilesResult = {
    sharedFiles: 0,
    sharedBytes: 0,
    dependencyFiles: 0,
    dependencyBytes: 0,
    contentFiles: 0,
    contentBytes: 0,
    fetchCacheFiles: 0,
    fetchCacheBytes: 0,
  };

  // Index every context without following symlinked directories. Looking up candidates by
  // relative path after this pass prevents a real directory in one pool from traversing a
  // symlinked ancestor in another pool and moving bytes outside its build context.
  const indexes = await Promise.all(poolContexts.map((context) => regularFiles(context)));
  const relatives = [...indexes[0]!.keys()].sort();
  const sharedFiles: SharedFile[] = [];
  const emptiedDirectories = poolContexts.map(() => new Set<string>());
  let nextIndex = 0;
  let activeDigests = 0;
  const digestWaiters: Array<() => void> = [];
  const boundedDigest = async (file: string): Promise<string> => {
    while (activeDigests >= MAX_CONCURRENT_DIGESTS) {
      await new Promise<void>((resolve) => digestWaiters.push(resolve));
    }
    activeDigests++;
    try {
      return await fileDigest(file);
    } finally {
      activeDigests--;
      digestWaiters.shift()?.();
    }
  };
  const inspect = async (): Promise<void> => {
    while (nextIndex < relatives.length) {
      const relative = relatives[nextIndex++]!;
      const candidates = indexes.map((index) => index.get(relative));
      if (candidates.some((candidate) => candidate === undefined)) continue;
      const complete = candidates as IndexedFile[];
      const first = complete[0]!;
      if (
        complete.some((candidate) => candidate.size !== first.size || candidate.mode !== first.mode)
      )
        continue;

      const digests = await Promise.all(
        complete.map((candidate) => boundedDigest(candidate.absolute)),
      );
      if (digests.some((digest) => digest !== digests[0])) continue;
      sharedFiles.push({ relative, candidates: complete });
    }
  };
  // Hashing is read-only and independent by path. The path workers remove most of the serial
  // I/O tax; boundedDigest caps total open streams even when a build defines many pools.
  await Promise.all(Array.from({ length: Math.min(32, relatives.length) }, async () => inspect()));

  const orderedSharedFiles = sharedFiles.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
  const destinationDirectories = new Set<string>();
  for (const { relative, candidates } of orderedSharedFiles) {
    const first = candidates[0]!;
    const dependency = dependencyLayerPath(relative);
    const fetchCache = fetchCacheLayerPath(relative);
    const layer = dependency ? "dependencies" : fetchCache ? "fetch-cache" : "content";
    const destination = path.join(baseContext, layer, relative);
    destinationDirectories.add(path.dirname(destination));
    for (const [index] of candidates.entries()) {
      for (const directory of parentDirectories(relative)) {
        emptiedDirectories[index]!.add(directory);
      }
    }

    result.sharedFiles++;
    result.sharedBytes += first.size;
    if (dependency) {
      result.dependencyFiles++;
      result.dependencyBytes += first.size;
    } else if (fetchCache) {
      result.fetchCacheFiles++;
      result.fetchCacheBytes += first.size;
    } else {
      result.contentFiles++;
      result.contentBytes += first.size;
    }
  }

  // A real multi-pool app commonly has tens of thousands of shared files but only a few
  // dozen destination directories. Create each directory once, then move independent paths
  // concurrently. The per-file serial mkdir/rename/unlink loop was the largest remaining
  // factoring cost on the four-pool fixture.
  await runBounded(
    [...destinationDirectories].sort(),
    MAX_CONCURRENT_MUTATIONS,
    async (directory) => {
      await mkdir(directory, { recursive: true });
    },
  );
  const mutationLimit = Math.max(
    1,
    Math.min(MAX_CONCURRENT_MUTATIONS, Math.floor(64 / poolContexts.length)),
  );
  await runBounded(orderedSharedFiles, mutationLimit, async ({ relative, candidates }) => {
    const dependency = dependencyLayerPath(relative);
    const fetchCache = fetchCacheLayerPath(relative);
    const layer = dependency ? "dependencies" : fetchCache ? "fetch-cache" : "content";
    const destination = path.join(baseContext, layer, relative);
    await rename(candidates[0]!.absolute, destination);
    const unlinks = await Promise.allSettled(
      candidates.slice(1).map((candidate) => unlink(candidate.absolute)),
    );
    const failure = unlinks.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failure) throw failure.reason;
  });

  await Promise.all(
    poolContexts.map((context, index) =>
      removeEmptiedDirectories(context, emptiedDirectories[index]!),
    ),
  );
  return result;
}
