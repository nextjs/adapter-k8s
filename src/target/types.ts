import type { HostConfig } from "../types.js";
import type {
  ClusterAccess,
  ClusterIdentity,
  CompositionPlan,
  DiagnosticSource,
  ExternalCleanupOperation,
  KubernetesApiRequirement,
  KubernetesManifest,
  KubernetesObjectRef,
  KubernetesServiceRef,
  NetworkPlan,
  RegistryAuthentication,
  RegistryDigestLookup,
  RegistryPlan,
  RetainedExternalResource,
  RoutingPlan,
  RoutingReadiness,
  TelemetrySource,
} from "../composition-plan/types.js";

export interface TargetBuildContext {
  releaseName: string;
  namespace: string;
  buildId: string;
  imageRegistry: string;
  pools: readonly string[];
  defaultPool: string;
  failurePolicy: "open" | "closed";
  cache?: "none" | "external";
  infrastructure?: {
    projectId?: string;
    region?: string;
  };
}

export interface OperationalContribution {
  externalCleanup?: ExternalCleanupOperation[];
  retained?: RetainedExternalResource[];
  diagnostics?: DiagnosticSource[];
  /** Declarative OTEL/native signal sources contributed by this target component. */
  telemetry?: TelemetrySource[];
}

export interface KubernetesContribution extends OperationalContribution {
  objects?: KubernetesManifest[];
  requirements?: KubernetesApiRequirement[];
  readiness?: RoutingReadiness[];
}

export interface IngressSourceSet {
  cidrs: string[];
  podSelectors: Array<{ namespace?: string; labels: Record<string, string> }>;
}

export type ExposureCapability =
  | { kind: "manual" }
  | {
      kind: "gateway-api";
      className: string;
      gateway: KubernetesObjectRef;
      applicationRoutes: KubernetesObjectRef[];
    }
  | { kind: "ingress"; className: string };

export type ExposureRequirement = Extract<ExposureCapability, { kind: "gateway-api" }>;

export interface ClusterBuildResult extends OperationalContribution {
  identity: ClusterIdentity;
  access: ClusterAccess;
  registry: RegistryPlan;
  network: NetworkPlan;
}

export interface ClusterComponent {
  readonly componentType: "cluster";
  readonly name: string;
  build(context: TargetBuildContext): ClusterBuildResult;
}

export interface ExposureBuildContext extends TargetBuildContext {
  origin: RoutingOrigin;
}

export interface ExposureBuildResult extends KubernetesContribution {
  ingressSources: IngressSourceSet;
  capabilities: ExposureCapability[];
}

export interface ExposureComponent {
  readonly componentType: "exposure";
  readonly name: string;
  readonly hosts: readonly HostConfig[];
  build(context: ExposureBuildContext): ExposureBuildResult;
}

export interface ResourceComponent {
  readonly componentType: "resource";
  readonly name: string;
  build(context: TargetBuildContext): KubernetesContribution;
}

export type DisabledRoutingTier = {
  enabled: false;
  serviceAnnotations: Record<string, string>;
  registration: "none";
  transport?: never;
  callerAuthentication?: never;
};

export type RoutingCallerAuthentication = {
  kind: "none";
  networkPolicy: "required";
  transportSecurity: "none" | "server-tls";
};

export type EnabledRoutingTier =
  | {
      enabled: true;
      transport: "tls" | "h2c";
      callerAuthentication: RoutingCallerAuthentication;
      serviceAnnotations: Record<string, string>;
      registration: "none";
    }
  | {
      enabled: true;
      transport: "tls";
      callerAuthentication: RoutingCallerAuthentication & { transportSecurity: "server-tls" };
      serviceAnnotations: Record<string, string>;
      /**
       * Built-in GKE bridge. This is not an extension hook because Helm has one matching
       * executor. Move registration into a versioned apply operation before adding another
       * external control plane.
       */
      registration: "gke-traffic-extension";
    };

export type RoutingTier = DisabledRoutingTier | EnabledRoutingTier;

/**
 * The routing plan and emitted routing tier are one contract. Keeping them in a
 * discriminated union makes impossible combinations fail in TypeScript, while the target
 * compiler applies the same checks to JavaScript and untyped third-party adapters.
 */
export type RoutingBuildResult = KubernetesContribution &
  (
    | {
        plan: Extract<RoutingPlan, { protocol: "pool-local-v1" }>;
        routingTier: DisabledRoutingTier;
      }
    | {
        plan: Extract<RoutingPlan, { protocol: "envoy-ext-proc-v3" }>;
        routingTier: EnabledRoutingTier;
      }
  );

export interface RoutingBuildContext extends TargetBuildContext {
  exposureCapabilities: readonly ExposureCapability[];
}

/**
 * Destination exposed before routing runs. Kubernetes Service is the only supported origin
 * today. The discriminant leaves room for a future proxy origin without overloading a Service
 * reference or changing the exposure context shape.
 */
export type RoutingOrigin = { kind: "kubernetes-service"; service: KubernetesServiceRef };

export interface RoutingComponent {
  readonly componentType: "routing";
  readonly name: string;
  origin(context: TargetBuildContext): RoutingOrigin;
  build(context: RoutingBuildContext): RoutingBuildResult;
}

export interface KubernetesTargetDefinition {
  readonly componentType: "target";
  readonly cluster: ClusterComponent;
  readonly exposure: ExposureComponent;
  readonly routing: RoutingComponent;
  readonly resources: readonly ResourceComponent[];
}

export interface DefineTargetOptions {
  cluster: ClusterComponent;
  exposure: ExposureComponent;
  routing?: RoutingComponent;
  resources?: readonly ResourceComponent[];
}

export interface CompiledKubernetesTarget {
  plan: CompositionPlan;
  defaultPool: string;
  hosts: HostConfig[];
  ingressSources: IngressSourceSet;
  routingTier: RoutingTier;
  /** Validated routing component name stamped onto adapter-owned runtime telemetry. */
  routingProviderName: string;
}

export interface KubernetesClusterOptions {
  identity?: ClusterIdentity;
  access?: ClusterAccess;
  registry?: {
    authentication?: RegistryAuthentication;
    digestLookup?: RegistryDigestLookup;
  };
  network?: NetworkPlan;
}

export interface GkeClusterOptions {
  projectId?: string;
  region?: string;
  clusterName?: string;
  registry?: {
    authentication?: RegistryAuthentication;
    digestLookup?: RegistryDigestLookup;
  };
}
