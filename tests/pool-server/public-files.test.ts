// tests/pool-server/public-files.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectPublicPathnames,
  decodePublicPathname,
} from "../../src/pool-server/public-files.js";

describe("collectPublicPathnames", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = path.join(os.tmpdir(), `public-files-test-${Date.now()}-${Math.random()}`);
    mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns [] when there is no public/ directory", () => {
    expect(collectPublicPathnames(projectDir)).toEqual([]);
  });

  it("enumerates files as root-absolute, forward-slash pathnames, sorted", () => {
    mkdirSync(path.join(projectDir, "public", "files", "docs"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "favicon.ico"), "x");
    writeFileSync(path.join(projectDir, "public", "robots.txt"), "x");
    writeFileSync(path.join(projectDir, "public", "files", "a.pdf"), "x");
    writeFileSync(path.join(projectDir, "public", "files", "docs", "b.pdf"), "x");

    expect(collectPublicPathnames(projectDir)).toEqual([
      "/favicon.ico",
      "/files/a.pdf",
      "/files/docs/b.pdf",
      "/robots.txt",
    ]);
  });

  it("emits pathnames a rewrite destination can match (e.g. /files/:path* -> /:path*)", () => {
    // The rewrite `/files/report.pdf -> /report.pdf` is only selectable by
    // @next/routing if `/report.pdf` is present in the pathname set.
    mkdirSync(path.join(projectDir, "public"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "report.pdf"), "x");

    expect(collectPublicPathnames(projectDir)).toContain("/report.pdf");
  });

  it("ignores directories themselves, keeping only file entries", () => {
    mkdirSync(path.join(projectDir, "public", "empty-dir"), { recursive: true });
    writeFileSync(path.join(projectDir, "public", "keep.txt"), "x");

    expect(collectPublicPathnames(projectDir)).toEqual(["/keep.txt"]);
  });

  // Regression cover for the symlink support the cycle guard is interleaved with (N50): a link
  // whose target stays inside public/ is enumerated (parity with `next start`, whose `send`
  // follows links), one pointing outside is skipped with a warning, a dangling one is ignored.
  describe("symlink containment", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("enumerates a symlinked file whose target is inside public/", () => {
      const pub = path.join(projectDir, "public");
      mkdirSync(path.join(pub, "real"), { recursive: true });
      writeFileSync(path.join(pub, "real", "doc.pdf"), "x");
      symlinkSync(path.join(pub, "real", "doc.pdf"), path.join(pub, "alias.pdf"));

      expect(collectPublicPathnames(projectDir)).toEqual(["/alias.pdf", "/real/doc.pdf"]);
      expect(warn).not.toHaveBeenCalled();
    });

    it("skips a link that escapes public/, and a dangling link", () => {
      const pub = path.join(projectDir, "public");
      mkdirSync(pub, { recursive: true });
      writeFileSync(path.join(projectDir, ".env"), "SECRET=1");
      writeFileSync(path.join(pub, "ok.txt"), "x");
      symlinkSync(path.join(projectDir, ".env"), path.join(pub, "leak.env"));
      symlinkSync(path.join(pub, "gone.txt"), path.join(pub, "dangling.txt"));

      expect(collectPublicPathnames(projectDir)).toEqual(["/ok.txt"]);
      expect(warn.mock.calls.map(String).join("\n")).toContain("is outside public/");
    });
  });

  // N50 follow-up: symlink support resolved the target and checked containment, but a CONTAINED
  // directory link can still point at itself or an ancestor. `public/loop -> .` resolves to
  // public/ itself, passes containment, and the walk then descends /loop/loop/loop/… until
  // ENAMETOOLONG or a stack overflow aborts the whole build. A cycle is a repo mistake, so it must
  // be skipped with a warning while everything reachable without it is still enumerated (that is
  // what `next start` does).
  describe("cyclic directory symlinks terminate the walk", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    it("skips a self-referential link (public/loop -> .) and still enumerates the real files", () => {
      const pub = path.join(projectDir, "public");
      mkdirSync(path.join(pub, "files"), { recursive: true });
      writeFileSync(path.join(pub, "favicon.ico"), "x");
      writeFileSync(path.join(pub, "files", "a.pdf"), "x");
      symlinkSync(".", path.join(pub, "loop"), "dir");

      expect(collectPublicPathnames(projectDir)).toEqual(["/favicon.ico", "/files/a.pdf"]);
      expect(warn.mock.calls.map(String).join("\n")).toContain("cyclic");
    });

    it("skips a link to an ancestor (public/a/up -> ..)", () => {
      const pub = path.join(projectDir, "public");
      mkdirSync(path.join(pub, "a", "b"), { recursive: true });
      writeFileSync(path.join(pub, "root.txt"), "x");
      writeFileSync(path.join(pub, "a", "inner.txt"), "x");
      writeFileSync(path.join(pub, "a", "b", "deep.txt"), "x");
      symlinkSync("..", path.join(pub, "a", "up"), "dir");

      expect(collectPublicPathnames(projectDir)).toEqual([
        "/a/b/deep.txt",
        "/a/inner.txt",
        "/root.txt",
      ]);
      expect(warn.mock.calls.map(String).join("\n")).toContain("cyclic");
    });

    it("skips a two-hop cycle (public/x/down -> ../y, public/y/up -> ../x)", () => {
      const pub = path.join(projectDir, "public");
      mkdirSync(path.join(pub, "x"), { recursive: true });
      mkdirSync(path.join(pub, "y"), { recursive: true });
      writeFileSync(path.join(pub, "x", "x.txt"), "x");
      writeFileSync(path.join(pub, "y", "y.txt"), "x");
      symlinkSync("../y", path.join(pub, "x", "down"), "dir");
      symlinkSync("../x", path.join(pub, "y", "up"), "dir");

      // Each prefix is followed once (parity with `next start`, which serves /x/down/y.txt), but
      // the mutual recursion stops instead of alternating forever.
      expect(collectPublicPathnames(projectDir)).toEqual([
        "/x/down/y.txt",
        "/x/x.txt",
        "/y/up/x.txt",
        "/y/y.txt",
      ]);
    });

    it("still follows two sibling links into the SAME subtree (not a cycle)", () => {
      // Guards the fix against being implemented as a global visited-set: `next start` serves
      // /one/f.txt AND /two/f.txt, so both prefixes must be enumerated.
      const pub = path.join(projectDir, "public");
      mkdirSync(path.join(pub, "sub"), { recursive: true });
      writeFileSync(path.join(pub, "sub", "f.txt"), "x");
      symlinkSync("sub", path.join(pub, "one"), "dir");
      symlinkSync("sub", path.join(pub, "two"), "dir");

      expect(collectPublicPathnames(projectDir)).toEqual([
        "/one/f.txt",
        "/sub/f.txt",
        "/two/f.txt",
      ]);
    });
  });

  it("decodes a public URL pathname exactly once for filesystem lookup", () => {
    expect(decodePublicPathname("/hello%20world.jpg")).toBe("/hello world.jpg");
    expect(decodePublicPathname("/literal%2520name.jpg")).toBe("/literal%20name.jpg");
    expect(decodePublicPathname("/%zz.jpg")).toBeNull();
  });
});
