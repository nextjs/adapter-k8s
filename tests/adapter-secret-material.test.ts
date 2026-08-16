// tests/adapter-secret-material.test.ts
//
// The internal dispatch secret's operator key (`.k8s-adapter/internal-secret.key`) and the
// gitignore rule that keeps the whole state directory out of commits. The documented GitOps
// flow (docs/gitops.md) runs `next build` on the application PR BEFORE `adapter-k8s init`
// ever ran — so the build itself must enforce both, not init alone.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInternalSecret, ensureStateDirGitignored } from "../src/adapter.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-secret-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY;
});

describe("ensureStateDirGitignored", () => {
  it("creates a .gitignore with the state-dir rule when none exists", () => {
    ensureStateDirGitignored(tmpDir);
    expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf-8")).toBe(".k8s-adapter/\n");
  });

  it("appends to an existing .gitignore, repairing a missing trailing newline", () => {
    writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n.next");
    ensureStateDirGitignored(tmpDir);
    expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n.next\n.k8s-adapter/\n",
    );
  });

  it("is idempotent and never duplicates the rule", () => {
    writeFileSync(path.join(tmpDir, ".gitignore"), "node_modules/\n.k8s-adapter/\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ensureStateDirGitignored(tmpDir);
    ensureStateDirGitignored(tmpDir);
    expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf-8")).toBe(
      "node_modules/\n.k8s-adapter/\n",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("fails SOFT but loud when the checkout is unwritable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A projectDir that does not exist: writeFileSync throws ENOENT.
    ensureStateDirGitignored(path.join(tmpDir, "does-not-exist"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not add"));
  });
});

describe("deriveInternalSecret", () => {
  const keyPath = () => path.join(tmpDir, ".k8s-adapter", "internal-secret.key");

  it("mints a 256-bit key file with mode 0600 on first use", async () => {
    const secret = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    const key = readFileSync(keyPath(), "utf-8");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    // macOS/Linux: exactly 0600 (owner rw only).
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
  });

  it("is deterministic per (release, buildId) and unrelated across builds", async () => {
    const a1 = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    const a2 = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    const b = await deriveInternalSecret(tmpDir, "my-app", "buildm");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("TIGHTENS a pre-existing loose-mode key file — writeFile's mode is creation-only", async () => {
    // Restored-from-backup / hand-created case: the file exists, is empty (so a fresh key
    // is written into it), and is world-readable.
    mkdirSync(path.dirname(keyPath()), { recursive: true });
    writeFileSync(keyPath(), "", { mode: 0o644 });
    expect(statSync(keyPath()).mode & 0o777).toBe(0o644);
    await deriveInternalSecret(tmpDir, "my-app", "buildn");
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
  });

  it("also tightens a loose PRE-EXISTING key that is simply read back", async () => {
    mkdirSync(path.dirname(keyPath()), { recursive: true });
    writeFileSync(keyPath(), `${"ab".repeat(32)}\n`, { mode: 0o644 });
    const secret = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    expect(statSync(keyPath()).mode & 0o777).toBe(0o600);
    // The existing key drove the derivation (rotation only ever happens by operator choice).
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  it("honors ADAPTER_K8S_INTERNAL_SECRET_KEY over the key file (CI secret store)", async () => {
    process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY = "ci-held-key";
    const secret = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    // The env key is used INSTEAD of the file: no key file is minted.
    expect(existsSync(keyPath())).toBe(false);
    delete process.env.ADAPTER_K8S_INTERNAL_SECRET_KEY;
    const fileSecret = await deriveInternalSecret(tmpDir, "my-app", "buildn");
    expect(secret).not.toBe(fileSecret);
  });
});
