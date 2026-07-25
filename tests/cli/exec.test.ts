// tests/cli/exec.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  buildWindowsCmdInvocation,
  escapeArgument,
  escapeCommand,
  exec,
  execCapture,
  execCaptureStdin,
  execOrThrow,
  resolveWindowsCommand,
} from "../../src/cli/exec.js";
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

describe("execCaptureStdin", () => {
  it("pipes input to stdin without touching argv", async () => {
    const result = await execCaptureStdin(
      "node",
      ["-e", "process.stdin.pipe(process.stdout)"],
      "hello-stdin",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello-stdin");
  });

  it("surfaces ENOENT for a missing binary instead of crashing on the stdin stream", async () => {
    // A missing binary destroys the stdin pipe while the payload is written; without a
    // stream 'error' handler that raised an UNHANDLED error and crashed the process.
    // The child's own 'error' event must carry the real failure.
    await expect(
      execCaptureStdin("definitely-missing-tool-xyz", ["apply", "-f", "-"], "payload"),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe("timeoutMs", () => {
  it("kills a child that outlives timeoutMs and reports timedOut", async () => {
    const result = await execCapture("node", ["-e", "setTimeout(() => {}, 60_000)"], {
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out after 150ms");
  });

  it("execOrThrow names the timeout in its error", async () => {
    await expect(
      execOrThrow("node", ["-e", "setTimeout(() => {}, 60_000)"], { timeoutMs: 150 }),
    ).rejects.toThrow(/timed out after 150ms/);
  });

  it("does not disturb a fast command (and unset keeps old behavior)", async () => {
    const withTimeout = await execCapture("echo", ["fast"], { timeoutMs: 10_000 });
    expect(withTimeout.exitCode).toBe(0);
    expect(withTimeout.timedOut).toBeUndefined();
    expect(withTimeout.stdout.trim()).toBe("fast");

    const unset = await exec("echo", ["fast"]);
    expect(unset.exitCode).toBe(0);
    expect(unset.timedOut).toBeUndefined();
  });
});

// M2: on Windows the executable is resolved on PATH and, when it's a real executable,
// spawned with shell:false instead of routing every arg through cmd.exe. `.exe` is
// preferred over `.cmd`/`.bat` so tools shipping both take the direct-spawn path
// (`.cmd`/`.bat` cannot be spawned without a shell on Node >= 18.20/20.12/21.7 —
// CVE-2024-27980 — see buildWindowsCmdInvocation).
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

  it("prefers .exe over .cmd over .bat over the bare name", () => {
    touch("bin/tool.cmd");
    touch("bin/tool.exe");
    touch("bin/tool.bat");
    touch("bin/tool");
    // .exe first so tools shipping both an executable and a shim take the direct-spawn
    // path (a .cmd would force the cmd.exe escape path — CVE-2024-27980).
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool.exe"),
    );

    rmSync(path.join(tmpDir, "bin", "tool.exe"));
    expect(resolveWindowsCommand("tool", path.join(tmpDir, "bin"))).toBe(
      path.join(tmpDir, "bin", "tool.cmd"),
    );

    rmSync(path.join(tmpDir, "bin", "tool.cmd"));
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

// M2/EINVAL: cmd.exe command-line escaping (cross-spawn lib/util/escape.js semantics).
// These pure functions carry the test weight — we cannot execute the Windows spawn path
// on Linux, so any drift from cross-spawn here is a re-opened injection hole.
describe("escapeArgument", () => {
  it("wraps a plain arg in ^-escaped double quotes", () => {
    expect(escapeArgument("foo")).toBe('^"foo^"');
  });

  it("preserves spaces inside the quotes", () => {
    expect(escapeArgument("foo bar")).toBe('^"foo bar^"');
  });

  it("backslash-escapes embedded double quotes (then ^-escapes them for cmd)", () => {
    expect(escapeArgument('say "hi"')).toBe('^"say \\^"hi\\^"^"');
  });

  it("doubles a backslash run that precedes an embedded quote", () => {
    // MSVC rule: a\"b -> the backslash before the quote must be doubled, then the quote
    // itself escaped: a\\\"b inside the quotes.
    expect(escapeArgument('a\\"b')).toBe('^"a\\\\\\^"b^"');
  });

  it("doubles trailing backslashes so they cannot eat the closing quote", () => {
    expect(escapeArgument("C:\\temp\\")).toBe('^"C:\\temp\\\\^"');
    expect(escapeArgument("x\\\\")).toBe('^"x\\\\\\\\^"');
  });

  it("^-escapes every cmd metacharacter", () => {
    expect(escapeArgument("a&b")).toBe('^"a^&b^"');
    expect(escapeArgument("a|b")).toBe('^"a^|b^"');
    expect(escapeArgument("a^b")).toBe('^"a^^b^"');
    expect(escapeArgument("a%b%")).toBe('^"a^%b^%^"');
    expect(escapeArgument("a!b")).toBe('^"a^!b^"');
    expect(escapeArgument("a<b")).toBe('^"a^<b^"');
    expect(escapeArgument("a>b")).toBe('^"a^>b^"');
    expect(escapeArgument("(a)")).toBe('^"^(a^)^"');
  });

  it("produces an empty quoted pair for the empty string", () => {
    expect(escapeArgument("")).toBe('^"^"');
  });

  it("double-escapes metacharacters when asked (node_modules/.bin cmd shims)", () => {
    expect(escapeArgument("a&b", true)).toBe('^^^"a^^^&b^^^"');
  });
});

describe("escapeCommand", () => {
  it("^-escapes metacharacters in the command path without quoting it", () => {
    expect(escapeCommand("C:\\Program Files (x86)\\Google\\gcloud.cmd")).toBe(
      "C:\\Program Files ^(x86^)\\Google\\gcloud.cmd",
    );
  });
});

describe("buildWindowsCmdInvocation", () => {
  it("routes a .cmd resolution through cmd.exe /d /s /c with verbatim args", () => {
    const plan = buildWindowsCmdInvocation("C:\\tools\\gcloud.cmd", ["run", "a b"]);
    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    // Outer quotes are consumed by /s; command escaped without quoting, args quoted.
    expect(plan.args[3]).toBe('"C:\\tools\\gcloud.cmd ^"run^" ^"a b^""');
    expect(plan.windowsVerbatimArguments).toBe(true);
  });

  it("handles .bat and is case-insensitive on the extension", () => {
    expect(buildWindowsCmdInvocation("C:\\t\\x.bat", []).command).toBe("cmd.exe");
    expect(buildWindowsCmdInvocation("C:\\t\\X.CMD", []).command).toBe("cmd.exe");
    expect(buildWindowsCmdInvocation("C:\\t\\X.CMD", []).windowsVerbatimArguments).toBe(true);
  });

  it("spawns a .exe resolution directly (no cmd.exe, no verbatim args)", () => {
    const plan = buildWindowsCmdInvocation("C:\\tools\\kubectl.exe", ["get", "pods"]);
    expect(plan.command).toBe("C:\\tools\\kubectl.exe");
    expect(plan.args).toEqual(["get", "pods"]);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it("spawns a bare (extension-less) resolution directly", () => {
    const plan = buildWindowsCmdInvocation("C:\\tools\\kubectl", ["version"]);
    expect(plan.command).toBe("C:\\tools\\kubectl");
    expect(plan.args).toEqual(["version"]);
    expect(plan.windowsVerbatimArguments).toBe(false);
  });

  it("double-escapes args for node_modules/.bin cmd shims", () => {
    const plan = buildWindowsCmdInvocation(
      "C:\\proj\\node_modules\\.bin\\next.cmd",
      ["a&b"],
    );
    expect(plan.args[3]).toContain("^^^&");
  });

  // M2 regression: this is the exact class of payload the original fix closed. It must
  // arrive at the tool as one inert argument — never as cmd.exe syntax.
  it("keeps an injection payload inert on the built command line", () => {
    const evil = 'foo" & del C:\\* & "';
    expect(escapeArgument(evil)).toBe('^"foo\\^" ^& del C:\\* ^& \\^"^"');

    const plan = buildWindowsCmdInvocation("C:\\tools\\npx.cmd", ["exec", evil]);
    const line = plan.args[3];
    // Every chaining/redirect metacharacter must carry a ^ escape — an unescaped one
    // would let cmd.exe split the line into multiple commands.
    expect(line).not.toMatch(/(^|[^^])[&|<>]/);
    // And every double quote other than the /s outer pair must be ^-escaped.
    expect(line.slice(1, -1)).not.toMatch(/(^|[^^\\])"/);
  });
});
