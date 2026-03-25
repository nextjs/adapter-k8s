// src/index.ts
import { createK8sAdapter } from "./adapter.js";
export { createK8sAdapter };

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
