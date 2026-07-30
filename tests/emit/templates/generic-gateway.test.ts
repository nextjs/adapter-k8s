// The Gateway for non-GKE providers. GKE's renderGateway hardcodes
// `gatewayClassName: gke-l7-global-external-managed` and a NamedAddress pointing at a
// Google reserved IP — neither exists elsewhere, and both would leave the Gateway unprogrammed.
import { describe, it, expect } from "vitest";
import { renderGenericGateway } from "../../../src/emit/templates/generic-gateway.js";

const render = (over: Partial<Parameters<typeof renderGenericGateway>[0]> = {}) =>
  renderGenericGateway({
    releaseName: "my-app",
    gatewayClassName: "eg",
    hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
    ...over,
  });

describe("renderGenericGateway", () => {
  it("uses the configured GatewayClass rather than a Google one", () => {
    const y = render();
    expect(y).toContain("gatewayClassName: eg");
    expect(y).not.toContain("gke-l7");
  });

  it("does NOT emit a Google NamedAddress", () => {
    // GKE attaches a pre-reserved regional IP by name. On another platform that address does
    // not resolve and the Gateway never programs — the LB address comes from the controller.
    expect(render()).not.toContain("NamedAddress");
  });

  it("does NOT emit the GKE certmap annotation", () => {
    // Certificate Manager is GCP-only. TLS elsewhere comes from a Secret (cert-manager, ACM
    // via annotations, etc.), so silently carrying a certmap reference would be misleading.
    const y = render({ hosts: [{ hostname: "app.example.com", tls: { enabled: true } }] });
    expect(y).not.toContain("networking.gke.io/certmap");
  });

  it("always exposes an HTTP listener", () => {
    const y = render();
    expect(y).toContain("protocol: HTTP");
    expect(y).toContain("port: 80");
  });

  it("adds an HTTPS listener with a certificateRef when TLS is enabled", () => {
    const y = render({
      hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
      tlsSecretName: "app-tls",
    });
    expect(y).toContain("protocol: HTTPS");
    expect(y).toContain("port: 443");
    expect(y).toContain("certificateRefs:");
    expect(y).toContain("name: app-tls");
  });

  it("omits HTTPS when TLS is enabled but no cert Secret was supplied", () => {
    // A listener with no certificateRef never programs. Emitting HTTP only is honest and
    // serves; emitting a broken HTTPS listener looks configured and fails at request time.
    const y = render({ hosts: [{ hostname: "app.example.com", tls: { enabled: true } }] });
    expect(y).not.toContain("protocol: HTTPS");
  });

  it("names listeners exactly `http`/`https` so HTTPRoute sectionName attaches", () => {
    // An earlier cut emitted a listener PER HOST (`http-0`, `https-0`, …) and carried the
    // hostname on the listener. renderHTTPRoute binds with `sectionName: http`/`https`, so with
    // more than one host NO section matched: the route attached to nothing while the Gateway
    // still reported programmed — a silent serve-nothing. Hostname matching belongs to the
    // HTTPRoute, which already does it.
    const y = render({
      hosts: [
        { hostname: "a.example.com", tls: { enabled: true } },
        { hostname: "b.example.com", tls: { enabled: true } },
      ],
      tlsSecretName: "app-tls",
    });
    expect(y).toContain("- name: http\n");
    expect(y).toContain("- name: https\n");
    expect(y).not.toMatch(/- name: https?-\d/);
  });

  it("rejects unsafe release names and hostnames", () => {
    expect(() => render({ releaseName: "bad name!" })).toThrow();
    expect(() =>
      render({ hosts: [{ hostname: "evil\nhost", tls: { enabled: false } }] }),
    ).toThrow();
  });
});
