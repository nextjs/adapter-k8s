export const COMPOSITION_PLAN_API_VERSION = "adapter-k8s.nextjs.org/v1alpha1" as const;
export const COMPOSITION_PLAN_KIND = "CompositionPlan" as const;
export const MINIMUM_KUBERNETES_VERSION = "1.33.0" as const;

export type CompositionPlanDigest = `sha256:${string}`;

export type GcpLocation = { kind: "region"; name: string } | { kind: "zone"; name: string };

export type ClusterIdentity =
  | {
      kind: "gke-resource";
      projectId: string;
      clusterName: string;
      location: GcpLocation;
      expectedKubeSystemUid?: string;
    }
  | {
      kind: "kubernetes-namespace-uid";
      namespace: "kube-system";
      uid: string;
    }
  | {
      kind: "unverified";
      requireExplicitConfirmation: true;
    };

export type ClusterAccess =
  | { kind: "kubeconfig-context"; context: string }
  | {
      kind: "kubeconfig-current-context";
      requireExplicitConfirmation: true;
    }
  | {
      kind: "gke-get-credentials";
      projectId: string;
      clusterName: string;
      location: GcpLocation;
    };

export type RegistryAuthentication =
  | { kind: "ambient-credentials" }
  | { kind: "gcloud-docker-helper"; registryHost: string };

export type RegistryDigestLookup =
  | { kind: "oci-distribution" }
  | { kind: "gcp-artifact-registry"; projectId: string };

export interface RegistryPlan {
  repository: string;
  authentication: RegistryAuthentication;
  digestLookup: RegistryDigestLookup;
}

export type NetworkCidrSource =
  | { kind: "not-required" }
  | { kind: "static"; cidrs: string[] }
  | { kind: "kubernetes-node-pod-cidrs" }
  | { kind: "kubernetes-node-addresses"; addressTypes: ["InternalIP"] }
  | {
      kind: "gke-pod-range";
      projectId: string;
      clusterName: string;
      location: GcpLocation;
    }
  | {
      kind: "gke-node-subnet";
      projectId: string;
      clusterName: string;
      location: GcpLocation;
    };

export interface NetworkPlan {
  podCidrs: NetworkCidrSource;
  nodeCidrs: NetworkCidrSource;
  missingSourcePolicy: "fail";
}

export type CacheProvisioning =
  | { kind: "none" }
  | { kind: "external"; lifecycle: "operator-managed" }
  | {
      kind: "gcp-memorystore";
      projectId: string;
      region: string;
      name: string;
      network: string;
      sizeGb: number;
      tier: "BASIC" | "STANDARD_HA";
      security: { kind: "auth-tls-required" } | { kind: "legacy-plaintext-explicit-opt-out" };
    };

export type CdnInvalidation =
  | { kind: "none" }
  | { kind: "external"; lifecycle: "operator-managed" }
  | {
      kind: "gcp-cloud-cdn";
      projectId: string;
      addressName: string;
      invalidation: "recorded-cache-tag-or-full-path";
      failurePolicy: "warn";
    };

export interface KubernetesObjectRef {
  apiVersion: string;
  resource: string;
  name: string;
  namespace?: string;
}

export interface KubernetesServiceRef {
  name: string;
  namespace: string;
  port: number;
}

export type RoutingReadiness =
  | {
      kind: "kubernetes-condition";
      object: KubernetesObjectRef;
      conditionsAt:
        | { kind: "object" }
        // minimumCount guards the shared-gateway case: a parentRef naming a NONEXISTENT
        // Gateway produces no status.parents entry at all, so with >=2 parentRefs the
        // remaining entries would satisfy the per-entry check and readiness would pass
        // wrongly. Requiring at least parentRefs.length reported parents closes that hole.
        | { kind: "parents"; controllerName?: string; minimumCount?: number }
        | { kind: "ancestors"; controllerName: string };
      condition: {
        type: string;
        status: "True";
        observedGeneration: "must-equal-metadata-generation";
      };
      timeoutSeconds: number;
    }
  | {
      kind: "kubernetes-job-complete";
      object: KubernetesObjectRef;
      timeoutSeconds: number;
    }
  | {
      kind: "kubernetes-deployment-available";
      object: KubernetesObjectRef;
      timeoutSeconds: number;
    }
  | {
      kind: "kubernetes-service-endpoints";
      service: KubernetesServiceRef;
      minimumReady: number;
    }
  | {
      kind: "gcp-traffic-extension";
      projectId: string;
      extensionName: string;
      addressName: string;
      requireEveryForwardingRule: true;
    };

/**
 * Adapter-owned work that attaches the routing service to an external data plane. This belongs
 * to the authenticated operation plan, not the contributor-facing routing-tier shape: adding a
 * future executor extends this operation union without adding a provider field to every adapter.
 */
export type RoutingRegistration =
  | { kind: "none" }
  | {
      kind: "gcp-traffic-extension-v1";
      projectId: string;
      extensionName: string;
      addressName: string;
    };

export type RoutingPlan =
  | {
      protocol: "pool-local-v1";
      failurePolicy: "closed";
      /** Absent on retained plans emitted before registration became an authenticated operation. */
      registration?: RoutingRegistration;
      dataplane: {
        kind: "portable-http-origin";
        service: KubernetesServiceRef;
        targetPool: string;
        readiness: RoutingReadiness[];
      };
    }
  | {
      protocol: "envoy-ext-proc-v3";
      failurePolicy: "open" | "closed";
      /** Absent on retained plans emitted before registration became an authenticated operation. */
      registration?: RoutingRegistration;
      dataplane:
        | {
            kind: "external-ext-proc";
            transport: "tls" | "h2c";
            readiness: RoutingReadiness[];
          }
        | {
            kind: "adapter-owned-envoy-proxy";
            service: KubernetesServiceRef;
            readiness: RoutingReadiness[];
          };
    };

export interface KubernetesOwnedObject {
  ref: KubernetesObjectRef;
  lifecycle: "helm" | "retain-with-build" | "retain-with-pool";
  ownership: {
    releaseLabel: {
      key: "adapter-k8s.dev/release";
      value: string;
    };
    helmRelease?: { name: string; namespace: string };
  };
}

export type ExternalCleanupOperation =
  | { kind: "gcp-storage-bucket"; projectId: string; bucket: string }
  | { kind: "gcp-service-account"; projectId: string; email: string }
  | { kind: "gcp-memorystore"; projectId: string; region: string; name: string }
  | {
      kind: "gcp-traffic-extension";
      projectId: string;
      name: string;
      location: "global";
    }
  | {
      kind: "gcp-backend-service";
      projectId: string;
      name: string;
      scope: "global";
    }
  | {
      kind: "gcp-health-check";
      projectId: string;
      name: string;
      scope: "global";
    }
  | { kind: "gcp-global-address"; projectId: string; name: string }
  | { kind: "gcp-custom-iam-role"; projectId: string; roleId: string };

export type RetainedExternalResource =
  | {
      kind: "gke-cluster";
      projectId: string;
      clusterName: string;
      location: GcpLocation;
    }
  | {
      kind: "gcp-artifact-registry";
      projectId: string;
      region: string;
      repository: string;
    }
  | { kind: "gcp-certificate-manager"; projectId: string; releasePrefix: string };

export interface CleanupPlan {
  kubernetes: {
    strategy: "adapter-release-v1";
    contributedObjects: KubernetesOwnedObject[];
  };
  external: ExternalCleanupOperation[];
  retained: RetainedExternalResource[];
}

export type DiagnosticSource =
  | {
      kind: "kubernetes-condition";
      check: Extract<RoutingReadiness, { kind: "kubernetes-condition" }>;
      label: string;
    }
  | { kind: "kubernetes-gateway-address"; gateway: KubernetesObjectRef }
  | { kind: "gcp-auth"; projectId: string }
  | { kind: "gcp-global-address"; projectId: string; name: string }
  | { kind: "gcp-storage-bucket"; projectId: string; bucket: string }
  | {
      kind: "gcp-artifact-registry";
      projectId: string;
      region: string;
      repository: string;
    }
  | { kind: "gcp-backend-health"; projectId: string; releasePrefix: string }
  | {
      kind: "gcp-traffic-extension";
      projectId: string;
      extensionName: string;
      addressName: string;
    }
  | {
      kind: "gcp-backend-service-shape";
      projectId: string;
      name: string;
      loadBalancingScheme: "EXTERNAL_MANAGED";
      requireBackend: true;
    }
  | {
      kind: "gcp-health-check-shape";
      projectId: string;
      name: string;
      expectedType: "TCP";
    }
  | { kind: "gcp-certificate"; projectId: string; name: string };

export interface LogSource {
  kind: "kubernetes-pods";
  namespace: string;
  selector: { releaseName: string };
  containers: "all";
}

export type TelemetryProducerKind =
  | "adapter-runtime"
  | "data-plane"
  | "ingress-controller"
  | "managed-provider";

export type TelemetryOwner = "adapter" | "application" | "operator" | "cloud-provider";

export type TelemetryActivation =
  | { kind: "app-instrumentation-hook" }
  | { kind: "otel-operator"; instrumentation: KubernetesObjectRef }
  | { kind: "external-precondition"; description: string }
  | { kind: "managed" };

export type TelemetryProtocol = "otel-api" | "otlp" | "prometheus" | "cloud-managed";

export type TelemetryPropagation = "tracecontext" | "tracestate" | "baggage-pass-through";

export type TelemetrySignal =
  | { kind: "span"; name: string }
  | {
      kind: "metric";
      name: string;
      instrument: "counter" | "histogram" | "gauge" | "up-down-counter";
      unit?: string;
    }
  | { kind: "log"; name: string };

export type TelemetryWorkload =
  | { kind: "adapter-pool"; pool: string }
  | { kind: "adapter-routing-service" }
  | { kind: "kubernetes-object"; object: KubernetesObjectRef }
  | { kind: "managed-service"; name: string };

/** One independently-owned signal producer in the composed request topology. */
export interface TelemetrySource {
  id: string;
  producer: { kind: TelemetryProducerKind; name: string };
  owner: TelemetryOwner;
  activation: TelemetryActivation;
  protocols: TelemetryProtocol[];
  propagation: TelemetryPropagation[];
  signals: TelemetrySignal[];
  workloads: TelemetryWorkload[];
  /** Static, bounded dimensions a runtime/provider must attach to this source's signals. */
  attributes: Record<string, string>;
}

export interface KubernetesApiRequirement {
  apiVersion: string;
  resource: string;
  optional: boolean;
}

export type KubernetesJsonValue =
  | null
  | boolean
  | number
  | string
  | KubernetesJsonValue[]
  | { [key: string]: KubernetesJsonValue };

/** A build-time Kubernetes object. Hooks emit JSON data, never raw YAML or runtime callbacks. */
export interface KubernetesManifest {
  apiVersion: string;
  kind: string;
  /** Kubernetes API resource name used for discovery and exact cleanup. */
  resource: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  body?: Record<string, KubernetesJsonValue>;
}

export interface KubernetesResourcePlan {
  objects: KubernetesManifest[];
  readiness: RoutingReadiness[];
}

export interface CompositionPlanV1 {
  apiVersion: typeof COMPOSITION_PLAN_API_VERSION;
  kind: typeof COMPOSITION_PLAN_KIND;
  metadata: {
    releaseName: string;
    namespace: string;
    buildId: string;
  };
  target: {
    fingerprint: CompositionPlanDigest;
    identity: ClusterIdentity;
    access: ClusterAccess;
    registry: RegistryPlan;
  };
  requirements: {
    kubernetes: {
      minimumVersion: string;
      resources: KubernetesApiRequirement[];
    };
  };
  operations: {
    resources: KubernetesResourcePlan;
    network: NetworkPlan;
    cache: CacheProvisioning;
    cdn: CdnInvalidation;
    routing: RoutingPlan;
    cleanup: CleanupPlan;
    diagnostics: DiagnosticSource[];
    logs: LogSource[];
    /**
     * Optional for backwards compatibility with retained v1alpha1 plans emitted before the
     * telemetry inventory existed. New compilers always emit it; parsers preserve absence so an
     * old plan's authenticated digest remains stable.
     */
    telemetry?: TelemetrySource[];
  };
}

export type CompositionPlan = CompositionPlanV1;
