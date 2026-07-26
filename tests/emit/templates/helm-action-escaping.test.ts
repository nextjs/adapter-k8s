// tests/emit/templates/helm-action-escaping.test.ts
//
// S5 (SECURITY). Everything under a chart's `templates/` directory is evaluated by Helm's Go
// template engine BEFORE the YAML is parsed. The routing manifest and the Valkey AUTH string
// are OPAQUE payloads embedded verbatim there — the manifest is built from the app's own
// `next.config` (headers/rewrites/redirects/matchers) — and `JSON.stringify` does not touch
// braces. So a response-header value of `{{ ... }}` was EXECUTED at `helm upgrade` time with
// the deployer's credentials, and `{{ lookup "v1" "Secret" … }}` reads a cluster Secret whose
// value handler.ts/dispatch.ts then serve as a response header.
//
// These tests render with REAL helm, because the whole finding is about what helm does with
// the file — a string assertion alone could not tell an escaped `{{` from an evaluated one.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderConfigMap } from "../../../src/emit/templates/configmap.js";
import { renderInternalSecret } from "../../../src/emit/templates/internal-secret.js";
import { escapeHelmActions } from "../../../src/emit/templates/utils.js";

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version", "--short"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Render one templates/ file with real helm and return stdout (or the error text). */
function helmRender(fileBody: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "helm-escape-"));
  try {
    mkdirSync(path.join(dir, "templates"));
    writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: p\nversion: 0.0.0\n");
    writeFileSync(path.join(dir, "values.yaml"), "");
    writeFileSync(path.join(dir, "templates", "obj.yaml"), fileBody);
    try {
      return { ok: true, out: execFileSync("helm", ["template", "p", dir], { encoding: "utf8" }) };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      return { ok: false, out: String(e.stderr ?? e.message ?? "") };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("escapeHelmActions", () => {
  it("leaves text with no template action untouched (byte-identical)", () => {
    for (const v of ["", "plain", '{"a":1}', "a { b } c", "}}"]) {
      expect(escapeHelmActions(v)).toBe(v);
    }
  });

  it("rewrites every `{{`, not just the first", () => {
    expect(escapeHelmActions("{{a}} {{b}}")).toBe('{{ "{{" }}a}} {{ "{{" }}b}}');
  });
});

describe.skipIf(!helmAvailable())("real helm: opaque chart data is inert (S5)", () => {
  it("REGRESSION: an unescaped action in a ConfigMap value is executed by helm", () => {
    // The vulnerability itself, rendered — this is what the fix has to prevent. Built by
    // hand (not through renderConfigMap) so the assertion cannot silently pass if the
    // escaping is removed from the renderer.
    const body =
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: probe\ndata:\n" +
      "  routing-manifest.json: |\n    {\n      \"value\": \"{{ mul 7 6 }}\"\n    }\n";
    const { ok, out } = helmRender(body);
    expect(ok).toBe(true);
    expect(out).toContain('"42"'); // evaluated — the primitive is real
  });

  it("renderConfigMap emits the action as LITERAL TEXT", () => {
    const manifest = JSON.stringify(
      {
        headers: [
          { key: "x-arith", value: "{{ mul 7 6 }}" },
          { key: "x-lookup", value: '{{ index (lookup "v1" "Secret" "ns" "n").data "token" }}' },
        ],
      },
      null,
      2,
    );
    const { ok, out } = helmRender(
      renderConfigMap({
        name: "routing-manifest",
        releaseName: "nextjs",
        data: { "routing-manifest.json": manifest },
      }),
    );
    expect(ok).toBe(true);
    // Rendered output is byte-identical to what the app configured…
    expect(out).toContain("{{ mul 7 6 }}");
    // (the inner quotes arrive JSON-escaped, which is exactly how they were configured)
    expect(out).toContain('{{ index (lookup \\"v1\\" \\"Secret\\" \\"ns\\" \\"n\\").data');
    // …and nothing was evaluated.
    expect(out).not.toContain('"42"');
  });

  it("the Secret template is inert too (its value comes from gcloud output)", () => {
    const { ok, out } = helmRender(
      renderInternalSecret({ releaseName: "nextjs", secret: "{{ mul 7 6 }}" }),
    );
    expect(ok).toBe(true);
    expect(out).toContain("{{ mul 7 6 }}");
    expect(out).not.toContain("42");
  });

  it("a value that legitimately contains braces survives unchanged", () => {
    // Escaping (not rejecting) is the point: `{{` in an app's own config is legal and must
    // not fail the build or come out mangled.
    const css = "{{--brand}} and {{--accent}}";
    const { ok, out } = helmRender(
      renderConfigMap({ name: "c", releaseName: "nextjs", data: { "k.json": css } }),
    );
    expect(ok).toBe(true);
    expect(out).toContain(css);
  });
});
