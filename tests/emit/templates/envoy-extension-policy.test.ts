// The generic/AKS/EKS replacement for GKE's GXLB traffic extension. On those platforms the
// load balancer cannot call ext_proc at all (neither ALB nor Application Gateway supports it),
// so an in-cluster Envoy owns the callout and an EnvoyExtensionPolicy attaches it.
//
// MEASURED 2026-07-29 on k3s + Envoy Gateway v1.5.4 with the UNMODIFIED routing-service image:
// the full dispatch vocabulary arrived at the backend (x-output-id, x-internal-secret,
// x-matched-pathname, x-mw-evaluated: ran), and with the routing service scaled to 0 requests
// returned 500 rather than bypassing. This template encodes that proven shape.
import { describe, it, expect } from "vitest";
import { renderEnvoyExtensionPolicy } from "../../../src/emit/templates/envoy-extension-policy.js";

const render = (over: Partial<Parameters<typeof renderEnvoyExtensionPolicy>[0]> = {}) =>
  renderEnvoyExtensionPolicy({ releaseName: "my-app", routeName: "my-app-route", ...over });

describe("renderEnvoyExtensionPolicy", () => {
  it("targets the HTTPRoute that carries the app's traffic", () => {
    const y = render();
    expect(y).toContain("kind: EnvoyExtensionPolicy");
    expect(y).toContain("group: gateway.networking.k8s.io");
    expect(y).toContain("kind: HTTPRoute");
    expect(y).toContain("name: my-app-route");
  });

  it("points ext_proc at the routing service on the ext_proc port", () => {
    const y = render();
    expect(y).toContain("name: my-app-routing-service");
    expect(y).toContain("port: 8443");
  });

  it("sends REQUEST HEADERS ONLY — never the body", () => {
    // The GXLB traffic extension never buffers bodies, and the routing service is built for
    // that contract: middleware that reads the body cannot run at the edge. Sending bodies
    // here would diverge the two tiers and stall streaming requests.
    const y = render();
    expect(y).toContain("processingMode:");
    expect(y).toContain("request: {}");
    expect(y).not.toContain("response:");
    expect(y).not.toMatch(/body:\s*\w/);
  });

  it("fails CLOSED by default", () => {
    // Matches the emitted extension-chain default: if the routing tier is unreachable, a
    // request must NOT be delivered with middleware silently skipped — that is an auth bypass,
    // not a degradation. VERIFIED on k3s: scaling the routing service to 0 returned 500.
    expect(render()).toContain("failOpen: false");
  });

  it("can fail open when the app has no middleware to bypass", () => {
    expect(render({ failOpen: true })).toContain("failOpen: true");
  });

  it("bounds the callout with a message timeout", () => {
    expect(render({ messageTimeoutMs: 4000 })).toContain("messageTimeout: 4s");
  });

  it("defaults the timeout below the handler budget", () => {
    expect(render()).toMatch(/messageTimeout: \d+s/);
  });

  it("rejects an unsafe release name before it reaches the manifest", () => {
    expect(() => render({ releaseName: "bad name!" })).toThrow();
  });
});
