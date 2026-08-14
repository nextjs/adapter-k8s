// Rendering of user-supplied runtime environment into the pool pod template.
// Companion to tests/config-env.test.ts, which covers validation. See that file's header
// for why this exists at all (cluster run, 2026-07-29, middleware-general).
import { describe, it, expect } from "vitest";
import { renderDeployment } from "../../src/emit/templates/deployment.js";
import { renderRoutingServiceDeployment } from "../../src/emit/templates/routing-service-deployment.js";

const render = (
  over: Parameters<typeof renderDeployment>[0] extends infer T ? Partial<T> : never,
) =>
  renderDeployment({
    poolName: "default",
    buildId: "bms6abc",
    releaseName: "test-app",
    ...over,
  } as Parameters<typeof renderDeployment>[0]);

describe("renderDeployment env", () => {
  it("stamps a validated telemetry provider identity", () => {
    const yaml = render({ providerName: "nginx-ingress" });
    expect(yaml).toContain(
      '- name: ADAPTER_K8S_PROVIDER_NAME\n              value: "nginx-ingress"',
    );
    expect(() => render({ providerName: 'nginx"\n- name: INJECTED' })).toThrow(
      /invalid telemetry provider name/i,
    );
  });

  it("renders nothing extra when no env is configured", () => {
    const yaml = render({});
    expect(yaml).toContain("name: NEXT_BUILD_ID");
    expect(yaml).not.toContain("envFrom:");
  });

  it("renders a literal value as a quoted string", () => {
    // Unquoted, a value like `1.20` or `yes` becomes a YAML float/bool and Kubernetes
    // rejects the manifest, because env values must be strings.
    const yaml = render({ env: { API_URL: "https://api.example.com", VERSION: "1.20" } });
    expect(yaml).toContain('- name: API_URL\n              value: "https://api.example.com"');
    expect(yaml).toContain('- name: VERSION\n              value: "1.20"');
  });

  it("renders a secret reference as secretKeyRef", () => {
    const yaml = render({ env: { API_KEY: { secret: "app-secrets", key: "api-key" } } });
    expect(yaml).toContain("- name: API_KEY");
    expect(yaml).toContain("secretKeyRef:");
    expect(yaml).toContain('name: "app-secrets"');
    expect(yaml).toContain('key: "api-key"');
    // The literal must not appear as a plain value anywhere.
    expect(yaml).not.toContain('value: "app-secrets"');
  });

  it("renders a configMap reference as configMapKeyRef", () => {
    const yaml = render({ env: { FLAGS: { configMap: "app-config", key: "flags" } } });
    expect(yaml).toContain("configMapKeyRef:");
    expect(yaml).toContain('name: "app-config"');
  });

  it("renders envFrom sources with an optional prefix", () => {
    const yaml = render({
      envFrom: [{ secret: "app-secrets" }, { configMap: "app-config", prefix: "CFG_" }],
    });
    expect(yaml).toContain("envFrom:");
    expect(yaml).toContain('secretRef:\n                name: "app-secrets"');
    expect(yaml).toContain('prefix: "CFG_"');
  });

  it("escapes a value that would otherwise break out of the YAML string", () => {
    // Config is author-controlled, not attacker-controlled, but a value with a quote or a
    // newline is an ordinary accident (a PEM, a JSON blob) and must not corrupt the manifest.
    const yaml = render({ env: { BLOB: 'a"b\nc' } });
    expect(yaml).toContain('value: "a\\"b\\nc"');
    expect(yaml).not.toContain('\nc"');
  });

  it("neutralizes Helm template actions in a value (S5)", () => {
    // Everything under templates/ is evaluated by Helm BEFORE the YAML is parsed, so a value
    // containing {{ ... }} would EXECUTE at `helm upgrade` time with the deployer's
    // credentials — the same hole S5 documents for routing-manifest headers. env values are
    // opaque author data spliced into a chart file and get the same treatment.
    const yaml = render({
      env: { TEMPLATED: '{{ index (lookup "v1" "Secret" "d" "s").data "t" }}' },
    });
    expect(yaml).not.toContain('{{ index (lookup "v1"');
    expect(yaml).toContain('{{ "{{" }}');
  });

  it("neutralizes Helm template actions in a secret NAME", () => {
    const yaml = render({ env: { K: { secret: "{{ .Release.Namespace }}", key: "k" } } });
    expect(yaml).not.toContain("{{ .Release.Namespace }}");
  });

  it("keeps the adapter's own variables ahead of user values", () => {
    // If a user value somehow shared a name with a built-in, Kubernetes takes the LAST
    // occurrence — so user entries must come after, and validation separately forbids the
    // collision. Order here is what makes that guarantee real rather than incidental.
    const yaml = render({ env: { USER_VALUE: "x" } });
    expect(yaml.indexOf("name: NEXT_BUILD_ID")).toBeLessThan(yaml.indexOf("name: USER_VALUE"));
  });
});

describe("renderRoutingServiceDeployment env", () => {
  // Full-run cluster (middleware-general node-runtime, 66/68 after the staging fix): a
  // NODE-runtime middleware executes in the ROUTING container and reads process.env at
  // request time — but only pool deployments rendered user env, so the suite's declared
  // variable was undefined in middleware. Same rendering rules as pools: after built-ins
  // (K8s last-wins), JSON-quoted, Helm-action-escaped.
  const renderRouting = (over: Record<string, unknown>) =>
    renderRoutingServiceDeployment({
      releaseName: "test-app",
      buildId: "bms6abc",
      imageRegistry: "registry.example.com/app",
      ...over,
    } as Parameters<typeof renderRoutingServiceDeployment>[0]);

  it("renders user env after the adapter's own entries", () => {
    const yaml = renderRouting({ env: { MIDDLEWARE_VAR: "asdf2" } });
    expect(yaml).toContain('- name: MIDDLEWARE_VAR\n              value: "asdf2"');
    expect(yaml.indexOf("name: NEXT_BUILD_ID")).toBeLessThan(yaml.indexOf("name: MIDDLEWARE_VAR"));
  });

  it("stamps the same telemetry provider identity", () => {
    const yaml = renderRouting({ providerName: "envoy-native" });
    expect(yaml).toContain(
      '- name: ADAPTER_K8S_PROVIDER_NAME\n              value: "envoy-native"',
    );
  });

  it("renders secret refs and envFrom like the pool template", () => {
    const yaml = renderRouting({
      env: { TOKEN: { secret: "app-secrets", key: "token", optional: true } },
      envFrom: [{ configMap: "shared-config", prefix: "APP_" }],
    });
    expect(yaml).toContain("secretKeyRef:");
    expect(yaml).toContain('name: "app-secrets"');
    expect(yaml).toContain("envFrom:");
    expect(yaml).toContain('prefix: "APP_"');
  });

  it("renders nothing extra without env", () => {
    const yaml = renderRouting({});
    expect(yaml).not.toContain("envFrom:");
  });
});

describe("NEXT_DEPLOYMENT_ID rendering", () => {
  // Full-run v4 deployment-id family (next-image-legacy ?dpl=, worker NEXT_DEPLOYMENT_ID,
  // both deployment-skew suites): Next's runtime reads process.env.NEXT_DEPLOYMENT_ID and
  // config load REFUSES a mismatch, so both containers must carry the exact build value.
  it("pool pods carry the build's deploymentId before user env", () => {
    const yaml = render({ deploymentId: "k8s-3f9a12bc45de", env: { A: "b" } });
    expect(yaml).toContain('- name: NEXT_DEPLOYMENT_ID\n              value: "k8s-3f9a12bc45de"');
    expect(yaml.indexOf("NEXT_DEPLOYMENT_ID")).toBeLessThan(yaml.indexOf("- name: A"));
  });

  it("routing pods carry it too (node middleware runs there)", () => {
    const yaml = renderRoutingServiceDeployment({
      releaseName: "test-app",
      buildId: "bms6abc",
      imageRegistry: "registry.example.com/app",
      deploymentId: "k8s-3f9a12bc45de",
    } as Parameters<typeof renderRoutingServiceDeployment>[0]);
    expect(yaml).toContain('- name: NEXT_DEPLOYMENT_ID\n              value: "k8s-3f9a12bc45de"');
  });

  it("renders nothing when no deploymentId is set", () => {
    expect(render({})).not.toContain("NEXT_DEPLOYMENT_ID");
  });
});
