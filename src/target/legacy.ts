import type { HostConfig, K8sAdapterConfig } from "../types.js";
import { STRICT_INGRESS_CIDRS } from "../emit/templates/network-policy.js";
import {
  defineTarget,
  envoyNativeRouting,
  gatewayApiExposure,
  gkeCluster,
  gkeNativeRouting,
  kubernetesCluster,
} from "./components.js";
import type { KubernetesTargetDefinition } from "./types.js";

export function targetForConfig(config: K8sAdapterConfig): KubernetesTargetDefinition {
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
    return target;
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
    return defineTarget({
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
      exposure: gatewayApiExposure({
        className,
        hosts,
        ...(generic?.gateway?.tlsSecretName
          ? { tlsSecretName: generic.gateway.tlsSecretName }
          : {}),
        ingressSources: {
          cidrs: [],
          podSelectors: [
            {
              namespace: generic?.gatewayNamespace ?? "envoy-gateway-system",
              labels: {
                "app.kubernetes.io/name": "envoy",
                "gateway.envoyproxy.io/owning-gatewayclass": className,
              },
            },
          ],
        },
      }),
      routing: envoyNativeRouting({
        gatewayClassName: className,
      }),
    });
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
    return defineTarget({
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
        ingressSources: { cidrs: [...STRICT_INGRESS_CIDRS], podSelectors: [] },
      }),
      routing: gkeNativeRouting({
        gatewayClassName: gke?.gateway?.className ?? "gke-l7-global-external-managed",
      }),
    });
  }
  throw new Error(`Unknown legacy provider ${JSON.stringify(name)}`);
}

export function targetHosts(config: K8sAdapterConfig): HostConfig[] {
  return targetForConfig(config).exposure.hosts.map((host) => ({
    hostname: host.hostname,
    tls: { ...host.tls },
  }));
}
