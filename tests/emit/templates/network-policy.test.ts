import { describe, it, expect } from "vitest";
import { renderNetworkPolicies } from "../../../src/emit/templates/network-policy.js";

// Minimal evaluator for this template's two helm constructs: a top-level
// `{{- if .Values.global.networkPolicy.podCidrs }}` guard wrapping the whole file, and
// `{{- range .Values.global.networkPolicy.podCidrs }}` loops expanding CIDR list items.
// (`{{-`/`{{- end }}` trim the adjacent newline, mirrored here.)
function helmRender(template: string, podCidrs: string[]): string {
  if (podCidrs.length === 0) return ""; // the `if` guard renders nothing
  let out = template.replace(/^\{\{- if \.Values\.global\.networkPolicy\.podCidrs \}\}/, "");
  out = out.replace(
    /\n\{\{- range \.Values\.global\.networkPolicy\.podCidrs \}\}\n([\s\S]*?)\n\{\{- end \}\}/g,
    (_m, body: string) =>
      podCidrs.map((c) => `\n${body.replace("{{ . | quote }}", JSON.stringify(c))}`).join(""),
  );
  out = out.replace(/\n\{\{- end \}\}\n?$/, "\n");
  return out;
}

describe("renderNetworkPolicies", () => {
  it("wraps the whole file in a podCidrs guard so an empty list renders no document", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    expect(template).toMatch(/^\{\{- if \.Values\.global\.networkPolicy\.podCidrs \}\}/);
    expect(template).toMatch(/\{\{- end \}\}\n?$/);
    expect(helmRender(template, [])).toBe("");
  });

  it("renders a routing-service policy allowing only non-pod (LB/health-check) ingress", () => {
    const template = renderNetworkPolicies({ releaseName: "my-app", poolNames: ["ssr"] });
    const yaml = helmRender(template, ["10.8.0.0/14", "10.12.0.0/14"]);

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
    const yaml = helmRender(template, ["10.8.0.0/14"]);

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

  it("rejects an unsafe releaseName", () => {
    expect(() =>
      renderNetworkPolicies({ releaseName: 'foo";rm -rf /;"', poolNames: ["ssr"] }),
    ).toThrow(/Invalid releaseName/);
  });
});
