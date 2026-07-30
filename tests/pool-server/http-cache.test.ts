import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __etagHashStatsForTests,
  __resetEtagCacheForTests,
  ifNoneMatchMatches,
  staticAssetEtag,
  staticAssetEtagForFileAsync,
} from "../../src/pool-server/http-cache.js";

let tempDir: string | undefined;
afterEach(() => {
  __resetEtagCacheForTests();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("static asset HTTP validators", () => {
  it("uses stable content identity rather than replica-local file metadata", () => {
    expect(staticAssetEtag(Buffer.from("same bytes"))).toBe(
      staticAssetEtag(Buffer.from("same bytes")),
    );
    expect(staticAssetEtag(Buffer.from("same bytes"))).not.toBe(
      staticAssetEtag(Buffer.from("different bytes")),
    );
  });

  it("accepts weak, list, and wildcard If-None-Match validators", () => {
    const etag = staticAssetEtag(Buffer.from("worker"));
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
    expect(ifNoneMatchMatches(`"other", W/${etag}`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches('"other"', etag)).toBe(false);
  });
});

describe("staticAssetEtagForFileAsync", () => {
  it("computes the same strong validator through a bounded file stream", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "stream-etag-"));
    const filePath = path.join(tempDir, "asset.bin");
    const content = Buffer.alloc(1024 * 1024 + 1, 0x5a);
    writeFileSync(filePath, content);
    const stat = statSync(filePath);
    await expect(staticAssetEtagForFileAsync(filePath, stat)).resolves.toBe(
      staticAssetEtag(content),
    );
    // A second call is served from the stable per-file cache.
    await expect(staticAssetEtagForFileAsync(filePath, stat)).resolves.toBe(
      staticAssetEtag(content),
    );
  });

  it("bounds concurrent distinct cold hashes and sheds excess validator work", async () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "stream-etag-fanout-"));
    const { maxActive, maxPending } = __etagHashStatsForTests();
    const calls = Array.from({ length: maxPending + 1 }, (_, index) => {
      const filePath = path.join(tempDir!, `asset-${index}.bin`);
      writeFileSync(filePath, String(index));
      return staticAssetEtagForFileAsync(filePath, statSync(filePath));
    });
    const during = __etagHashStatsForTests();
    expect(during.active).toBe(maxActive);
    expect(during.pending).toBe(maxPending);
    expect(during.queued).toBe(maxPending - maxActive);

    const results = await Promise.all(calls);
    expect(results.filter((etag) => etag === null)).toHaveLength(1);
    expect(results.filter((etag) => etag !== null)).toHaveLength(maxPending);
    expect(__etagHashStatsForTests()).toMatchObject({ active: 0, queued: 0, pending: 0 });
  });
});
