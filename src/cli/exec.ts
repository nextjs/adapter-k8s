// src/cli/exec.ts
import { spawn } from 'node:child_process';

export interface ExecResult {
  exitCode: number;
}

export interface ExecCaptureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Run a command with inherited stdio (output streams to terminal)
export function exec(command: string, args: string[], options?: { cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd: options?.cwd,
      shell: process.platform === 'win32', // Support Windows
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1 }));
  });
}

// Run a command and capture stdout/stderr
export function execCapture(command: string, args: string[], options?: { cwd?: string }): Promise<ExecCaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: options?.cwd,
      shell: process.platform === 'win32',
    });

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d) => { stdout += d.toString(); });
    child.stderr!.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
  });
}

// Run a command and throw on non-zero exit
export async function execOrThrow(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
  const result = await exec(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed with exit code ${result.exitCode}: ${command} ${args.join(' ')}`);
  }
}

// Run a command, capture output, and throw on non-zero exit
export async function execCaptureOrThrow(command: string, args: string[], options?: { cwd?: string }): Promise<string> {
  const result = await execCapture(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`Command failed (exit ${result.exitCode}): ${command} ${args.join(' ')}\n${result.stderr}`);
  }
  return result.stdout;
}
