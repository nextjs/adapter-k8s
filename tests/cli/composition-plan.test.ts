import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../../src/cli/exec.js");

import { execCapture, execOrThrow } from "../../src/cli/exec.js";
import {
  assertCompositionPlanInvocation,
  compositionPlanNeedsExplicitConfirmation,
  describeCompositionPlan,
  evaluateCompositionPlanDiagnostics,
  evaluateCompositionPlanReadiness,
  loadDeployedCompositionPlan,
  loadLocalCompositionPlan,
  preflightCompositionPlan,
} from "../../src/cli/composition-plan.js";
import {
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  parseCompositionPlan,
  type CompositionPlan,
} from "../../src/composition-plan/index.js";
import { compositionPlanConfigMapName } from "../../src/emit/templates/composition-plan-configmap.js";

const RELEASE = "test-app";
const NAMESPACE = "test-app";
const BUILD = "build-123";
const TARGET_FINGERPRINT = `sha256:${"a".repeat(64)}`;

function plan(
  overrides: {
    identity?: CompositionPlan["target"]["identity"];
    access?: CompositionPlan["target"]["access"];
    requirements?: CompositionPlan["requirements"]["kubernetes"]["resources"];
    readiness?: CompositionPlan["operations"]["resources"]["readiness"];
    objects?: CompositionPlan["operations"]["resources"]["objects"];
    diagnostics?: CompositionPlan["operations"]["diagnostics"];
    telemetry?: NonNullable<CompositionPlan["operations"]["telemetry"]>;
  } = {},
): CompositionPlan {
  return parseCompositionPlan({
    apiVersion: "adapter-k8s.nextjs.org/v1alpha1",
    kind: "CompositionPlan",
    metadata: { releaseName: RELEASE, namespace: NAMESPACE, buildId: BUILD },
    target: {
      fingerprint: TARGET_FINGERPRINT,
      identity: overrides.identity ?? {
        kind: "unverified",
        requireExplicitConfirmation: true,
      },
      access: overrides.access ?? {
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
        resources: overrides.requirements ?? [
          { apiVersion: "v1", resource: "services", optional: false },
        ],
      },
    },
    operations: {
      resources: { objects: overrides.objects ?? [], readiness: overrides.readiness ?? [] },
      network: {
        podCidrs: { kind: "not-required" },
        nodeCidrs: { kind: "kubernetes-node-addresses", addressTypes: ["InternalIP"] },
        missingSourcePolicy: "fail",
      },
      cache: { kind: "none" },
      cdn: { kind: "none" },
      routing: {
        protocol: "pool-local-v1",
        failurePolicy: "closed",
        dataplane: {
          kind: "portable-http-origin",
          service: { name: `${RELEASE}-origin`, namespace: NAMESPACE, port: 3000 },
          targetPool: "default",
          readiness: [],
        },
      },
      cleanup: {
        kubernetes: {
          strategy: "adapter-release-v1",
          contributedObjects: (overrides.objects ?? []).map((object) => ({
            ref: {
              apiVersion: object.apiVersion,
              resource: object.resource,
              name: object.metadata.name,
              ...(object.metadata.namespace ? { namespace: object.metadata.namespace } : {}),
            },
            lifecycle: "helm",
            ownership: {
              releaseLabel: { key: "adapter-k8s.dev/release", value: RELEASE },
              helmRelease: { name: RELEASE, namespace: NAMESPACE },
            },
          })),
        },
        external: [],
        retained: [],
      },
      diagnostics: overrides.diagnostics ?? [],
      telemetry: overrides.telemetry ?? [],
      logs: [
        {
          kind: "kubernetes-pods",
          namespace: NAMESPACE,
          selector: { releaseName: RELEASE },
          containers: "all",
        },
      ],
    },
  });
}

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("composition-plan snapshots", () => {
  let temp: string;

  beforeEach(() => {
    temp = mkdtempSync(path.join(os.tmpdir(), "adapter-k8s-plan-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(temp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("requires the local file and build-metadata digest to authenticate each other", () => {
    const value = plan();
    const digest = fingerprintCompositionPlan(value);
    writeFileSync(path.join(temp, "composition-plan.json"), JSON.stringify(value));

    const loaded = loadLocalCompositionPlan(temp, {
      buildId: BUILD,
      compositionPlan: { digest, targetFingerprint: TARGET_FINGERPRINT },
    });
    expect(loaded?.digest).toBe(digest);
    expect(loaded?.plan.metadata.buildId).toBe(BUILD);

    expect(() =>
      loadLocalCompositionPlan(temp, {
        buildId: BUILD,
        compositionPlan: {
          digest: `sha256:${"0".repeat(64)}`,
          targetFingerprint: TARGET_FINGERPRINT,
        },
      }),
    ).toThrow(/digest mismatch.*refusing to execute/i);
    expect(() => loadLocalCompositionPlan(temp, { buildId: BUILD })).toThrow(
      /unauthenticated leftover plan/i,
    );
  });

  it("verifies a deployed ConfigMap against its digest and requested identity", async () => {
    const value = plan();
    const digest = fingerprintCompositionPlan(value);
    vi.mocked(execCapture).mockResolvedValue(
      ok(
        JSON.stringify({
          metadata: { annotations: { "adapter-k8s.dev/composition-digest": digest } },
          data: { "plan.json": canonicalCompositionPlanJson(value) },
        }),
      ),
    );

    const loaded = await loadDeployedCompositionPlan({
      releaseName: RELEASE,
      namespace: NAMESPACE,
      buildId: BUILD,
      expected: { digest, targetFingerprint: TARGET_FINGERPRINT },
    });
    expect(loaded?.digest).toBe(digest);
    expect(execCapture).toHaveBeenCalledWith(
      "kubectl",
      [
        "get",
        "configmap",
        compositionPlanConfigMapName(RELEASE, BUILD),
        "-n",
        NAMESPACE,
        "-o",
        "json",
        "--ignore-not-found",
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );

    await expect(
      loadDeployedCompositionPlan({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        buildId: BUILD,
        expected: {
          digest: `sha256:${"f".repeat(64)}`,
          targetFingerprint: TARGET_FINGERPRINT,
        },
      }),
    ).rejects.toThrow(/does not match committed deploy state/i);

    vi.mocked(execCapture).mockResolvedValue(
      ok(
        JSON.stringify({
          metadata: {
            annotations: {
              "adapter-k8s.dev/composition-digest": `sha256:${"0".repeat(64)}`,
            },
          },
          data: { "plan.json": canonicalCompositionPlanJson(value) },
        }),
      ),
    );
    await expect(
      loadDeployedCompositionPlan({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        buildId: BUILD,
      }),
    ).rejects.toThrow(/digest mismatch.*refusing to execute/i);
  });

  it("keeps legacy artifacts and missing deployed snapshots compatible", async () => {
    expect(loadLocalCompositionPlan(temp, { buildId: BUILD })).toBeNull();
    vi.mocked(execCapture).mockResolvedValue(ok());
    await expect(
      loadDeployedCompositionPlan({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        buildId: BUILD,
      }),
    ).resolves.toBeNull();

    vi.mocked(execCapture).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "Error from server: forbidden; configmap was not found in the local cache",
    });
    await expect(
      loadDeployedCompositionPlan({
        releaseName: RELEASE,
        namespace: NAMESPACE,
        buildId: BUILD,
      }),
    ).rejects.toThrow(/could not read deployed composition plan.*forbidden/i);
  });
});

describe("composition-plan cluster preflight", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execOrThrow).mockResolvedValue(undefined);
  });

  it("pins and verifies a GKE resource without consulting a provider name", async () => {
    const value = plan({
      identity: {
        kind: "gke-resource",
        projectId: "proj-12345",
        clusterName: "test-app-cluster",
        location: { kind: "region", name: "europe-west2" },
      },
      access: {
        kind: "gke-get-credentials",
        projectId: "proj-12345",
        clusterName: "test-app-cluster",
        location: { kind: "region", name: "europe-west2" },
      },
      requirements: [
        { apiVersion: "v1", resource: "services", optional: false },
        {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "gateways",
          optional: false,
        },
      ],
    });
    vi.mocked(execCapture).mockImplementation((async (_command: string, args: string[]) => {
      const raw = args.at(-1);
      if (raw === "/version") return ok(JSON.stringify({ gitVersion: "v1.35.2-gke.10" }));
      if (raw === "/api/v1") {
        return ok(JSON.stringify({ resources: [{ name: "services", kind: "Service" }] }));
      }
      if (raw === "/apis/gateway.networking.k8s.io/v1") {
        return ok(JSON.stringify({ resources: [{ name: "gateways", kind: "Gateway" }] }));
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    }) as never);

    const result = await preflightCompositionPlan(value, { explicitlyConfirmed: false });
    expect(result.serverVersion).toBe("v1.35.2-gke.10");
    expect(result.clusterIdentity).toContain("proj-12345/test-app-cluster");
    expect(execOrThrow).toHaveBeenCalledWith(
      "gcloud",
      [
        "container",
        "clusters",
        "get-credentials",
        "test-app-cluster",
        "--region",
        "europe-west2",
        "--project",
        "proj-12345",
        "--quiet",
      ],
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it("requires explicit confirmation for an unverified current context", async () => {
    const value = plan();
    expect(compositionPlanNeedsExplicitConfirmation(value)).toBe(true);
    await expect(preflightCompositionPlan(value, { explicitlyConfirmed: false })).rejects.toThrow(
      /requires explicit confirmation/i,
    );
    expect(execCapture).not.toHaveBeenCalled();
  });

  it("rejects Kubernetes below 1.33 and a missing required API", async () => {
    const value = plan({
      identity: { kind: "kubernetes-namespace-uid", namespace: "kube-system", uid: "uid-1" },
      access: { kind: "kubeconfig-context", context: "home" },
    });
    vi.mocked(execCapture).mockImplementation((async (_command: string, args: string[]) => {
      if (args.join(" ") === "config current-context") return ok("home\n");
      const raw = args.at(-1);
      if (raw === "/api/v1/namespaces/kube-system") {
        return ok(JSON.stringify({ metadata: { uid: "uid-1" } }));
      }
      if (raw === "/version") return ok(JSON.stringify({ gitVersion: "v1.32.9" }));
      throw new Error(`unexpected args: ${args.join(" ")}`);
    }) as never);
    await expect(preflightCompositionPlan(value, { explicitlyConfirmed: false })).rejects.toThrow(
      /older than.*1\.33\.0/i,
    );

    vi.mocked(execCapture).mockImplementation((async (_command: string, args: string[]) => {
      if (args.join(" ") === "config current-context") return ok("home\n");
      const raw = args.at(-1);
      if (raw === "/api/v1/namespaces/kube-system") {
        return ok(JSON.stringify({ metadata: { uid: "uid-1" } }));
      }
      if (raw === "/version") return ok(JSON.stringify({ gitVersion: "v1.33.0" }));
      if (raw === "/api/v1") return ok(JSON.stringify({ resources: [] }));
      throw new Error(`unexpected args: ${args.join(" ")}`);
    }) as never);
    await expect(preflightCompositionPlan(value, { explicitlyConfirmed: false })).rejects.toThrow(
      /missing required APIs: v1\/services/i,
    );
  });

  it("infers contributed APIs and verifies their discovered kind", async () => {
    const value = plan({
      identity: { kind: "kubernetes-namespace-uid", namespace: "kube-system", uid: "uid-1" },
      access: { kind: "kubeconfig-context", context: "home" },
      objects: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
          resource: "ingresses",
          metadata: { name: "test-app", namespace: NAMESPACE },
          body: { spec: {} },
        },
      ],
    });
    vi.mocked(execCapture).mockImplementation((async (_command: string, args: string[]) => {
      if (args.join(" ") === "config current-context") return ok("home\n");
      const raw = args.at(-1);
      if (raw === "/api/v1/namespaces/kube-system") {
        return ok(JSON.stringify({ metadata: { uid: "uid-1" } }));
      }
      if (raw === "/version") return ok(JSON.stringify({ gitVersion: "v1.33.0" }));
      if (raw === "/api/v1") {
        return ok(JSON.stringify({ resources: [{ name: "services", kind: "Service" }] }));
      }
      if (raw === "/apis/networking.k8s.io/v1") {
        return ok(JSON.stringify({ resources: [{ name: "ingresses", kind: "StatefulSet" }] }));
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    }) as never);

    await expect(preflightCompositionPlan(value, { explicitlyConfirmed: false })).rejects.toThrow(
      /ingresses reports kind StatefulSet, expected Ingress/i,
    );
  });
});

describe("composition-plan readiness and descriptions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads object, parents, ancestors and EndpointSlices without jsonpath assumptions", async () => {
    const value = plan({
      readiness: [
        {
          kind: "kubernetes-condition",
          object: {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "gateways",
            name: "test-app-gateway",
            namespace: NAMESPACE,
          },
          conditionsAt: { kind: "object" },
          condition: {
            type: "Programmed",
            status: "True",
            observedGeneration: "must-equal-metadata-generation",
          },
          timeoutSeconds: 30,
        },
        {
          kind: "kubernetes-condition",
          object: {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "httproutes",
            name: "test-app-routes",
            namespace: NAMESPACE,
          },
          conditionsAt: { kind: "parents", controllerName: "example.net/controller" },
          condition: {
            type: "Accepted",
            status: "True",
            observedGeneration: "must-equal-metadata-generation",
          },
          timeoutSeconds: 30,
        },
        {
          kind: "kubernetes-condition",
          object: {
            apiVersion: "gateway.envoyproxy.io/v1alpha1",
            resource: "envoyextensionpolicies",
            name: "test-app-routing",
            namespace: NAMESPACE,
          },
          conditionsAt: {
            kind: "ancestors",
            controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
          },
          condition: {
            type: "Accepted",
            status: "True",
            observedGeneration: "must-equal-metadata-generation",
          },
          timeoutSeconds: 30,
        },
        {
          kind: "kubernetes-service-endpoints",
          service: { name: "test-app-origin", namespace: NAMESPACE, port: 3000 },
          minimumReady: 2,
        },
      ],
    });
    vi.mocked(execCapture).mockImplementation((async (_command: string, args: string[]) => {
      const raw = args.at(-1)!;
      if (raw.includes("/gateways/")) {
        return ok(
          JSON.stringify({
            metadata: { generation: 4 },
            status: {
              conditions: [{ type: "Programmed", status: "True", observedGeneration: 4 }],
            },
          }),
        );
      }
      if (raw.includes("/httproutes/")) {
        return ok(
          JSON.stringify({
            metadata: { generation: 2 },
            status: {
              parents: [
                {
                  controllerName: "another/controller",
                  conditions: [{ type: "Accepted", status: "False", observedGeneration: 2 }],
                },
                {
                  controllerName: "example.net/controller",
                  conditions: [{ type: "Accepted", status: "True", observedGeneration: 2 }],
                },
              ],
            },
          }),
        );
      }
      if (raw.includes("/envoyextensionpolicies/")) {
        return ok(
          JSON.stringify({
            metadata: { generation: 7 },
            status: {
              ancestors: [
                {
                  controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
                  conditions: [{ type: "Accepted", status: "True", observedGeneration: 7 }],
                },
              ],
            },
          }),
        );
      }
      if (raw.includes("/endpointslices?")) {
        return ok(
          JSON.stringify({
            items: [
              {
                endpoints: [
                  { conditions: { ready: true } },
                  { conditions: { ready: false } },
                  { conditions: {} },
                  { conditions: { ready: true, terminating: true } },
                ],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected raw path ${raw}`);
    }) as never);

    const checks = await evaluateCompositionPlanReadiness(value);
    expect(checks).toHaveLength(4);
    expect(checks.every((check) => check.status === "pass")).toBe(true);
    expect(checks.at(-1)?.message).toBe("2/2 ready service endpoints");
  });

  it("parses and enforces a parents minimumCount (missing parent Gateway reports nothing)", async () => {
    const routeReadiness = (minimumCount: number) =>
      ({
        kind: "kubernetes-condition",
        object: {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "httproutes",
          name: "test-app-routes",
          namespace: NAMESPACE,
        },
        conditionsAt: { kind: "parents", minimumCount },
        condition: {
          type: "Accepted",
          status: "True",
          observedGeneration: "must-equal-metadata-generation",
        },
        timeoutSeconds: 30,
      }) as const;
    // Parse round-trips minimumCount and rejects invalid values.
    const parsed = plan({ readiness: [routeReadiness(2)] });
    expect(parsed.operations.resources.readiness[0]).toMatchObject({
      conditionsAt: { kind: "parents", minimumCount: 2 },
    });
    expect(() => plan({ readiness: [routeReadiness(0)] })).toThrow(
      /minimumCount.*expected an integer/i,
    );

    // One of two named parents exists: its Accepted=True entry alone must NOT pass.
    const oneParentReported = JSON.stringify({
      metadata: { generation: 3 },
      status: {
        parents: [
          {
            controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
            conditions: [{ type: "Accepted", status: "True", observedGeneration: 3 }],
          },
        ],
      },
    });
    vi.mocked(execCapture).mockResolvedValue(ok(oneParentReported));
    await expect(evaluateCompositionPlanReadiness(parsed)).resolves.toMatchObject([
      { status: "fail", message: expect.stringContaining("1/2 parents have reported status") },
    ]);

    // The same status satisfies minimumCount: 1.
    await expect(
      evaluateCompositionPlanReadiness(plan({ readiness: [routeReadiness(1)] })),
    ).resolves.toMatchObject([{ status: "pass" }]);
  });

  it("does not accept a stale observedGeneration", async () => {
    const value = plan({
      readiness: [
        {
          kind: "kubernetes-condition",
          object: {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "gateways",
            name: "test-app-gateway",
            namespace: NAMESPACE,
          },
          conditionsAt: { kind: "object" },
          condition: {
            type: "Programmed",
            status: "True",
            observedGeneration: "must-equal-metadata-generation",
          },
          timeoutSeconds: 30,
        },
      ],
    });
    vi.mocked(execCapture).mockResolvedValue(
      ok(
        JSON.stringify({
          metadata: { generation: 9 },
          status: {
            conditions: [{ type: "Programmed", status: "True", observedGeneration: 8 }],
          },
        }),
      ),
    );
    await expect(evaluateCompositionPlanReadiness(value)).resolves.toMatchObject([
      { status: "fail", message: "Programmed is stale for generation 9" },
    ]);
  });

  it("executes diagnostics from their typed plan operations", async () => {
    const value = plan({
      diagnostics: [
        {
          kind: "kubernetes-gateway-address",
          gateway: {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "gateways",
            name: "test-app-gateway",
            namespace: NAMESPACE,
          },
        },
        {
          kind: "gcp-health-check-shape",
          projectId: "sample-project",
          name: "test-app-routing-hc",
          expectedType: "TCP",
        },
      ],
    });
    vi.mocked(execCapture).mockImplementation((async (command: string, args: string[]) => {
      if (command === "kubectl") {
        return ok(JSON.stringify({ status: { addresses: [{ value: "192.0.2.10" }] } }));
      }
      if (command === "gcloud" && args.includes("health-checks")) return ok("TCP\n");
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    }) as never);

    await expect(evaluateCompositionPlanDiagnostics(value)).resolves.toEqual([
      expect.objectContaining({ status: "pass", message: "192.0.2.10" }),
      expect.objectContaining({ status: "pass", message: "TCP" }),
    ]);
  });

  it("exposes exact resources, log selectors and cleanup ownership", () => {
    const value = plan({
      objects: [
        {
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
          resource: "ingresses",
          metadata: { name: "test-app-ingress", namespace: NAMESPACE },
          body: { spec: { ingressClassName: "nginx" } },
        },
      ],
      telemetry: [
        {
          id: "provider.nginx-ingress",
          producer: { kind: "ingress-controller", name: "nginx-ingress" },
          owner: "operator",
          activation: { kind: "managed" },
          protocols: ["prometheus"],
          propagation: ["tracecontext"],
          signals: [
            {
              kind: "metric",
              name: "nginx_ingress_controller_requests",
              instrument: "counter",
            },
          ],
          workloads: [{ kind: "managed-service", name: "nginx-ingress" }],
          attributes: { "adapter_k8s.provider.name": "nginx-ingress" },
        },
      ],
    });
    assertCompositionPlanInvocation(value, {
      releaseName: RELEASE,
      namespace: NAMESPACE,
      buildId: BUILD,
    });
    const description = describeCompositionPlan(value);
    expect(description.resources).toEqual([
      {
        ref: {
          apiVersion: "networking.k8s.io/v1",
          resource: "ingresses",
          name: "test-app-ingress",
          namespace: NAMESPACE,
        },
        lifecycle: "helm",
      },
    ]);
    expect(description.logs).toEqual([
      {
        namespace: NAMESPACE,
        selector: `adapter-k8s.dev/release=${RELEASE}`,
        containers: "all",
      },
    ]);
    expect(description.telemetry).toEqual(value.operations.telemetry);
    expect(description.cleanup.kubernetes[0]?.ref.name).toBe("test-app-ingress");
  });
});
