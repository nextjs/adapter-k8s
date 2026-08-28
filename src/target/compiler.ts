import type {
  CacheProvisioning,
  DiagnosticSource,
  ExternalCleanupOperation,
  KubernetesApiRequirement,
  KubernetesManifest,
  RetainedExternalResource,
  RoutingReadiness,
  TelemetrySource,
} from "../composition-plan/types.js";
import { parseCompositionPlan } from "../composition-plan/parse.js";
import { MINIMUM_KUBERNETES_VERSION } from "../composition-plan/types.js";
import { assertGcpTrafficExtensionTopology } from "../composition-plan/routing-invariants.js";
import {
  ADAPTER_RELEASE_LABEL,
  assertSafeAnnotationName,
  assertSafeKubernetesObjectName,
  assertSafeNamespace,
  assertSafeServiceName,
} from "../emit/templates/utils.js";
import type {
  CompiledKubernetesTarget,
  KubernetesContribution,
  KubernetesTargetDefinition,
  ResourceBuildResult,
  TargetBuildContext,
} from "./types.js";
import { targetFingerprint, validateTargetContext } from "./components.js";
import { normalizeIngressSources } from "./ingress-sources.js";

function assertSafeLabelValue(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 63 ||
    (value.length > 0 && !/^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(value))
  ) {
    throw new Error(`Invalid ${field}: expected a Kubernetes label value`);
  }
}

function validateRoutingOrigin(
  componentName: string,
  origin: import("./types.js").RoutingOrigin,
  releaseNamespace: string,
): void {
  const backend = origin?.kind === "kubernetes-service" ? origin.service : undefined;
  if (
    !backend ||
    typeof backend !== "object" ||
    !Number.isInteger(backend.port) ||
    backend.port < 1 ||
    backend.port > 65_535
  ) {
    throw new Error(
      `Routing component "${componentName}" returned an invalid origin Service reference`,
    );
  }
  try {
    // Namespace validation belongs at this consumption point. Exposure components embed the
    // reference into Kubernetes objects before the composition-plan parser sees it.
    assertSafeNamespace(backend.namespace);
    assertSafeServiceName(backend.name);
  } catch {
    throw new Error(
      `Routing component "${componentName}" returned an invalid origin Service reference`,
    );
  }
  if (backend.namespace !== releaseNamespace) {
    throw new Error(
      `Routing component "${componentName}" returned an invalid origin Service reference: ` +
        `current exposure components require namespace ${JSON.stringify(releaseNamespace)}`,
    );
  }
}

function validateRoutingContract(
  componentName: string,
  context: TargetBuildContext,
  routing: import("./types.js").RoutingBuildResult,
  originService: import("../composition-plan/types.js").KubernetesServiceRef,
): void {
  const tier = routing.routingTier;
  if (!tier || typeof tier !== "object" || !routing.plan || typeof routing.plan !== "object") {
    throw new Error(`Routing component "${componentName}" must return plan and routingTier`);
  }
  const tierUnknown = Object.keys(tier).filter(
    (key) => !["enabled", "transport", "callerAuthentication", "serviceAnnotations"].includes(key),
  );
  if (tierUnknown.length > 0) {
    throw new Error(
      `Routing component "${componentName}" returned unknown routingTier field${tierUnknown.length === 1 ? "" : "s"}: ${tierUnknown.join(", ")}`,
    );
  }
  if (
    !tier.serviceAnnotations ||
    typeof tier.serviceAnnotations !== "object" ||
    Array.isArray(tier.serviceAnnotations)
  ) {
    throw new Error(
      `Routing component "${componentName}" must return routingTier.serviceAnnotations`,
    );
  }
  if (typeof tier.enabled !== "boolean") {
    throw new Error(
      `Routing component "${componentName}" returned invalid routingTier.enabled; expected a boolean`,
    );
  }
  for (const [name, value] of Object.entries(tier.serviceAnnotations)) {
    try {
      assertSafeAnnotationName(name);
    } catch {
      throw new Error(
        `Routing component "${componentName}" returned an invalid routingTier annotation name`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `Routing component "${componentName}" returned an invalid routingTier annotation value`,
      );
    }
  }

  if (routing.plan.protocol === "pool-local-v1") {
    if (
      tier.enabled !== false ||
      tier.transport !== undefined ||
      tier.callerAuthentication !== undefined
    ) {
      throw new Error(
        `Routing component "${componentName}" returned a pool-local plan with an enabled routing tier`,
      );
    }
    if (routing.plan.dataplane.targetPool !== context.defaultPool) {
      throw new Error(
        `Routing component "${componentName}" targets pool ` +
          `${JSON.stringify(routing.plan.dataplane.targetPool)} instead of defaultPool ` +
          JSON.stringify(context.defaultPool),
      );
    }
    const service = routing.plan.dataplane.service;
    if (
      service.name !== originService.name ||
      service.namespace !== originService.namespace ||
      service.port !== originService.port
    ) {
      throw new Error(
        `Routing component "${componentName}" must use the same origin Service in its ` +
          `pool-local plan and exposure`,
      );
    }
    return;
  }

  if (tier.enabled !== true || (tier.transport !== "tls" && tier.transport !== "h2c")) {
    throw new Error(
      `Routing component "${componentName}" returned an ext_proc plan without an enabled routing tier`,
    );
  }
  const callerAuthentication = tier.callerAuthentication;
  if (!callerAuthentication || typeof callerAuthentication !== "object") {
    throw new Error(
      `Routing component "${componentName}" must declare caller authentication for its routing tier`,
    );
  }
  const callerUnknown = Object.keys(callerAuthentication).filter(
    (key) => !["kind", "networkPolicy", "transportSecurity"].includes(key),
  );
  if (callerUnknown.length > 0) {
    throw new Error(
      `Routing component "${componentName}" returned unknown caller authentication field${callerUnknown.length === 1 ? "" : "s"}: ${callerUnknown.join(", ")}`,
    );
  }
  if (
    callerAuthentication.kind !== "none" ||
    callerAuthentication.networkPolicy !== "required" ||
    (tier.transport === "tls"
      ? callerAuthentication.transportSecurity !== "server-tls"
      : callerAuthentication.transportSecurity !== "none")
  ) {
    throw new Error(
      `Routing component "${componentName}" returned an invalid caller authentication posture`,
    );
  }
  if (routing.plan.failurePolicy !== context.failurePolicy) {
    throw new Error(
      `Routing component "${componentName}" uses failure policy ` +
        `${JSON.stringify(routing.plan.failurePolicy)}, but the build requires ` +
        JSON.stringify(context.failurePolicy),
    );
  }
  if (
    routing.plan.dataplane.kind === "external-ext-proc" &&
    routing.plan.dataplane.transport !== tier.transport
  ) {
    throw new Error(
      `Routing component "${componentName}" enables ${tier.transport} transport, but its ` +
        `ext_proc plan declares ${routing.plan.dataplane.transport}`,
    );
  }
  const registration = routing.plan.registration;
  if (registration?.kind === "gcp-traffic-extension-v1" && tier.transport !== "tls") {
    throw new Error(
      `Routing component "${componentName}" must use tls transport for gcp-traffic-extension-v1 registration`,
    );
  }
}

interface NormalizedContribution {
  objects: KubernetesManifest[];
  requirements: KubernetesApiRequirement[];
  readiness: RoutingReadiness[];
  cache?: CacheProvisioning;
  externalCleanup: ExternalCleanupOperation[];
  retained: RetainedExternalResource[];
  diagnostics: DiagnosticSource[];
  telemetry: TelemetrySource[];
}

function contributionOf(
  contribution: KubernetesContribution & Pick<ResourceBuildResult, "cache">,
  componentName: string,
): NormalizedContribution {
  if (contribution === null || typeof contribution !== "object" || Array.isArray(contribution)) {
    throw new Error(`Target component "${componentName}" returned a non-object contribution`);
  }
  const unknown = Object.keys(contribution).filter(
    (key) =>
      ![
        "objects",
        "requirements",
        "readiness",
        "cache",
        "externalCleanup",
        "retained",
        "diagnostics",
        "telemetry",
      ].includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Target component "${componentName}" returned unknown field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`,
    );
  }
  return {
    objects: [...(contribution.objects ?? [])],
    requirements: [...(contribution.requirements ?? [])],
    readiness: [...(contribution.readiness ?? [])],
    ...(contribution.cache ? { cache: contribution.cache } : {}),
    externalCleanup: [...(contribution.externalCleanup ?? [])],
    retained: [...(contribution.retained ?? [])],
    diagnostics: [...(contribution.diagnostics ?? [])],
    telemetry: [...(contribution.telemetry ?? [])],
  };
}

function resolveCacheProvisioning(
  context: TargetBuildContext,
  targetName: string,
  contributions: readonly (CacheProvisioning | undefined)[],
): CacheProvisioning {
  const declared = contributions.filter((entry): entry is CacheProvisioning => entry !== undefined);
  if (declared.length > 1) {
    throw new Error(`Target "${targetName}" has multiple cache provisioning contributions`);
  }

  if (context.cache === "external") {
    if (declared.length > 0 && declared[0]!.kind !== "external") {
      throw new Error(
        `Target "${targetName}" declares managed cache provisioning even though cache.url is configured`,
      );
    }
    return { kind: "external", lifecycle: "operator-managed" };
  }
  if (context.cache === undefined || context.cache === "none") {
    if (declared.length > 0 && declared[0]!.kind !== "none") {
      throw new Error(
        `Target "${targetName}" declares cache provisioning even though the cache is disabled`,
      );
    }
    return { kind: "none" };
  }

  const provisioning = declared[0];
  if (!provisioning || provisioning.kind === "none" || provisioning.kind === "external") {
    throw new Error(
      `Target "${targetName}" does not provide managed cache provisioning. Set cache.url to ` +
        `an operator-managed Valkey/Redis endpoint, disable the cache, or use a target component ` +
        `that contributes a managed CacheProvisioning operation.`,
    );
  }
  return provisioning;
}

function cacheCleanup(cache: CacheProvisioning): ExternalCleanupOperation[] {
  switch (cache.kind) {
    case "gcp-memorystore":
      return [
        {
          kind: "gcp-memorystore",
          projectId: cache.projectId,
          region: cache.region,
          name: cache.name,
        },
      ];
    case "none":
    case "external":
      return [];
  }
}

function objectIdentity(object: KubernetesManifest): string {
  return [
    object.apiVersion,
    object.resource,
    object.metadata.namespace ?? "",
    object.metadata.name,
  ].join("|");
}

function mergeRequirements(requirements: KubernetesApiRequirement[]): KubernetesApiRequirement[] {
  const merged = new Map<string, KubernetesApiRequirement>();
  for (const requirement of requirements) {
    const key = `${requirement.apiVersion}|${requirement.resource}`;
    const existing = merged.get(key);
    merged.set(key, {
      ...requirement,
      optional: existing ? existing.optional && requirement.optional : requirement.optional,
    });
  }
  return [...merged.values()].sort((a, b) =>
    `${a.apiVersion}/${a.resource}`.localeCompare(`${b.apiVersion}/${b.resource}`),
  );
}

function adapterTelemetrySources(
  context: TargetBuildContext,
  routingProviderName: string,
  routingTierEnabled: boolean,
): TelemetrySource[] {
  const providerAttribute = { "adapter_k8s.provider.name": routingProviderName };
  const sources: TelemetrySource[] = [
    {
      id: "adapter.pool",
      producer: { kind: "adapter-runtime", name: "pool-server" },
      owner: "adapter",
      activation: { kind: "app-instrumentation-hook" },
      protocols: ["otel-api"],
      propagation: ["tracecontext", "tracestate", "baggage-pass-through"],
      signals: [
        { kind: "span", name: "adapter-k8s.pool.request" },
        {
          kind: "metric",
          name: "adapter_k8s.pool.request.count",
          instrument: "counter",
          unit: "{request}",
        },
        {
          kind: "metric",
          name: "adapter_k8s.pool.request.duration",
          instrument: "histogram",
          unit: "s",
        },
      ],
      workloads: context.pools.map((pool) => ({ kind: "adapter-pool" as const, pool })),
      attributes: {
        "adapter_k8s.component": "pool-server",
        ...providerAttribute,
      },
    },
  ];
  if (routingTierEnabled) {
    sources.push({
      id: `adapter.routing.${routingProviderName}`,
      producer: { kind: "adapter-runtime", name: "routing-service" },
      owner: "adapter",
      activation: {
        kind: "external-precondition",
        description:
          "Inject or preload an OpenTelemetry provider into the routing-service process before its first request",
      },
      protocols: ["otel-api"],
      propagation: ["tracecontext", "tracestate", "baggage-pass-through"],
      signals: [
        { kind: "span", name: "adapter-k8s.routing.request" },
        {
          kind: "metric",
          name: "adapter_k8s.routing.request.count",
          instrument: "counter",
          unit: "{request}",
        },
        {
          kind: "metric",
          name: "adapter_k8s.routing.request.duration",
          instrument: "histogram",
          unit: "s",
        },
      ],
      workloads: [{ kind: "adapter-routing-service" }],
      attributes: {
        "adapter_k8s.component": "routing-service",
        ...providerAttribute,
      },
    });
  }
  return sources;
}

export function compileTarget(
  target: KubernetesTargetDefinition,
  context: TargetBuildContext,
): CompiledKubernetesTarget {
  if (target?.componentType !== "target") {
    throw new Error("compileTarget requires a target created by defineTarget");
  }
  validateTargetContext(context);
  const cluster = target.cluster.build(context);
  if (!cluster || typeof cluster !== "object" || Array.isArray(cluster)) {
    throw new Error(`Target component "${target.cluster.name}" returned a non-object result`);
  }
  const routingOrigin = target.routing.origin(context);
  validateRoutingOrigin(target.routing.name, routingOrigin, context.namespace);
  const exposure = target.exposure.build({ ...context, origin: routingOrigin });
  if (!exposure || typeof exposure !== "object" || Array.isArray(exposure)) {
    throw new Error(`Target component "${target.exposure.name}" returned a non-object result`);
  }
  const unknownClusterFields = Object.keys(cluster).filter(
    (key) =>
      ![
        "identity",
        "access",
        "registry",
        "network",
        "cache",
        "externalCleanup",
        "retained",
        "diagnostics",
        "telemetry",
      ].includes(key),
  );
  if (unknownClusterFields.length > 0) {
    throw new Error(
      `Target component "${target.cluster.name}" returned unknown field${unknownClusterFields.length === 1 ? "" : "s"}: ${unknownClusterFields.join(", ")}`,
    );
  }
  const unknownExposureFields = Object.keys(exposure).filter(
    (key) =>
      ![
        "objects",
        "requirements",
        "readiness",
        "externalCleanup",
        "retained",
        "diagnostics",
        "ingressSources",
        "capabilities",
        "telemetry",
      ].includes(key),
  );
  if (unknownExposureFields.length > 0) {
    throw new Error(
      `Target component "${target.exposure.name}" returned unknown field${unknownExposureFields.length === 1 ? "" : "s"}: ${unknownExposureFields.join(", ")}`,
    );
  }
  if (!Array.isArray(exposure.capabilities)) {
    throw new Error(`Target component "${target.exposure.name}" must return capabilities`);
  }
  const ingressSources = normalizeIngressSources(exposure.ingressSources);
  const exposesTraffic = exposure.capabilities.some(
    (capability) => capability.kind === "gateway-api" || capability.kind === "ingress",
  );
  if (
    exposesTraffic &&
    ingressSources.cidrs.length === 0 &&
    ingressSources.podSelectors.length === 0
  ) {
    throw new Error(
      `Target component "${target.exposure.name}" exposes external traffic but returned empty ` +
        `ingressSources`,
    );
  }
  const backendHealthCapabilities = exposure.capabilities.filter(
    (capability): capability is Extract<typeof capability, { kind: "backend-health" }> =>
      capability.kind === "backend-health",
  );
  if (backendHealthCapabilities.length > 1) {
    throw new Error(
      `Target component "${target.exposure.name}" returned more than one backend-health capability`,
    );
  }
  const backendHealthCapability = backendHealthCapabilities[0];
  if (backendHealthCapability) {
    if (backendHealthCapability.policy.kind !== "gke-health-check-policy") {
      throw new Error(
        `Target component "${target.exposure.name}" returned an unsupported backend-health policy`,
      );
    }
    const service = backendHealthCapability.service;
    if (
      service.name !== routingOrigin.service.name ||
      service.namespace !== routingOrigin.service.namespace ||
      service.port !== routingOrigin.service.port
    ) {
      throw new Error(
        `Target component "${target.exposure.name}" backend-health capability must target the ` +
          `routing origin Service`,
      );
    }
  }
  const routing = target.routing.build({
    ...context,
    exposureCapabilities: exposure.capabilities,
  });
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    throw new Error(`Target component "${target.routing.name}" returned a non-object result`);
  }
  const unknownRoutingFields = Object.keys(routing).filter(
    (key) =>
      ![
        "plan",
        "routingTier",
        "objects",
        "requirements",
        "readiness",
        "externalCleanup",
        "retained",
        "diagnostics",
        "telemetry",
      ].includes(key),
  );
  if (unknownRoutingFields.length > 0) {
    throw new Error(
      `Target component "${target.routing.name}" returned unknown field${unknownRoutingFields.length === 1 ? "" : "s"}: ${unknownRoutingFields.join(", ")}`,
    );
  }
  validateRoutingContract(target.routing.name, context, routing, routingOrigin.service);
  assertGcpTrafficExtensionTopology({
    identity: cluster.identity,
    routing: routing.plan,
    objects: exposure.objects ?? [],
    subject: `Routing component "${target.routing.name}"`,
  });

  const contributions = [
    contributionOf(
      {
        objects: exposure.objects ?? [],
        requirements: exposure.requirements ?? [],
        readiness: exposure.readiness ?? [],
        externalCleanup: exposure.externalCleanup ?? [],
        retained: exposure.retained ?? [],
        diagnostics: exposure.diagnostics ?? [],
        telemetry: exposure.telemetry ?? [],
      },
      target.exposure.name,
    ),
    contributionOf(
      {
        objects: routing.objects ?? [],
        requirements: routing.requirements ?? [],
        readiness: routing.readiness ?? [],
        externalCleanup: routing.externalCleanup ?? [],
        retained: routing.retained ?? [],
        diagnostics: routing.diagnostics ?? [],
        telemetry: routing.telemetry ?? [],
      },
      target.routing.name,
    ),
    ...target.resources.map((resource) => contributionOf(resource.build(context), resource.name)),
  ];
  const objects = contributions
    .flatMap((entry) => entry.objects)
    .map((manifest) => {
      if (manifest.apiVersion === "v1" && manifest.kind === "Service") {
        assertSafeServiceName(manifest.metadata.name);
      } else if (manifest.apiVersion === "v1" && manifest.kind === "Namespace") {
        assertSafeNamespace(manifest.metadata.name);
      } else {
        assertSafeKubernetesObjectName(manifest.metadata.name);
      }
      if (manifest.metadata.namespace !== undefined) {
        assertSafeNamespace(manifest.metadata.namespace);
      }
      for (const [name, value] of Object.entries(manifest.metadata.labels ?? {})) {
        assertSafeAnnotationName(name);
        assertSafeLabelValue(value, `label ${JSON.stringify(name)}`);
      }
      for (const [name, value] of Object.entries(manifest.metadata.annotations ?? {})) {
        assertSafeAnnotationName(name);
        if (typeof value !== "string") {
          throw new Error(`Invalid annotation ${JSON.stringify(name)}: expected a string value`);
        }
      }
      const configuredRelease = manifest.metadata.labels?.[ADAPTER_RELEASE_LABEL];
      if (configuredRelease !== undefined && configuredRelease !== context.releaseName) {
        throw new Error(
          `Target object ${manifest.kind}/${manifest.metadata.name} overrides reserved label ` +
            ADAPTER_RELEASE_LABEL,
        );
      }
      return {
        ...manifest,
        metadata: {
          ...manifest.metadata,
          labels: {
            ...manifest.metadata.labels,
            [ADAPTER_RELEASE_LABEL]: context.releaseName,
          },
        },
      };
    });
  const identities = new Set<string>();
  for (const manifest of objects) {
    const identity = objectIdentity(manifest);
    if (identities.has(identity)) {
      throw new Error(`Target components emitted duplicate Kubernetes object ${identity}`);
    }
    identities.add(identity);
  }
  const readiness: RoutingReadiness[] = contributions.flatMap((entry) => entry.readiness);
  const cache = resolveCacheProvisioning(context, target.cluster.name, [
    cluster.cache,
    ...contributions.map((entry) => entry.cache),
  ]);
  const externalCleanup = [
    ...(cluster.externalCleanup ?? []),
    ...contributions.flatMap((entry) => entry.externalCleanup),
    ...cacheCleanup(cache),
  ];
  const retained = [
    ...(cluster.retained ?? []),
    ...contributions.flatMap((entry) => entry.retained),
  ];
  const diagnostics = [
    ...(cluster.diagnostics ?? []),
    ...contributions.flatMap((entry) => entry.diagnostics),
  ];
  const contributedTelemetry = [
    ...(cluster.telemetry ?? []),
    ...contributions.flatMap((entry) => entry.telemetry),
  ];
  for (const source of contributedTelemetry) {
    if (typeof source?.id === "string" && source.id.startsWith("adapter.")) {
      throw new Error(
        `Target telemetry source id ${JSON.stringify(source.id)} uses the reserved "adapter." ` +
          `prefix. Provider/component sources must use their own prefix (for example ` +
          `"provider.nginx").`,
      );
    }
  }
  const telemetry = [
    ...adapterTelemetrySources(context, target.routing.name, routing.routingTier.enabled),
    ...contributedTelemetry,
  ].sort((a, b) => String(a?.id ?? "").localeCompare(String(b?.id ?? "")));
  const telemetryIds = new Set<string>();
  for (const source of telemetry) {
    if (typeof source?.id !== "string") continue;
    if (telemetryIds.has(source.id)) {
      throw new Error(`Target components emitted duplicate telemetry source id ${source.id}`);
    }
    telemetryIds.add(source.id);
  }
  const requirements = mergeRequirements([
    { apiVersion: "v1", resource: "services", optional: false },
    { apiVersion: "apps/v1", resource: "deployments", optional: false },
    { apiVersion: "autoscaling/v2", resource: "horizontalpodautoscalers", optional: false },
    { apiVersion: "policy/v1", resource: "poddisruptionbudgets", optional: false },
    { apiVersion: "networking.k8s.io/v1", resource: "networkpolicies", optional: false },
    ...(backendHealthCapability
      ? [
          {
            apiVersion: "networking.gke.io/v1",
            resource: "healthcheckpolicies",
            optional: false,
          },
        ]
      : []),
    ...contributions.flatMap((entry) => entry.requirements),
  ]);
  // This is the compatibility identity for lifecycle commands, not merely a cluster locator.
  // A rollback cannot safely keep the current Helm release while claiming to restore a build
  // whose exposure, routing policies, contributed objects or default origin pool differ.
  const fingerprint = targetFingerprint({
    cluster: {
      identity: cluster.identity,
      access: cluster.access,
      registry: cluster.registry,
      network: cluster.network,
    },
    defaultPool: context.defaultPool,
    ingressSources,
    backendHealth: backendHealthCapability?.policy ?? null,
    objects,
    requirements,
    readiness,
    routing: routing.plan,
    routingTier: routing.routingTier,
    cache,
    cdn: { kind: "none" },
    externalCleanup,
    retained,
    diagnostics,
    telemetry,
  });
  const plan = parseCompositionPlan({
    apiVersion: "adapter-k8s.nextjs.org/v1alpha1",
    kind: "CompositionPlan",
    metadata: {
      releaseName: context.releaseName,
      namespace: context.namespace,
      buildId: context.buildId,
    },
    target: {
      fingerprint,
      identity: cluster.identity,
      access: cluster.access,
      registry: cluster.registry,
    },
    requirements: {
      kubernetes: {
        minimumVersion: MINIMUM_KUBERNETES_VERSION,
        resources: requirements,
      },
    },
    operations: {
      resources: { objects, readiness },
      network: cluster.network,
      cache,
      cdn: { kind: "none" },
      routing: routing.plan,
      cleanup: {
        kubernetes: {
          strategy: "adapter-release-v1",
          contributedObjects: objects.map((manifest) => ({
            ref: {
              apiVersion: manifest.apiVersion,
              resource: manifest.resource,
              name: manifest.metadata.name,
              ...(manifest.metadata.namespace ? { namespace: manifest.metadata.namespace } : {}),
            },
            lifecycle: "helm",
            ownership: {
              releaseLabel: {
                key: "adapter-k8s.dev/release",
                value: context.releaseName,
              },
              helmRelease: {
                name: context.releaseName,
                namespace: context.namespace,
              },
            },
          })),
        },
        external: externalCleanup,
        retained,
      },
      diagnostics,
      logs: [
        {
          kind: "kubernetes-pods",
          namespace: context.namespace,
          selector: { releaseName: context.releaseName },
          containers: "all",
        },
      ],
      telemetry,
    },
  });
  return {
    plan,
    defaultPool: context.defaultPool,
    hosts: target.exposure.hosts.map((host) => ({
      hostname: host.hostname,
      tls: { ...host.tls },
    })),
    ingressSources,
    backendHealth: backendHealthCapability?.policy ?? null,
    routingTier: routing.routingTier,
    routingProviderName: target.routing.name,
  };
}
