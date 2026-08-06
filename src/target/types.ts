import type { HostConfig } from "../types.js";
import type {
  ClusterAccess,
  ClusterIdentity,
  CompositionPlan,
  KubernetesApiRequirement,
  KubernetesManifest,
  KubernetesServiceRef,
  NetworkPlan,
  RegistryAuthentication,
  RegistryDigestLookup,
  RegistryPlan,
  RoutingPlan,
  RoutingReadiness,
} from "../composition-plan/types.js";

export interface TargetBuildContext {
  releaseName: string;
  namespace: string;
  buildId: string;
  imageRegistry: string;
  pools: readonly string[];
  defaultPool: string;
  failurePolicy: "open" | "closed";
  infrastructure?: {
    projectId?: string;
    region?: string;
  };
}

export interface KubernetesContribution {
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
  | { kind: "gateway-api"; className: string }
  | { kind: "ingress"; className: string };

export type ExposureRequirement = Extract<ExposureCapability, { kind: "gateway-api" }>;

export interface ClusterBuildResult {
  identity: ClusterIdentity;
  access: ClusterAccess;
  registry: RegistryPlan;
  network: NetworkPlan;
  managedCache: "none" | "gcp-memorystore";
}

export interface ClusterComponent {
  readonly componentType: "cluster";
  readonly name: string;
  build(context: TargetBuildContext): ClusterBuildResult;
}

export interface ExposureBuildContext extends TargetBuildContext {
  backend: KubernetesServiceRef;
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

export interface RoutingBuildResult extends KubernetesContribution {
  plan: RoutingPlan;
  backend: KubernetesServiceRef;
  requiresExposure?: ExposureRequirement;
  routingTier: {
    enabled: boolean;
    transport?: "tls" | "h2c";
    serviceAnnotations: Record<string, string>;
    registration: "none" | "gke-traffic-extension";
  };
}

export interface RoutingComponent {
  readonly componentType: "routing";
  readonly name: string;
  build(context: TargetBuildContext): RoutingBuildResult;
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
  hosts: HostConfig[];
  ingressSources: IngressSourceSet;
  routingTier: RoutingBuildResult["routingTier"];
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
