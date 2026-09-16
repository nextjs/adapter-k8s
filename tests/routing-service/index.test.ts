import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertManifestMatchesImage, ensureTlsIdentity } from "../../src/routing-service/index.js";

// ensureTlsIdentity: a routing service that can't mint its TLS identity must CRASH
// (throw) rather than start plaintext — an h2c server passes the health probes while
// every ext_proc callout (h2+TLS only) silently fails. The only override is the
// explicit ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT=1 opt-in (local emulation).
describe("ensureTlsIdentity — ROUTING_TRANSPORT (S26)", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("serves h2c when the transport is explicitly h2c, even with TLS paths present", () => {
    // The old image-level TLS defaults meant the plaintext opt-in only applied when BOTH paths
    // were unset — so on an in-cluster gateway the service self-signed and
    // served h2 TLS while Envoy dialled h2c. MEASURED: every callout 500s while :8081 health
    // stays green, so the deployment looks fine and no request is ever routed.
    const dir = mkdtempSync(path.join(os.tmpdir(), "h2c-"));
    const cert = path.join(dir, "tls-cert.pem");
    const key = path.join(dir, "tls-key.pem");
    process.env.TLS_CERT_FILE = cert;
    process.env.TLS_KEY_FILE = key;
    process.env.ROUTING_TRANSPORT = "h2c";

    expect(() => ensureTlsIdentity()).not.toThrow();
    // The real assertion: it returned WITHOUT minting a certificate. Merely not throwing
    // would also be true if it had self-signed and served TLS — which is the bug.
    expect(existsSync(cert)).toBe(false);
    expect(existsSync(key)).toBe(false);
  });

  it("rejects an unrecognized transport rather than guessing", () => {
    process.env.ROUTING_TRANSPORT = "sslv3";
    delete process.env.TLS_CERT_FILE;
    delete process.env.TLS_KEY_FILE;
    expect(() => ensureTlsIdentity()).toThrow(/ROUTING_TRANSPORT/);
  });

  it("still refuses an accidental plaintext start when no transport is declared", () => {
    // The original guard must survive: unset TLS paths with no explicit opt-in is a
    // misconfiguration, not a request for plaintext.
    delete process.env.TLS_CERT_FILE;
    delete process.env.TLS_KEY_FILE;
    delete process.env.ROUTING_TRANSPORT;
    delete process.env.ADAPTER_K8S_ROUTING_INSECURE_PLAINTEXT;
    expect(() => ensureTlsIdentity()).toThrow(/TLS_CERT_FILE/);
  });
});

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

// ---------------------------------------------------------------------------
// S1 (SECURITY) — the mounted routing manifest must match the one the IMAGE shipped with.
//
// The routing service reads its manifest from CONFIG_DIR, which the pod spec points at the
// MUTABLE `<release>-routing-manifest` ConfigMap, while the pool reads the copy baked into its
// own image. The manifest carries the middleware matchers, so anyone with `configmaps/update`
// could rewrite them so nothing matches: the edge then stamps the TRUSTED
// `x-mw-evaluated: skip-nomatch` verdict together with the internal secret, and the pool skips
// its own middleware too — auth bypass at both tiers. BAKED_CONFIG_DIR names the staged copy at
// a path the mount cannot shadow, and a mismatch must be fatal.
// ---------------------------------------------------------------------------
describe("assertManifestMatchesImage (S1)", () => {
  let dir: string;
  let saved: string | undefined;

  const MANIFEST = {
    version: 1,
    basePath: "",
    middleware: { matchers: [{ regexp: "^/gated$", originalSource: "/gated" }] },
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "routing-manifest-pin-"));
    saved = process.env.BAKED_CONFIG_DIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BAKED_CONFIG_DIR;
    else process.env.BAKED_CONFIG_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  function write(sub: string, value: unknown): string {
    const d = path.join(dir, sub);
    mkdirSync(d, { recursive: true });
    const p = path.join(d, "routing-manifest.json");
    writeFileSync(p, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return p;
  }

  it("accepts a mounted manifest identical to the baked one", () => {
    const mounted = write("config", MANIFEST);
    process.env.BAKED_CONFIG_DIR = path.join(dir, "baked");
    write("baked", MANIFEST);
    expect(() => assertManifestMatchesImage(mounted)).not.toThrow();
  });

  it("accepts a reformatted copy — content is compared, not bytes", () => {
    // helm's block scalar and kubectl's re-serialization both reshape whitespace; a
    // byte-for-byte comparison would fail every legitimate deploy.
    const mounted = write("config", JSON.stringify(MANIFEST));
    process.env.BAKED_CONFIG_DIR = path.join(dir, "baked");
    write("baked", MANIFEST);
    expect(() => assertManifestMatchesImage(mounted)).not.toThrow();
  });

  it("REFUSES a manifest whose matchers were tampered with (the bypass)", () => {
    const tampered = {
      ...MANIFEST,
      middleware: { matchers: [{ regexp: "^/zzz-never$", originalSource: "/zzz-never" }] },
    };
    const mounted = write("config", tampered);
    process.env.BAKED_CONFIG_DIR = path.join(dir, "baked");
    write("baked", MANIFEST);
    expect(() => assertManifestMatchesImage(mounted)).toThrow(/Routing manifest mismatch/);
  });

  it("REFUSES when BAKED_CONFIG_DIR is set but the baked copy is missing (broken image)", () => {
    const mounted = write("config", MANIFEST);
    process.env.BAKED_CONFIG_DIR = path.join(dir, "absent");
    expect(() => assertManifestMatchesImage(mounted)).toThrow(/does not exist/);
  });

  it("REFUSES when either copy is unparseable rather than assuming a match", () => {
    const mounted = write("config", "{not json");
    process.env.BAKED_CONFIG_DIR = path.join(dir, "baked");
    write("baked", MANIFEST);
    expect(() => assertManifestMatchesImage(mounted)).toThrow(/Could not verify/);
  });

  it("skips verification when BAKED_CONFIG_DIR is unset (emulate/tests)", () => {
    // An attacker cannot reach this branch: the var is baked into the image and the pod runs
    // with a read-only root filesystem.
    const mounted = write("config", MANIFEST);
    delete process.env.BAKED_CONFIG_DIR;
    expect(() => assertManifestMatchesImage(mounted)).not.toThrow();
  });

  it("is a no-op when CONFIG_DIR *is* the baked dir (no mount in play)", () => {
    const baked = write("baked", MANIFEST);
    process.env.BAKED_CONFIG_DIR = path.join(dir, "baked");
    expect(() => assertManifestMatchesImage(baked)).not.toThrow();
  });
});
