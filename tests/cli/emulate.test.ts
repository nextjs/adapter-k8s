// S20: `emulate --port N` renders a port-substituted copy of the checked-in Envoy config.
// That copy used to land at the PREDICTABLE, world-known path /tmp/adapter-k8s-envoy-<port>.yaml
// via a plain writeFileSync — no exclusive create, no O_NOFOLLOW, no private directory. On a
// shared host another local user can pre-place a symlink at that name (a sticky /tmp stops them
// deleting your files, not creating a name that does not exist yet) and the operator's own
// emulate run then writes Envoy YAML through it, clobbering whatever the operator can write.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EMULATE_ENVOY_IMAGE,
  EMULATE_LISTEN_HOST,
  EMULATE_VALKEY_IMAGE,
  renderEnvoyConfigForPort,
} from "../../src/cli/emulate.js";

const SOURCE = `static_resources:
  listeners:
    - address:
        socket_address: { address: 0.0.0.0, port_value: 8080 }
  clusters:
    - name: pool
      load_assignment:
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { socket_address: { address: 127.0.0.1, port_value: 3000 } } }
    - name: routing
      load_assignment:
        endpoints:
          - lb_endpoints:
              - endpoint: { address: { socket_address: { address: 127.0.0.1, port_value: 8443 } } }
`;

describe("renderEnvoyConfigForPort", () => {
  let tmpDir: string;
  let source: string;
  const rendered: string[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-emulate-test-"));
    source = path.join(tmpDir, "envoy.yaml");
    writeFileSync(source, SOURCE);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const r of rendered.splice(0)) rmSync(path.dirname(r), { recursive: true, force: true });
  });

  it("substitutes only the listener port, leaving the cluster ports alone", () => {
    const out = renderEnvoyConfigForPort(source, 9000);
    rendered.push(out);
    const yaml = readFileSync(out, "utf-8");
    expect(yaml).toContain("port_value: 9000");
    expect(yaml).toContain("port_value: 3000"); // pool cluster, untouched
    expect(yaml).toContain("port_value: 8443"); // routing cluster, untouched
    expect(yaml).not.toContain("port_value: 8080");
  });

  it("refuses to render when the source no longer has exactly one listener port", () => {
    writeFileSync(source, SOURCE + "        # port_value: 8080\n");
    expect(() => renderEnvoyConfigForPort(source, 9000)).toThrow(/expected exactly one/);
  });

  it("does NOT write through a symlink pre-placed at the predictable /tmp path", () => {
    const canary = path.join(tmpDir, "canary.txt");
    writeFileSync(canary, "operator data");
    const predictable = path.join(os.tmpdir(), `adapter-k8s-envoy-9101.yaml`);
    if (existsSync(predictable)) rmSync(predictable, { force: true });
    symlinkSync(canary, predictable);
    try {
      const out = renderEnvoyConfigForPort(source, 9101);
      rendered.push(out);
      expect(readFileSync(canary, "utf-8")).toBe("operator data");
      expect(out).not.toBe(predictable);
    } finally {
      rmSync(predictable, { force: true });
    }
  });

  it("writes into a fresh private directory, and two runs never collide", () => {
    const a = renderEnvoyConfigForPort(source, 9000);
    const b = renderEnvoyConfigForPort(source, 9000);
    rendered.push(a, b);
    expect(path.dirname(a)).not.toBe(path.dirname(b));
    // 0o700 — no group/other access to the operator's rendered config.
    expect(statSync(path.dirname(a)).mode & 0o077).toBe(0);
  });

  it("returns the source path unchanged for the default port", () => {
    expect(renderEnvoyConfigForPort(source, 8080)).toBe(source);
  });

  it("returns the source path unchanged when the source does not exist", () => {
    const missing = path.join(tmpDir, "nope", "envoy.yaml");
    mkdirSync(path.dirname(missing), { recursive: true });
    expect(renderEnvoyConfigForPort(missing, 9000)).toBe(missing);
  });
});

describe("emulation security defaults", () => {
  it("binds the checked-in Envoy listener to loopback", () => {
    const yaml = readFileSync(new URL("../../integration/envoy.yaml", import.meta.url), "utf8");
    expect(EMULATE_LISTEN_HOST).toBe("127.0.0.1");
    expect(yaml).toContain(`address: ${EMULATE_LISTEN_HOST}`);
    expect(yaml).not.toContain("address: 0.0.0.0");
  });

  it.each([EMULATE_ENVOY_IMAGE, EMULATE_VALKEY_IMAGE])(
    "pins emulation image %s to an immutable digest",
    (image) => {
      expect(image).toMatch(/^[^@]+@sha256:[0-9a-f]{64}$/);
    },
  );
});
