import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateHelmChart } from "../../src/emit/helm.js";
import type { K8sAdapterConfig, PoolDefinition, RoutingManifest } from "../../src/types.js";
import {
  compileTarget,
  defineTarget,
  ingressExposure,
  kubernetesCluster,
} from "../../src/target/index.js";

const helm = process.env.ADAPTER_K8S_SCHEMA_HELM;
const kubeconform = process.env.ADAPTER_K8S_SCHEMA_KUBECONFORM;
const tempDirs: string[] = [];

const pools = new Map<string, PoolDefinition>([
  ["default", { name: "default", outputs: [], config: { routes: ["appPages"] } }],
]);
const routingManifest = {
  routeGraph: { rsc: {} },
  pathnames: ["/"],
  i18n: null,
  buildId: "schema-build",
  builtAt: "2026-08-27T00:00:00.000Z",
  basePath: "",
  middleware: { filePath: "middleware.js" },
  poolAssignments: { "/": "default" },
  pprRoutes: {},
  nextVersion: "16.3.0",
} as unknown as RoutingManifest;

const extensionChainJson = JSON.stringify([
  {
    name: "nextjs-routing",
    matchCondition: { celExpression: "true" },
    extensions: [
      {
        name: "routing-service",
        authority: "schema-routing-service.default.svc.cluster.local",
        service: "projects/schema-project/global/backendServices/schema-routing-service",
        timeout: "5s",
        supportedEvents: ["REQUEST_HEADERS"],
        failOpen: false,
      },
    ],
  },
]);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function renderAndValidate(
  name: string,
  files: Record<string, string>,
  skippedCrdKinds: readonly string[],
): string {
  const root = mkdtempSync(path.join(tmpdir(), `adapter-k8s-schema-${name}-`));
  tempDirs.push(root);
  for (const [relativePath, body] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, body);
  }
  const valuesPath = path.join(root, "schema-values.yaml");
  writeFileSync(
    valuesPath,
    [
      "global:",
      "  networkPolicy:",
      '    podCidrs: ["10.244.0.0/16"]',
      '    nodeCidrs: ["10.0.0.0/16"]',
      "",
    ].join("\n"),
  );
  const rendered = path.join(root, "rendered.yaml");
  writeFileSync(
    rendered,
    execFileSync(helm!, ["template", name, root, "--values", valuesPath], {
      encoding: "utf8",
    }),
  );
  const validation = execFileSync(
    kubeconform!,
    [
      "-strict",
      "-summary",
      "-kubernetes-version",
      "1.33.0",
      "-schema-location",
      "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/5a69f8365c9d3ed7de997f5365e22481cf775fa2/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json",
      ...(skippedCrdKinds.length > 0 ? ["-skip", skippedCrdKinds.join(",")] : []),
      rendered,
    ],
    { encoding: "utf8" },
  );
  const summary = validation
    .trim()
    .split("\n")
    .findLast((line) => line.startsWith("Summary:"));
  if (summary) console.log(`[schema] ${name}: ${summary}`);
  return validation;
}

describe.skipIf(!helm || !kubeconform)("generated chart Kubernetes schemas", () => {
  it("strict-validates a portable ingress target without skipping native resources", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: ingressExposure({
        className: "nginx",
        hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
        tlsSecretName: "app-tls",
      }),
    });
    const config = {
      pools: { default: { routes: ["appPages"] } },
      target,
    } as K8sAdapterConfig;
    const compiledTarget = compileTarget(target, {
      releaseName: "schema-portable",
      namespace: "default",
      buildId: "schema-build",
      imageRegistry: "registry.example.com/schema",
      pools: ["default"],
      defaultPool: "default",
      failurePolicy: "closed",
    });
    const output = renderAndValidate(
      "schema-portable",
      generateHelmChart({
        pools,
        buildId: "schema-build",
        nextVersion: "16.3.0",
        config,
        imageRegistry: "registry.example.com/schema",
        routingManifest,
        releaseName: "schema-portable",
        internalSecret: "a".repeat(64),
        compiledTarget,
      }),
      [],
    );
    expect(output).toContain("Invalid: 0");
    expect(output).toContain("Errors: 0");
    expect(output).toContain("Skipped: 0");
  });

  it("strict-validates native resources in the Envoy profile and names each skipped CRD", () => {
    const config = {
      pools: { default: { routes: ["appPages"] } },
      provider: {
        generic: {
          gateway: {
            className: "eg",
            hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
            tlsSecretName: "app-tls",
          },
        },
      },
    } as K8sAdapterConfig;
    const output = renderAndValidate(
      "schema-envoy",
      generateHelmChart({
        pools,
        buildId: "schema-build",
        nextVersion: "16.3.0",
        config,
        imageRegistry: "registry.example.com/schema",
        routingManifest,
        releaseName: "schema-envoy",
        internalSecret: "b".repeat(64),
        extensionChainJson,
      }),
      ["Gateway", "HTTPRoute", "ClientTrafficPolicy", "EnvoyExtensionPolicy"],
    );
    expect(output).toContain("Invalid: 0");
    expect(output).toContain("Errors: 0");
    expect(output).toMatch(/Skipped: [1-9]/);
  });

  it("strict-validates native resources in the GKE profile and names each skipped CRD", () => {
    const config = {
      pools: { default: { routes: ["appPages"] } },
      provider: {
        gke: {
          gateway: {
            type: "gateway-api",
            className: "gke-l7-global-external-managed",
            hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
          },
          cdn: { enabled: true },
        },
      },
    } as K8sAdapterConfig;
    const output = renderAndValidate(
      "schema-gke",
      generateHelmChart({
        pools,
        buildId: "schema-build",
        nextVersion: "16.3.0",
        config,
        imageRegistry: "us-central1-docker.pkg.dev/schema-project/apps",
        routingManifest,
        releaseName: "schema-gke",
        internalSecret: "c".repeat(64),
        extensionChainJson,
        infrastructure: { projectId: "schema-project", region: "us-central1" },
      }),
      ["Gateway", "HTTPRoute", "HealthCheckPolicy", "GCPHTTPFilter"],
    );
    expect(output).toContain("Invalid: 0");
    expect(output).toContain("Errors: 0");
    expect(output).toMatch(/Skipped: [1-9]/);
  });
});
