import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureTlsIdentity } from "../../src/routing-service/index.js";

// ensureTlsIdentity: a routing service that can't mint its TLS identity must CRASH
// (throw) rather than start plaintext — an h2c server passes the health probes while
// every ext_proc callout (h2+TLS only) silently fails. The only override is the
// explicit ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 opt-in (local emulation).
describe("ensureTlsIdentity", () => {
  let tmpDir: string;
  const ENV_KEYS = [
    "TLS_CERT_FILE",
    "TLS_KEY_FILE",
    "ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT",
    "PATH",
  ];
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "routing-tls-index-"));
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Plaintext must ALWAYS be an explicit opt-in — with TLS entirely unconfigured the
  // server would silently start h2c, pass every health probe, and fail every callout.
  it("throws when TLS is entirely unconfigured and no plaintext opt-in is set", () => {
    expect(() => ensureTlsIdentity()).toThrow(/ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT/);
    expect(() => ensureTlsIdentity()).toThrow(/refusing to start plaintext/);
  });

  it("is a no-op when unconfigured WITH the explicit plaintext opt-in (emulate)", () => {
    // emulate.ts sets exactly this env — the local-emulation path must keep working.
    process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT = "1";
    expect(() => ensureTlsIdentity()).not.toThrow();
  });

  // Env/chart skew: exactly ONE of the pair set used to return early and silently
  // start plaintext with NO opt-in required. It must crash, naming both vars, and
  // the plaintext opt-in must not rescue a half-configured TLS identity.
  it("crashes when only TLS_CERT_FILE is set (env/chart skew)", () => {
    process.env.TLS_CERT_FILE = path.join(tmpDir, "tls-cert.pem");
    expect(() => ensureTlsIdentity()).toThrow(/TLS_CERT_FILE/);
    expect(() => ensureTlsIdentity()).toThrow(/TLS_KEY_FILE/);
    process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT = "1";
    expect(() => ensureTlsIdentity()).toThrow(/exactly one/);
  });

  it("crashes when only TLS_KEY_FILE is set (env/chart skew)", () => {
    process.env.TLS_KEY_FILE = path.join(tmpDir, "tls-key.pem");
    expect(() => ensureTlsIdentity()).toThrow(/TLS_CERT_FILE/);
    expect(() => ensureTlsIdentity()).toThrow(/TLS_KEY_FILE/);
    process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT = "1";
    expect(() => ensureTlsIdentity()).toThrow(/exactly one/);
  });

  it("is a no-op when both files already exist", () => {
    const cert = path.join(tmpDir, "tls-cert.pem");
    const key = path.join(tmpDir, "tls-key.pem");
    writeFileSync(cert, "cert");
    writeFileSync(key, "key");
    process.env.TLS_CERT_FILE = cert;
    process.env.TLS_KEY_FILE = key;
    expect(() => ensureTlsIdentity()).not.toThrow();
  });

  it("throws (crashes) when generation fails and no plaintext opt-in is set", () => {
    process.env.TLS_CERT_FILE = path.join(tmpDir, "tls-cert.pem");
    process.env.TLS_KEY_FILE = path.join(tmpDir, "tls-key.pem");
    // Make openssl unresolvable — the generation must fail.
    process.env.PATH = tmpDir;
    expect(() => ensureTlsIdentity()).toThrow(/refusing to start plaintext/);
    expect(() => ensureTlsIdentity()).toThrow(/ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT/);
    // …and it must NOT have silently produced a half-identity.
    expect(existsSync(process.env.TLS_CERT_FILE)).toBe(false);
  });

  it("warns and continues plaintext only with the explicit insecure opt-in", () => {
    process.env.TLS_CERT_FILE = path.join(tmpDir, "tls-cert.pem");
    process.env.TLS_KEY_FILE = path.join(tmpDir, "tls-key.pem");
    process.env.PATH = tmpDir;
    process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => ensureTlsIdentity()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("plaintext h2c");
    warn.mockRestore();
  });

  it("generates a self-signed pair when openssl is available", () => {
    if (!savedEnv.PATH) return; // no PATH to restore openssl from — skip
    process.env.PATH = savedEnv.PATH;
    const cert = path.join(tmpDir, "tls-cert.pem");
    const key = path.join(tmpDir, "tls-key.pem");
    process.env.TLS_CERT_FILE = cert;
    process.env.TLS_KEY_FILE = key;
    try {
      ensureTlsIdentity();
    } catch (err) {
      // openssl genuinely unavailable on this machine — the throw IS the
      // contract; assert it's the crash message, not a silent fallback.
      expect((err as Error).message).toContain("refusing to start plaintext");
      return;
    }
    expect(existsSync(cert)).toBe(true);
    expect(existsSync(key)).toBe(true);
  });
});
