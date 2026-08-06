import type {
  KubernetesApiRequirement,
  KubernetesManifest,
  RoutingReadiness,
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
    (key) => !["objects", "requirements", "readiness"].includes(key),
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

export function compileTarget(
  target: KubernetesTargetDefinition,
  context: TargetBuildContext,
): CompiledKubernetesTarget {
  if (target?.componentType !== "target") {
    throw new Error("compileTarget requires a target created by defineTarget");
  }
  validateTargetContext(context);
  const cluster = target.cluster.build(context);
  const routing = target.routing.build(context);
  const exposure = target.exposure.build({ ...context, backend: routing.backend });
  const unknownClusterFields = Object.keys(cluster).filter(
    (key) => !["identity", "access", "registry", "network", "managedCache"].includes(key),
  );
  if (unknownClusterFields.length > 0) {
    throw new Error(
      `Target component "${target.cluster.name}" returned unknown field${unknownClusterFields.length === 1 ? "" : "s"}: ${unknownClusterFields.join(", ")}`,
    );
  }
  const unknownExposureFields = Object.keys(exposure).filter(
    (key) =>
      !["objects", "requirements", "readiness", "ingressSources", "capabilities"].includes(key),
  );
  if (unknownExposureFields.length > 0) {
    throw new Error(
      `Target component "${target.exposure.name}" returned unknown field${unknownExposureFields.length === 1 ? "" : "s"}: ${unknownExposureFields.join(", ")}`,
    );
  }
  const unknownRoutingFields = Object.keys(routing).filter(
    (key) =>
      ![
        "plan",
        "backend",
        "requiresExposure",
        "routingTier",
        "objects",
        "requirements",
        "readiness",
      ].includes(key),
  );
  if (unknownRoutingFields.length > 0) {
    throw new Error(
      `Target component "${target.routing.name}" returned unknown field${unknownRoutingFields.length === 1 ? "" : "s"}: ${unknownRoutingFields.join(", ")}`,
    );
  }
  if (
    routing.requiresExposure &&
    !exposure.capabilities.some(
      (capability) =>
        capability.kind === "gateway-api" &&
        capability.className === routing.requiresExposure!.className,
    )
  ) {
    throw new Error(
      `Routing component "${target.routing.name}" requires Gateway API class ` +
        `"${routing.requiresExposure.className}", but "${target.exposure.name}" does not provide it`,
    );
  }

  const contributions = [
    contributionOf(
      {
        objects: exposure.objects ?? [],
        requirements: exposure.requirements ?? [],
        readiness: exposure.readiness ?? [],
      },
      target.exposure.name,
    ),
    contributionOf(
      {
        objects: routing.objects ?? [],
        requirements: routing.requirements ?? [],
        readiness: routing.readiness ?? [],
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
  const requirements = mergeRequirements([
    { apiVersion: "v1", resource: "services", optional: false },
    { apiVersion: "apps/v1", resource: "deployments", optional: false },
    { apiVersion: "autoscaling/v2", resource: "horizontalpodautoscalers", optional: false },
    { apiVersion: "policy/v1", resource: "poddisruptionbudgets", optional: false },
    { apiVersion: "networking.k8s.io/v1", resource: "networkpolicies", optional: false },
    ...contributions.flatMap((entry) => entry.requirements),
  ]);
  const fingerprint = targetFingerprint({
    identity: cluster.identity,
    access: cluster.access,
    registry: cluster.registry,
    network: cluster.network,
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
      cache:
        context.cache === "external"
          ? { kind: "external", lifecycle: "operator-managed" }
          : { kind: "none" },
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
        external: [],
        retained: [],
      },
      diagnostics: [],
      logs: [
        {
          kind: "kubernetes-pods",
          namespace: context.namespace,
          selector: { releaseName: context.releaseName },
          containers: "all",
        },
      ],
    },
  });
  return {
    plan,
    hosts: target.exposure.hosts.map((host) => ({
      hostname: host.hostname,
      tls: { ...host.tls },
    })),
    ingressSources: exposure.ingressSources,
    routingTier: routing.routingTier,
  };
}
