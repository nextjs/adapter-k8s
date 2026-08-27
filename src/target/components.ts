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
  ClusterBuildResult,
  ClusterComponent,
  DefineTargetOptions,
  ExposureBuildContext,
  ExposureBuildResult,
  ExposureCapability,
  ExposureComponent,
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

function gatewayCapability(
  context: RoutingBuildContext,
  routingName: string,
  className: string,
): Extract<ExposureCapability, { kind: "gateway-api" }> {
  const capability = context.exposureCapabilities.find(
    (entry): entry is Extract<ExposureCapability, { kind: "gateway-api" }> =>
      entry.kind === "gateway-api" && entry.className === className,
  );
  if (!capability) {
    throw new Error(
      `Routing component "${routingName}" requires Gateway API class "${className}", ` +
        "but the exposure does not provide it",
    );
  }
  if (capability.applicationRoutes.length === 0) {
    throw new Error(
      `Routing component "${routingName}" requires at least one application HTTPRoute`,
    );
  }
  // Only the HTTPRoute must be namespace-local: Envoy policy targetRefs are
  // LocalPolicyTargetReferences, and the EnvoyExtensionPolicy targets the route.
  // The Gateway may live in another namespace (httpRouteExposure attaching to a
  // shared Gateway) — nothing routing-owned targets the Gateway there; the
  // namespace-local ClientTrafficPolicy is suppressed instead (see envoyNativeRouting).
  for (const route of capability.applicationRoutes) {
    if (route.namespace && route.namespace !== context.namespace) {
      throw new Error(
        `Routing component "${routingName}" cannot target HTTPRoute ` +
          `"${route.namespace}/${route.name}" from namespace "${context.namespace}": ` +
          "Envoy Gateway policy targetRefs are namespace-local",
      );
    }
  }
  return capability;
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
  return defineClusterComponent({
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
  });
}

export function gkeCluster(options: GkeClusterOptions = {}): ClusterComponent {
  return defineClusterComponent({
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
      const registryRepository = context.imageRegistry.split("/").at(-1)!;
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
        retained: [
          {
            kind: "gke-cluster",
            projectId,
            clusterName,
            location: { kind: "region", name: region },
          },
          ...(usesArtifactRegistry
            ? [
                {
                  kind: "gcp-artifact-registry" as const,
                  projectId,
                  region,
                  repository: registryRepository,
                },
              ]
            : []),
        ],
        diagnostics: [
          { kind: "gcp-auth", projectId },
          ...(usesArtifactRegistry
            ? [
                {
                  kind: "gcp-artifact-registry" as const,
                  projectId,
                  region,
                  repository: registryRepository,
                },
              ]
            : []),
        ],
      };
    },
  });
}

export function defineClusterComponent(options: {
  name: string;
  build(context: TargetBuildContext): ClusterBuildResult;
}): ClusterComponent {
  return {
    componentType: "cluster",
    name: safeComponentName(options.name),
    build: options.build,
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

export function defineRoutingComponent(options: {
  name: string;
  backend(context: TargetBuildContext): KubernetesServiceRef;
  build(context: RoutingBuildContext): RoutingBuildResult;
}): RoutingComponent {
  return {
    componentType: "routing",
    name: safeComponentName(options.name),
    backend: options.backend,
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

/**
 * cert-manager issuance for a dedicated exposure's in-namespace TLS Secret.
 *
 * Wildcard-cert fleets keep their certificate in the gateway owner's namespace (e.g.
 * `network`), which a dedicated Gateway/Ingress in the app namespace cannot reference —
 * Gateway `certificateRefs` and Ingress `spec.tls` are namespace-local. This option emits
 * a `cert-manager.io/v1` Certificate alongside the exposure so the Secret exists where the
 * listener needs it. With `httpRouteExposure` none of this applies: TLS terminates at the
 * parent Gateway and certificates stay the gateway owner's job.
 */
export interface CertManagerTlsOptions {
  issuerRef: {
    name: string;
    kind: "ClusterIssuer" | "Issuer";
    /** Issuer API group. Defaults to `cert-manager.io` (external issuers override it). */
    group?: string;
  };
}

// cert-manager Issuer/ClusterIssuer names are DNS subdomains; asserted verbatim (NOT
// sanitized) because the ref must match an existing issuer exactly — same contract as
// httpRouteExposure's parentRef Gateway names.
const ISSUER_NAME_RE = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;
// Kubernetes API group: DNS subdomain (e.g. "cert-manager.io", "awspca.cert-manager.io").
const API_GROUP_RE = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;

function validateCertManagerOptions(
  certManager: CertManagerTlsOptions,
  exposureName: string,
  wantsTls: boolean,
): void {
  if (!wantsTls) {
    throw new Error(
      `${exposureName} certManager requires at least one host with tls.enabled — a ` +
        "Certificate for a plaintext-only exposure would issue a cert nothing references",
    );
  }
  const issuerRef = certManager.issuerRef;
  if (!issuerRef || typeof issuerRef !== "object") {
    throw new Error(`${exposureName} certManager requires an issuerRef`);
  }
  if (typeof issuerRef.name !== "string" || !ISSUER_NAME_RE.test(issuerRef.name)) {
    throw new Error(`Invalid certManager issuerRef name ${JSON.stringify(issuerRef.name)}`);
  }
  if (issuerRef.kind !== "ClusterIssuer" && issuerRef.kind !== "Issuer") {
    throw new Error(
      `Invalid certManager issuerRef kind ${JSON.stringify(issuerRef.kind)}: ` +
        'expected "ClusterIssuer" or "Issuer"',
    );
  }
  if (issuerRef.group !== undefined && !API_GROUP_RE.test(issuerRef.group)) {
    throw new Error(`Invalid certManager issuerRef group ${JSON.stringify(issuerRef.group)}`);
  }
}

/**
 * The Certificate + its API requirement + its readiness gate. `secretName` doubles as the
 * Certificate name (cert-manager's own convention), so re-runs against the same config are
 * idempotent and the object diff in a GitOps bundle is stable.
 */
function certManagerContribution(
  certManager: CertManagerTlsOptions,
  secretName: string,
  dnsNames: string[],
  context: ExposureBuildContext,
): {
  certificate: KubernetesManifest;
  requirement: { apiVersion: string; resource: string; optional: false };
  readiness: RoutingReadiness;
} {
  const issuerRef = certManager.issuerRef;
  const certificate = object(
    "cert-manager.io/v1",
    "Certificate",
    "certificates",
    secretName,
    context.namespace,
    {
      spec: {
        secretName,
        dnsNames,
        issuerRef: {
          name: issuerRef.name,
          kind: issuerRef.kind,
          ...(issuerRef.group !== undefined ? { group: issuerRef.group } : {}),
        },
      },
    },
    { labels: { "app.kubernetes.io/name": context.releaseName } },
  );
  return {
    certificate,
    requirement: { apiVersion: "cert-manager.io/v1", resource: "certificates", optional: false },
    readiness: {
      kind: "kubernetes-condition",
      object: {
        apiVersion: "cert-manager.io/v1",
        resource: "certificates",
        name: secretName,
        namespace: context.namespace,
      },
      conditionsAt: { kind: "object" },
      condition: {
        type: "Ready",
        status: "True",
        observedGeneration: "must-equal-metadata-generation",
      },
      timeoutSeconds: 600,
    },
  };
}

export interface GatewayApiExposureOptions {
  className: string;
  hosts: readonly HostConfig[];
  tlsSecretName?: string;
  /**
   * Emit a cert-manager Certificate for the HTTPS listener's Secret. `tlsSecretName`
   * becomes the Certificate's `secretName` when both are set; without it the Secret is
   * derived as `<release>-tls`. Mutually exclusive with `controllerManagedTls` (two
   * certificate managers for one listener).
   */
  certManager?: CertManagerTlsOptions;
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
  if (wantsTls && !options.tlsSecretName && !options.controllerManagedTls && !options.certManager) {
    throw new Error(
      "gatewayApiExposure requires tlsSecretName, certManager, or controllerManagedTls when TLS is enabled",
    );
  }
  if (options.certManager && options.controllerManagedTls) {
    throw new Error(
      "gatewayApiExposure cannot combine certManager with controllerManagedTls: the " +
        "controller already provisions the listener certificate",
    );
  }
  if (options.certManager) {
    validateCertManagerOptions(options.certManager, "gatewayApiExposure", wantsTls);
  }
  return defineExposureComponent({
    name: "gateway-api",
    hosts,
    build(context) {
      const gatewayName = sanitizeK8sName(`${context.releaseName}-gateway`);
      const tlsSecretName =
        options.tlsSecretName ??
        (options.certManager ? sanitizeK8sName(`${context.releaseName}-tls`) : undefined);
      const certManaged = options.certManager
        ? certManagerContribution(
            options.certManager,
            tlsSecretName!,
            hosts.filter((host) => host.tls.enabled).map((host) => host.hostname),
            context,
          )
        : undefined;
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
                  certificateRefs: [{ kind: "Secret", name: tlsSecretName! }],
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
        objects: [
          gateway,
          route,
          ...(redirectRoute ? [redirectRoute] : []),
          ...(certManaged ? [certManaged.certificate] : []),
        ],
        requirements: [
          { apiVersion: "gateway.networking.k8s.io/v1", resource: "gateways", optional: false },
          {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "httproutes",
            optional: false,
          },
          ...(certManaged ? [certManaged.requirement] : []),
        ],
        readiness: [
          gatewayReady,
          routeReady,
          ...(redirectReady ? [redirectReady] : []),
          ...(certManaged ? [certManaged.readiness] : []),
        ],
        ingressSources: copyIngressSources(options.ingressSources),
        capabilities: [
          {
            kind: "gateway-api",
            className: options.className,
            gateway: gatewayReady.object,
            applicationRoutes: [routeReady.object],
          },
        ],
      };
    },
  });
}

export interface HttpRouteExposureOptions {
  /**
   * The shared GatewayClass (e.g. "envoy", "eg"). Required: envoyNativeRouting's
   * capability match keys on className.
   */
  className: string;
  /**
   * Attached verbatim as the app HTTPRoute's spec.parentRefs. At least one. Each name
   * must match an EXISTING Gateway exactly (asserted, never sanitized). The namespace
   * may be another team's (e.g. "network"); omitted it defaults to the release
   * namespace, per Gateway API. sectionName picks the listener (e.g. "https").
   */
  parentRefs: Array<{
    name: string;
    namespace?: string;
    sectionName?: string;
  }>;
  hosts: readonly HostConfig[];
  /**
   * Escaped-slash parity (escapedSlashesAction: KeepUnchanged) is the GATEWAY OWNER's
   * job on a shared gateway — ClientTrafficPolicy is Gateway-scoped and namespace-local.
   * Only "external" is valid; it exists so config reads as an explicit attestation,
   * mirroring envoyNativeRouting's option.
   */
  escapedSlashes?: "external";
  annotations?: Record<string, string>;
  /**
   * Strict-NetworkPolicy admitted sources. The shared gateway's proxy pods live in the
   * PARENT's namespace (e.g. envoy-gateway-system or network), so under
   * networkPolicy.strict you MUST admit them here or every request fails closed. Keep the set as
   * tight as the deployment allows: the routing tier authenticates no callers, so reachability to
   * its :8443 is what decides who can obtain a pool-trusted routing verdict.
   */
  ingressSources?: IngressSourceSet;
}

// Kubernetes sectionName is a Gateway API SectionName: DNS-label charset.
const SECTION_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// Gateway names are DNS subdomains; asserted verbatim (NOT sanitized) because the ref
// must match an existing Gateway exactly.
const PARENT_GATEWAY_NAME_RE = /^[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?$/;

/**
 * Attach the app's HTTPRoute to EXISTING shared Gateway(s) via parentRefs — the common
 * fleet pattern (HTTPRoute -> shared envoy-internal/envoy-external in ns "network").
 * Emits exactly one HTTPRoute: no Gateway, no Certificate, no ClientTrafficPolicy.
 * TLS termination, certs, DNS and escaped-slash parity are the gateway owner's job.
 *
 * With envoyNativeRouting, the EnvoyExtensionPolicy attaches to this route by name
 * (route-scoped ext_proc — supported since Envoy Gateway v1.1.0; the adapter's proven
 * baseline is v1.5.4).
 */
export function httpRouteExposure(options: HttpRouteExposureOptions): ExposureComponent {
  const hosts = copyHosts(options.hosts);
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(options.className)) {
    throw new Error(`Invalid GatewayClass name ${JSON.stringify(options.className)}`);
  }
  if (!Array.isArray(options.parentRefs) || options.parentRefs.length === 0) {
    throw new Error("httpRouteExposure requires at least one parentRef naming an existing Gateway");
  }
  const parentRefs = options.parentRefs.map((ref) => {
    if (typeof ref.name !== "string" || !PARENT_GATEWAY_NAME_RE.test(ref.name)) {
      throw new Error(`Invalid parentRef Gateway name ${JSON.stringify(ref.name)}`);
    }
    if (ref.namespace !== undefined) assertSafeNamespace(ref.namespace);
    if (ref.sectionName !== undefined && !SECTION_NAME_RE.test(ref.sectionName)) {
      throw new Error(`Invalid parentRef sectionName ${JSON.stringify(ref.sectionName)}`);
    }
    return {
      name: ref.name,
      ...(ref.namespace !== undefined ? { namespace: ref.namespace } : {}),
      ...(ref.sectionName !== undefined ? { sectionName: ref.sectionName } : {}),
    };
  });
  if (options.escapedSlashes !== undefined && options.escapedSlashes !== "external") {
    throw new Error(
      'httpRouteExposure only supports escapedSlashes: "external" — escaped-slash parity ' +
        "on a shared gateway belongs to the gateway owner's ClientTrafficPolicy/EnvoyPatchPolicy",
    );
  }
  return defineExposureComponent({
    name: "http-route",
    hosts,
    build(context) {
      const routeName = sanitizeK8sName(`${context.releaseName}-routes`);
      const labels = { "app.kubernetes.io/name": context.releaseName };
      const route = object(
        "gateway.networking.k8s.io/v1",
        "HTTPRoute",
        "httproutes",
        routeName,
        context.namespace,
        {
          spec: {
            parentRefs,
            hostnames: hosts.map((host) => host.hostname),
            rules: [
              {
                matches: [{ path: { type: "PathPrefix", value: "/" } }],
                backendRefs: [{ name: context.backend.name, port: context.backend.port }],
              },
            ],
          },
        },
        {
          labels,
          ...(options.annotations && Object.keys(options.annotations).length > 0
            ? { annotations: options.annotations }
            : {}),
        },
      );
      const routeRef = {
        apiVersion: "gateway.networking.k8s.io/v1",
        resource: "httproutes",
        name: routeName,
        namespace: context.namespace,
      };
      // Both conditions must be True-and-fresh on EVERY reported parent, and
      // minimumCount forces every named parent to have reported at all — a parentRef
      // naming a nonexistent Gateway produces no status.parents entry, which would
      // otherwise let the remaining parents satisfy the check.
      const readiness: RoutingReadiness[] = (["Accepted", "ResolvedRefs"] as const).map((type) => ({
        kind: "kubernetes-condition",
        object: routeRef,
        conditionsAt: { kind: "parents", minimumCount: parentRefs.length },
        condition: {
          type,
          status: "True",
          observedGeneration: "must-equal-metadata-generation",
        },
        timeoutSeconds: 600,
      }));
      const parentGatewayRefs = parentRefs.map((ref) => ({
        apiVersion: "gateway.networking.k8s.io/v1",
        resource: "gateways",
        name: ref.name,
        namespace: ref.namespace ?? context.namespace,
      }));
      const uniqueParents = [
        ...new Map(parentGatewayRefs.map((ref) => [`${ref.namespace}|${ref.name}`, ref])).values(),
      ];
      return {
        objects: [route],
        requirements: [
          {
            apiVersion: "gateway.networking.k8s.io/v1",
            resource: "httproutes",
            optional: false,
          },
        ],
        readiness,
        diagnostics: uniqueParents.map((gateway) => ({
          kind: "kubernetes-gateway-address" as const,
          gateway,
        })),
        ingressSources: copyIngressSources(options.ingressSources),
        capabilities: [
          {
            kind: "gateway-api",
            className: options.className,
            gateway: parentGatewayRefs[0]!,
            applicationRoutes: [routeRef],
          },
        ],
      };
    },
  });
}

export interface IngressExposureOptions {
  className: string;
  hosts: readonly HostConfig[];
  tlsSecretName?: string;
  /**
   * Emit a cert-manager Certificate for the Ingress's TLS Secret. `tlsSecretName`
   * becomes the Certificate's `secretName` when both are set; without it the Secret is
   * derived as `<release>-tls`.
   *
   * ALWAYS emits the Certificate object rather than the `cert-manager.io/cluster-issuer`
   * annotation, deliberately: an emitted Certificate is adapter-owned (visible in the
   * GitOps bundle diff, cleaned up with the release), its `Ready` condition gates
   * readiness by a name known at render time, the cert-manager CRD requirement is
   * preflight-checked, and `issuerRef` supports `kind: Issuer` and external issuer
   * groups — none of which the annotation can express, and the shim-created Certificate
   * it produces is invisible to readiness until the shim has run. The lighter annotation
   * path needs no adapter surface at all: pass the annotation via `annotations` with a
   * `tlsSecretName` and ingress-shim owns issuance (no Certificate emitted, no CRD
   * requirement declared, no readiness gate).
   */
  certManager?: CertManagerTlsOptions;
  annotations?: Record<string, string>;
  ingressSources?: IngressSourceSet;
}

export function ingressExposure(options: IngressExposureOptions): ExposureComponent {
  const hosts = copyHosts(options.hosts);
  const wantsTls = hosts.some((host) => host.tls.enabled);
  if (wantsTls && !options.tlsSecretName && !options.certManager) {
    throw new Error("ingressExposure requires tlsSecretName or certManager when TLS is enabled");
  }
  if (options.certManager) {
    validateCertManagerOptions(options.certManager, "ingressExposure", wantsTls);
  }
  return defineExposureComponent({
    name: "ingress",
    hosts,
    build(context) {
      const tlsSecretName =
        options.tlsSecretName ??
        (options.certManager ? sanitizeK8sName(`${context.releaseName}-tls`) : undefined);
      const certManaged = options.certManager
        ? certManagerContribution(
            options.certManager,
            tlsSecretName!,
            hosts.filter((host) => host.tls.enabled).map((host) => host.hostname),
            context,
          )
        : undefined;
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
                ...(tlsSecretName
                  ? {
                      tls: [
                        {
                          hosts: hosts
                            .filter((host) => host.tls.enabled)
                            .map((host) => host.hostname),
                          secretName: tlsSecretName,
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
          ...(certManaged ? [certManaged.certificate] : []),
        ],
        requirements: [
          { apiVersion: "networking.k8s.io/v1", resource: "ingresses", optional: false },
          ...(certManaged ? [certManaged.requirement] : []),
        ],
        readiness: certManaged ? [certManaged.readiness] : [],
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
    backend,
    build(context): RoutingBuildResult {
      const service = backend(context);
      const readiness: RoutingReadiness[] = [
        { kind: "kubernetes-service-endpoints", service, minimumReady: 1 },
      ];
      return {
        plan: {
          protocol: "pool-local-v1",
          failurePolicy: "closed",
          dataplane: {
            kind: "portable-http-origin",
            service,
            targetPool: context.defaultPool,
            readiness,
          },
        },
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
    escapedSlashes?: "policy" | "external";
  } = {},
): RoutingComponent {
  return {
    componentType: "routing",
    name: "envoy-native",
    backend,
    build(context): RoutingBuildResult {
      const className = options.gatewayClassName ?? "eg";
      const exposure = gatewayCapability(context, "envoy-native", className);
      const policyName = sanitizeK8sName(`${context.releaseName}-routing-extproc`);
      const clientPolicyName = sanitizeK8sName(`${context.releaseName}-client-traffic`);
      // A ClientTrafficPolicy targets the Gateway by name, namespace-locally — it cannot
      // reach a Gateway in another namespace (a shared gateway attached via
      // httpRouteExposure). There, escaped-slash parity (KeepUnchanged) is the gateway
      // OWNER's job (a CTP/EnvoyPatchPolicy on the shared Gateway), so the default flips
      // to "external" and an explicit "policy" is a build error rather than a policy that
      // never binds — Envoy Gateway also rejects a second conflicting CTP per listener.
      const gatewayIsCrossNamespace =
        exposure.gateway.namespace !== undefined &&
        exposure.gateway.namespace !== context.namespace;
      if (gatewayIsCrossNamespace && options.escapedSlashes === "policy") {
        throw new Error(
          `envoyNativeRouting cannot emit a ClientTrafficPolicy for Gateway ` +
            `"${exposure.gateway.namespace}/${exposure.gateway.name}": ClientTrafficPolicy ` +
            `targetRefs are namespace-local. Escaped-slash parity (escapedSlashesAction: ` +
            `KeepUnchanged) must be configured by the shared gateway's owner via a ` +
            `ClientTrafficPolicy or EnvoyPatchPolicy in that namespace; set ` +
            `escapedSlashes: "external" to attest that.`,
        );
      }
      const emitsClientPolicy =
        !gatewayIsCrossNamespace && (options.escapedSlashes ?? "policy") === "policy";
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
            targetRefs: exposure.applicationRoutes.map((route) => ({
              group: "gateway.networking.k8s.io",
              kind: "HTTPRoute",
              name: route.name,
            })),
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
      const clientPolicy = object(
        "gateway.envoyproxy.io/v1alpha1",
        "ClientTrafficPolicy",
        "clienttrafficpolicies",
        clientPolicyName,
        context.namespace,
        {
          spec: {
            targetRefs: [
              {
                group: "gateway.networking.k8s.io",
                kind: "Gateway",
                name: exposure.gateway.name,
              },
            ],
            http1: {},
            path: { escapedSlashesAction: "KeepUnchanged" },
          },
        },
        {
          labels: {
            "app.kubernetes.io/name": context.releaseName,
            "app.kubernetes.io/component": "routing-service",
          },
        },
      );
      const clientPolicyReady: RoutingReadiness = {
        kind: "kubernetes-condition",
        object: {
          apiVersion: "gateway.envoyproxy.io/v1alpha1",
          resource: "clienttrafficpolicies",
          name: clientPolicyName,
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
      };
      return {
        plan: {
          protocol: "envoy-ext-proc-v3",
          failurePolicy: context.failurePolicy,
          dataplane: { kind: "external-ext-proc", transport: "h2c", readiness },
        },
        objects: [policy, ...(emitsClientPolicy ? [clientPolicy] : [])],
        requirements: [
          {
            apiVersion: "gateway.envoyproxy.io/v1alpha1",
            resource: "envoyextensionpolicies",
            optional: false,
          },
          ...(emitsClientPolicy
            ? [
                {
                  apiVersion: "gateway.envoyproxy.io/v1alpha1",
                  resource: "clienttrafficpolicies",
                  optional: false,
                },
              ]
            : []),
        ],
        readiness: [...readiness, ...(emitsClientPolicy ? [clientPolicyReady] : [])],
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
    backend,
    build(context): RoutingBuildResult {
      gatewayCapability(
        context,
        "gke-native",
        options.gatewayClassName ?? "gke-l7-global-external-managed",
      );
      const projectId = options.projectId ?? context.infrastructure?.projectId;
      if (!projectId) throw new Error("gkeNativeRouting requires a projectId");
      assertSafeProjectId(projectId);
      const extensionName = options.extensionName ?? `${context.releaseName}-traffic-ext`;
      const addressName = options.addressName ?? `${context.releaseName}-ip`;
      const readiness: RoutingReadiness[] = [
        {
          kind: "gcp-traffic-extension",
          projectId,
          extensionName,
          addressName,
          requireEveryForwardingRule: true,
        },
      ];
      return {
        plan: {
          protocol: "envoy-ext-proc-v3",
          failurePolicy: context.failurePolicy,
          dataplane: { kind: "external-ext-proc", transport: "tls", readiness },
        },
        readiness,
        requirements: [
          {
            apiVersion: "networking.gke.io/v1",
            resource: "healthcheckpolicies",
            optional: false,
          },
        ],
        routingTier: {
          enabled: true,
          transport: "tls",
          serviceAnnotations: {
            "cloud.google.com/neg": `{"exposed_ports":{"8443":{"name":"${context.releaseName}-routing-neg"}}}`,
          },
          registration: "gke-traffic-extension",
        },
        externalCleanup: [
          {
            kind: "gcp-traffic-extension",
            projectId,
            name: extensionName,
            location: "global",
          },
          {
            kind: "gcp-backend-service",
            projectId,
            name: `${context.releaseName}-routing-service`,
            scope: "global",
          },
          {
            kind: "gcp-health-check",
            projectId,
            name: `${context.releaseName}-routing-hc`,
            scope: "global",
          },
          { kind: "gcp-global-address", projectId, name: addressName },
        ],
        diagnostics: [
          { kind: "gcp-global-address", projectId, name: addressName },
          {
            kind: "gcp-traffic-extension",
            projectId,
            extensionName,
            addressName,
          },
          {
            kind: "gcp-backend-service-shape",
            projectId,
            name: `${context.releaseName}-routing-service`,
            loadBalancingScheme: "EXTERNAL_MANAGED",
            requireBackend: true,
          },
          {
            kind: "gcp-health-check-shape",
            projectId,
            name: `${context.releaseName}-routing-hc`,
            expectedType: "TCP",
          },
        ],
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
  if (typeof options.cluster.build !== "function") {
    throw new Error("defineTarget.cluster must implement build()");
  }
  if (options.exposure?.componentType !== "exposure") {
    throw new Error("defineTarget.exposure must be an exposure component");
  }
  if (typeof options.exposure.build !== "function") {
    throw new Error("defineTarget.exposure must implement build()");
  }
  const routing = options.routing ?? portableRouting();
  if (routing.componentType !== "routing") {
    throw new Error("defineTarget.routing must be a routing component");
  }
  if (typeof routing.backend !== "function" || typeof routing.build !== "function") {
    throw new Error("defineTarget.routing must implement backend() and build()");
  }
  const resources = [...(options.resources ?? [])];
  for (const resource of resources) {
    if (resource.componentType !== "resource") {
      throw new Error("defineTarget.resources must contain resource components");
    }
    if (typeof resource.build !== "function") {
      throw new Error("defineTarget resource components must implement build()");
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
