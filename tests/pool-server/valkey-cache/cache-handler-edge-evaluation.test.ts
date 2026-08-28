import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import path from "node:path";

describe("published cache handler edge evaluation", () => {
  it("does not require a Node built-in before the EdgeRuntime guard", async () => {
    const result = await build({
      entryPoints: [path.resolve("src/pool-server/valkey-cache/cache-handler-entry.ts")],
      bundle: true,
      format: "cjs",
      platform: "node",
      external: ["next"],
      write: false,
    });
    const code = result.outputFiles[0]!.text;
    const moduleRef: { exports: Record<string, unknown> } = { exports: {} };
    const rejectRequire = vi.fn((id: string) => {
      throw new Error(`edge evaluation attempted require(${id})`);
    });
    const evaluate = new Function("module", "exports", "require", "process", "globalThis", code);

    expect(() =>
      evaluate(moduleRef, moduleRef.exports, rejectRequire, { env: {} }, { EdgeRuntime: "edge" }),
    ).not.toThrow();
    const CacheHandler = moduleRef.exports.default as new (ctx: unknown) => unknown;
    expect(() => new CacheHandler({})).not.toThrow();
    expect(rejectRequire).not.toHaveBeenCalled();
  });
});
