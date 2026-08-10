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
} from "./components.js";
export type {
  GatewayApiExposureOptions,
  HttpRouteExposureOptions,
  IngressExposureOptions,
} from "./components.js";
export { compileTarget } from "./compiler.js";
export { targetForConfig, targetHosts } from "./legacy.js";
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
  GkeClusterOptions,
  IngressSourceSet,
  KubernetesClusterOptions,
  KubernetesContribution,
  KubernetesTargetDefinition,
  ResourceComponent,
  RoutingBuildResult,
  RoutingBuildContext,
  RoutingComponent,
  TargetBuildContext,
} from "./types.js";
