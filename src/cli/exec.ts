// src/cli/exec.ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { sanitizeForTerminal } from "./terminal.js";

export interface ExecResult {
  exitCode: number;
  /** True when the child was killed because timeoutMs elapsed (exitCode is then 124). */
  timedOut?: boolean;
}

export interface ExecCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True when the child was killed because timeoutMs elapsed (exitCode is then 124). */
  timedOut?: boolean;
}

export interface ExecOptions {
  cwd?: string;
  /**
   * Optional hard cap on the child's lifetime. On expiry the child is SIGKILLed and the
   * promise resolves with exitCode 124 + timedOut: true (execCapture also notes the timeout
   * on stderr). Unset = no timeout, exactly the pre-timeout behavior. gcloud/kubectl calls
   * that wait on long-running GCP operations must set this — a wedged operation otherwise
   * hangs the CLI forever (there was previously no timeout anywhere).
   */
  timeoutMs?: number;
  /**
   * Extra environment for the child, merged over `process.env`. Added for the buildkit probe
   * (container-runtime.ts), which must try nerdctl's rootless BUILDKIT_HOST candidates —
   * buildctl otherwise defaults to the root socket and reports failure for a working
   * rootless daemon.
   */
  env?: Record<string, string>;
}

// M2: never route arguments through a shell we don't escape for. The old blanket
// `shell: process.platform === "win32"` sent every argument through `cmd.exe /s /c`, so a
// metacharacter in any arg (build id, git branch, pool name) was a command-injection sink
// on Windows. Bare tool names (gcloud, npx, helm) are usually shims on Windows, so resolve
// the real executable on PATH and spawn it directly with `shell: false` where possible.
// POSIX keeps the bare command.
//
// M2 follow-up (EINVAL): Node >= 18.20 / 20.12 / 21.7 (CVE-2024-27980 hardening) refuses
// to spawn a `.cmd`/`.bat` file without a shell — spawn() throws EINVAL — so the original
// M2 fix (direct spawn of the resolved `.cmd` shim) broke gcloud/npx-style tools entirely
// on current Node. For `.cmd`/`.bat` resolutions we therefore must go through cmd.exe,
// but with a command line WE escape, using the battle-tested algorithm from the npm
// `cross-spawn` package (lib/util/escape.js + lib/parse.js, reimplemented inline below —
// zero-dependency discipline, no new package), spawned with
// `windowsVerbatimArguments: true` so Node doesn't re-quote what we already escaped.
// `.exe` and bare-name resolutions keep the direct `shell: false` spawn.
//
// The probe order prefers `.exe` over `.cmd` (then `.bat`, then the bare name) — changed
// from the original M2 `.cmd`-first order — so tools shipping both a real executable and
// a shim take the direct-spawn path and never touch cmd.exe.
export function resolveWindowsCommand(command: string, pathEnv?: string): string {
  const pathValue = pathEnv ?? process.env.PATH ?? "";
  for (const dir of pathValue.split(";")) {
    if (!dir) continue;
    for (const ext of [".exe", ".cmd", ".bat", ""]) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Not found on PATH: return the bare command and let spawn fail with ENOENT,
  // matching the pre-existing behavior for a missing tool.
  return command;
}

// cmd.exe metacharacters (cross-spawn's metaCharsRegExp). Escaping any of these with a
// leading `^` renders them literal to cmd.exe's parser.
const CMD_META_CHARS = /([()\][%!^"`<>&|])/g;

// M2/EINVAL: escape a command path for a cmd.exe command line (cross-spawn
// lib/util/escape.js `command()`): `^`-escape metacharacters, no quoting — cmd.exe
// resolves the leading token fine with spaces as long as `/s` outer-quote handling
// applies (see buildWindowsCmdInvocation).
export function escapeCommand(command: string): string {
  return command.replace(CMD_META_CHARS, "^$1");
}

// M2/EINVAL: escape one argument for a cmd.exe command line (cross-spawn
// lib/util/escape.js `argument()`, itself based on https://qntm.org/cmd):
//   1. double up backslash runs that precede a double quote, and `\`-escape the quote
//      (MSVC argv parsing rules),
//   2. double up a trailing backslash run (it will precede the closing quote we add),
//   3. wrap the whole thing in double quotes,
//   4. `^`-escape every cmd.exe metacharacter (twice for node_modules/.bin cmd shims,
//      which re-expand `%*` — cross-spawn's doubleEscapeMetaChars).
// Getting this wrong reintroduces the injection M2 closed — do not "simplify" it.
export function escapeArgument(arg: string, doubleEscapeMetaChars = false): string {
  let escaped = `${arg}`;
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, "^$1");
  if (doubleEscapeMetaChars) {
    escaped = escaped.replace(CMD_META_CHARS, "^$1");
  }
  return escaped;
}

export interface WindowsSpawnPlan {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

// cross-spawn's cmd-shim detection: npm-generated shims under node_modules/.bin
// re-expand `%*`, so their arguments need the metacharacter escape applied twice.
const NODE_MODULES_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

// M2/EINVAL: turn a PATH-resolved executable + argv into a concrete spawn plan
// (cross-spawn lib/parse.js `parseNonShell()`).
// - `.cmd`/`.bat` (case-insensitive): Node's CVE-2024-27980 hardening throws EINVAL on a
//   direct `shell: false` spawn, so build `cmd.exe /d /s /c "<escaped command line>"`
//   with `windowsVerbatimArguments: true` (Node passes our escaped line through
//   untouched). The outer quotes around the command line are consumed by `/s`.
// - anything else (`.exe`, bare): direct spawn, `shell: false`, no verbatim args.
// Pure so the Windows behavior is unit-testable from any platform.
export function buildWindowsCmdInvocation(resolvedPath: string, args: string[]): WindowsSpawnPlan {
  if (!/\.(cmd|bat)$/i.test(resolvedPath)) {
    return { command: resolvedPath, args, windowsVerbatimArguments: false };
  }
  const doubleEscape = NODE_MODULES_CMD_SHIM.test(resolvedPath);
  const commandLine = [
    escapeCommand(path.win32.normalize(resolvedPath)),
    ...args.map((arg) => escapeArgument(arg, doubleEscape)),
  ].join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function planSpawn(command: string, args: string[]): WindowsSpawnPlan {
  if (process.platform !== "win32") {
    return { command, args, windowsVerbatimArguments: false };
  }
  return buildWindowsCmdInvocation(resolveWindowsCommand(command), args);
}

// Arms the optional timeout. Returns a cleanup disposer; on expiry the child is killed
// and `onTimeout` fires so callers can stamp the result as timed out. 124 mirrors the
// GNU `timeout` exit code so logs read conventionally.
const TIMEOUT_EXIT_CODE = 124;

function armTimeout(
  child: ReturnType<typeof spawn>,
  timeoutMs: number | undefined,
  onTimeout: () => void,
): () => void {
  if (!timeoutMs) return () => {};
  const timer = setTimeout(() => {
    onTimeout();
    child.kill("SIGKILL");
  }, timeoutMs);
  // Don't keep the process alive just for the timer.
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Run a command, streaming its output to the terminal.
 *
 * S28 (SECURITY). This used `stdio: "inherit"`, which hands the child our raw file descriptors
 * — so helm/gcloud/kubectl output reached the operator's terminal without passing through
 * `sanitizeForTerminal`. L14 established the rule for pod logs (a cluster-sourced string can
 * carry CSI/OSC sequences that rewrite the terminal, forge output, or hide an earlier warning)
 * but the biggest source of externally-influenced text — an admission-webhook message, a
 * gcloud API error echoing a request value — bypassed it entirely. Pipe and filter instead,
 * line by line, so the streaming behaviour is unchanged and the escapes are gone.
 */
export function exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const plan = planSpawn(command, args);
    const child = spawn(plan.command, plan.args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: options?.cwd,
      shell: false, // M2: never a shell we don't escape for (see buildWindowsCmdInvocation)
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });
    // S28: forward line-by-line through the sanitizer. Partial lines are held until their
    // newline arrives so a control sequence cannot be split across two chunks and slip
    // through; whatever is left at EOF is flushed.
    const forward = (src: NodeJS.ReadableStream | null, dest: NodeJS.WriteStream): (() => void) => {
      let pending = "";
      src?.setEncoding("utf8");
      src?.on("data", (chunk: string) => {
        pending += chunk;
        const lastBreak = pending.lastIndexOf("\n");
        if (lastBreak === -1) return;
        dest.write(sanitizeForTerminal(pending.slice(0, lastBreak + 1)));
        pending = pending.slice(lastBreak + 1);
      });
      return () => {
        if (pending) {
          dest.write(sanitizeForTerminal(pending));
          pending = "";
        }
      };
    };
    const flushOut = forward(child.stdout, process.stdout);
    const flushErr = forward(child.stderr, process.stderr);

    let timedOut = false;
    const disarm = armTimeout(child, options?.timeoutMs, () => {
      timedOut = true;
    });
    child.on("error", (err) => {
      disarm();
      flushOut();
      flushErr();
      reject(err);
    });
    child.on("close", (code) => {
      disarm();
      flushOut();
      flushErr();
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1),
        ...(timedOut ? { timedOut } : {}),
      });
    });
  });
}

// Shared capture implementation for execCapture / execCaptureStdin.
function spawnCapture(
  command: string,
  args: string[],
  options: ExecOptions | undefined,
  stdin: string | undefined,
): Promise<ExecCaptureResult> {
  return new Promise((resolve, reject) => {
    const plan = planSpawn(command, args);
    const child = spawn(plan.command, plan.args, {
      stdio: [stdin !== undefined ? "pipe" : "inherit", "pipe", "pipe"],
      cwd: options?.cwd,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
      shell: false, // M2: never a shell we don't escape for (see buildWindowsCmdInvocation)
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const disarm = armTimeout(child, options?.timeoutMs, () => {
      timedOut = true;
    });
    child.stdout!.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr!.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      disarm();
      reject(err);
    });
    child.on("close", (code) => {
      disarm();
      resolve({
        exitCode: timedOut ? TIMEOUT_EXIT_CODE : (code ?? 1),
        stdout,
        stderr: timedOut
          ? `${stderr}${stderr.endsWith("\n") || !stderr ? "" : "\n"}Command timed out after ${options?.timeoutMs}ms — killed: ${command} ${args.join(" ")}`
          : stderr,
        ...(timedOut ? { timedOut } : {}),
      });
    });
    if (stdin !== undefined) {
      // A missing binary (spawn ENOENT) destroys the stdin pipe while we write to it;
      // without a handler that surfaces as an UNHANDLED stream 'error' (EPIPE/
      // ERR_STREAM_DESTROYED) and crashes the process. Swallow it — the child's own
      // 'error' event above carries the real failure.
      child.stdin!.on("error", () => {});
      child.stdin!.write(stdin);
      child.stdin!.end();
    }
  });
}

// Run a command and capture stdout/stderr
export function execCapture(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecCaptureResult> {
  return spawnCapture(command, args, options, undefined);
}

// Run a command with `input` piped to stdin, capturing stdout/stderr. For
// `kubectl apply -f -`-style calls where the payload must not appear on argv
// (size limits, and secrets never on argv — see AGENTS.md).
export function execCaptureStdin(
  command: string,
  args: string[],
  input: string,
  options?: ExecOptions,
): Promise<ExecCaptureResult> {
  return spawnCapture(command, args, options, input);
}

// Run a command and throw on non-zero exit
export async function execOrThrow(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<void> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Command timed out after ${options?.timeoutMs}ms — killed: ${command} ${args.join(" ")}`
        : `Command failed with exit code ${result.exitCode}: ${command} ${args.join(" ")}`,
    );
  }
}

// Run a command, capture output, and throw on non-zero exit
export async function execCaptureOrThrow(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<string> {
  const result = await execCapture(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      result.timedOut
        ? `Command timed out after ${options?.timeoutMs}ms — killed: ${command} ${args.join(" ")}`
        : `Command failed (exit ${result.exitCode}): ${command} ${args.join(" ")}\n${result.stderr}`,
    );
  }
  return result.stdout;
}
