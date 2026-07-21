// src/cli/exec.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ExecResult {
  exitCode: number;
}

export interface ExecCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// M2: never spawn through cmd.exe. The old blanket `shell: process.platform === "win32"`
// routed every argument through `cmd.exe /s /c`, so a metacharacter in any arg (build id,
// git branch, pool name) was a command-injection sink on Windows. Bare tool names
// (gcloud, npx, helm) are usually `.cmd` shims on Windows, so resolve the real
// executable on PATH — trying `<cmd>.cmd`, `<cmd>.exe`, `<cmd>.bat`, then `<cmd>` —
// and spawn it directly with `shell: false`. POSIX keeps the bare command.
export function resolveWindowsCommand(command: string, pathEnv?: string): string {
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    for (const ext of [".cmd", ".exe", ".bat", ""]) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Not found on PATH: return the bare command and let spawn fail with ENOENT,
  // matching the pre-existing behavior for a missing tool.
  return command;
}

function resolveSpawnCommand(command: string): string {
  return process.platform === "win32" ? resolveWindowsCommand(command) : command;
}

// Run a command with inherited stdio (output streams to terminal)
export function exec(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveSpawnCommand(command), args, {
      stdio: "inherit",
      cwd: options?.cwd,
      shell: false, // M2: args must never pass through a shell (see resolveWindowsCommand)
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
  });
}

// Run a command and capture stdout/stderr
export function execCapture(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<ExecCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(resolveSpawnCommand(command), args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: options?.cwd,
      shell: false, // M2: args must never pass through a shell (see resolveWindowsCommand)
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr!.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

// Run a command and throw on non-zero exit
export async function execOrThrow(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<void> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${command} ${args.join(" ")}`,
    );
  }
}

// Run a command, capture output, and throw on non-zero exit
export async function execCaptureOrThrow(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<string> {
  const result = await execCapture(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode}): ${command} ${args.join(" ")}\n${result.stderr}`,
    );
  }
  return result.stdout;
}
