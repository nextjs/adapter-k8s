import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  renderNetworkPolicies,
  GFE_PROXY_CIDRS,
  HEALTH_CHECK_PROBE_CIDRS,
  STRICT_INGRESS_CIDRS,
} from "../../../src/emit/templates/network-policy.js";

type Values = { podCidrs?: string[]; strict?: boolean; nodeCidrs?: string[] };

// Minimal evaluator for the helm constructs this template emits: the top-level
// `{{- if or .podCidrs .strict }}` guard, the `{{- if and .strict (not .nodeCidrs) }}`
// + `{{- fail }}` guard, the `{{- if .strict }}…{{- else }}…{{- end }}` posture switch,
// and `{{- range }}` loops over the CIDR lists. (`{{-` trims the adjacent newline, which
// is mirrored by dropping directive lines entirely.) The SAME template is also rendered
// by real helm in the helm-gated describe at the bottom of this file — that is what
// keeps this stand-in honest.
function helmRender(template: string, values: Values = {}): string {
  const v = { podCidrs: [] as string[], strict: false, nodeCidrs: [] as string[], ...values };
  const lookup = (p: string): string[] | boolean => {
    const m = /^\.Values\.global\.networkPolicy\.(podCidrs|strict|nodeCidrs)$/.exec(p);
    if (!m) throw new Error(`unsupported helm path in template: ${p}`);
    return v[m[1] as "podCidrs" | "strict" | "nodeCidrs"];
  };
  const truthy = (x: string[] | boolean) => (Array.isArray(x) ? x.length > 0 : x === true);
  const cond = (expr: string): boolean => {
    let m: RegExpExecArray | null;
    if ((m = /^or (\S+) (\S+)$/.exec(expr))) return truthy(lookup(m[1]!)) || truthy(lookup(m[2]!));
    if ((m = /^and (\S+) \(not (\S+)\)$/.exec(expr)))
      return truthy(lookup(m[1]!)) && !truthy(lookup(m[2]!));
    return truthy(lookup(expr));
  };

  const lines = template.split("\n");
  let i = 0;
  const block = (emit: boolean): { out: string[]; term: "end" | "else" } => {
    const out: string[] = [];
    while (i < lines.length) {
      const line = lines[i]!;
      const m = /^\{\{-\s*(if|else|end|range|fail)\s*(.*?)\s*\}\}$/.exec(line);
      if (!m) {
        if (emit) out.push(line);
        i++;
        continue;
      }
      const kw = m[1]!;
      const arg = m[2]!;
      i++;
      if (kw === "end") return { out, term: "end" };
      if (kw === "else") return { out, term: "else" };
      if (kw === "fail") {
        if (emit) throw new Error(JSON.parse(arg) as string);
        continue;
      }
      if (kw === "if") {
        const take = emit && cond(arg);
        const first = block(take);
        if (first.term === "else") {
          const second = block(emit && !cond(arg));
          out.push(...(take ? first.out : second.out));
        } else {
          out.push(...first.out);
        }
        continue;
      }
      // range
      const bodyStart = i;
      block(false); // scan to the matching end
      const endIdx = i;
      if (emit) {
        for (const item of lookup(arg) as string[]) {
          i = bodyStart;
          out.push(
            ...block(true).out.map((l) => l.replace("{{ . | quote }}", JSON.stringify(item))),
          );
        }
      }
      i = endIdx;
      continue;
    }
    return { out, term: "end" };
  };

  const { out } = block(true);
  // The template's trailing newline leaves a blank line after the top-level `{{- end }}`;
  // helm emits no document at all in that case.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** Every `cidr:` value in a rendered document, in order. */
function cidrsOf(doc: string): string[] {
  return [...doc.matchAll(/^\s*(?:cidr: |- )"?((?:\d|2[0-9a-f]|[0-9a-f]*:)[^"\n]*\/\d+)"?$/gm)].map(
    (m) => m[1]!,
  );
}

/** The `- ipBlock:\n cidr: X` values of one ingress rule block. */
function ipBlocksOf(ruleBlock: string): string[] {
  return [...ruleBlock.matchAll(/- ipBlock:\n\s+cidr: "?([^"\n]+)"?/g)].map((m) => m[1]!);
}

/** Split a policy document's `ingress:` section into its `- from:` rules. */
function ingressRules(doc: string): string[] {
  const body = doc.slice(doc.indexOf("\n  ingress:\n") + "\n  ingress:\n".length);
  return body
    .split(/\n(?=    - from:)/)
    .map((r) => r.trim())
    .filter((r) => r.startsWith("- from:"));
}

describe("renderNetworkPolicies — documented ingress ranges (N19)", () => {
  // These CIDRs are the whole point of the strict posture; a future edit must not widen
  // them without changing this test (and re-reading the docs cited in N19).
  //   https://docs.cloud.google.com/load-balancing/docs/firewall-rules
  //   https://docs.cloud.google.com/load-balancing/docs/health-check-concepts
  it("pins the GFE proxy ranges for a global external ALB with zonal NEG backends", () => {
    expect([...GFE_PROXY_CIDRS]).toEqual(["35.191.0.0/16", "130.211.0.0/22", "2600:2d00:1:1::/64"]);
  });

  it("pins the health-check prober ranges for GFE-based load balancers", () => {
    expect([...HEALTH_CHECK_PROBE_CIDRS]).toEqual(["35.191.0.0/16", "2600:2d00:1:b029::/64"]);
  });

  it("emits the de-duplicated union, and nothing broader", () => {
    expect([...STRICT_INGRESS_CIDRS]).toEqual([
      "35.191.0.0/16",
      "130.211.0.0/22",
      "2600:2d00:1:1::/64",
      "2600:2d00:1:b029::/64",
    ]);
    // No duplicates, and no range wider than the documented ones (a /0 or a private
    // supernet slipping in here would silently reopen the policy).
    expect(new Set(STRICT_INGRESS_CIDRS).size).toBe(STRICT_INGRESS_CIDRS.length);
    for (const cidr of STRICT_INGRESS_CIDRS) {
      expect(cidr).not.toMatch(/\/0$/);
      expect(cidr).not.toMatch(/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/);
    }
  });
});

describe("renderNetworkPolicies — default (broad) posture", () => {
  it("wraps the whole file in a podCidrs-or-strict guard so empty values render nothing", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    expect(template).toMatch(
      /^\{\{- if or \.Values\.global\.networkPolicy\.podCidrs \.Values\.global\.networkPolicy\.strict \}\}/,
    );
    expect(template).toMatch(/\{\{- end \}\}\n?$/);
    expect(helmRender(template, {})).toBe("");
  });

  it("renders a routing-service policy allowing only non-pod (LB/health-check) ingress", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    const yaml = helmRender(template, { podCidrs: ["10.8.0.0/14", "10.12.0.0/14"] });

    const routingDoc = yaml.slice(0, yaml.indexOf("---"));
    expect(routingDoc).toContain("kind: NetworkPolicy");
    expect(routingDoc).toContain("name: my-app-routing-service");
    // Selects the routing-service pods by their deployment labels.
    expect(routingDoc).toMatch(
      /podSelector:\n    matchLabels:\n      app\.kubernetes\.io\/name: my-app\n      app\.kubernetes\.io\/component: routing-service/,
    );
    // Ingress from anywhere EXCEPT the pod CIDRs (LB + Google health checks arrive with
    // non-pod source IPs; in-cluster pods are blocked).
    expect(routingDoc).toContain("cidr: 0.0.0.0/0");
    expect(routingDoc).toContain("except:");
    expect(routingDoc).toContain('- "10.8.0.0/14"');
    expect(routingDoc).toContain('- "10.12.0.0/14"');
    // Only the ports the routing service serves: gRPC 8443 + health 8081.
    expect(routingDoc).toContain("port: 8443");
    expect(routingDoc).toContain("port: 8081");
    expect(routingDoc).not.toContain("port: 3000");
    // No pod-to-pod allowance for the ext_proc tier.
    expect(routingDoc).not.toContain("podSelector:\n        ");
  });

  it("renders one policy per pool with the LB rule UNION a sibling-podSelector rule", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr", "api"] });
    const yaml = helmRender(template, { podCidrs: ["10.8.0.0/14"] });

    const docs = yaml.split("\n---\n").filter((d) => d.includes("kind: NetworkPolicy"));
    // routing-service + one per pool
    expect(docs).toHaveLength(3);

    const poolDoc = docs.find((d) => d.includes("name: my-app-ssr"))!;
    expect(poolDoc).toBeDefined();
    expect(poolDoc).toContain("app.kubernetes.io/component: ssr");
    // Rule (a): LB traffic — same ipBlock-except-CIDRs as the routing tier.
    expect(poolDoc).toContain("- ipBlock:");
    expect(poolDoc).toContain("cidr: 0.0.0.0/0");
    expect(poolDoc).toContain('- "10.8.0.0/14"');
    // Rule (b): cross-pool proxy traffic comes from SIBLING POOL pods (proxyToPool) —
    // one podSelector per pool component of this release. Both `from` entries form a union.
    expect(poolDoc).toMatch(
      /- podSelector:\n            matchLabels:\n              app\.kubernetes\.io\/name: my-app\n              app\.kubernetes\.io\/component: ssr/,
    );
    expect(poolDoc).toMatch(
      /- podSelector:\n            matchLabels:\n              app\.kubernetes\.io\/name: my-app\n              app\.kubernetes\.io\/component: api/,
    );
    // The routing service never originates pool traffic: its component must NOT be
    // allowed into pools (a compromised ext_proc pod can't reach the dataplane directly).
    const podSelectorBlocks =
      poolDoc.match(/- podSelector:[\s\S]*?(?=\n        - |\n      ports:)/g) ?? [];
    expect(podSelectorBlocks.some((b) => b.includes("component: routing-service"))).toBe(false);
    // Pools serve only 3000.
    expect(poolDoc).toContain("port: 3000");
    expect(poolDoc).not.toContain("port: 8443");

    expect(docs.some((d) => d.includes("name: my-app-api"))).toBe(true);
  });

  it("does NOT name any Google range in the default posture (unchanged behavior)", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    const yaml = helmRender(template, { podCidrs: ["10.8.0.0/14"] });
    for (const cidr of STRICT_INGRESS_CIDRS) expect(yaml).not.toContain(cidr);
    // Exactly the pod CIDR subtraction, nothing else.
    expect(cidrsOf(yaml)).toEqual(["0.0.0.0/0", "10.8.0.0/14", "0.0.0.0/0", "10.8.0.0/14"]);
  });

  it("renders nothing when only nodeCidrs is set (strict is what turns the allowlist on)", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    expect(helmRender(template, { nodeCidrs: ["10.128.0.0/20"] })).toBe("");
  });
});

describe("renderNetworkPolicies — strict (opt-in) posture", () => {
  const template = () =>
    renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr", "api"] });
  const strict = (extra: Values = {}) =>
    helmRender(template(), { strict: true, nodeCidrs: ["10.128.0.0/20"], ...extra });

  it("refuses to render without nodeCidrs (kubelet probes come from the node IP)", () => {
    expect(() => helmRender(template(), { strict: true })).toThrow(
      /strict requires global\.networkPolicy\.nodeCidrs/,
    );
    // …and the message points at the fix.
    expect(() => helmRender(template(), { strict: true })).toThrow(
      /nodeCidrs=\{10\.128\.0\.0\/20\}/,
    );
  });

  it("renders without any podCidrs: the allowlist never names the pod range", () => {
    const yaml = strict();
    expect(yaml).toContain("kind: NetworkPolicy");
    expect(yaml).not.toContain("0.0.0.0/0");
    expect(yaml).not.toContain("except:");
  });

  it("routing tier: Google LB ranges reach 8443 only; the node range reaches 8081 only", () => {
    const yaml = strict();
    const routingDoc = yaml.slice(0, yaml.indexOf("---"));
    const rules = ingressRules(routingDoc);
    expect(rules).toHaveLength(2);

    const [lbRule, kubeletRule] = rules as [string, string];
    expect(ipBlocksOf(lbRule)).toEqual([...STRICT_INGRESS_CIDRS]);
    expect(lbRule).toContain("port: 8443");
    expect(lbRule).not.toContain("port: 8081");
    // The ext_proc callout is the only thing that may reach the gRPC port; the node
    // range must NOT be able to.
    expect(ipBlocksOf(lbRule)).not.toContain("10.128.0.0/20");

    expect(ipBlocksOf(kubeletRule)).toEqual(["10.128.0.0/20"]);
    expect(kubeletRule).toContain("port: 8081");
    expect(kubeletRule).not.toContain("port: 8443");
    // Still no pod-to-pod allowance for the ext_proc tier.
    expect(routingDoc).not.toContain("podSelector:\n        ");
  });

  it("pools: Google LB ranges + node range + sibling pools, on 3000 only", () => {
    const yaml = strict();
    const docs = yaml.split("\n---\n").filter((d) => d.includes("kind: NetworkPolicy"));
    expect(docs).toHaveLength(3);

    const poolDoc = docs.find((d) => d.includes("name: my-app-ssr"))!;
    const rules = ingressRules(poolDoc);
    // The data port and the kubelet probe port are the same (3000), so pools keep a
    // single rule — the node range cannot be separated out by port here.
    expect(rules).toHaveLength(1);
    expect(ipBlocksOf(rules[0]!)).toEqual([...STRICT_INGRESS_CIDRS, "10.128.0.0/20"]);
    expect(poolDoc).toContain("port: 3000");
    expect(poolDoc).not.toContain("port: 8443");
    // Cross-pool proxying survives the tightening…
    expect(poolDoc).toContain("app.kubernetes.io/component: ssr");
    expect(poolDoc).toContain("app.kubernetes.io/component: api");
    // …and the routing tier is still not allowed to originate pool traffic.
    const podSelectorBlocks =
      poolDoc.match(/- podSelector:[\s\S]*?(?=\n        - |\n      ports:)/g) ?? [];
    expect(podSelectorBlocks.some((b) => b.includes("component: routing-service"))).toBe(false);
  });

  it("emits every documented range and no other ipBlock than the operator's node range", () => {
    const yaml = strict({ nodeCidrs: ["10.128.0.0/20", "10.129.0.0/20"] });
    const seen = new Set(cidrsOf(yaml));
    expect([...seen].sort()).toEqual(
      [...STRICT_INGRESS_CIDRS, "10.128.0.0/20", "10.129.0.0/20"].sort(),
    );
  });

  it("multiple node CIDRs all expand", () => {
    const yaml = strict({ nodeCidrs: ["10.128.0.0/20", "10.129.0.0/20"] });
    expect(yaml).toContain('cidr: "10.128.0.0/20"');
    expect(yaml).toContain('cidr: "10.129.0.0/20"');
  });
});

describe("renderNetworkPolicies — input validation", () => {
  it("rejects an unsafe releaseName", () => {
    expect(() =>
      renderNetworkPolicies({ releaseName: 'foo";rm -rf /;"', poolNames: ["ssr"] }),
    ).toThrow(/Invalid releaseName/);
  });
});

// Renders the template with REAL helm when the binary is present (offline; `helm
// template` needs no cluster). This is what proves the hand-rolled evaluator above
// matches helm's own if/else/range/fail semantics and that the output is valid YAML —
// helm parses every rendered manifest, so a malformed document fails the render.
function helmVersion(): string | null {
  try {
    return execFileSync("helm", ["version", "--short"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

describe.skipIf(!helmVersion())("renderNetworkPolicies — real helm render", () => {
  function render(sets: string[]): { ok: boolean; out: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "np-helm-"));
    try {
      mkdirSync(path.join(dir, "templates"));
      writeFileSync(path.join(dir, "Chart.yaml"), "apiVersion: v2\nname: np\nversion: 0.0.0\n");
      writeFileSync(path.join(dir, "values.yaml"), "global:\n  networkPolicy:\n    podCidrs: []\n");
      writeFileSync(
        path.join(dir, "templates", "network-policy.yaml"),
        renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr", "api"] }),
      );
      const args = ["template", "np", dir];
      for (const s of sets) args.push("--set", s);
      try {
        return { ok: true, out: execFileSync("helm", args, { encoding: "utf8", stdio: "pipe" }) };
      } catch (err) {
        const e = err as { stderr?: Buffer | string; message?: string };
        return { ok: false, out: String(e.stderr ?? e.message ?? "") };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("renders nothing with the chart defaults", () => {
    const { ok, out } = render([]);
    expect(ok).toBe(true);
    expect(out).not.toContain("kind: NetworkPolicy");
  });

  it("broad posture matches the hand-rolled evaluator byte for byte", () => {
    const { ok, out } = render(["global.networkPolicy.podCidrs={10.17.0.0/17}"]);
    expect(ok).toBe(true);
    const expected = helmRender(
      renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr", "api"] }),
      { podCidrs: ["10.17.0.0/17"] },
    );
    // helm prefixes each document with `---\n# Source: …`; strip that framing.
    const docs = out
      .split(/^---\n# Source: [^\n]*\n/m)
      .filter((d) => d.includes("kind: NetworkPolicy"))
      .map((d) => d.trimEnd())
      .join("\n---\n");
    expect(docs).toBe(expected.trimEnd());
  });

  it("strict posture matches the hand-rolled evaluator byte for byte", () => {
    const { ok, out } = render([
      "global.networkPolicy.strict=true",
      "global.networkPolicy.nodeCidrs={10.128.0.0/20}",
    ]);
    expect(ok).toBe(true);
    const expected = helmRender(
      renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr", "api"] }),
      { strict: true, nodeCidrs: ["10.128.0.0/20"] },
    );
    const docs = out
      .split(/^---\n# Source: [^\n]*\n/m)
      .filter((d) => d.includes("kind: NetworkPolicy"))
      .map((d) => d.trimEnd())
      .join("\n---\n");
    expect(docs).toBe(expected.trimEnd());
    expect(docs).toContain("cidr: 35.191.0.0/16");
    expect(docs).not.toContain("0.0.0.0/0");
  });

  it("helm itself refuses strict without nodeCidrs", () => {
    const { ok, out } = render(["global.networkPolicy.strict=true"]);
    expect(ok).toBe(false);
    expect(out).toMatch(/strict requires global\.networkPolicy\.nodeCidrs/);
  });
});
