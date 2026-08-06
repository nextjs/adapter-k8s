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
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stageFile,
  stagingFailures,
  assertNoStagingFailures,
  resolveAndCopyExternals,
  assetDestPath,
  hasEdgeMiddleware,
  stagedPaths,
  stageSharpRuntimePackages,
  SHARP_RUNTIME_PACKAGES,
  resolveSharpDepDir,
  prerenderSiblingFiles,
} from "../src/adapter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-staging-"));
  stagedPaths.clear();
  stagingFailures.length = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  stagedPaths.clear();
  stagingFailures.length = 0;
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

  // N50 (review #9, both outcomes reproduced against the unfixed code):
  //   (a) `assetDestPath` returned Next's `../`-prefixed traced-asset key verbatim, so the
  //       file landed OUTSIDE `context/` and `COPY context/ .` never picked it up — a
  //       silently missing runtime dependency (the sharp-incident shape);
  //   (b) with enough `../` segments, `cp` OVERWROTE A REPO FILE. Measured on the unfixed
  //       code: stageFile(projectDir, evil, "../../../../../../package.json") replaced
  //       <tmp>/package.json with the source's contents.
  // Next keys traced assets as `path.relative(repoRoot, file)`, so ANY traced file above the
  // lockfile-detected root produces such a key: a file:/link: dependency, a linked next
  // checkout, a pnpm store outside the tree, or a narrow outputFileTracingRoot.
  describe("containment (N50)", () => {
    it("throws instead of staging outside the build context", async () => {
      const src = write("dep.js", "OUTSIDE");
      await expect(stageFile(tmpDir, src, "../escaped.js", "ssr")).rejects.toThrow(
        /Refusing to stage outside the Docker build context/,
      );
      expect(existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/escaped.js"))).toBe(false);
    });

    it("cannot overwrite a file in the repository, however many ../ segments", async () => {
      const victim = write("package.json", '{"real":true}');
      const evil = write("evil.json", '{"OVERWRITTEN":true}');
      // 6 segments up from <tmp>/.k8s-adapter/output/pools/ssr/context lands on <tmp>.
      await expect(
        stageFile(tmpDir, evil, "../../../../../../package.json", "ssr"),
      ).rejects.toThrow(/Refusing to stage outside/);
      expect(readFileSync(victim, "utf-8")).toBe('{"real":true}');
    });

    it("neutralizes an absolute-looking destination (path.join keeps it relative)", async () => {
      // path.join (unlike path.resolve) treats a leading "/" as just another separator, so
      // this cannot escape — pin that, so a future switch to path.resolve is caught here.
      const src = write("dep.js", "x");
      await stageFile(tmpDir, src, "/etc/whatever.js", "ssr");
      expect(
        existsSync(path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/etc/whatever.js")),
      ).toBe(true);
      expect(existsSync("/etc/whatever.js")).toBe(false);
    });
  });

  // N50 (review, Medium): a copy failure was a console.warn and the dest was recorded as
  // staged BEFORE the copy, so (1) the build stayed green while the image lost a handler and
  // (2) a later call for the same dest from a different source was skipped as "already done".
  describe("copy-failure handling (N50)", () => {
    it("collects the failure, leaves the dest unmarked, and throws at the end of the build", async () => {
      const src = write("handler.js", "v1");
      // Make the destination path a DIRECTORY so copyFile fails with EISDIR.
      const dest = path.join(tmpDir, ".k8s-adapter/output/pools/ssr/context/handler.js");
      mkdirSync(dest, { recursive: true });

      await stageFile(tmpDir, src, "handler.js", "ssr");
      expect(stagingFailures).toHaveLength(1);
      expect(stagingFailures[0]!.dest).toBe("handler.js");
      // NOT marked as staged — a later call with a working source must still be attempted.
      expect(stagedPaths.has(dest)).toBe(false);

      expect(() => assertNoStagingFailures()).toThrow(/could not be staged/);
      // The queue is cleared for the next build.
      expect(stagingFailures).toHaveLength(0);
      expect(() => assertNoStagingFailures()).not.toThrow();
    });
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

describe("prerenderSiblingFiles", () => {
  // The fs-mirror seed (build-seed-index.ts) reads `<key>.meta` next to a prerendered
  // document — postponed state and segmentPaths live there. The staging loop copies
  // exactly the static-assets manifest's filePaths, and `.meta` is never a manifest
  // asset, so pool images shipped `.html` + `.segments` with ZERO `.meta` files and
  // every PPR fs-mirror seed silently missed in containers (measured: resume-data-cache
  // pods, `ls /app/.next/server/app/*.meta` → none) while local runs worked.
  it("returns the .meta sibling for an app-dir html prerender", () => {
    expect(
      prerenderSiblingFiles({ filePath: ".next/server/app/index.html", prerender: true }),
    ).toEqual([".next/server/app/index.meta"]);
    expect(
      prerenderSiblingFiles({
        filePath: ".next/server/pages/blog/post.html",
        prerender: true,
      }),
    ).toEqual([".next/server/pages/blog/post.meta"]);
  });

  it("returns nothing for non-prerenders, non-html assets, and public files", () => {
    expect(
      prerenderSiblingFiles({ filePath: ".next/server/app/index.html", prerender: false }),
    ).toEqual([]);
    expect(
      prerenderSiblingFiles({ filePath: ".next/server/app/index.rsc", prerender: true }),
    ).toEqual([]);
    expect(prerenderSiblingFiles({ filePath: "public/logo.svg", prerender: true })).toEqual([]);
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

  // N50 (review, Medium): a dangling symlink made `await realpath(entry)` REJECT, so the
  // build died with a bare `ENOENT: no such file or directory, realpath '...'` and no
  // attribution — and the `existsSync(realTarget)` guard written to handle exactly this was
  // unreachable dead code. Now it fails with the entry and the likely cause.
  it("fails with an actionable message on a dangling symlink (N50)", async () => {
    const src = path.join(tmpDir, ".next/node_modules");
    mkdirSync(src, { recursive: true });
    symlinkSync(path.join(tmpDir, "node_modules/removed-pkg"), path.join(src, "removed-pkg"));
    await expect(
      resolveAndCopyExternals(src, path.join(tmpDir, "staged/node_modules")),
    ).rejects.toThrow(/Dangling symlink in the Turbopack externals directory.*removed-pkg/s);
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

  // N50 (review #9): an asset ABOVE the tracing root used to be returned verbatim, i.e. a
  // `../`-prefixed destination. It is now rebased so it always stays inside the context.
  describe("outside-root assets are rebased into the context (N50)", () => {
    it("re-roots anything under a node_modules segment so Node can still resolve it", () => {
      expect(
        assetDestPath(
          "/repo/app",
          "../../pnpm-store/v3/node_modules/foo/index.js",
          "/pnpm-store/v3/node_modules/foo/index.js",
        ),
      ).toBe("node_modules/foo/index.js");
      // The LAST node_modules wins (nested deps keep their nesting).
      expect(
        assetDestPath(
          "/repo/app",
          "../node_modules/a/node_modules/b/index.js",
          "/repo/node_modules/a/node_modules/b/index.js",
        ),
      ).toBe("node_modules/b/index.js");
    });

    it("flattens a non-node_modules outside-root asset under .adapter-k8s-external/", () => {
      const dest = assetDestPath("/repo/app", "../shared/data.json", "/repo/shared/data.json");
      expect(dest).toBe(path.join(".adapter-k8s-external", "shared", "data.json"));
      expect(dest.startsWith("..")).toBe(false);
    });

    it("never returns a path that escapes the context", () => {
      for (const key of ["../x.js", "../../../../x.js", "..", "../node_modules/p/x.js"]) {
        const dest = assetDestPath("/repo/app", key, path.resolve("/repo/app", key));
        expect(path.normalize(dest).startsWith("..")).toBe(false);
        expect(path.isAbsolute(dest)).toBe(false);
      }
    });
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

  // N50 (review #34): detection was filename-only, but Next 16 decides by the declared
  // runtime — `hasNodeMiddleware = staticInfo.runtime === "nodejs" || isProxyFile(page)`
  // (build/index.ts). A `middleware.ts` with `export const runtime = "nodejs"` is NODE
  // middleware: there is no edge bundle to poison, so the Valkey incremental cacheHandler
  // must still be registered. It was not — ISR/PPR-shell revalidation silently stopped being
  // cross-replica while build-metadata still said cacheEnabled: true.
  describe("node-runtime middleware is not edge middleware (N50)", () => {
    it('returns false for middleware.ts declaring runtime = "nodejs"', () => {
      write("middleware.ts", 'export const runtime = "nodejs";\nexport default function () {}\n');
      expect(hasEdgeMiddleware(tmpDir)).toBe(false);
    });

    it("accepts single quotes, let/var, and a type annotation", () => {
      for (const decl of [
        "export const runtime = 'nodejs'",
        'export let runtime = "nodejs"',
        'export const runtime: "nodejs" = "nodejs"',
      ]) {
        rmSync(path.join(tmpDir, "middleware.ts"), { force: true });
        write("middleware.ts", `${decl};\n`);
        expect(hasEdgeMiddleware(tmpDir), decl).toBe(false);
      }
    });

    it("still reports edge for an explicit edge runtime or no declaration at all", () => {
      write("middleware.ts", 'export const runtime = "edge";\n');
      expect(hasEdgeMiddleware(tmpDir)).toBe(true);
      rmSync(path.join(tmpDir, "middleware.ts"), { force: true });
      write("middleware.ts", "export default function () {}\n");
      expect(hasEdgeMiddleware(tmpDir)).toBe(true);
    });

    it("checks src/middleware.* too", () => {
      write("src/middleware.js", 'export const runtime = "nodejs";\n');
      expect(hasEdgeMiddleware(tmpDir)).toBe(false);
    });
  });

  // N50 follow-up: the runtime scan ran over RAW source, so a COMMENTED-OUT or QUOTED declaration
  // read as active. The consequence runs the unsafe way: default-EDGE middleware reported as Node
  // lets the Node Valkey cacheHandler (node:net/node:tls RESP client) into the edge bundle, where
  // it cannot resolve. Comments and literal contents must be excluded from the scan, and the
  // exclusion itself must not be foolable (a `//` inside a string, a `/*` inside a template).
  describe("comments and string contents are not live code (N50 follow-up)", () => {
    const edgeCases: [name: string, source: string, edge: boolean][] = [
      ["an active declaration", 'export const runtime = "nodejs";\n', false],
      ["a //-commented declaration", '// export const runtime = "nodejs";\n', true],
      ["an indented //-commented declaration", '  //export const runtime = "nodejs"\n', true],
      ["a /* */-commented declaration", '/* export const runtime = "nodejs"; */\n', true],
      [
        "a multi-line /* */ block",
        '/*\n * export const runtime = "nodejs";\n */\nexport default function () {}\n',
        true,
      ],
      [
        "a declaration inside a string literal",
        `const doc = 'export const runtime = "nodejs"';\nexport default function () {}\n`,
        true,
      ],
      [
        "a declaration inside a template literal",
        'const doc = `export const runtime = "nodejs"`;\nexport default function () {}\n',
        true,
      ],
      [
        "a declaration inside a template literal with a substitution",
        "const doc = `export const runtime = ${JSON.stringify(x)}`;\nexport default function () {}\n",
        true,
      ],
      // The stripper must not be foolable by the reverse trick either.
      [
        "a `//` that is only string CONTENT, not a comment",
        'const u = "https://example.com";\nexport const runtime = "nodejs";\n',
        false,
      ],
      [
        "a `/*` that is only template CONTENT, not a comment",
        'const glob = `/*.js`;\nexport const runtime = "nodejs";\n',
        false,
      ],
      [
        "an apostrophe inside a // comment",
        '// don\'t treat this as a string\nexport const runtime = "nodejs";\n',
        false,
      ],
      [
        "a quote inside a regex literal",
        'const q = /["\']/;\nexport const runtime = "nodejs";\n',
        false,
      ],
      [
        "a division operator that is not a regex",
        'const half = 1 / 2, third = (3) / 4;\nexport const runtime = "nodejs";\n',
        false,
      ],
      // The point of the whole finding: a comment ABOUT the declaration must not hide the real one.
      [
        "a genuine declaration after a comment mentioning it",
        '// we set `export const runtime = "edge"` here for the edge bundle... actually:\n' +
          'export const runtime = "nodejs";\nexport default function () {}\n',
        false,
      ],
      [
        "a genuine EDGE declaration after a comment mentioning nodejs",
        '/* runtime = "nodejs" was tried and reverted */\nexport const runtime = "edge";\n',
        true,
      ],
    ];

    for (const [name, source, edge] of edgeCases) {
      it(`${edge ? "reports edge" : "reports node"} for ${name}`, () => {
        rmSync(path.join(tmpDir, "middleware.ts"), { force: true });
        write("middleware.ts", source);
        expect(hasEdgeMiddleware(tmpDir), source).toBe(edge);
      });
    }

    it("is not fooled by source that forges the scanner's internal literal sentinel", () => {
      // The scanner lifts literals out as `\uE000<index>\uE000`; source containing that codepoint
      // must not be able to fabricate one. Here literal #0 IS "nodejs", so an unneutralized
      // sentinel would make this file (which has no resolvable declaration) read as Node.
      const S = "\uE000";
      write("middleware.ts", `const s = "nodejs";\nexport const runtime = ${S}0${S};\n`);
      expect(hasEdgeMiddleware(tmpDir)).toBe(true);
    });
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
    // Canary.97 contract: sharp's own JS package must stage WITH the binaries (the pool
    // bundle marks sharp external), so the resolver must also map "sharp".
    const dirs = new Map([
      ...SHARP_RUNTIME_PACKAGES.map((p) => [p, writePkg(p)] as const),
      ["sharp", writePkg("sharp", "0.35.0")] as const,
    ]);
    const result = await stageSharpRuntimePackages(tmpDir, "ssr", (dep) => dirs.get(dep));
    expect(result).toEqual({ staged: true });
    expect(existsSync(path.join(poolCtx(), "node_modules", "sharp", "package.json"))).toBe(true);
    for (const pkg of SHARP_RUNTIME_PACKAGES) {
      const staged = path.join(poolCtx(), "node_modules", pkg);
      expect(existsSync(path.join(staged, "native.bin"))).toBe(true);
      expect(readFileSync(path.join(staged, "package.json"), "utf-8")).toContain(pkg);
    }
  });

  it("stages the linux-arm64 sharp pair for an arm64 target", async () => {
    const armPackages = ["@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"];
    const dirs = new Map([
      ...armPackages.map((p) => [p, writePkg(p)] as const),
      ["sharp", writePkg("sharp", "0.35.0")] as const,
    ]);
    const result = await stageSharpRuntimePackages(
      tmpDir,
      "ssr",
      (dep) => dirs.get(dep),
      false,
      "linux/arm64",
    );
    expect(result).toEqual({ staged: true });
    for (const pkg of armPackages) {
      expect(existsSync(path.join(poolCtx(), "node_modules", pkg, "package.json"))).toBe(true);
    }
    expect(existsSync(path.join(poolCtx(), "node_modules/@img/sharp-linux-x64"))).toBe(false);
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
    expect(resolveSharpDepDir("@img/sharp-testonly-linux-x64", tmpDir)).toBe(realpathSync(dir));
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
    expect(resolveSharpDepDir("@img/sharp-testonly-sibling", tmpDir)).toBe(realpathSync(dir));
  });

  it("returns undefined for an unresolvable package", () => {
    expect(resolveSharpDepDir("@img/sharp-testonly-absent", tmpDir)).toBeUndefined();
  });
});
