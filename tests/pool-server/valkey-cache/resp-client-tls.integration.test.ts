import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createValkeyClient,
  type ValkeyClient,
} from "../../../src/pool-server/valkey-cache/client.js";
import { ValkeyIncrementalCacheHandler } from "../../../src/pool-server/valkey-cache/incremental-cache-handler.js";
import { createRespClient } from "../../../src/pool-server/valkey-cache/resp-client.js";
import { bufferToStream } from "../../../src/pool-server/valkey-cache/stream-codec.js";
import {
  computeTagUpdate,
  MAX_CLOCK_SKEW_MS,
  TAG_MANIFEST_TTL_SECONDS,
  UPDATE_TAGS_SCRIPT,
} from "../../../src/pool-server/valkey-cache/tag-manifest.js";
import type { CacheEntry } from "../../../src/pool-server/valkey-cache/types.js";
import { ValkeyCacheHandler } from "../../../src/pool-server/valkey-cache/use-cache-handler.js";

// The `rediss://` (TLS) variant of the plaintext integration suites: the SAME paths those cover —
// RESP round-trips, the tag-manifest `updateTags` EVAL, cross-replica revalidation through both
// handlers — but over a real TLS handshake to a real Valkey configured with `--tls-port`. The unit
// suite (resp-client.test.ts) exercises TLS against an in-process `tls.createServer`; nothing
// before this ran our client's TLS path against an actual Valkey TLS listener.
//
// Both production endpoint shapes are covered, because they take DIFFERENT code paths in
// `connect()`:
//   - a DNS hostname → SNI (`servername`) is sent;
//   - an IP literal   → SNI is deliberately OMITTED (L18). This is Memorystore's normal endpoint
//     shape (a VPC IP), so it is the shape that matters most in production.
//
// The IP case is asserted ON THE WIRE (see `startSniProbe`) rather than only behaviorally. On
// Node 20/22/24 an IP `servername` does NOT fail the handshake — it emits DEP0123 and is still
// sent — so "the IP endpoint connects" would keep passing even if the L18 skip were deleted.
// Reading the ClientHello is the only version-independent guard.
//
// Certs are minted per-run with `openssl` (same pattern as resp-client.test.ts and
// routing-service/server.test.ts) into an mkdtemp dir and mounted read-only into the container.
// Two leaf certs off one throwaway CA, each with a DELIBERATELY narrow SAN, so that a wrong-shape
// connection is a hostname-verification failure rather than a silent pass:
//   - `dns` cert: `subjectAltName=DNS:localhost` only  → serves the hostname endpoint;
//   - `ip`  cert: `subjectAltName=IP:127.0.0.1` only   → serves the IP-literal endpoint.

function docker(args: string[]): string {
  return (
    execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || ""
  ).trim();
}

/** `docker logs` merged across both streams (valkey logs to stdout, its warnings to stderr). */
function dockerLogs(name: string): string {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

let dockerAvailable = false;
try {
  docker(["ps"]);
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

let opensslAvailable = false;
try {
  execFileSync("openssl", ["version"], { stdio: ["ignore", "ignore", "ignore"] });
  opensslAvailable = true;
} catch {
  opensslAvailable = false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** AUTH string on the IP-endpoint server — the Memorystore shape is auth string + TLS + VPC IP. */
const TLS_PASSWORD = "tls-auth-string";

function mintCa(dir: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path.join(dir, "ca.key"),
      "-out",
      path.join(dir, "ca.crt"),
      "-days",
      "1",
      "-subj",
      "/CN=adapter-k8s-test-valkey-ca",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/** Mint a leaf cert signed by the throwaway CA with exactly the SAN given (e.g. `DNS:localhost`). */
function mintLeaf(dir: string, name: string, subject: string, san: string): void {
  const key = path.join(dir, `${name}.key`);
  const csr = path.join(dir, `${name}.csr`);
  const crt = path.join(dir, `${name}.crt`);
  const ext = path.join(dir, `${name}.ext`);
  execFileSync(
    "openssl",
    ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", subject],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  writeFileSync(ext, `subjectAltName=${san}\n`);
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      path.join(dir, "ca.crt"),
      "-CAkey",
      path.join(dir, "ca.key"),
      "-out",
      crt,
      "-days",
      "1",
      "-extfile",
      ext,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/**
 * Start `valkey/valkey:8-alpine` as a TLS-ONLY listener (`--port 0 --tls-port 6379`) and return
 * the published host port. `--tls-auth-clients no` because the client presents no cert (Memorystore
 * in-transit encryption is likewise server-auth only).
 *
 * Runs as the invoking uid/gid: openssl writes the private key 0600, and the image otherwise drops
 * to uid 999 (`valkey`) and could not read it — the alternative would be chmodding a private key
 * world-readable on the host. `--save ''` disables RDB so the non-root user never needs to write
 * /data (owned by uid 999 in the image).
 */
function startTlsValkey(name: string, dir: string, certName: string, extraArgs: string[]): number {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    ...(uid !== undefined && gid !== undefined ? ["--user", `${uid}:${gid}`] : []),
    "-v",
    `${dir}:/tls:ro`,
    "-p",
    "127.0.0.1::6379",
    "valkey/valkey:8-alpine",
    "--port",
    "0",
    "--tls-port",
    "6379",
    "--tls-cert-file",
    `/tls/${certName}.crt`,
    "--tls-key-file",
    `/tls/${certName}.key`,
    "--tls-ca-cert-file",
    "/tls/ca.crt",
    "--tls-auth-clients",
    "no",
    "--save",
    "",
    ...extraArgs,
  ]);
  return Number(docker(["port", name, "6379/tcp"]).split("\n")[0].split(":").pop());
}

/**
 * Wait until a TLS command actually completes against `url` — readiness is proven through our own
 * client (handshake + AUTH + GET), not by scraping logs, so a cert/config mistake surfaces here
 * with the container's log attached instead of as a mystery failure in the first test.
 */
async function waitTlsReady(
  name: string,
  url: string,
  caCert: string,
  password?: string,
): Promise<void> {
  let last = "";
  for (let i = 0; i < 100; i++) {
    const probe = createRespClient({
      url,
      caCert,
      password,
      connectTimeoutMs: 1000,
      circuitBreakerMs: 0,
    });
    try {
      await probe.get("__tls_ready__");
      await probe.quit();
      return;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await probe.quit().catch(() => undefined);
    }
    await sleep(200);
  }
  throw new Error(
    `${name} never accepted a TLS command (last error: ${last})\n${dockerLogs(name)}`,
  );
}

/**
 * Extract the SNI `host_name` from a TLS ClientHello record: a string when the server_name
 * extension is present, `null` when it is absent (or the bytes aren't a ClientHello at all), and
 * `undefined` while the record is still incomplete.
 */
export function readClientHelloSni(buf: Buffer): string | null | undefined {
  if (buf.length < 5) return undefined;
  if (buf[0] !== 0x16) return null; // not a handshake record
  const recordEnd = 5 + buf.readUInt16BE(3);
  if (buf.length < recordEnd) return undefined;
  let p = 5;
  if (buf[p] !== 0x01) return null; // not client_hello
  p += 4; // handshake type (1) + length (3)
  p += 2; // client_version
  p += 32; // random
  p += 1 + buf[p]!; // session_id
  p += 2 + buf.readUInt16BE(p); // cipher_suites
  p += 1 + buf[p]!; // compression_methods
  if (p + 2 > recordEnd) return null; // no extension block at all
  const extEnd = Math.min(recordEnd, p + 2 + buf.readUInt16BE(p));
  p += 2;
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p);
    const len = buf.readUInt16BE(p + 2);
    const body = p + 4;
    if (type === 0x0000) {
      // server_name: list length (2) + name_type (1, 0 = host_name) + name length (2) + name
      const nameLen = buf.readUInt16BE(body + 3);
      return buf.toString("utf8", body + 5, body + 5 + nameLen);
    }
    p = body + len;
  }
  return null;
}

interface SniProbe {
  port: number;
  /** Resolves with the SNI of the first connection: the host_name, or null when absent. */
  sni: Promise<string | null>;
  close: () => Promise<void>;
}

/**
 * A transparent TCP relay in front of `targetPort` that records the ClientHello's SNI. TLS still
 * terminates at the real Valkey — the relay never decrypts anything, it only reads the (cleartext)
 * handshake header on the way past.
 */
function startSniProbe(targetPort: number): Promise<SniProbe> {
  let resolveSni!: (value: string | null) => void;
  const sni = new Promise<string | null>((r) => {
    resolveSni = r;
  });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => undefined);
    const upstream = net.connect({ host: "127.0.0.1", port: targetPort });
    sockets.add(upstream);
    upstream.on("error", () => undefined);
    let head: Buffer = Buffer.alloc(0);
    let decided = false;
    client.on("data", (chunk: Buffer) => {
      if (!decided) {
        head = Buffer.concat([head, chunk]);
        const found = readClientHelloSni(head);
        if (found !== undefined) {
          decided = true;
          resolveSni(found);
        }
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => client.write(chunk));
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        sni,
        close: () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function makeEntry(
  text: string,
  opts: { tags?: string[]; timestamp: number; revalidate?: number; expire?: number },
): CacheEntry {
  return {
    value: bufferToStream(Buffer.from(text, "utf8")),
    tags: opts.tags ?? [],
    stale: 300,
    timestamp: opts.timestamp,
    expire: opts.expire ?? 300,
    revalidate: opts.revalidate ?? 60,
  };
}

async function readStream(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A representative APP_PAGE (PPR shell) entry, matching the plaintext incremental suite. */
function appPageEntry(html: string, tag: string): Record<string, unknown> {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`rsc:${html}`),
    status: 200,
    postponed: "postponed-token",
    headers: { "x-next-cache-tags": tag },
    segmentData: new Map([["/_index", Buffer.from(`seg:${html}`)]]),
  };
}

// The Docker-gated L18 test asserts `sni === null`. That assertion is only meaningful if the
// parser can actually SEE an SNI when one is sent — a parser that always returned null would make
// it pass vacuously forever. These cases pin both directions against ClientHellos produced by the
// real `tls.connect` (no Docker needed), including the IP `servername` shape that IS the L18
// regression: on Node 20/22/24 that value is sent on the wire (DEP0123, not an error), so the
// parser must report it.
describe("readClientHelloSni (guards the L18 wire assertion from going vacuous)", () => {
  async function sniOf(options: tls.ConnectionOptions): Promise<string | null> {
    let resolveSni!: (value: string | null) => void;
    const seen = new Promise<string | null>((r) => {
      resolveSni = r;
    });
    const server = net.createServer((socket) => {
      let head: Buffer = Buffer.alloc(0);
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        head = Buffer.concat([head, chunk]);
        const found = readClientHelloSni(head);
        if (found !== undefined) {
          resolveSni(found);
          socket.destroy();
        }
      });
    });
    const port = await new Promise<number>((r) => {
      server.listen(0, "127.0.0.1", () => r((server.address() as net.AddressInfo).port));
    });
    let socket: tls.TLSSocket | undefined;
    try {
      socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, ...options });
      socket.on("error", () => undefined);
      return await seen;
    } finally {
      socket?.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it("reports the host_name when servername is a DNS name", async () => {
    expect(await sniOf({ servername: "valkey.example.internal" })).toBe("valkey.example.internal");
  });

  it("reports an IP servername when the Node runtime permits sending one", async () => {
    try {
      expect(await sniOf({ servername: "10.1.2.3" })).toBe("10.1.2.3");
    } catch (error) {
      // Node 26 upgraded DEP0123 from a warning to a TypeError. That is a stronger runtime
      // guarantee than L18 needs; Node 20/22/24 still exercise the ClientHello parser above.
      expect(error).toBeInstanceOf(TypeError);
      expect(String(error)).toContain(
        "Setting the TLS ServerName to an IP address is not permitted",
      );
    }
  });

  it("reports null when no servername is set (the L18 shape)", async () => {
    // `host` is an IP literal, so Node derives no implicit servername from it.
    expect(await sniOf({})).toBeNull();
  });

  it("returns undefined while the ClientHello record is still incomplete", () => {
    expect(readClientHelloSni(Buffer.from([0x16, 0x03, 0x01]))).toBeUndefined();
    expect(readClientHelloSni(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x40, 0x01]))).toBeUndefined();
  });
});

describe.skipIf(!dockerAvailable || !opensslAvailable)(
  "rediss:// TLS against a real Valkey TLS listener (integration)",
  () => {
    const dnsContainer = `adapter-k8s-tls-dns-${process.pid}`;
    const ipContainer = `adapter-k8s-tls-ip-${process.pid}`;
    let tlsDir = "";
    let otherCaDir = "";
    /** PEM of the CA both server certs chain to — the `caCert` the client pins against. */
    let ca = "";
    /** PEM of an unrelated CA, for the negative control. */
    let wrongCa = "";
    let dnsPort = 0;
    let ipPort = 0;
    /** `rediss://localhost:<port>` — a DNS hostname, so the client sends SNI. */
    let hostUrl = "";
    /** `rediss://127.0.0.1:<port>` — an IP literal, so the client must NOT send SNI (L18). */
    let ipUrl = "";
    const clients: ValkeyClient[] = [];
    const probes: SniProbe[] = [];

    const newClient = (url: string, password?: string) => {
      const c = createValkeyClient({ url, caCert: ca, password });
      clients.push(c);
      return c;
    };

    beforeAll(async () => {
      tlsDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-valkey-tls-"));
      otherCaDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-valkey-tls-otherca-"));
      mintCa(tlsDir);
      mintCa(otherCaDir);
      // Narrow SANs on purpose: each server accepts only its own endpoint shape.
      mintLeaf(tlsDir, "dns", "/CN=localhost", "DNS:localhost");
      mintLeaf(tlsDir, "ip", "/CN=127.0.0.1", "IP:127.0.0.1");
      ca = readFileSync(path.join(tlsDir, "ca.crt"), "utf8");
      wrongCa = readFileSync(path.join(otherCaDir, "ca.crt"), "utf8");

      dnsPort = startTlsValkey(dnsContainer, tlsDir, "dns", []);
      ipPort = startTlsValkey(ipContainer, tlsDir, "ip", ["--requirepass", TLS_PASSWORD]);
      hostUrl = `rediss://localhost:${dnsPort}`;
      ipUrl = `rediss://127.0.0.1:${ipPort}`;
      await waitTlsReady(dnsContainer, hostUrl, ca);
      await waitTlsReady(ipContainer, ipUrl, ca, TLS_PASSWORD);
    }, 120_000);

    afterAll(async () => {
      await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
      await Promise.all(probes.map((p) => p.close().catch(() => undefined)));
      for (const name of [dnsContainer, ipContainer]) {
        try {
          docker(["rm", "-f", name]);
        } catch {
          /* already gone */
        }
      }
      for (const dir of [tlsDir, otherCaDir]) {
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });

    it("HOSTNAME endpoint: handshakes, round-trips GET/SET/TTL/DEL over TLS", async () => {
      const c = newClient(hostUrl);
      expect(await c.get("tls:nope")).toBeNull();
      expect(await c.set("tls:k", "v", "EX", 100)).toBe("OK");
      expect(await c.get("tls:k")).toBe("v");
      expect(await c.ttl("tls:k")).toBeGreaterThan(90);
      expect(await c.del("tls:k")).toBe(1);
      expect(await c.get("tls:k")).toBeNull();
    });

    it("IP-LITERAL endpoint (the Memorystore shape): AUTHs over TLS, then round-trips", async () => {
      // rediss:// + an auth string + a bare VPC IP is exactly what Memorystore-for-Valkey with
      // in-transit encryption presents. AUTH must land before the concurrent cold commands.
      const c = newClient(ipUrl, TLS_PASSWORD);
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => c.set(`tls:ip:${i}`, String(i))),
      );
      expect(results.every((r) => r === "OK")).toBe(true);
      expect(await c.get("tls:ip:7")).toBe("7");
    });

    it("reassembles values spanning many TLS records (binary + 500 KB) over TLS", async () => {
      // TLS chunks the stream into ~16 KiB records with its own framing, so the inbound
      // reassembly path (M6b) sees a different chunk pattern than on plaintext.
      const c = newClient(hostUrl);
      const payload = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x24, 0x2a, 0x00]);
      await c.hset("tls:h", "v", payload);
      const got = await c.hgetallBuffer("tls:h");
      expect(Buffer.isBuffer(got.v)).toBe(true);
      expect(got.v!.equals(payload)).toBe(true);

      const big = "x".repeat(500_000);
      await c.set("tls:big", big);
      expect(await c.get("tls:big")).toBe(big);
    });

    it("runs the tag-manifest UPDATE_TAGS_SCRIPT EVAL over TLS, skew count included", async () => {
      // The same N78 rebase branch the plaintext suite covers, driven over TLS: a client clock
      // 120s ahead must come back rebased onto the SERVER clock with `clamped == 1`.
      const c = newClient(hostUrl);
      const key = "k8s:tls-skew:tags";
      const clientNow = Date.now() + 120_000;
      const event = JSON.stringify(computeTagUpdate(undefined, clientNow));
      const before = Date.now();
      const clamped = await c.eval(
        UPDATE_TAGS_SCRIPT,
        1,
        key,
        "t",
        event,
        String(TAG_MANIFEST_TTL_SECONDS),
      );
      const after = Date.now();
      expect(Number(clamped)).toBe(1);
      const stored = JSON.parse((await c.hmget(key, "t"))[0]!);
      expect(stored.expired).toBeGreaterThanOrEqual(before - 5);
      expect(stored.expired).toBeLessThanOrEqual(after + 5);
      expect(stored.expired).toBeLessThan(clientNow - MAX_CLOCK_SKEW_MS);
      expect(await c.ttl(key)).toBeGreaterThan(29 * 24 * 60 * 60); // M11 TTL applied over TLS too
    });

    it("V2 handler over TLS: set/get, updateTags/getExpiration, and cross-replica revalidation", async () => {
      // N78: the manifest is stamped from Valkey's own TIME, so the injected clocks track the real
      // clock and the entry is written 5s "ago" (a sub-millisecond client-vs-server margin would
      // be a coin flip).
      const t0 = Date.now();
      const clock = { t: t0 };
      const a = new ValkeyCacheHandler({
        client: newClient(hostUrl),
        buildId: "tls-v2",
        now: () => clock.t,
      });
      const b = new ValkeyCacheHandler({
        client: newClient(hostUrl), // a second TLS connection = a second replica
        buildId: "tls-v2",
        now: () => clock.t,
      });

      await a.set(
        "page",
        Promise.resolve(makeEntry("v1", { timestamp: t0 - 5000, tags: ["tls-tag"] })),
      );
      const fresh = await b.get("page", []);
      expect(fresh).toBeDefined();
      expect(fresh?.revalidate).toBe(60);
      expect(await readStream(fresh!.value)).toBe("v1");

      // Profiled revalidation: a future `expired` watermark is reported but does not drop the entry.
      clock.t = t0 + 1000;
      await a.updateTags(["tls-tag"], { expire: 300 });
      const expiration = await b.getExpiration(["tls-tag"]);
      expect(expiration).toBeGreaterThanOrEqual(t0 + 300_000 - 50);
      expect(expiration).toBeLessThanOrEqual(Date.now() + 300_000 + 50);
      expect((await b.get("page", []))?.revalidate).toBe(-1); // stale, still served

      // Hard revalidation on A is visible LIVE on B (no refreshTags) — the whole point of the
      // shared manifest, now proven over TLS.
      clock.t = t0 + 2000;
      await a.updateTags(["tls-tag"]);
      expect(await b.get("page", [])).toBeUndefined();
    });

    it("incremental handler over TLS (IP endpoint): revalidateTag on A drops the shell on B", async () => {
      // N78: see the V2-over-TLS note — anchored clocks, entry written 5s "ago".
      const offset = { ms: -5000 };
      const a = new ValkeyIncrementalCacheHandler({
        client: newClient(ipUrl, TLS_PASSWORD),
        buildId: "tls-inc",
        now: () => Date.now() + offset.ms,
      });
      const b = new ValkeyIncrementalCacheHandler({
        client: newClient(ipUrl, TLS_PASSWORD),
        buildId: "tls-inc",
        now: () => Date.now() + offset.ms,
      });

      await a.set("/shell", appPageEntry("SHELL-TLS", "catalog"), {});
      const got = await b.get("/shell", {});
      expect(got).not.toBeNull();
      const value = got!.value as Record<string, unknown>;
      expect(value.html).toBe("SHELL-TLS");
      expect((value.rscData as Buffer).toString()).toBe("rsc:SHELL-TLS");
      expect(((value.segmentData as Map<string, Buffer>).get("/_index") as Buffer).toString()).toBe(
        "seg:SHELL-TLS",
      );

      offset.ms = 0;
      await a.revalidateTag("catalog");
      offset.ms = 1000;
      expect(await b.get("/shell", {})).toBeNull();
    });

    it("sends SNI for a DNS hostname endpoint", async () => {
      const probe = await startSniProbe(dnsPort);
      probes.push(probe);
      const c = createRespClient({ url: `rediss://localhost:${probe.port}`, caCert: ca });
      try {
        expect(await c.set("tls:sni", "yes")).toBe("OK"); // handshake + command actually worked
        await expect(probe.sni).resolves.toBe("localhost");
      } finally {
        await c.quit();
        await probe.close();
      }
    });

    it("L18: omits SNI for an IP-literal endpoint (asserted on the wire)", async () => {
      // The regression guard. Node 20/22/24 do NOT reject an IP `servername` — they emit DEP0123
      // and send it anyway — so only reading the ClientHello proves the skip is still in place.
      // RFC 6066 forbids an IP SNI, and the deprecation says it will stop being sent entirely.
      const probe = await startSniProbe(ipPort);
      probes.push(probe);
      const c = createRespClient({
        url: `rediss://127.0.0.1:${probe.port}`,
        caCert: ca,
        password: TLS_PASSWORD,
      });
      try {
        expect(await c.set("tls:sni:ip", "yes")).toBe("OK");
        await expect(probe.sni).resolves.toBeNull(); // no server_name extension at all
      } finally {
        await c.quit();
        await probe.close();
      }
    });

    it("NEGATIVE: pinning an unrelated CA fails the handshake, no command reaches the server", async () => {
      const mistrusting = createRespClient({ url: hostUrl, caCert: wrongCa, circuitBreakerMs: 0 });
      try {
        await expect(mistrusting.set("tls:never", "written")).rejects.toThrow(/certificate/i);
      } finally {
        await mistrusting.quit();
      }
      // Verification happens before AUTH/commands, so nothing was written.
      expect(await newClient(hostUrl).get("tls:never")).toBeNull();
    });

    it("NEGATIVE: hostname verification is live — an IP URL against the DNS-only-SAN cert is refused", async () => {
      // Same server as the hostname endpoint, addressed by IP: the cert has no IP SAN, so
      // verification must reject. Proves the TLS path is not running with verification disabled
      // (which would make every positive case above meaningless).
      const c = createRespClient({
        url: `rediss://127.0.0.1:${dnsPort}`,
        caCert: ca,
        circuitBreakerMs: 0,
      });
      try {
        await expect(c.get("x")).rejects.toThrow(/altnames|does not match/i);
      } finally {
        await c.quit();
      }
    });
  },
);
