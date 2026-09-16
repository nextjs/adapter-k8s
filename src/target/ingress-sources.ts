import {
  assertSafeAnnotationName,
  assertSafeCidr,
  assertSafeKubernetesObjectName,
  assertSafeNamespace,
} from "../emit/templates/utils.js";
import type { IngressSourceSet } from "./types.js";

/** Google frontend proxy ranges for global external Application Load Balancers. */
export const GKE_GFE_PROXY_CIDRS = [
  "35.191.0.0/16",
  "130.211.0.0/22",
  "2600:2d00:1:1::/64",
] as const;

/** Google health-check prober ranges for GFE-based load balancers. */
export const GKE_HEALTH_CHECK_PROBE_CIDRS = ["35.191.0.0/16", "2600:2d00:1:b029::/64"] as const;

function assertSafeLabelValue(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    (value.length > 0 && !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value))
  ) {
    throw new Error(
      `Invalid ${field} ${JSON.stringify(value)}: expected a Kubernetes label value.`,
    );
  }
}

/** Copy and validate a source set before it crosses into target composition. */
export function normalizeIngressSources(sources: IngressSourceSet): IngressSourceSet {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) {
    throw new Error("ingressSources must be an object with cidrs and podSelectors arrays");
  }
  if (!Array.isArray(sources.cidrs) || !Array.isArray(sources.podSelectors)) {
    throw new Error("ingressSources must contain cidrs and podSelectors arrays");
  }
  const cidrs = sources.cidrs.map((cidr) => {
    assertSafeCidr(cidr, "ingressSources CIDR");
    return cidr;
  });
  const podSelectors = sources.podSelectors.map((selector, index) => {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      throw new Error(`ingressSources.podSelectors[${index}] must be an object`);
    }
    if (selector.namespace !== undefined) assertSafeNamespace(selector.namespace);
    if (
      !selector.labels ||
      typeof selector.labels !== "object" ||
      Array.isArray(selector.labels) ||
      Object.keys(selector.labels).length === 0
    ) {
      throw new Error(
        `ingressSources.podSelectors[${index}].labels must contain at least one label`,
      );
    }
    const labels = Object.fromEntries(
      Object.entries(selector.labels).map(([key, value]) => {
        assertSafeAnnotationName(key);
        assertSafeLabelValue(value, `ingressSources label ${JSON.stringify(key)}`);
        return [key, value];
      }),
    );
    return {
      ...(selector.namespace ? { namespace: selector.namespace } : {}),
      labels,
    };
  });
  return { cidrs, podSelectors };
}

/** Explicit strict-NetworkPolicy sources for the GKE global external Gateway preset. */
export function gkeIngressSources(): IngressSourceSet {
  return normalizeIngressSources({
    cidrs: [
      ...GKE_GFE_PROXY_CIDRS,
      ...GKE_HEALTH_CHECK_PROBE_CIDRS.filter(
        (cidr) => !(GKE_GFE_PROXY_CIDRS as readonly string[]).includes(cidr),
      ),
    ],
    podSelectors: [],
  });
}

export interface EnvoyGatewayIngressSourcesOptions {
  /** Namespace containing Envoy Gateway data-plane proxy pods, not the controller. */
  namespace: string;
  /** Exact, non-merged Gateway proxy owners. */
  gateways?: ReadonlyArray<{ name: string; namespace: string }>;
  /** Merged/class-owned proxy deployments. */
  gatewayClasses?: readonly string[];
}

/**
 * Strict-NetworkPolicy selectors for Envoy Gateway data-plane pods. The helper targets
 * the proxy labels Envoy Gateway owns, never its controller Deployment.
 */
export function envoyGatewayIngressSources(
  options: EnvoyGatewayIngressSourcesOptions,
): IngressSourceSet {
  assertSafeNamespace(options.namespace);
  const gateways = [...(options.gateways ?? [])];
  const gatewayClasses = [...(options.gatewayClasses ?? [])];
  if (gateways.length === 0 && gatewayClasses.length === 0) {
    throw new Error(
      "envoyGatewayIngressSources requires at least one gateway or gatewayClass selector",
    );
  }
  return normalizeIngressSources({
    cidrs: [],
    podSelectors: [
      ...gateways.map((gateway) => {
        assertSafeKubernetesObjectName(gateway.name, "Envoy Gateway name");
        assertSafeNamespace(gateway.namespace);
        return {
          namespace: options.namespace,
          labels: {
            "app.kubernetes.io/name": "envoy",
            "gateway.envoyproxy.io/owning-gateway-name": gateway.name,
            "gateway.envoyproxy.io/owning-gateway-namespace": gateway.namespace,
          },
        };
      }),
      ...gatewayClasses.map((className) => {
        assertSafeKubernetesObjectName(className, "Envoy GatewayClass name");
        return {
          namespace: options.namespace,
          labels: {
            "app.kubernetes.io/name": "envoy",
            "gateway.envoyproxy.io/owning-gatewayclass": className,
          },
        };
      }),
    ],
  });
}
