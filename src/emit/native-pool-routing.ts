import type { KubernetesJsonValue, KubernetesManifest } from "../composition-plan/types.js";

/** Build-time marker; the rendered HTTPRoute records origin/owning instead. */
export const NATIVE_POOL_ROUTING_ANNOTATION = "adapter-k8s.dev/native-pool-routing";
export const NATIVE_POOL_ROUTING_CANDIDATE = "candidate";

function record(value: KubernetesJsonValue | undefined): Record<string, KubernetesJsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function isNativePoolRoutingRoute(manifest: KubernetesManifest): boolean {
  return (
    manifest.apiVersion === "gateway.networking.k8s.io/v1" &&
    manifest.kind === "HTTPRoute" &&
    manifest.metadata.annotations?.[NATIVE_POOL_ROUTING_ANNOTATION] ===
      NATIVE_POOL_ROUTING_CANDIDATE
  );
}

export function nativePoolRoutingRules(manifest: KubernetesManifest): KubernetesJsonValue[] {
  const rules = record(manifest.body?.spec).rules;
  return Array.isArray(rules) ? rules : [];
}

export function isNativePoolRule(rule: KubernetesJsonValue): boolean {
  const matches = record(rule).matches;
  return (
    Array.isArray(matches) &&
    matches.some((match) => {
      const headers = record(match).headers;
      return (
        Array.isArray(headers) &&
        headers.some((header) => record(header).name === "x-upstream-pool")
      );
    })
  );
}

export function nativePoolRoutingVariant(
  manifest: KubernetesManifest,
  direct: boolean,
): KubernetesManifest {
  const rules = nativePoolRoutingRules(manifest);
  const originRules = rules.filter((rule) => !isNativePoolRule(rule));
  if (originRules.length !== 1) {
    throw new Error(`Native HTTPRoute ${manifest.metadata.name} must have one origin fallback`);
  }
  return {
    ...manifest,
    metadata: {
      ...manifest.metadata,
      annotations: {
        ...manifest.metadata.annotations,
        [NATIVE_POOL_ROUTING_ANNOTATION]: direct ? "owning" : "origin",
      },
    },
    body: {
      ...manifest.body,
      spec: { ...record(manifest.body?.spec), rules: direct ? rules : originRules },
    },
  };
}
