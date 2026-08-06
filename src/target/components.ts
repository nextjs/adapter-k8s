import { createHash } from "node:crypto";
import type { HostConfig } from "../types.js";
import type {
  KubernetesJsonValue,
  KubernetesManifest,
  KubernetesServiceRef,
  RoutingReadiness,
} from "../composition-plan/types.js";
import {
  assertSafeHostname,
  assertSafeNamespace,
  assertSafeProjectId,
  assertSafeRegion,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "../emit/templates/utils.js";
import type {
  ClusterComponent,
  DefineTargetOptions,
  ExposureBuildContext,
  ExposureBuildResult,
  ExposureComponent,
  GkeClusterOptions,
  IngressSourceSet,
  KubernetesClusterOptions,
  KubernetesContribution,
  KubernetesTargetDefinition,
  ResourceComponent,
  RoutingBuildResult,
  RoutingComponent,
  TargetBuildContext,
} from "./types.js";

const DEFAULT_NETWORK = {
  podCidrs: { kind: "kubernetes-node-pod-cidrs" as const },
  nodeCidrs: {
    kind: "kubernetes-node-addresses" as const,
    addressTypes: ["InternalIP"] as ["InternalIP"],
  },
  missingSourcePolicy: "fail" as const,
};

function safeComponentName(name: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`Invalid target component name ${JSON.stringify(name)}`);
  }
  return name;
}

function copyHosts(hosts: readonly HostConfig[]): HostConfig[] {
  if (hosts.length === 0) throw new Error("An exposure must declare at least one host");
  return hosts.map((host) => {
    assertSafeHostname(host.hostname);
    return { hostname: host.hostname, tls: { ...host.tls } };
  });
}

function copyIngressSources(sources?: IngressSourceSet): IngressSourceSet {
  return {
    cidrs: [...(sources?.cidrs ?? [])],
    podSelectors: (sources?.podSelectors ?? []).map((selector) => ({
      ...(selector.namespace ? { namespace: selector.namespace } : {}),
      labels: { ...selector.labels },
    })),
  };
}

function backend(context: TargetBuildContext): KubernetesServiceRef {
  return {
    name: sanitizeK8sName(`${context.releaseName}-origin`),
    namespace: context.namespace,
    port: 3000,
  };
}

function object(
  apiVersion: string,
  kind: string,
  resource: string,
  name: string,
  namespace: string,
  body: Record<string, KubernetesJsonValue>,
  metadata?: {
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  },
): KubernetesManifest {
  return {
    apiVersion,
    kind,
    resource,
    metadata: {
      name,
      namespace,
      ...(metadata?.labels ? { labels: metadata.labels } : {}),
      ...(metadata?.annotations ? { annotations: metadata.annotations } : {}),
    },
    body,
  };
}

export function kubernetesCluster(options: KubernetesClusterOptions = {}): ClusterComponent {
  return {
    componentType: "cluster",
    name: "kubernetes",
    build(context) {
      return {
        identity: options.identity ?? {
          kind: "unverified",
          requireExplicitConfirmation: true,
        },
        access: options.access ?? {
          kind: "kubeconfig-current-context",
          requireExplicitConfirmation: true,
        },
        registry: {
          repository: context.imageRegistry,
          authentication: options.registry?.authentication ?? { kind: "ambient-credentials" },
          digestLookup: options.registry?.digestLookup ?? { kind: "oci-distribution" },
        },
        network: options.network ?? DEFAULT_NETWORK,
        managedCache: "none",
      };
    },
  };
}

export function gkeCluster(options: GkeClusterOptions = {}): ClusterComponent {
  return {
    componentType: "cluster",
    name: "gke",
    build(context) {
      const projectId = options.projectId ?? context.infrastructure?.projectId;
      const region = options.region ?? context.infrastructure?.region;
      if (!projectId || !region) {
        throw new Error("gkeCluster requires projectId and region from options or infrastructure");
      }
      assertSafeProjectId(projectId);
      assertSafeRegion(region);
      const clusterName = options.clusterName ?? `${context.releaseName}-cluster`;
      const registryHost = context.imageRegistry.split("/")[0]!;
      const usesArtifactRegistry = registryHost.endsWith(".pkg.dev");
      return {
        identity: {
          kind: "gke-resource",
          projectId,
          clusterName,
          location: { kind: "region", name: region },
        },
        access: {
          kind: "gke-get-credentials",
          projectId,
          clusterName,
          location: { kind: "region", name: region },
        },
        registry: {
          repository: context.imageRegistry,
          authentication:
            options.registry?.authentication ??
            (usesArtifactRegistry
              ? { kind: "gcloud-docker-helper", registryHost }
              : { kind: "ambient-credentials" }),
          digestLookup:
            options.registry?.digestLookup ??
            (usesArtifactRegistry
              ? { kind: "gcp-artifact-registry", projectId }
              : { kind: "oci-distribution" }),
        },
        network: {
          podCidrs: {
            kind: "gke-pod-range",
            projectId,
            clusterName,
            location: { kind: "region", name: region },
          },
          nodeCidrs: {
            kind: "gke-node-subnet",
            projectId,
            clusterName,
            location: { kind: "region", name: region },
          },
          missingSourcePolicy: "fail",
        },
        managedCache: "gcp-memorystore",
      };
    },
  };
}

export function defineExposureComponent(options: {
  name: string;
  hosts: readonly HostConfig[];
  build(context: ExposureBuildContext): ExposureBuildResult;
}): ExposureComponent {
  const name = safeComponentName(options.name);
  const hosts = copyHosts(options.hosts);
  return {
    componentType: "exposure",
    name,
    hosts,
    build: options.build,
  };
}

export function defineResourceComponent(options: {
  name: string;
  build(context: TargetBuildContext): KubernetesContribution;
}): ResourceComponent {
  return {
    componentType: "resource",
    name: safeComponentName(options.name),
    build: options.build,
  };
}

export function manualExposure(options: {
  hosts: readonly HostConfig[];
  ingressSources?: IngressSourceSet;
}): ExposureComponent {
  return defineExposureComponent({
    name: "manual",
    hosts: options.hosts,
    build() {
      return {
        objects: [],
        requirements: [],
        readiness: [],
        ingressSources: copyIngressSources(options.ingressSources),
        capabilities: [{ kind: "manual" }],
      };
    },
  });
}

export interface GatewayApiExposureOptions {
  className: string;
  hosts: readonly HostConfig[];
  tlsSecretName?: string;
  controllerManagedTls?: boolean;
  controllerManagedCertificate?: { annotation: string; nameSuffix: string };
  annotations?: Record<string, string>;
  addresses?: Array<{ type: string; value: string }>;
  releaseAddresses?: Array<{ type: string; nameSuffix: string }>;
  ingressSources?: IngressSourceSet;
}

export function gatewayApiExposure(options: GatewayApiExposureOptions): ExposureComponent {
  const hosts = copyHosts(options.hosts);
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(options.className)) {
    throw new Error(`Invalid GatewayClass name ${JSON.stringify(options.className)}`);
  }
  const wantsTls = hosts.some((host) => host.tls.enabled);
  if (wantsTls && hosts.some((host) => !host.tls.enabled)) {
    throw new Error(
      "gatewayApiExposure cannot mix TLS and plaintext hosts in one exposure; compose separate releases or use matching TLS settings",
    );
  }
  if (wantsTls && !options.tlsSecretName && !options.controllerManagedTls) {
    throw new Error(
      "gatewayApiExposure requires tlsSecretName or controllerManagedTls when TLS is enabled",
    );
  }
  return defineExposureComponent({
    name: "gateway-api",
    hosts,
    build(context) {
      const gatewayName = sanitizeK8sName(`${context.releaseName}-gateway`);
      const routeName = sanitizeK8sName(`${context.releaseName}-routes`);
      const annotations = {
        ...options.annotations,
        ...(wantsTls && options.controllerManagedCertificate
          ? {
              [options.controllerManagedCertificate.annotation]:
                `${context.releaseName}${options.controllerManagedCertificate.nameSuffix}`,
            }
          : {}),
      };
      const addresses = [
        ...(options.addresses ?? []),
        ...(options.releaseAddresses ?? []).map((address) => ({
          type: address.type,
          value: `${context.releaseName}${address.nameSuffix}`,
        })),
      ];
      const labels = { "app.kubernetes.io/name": context.releaseName };
      const listenerHostname = hosts.length === 1 ? { hostname: hosts[0]!.hostname } : {};
      const listeners: KubernetesJsonValue[] = [
        {
          name: "http",
          protocol: "HTTP",
          port: 80,
          ...listenerHostname,
          allowedRoutes: { namespaces: { from: "Same" } },
        },
      ];
      if (wantsTls) {
        listeners.push({
          name: "https",
          protocol: "HTTPS",
          port: 443,
          ...listenerHostname,
          ...(!options.controllerManagedTls
            ? {
                tls: {
                  mode: "Terminate",
                  certificateRefs: [{ kind: "Secret", name: options.tlsSecretName! }],
                },
              }
            : {}),
          allowedRoutes: { namespaces: { from: "Same" } },
        });
      }
      const gateway = object(
        "gateway.networking.k8s.io/v1",
        "Gateway",
        "gateways",
        gatewayName,
        context.namespace,
        {
          spec: {
            gatewayClassName: options.className,
            ...(addresses.length > 0 ? { addresses } : {}),
            listeners,
          },
        },
        { labels, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) },
      );
      const route = object(
        "gateway.networking.k8s.io/v1",
        "HTTPRoute",
        "httproutes",
        routeName,
        context.namespace,
        {
          spec: {
            parentRefs: [
              {
                name: gatewayName,
                ...(wantsTls ? { sectionName: "https" } : {}),
              },
            ],
            hostnames: hosts.map((host) => host.hostname),
            rules: [
              {
                matches: [{ path: { type: "PathPrefix", value: "/" } }],
                backendRefs: [{ name: context.backend.name, port: context.backend.port }],
              },
            ],
          },
        },
        { labels },
      );
      const redirectRoute = wantsTls
        ? object(
            "gateway.networking.k8s.io/v1",
            "HTTPRoute",
            "httproutes",
            sanitizeK8sName(`${context.releaseName}-http-redirect`),
            context.namespace,
            {
              spec: {
                parentRefs: [{ name: gatewayName, sectionName: "http" }],
                hostnames: hosts.map((host) => host.hostname),
                rules: [
                  {
                    filters: [
                      {
                        type: "RequestRedirect",
                        requestRedirect: { scheme: "https", statusCode: 301 },
                      },
                    ],
                  },
                ],
              },
            },
            { labels },
          )
        : undefined;
      const gatewayReady: RoutingReadiness = {
        kind: "kubernetes-condition",
        object: {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "gateways",
          name: gatewayName,
          namespace: context.namespace,
        },
        conditionsAt: { kind: "object" },
        condition: {
          type: "Programmed",
          status: "True",
          observedGeneration: "must-equal-metadata-generation",
        },
        timeoutSeconds: 600,
      };
      const routeReady: RoutingReadiness = {
        kind: "kubernetes-condition",
        object: {
          apiVersion: "gateway.networking.k8s.io/v1",
          resource: "httproutes",
          name: routeName,
          namespace: context.namespace,
        },
        conditionsAt: { kind: "parents" },
        condition: {
          type: "Accepted",
          status: "True",
          observedGeneration: "must-equal-metadata-generation",
        },
        timeoutSeconds: 600,
      };
      const redirectReady: RoutingReadiness | undefined = redirectRoute
        ? {
            kind: "kubernetes-condition",
            object: {
              apiVersion: "gateway.networking.k8s.io/v1",
              resource: "httproutes",
              name: redirectRoute.metadata.name,
              namespace: context.namespace,
            },
            conditionsAt: { kind: "parents" },
            condition: {
              type: "Accepted",
              status: "True",
              observedGeneration: "must-equal-metadata-generation",
            },
            timeoutSeconds: 600,
          }
        : undefined;
      return {
        objects: [gateway, route, ...(redirectRoute ? [redirectRoute] : [])],
        requirements: [
          { apiVersion: "gateway.networking.k8s.io/v1", resource: "gateways", optional: false },
          {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "httproutes",
            optional: false,
          },
        ],
        readiness: [gatewayReady, routeReady, ...(redirectReady ? [redirectReady] : [])],
        ingressSources: copyIngressSources(options.ingressSources),
        capabilities: [{ kind: "gateway-api", className: options.className }],
      };
    },
  });
}

export interface IngressExposureOptions {
  className: string;
  hosts: readonly HostConfig[];
  tlsSecretName?: string;
  annotations?: Record<string, string>;
  ingressSources?: IngressSourceSet;
}

export function ingressExposure(options: IngressExposureOptions): ExposureComponent {
  const hosts = copyHosts(options.hosts);
  if (hosts.some((host) => host.tls.enabled) && !options.tlsSecretName) {
    throw new Error("ingressExposure requires tlsSecretName when TLS is enabled");
  }
  return defineExposureComponent({
    name: "ingress",
    hosts,
    build(context) {
      return {
        objects: [
          object(
            "networking.k8s.io/v1",
            "Ingress",
            "ingresses",
            sanitizeK8sName(`${context.releaseName}-ingress`),
            context.namespace,
            {
              spec: {
                ingressClassName: options.className,
                ...(options.tlsSecretName
                  ? {
                      tls: [
                        {
                          hosts: hosts
                            .filter((host) => host.tls.enabled)
                            .map((host) => host.hostname),
                          secretName: options.tlsSecretName,
                        },
                      ],
                    }
                  : {}),
                rules: hosts.map((host) => ({
                  host: host.hostname,
                  http: {
                    paths: [
                      {
                        path: "/",
                        pathType: "Prefix",
                        backend: {
                          service: {
                            name: context.backend.name,
                            port: { number: context.backend.port },
                          },
                        },
                      },
                    ],
                  },
                })),
              },
            },
            {
              labels: { "app.kubernetes.io/name": context.releaseName },
              ...(options.annotations ? { annotations: options.annotations } : {}),
            },
          ),
        ],
        requirements: [
          { apiVersion: "networking.k8s.io/v1", resource: "ingresses", optional: false },
        ],
        readiness: [],
        ingressSources: copyIngressSources(options.ingressSources),
        capabilities: [{ kind: "ingress", className: options.className }],
      };
    },
  });
}

export function portableRouting(): RoutingComponent {
  return {
    componentType: "routing",
    name: "portable",
    build(context): RoutingBuildResult {
      const service = backend(context);
      const readiness: RoutingReadiness[] = [
        { kind: "kubernetes-service-endpoints", service, minimumReady: 1 },
      ];
      return {
        plan: {
          protocol: "pool-local-v1",
          failurePolicy: "closed",
          dataplane: { kind: "portable-http-origin", service, readiness },
        },
        backend: service,
        readiness,
        routingTier: {
          enabled: false,
          serviceAnnotations: {},
          registration: "none",
        },
      };
    },
  };
}

export function envoyNativeRouting(
  options: {
    gatewayClassName?: string;
    messageTimeoutMs?: number;
  } = {},
): RoutingComponent {
  return {
    componentType: "routing",
    name: "envoy-native",
    build(context): RoutingBuildResult {
      const policyName = sanitizeK8sName(`${context.releaseName}-routing-extproc`);
      const routeName = sanitizeK8sName(`${context.releaseName}-routes`);
      const readiness: RoutingReadiness[] = [
        {
          kind: "kubernetes-condition",
          object: {
            apiVersion: "gateway.envoyproxy.io/v1alpha1",
            resource: "envoyextensionpolicies",
            name: policyName,
            namespace: context.namespace,
          },
          conditionsAt: {
            kind: "ancestors",
            controllerName: "gateway.envoyproxy.io/gatewayclass-controller",
          },
          condition: {
            type: "Accepted",
            status: "True",
            observedGeneration: "must-equal-metadata-generation",
          },
          timeoutSeconds: 600,
        },
      ];
      const timeoutSeconds = Math.max(1, Math.round((options.messageTimeoutMs ?? 4000) / 1000));
      const policy = object(
        "gateway.envoyproxy.io/v1alpha1",
        "EnvoyExtensionPolicy",
        "envoyextensionpolicies",
        policyName,
        context.namespace,
        {
          spec: {
            targetRefs: [
              {
                group: "gateway.networking.k8s.io",
                kind: "HTTPRoute",
                name: routeName,
              },
            ],
            extProc: [
              {
                backendRefs: [{ name: `${context.releaseName}-routing-service`, port: 8443 }],
                processingMode: { request: {} },
                failOpen: context.failurePolicy === "open",
                messageTimeout: `${timeoutSeconds}s`,
              },
            ],
          },
        },
        {
          labels: {
            "app.kubernetes.io/name": context.releaseName,
            "app.kubernetes.io/component": "routing-service",
          },
        },
      );
      return {
        plan: {
          protocol: "envoy-ext-proc-v3",
          failurePolicy: context.failurePolicy,
          dataplane: { kind: "external-ext-proc", transport: "h2c", readiness },
        },
        backend: backend(context),
        objects: [policy],
        requirements: [
          {
            apiVersion: "gateway.envoyproxy.io/v1alpha1",
            resource: "envoyextensionpolicies",
            optional: false,
          },
        ],
        readiness,
        requiresExposure: { kind: "gateway-api", className: options.gatewayClassName ?? "eg" },
        routingTier: {
          enabled: true,
          transport: "h2c",
          serviceAnnotations: {},
          registration: "none",
        },
      };
    },
  };
}

export function gkeNativeRouting(
  options: {
    projectId?: string;
    addressName?: string;
    extensionName?: string;
    gatewayClassName?: string;
  } = {},
): RoutingComponent {
  return {
    componentType: "routing",
    name: "gke-native",
    build(context): RoutingBuildResult {
      const projectId = options.projectId ?? context.infrastructure?.projectId;
      if (!projectId) throw new Error("gkeNativeRouting requires a projectId");
      assertSafeProjectId(projectId);
      const readiness: RoutingReadiness[] = [
        {
          kind: "gcp-traffic-extension",
          projectId,
          extensionName: options.extensionName ?? `${context.releaseName}-traffic-ext`,
          addressName: options.addressName ?? `${context.releaseName}-ip`,
          requireEveryForwardingRule: true,
        },
      ];
      return {
        plan: {
          protocol: "envoy-ext-proc-v3",
          failurePolicy: context.failurePolicy,
          dataplane: { kind: "external-ext-proc", transport: "tls", readiness },
        },
        backend: backend(context),
        readiness,
        requirements: [
          {
            apiVersion: "networking.gke.io/v1",
            resource: "healthcheckpolicies",
            optional: false,
          },
        ],
        requiresExposure: {
          kind: "gateway-api",
          className: options.gatewayClassName ?? "gke-l7-global-external-managed",
        },
        routingTier: {
          enabled: true,
          transport: "tls",
          serviceAnnotations: {
            "cloud.google.com/neg": `{"exposed_ports":{"8443":{"name":"${context.releaseName}-routing-neg"}}}`,
          },
          registration: "gke-traffic-extension",
        },
      };
    },
  };
}

export function defineTarget(options: DefineTargetOptions): KubernetesTargetDefinition {
  const keys = Object.keys(options as unknown as Record<string, unknown>);
  const unknown = keys.filter(
    (key) => !["cluster", "exposure", "routing", "resources"].includes(key),
  );
  if (unknown.length > 0) throw new Error(`Unknown defineTarget field: ${unknown.join(", ")}`);
  if (options.cluster?.componentType !== "cluster") {
    throw new Error("defineTarget.cluster must be a cluster component");
  }
  if (options.exposure?.componentType !== "exposure") {
    throw new Error("defineTarget.exposure must be an exposure component");
  }
  const routing = options.routing ?? portableRouting();
  if (routing.componentType !== "routing") {
    throw new Error("defineTarget.routing must be a routing component");
  }
  const resources = [...(options.resources ?? [])];
  for (const resource of resources) {
    if (resource.componentType !== "resource") {
      throw new Error("defineTarget.resources must contain resource components");
    }
  }
  return {
    componentType: "target",
    cluster: options.cluster,
    exposure: options.exposure,
    routing,
    resources,
  };
}

export function targetFingerprint(value: unknown): `sha256:${string}` {
  const canonical = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map(canonical).join(",")}]`;
    const record = entry as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function validateTargetContext(context: TargetBuildContext): void {
  assertSafeReleaseName(context.releaseName);
  assertSafeNamespace(context.namespace);
  if (context.pools.length === 0 || !context.pools.includes(context.defaultPool)) {
    throw new Error("Target compilation requires a default pool present in pools");
  }
}
