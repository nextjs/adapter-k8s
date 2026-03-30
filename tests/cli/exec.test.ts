// tests/cli/exec.test.ts
import { describe, it, expect } from "vitest";
import { exec, execCapture } from "../../src/cli/exec.js";

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
});
