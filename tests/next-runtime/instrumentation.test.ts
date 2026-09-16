import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerInstrumentationHook } from "../../src/next-runtime/instrumentation.js";

describe("registerInstrumentationHook", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function appDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adapter-instrumentation-"));
    dirs.push(dir);
    return dir;
  }

  it("does not resolve the Next registrar when the app has no instrumentation hook", async () => {
    const dir = appDir();
    await expect(registerInstrumentationHook(dir, ".next")).resolves.toBe("absent");
  });

  it("awaits the app-local Next registrar before reporting ready", async () => {
    const dir = appDir();
    mkdirSync(path.join(dir, ".next", "server"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "next", "dist", "server", "lib", "router-utils"), {
      recursive: true,
    });
    writeFileSync(
      path.join(dir, ".next", "server", "instrumentation.js"),
      "module.exports = {};\n",
    );
    const marker = path.join(dir, "registered");
    writeFileSync(
      path.join(
        dir,
        "node_modules",
        "next",
        "dist",
        "server",
        "lib",
        "router-utils",
        "instrumentation-globals.external.js",
      ),
      `exports.ensureInstrumentationRegistered = async () => {\n` +
        `  await new Promise((resolve) => setTimeout(resolve, 10));\n` +
        `  require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ready");\n` +
        `};\n`,
    );

    await expect(registerInstrumentationHook(dir, ".next")).resolves.toBe("ok");
    expect(() => writeFileSync(marker, "already-ready", { flag: "wx" })).toThrow();
  });

  it("reports a throwing registrar as failed without throwing through startup", async () => {
    const dir = appDir();
    mkdirSync(path.join(dir, ".next", "server"), { recursive: true });
    mkdirSync(path.join(dir, "node_modules", "next", "dist", "server", "lib", "router-utils"), {
      recursive: true,
    });
    writeFileSync(
      path.join(dir, ".next", "server", "instrumentation.js"),
      "module.exports = {};\n",
    );
    writeFileSync(
      path.join(
        dir,
        "node_modules",
        "next",
        "dist",
        "server",
        "lib",
        "router-utils",
        "instrumentation-globals.external.js",
      ),
      `exports.ensureInstrumentationRegistered = async () => { throw new Error("boom"); };\n`,
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(registerInstrumentationHook(dir, ".next")).resolves.toBe("failed");
  });
});
