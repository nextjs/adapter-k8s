// Server-side validation: the ONLY check that catches an invalid field, which string
// assertions cannot. Skipped unless a cluster with the Gateway API + Envoy Gateway CRDs is
// reachable via K8S_VALIDATE_CONTEXT.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderGenericGateway } from "../../../src/emit/templates/generic-gateway.js";
import { renderEnvoyExtensionPolicy } from "../../../src/emit/templates/envoy-extension-policy.js";
import { renderHTTPRoute } from "../../../src/emit/templates/gateway.js";
import type { PoolDefinition, RoutingManifest } from "../../../src/types.js";

const ctx = process.env.K8S_VALIDATE_CONTEXT;

describe.skipIf(!ctx)("generic templates validate against a real API server", () => {
  const apply = (yaml: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "gwcheck-"));
    const f = path.join(dir, "doc.yaml");
    writeFileSync(f, yaml);
    return execFileSync(
      "kubectl",
      ["--context", ctx!, "apply", "--dry-run=server", "-n", "default", "-f", f],
      { encoding: "utf8", stdio: "pipe" },
    );
  };

  it("Gateway is accepted by the API server", () => {
    const out = apply(
      renderGenericGateway({
        releaseName: "validate-app",
        gatewayClassName: "eg",
        hosts: [
          { hostname: "a.example.com", tls: { enabled: true } },
          { hostname: "b.example.com", tls: { enabled: false } },
        ],
        tlsSecretName: "validate-tls",
      }),
    );
    expect(out).toContain("gateway");
  });

  it("EnvoyExtensionPolicy is accepted by the API server", () => {
    const out = apply(
      renderEnvoyExtensionPolicy({ releaseName: "validate-app", routeName: "validate-app-route" }),
    );
    expect(out).toContain("envoyextensionpolicy");
  });

  it("HTTPRoute accepts disabled request timeouts on every application rule", () => {
    const pools = new Map<string, PoolDefinition>([
      ["default", { name: "default", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const manifest: RoutingManifest = {
      routeGraph: { rsc: {} } as RoutingManifest["routeGraph"],
      pathnames: [],
      i18n: null,
      buildId: "validate-build",
      builtAt: "2026-08-12T00:00:00.000Z",
      basePath: "",
      middleware: null,
      poolAssignments: { "/": "default" },
      pprRoutes: {},
      nextVersion: "16.3.0",
    };
    const out = apply(
      renderHTTPRoute({
        releaseName: "validate-app",
        hosts: [{ hostname: "a.example.com", tls: { enabled: false } }],
        pools,
        routingManifest: manifest,
        disableRequestTimeout: true,
      }),
    );
    expect(out).toContain("httproute");
  });
});
