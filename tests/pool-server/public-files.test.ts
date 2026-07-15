// tests/pool-server/public-files.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectPublicPathnames } from "../../src/pool-server/public-files.js";

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
});
