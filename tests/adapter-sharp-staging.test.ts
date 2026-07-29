// Canary.97 catch-up ② — sharp 0.34.5→0.35.3 upstream bump 503'd every /_next/image.
// Root cause was structural: `pool-server.cjs` INLINED the adapter repo's sharp JS
// (whatever version was present at pack time) while staging shipped the APP's @img native
// binaries — a cross-version JS/binding pair that fails to load. The fix must make skew
// impossible: sharp is external in the pool bundle and the APP's OWN sharp JS package
// (plus its runtime dep tree) is staged next to the @img binaries it was installed with.
// Additionally sharp@0.35 gained an exports map WITHOUT a "./package" subpath, which the
// old `${dep}/package` resolution choked on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSharpDepDir, stageSharpRuntimePackages } from "../src/adapter.js";

let projectDir: string;

function writePkg(dir: string, pkg: Record<string, unknown>, extraFiles: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(extraFiles)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

beforeAll(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "sharp-staging-"));
  writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "app" }));
  const nm = path.join(projectDir, "node_modules");
  // sharp@0.35 shape: exports map with NO "./package" and NO "./package.json" subpath.
  writePkg(
    path.join(nm, "sharp"),
    {
      name: "sharp",
      version: "0.35.3",
      exports: { ".": { require: { default: "./dist/index.cjs" } } },
      dependencies: { "detect-libc": "^2.0.0", "@img/colour": "^1.1.0" },
      optionalDependencies: { "@img/sharp-linux-x64": "0.35.3" },
    },
    { "dist/index.cjs": "module.exports = () => {};" },
  );
  writePkg(path.join(nm, "detect-libc"), {
    name: "detect-libc",
    version: "2.1.0",
    main: "lib/detect-libc.js",
  }, { "lib/detect-libc.js": "module.exports = {};" });
  writePkg(path.join(nm, "@img", "colour"), {
    name: "@img/colour",
    version: "1.1.0",
    main: "index.js",
  }, { "index.js": "module.exports = {};" });
  // @img platform packages: 0.35 shape still exports "./package".
  for (const p of ["sharp-linux-x64", "sharp-libvips-linux-x64"]) {
    writePkg(path.join(nm, "@img", p), {
      name: `@img/${p}`,
      version: "0.35.3",
      exports: { "./package": "./package.json" },
    });
  }
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe("sharp staging survives the 0.35 package shape (survey: canary.97 image cluster)", () => {
  it("resolveSharpDepDir resolves a sharp whose exports map has no ./package subpath", () => {
    const dir = resolveSharpDepDir("sharp", projectDir);
    expect(dir).toBe(path.join(projectDir, "node_modules", "sharp"));
  });

  it("stages the app's sharp JS package AND its runtime dep tree alongside the @img binaries", async () => {
    const result = await stageSharpRuntimePackages(projectDir, "ssr");
    expect(result.staged).toBe(true);
    const staged = (rel: string) =>
      existsSync(path.join(projectDir, ".k8s-adapter", "output", "pools", "ssr", "context", rel));
    // The version-skew killer: the app's OWN sharp JS ships with the binaries it was
    // installed against (pool-server.cjs no longer inlines a pack-time copy).
    expect(staged("node_modules/sharp/package.json")).toBe(true);
    expect(staged("node_modules/sharp/dist/index.cjs")).toBe(true);
    expect(staged("node_modules/detect-libc/package.json")).toBe(true);
    expect(staged("node_modules/@img/colour/package.json")).toBe(true);
    expect(staged("node_modules/@img/sharp-linux-x64/package.json")).toBe(true);
    expect(staged("node_modules/@img/sharp-libvips-linux-x64/package.json")).toBe(true);
  });

  it("the pool bundle build marks sharp external (no pack-time JS inlining)", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:pool-server"]).toContain("--external:sharp");
  });
});
