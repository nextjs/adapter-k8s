// The emptyDir mounted at /app/.next/cache shadows anything the image ships there
// (measured 2026-08-04: image had the fetch-cache, the pod showed an empty dir), so the
// image stages the build's fetch-cache at .k8s-adapter/fetch-cache-seed and the pool
// restores it into the writable runtime location at boot.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { restoreFetchCacheSeed } from "../../src/pool-server/fetch-cache-seed.js";

let appRoot: string;

beforeEach(() => {
  appRoot = mkdtempSync(path.join(os.tmpdir(), "fetch-cache-seed-"));
});
afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const abs = path.join(appRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};

describe("restoreFetchCacheSeed", () => {
  it("copies staged seed entries into the runtime fetch-cache location", () => {
    write(".k8s-adapter/fetch-cache-seed/abc123", "entry-bytes");
    restoreFetchCacheSeed(appRoot);
    expect(readFileSync(path.join(appRoot, ".next/cache/fetch-cache/abc123"), "utf-8")).toBe(
      "entry-bytes",
    );
  });

  it("never clobbers a runtime write — the pod's copy is fresher than the build's", () => {
    write(".k8s-adapter/fetch-cache-seed/abc123", "build-era");
    write(".next/cache/fetch-cache/abc123", "runtime-era");
    restoreFetchCacheSeed(appRoot);
    expect(readFileSync(path.join(appRoot, ".next/cache/fetch-cache/abc123"), "utf-8")).toBe(
      "runtime-era",
    );
  });

  it("restores into a custom distDir", () => {
    write(".k8s-adapter/fetch-cache-seed/abc123", "entry-bytes");
    restoreFetchCacheSeed(appRoot, path.join(appRoot, "build"));
    expect(readFileSync(path.join(appRoot, "build/cache/fetch-cache/abc123"), "utf-8")).toBe(
      "entry-bytes",
    );
  });

  it("no-ops without a staged seed", () => {
    restoreFetchCacheSeed(appRoot);
    expect(existsSync(path.join(appRoot, ".next/cache"))).toBe(false);
  });
});
