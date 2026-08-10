// Re-emit reuse against the REAL sops binary. The mocked suite (emit.test.ts) cannot
// catch serializer drift: sops re-serializes YAML on decrypt (4-space indent, quotes
// stripped), which is exactly what broke the original textual plaintext comparison —
// every re-emit re-encrypted, making the documented "a changed secrets/ diff is never
// noise" guarantee false. Skips cleanly when sops/age are not installed (same pattern
// as the Docker-gated integration tests).
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitBundleSopsSecrets } from "../../src/cli/emit.js";

const sopsAvailable = (() => {
  try {
    execFileSync("sops", ["--version"], { stdio: "ignore" });
    execFileSync("age-keygen", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sopsAvailable)("sops re-emit reuse (real binary)", () => {
  it("keeps the prior encrypted file byte-identical when plaintext is unchanged", async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "sops-reuse-"));
    try {
      const keyPath = path.join(repo, "age.key");
      execFileSync("age-keygen", ["-o", keyPath], { stdio: "ignore" });
      const recipient = readFileSync(keyPath, "utf-8").match(/public key: (age1\w+)/)![1];
      writeFileSync(
        path.join(repo, ".sops.yaml"),
        `creation_rules:\n  - path_regex: bundle/secrets/.*\\.sops\\.yaml$\n    age: ${recipient}\n`,
      );
      process.env.SOPS_AGE_KEY_FILE = keyPath;
      const bundleDir = path.join(repo, "bundle");
      mkdirSync(bundleDir, { recursive: true });
      const plaintext = `apiVersion: v1\nkind: Secret\nmetadata:\n  name: "demo-ihs"\nstringData:\n  secret: "cafe0123"\n`;
      const configOpt = { configPath: path.join(repo, ".sops.yaml"), explicit: false };

      const first = await emitBundleSopsSecrets({
        bundleDir,
        sources: [{ fileName: "internal-secret", plaintext }],
        prior: new Map(),
        config: configOpt,
      });
      expect(first).toEqual(["secrets/internal-secret.sops.yaml"]);
      const firstBytes = readFileSync(
        path.join(bundleDir, "secrets/internal-secret.sops.yaml"),
        "utf-8",
      );

      // Re-emit with identical plaintext: the prior file must be reused byte-identically.
      const prior = new Map([["internal-secret.sops.yaml", firstBytes]]);
      rmSync(path.join(bundleDir, "secrets"), { recursive: true, force: true });
      await emitBundleSopsSecrets({
        bundleDir,
        sources: [{ fileName: "internal-secret", plaintext }],
        prior,
        config: configOpt,
      });
      const secondBytes = readFileSync(
        path.join(bundleDir, "secrets/internal-secret.sops.yaml"),
        "utf-8",
      );
      expect(secondBytes).toBe(firstBytes);
      // No temp check file left behind.
      expect(
        existsSync(path.join(bundleDir, "secrets/internal-secret.reemit-check.sops.yaml")),
      ).toBe(false);

      // Changed plaintext: must re-encrypt (different bytes) and decrypt to the new value.
      const changed = plaintext.replace("cafe0123", "beef4567");
      rmSync(path.join(bundleDir, "secrets"), { recursive: true, force: true });
      await emitBundleSopsSecrets({
        bundleDir,
        sources: [{ fileName: "internal-secret", plaintext: changed }],
        prior: new Map([["internal-secret.sops.yaml", firstBytes]]),
        config: configOpt,
      });
      const thirdBytes = readFileSync(
        path.join(bundleDir, "secrets/internal-secret.sops.yaml"),
        "utf-8",
      );
      expect(thirdBytes).not.toBe(firstBytes);
      const dec = execFileSync("sops", ["--decrypt", "bundle/secrets/internal-secret.sops.yaml"], {
        cwd: repo,
        env: { ...process.env, SOPS_AGE_KEY_FILE: keyPath },
      }).toString();
      expect(dec).toContain("beef4567");
    } finally {
      delete process.env.SOPS_AGE_KEY_FILE;
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
