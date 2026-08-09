import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { factorSharedPoolFiles } from "../src/pool-image-layout.js";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "pool-image-layout-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, contents: string, mode?: number): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
  if (mode !== undefined) chmodSync(file, mode);
}

type FileSnapshot = { contents: string; mode: number; uid: number; gid: number };

function snapshot(root: string, relative = ""): Map<string, FileSnapshot> {
  const files = new Map<string, FileSnapshot>();
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      for (const [name, value] of snapshot(root, child)) files.set(name, value);
    } else if (entry.isFile()) {
      const info = lstatSync(path.join(root, child));
      files.set(child, {
        contents: readFileSync(path.join(root, child), "utf8"),
        mode: info.mode,
        uid: info.uid,
        gid: info.gid,
      });
    }
  }
  return files;
}

function mergedSnapshot(base: string, delta: string): Map<string, FileSnapshot> {
  const merged = new Map<string, FileSnapshot>();
  for (const layer of ["dependencies", "content", "fetch-cache"]) {
    for (const [name, value] of snapshot(path.join(base, layer))) merged.set(name, value);
  }
  for (const [name, value] of snapshot(delta)) merged.set(name, value);
  return merged;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("factorSharedPoolFiles", () => {
  it("moves only byte-and-mode-identical files shared by every pool", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");

    for (const pool of [web, api]) {
      write(pool, "node_modules/next/package.json", "same dependency");
      write(pool, ".next/server/chunks/common.js", "same content");
      write(pool, "config/routing-manifest.json", "same config");
    }
    write(web, "config/pool-manifest-web.json", "web only");
    write(api, "config/pool-manifest-api.json", "api only");
    write(web, ".next/server/app/page.js", "web handler");
    write(api, ".next/server/app/page.js", "api handler");
    write(web, "bin/tool", "same bytes", 0o755);
    write(api, "bin/tool", "same bytes", 0o644);

    const result = await factorSharedPoolFiles([web, api], base);

    expect(result).toEqual({
      sharedFiles: 3,
      sharedBytes:
        Buffer.byteLength("same dependency") +
        Buffer.byteLength("same content") +
        Buffer.byteLength("same config"),
      dependencyFiles: 1,
      dependencyBytes: Buffer.byteLength("same dependency"),
      contentFiles: 2,
      contentBytes: Buffer.byteLength("same content") + Buffer.byteLength("same config"),
      fetchCacheFiles: 0,
      fetchCacheBytes: 0,
    });
    expect(
      readFileSync(path.join(base, "dependencies/node_modules/next/package.json"), "utf8"),
    ).toBe("same dependency");
    expect(readFileSync(path.join(base, "content/.next/server/chunks/common.js"), "utf8")).toBe(
      "same content",
    );
    expect(readFileSync(path.join(base, "content/config/routing-manifest.json"), "utf8")).toBe(
      "same config",
    );
    for (const pool of [web, api]) {
      expect(existsSync(path.join(pool, "node_modules/next/package.json"))).toBe(false);
      expect(existsSync(path.join(pool, ".next/server/chunks/common.js"))).toBe(false);
      expect(existsSync(path.join(pool, "config/routing-manifest.json"))).toBe(false);
      expect(existsSync(path.join(pool, "bin/tool"))).toBe(true);
    }
    expect(readFileSync(path.join(web, ".next/server/app/page.js"), "utf8")).toBe("web handler");
    expect(readFileSync(path.join(api, ".next/server/app/page.js"), "utf8")).toBe("api handler");
  });

  it("replaces stale base output before factoring a rebuild", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    write(base, "content/stale.js", "old");
    write(web, "fresh.js", "new");
    write(api, "fresh.js", "new");

    await factorSharedPoolFiles([web, api], base);

    expect(existsSync(path.join(base, "content/stale.js"))).toBe(false);
    expect(readFileSync(path.join(base, "content/fresh.js"), "utf8")).toBe("new");
  });

  it("keeps the deploy-time fetch-cache seed in a separate final layer", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    for (const pool of [web, api]) {
      write(pool, ".k8s-adapter/fetch-cache-seed/key", "seed");
      write(pool, "pool-server.cjs", "runtime");
    }

    const result = await factorSharedPoolFiles([web, api], base);

    expect(result.fetchCacheFiles).toBe(1);
    expect(result.fetchCacheBytes).toBe(4);
    expect(
      readFileSync(path.join(base, "fetch-cache/.k8s-adapter/fetch-cache-seed/key"), "utf8"),
    ).toBe("seed");
  });

  it("preserves each pool's merged paths, bytes, modes, and ownership", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    for (const pool of [web, api]) {
      write(pool, "node_modules/next/index.js", "runtime", 0o755);
      write(pool, ".next/server/chunks/common.js", "chunk");
      write(pool, ".k8s-adapter/fetch-cache-seed/key", "seed");
    }
    write(web, ".next/server/app/page.js", "web");
    write(api, ".next/server/app/route.js", "api");
    const before = [snapshot(web), snapshot(api)];

    await factorSharedPoolFiles([web, api], base);

    expect(mergedSnapshot(base, web)).toEqual(before[0]);
    expect(mergedSnapshot(base, api)).toEqual(before[1]);
  });

  it("leaves symlinks and everything below symlinked ancestors in the pool delta", async () => {
    const root = tempDir();
    const target = path.join(root, "target");
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    write(target, "nested/file.js", "outside");
    mkdirSync(web, { recursive: true });
    mkdirSync(api, { recursive: true });
    symlinkSync(target, path.join(web, "linked"));
    symlinkSync(target, path.join(api, "linked"));
    write(web, "common.js", "shared");
    write(api, "common.js", "shared");

    await factorSharedPoolFiles([web, api], base);

    expect(lstatSync(path.join(web, "linked")).isSymbolicLink()).toBe(true);
    expect(lstatSync(path.join(api, "linked")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(base, "content/linked"))).toBe(false);
  });

  it("does not traverse a symlinked ancestor present in only one pool", async () => {
    const root = tempDir();
    const target = path.join(root, "target");
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    write(target, "file.js", "same bytes");
    write(web, "linked/file.js", "same bytes");
    mkdirSync(api, { recursive: true });
    symlinkSync(target, path.join(api, "linked"));

    await factorSharedPoolFiles([web, api], base);

    expect(readFileSync(path.join(web, "linked/file.js"), "utf8")).toBe("same bytes");
    expect(readFileSync(path.join(target, "file.js"), "utf8")).toBe("same bytes");
    expect(existsSync(path.join(base, "content/linked/file.js"))).toBe(false);
  });

  it("supports an empty pool delta and leaves a single pool on the legacy layout", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    write(web, "same.js", "shared");
    write(api, "same.js", "shared");
    await factorSharedPoolFiles([web, api], base);
    expect(readdirSync(web)).toEqual([]);
    expect(readdirSync(api)).toEqual([]);

    const only = path.join(root, "only");
    write(only, "untouched.js", "one pool");
    await expect(factorSharedPoolFiles([only], path.join(root, "unused"))).rejects.toThrow(
      /at least two/,
    );
    expect(readFileSync(path.join(only, "untouched.js"), "utf8")).toBe("one pool");
  });

  it("preserves empty directories that existed before factoring", async () => {
    const root = tempDir();
    const web = path.join(root, "web");
    const api = path.join(root, "api");
    const base = path.join(root, "base");
    for (const pool of [web, api]) {
      write(pool, "nested/common.js", "shared");
      mkdirSync(path.join(pool, "keep-empty"), { recursive: true });
    }

    await factorSharedPoolFiles([web, api], base);

    expect(existsSync(path.join(web, "nested"))).toBe(false);
    expect(existsSync(path.join(api, "nested"))).toBe(false);
    expect(existsSync(path.join(web, "keep-empty"))).toBe(true);
    expect(existsSync(path.join(api, "keep-empty"))).toBe(true);
  });
});
