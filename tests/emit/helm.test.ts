// tests/emit/helm.test.ts
import { describe, it, expect } from "vitest";
import {
  assertSecretChartFilesComplete,
  generateHelmChart,
  SECRET_CHART_FILES,
} from "../../src/emit/helm.js";
import { sanitizeK8sName } from "../../src/emit/templates/utils.js";
import { internalSecretName } from "../../src/emit/templates/internal-secret.js";
import type { PoolDefinition, K8sAdapterConfig, RoutingManifest } from "../../src/types.js";
import {
  compileTarget,
  defineTarget,
  gatewayApiExposure,
  httpRouteExposure,
  kubernetesCluster,
} from "../../src/target/index.js";

const mockManifest: RoutingManifest = {
  routeGraph: { rsc: {} } as any,
  pathnames: [],
  i18n: null,
  buildId: "abc123",
  builtAt: "2026-01-01T00:00:00.000Z",
  basePath: "",
  middleware: null,
  poolAssignments: {},
  pprRoutes: {},
  nextVersion: "16.2.0",
};

// Strict SemVer 2.0.0 (the grammar helm's chart-version validation enforces —
// numeric prerelease identifiers may not have leading zeros and no identifier may
// be empty). Used by the N50 chart-version tests below.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const chartVersion = (chart: Record<string, string>): string =>
  chart["Chart.yaml"].match(/^version: (.*)$/m)![1];

const minimalPools = () =>
  new Map<string, PoolDefinition>([
    ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
  ]);

const chartFor = (buildId: string) =>
  generateHelmChart({
    pools: minimalPools(),
    buildId,
    nextVersion: "16.2.0",
    config: {
      pools: { ssr: { routes: ["appPages"] } },
      provider: { gke: {} },
    } as K8sAdapterConfig,
    imageRegistry: "gcr.io/my-project",
    routingManifest: { ...mockManifest, buildId },
    internalSecret: "deadbeef",
  });

// N50 (review #23): safeVersionSuffix preserved `.`, so a date-style build id rendered
// `version: 0.1.0-2026.07.25` — SemVer forbids leading zeros in a NUMERIC prerelease
// identifier, so real helm fails with
//   Error: validation: chart.metadata.version "0.1.0-2026.07.25" is invalid
// on EVERY helm invocation (template, upgrade, rollback), after the build and the image
// push. `slice(0, 32)` could also land on a `.`, producing an EMPTY trailing identifier
// (`0.1.0-1.2.`), which is invalid for the same reason. BUILD_ID_RE deliberately permits
// `.`, so this is reachable from a plain `generateBuildId: () => "2026.07.25"`.
// N67. renderRouteExtConfigMap now REJECTS a chain array that is empty / has more than one
// chain-or-extension, and rejects an extension with no explicit boolean `failOpen` (the old
// `?? true` default was the middleware-BYPASS direction in the file that configures the
// fail-CLOSED posture). These tests only need "an extension chain is present", so they use
// the smallest chain the generator actually produces.
const MINIMAL_CHAIN_JSON = JSON.stringify([
  {
    name: "nextjs-routing",
    matchCondition: { celExpression: "true" },
    extensions: [
      {
        name: "routing-service",
        authority: "nextjs-routing-service.default.svc.cluster.local",
        service: "projects/p-123456/global/backendServices/nextjs-routing-service",
        timeout: "5s",
        supportedEvents: ["REQUEST_HEADERS"],
        failOpen: false,
      },
    ],
  },
]);

describe("chart version is always valid SemVer (N50)", () => {
  it.each([
    ["2026.07.25", "date-style build id with leading-zero segments"],
    ["1.2.", "trailing dot (empty prerelease identifier)"],
    ["07", "purely numeric with a leading zero"],
    ["v1.0.0-rc.1", "semver-ish build id"],
    ["a".repeat(40), "40-char build id"],
    ["1234567890".repeat(4), "40-char all-numeric build id"],
    ["___", "all-separator build id (suffix sanitizes to empty)"],
    ["feature.branch_name-2", "mixed separators"],
  ])("renders valid SemVer for %s (%s)", (buildId) => {
    const version = chartVersion(chartFor(buildId));
    expect(version).toMatch(SEMVER_RE);
    // Prerelease identifiers must be non-empty and free of dots (we collapse to `-`).
    const prerelease = version.slice("0.1.0-".length);
    expect(prerelease).not.toContain(".");
    expect(prerelease.length).toBeGreaterThan(0);
  });

  it("keeps the version stable across renders and distinct per build id", () => {
    expect(chartVersion(chartFor("2026.07.25"))).toBe(chartVersion(chartFor("2026.07.25")));
    // Two ids that collapse to the same sanitized suffix still differ (digest tail).
    expect(chartVersion(chartFor("a.b"))).not.toBe(chartVersion(chartFor("a_b")));
  });

  it("caps the version suffix (helm has no length limit, but names derived from it do)", () => {
    expect(chartVersion(chartFor("x".repeat(200).slice(0, 128))).length).toBeLessThanOrEqual(
      "0.1.0-".length + 32,
    );
  });
});

describe("generateHelmChart", () => {
  it("renders a composed target behind the stable portable origin", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: gatewayApiExposure({
        className: "eg",
        hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
      }),
    });
    const config = { pools: { ssr: { routes: ["appPages"] } }, target } as K8sAdapterConfig;
    const compiledTarget = compileTarget(target, {
      releaseName: "site",
      namespace: "apps",
      buildId: "abc123",
      imageRegistry: "ghcr.io/example/site",
      pools: ["ssr"],
      defaultPool: "ssr",
      failurePolicy: "closed",
    });
    const result = generateHelmChart({
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.3.0",
      config,
      imageRegistry: "ghcr.io/example/site",
      routingManifest: mockManifest,
      releaseName: "site",
      internalSecret: "deadbeef",
      compiledTarget,
    });

    expect(result["templates/origin-service.yaml"]).toContain("name: site-origin");
    // GitOps PR2: mode-gated selector — `none` (the default, and every imperative deploy)
    // resolves to activeDefaultPool exactly as before; `job` resolves to the previous
    // build's default pool because sync is not cutover.
    expect(result["templates/origin-service.yaml"]).toContain(".Values.activeDefaultPool");
    expect(result["templates/origin-service.yaml"]).toContain(".Values.previousDefaultPool");
    expect(Object.keys(result)).toContain("templates/composition-plan.yaml");
    expect(
      JSON.parse(result["values.yaml"].slice(result["values.yaml"].indexOf("{"))),
    ).toMatchObject({ activeDefaultPool: "ssr" });
    expect(Object.values(result).some((body) => body.includes('"kind": "Gateway"'))).toBe(true);
    expect(Object.values(result).some((body) => body.includes('"kind": "HTTPRoute"'))).toBe(true);
    expect(result["templates/ssr-deployment.yaml"]).toContain(
      '- name: ADAPTER_K8S_PROVIDER_NAME\n              value: "portable"',
    );
    expect(result["templates/routing-service-deployment.yaml"]).toBeUndefined();
  });

  it("renders an httpRouteExposure target with an HTTPRoute and no Gateway anywhere", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: httpRouteExposure({
        className: "envoy",
        parentRefs: [{ name: "envoy-external", namespace: "network", sectionName: "https" }],
        hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
      }),
    });
    const config = { pools: { ssr: { routes: ["appPages"] } }, target } as K8sAdapterConfig;
    const compiledTarget = compileTarget(target, {
      releaseName: "site",
      namespace: "apps",
      buildId: "abc123",
      imageRegistry: "ghcr.io/example/site",
      pools: ["ssr"],
      defaultPool: "ssr",
      failurePolicy: "closed",
    });
    const result = generateHelmChart({
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.3.0",
      config,
      imageRegistry: "ghcr.io/example/site",
      routingManifest: mockManifest,
      releaseName: "site",
      internalSecret: "deadbeef",
      compiledTarget,
    });

    const routeTemplate = Object.entries(result).find(([, body]) =>
      body.includes('"kind": "HTTPRoute"'),
    );
    expect(routeTemplate).toBeDefined();
    expect(routeTemplate![1]).toContain('"name": "envoy-external"');
    expect(routeTemplate![1]).toContain('"namespace": "network"');
    expect(routeTemplate![1]).toContain('"sectionName": "https"');
    // The whole chart contains no Gateway object — the shared parent is not ours.
    expect(Object.values(result).some((body) => body.includes('"kind": "Gateway"'))).toBe(false);
  });

  it("renders a cert-manager Certificate for a certManager gatewayApiExposure", () => {
    const target = defineTarget({
      cluster: kubernetesCluster(),
      exposure: gatewayApiExposure({
        className: "eg",
        hosts: [{ hostname: "app.example.com", tls: { enabled: true } }],
        certManager: { issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" } },
      }),
    });
    const config = { pools: { ssr: { routes: ["appPages"] } }, target } as K8sAdapterConfig;
    const compiledTarget = compileTarget(target, {
      releaseName: "site",
      namespace: "apps",
      buildId: "abc123",
      imageRegistry: "ghcr.io/example/site",
      pools: ["ssr"],
      defaultPool: "ssr",
      failurePolicy: "closed",
    });
    const result = generateHelmChart({
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.3.0",
      config,
      imageRegistry: "ghcr.io/example/site",
      routingManifest: mockManifest,
      releaseName: "site",
      internalSecret: "deadbeef",
      compiledTarget,
    });

    const certTemplate = Object.entries(result).find(([, body]) =>
      body.includes('"kind": "Certificate"'),
    );
    expect(certTemplate).toBeDefined();
    expect(certTemplate![1]).toContain('"apiVersion": "cert-manager.io/v1"');
    expect(certTemplate![1]).toContain('"secretName": "site-tls"');
    expect(certTemplate![1]).toContain('"name": "letsencrypt-production"');
    expect(certTemplate![1]).toContain('"app.example.com"');
    // The Gateway's HTTPS listener terminates from the derived Secret.
    const gatewayTemplate = Object.entries(result).find(([, body]) =>
      body.includes('"kind": "Gateway"'),
    );
    expect(gatewayTemplate![1]).toContain('"name": "site-tls"');
  });

  it("translates flat pool resource settings into Kubernetes requests and limits", () => {
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [],
          config: {
            routes: ["appPages"],
            resources: {
              cpu: "500m",
              memory: "768Mi",
              cpuLimit: "2",
              memoryLimit: "1Gi",
            },
          },
        },
      ],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });
    const values = JSON.parse(result["values.yaml"].slice(result["values.yaml"].indexOf("{")));

    expect(values.pools.ssr.resources).toEqual({
      requests: { cpu: "500m", memory: "768Mi" },
      limits: { cpu: "2", memory: "1Gi" },
    });
  });

  it("generates chart with correct structure", () => {
    const pools = new Map<string, PoolDefinition>([
      [
        "ssr",
        {
          name: "ssr",
          outputs: [],
          config: {
            routes: ["appPages"],
            scaling: { min: 2, max: 10, targetCPU: 70 },
          },
        },
      ],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });

    expect(result["Chart.yaml"]).toContain("name:");
    expect(result["Chart.yaml"]).toContain("version:");
    expect(result["values.yaml"]).toContain("abc123");
    expect(result["values.yaml"]).toContain('"activeBuildId": "abc123"');
    expect(result["templates/ssr-deployment.yaml"]).toBeDefined();
    expect(result["templates/ssr-service.yaml"]).toBeDefined();
    // GitOps PR2: mode-gated (see the origin-service assertion above).
    expect(result["templates/ssr-active-service.yaml"]).toContain(".Values.activeBuildId");
    expect(result["templates/ssr-active-service.yaml"]).toContain(".Values.previousBuildId");
    expect(result["templates/ssr-hpa.yaml"]).toBeDefined();
    expect(result["templates/routing-manifest-configmap.yaml"]).toBeDefined();
    expect(result["templates/http-route.yaml"]).toBeDefined();
    expect(result["templates/gateway.yaml"]).toBeDefined();
    expect(result["templates/gateway.yaml"]).toContain("type: NamedAddress");
    expect(result["templates/gateway.yaml"]).toContain("value: nextjs-ip");

    const deploymentContent = result["templates/ssr-deployment.yaml"];
    const expectedName = sanitizeK8sName("nextjs-ssr-abc123");
    expect(deploymentContent).toContain(`name: ${expectedName}`);
  });

  it("renders the internal-header Secret and wires it into pool + routing-service deployments", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: { gateway: { type: "gateway-api", hosts: [{ hostname: "app.example.com" }] } },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      extensionChainJson: MINIMAL_CHAIN_JSON,
      infrastructure: { projectId: "my-project", region: "us-central1" },
      internalSecret: "deadbeef",
    });

    // N87: the Secret name carries the build id, so a pod can only ever resolve its OWN
    // build's secret (a stable name let a restarted old pod pick up the new build's value
    // and trust its middleware verdict).
    const expectedSecretName = internalSecretName("nextjs", "abc123");
    expect(expectedSecretName).toContain("abc123");
    const secretFile = result["templates/internal-secret.yaml"];
    expect(secretFile).toBeDefined();
    expect(secretFile).toContain("kind: Secret");
    expect(secretFile).toContain(`name: ${expectedSecretName}`);
    expect(secretFile).toContain('secret: "deadbeef"');
    // It must outlive the upgrade that renders the NEXT build's Secret — the retained
    // previous build's pods reference it by name and cannot start without it.
    expect(secretFile).toContain("helm.sh/resource-policy: keep");
    expect(secretFile).toContain('adapter-k8s/build-id: "abc123"');

    // Both deployments must read INTERNAL_HEADER_SECRET from that Secret via secretKeyRef.
    for (const file of [
      "templates/ssr-deployment.yaml",
      "templates/routing-service-deployment.yaml",
    ]) {
      const content = result[file];
      expect(content).toContain("name: INTERNAL_HEADER_SECRET");
      expect(content).toContain("secretKeyRef:");
      expect(content).toContain(`name: ${expectedSecretName}`);
      expect(content).toContain("key: secret");
    }
  });

  // N50 (review #20): the internal dispatch secret used to be minted with
  // randomBytes(32) on every render because adapter.ts never passed one. Re-emitting the
  // chart for the SAME build then produced a DIFFERENT secret while the running pods kept
  // the old one — they stop trusting dispatch headers and middleware runs TWICE per
  // request (rate-limit counters, analytics) for the whole rollout window. It also
  // defeated the only audit for invariant 5 (diff a regenerated chart against what was
  // applied). The secret is now derived per build by the caller (adapter.ts
  // deriveInternalSecret) and is a REQUIRED argument here, so no render can invent one.
  it("uses the supplied internal secret verbatim and renders identically every time", () => {
    const a = chartFor("abc123")["templates/internal-secret.yaml"];
    const b = chartFor("abc123")["templates/internal-secret.yaml"];
    expect(a).toEqual(b);
    expect(a).toContain('secret: "deadbeef"');
    // Every non-values chart file is byte-stable across renders (values.yaml carries a
    // wall-clock "# Generated:" header owned by templates/values-yaml.ts).
    const first = chartFor("abc123");
    const second = chartFor("abc123");
    for (const key of Object.keys(first)) {
      if (key === "values.yaml") continue;
      expect(second[key]).toEqual(first[key]);
    }
  });

  it("generates header-based HTTPRoute rules for pools", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: true, managedCert: true } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });

    const httpRoute = result["templates/http-route.yaml"];
    expect(httpRoute).toContain("x-upstream-pool");
  });

  it("includes routing service templates when extensionChainJson provided", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
      extensionChainJson: JSON.stringify([
        {
          name: "nextjs-routing",
          matchCondition: { celExpression: "true" },
          extensions: [
            {
              name: "routing-service",
              authority: "nextjs-routing-service.default.svc.cluster.local",
              service:
                "projects/my-project/locations/us-central1/backendServices/nextjs-routing-service",
              timeout: "5s",
              supportedEvents: ["REQUEST_HEADERS"],
              failOpen: true,
            },
          ],
        },
      ]),
      infrastructure: { projectId: "my-project", region: "us-central1" },
    });

    expect(result["templates/routing-service-deployment.yaml"]).toBeDefined();
    expect(result["templates/routing-service-service.yaml"]).toBeDefined();
    expect(result["templates/routing-service-hpa.yaml"]).toBeDefined();
    expect(result["templates/route-ext-config.yaml"]).toBeDefined();
    expect(result["templates/route-ext-update-job.yaml"]).toBeDefined();
  });

  // Gap #2 (real-cluster gap analysis): the chart rendered NO imagePullSecrets anywhere,
  // so a private registry on nodes with no machine-level credentials was
  // ImagePullBackOff on every pod. One config key must reach EVERY pod-creating template.
  it("stamps config imagePullSecrets on every pod-creating template (pools, routing tier, registration Job)", () => {
    const result = generateHelmChart({
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        imagePullSecrets: ["docker-regcred"],
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
      extensionChainJson: MINIMAL_CHAIN_JSON,
      infrastructure: { projectId: "p-123456", region: "us-central1" },
    });
    for (const file of [
      "templates/ssr-deployment.yaml",
      "templates/routing-service-deployment.yaml",
      "templates/route-ext-update-job.yaml",
    ]) {
      expect(result[file], file).toMatch(/imagePullSecrets:\n\s+- name: "docker-regcred"/);
    }
    // Exhaustive: NO rendered template creates a pod without the reference. Every document
    // carrying a pod template (spec.template.spec) must carry imagePullSecrets.
    for (const [name, body] of Object.entries(result)) {
      if (!name.startsWith("templates/")) continue;
      if (
        /^\s{4}spec:$/m.test(body) &&
        /kind: (Deployment|Job|StatefulSet|DaemonSet|CronJob)/.test(body)
      ) {
        expect(body, `${name} renders a pod template without imagePullSecrets`).toContain(
          "imagePullSecrets",
        );
      }
    }
  });

  it("renders no imagePullSecrets anywhere when the key is absent (charts stay byte-identical)", () => {
    const result = chartFor("abc123");
    for (const [name, body] of Object.entries(result)) {
      expect(body, name).not.toContain("imagePullSecrets");
    }
  });

  // N50 (review, Medium): the route-extension update Job and its ServiceAccount used to
  // vanish with a bare `if (projectId && region)` and no else — the chart installed the
  // routing service but NEVER registered the GXLB traffic extension, so the edge kept the
  // previous build's chain (or none) while the deploy reported success. Refuse to render a
  // chain that cannot be registered.
  it("throws when an extension chain is requested without projectId/region", () => {
    const args = {
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
      extensionChainJson: MINIMAL_CHAIN_JSON,
    };
    expect(() => generateHelmChart(args)).toThrow(/projectId.*region/s);
    expect(() => generateHelmChart({ ...args, infrastructure: { projectId: "p-123456" } })).toThrow(
      /region/,
    );
    expect(() => generateHelmChart({ ...args, infrastructure: { region: "us-central1" } })).toThrow(
      /projectId/,
    );
    expect(() =>
      generateHelmChart({
        ...args,
        infrastructure: { projectId: "p-123456", region: "us-central1" },
      }),
    ).not.toThrow();
  });

  // N72 (templates-agent handoff): app images are otherwise pinned by a MUTABLE tag while the
  // deploy SA holds artifactregistry.repoAdmin, so a retag changes what a pool runs on its
  // next scale-up (existing nodes keep the cached layer) — a rollout and a scale-up can then
  // execute different code under one build id. `imageDigests` is the pass-through seam; the
  // digest itself can only be resolved AFTER `docker push`, i.e. by the deploy step.
  it("threads image digests into the pool and routing-service Deployments", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const withDigest = generateHelmChart({
      pools: minimalPools(),
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
      extensionChainJson: MINIMAL_CHAIN_JSON,
      infrastructure: { projectId: "p-123456", region: "us-central1" },
      imageDigests: { ssr: digest, routingService: digest },
    });
    expect(withDigest["templates/ssr-deployment.yaml"]).toContain(`@${digest}`);
    expect(withDigest["templates/ssr-deployment.yaml"]).toContain("imagePullPolicy: IfNotPresent");
    expect(withDigest["templates/routing-service-deployment.yaml"]).toContain(`@${digest}`);

    // Without a RENDER-TIME digest the template defers to values (S7): `deploy` sets
    // `pools.<pool>.image.digest` after `docker push` resolves it, and helm then picks the
    // digest + IfNotPresent, or the tag + Always so a retag can never be silently served
    // from a node's cached layer. Both arms are proven against real helm in
    // tests/emit/templates/image-digest.test.ts.
    const withoutDigest = chartFor("abc123");
    expect(withoutDigest["templates/ssr-deployment.yaml"]).not.toContain("@sha256:");
    expect(withoutDigest["templates/ssr-deployment.yaml"]).toContain(
      '{{ with (index .Values.pools "ssr").image.digest }}IfNotPresent{{ else }}Always{{ end }}',
    );
    expect(withoutDigest["values.yaml"]).toContain('"digest": ""');
  });

  it("generates one deployment per pool", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
      ["api", { name: "api", outputs: [], config: { routes: ["appRoutes"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] }, api: { routes: ["appRoutes"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });

    expect(result["templates/ssr-deployment.yaml"]).toBeDefined();
    expect(result["templates/api-deployment.yaml"]).toBeDefined();
  });

  it("emits the CDN filter and wires it into the HTTPRoute when cdn.enabled", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: {
          gke: {
            cdn: { enabled: true, bucket: "" },
            gateway: {
              type: "gateway-api",
              className: "gke-l7-global-external-managed",
              hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
            },
          },
        },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });

    const filter = result["templates/cdn-http-filter.yaml"];
    expect(filter).toBeDefined();
    expect(filter).toContain("kind: GCPHTTPFilter");
    expect(filter).toContain("cacheMode: USE_ORIGIN_HEADERS");

    const httpRoute = result["templates/http-route.yaml"];
    expect(httpRoute).toContain("type: ExtensionRef");
    expect(httpRoute).toContain("name: nextjs-cdn");
    // every rule carries the filter
    const ruleCount = (httpRoute.match(/- matches:/g) ?? []).length;
    const filterCount = (httpRoute.match(/type: ExtensionRef/g) ?? []).length;
    expect(filterCount).toBe(ruleCount);
  });

  it("emits no CDN artifacts when cdn is disabled or absent, leaving the chart unchanged", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const baseArgs = {
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    };
    const gateway = {
      type: "gateway-api",
      className: "gke-l7-global-external-managed",
      hosts: [{ hostname: "app.example.com", tls: { enabled: false } }],
    };

    const absent = generateHelmChart({
      ...baseArgs,
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { gateway } },
      } as K8sAdapterConfig,
    });
    const disabled = generateHelmChart({
      ...baseArgs,
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { gateway, cdn: { enabled: false, bucket: "" } } },
      } as K8sAdapterConfig,
    });

    for (const chart of [absent, disabled]) {
      expect(chart["templates/cdn-http-filter.yaml"]).toBeUndefined();
      expect(chart["templates/http-route.yaml"]).not.toContain("filters:");
      expect(chart["templates/http-route.yaml"]).not.toContain("GCPHTTPFilter");
    }
    // cdn.enabled: false is byte-identical to cdn absent, excluding the generated timestamp.
    const withoutTimestamp = (chart: Record<string, string>) => ({
      ...chart,
      "values.yaml": chart["values.yaml"].replace(/^# Generated: .*$/m, "# Generated: <time>"),
    });
    expect(withoutTimestamp(disabled)).toEqual(withoutTimestamp(absent));
  });

  it("emits no CDN artifacts without gateway hosts (unreachable via validated config)", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: { cdn: { enabled: true, bucket: "" } } },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });
    expect(result["templates/cdn-http-filter.yaml"]).toBeUndefined();
    expect(result["templates/http-route.yaml"]).toBeUndefined();
  });

  it("always emits the NetworkPolicy template (helm-gated) with an empty podCidrs default", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);
    const result = generateHelmChart({
      pools,
      buildId: "abc123",
      nextVersion: "16.2.0",
      config: {
        pools: { ssr: { routes: ["appPages"] } },
        provider: { gke: {} },
      } as K8sAdapterConfig,
      imageRegistry: "gcr.io/my-project",
      routingManifest: mockManifest,
      internalSecret: "deadbeef",
    });

    // The template is always in the chart; the helm `if` guard renders nothing until the
    // deploy CLI sets global.networkPolicy.podCidrs (or the operator opts into the
    // strict allowlist, which needs no pod CIDR — N19).
    const netpol = result["templates/network-policy.yaml"];
    expect(netpol).toBeDefined();
    expect(netpol).toContain(
      "{{- if or .Values.global.networkPolicy.podCidrs .Values.global.networkPolicy.strict }}",
    );
    expect(netpol).toContain("kind: NetworkPolicy");

    // S22: values.yaml carries the empty CIDR defaults the CLI overrides with --set, and
    // `strict: true` — the SECURE posture is the default. It was previously off only because
    // `nodeCidrs` had to be hand-supplied; deploy now discovers that range
    // (discoverClusterNodeCidrs), so the broad posture costs nothing to leave behind.
    //
    // Why it matters: the broad posture is `0.0.0.0/0 except <pod CIDR>`, which admits every
    // VPC peer, VM and hostNetwork pod to routing-service:8443. That service answers an
    // ordinary ext_proc call with the internal dispatch secret in its header mutation, so a
    // VPC-reachable caller can read the secret and replay trusted dispatch headers to a pool
    // to skip middleware. Pod-level isolation alone never closed that.
    const values = JSON.parse(result["values.yaml"].slice(result["values.yaml"].indexOf("{")));
    expect(values.global.networkPolicy).toEqual({ podCidrs: [], nodeCidrs: [], strict: true });
  });

  it("marks the secret-bearing templates for mode-0600 writes (M4)", () => {
    // adapter.ts writes chart files and MUST create these with mode 0600 — the set is
    // the single source of truth, kept next to the files' generation.
    expect(SECRET_CHART_FILES.has("templates/internal-secret.yaml")).toBe(true);
    expect(SECRET_CHART_FILES.has("templates/valkey-secret.yaml")).toBe(true);
    expect(SECRET_CHART_FILES.size).toBe(2);
  });

  it("throws a helpful error when the routing manifest exceeds the ConfigMap size limit", () => {
    const pools = new Map<string, PoolDefinition>([
      ["ssr", { name: "ssr", outputs: [], config: { routes: ["appPages"] } }],
    ]);

    // Build a manifest whose serialized form is well over ~950 KiB.
    const bigPoolAssignments: Record<string, string> = {};
    for (let i = 0; i < 40000; i++) {
      bigPoolAssignments[`/some/reasonably/long/route/path/number/${i}`] = "ssr";
    }
    const oversizedManifest: RoutingManifest = {
      ...mockManifest,
      poolAssignments: bigPoolAssignments,
    };

    expect(() =>
      generateHelmChart({
        pools,
        buildId: "abc123",
        nextVersion: "16.2.0",
        config: {
          pools: { ssr: { routes: ["appPages"] } },
          provider: { gke: {} },
        } as K8sAdapterConfig,
        imageRegistry: "gcr.io/my-project",
        routingManifest: oversizedManifest,
        internalSecret: "deadbeef",
      }),
    ).toThrow(/too large to embed in a ConfigMap/);
  });
});

// ---------------------------------------------------------------------------
// S25 — SECRET_CHART_FILES was an unverified hardcoded pair, and adapter.ts derives file mode
// 0600 from membership in it, so a third secret-bearing template would have been written
// world-readable with nothing failing anywhere.
// ---------------------------------------------------------------------------
describe("S25: secret-bearing templates are all mode-gated", () => {
  it("every rendered `kind: Secret` template is in SECRET_CHART_FILES", () => {
    const chart = chartFor("abc123");
    const secretFiles = Object.entries(chart)
      .filter(([name, body]) => name.startsWith("templates/") && /^kind: Secret$/m.test(body))
      .map(([name]) => name);
    expect(secretFiles.length).toBeGreaterThan(0);
    for (const name of secretFiles) expect(SECRET_CHART_FILES.has(name)).toBe(true);
  });

  it("the guard REJECTS a new Secret template that was not added to the set", () => {
    expect(() =>
      assertSecretChartFilesComplete({
        "templates/new-thing.yaml": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\n",
      }),
    ).toThrow(/not listed in SECRET_CHART_FILES/);
  });

  it("the guard REJECTS a listed file that stopped being a Secret", () => {
    expect(() =>
      assertSecretChartFilesComplete({
        "templates/internal-secret.yaml": "apiVersion: v1\nkind: ConfigMap\n",
      }),
    ).toThrow(/no longer renders a Secret/);
  });

  it("ignores non-template chart files", () => {
    expect(() => assertSecretChartFilesComplete({ "values.yaml": "kind: Secret\n" })).not.toThrow();
  });
});
