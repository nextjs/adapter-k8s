import type { HostConfig, K8sAdapterConfig } from "../types.js";
import {
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeHealthCheckPolicy,
  gkeNativeRouting,
  kubernetesCluster,
} from "./components.js";
import { envoyGatewayIngressSources, gkeIngressSources } from "./ingress-sources.js";
import type { ExposureComponent, KubernetesTargetDefinition } from "./types.js";
import { sanitizeK8sName } from "../emit/templates/utils.js";

function legacyEnvoyExposure(options: {
  className: string;
  hosts: readonly HostConfig[];
  tlsSecretName?: string;
  proxyNamespace: string;
}): ExposureComponent {
  // gatewayApiExposure validates the public options immediately. Its build result is then
  // narrowed with the context-known Gateway identity, matching the legacy chart provider's
  // ordinary per-Gateway peer plus its merged-GatewayClass fallback.
  const exposure = gatewayApiExposure({
    className: options.className,
    hosts: options.hosts,
    ...(options.tlsSecretName ? { tlsSecretName: options.tlsSecretName } : {}),
    ingressSources: envoyGatewayIngressSources({
      namespace: options.proxyNamespace,
      gatewayClasses: [options.className],
    }),
  });
  return {
    ...exposure,
    build(context) {
      return {
        ...exposure.build(context),
        ingressSources: envoyGatewayIngressSources({
          namespace: options.proxyNamespace,
          gateways: [
            {
              name: sanitizeK8sName(`${context.releaseName}-gateway`),
              namespace: context.namespace,
            },
          ],
          gatewayClasses: [options.className],
        }),
      };
    },
  };
}

/**
 * The only seam where the deprecated provider shape enters target composition. Downstream
 * callers keep the source tag until the legacy chart path is retired, so they cannot mistake a
 * translated definition for one whose full lifecycle is represented by a composition plan.
 */
export type ResolvedConfiguredTarget =
  | { source: "target"; definition: KubernetesTargetDefinition }
  | {
      source: "legacy-provider";
      providerName: "gke" | "generic";
      definition: KubernetesTargetDefinition;
    };

export function resolveConfiguredTarget(config: K8sAdapterConfig): ResolvedConfiguredTarget {
  const target = config.target;
  const provider = config.provider;
  if (target && provider) {
    throw new Error(
      "Configure target or legacy provider, not both. The two definitions can select different clusters and routing paths.",
    );
  }
  if (target) {
    if (target.componentType !== "target") {
      throw new Error("target must be created with defineTarget()");
    }
    return { source: "target", definition: target };
  }
  const configured = Object.entries(provider ?? {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key);
  if (configured.length !== 1) {
    throw new Error(
      configured.length === 0
        ? "target is required (legacy configs may provide exactly one provider block)"
        : `Legacy provider config must contain exactly one block; found ${configured.join(", ")}`,
    );
  }
  const name = configured[0]!;
  if (name === "generic") {
    const generic = (
      provider as NonNullable<K8sAdapterConfig["provider"]> & {
        generic?: {
          gateway?: { className?: string; hosts?: HostConfig[]; tlsSecretName?: string };
          gatewayNamespace?: string;
          nodeCidrs?: string[];
        };
      }
    ).generic;
    const hosts = generic?.gateway?.hosts ?? [];
    const className = generic?.gateway?.className ?? "eg";
    return {
      source: "legacy-provider",
      providerName: "generic",
      definition: defineTarget({
        cluster: kubernetesCluster(
          generic?.nodeCidrs
            ? {
                network: {
                  podCidrs: { kind: "kubernetes-node-pod-cidrs" },
                  nodeCidrs: { kind: "static", cidrs: generic.nodeCidrs },
                  missingSourcePolicy: "fail",
                },
              }
            : {},
        ),
        exposure: legacyEnvoyExposure({
          className,
          hosts,
          ...(generic?.gateway?.tlsSecretName
            ? { tlsSecretName: generic.gateway.tlsSecretName }
            : {}),
          proxyNamespace: generic?.gatewayNamespace ?? "envoy-gateway-system",
        }),
        routing: envoyNativeRouting({
          gatewayClassName: className,
        }),
      }),
    };
  }
  if (name === "gke") {
    const gke = (
      provider as NonNullable<K8sAdapterConfig["provider"]> & {
        gke?: {
          gateway?: { type?: string; className?: string; hosts?: HostConfig[] };
        };
      }
    ).gke;
    if (gke?.gateway?.type === "ingress") {
      throw new Error(
        "Legacy GKE traffic extensions require Gateway API; provider.gke.gateway.type=ingress cannot preserve the routing contract",
      );
    }
    return {
      source: "legacy-provider",
      providerName: "gke",
      definition: defineTarget({
        cluster: gkeCluster(),
        exposure: gatewayApiExposure({
          className: gke?.gateway?.className ?? "gke-l7-global-external-managed",
          hosts: gke?.gateway?.hosts ?? [],
          controllerManagedTls: true,
          controllerManagedCertificate: {
            annotation: "networking.gke.io/certmap",
            nameSuffix: "-certmap",
          },
          releaseAddresses: [{ type: "NamedAddress", nameSuffix: "-ip" }],
          ingressSources: gkeIngressSources(),
          backendHealth: gkeHealthCheckPolicy(),
        }),
        routing: gkeNativeRouting({
          gatewayClassName: gke?.gateway?.className ?? "gke-l7-global-external-managed",
        }),
      }),
    };
  }
  throw new Error(`Unknown legacy provider ${JSON.stringify(name)}`);
}
