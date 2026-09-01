import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneNextRuntimePackage, pruneRuntimeSourceMaps } from "../src/runtime-image-prune.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Next runtime image pruning", () => {
  it("removes build-only metadata without touching runtime files or licenses", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "adapter-k8s-next-runtime-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "dist", "server"), { recursive: true });
    await mkdir(path.join(root, "dist", "docs"), { recursive: true });
    await writeFile(path.join(root, "dist", "server", "runtime.js"), "module.exports = 1;");
    await writeFile(path.join(root, "dist", "server", "runtime.js.map"), "source map");
    await writeFile(
      path.join(root, "dist", "server", "runtime.d.ts"),
      "export declare const x: 1;",
    );
    await writeFile(path.join(root, "dist", "docs", "architecture.md"), "docs");
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "license.md"), "license");

    const result = await pruneNextRuntimePackage(root);

    expect(result).toEqual({ files: 3, bytes: 40 });
    await expect(readFile(path.join(root, "dist", "server", "runtime.js"), "utf8")).resolves.toBe(
      "module.exports = 1;",
    );
    await expect(readFile(path.join(root, "package.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(path.join(root, "license.md"), "utf8")).resolves.toBe("license");
    await expect(readFile(path.join(root, "dist", "server", "runtime.js.map"))).rejects.toThrow();
    await expect(readFile(path.join(root, "dist", "server", "runtime.d.ts"))).rejects.toThrow();
    await expect(readFile(path.join(root, "dist", "docs", "architecture.md"))).rejects.toThrow();
  });

  it("retains Next source maps when runtime symbolication is requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "adapter-k8s-next-runtime-maps-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "dist", "server"), { recursive: true });
    await writeFile(path.join(root, "dist", "server", "runtime.js.map"), "source map");
    await writeFile(path.join(root, "dist", "server", "runtime.d.ts"), "declaration");

    const result = await pruneNextRuntimePackage(root, { keepSourceMaps: true });

    expect(result).toEqual({ files: 1, bytes: 11 });
    await expect(
      readFile(path.join(root, "dist", "server", "runtime.js.map"), "utf8"),
    ).resolves.toBe("source map");
    await expect(readFile(path.join(root, "dist", "server", "runtime.d.ts"))).rejects.toThrow();
  });

  it("drops server source maps while preserving executable chunks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "adapter-k8s-server-runtime-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "chunks"), { recursive: true });
    await writeFile(path.join(root, "middleware.js"), "module.exports = {};");
    await writeFile(path.join(root, "middleware.js.map"), "middleware map");
    await writeFile(path.join(root, "chunks", "route.js"), "module.exports = 1;");
    await writeFile(path.join(root, "chunks", "route.js.map"), "route map");
    await writeFile(path.join(root, "chunks", "route.d.ts"), "runtime-adjacent declaration");

    const result = await pruneRuntimeSourceMaps(root);

    expect(result).toEqual({ files: 2, bytes: 23 });
    await expect(readFile(path.join(root, "middleware.js"), "utf8")).resolves.toContain(
      "module.exports",
    );
    await expect(readFile(path.join(root, "chunks", "route.js"), "utf8")).resolves.toContain(
      "module.exports",
    );
    await expect(readFile(path.join(root, "chunks", "route.d.ts"), "utf8")).resolves.toBe(
      "runtime-adjacent declaration",
    );
    await expect(readFile(path.join(root, "middleware.js.map"))).rejects.toThrow();
    await expect(readFile(path.join(root, "chunks", "route.js.map"))).rejects.toThrow();
  });
});
