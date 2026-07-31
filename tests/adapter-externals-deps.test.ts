// Turbopack copies resolved EXTERNAL packages into `.next/node_modules` under name-hashed
// dirs (e.g. `require-in-the-middle-45b2f40515652c68`), and staging copies those into the
// image — but the externals still `require()` their OWN dependencies by bare specifier,
// resolved from /app/node_modules. Nothing staged those trees: an app with an
// instrumentation hook shipped require-in-the-middle without `debug`, register() rejected
// at startup, and the pool never went Ready (full-run v4, cache-components-allow-otel-spans
// 4/4 — same class as the @swc/helpers and scheduler bugs, one layer deeper).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageExternalsDependencies, stagedPaths, stagingFailures } from "../src/adapter.js";

let projectDir: string;

function writePkg(dir: string, pkg: Record<string, unknown>, files: Record<string, string> = {}) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

beforeEach(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), "externals-deps-"));
  writeFileSync(path.join(projectDir, "package.json"), JSON.stringify({ name: "app" }));
  stagedPaths.clear();
  stagingFailures.length = 0;
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  stagedPaths.clear();
  stagingFailures.length = 0;
});

const staged = (rel: string) =>
  existsSync(path.join(projectDir, ".k8s-adapter", "output", "pools", "ssr", "context", rel));

describe("stageExternalsDependencies", () => {
  it("stages each external's dependency tree from the app's node_modules", async () => {
    const externals = path.join(projectDir, ".next", "node_modules");
    writePkg(path.join(externals, "require-in-the-middle-45b2f40515652c68"), {
      name: "require-in-the-middle",
      version: "7.5.2",
      dependencies: { debug: "^4.3.5" },
    });
    const nm = path.join(projectDir, "node_modules");
    writePkg(path.join(nm, "debug"), {
      name: "debug",
      version: "4.3.5",
      dependencies: { ms: "^2.1.3" },
    });
    writePkg(path.join(nm, "ms"), { name: "ms", version: "2.1.3" });

    const result = await stageExternalsDependencies(projectDir, externals, "ssr", false);

    expect(result.staged).toContain("debug");
    expect(staged("node_modules/debug/package.json")).toBe(true);
    // stagePackageTree semantics: the dependency's own tree comes along.
    expect(staged("node_modules/ms/package.json")).toBe(true);
  });

  it("walks scoped externals directories too", async () => {
    const externals = path.join(projectDir, ".next", "node_modules");
    writePkg(path.join(externals, "@scope", "pkg-abcdef123456"), {
      name: "@scope/pkg",
      dependencies: { "left-pad": "^1.3.0" },
    });
    writePkg(path.join(projectDir, "node_modules", "left-pad"), {
      name: "left-pad",
      version: "1.3.0",
    });

    const result = await stageExternalsDependencies(projectDir, externals, "ssr", false);

    expect(result.staged).toContain("left-pad");
    expect(staged("node_modules/left-pad/package.json")).toBe(true);
  });

  it("reports (not throws) an unresolvable dependency and continues", async () => {
    const externals = path.join(projectDir, ".next", "node_modules");
    writePkg(path.join(externals, "thing-123"), {
      name: "thing",
      dependencies: { ghost: "^1.0.0" },
    });

    const result = await stageExternalsDependencies(projectDir, externals, "ssr", false);

    expect(result.unresolved).toContain("ghost");
  });
});
