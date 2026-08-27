// src/index.ts
import { createK8sAdapter } from "./adapter.js";
export { createK8sAdapter };
export {
  defineClusterComponent,
  defineExposureComponent,
  defineResourceComponent,
  defineRoutingComponent,
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeNativeRouting,
  httpRouteExposure,
  ingressExposure,
  kubernetesCluster,
  manualExposure,
  portableRouting,
} from "./target/index.js";
// Default instance for zero-config use via adapterPath: '@next-community/adapter-k8s'
// It will attempt to load adapter.config.ts from the project root.
const defaultAdapter = createK8sAdapter();
export default defaultAdapter;

export type {
  K8sAdapterConfig,
  PoolConfig,
  GKEProviderConfig,
  RoutingManifest,
  PoolManifest,
} from "./types.js";
export type {
  CacheProvisioning,
  ClusterAccess,
  ClusterIdentity,
  DiagnosticSource,
  KubernetesApiRequirement,
  KubernetesJsonValue,
  KubernetesManifest,
  KubernetesObjectRef,
  KubernetesServiceRef,
  NetworkCidrSource,
  RegistryAuthentication,
  RegistryDigestLookup,
  RoutingPlan,
  RoutingReadiness,
  TelemetryActivation,
  TelemetryOwner,
  TelemetryProducerKind,
  TelemetryPropagation,
  TelemetryProtocol,
  TelemetrySignal,
  TelemetrySource,
  TelemetryWorkload,
} from "./composition-plan/index.js";
export type {
  CertManagerTlsOptions,
  ClusterBuildResult,
  ClusterComponent,
  DefineTargetOptions,
  ExposureBuildContext,
  ExposureBuildResult,
  ExposureCapability,
  ExposureComponent,
  ExposureRequirement,
  GatewayApiExposureOptions,
  GkeClusterOptions,
  HttpRouteExposureOptions,
  IngressExposureOptions,
  IngressSourceSet,
  KubernetesClusterOptions,
  KubernetesContribution,
  KubernetesTargetDefinition,
  ManagedCacheRequest,
  ResourceBuildResult,
  ResourceComponent,
  RoutingBuildResult,
  RoutingBuildContext,
  RoutingCallerAuthentication,
  RoutingComponent,
  RoutingOrigin,
  RoutingTier,
  TargetBuildContext,
} from "./target/index.js";
