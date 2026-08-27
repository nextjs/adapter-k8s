/**
 * Unstable implementation surface for adapter tooling. No compatibility guarantee applies to
 * this subpath, including during 0.x releases. Application configuration should import from the
 * package root instead.
 */
export { compileTarget } from "./target/compiler.js";
export {
  canonicalCompositionPlanJson,
  fingerprintCompositionPlan,
  parseAndVerifyCompositionPlan,
} from "./composition-plan/fingerprint.js";
export { assertKubernetesServerVersion } from "./composition-plan/parse.js";
export type { CompiledKubernetesTarget } from "./target/types.js";
export type {
  CleanupPlan,
  ExternalCleanupOperation,
  GcpLocation,
  NetworkPlan,
  RegistryPlan,
  RetainedExternalResource,
} from "./composition-plan/types.js";
