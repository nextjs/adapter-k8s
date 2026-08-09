import { describe, expect, it } from "vitest";
import {
  assertKubernetesServerVersion,
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  parseAndFingerprintCompositionPlan,
  parseAndVerifyCompositionPlan,
  parseCompositionPlan,
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
