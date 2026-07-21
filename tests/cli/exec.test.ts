// tests/cli/exec.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { exec, execCapture, resolveWindowsCommand } from "../../src/cli/exec.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("exec", () => {
  it("runs a command and returns exit code 0 on success", async () => {
    const result = await exec("echo", ["hello"]);
    expect(result.exitCode).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const result = await exec("node", ["-e", "process.exit(1)"]);
    expect(result.exitCode).toBe(1);
  });
});

describe("execCapture", () => {
  it("captures stdout", async () => {
    const result = await execCapture("echo", ["hello world"]);
    expect(result.stdout.trim()).toBe("hello world");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr on failure", async () => {
    const result = await execCapture("node", ["-e", 'console.error("oops"); process.exit(1)']);
    expect(result.stderr.trim()).toBe("oops");
    expect(result.exitCode).toBe(1);
  });

  it("does not route args through a shell (metacharacters are literal)", async () => {
    // With shell:true this would spawn `q` / print env vars; with shell:false echo
    // receives the string verbatim.
    const result = await execCapture("echo", ["a;b&c|d>e$F `g` $(h)"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("a;b&c|d>e$F `g` $(h)");
  });
});

// M2: on Windows the executable is resolved on PATH (.cmd/.exe/.bat shims) and spawned
// with shell:false instead of routing every arg through cmd.exe.
describe("resolveWindowsCommand", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-exec-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function touch(rel: string): void {
    const full = path.join(tmpDir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "@echo off\r\n");
  }

  it("resolves a .cmd shim on PATH", () => {
    touch("bin/gcloud.cmd");
    const resolved = resolveWindowsCommand("gcloud", path.join(tmpDir, "bin"));
    expect(resolved).toBe(path.join(tmpDir, "bin", "gcloud.cmd"));
  });

  it("prefers .cmd over .exe over .bat over the bare name", () => {
    touch("bin/tool.cmd");
    touch("bin/tool.exe");
    touch("bin/tool.bat");
    touch("bin/tool");
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool.cmd"),
    );

    rmSync(path.join(tmpDir, "bin", "tool.cmd"));
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool.exe"),
    );

    rmSync(path.join(tmpDir, "bin", "tool.exe"));
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool.bat"),
    );

    rmSync(path.join(tmpDir, "bin", "tool.bat"));
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool"),
    );
  });

  it("searches PATH entries in order (semicolon-separated)", () => {
    touch("first/tool.exe");
    touch("second/tool.cmd");
    const pathEnv = `${path.join(tmpDir, "first")};${path.join(tmpDir, "second")}`;
    expect(resolveWindowsCommand("tool", pathEnv)).toBe(path.join(tmpDir, "first", "tool.exe"));
  });

  it("skips empty PATH entries", () => {
    touch("bin/tool.cmd");
    const resolved = resolveWindowsCommand("tool", `;;${path.join(tmpDir, "bin")};`);
    expect(resolved).toBe(path.join(tmpDir, "bin", "tool.cmd"));
  });

  it("returns the bare command when not found on PATH", () => {
    expect(resolveWindowsCommand("definitely-missing-tool", tmpDir)).toBe(
      "definitely-missing-tool",
    );
  });
});
