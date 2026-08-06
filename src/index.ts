// src/index.ts
import { createK8sAdapter } from "./adapter.js";
export { createK8sAdapter };
export {
  compileTarget,
  defineExposureComponent,
  defineResourceComponent,
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeNativeRouting,
  ingressExposure,
  kubernetesCluster,
  manualExposure,
  portableRouting,
  targetForConfig,
} from "./target/index.js";
export {
  COMPOSITION_PLAN_API_VERSION,
  COMPOSITION_PLAN_KIND,
  MINIMUM_KUBERNETES_VERSION,
  assertKubernetesMinimumVersion,
  assertKubernetesServerVersion,
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  parseAndFingerprintCompositionPlan,
  parseAndVerifyCompositionPlan,
  parseCompositionPlan,
} from "./composition-plan/index.js";

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
  CdnInvalidation,
  CleanupPlan,
  ClusterAccess,
  ClusterIdentity,
  CompositionPlan,
  CompositionPlanDigest,
  CompositionPlanV1,
  DiagnosticSource,
  ExternalCleanupOperation,
  GcpLocation,
  KubernetesApiRequirement,
  KubernetesJsonValue,
  KubernetesManifest,
  KubernetesObjectRef,
  KubernetesOwnedObject,
  KubernetesResourcePlan,
  KubernetesServiceRef,
  LogSource,
  NetworkCidrSource,
  NetworkPlan,
  RegistryAuthentication,
  RegistryDigestLookup,
  RegistryPlan,
  RetainedExternalResource,
  RoutingPlan,
  RoutingReadiness,
} from "./composition-plan/index.js";
export type {
  ClusterBuildResult,
  ClusterComponent,
  CompiledKubernetesTarget,
  DefineTargetOptions,
  ExposureBuildContext,
  ExposureBuildResult,
  ExposureCapability,
  ExposureComponent,
  ExposureRequirement,
  GatewayApiExposureOptions,
  GkeClusterOptions,
  IngressExposureOptions,
  IngressSourceSet,
  KubernetesClusterOptions,
  KubernetesContribution,
  KubernetesTargetDefinition,
  ResourceComponent,
  RoutingBuildResult,
  RoutingComponent,
  TargetBuildContext,
} from "./target/index.js";
