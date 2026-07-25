// tests/adapter-staging.test.ts
//
// Hermetic tests for the adapter's file-staging machinery (adapter.ts) — the
// symlink-dereferencing and monorepo rebasing that make the Docker build
// contexts self-contained. All filesystem work happens in mkdtemp tmp dirs.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  existsSync,
  lstatSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stageFile,
  resolveAndCopyExternals,
  assetDestPath,
  hasEdgeMiddleware,
  stagedPaths,
  stageSharpRuntimePackages,
  SHARP_RUNTIME_PACKAGES,
  resolveSharpDepDir,
} from "../src/adapter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-staging-"));
  stagedPaths.clear();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  stagedPaths.clear();
});

const write = (rel: string, content = "x") => {
  const abs = path.join(tmpDir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
};

describe("stageFile", () => {
  it("copies a file into the pool context at the dest-relative path", async () => {
    const src = write("src/handler.js", "module.exports = 1");
    await stageFile(tmpDir, src, "app/handler.js", "ssr");
    const staged = path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/app/handler.js");
    expect(readFileSync(staged, "utf-8")).toBe("module.exports = 1");
  });

  it("resolves a relative sourcePath against projectDir", async () => {
    write("src/handler.js", "rel");
    await stageFile(tmpDir, "src/handler.js", "handler.js", "ssr");
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/handler.js"))).toBe(
      true,
    );
  });

  it("stages into the shared context when isShared is set", async () => {
    const src = write("src/handler.js");
    await stageFile(tmpDir, src, "handler.js", "ssr", true);
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/shared-context/handler.js"))).toBe(
      true,
    );
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/handler.js"))).toBe(
      false,
    );
  });

  it("copies symlinked content as real files (Docker COPY cannot follow symlinks)", async () => {
    const real = write("real/pkg/index.js", "real content");
    const linkDir = path.join(tmpDir, "links");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(real, path.join(linkDir, "index.js"));
    await stageFile(tmpDir, path.join(linkDir, "index.js"), "pkg/index.js", "ssr");
    const staged = path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/pkg/index.js");
    expect(readFileSync(staged, "utf-8")).toBe("real content");
    expect(lstatSync(staged).isSymbolicLink()).toBe(false);
  });

  it("refuses to stage a destination inside its own source (ERR_FS_CP_EINVAL guard)", async () => {
    // The stage dir lives under projectDir, so staging projectDir itself (or any
    // ancestor of the stage dir) would recursively copy into itself — the guard
    // must make it a silent no-op, not a crash or an infinite copy.
    write("app/file.js");
    await expect(stageFile(tmpDir, tmpDir, "app-copy", "ssr")).resolves.toBeUndefined();
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/app-copy"))).toBe(
      false,
    );
    // A normal directory stage right under projectDir still works.
    await stageFile(tmpDir, path.join(tmpDir, "app"), "app", "ssr");
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/app/file.js"))).toBe(
      true,
    );
  });

  it("silently skips a missing source (traced assets may vanish mid-build)", async () => {
    await expect(
      stageFile(tmpDir, path.join(tmpDir, "does-not-exist.js"), "gone.js", "ssr"),
    ).resolves.toBeUndefined();
    expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/gone.js"))).toBe(
      false,
    );
  });

  it("stages each destination only once per build (stagedPaths dedup)", async () => {
    const src = write("src/handler.js", "v1");
    await stageFile(tmpDir, src, "handler.js", "ssr");
    writeFileSync(src, "v2");
    await stageFile(tmpDir, src, "handler.js", "ssr");
    const staged = path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/handler.js");
    expect(readFileSync(staged, "utf-8")).toBe("v1"); // second call was a no-op
  });
});

describe("resolveAndCopyExternals", () => {
  it("dereferences symlinked packages and preserves real content", async () => {
    // .next/node_modules layout: symlinks to real node_modules packages.
    const realPkg = path.join(tmpDir, "node_modules/some-pkg");
    mkdirSync(realPkg, { recursive: true });
    writeFileSync(path.join(realPkg, "index.js"), "real pkg");
    const src = path.join(tmpDir, ".next/node_modules");
    mkdirSync(src, { recursive: true });
    symlinkSync(realPkg, path.join(src, "some-pkg"));
    // A plain file entry and a scoped dir with a symlink inside.
    writeFileSync(path.join(src, "plain.js"), "plain");
    mkdirSync(path.join(src, "@scope"), { recursive: true });
    const realScoped = path.join(tmpDir, "node_modules/@scope/pkg");
    mkdirSync(realScoped, { recursive: true });
    writeFileSync(path.join(realScoped, "mod.js"), "scoped");
    symlinkSync(realScoped, path.join(src, "@scope/pkg"));

    const dest = path.join(tmpDir, "staged/node_modules");
    await resolveAndCopyExternals(src, dest);

    const pkg = path.join(dest, "some-pkg/index.js");
    expect(readFileSync(pkg, "utf-8")).toBe("real pkg");
    expect(lstatSync(path.join(dest, "some-pkg")).isSymbolicLink()).toBe(false);
    expect(readFileSync(path.join(dest, "plain.js"), "utf-8")).toBe("plain");
    expect(readFileSync(path.join(dest, "@scope/pkg/mod.js"), "utf-8")).toBe("scoped");
  });

  it("is a no-op when the source does not exist", async () => {
    await expect(
      resolveAndCopyExternals(path.join(tmpDir, "nope"), path.join(tmpDir, "dest")),
    ).resolves.toBeUndefined();
    expect(existsSync(path.join(tmpDir, "dest"))).toBe(false);
  });

  it("rebuilds the destination (stale entries from a previous build are removed)", async () => {
    const src = path.join(tmpDir, ".next/node_modules");
    mkdirSync(src, { recursive: true });
    writeFileSync(path.join(src, "current.js"), "current");
    const dest = path.join(tmpDir, "staged");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "stale.js"), "stale");
    await resolveAndCopyExternals(src, dest);
    expect(existsSync(path.join(dest, "stale.js"))).toBe(false);
    expect(existsSync(path.join(dest, "current.js"))).toBe(true);
  });
});

describe("assetDestPath (monorepo rebasing)", () => {
  it("re-bases an asset under projectDir to a projectDir-relative path", () => {
    // Traced-asset keys are repoRoot-relative; an asset that lives under
    // projectDir must be staged relative to projectDir so Node's upward
    // node_modules walk from the entrypoint can reach it.
    expect(
      assetDestPath(
        "/repo/app",
        "node_modules/dep/index.js",
        "/repo/app/node_modules/dep/index.js",
      ),
    ).toBe("node_modules/dep/index.js");
    expect(
      assetDestPath(
        "/repo/app",
        "packages/app/.next/server/page.js",
        "/repo/app/.next/server/page.js",
      ),
    ).toBe(".next/server/page.js");
  });

  it("keeps the repoRoot-relative key for assets hoisted above projectDir", () => {
    // Hoisted deps land at repoRoot/node_modules — already where the upward walk expects.
    expect(
      assetDestPath("/repo/app", "node_modules/dep/index.js", "/repo/node_modules/dep/index.js"),
    ).toBe("node_modules/dep/index.js");
  });

  it("resolves relative absAsset paths against projectDir", () => {
    expect(assetDestPath("/repo/app", "key", ".next/server/chunks/x.js")).toBe(
      ".next/server/chunks/x.js",
    );
  });

  it("is a no-op when repoRoot === projectDir", () => {
    expect(
      assetDestPath(
        "/repo/app",
        "node_modules/dep/index.js",
        "/repo/app/node_modules/dep/index.js",
      ),
    ).toBe("node_modules/dep/index.js");
  });
});

describe("hasEdgeMiddleware", () => {
  it("detects middleware.ts at the project root and under src/", () => {
    write("middleware.ts");
    expect(hasEdgeMiddleware(tmpDir)).toBe(true);
  });

  it("detects middleware.js under src/", () => {
    write("src/middleware.js");
    expect(hasEdgeMiddleware(tmpDir)).toBe(true);
  });

  it("does NOT match proxy.ts (modern Node middleware) or unrelated files", () => {
    write("proxy.ts");
    write("src/proxy.ts");
    write("middleware.config.ts");
    expect(hasEdgeMiddleware(tmpDir)).toBe(false);
  });

  it("returns false when no middleware file exists", () => {
    expect(hasEdgeMiddleware(tmpDir)).toBe(false);
  });
});

// REGRESSION (live build XchOtaGFu6GdF…): pool-server.cjs inlines sharp's JS via
// esbuild, but the native binding is a RUNTIME require of @img/sharp-linux-x64
// (which dlopens libvips from @img/sharp-libvips-linux-x64). Neither was staged
// into the traced-assets context, so the deployed pool had no @img/* at all and
// every containerized /_next/image failed the sharp load (503) — while local runs
// resolved the binding by walking up to the repo's node_modules, masking the gap.
describe("stageSharpRuntimePackages", () => {
  const poolCtx = () => path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context");

  const writePkg = (name: string, version = "0.34.5") => {
    const dir = path.join(tmpDir, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(path.join(dir, "native.bin"), "binary");
    return dir;
  };

  it("stages both linux-x64 packages into the pool context when resolvable", async () => {
    const dirs = new Map(SHARP_RUNTIME_PACKAGES.map((p) => [p, writePkg(p)]));
    const result = await stageSharpRuntimePackages(tmpDir, "ssr", (dep) => dirs.get(dep));
    expect(result).toEqual({ staged: true });
    for (const pkg of SHARP_RUNTIME_PACKAGES) {
      const staged = path.join(poolCtx(), "node_modules", pkg);
      expect(existsSync(path.join(staged, "native.bin"))).toBe(true);
      expect(readFileSync(path.join(staged, "package.json"), "utf-8")).toContain(pkg);
    }
  });

  it("falls back to the app's sharp version when the platform pair is missing (non-linux-x64 build host)", async () => {
    // Only sharp's JS package resolves — npm installed the host platform's @img/*.
    const sharpDir = writePkg("sharp", "0.34.5");
    const result = await stageSharpRuntimePackages(tmpDir, "ssr", (dep) =>
      dep === "sharp" ? sharpDir : undefined,
    );
    expect(result).toEqual({ staged: false, sharpVersion: "0.34.5" });
    expect(existsSync(path.join(poolCtx(), "node_modules", "@img"))).toBe(false);
  });

  it("requires BOTH packages — libvips missing means the binding cannot load", async () => {
    const bindingDir = writePkg("@img/sharp-linux-x64");
    const sharpDir = writePkg("sharp", "0.33.2");
    const result = await stageSharpRuntimePackages(tmpDir, "ssr", (dep) => {
      if (dep === "@img/sharp-linux-x64") return bindingDir;
      if (dep === "sharp") return sharpDir;
      return undefined;
    });
    expect(result).toEqual({ staged: false, sharpVersion: "0.33.2" });
  });

  it("returns staged:false without a version (and does not throw) when sharp is absent entirely", async () => {
    const result = await stageSharpRuntimePackages(tmpDir, "ssr", () => undefined);
    expect(result).toEqual({ staged: false });
  });
});

// The @img/* platform packages BLOCK `require.resolve("<pkg>/package.json")` via their
// exports maps (they export "./package", not "./package.json") — resolveDepDir's shape
// would ERR_PACKAGE_PATH_NOT_EXPORTED and silently skip staging on every build. Fake
// package names are used so the adapter-first resolution root (the real repo
// node_modules) can never satisfy them — keeps these hermetic on any build host.
describe("resolveSharpDepDir", () => {
  it("resolves a package whose exports map only exposes ./package (the @img/* shape)", () => {
    const dir = path.join(tmpDir, "node_modules/@img/sharp-testonly-linux-x64");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@img/sharp-testonly-linux-x64",
        version: "1.0.0",
        exports: { "./sharp.node": "./sharp.node", "./package": "./package.json" },
      }),
    );
    expect(resolveSharpDepDir("@img/sharp-testonly-linux-x64", tmpDir)).toBe(dir);
  });

  it("falls back to the sibling of a resolvable sharp copy when exports block resolution entirely", () => {
    // sharp resolvable from the app root…
    const sharpDir = path.join(tmpDir, "node_modules/sharp");
    mkdirSync(sharpDir, { recursive: true });
    writeFileSync(
      path.join(sharpDir, "package.json"),
      JSON.stringify({ name: "sharp", version: "0.34.5" }),
    );
    // …and a platform sibling whose exports map exposes NOTHING resolvable.
    const dir = path.join(tmpDir, "node_modules/@img/sharp-testonly-sibling");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "@img/sharp-testonly-sibling",
        version: "1.0.0",
        exports: { "./sharp.node": "./sharp.node" },
      }),
    );
    expect(resolveSharpDepDir("@img/sharp-testonly-sibling", tmpDir)).toBe(dir);
  });

  it("returns undefined for an unresolvable package", () => {
    expect(resolveSharpDepDir("@img/sharp-testonly-absent", tmpDir)).toBeUndefined();
  });
});
