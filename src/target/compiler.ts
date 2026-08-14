import type {
  KubernetesApiRequirement,
  KubernetesManifest,
  RoutingReadiness,
  TelemetrySource,
} from "../composition-plan/types.js";
import { parseCompositionPlan } from "../composition-plan/parse.js";
import { MINIMUM_KUBERNETES_VERSION } from "../composition-plan/types.js";
import { ADAPTER_RELEASE_LABEL } from "../emit/templates/utils.js";
import type {
  CompiledKubernetesTarget,
  KubernetesContribution,
  KubernetesTargetDefinition,
  TargetBuildContext,
} from "./types.js";
import { targetFingerprint, validateTargetContext } from "./components.js";

function contributionOf(
  contribution: KubernetesContribution,
  componentName: string,
): Required<KubernetesContribution> {
  if (contribution === null || typeof contribution !== "object" || Array.isArray(contribution)) {
    throw new Error(`Target component "${componentName}" returned a non-object contribution`);
  }
  const unknown = Object.keys(contribution).filter(
    (key) =>
      ![
        "objects",
        "requirements",
        "readiness",
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
    externalCleanup: [...(contribution.externalCleanup ?? [])],
    retained: [...(contribution.retained ?? [])],
    diagnostics: [...(contribution.diagnostics ?? [])],
    telemetry: [...(contribution.telemetry ?? [])],
  };
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
  const routingBackend = target.routing.backend(context);
  const exposure = target.exposure.build({ ...context, backend: routingBackend });
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
        "managedCache",
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
  const externalCleanup = [
    ...(cluster.externalCleanup ?? []),
    ...contributions.flatMap((entry) => entry.externalCleanup),
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
    ...contributions.flatMap((entry) => entry.requirements),
  ]);
  const cache =
    context.cache === "external"
      ? ({ kind: "external", lifecycle: "operator-managed" } as const)
      : ({ kind: "none" } as const);
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
    ingressSources: exposure.ingressSources,
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
    ingressSources: exposure.ingressSources,
    routingTier: routing.routingTier,
    routingProviderName: target.routing.name,
  };
}
