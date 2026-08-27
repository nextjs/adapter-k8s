import { describe, expect, it } from "vitest";
import {
  assertKubernetesServerVersion,
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  parseAndFingerprintCompositionPlan,
  parseAndVerifyCompositionPlan,
  parseCompositionPlan,
  type CompositionPlan,
} from "../src/composition-plan/index.js";

const TARGET_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function basePlan(): Record<string, unknown> {
  return {
    apiVersion: "adapter-k8s.nextjs.org/v1alpha1",
    kind: "CompositionPlan",
    metadata: {
      releaseName: "test-app",
      namespace: "test-app",
      buildId: "build-123",
    },
    target: {
      fingerprint: TARGET_FINGERPRINT,
      identity: {
        kind: "unverified",
        requireExplicitConfirmation: true,
      },
      access: {
        kind: "kubeconfig-current-context",
        requireExplicitConfirmation: true,
      },
      registry: {
        repository: "ghcr.io/davidilie/test-app",
        authentication: { kind: "ambient-credentials" },
        digestLookup: { kind: "oci-distribution" },
      },
    },
    requirements: {
      kubernetes: {
        minimumVersion: "1.33.0",
        resources: [{ apiVersion: "v1", resource: "services", optional: false }],
      },
    },
    operations: {
      resources: { objects: [], readiness: [] },
      network: {
        podCidrs: { kind: "not-required" },
        nodeCidrs: { kind: "kubernetes-node-addresses", addressTypes: ["InternalIP"] },
        missingSourcePolicy: "fail",
      },
      cache: { kind: "none" },
      cdn: { kind: "none" },
      routing: {
        protocol: "envoy-ext-proc-v3",
        failurePolicy: "closed",
        dataplane: {
          kind: "external-ext-proc",
          transport: "h2c",
          readiness: [],
        },
      },
      cleanup: {
        kubernetes: { strategy: "adapter-release-v1", contributedObjects: [] },
        external: [],
        retained: [],
      },
      diagnostics: [],
      logs: [],
    },
  };
}

function telemetrySource(id = "provider.nginx-ingress"): Record<string, unknown> {
  return {
    id,
    producer: { kind: "ingress-controller", name: "nginx-ingress" },
    owner: "operator",
    activation: {
      kind: "otel-operator",
      instrumentation: {
        apiVersion: "opentelemetry.io/v1alpha1",
        resource: "instrumentations",
        name: "nginx-ingress",
        namespace: "test-app",
      },
    },
    protocols: ["prometheus"],
    propagation: ["tracecontext"],
    signals: [
      {
        kind: "metric",
        name: "nginx_ingress_controller_requests",
        instrument: "counter",
        unit: "{request}",
      },
    ],
    workloads: [
      {
        kind: "kubernetes-object",
        object: {
          apiVersion: "apps/v1",
          resource: "deployments",
          name: "ingress-nginx-controller",
          namespace: "test-app",
        },
      },
    ],
    attributes: { "adapter_k8s.provider.name": "nginx-ingress" },
  };
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, entry]) => [key, reverseKeys(entry)]),
  );
}

describe("composition plan schema", () => {
  it("parses a closed v1alpha1 plan", () => {
    const plan = parseCompositionPlan(basePlan());
    expect(plan.apiVersion).toBe("adapter-k8s.nextjs.org/v1alpha1");
    expect(plan.requirements.kubernetes.minimumVersion).toBe("1.33.0");
    expect(plan.operations.routing).not.toHaveProperty("registration");
  });

  it("authenticates versioned routing registration operations", () => {
    const raw = basePlan();
    const routing = (raw.operations as Record<string, unknown>).routing as Record<string, unknown>;
    (routing.dataplane as Record<string, unknown>).transport = "tls";
    routing.registration = {
      kind: "gcp-traffic-extension-v1",
      projectId: "sample-project",
      extensionName: "test-app-traffic-ext",
      addressName: "test-app-ip",
    };
    expect(parseCompositionPlan(raw).operations.routing.registration).toEqual(routing.registration);

    (routing.registration as Record<string, unknown>).kind = "exec-provider-plugin";
    expect(() => parseCompositionPlan(raw)).toThrow(/unknown routing registration operation/i);
  });

  it("parses declarative provider telemetry without executing provider code", () => {
    const raw = basePlan();
    (raw.operations as Record<string, unknown>).telemetry = [telemetrySource()];
    const parsed = parseCompositionPlan(raw);
    expect(parsed.operations.telemetry).toEqual([telemetrySource()]);
  });

  it("keeps telemetry absent on older authenticated v1alpha1 plans", () => {
    const legacy = basePlan() as unknown as CompositionPlan;
    const legacyDigest = fingerprintCompositionPlan(legacy);
    const parsed = parseAndVerifyCompositionPlan(legacy, legacyDigest);
    expect(parsed.operations).not.toHaveProperty("telemetry");
  });

  it("rejects duplicate or malformed telemetry contributions", () => {
    const duplicate = basePlan();
    (duplicate.operations as Record<string, unknown>).telemetry = [
      telemetrySource(),
      telemetrySource(),
    ];
    expect(() => parseCompositionPlan(duplicate)).toThrow(/duplicate source id/i);

    const malformed = basePlan();
    const source = telemetrySource();
    (source.signals as Array<Record<string, unknown>>)[0]!.name = "bad metric name";
    (malformed.operations as Record<string, unknown>).telemetry = [source];
    expect(() => parseCompositionPlan(malformed)).toThrow(/invalid OpenTelemetry metric name/i);
  });

  it("rejects unknown fields at every parsed boundary", () => {
    const root = { ...basePlan(), command: "sh" };
    expect(() => parseCompositionPlan(root)).toThrow(/unknown field.*command/i);

    const nested = basePlan();
    (nested.operations as Record<string, unknown>).cache = {
      kind: "none",
      command: "gcloud",
    };
    expect(() => parseCompositionPlan(nested)).toThrow(
      /operations\.cache.*unknown field.*command/i,
    );
  });

  it("rejects unknown operation kinds before they reach an interpreter", () => {
    const plan = basePlan();
    (plan.operations as Record<string, unknown>).cache = {
      kind: "exec-provider-plugin",
      module: "./provider.mjs",
    };
    expect(() => parseCompositionPlan(plan)).toThrow(
      /unknown cache operation "exec-provider-plugin"/i,
    );
  });

  it("rejects unsupported plan versions instead of falling back", () => {
    const plan = basePlan();
    plan.apiVersion = "adapter-k8s.nextjs.org/v2";
    expect(() => parseCompositionPlan(plan)).toThrow(/expected.*v1alpha1/i);
  });

  it("enforces the Kubernetes 1.33 compatibility floor without a maximum", () => {
    const old = basePlan();
    const oldRequirements = old.requirements as {
      kubernetes: { minimumVersion: string };
    };
    oldRequirements.kubernetes.minimumVersion = "1.32.9";
    expect(() => parseCompositionPlan(old)).toThrow(/requires Kubernetes 1\.33\.0 or newer/i);

    const current = basePlan();
    const currentRequirements = current.requirements as {
      kubernetes: { minimumVersion: string };
    };
    currentRequirements.kubernetes.minimumVersion = "1.33.0";
    expect(() => parseCompositionPlan(current)).not.toThrow();

    const future = basePlan();
    const futureRequirements = future.requirements as {
      kubernetes: { minimumVersion: string };
    };
    futureRequirements.kubernetes.minimumVersion = "1.36.0";
    expect(() => parseCompositionPlan(future)).not.toThrow();
  });

  it("rejects cross-namespace readiness and dataplane references", () => {
    const readiness = basePlan();
    const operations = readiness.operations as Record<string, unknown>;
    const resources = operations.resources as Record<string, unknown>;
    resources.readiness = [
      {
        kind: "kubernetes-service-endpoints",
        service: { name: "foreign", namespace: "other", port: 3000 },
        minimumReady: 1,
      },
    ];
    expect(() => parseCompositionPlan(readiness)).toThrow(
      /resources\.readiness.*namespace test-app/i,
    );

    const dataplane = basePlan();
    const routing = (dataplane.operations as Record<string, unknown>).routing as Record<
      string,
      unknown
    >;
    routing.protocol = "pool-local-v1";
    routing.failurePolicy = "closed";
    routing.dataplane = {
      kind: "portable-http-origin",
      service: { name: "origin", namespace: "other", port: 3000 },
      targetPool: "default",
      readiness: [],
    };
    expect(() => parseCompositionPlan(dataplane)).toThrow(
      /dataplane\.service\.namespace.*namespace test-app/i,
    );
  });

  it.each(["service.name", "1service"])("rejects invalid Service name %s", (name) => {
    const plan = basePlan();
    const resources = (plan.operations as Record<string, unknown>).resources as Record<
      string,
      unknown
    >;
    resources.readiness = [
      {
        kind: "kubernetes-service-endpoints",
        service: { name, namespace: "test-app", port: 3000 },
        minimumReady: 1,
      },
    ];
    expect(() => parseCompositionPlan(plan)).toThrow(/invalid Service name/i);
  });
});

describe("composition plan fingerprints", () => {
  it("is invariant to object-key order", () => {
    const first = parseAndFingerprintCompositionPlan(basePlan());
    const second = parseAndFingerprintCompositionPlan(reverseKeys(basePlan()));
    expect(second.digest).toBe(first.digest);
    expect(canonicalCompositionPlanJson(second.plan)).toBe(
      canonicalCompositionPlanJson(first.plan),
    );
  });

  it("changes when the plan changes semantically", () => {
    const first = parseCompositionPlan(basePlan());
    const changedRaw = basePlan();
    const routing = (changedRaw.operations as Record<string, unknown>).routing as Record<
      string,
      unknown
    >;
    routing.failurePolicy = "open";
    const changed = parseCompositionPlan(changedRaw);
    expect(fingerprintCompositionPlan(changed)).not.toBe(fingerprintCompositionPlan(first));
  });

  it("verifies the expected digest and fails closed on a mismatch", () => {
    const { digest } = parseAndFingerprintCompositionPlan(basePlan());
    expect(parseAndVerifyCompositionPlan(basePlan(), digest).metadata.buildId).toBe("build-123");
    expect(() => parseAndVerifyCompositionPlan(basePlan(), `sha256:${"0".repeat(64)}`)).toThrow(
      /digest mismatch.*refusing to execute/i,
    );
  });
});

describe("Kubernetes server compatibility", () => {
  it("accepts 1.33+ server versions, including vendor suffixes", () => {
    expect(() => assertKubernetesServerVersion("v1.33.4+k3s1", "1.33.0")).not.toThrow();
    expect(() => assertKubernetesServerVersion("v1.35.1-gke.100", "1.33.0")).not.toThrow();
  });

  it("rejects a server below the plan requirement", () => {
    expect(() => assertKubernetesServerVersion("v1.32.8", "1.33.0")).toThrow(
      /older than.*1\.33\.0/i,
    );
  });
});
