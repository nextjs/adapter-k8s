import { EXEC_TIMEOUTS, execCapture } from "../cli/exec.js";
import { INTERNAL_SECRET_KEY } from "../emit/templates/internal-secret.js";

export interface RoutingRevision {
  image: string;
  internalSecretRef: string | null;
  nodeArchitecture: string | null;
}

type KubernetesWorkload = {
  metadata?: {
    ownerReferences?: {
      apiVersion?: string;
      kind?: string;
      name?: string;
      uid?: string;
      controller?: boolean;
    }[];
  };
  spec?: {
    template?: {
      spec?: {
        containers?: {
          name?: string;
          image?: string;
          env?: {
            name?: string;
            value?: string;
            valueFrom?: { secretKeyRef?: { name?: string; key?: string } };
          }[];
        }[];
        nodeSelector?: Record<string, string>;
      };
    };
  };
};

/** ConfigMaps describe a rollback request; only workloads authorize the executable image. */
export async function readTrustedRoutingRevision(options: {
  deploymentName: string;
  deploymentUid: string | undefined;
  namespace: string;
  targetBuildId: string;
  live: RoutingRevision & { imageTag: string };
}): Promise<RoutingRevision> {
  const { deploymentName, deploymentUid, namespace, targetBuildId, live } = options;
  const refuse = (reason: string): never => {
    throw new Error(
      `Cannot recover routing build ${targetBuildId}: ${reason}. ` +
        `Recovery requires the live Deployment or its retained ReplicaSet history; ` +
        `ConfigMap image coordinates cannot authorize a routing image. Traffic was NOT switched.`,
    );
  };
  if (!deploymentUid) return refuse("the routing Deployment has no UID");
  const result = await execCapture(
    "kubectl",
    ["get", "replicasets", "-n", namespace, "-o", "json"],
    { timeoutMs: EXEC_TIMEOUTS.kubectl },
  );
  if (result.exitCode !== 0) return refuse("the routing ReplicaSet history could not be read");
  let items: KubernetesWorkload[];
  try {
    const parsed = JSON.parse(result.stdout) as { items?: unknown };
    if (!Array.isArray(parsed?.items)) return refuse("the ReplicaSet list is malformed");
    items = parsed.items;
  } catch {
    return refuse("the ReplicaSet list is malformed");
  }
  const candidates: RoutingRevision[] = [];
  if (live.imageTag === targetBuildId) {
    candidates.push({
      image: live.image,
      internalSecretRef: live.internalSecretRef,
      nodeArchitecture: live.nodeArchitecture,
    });
  }
  for (const item of items) {
    const owners = item?.metadata?.ownerReferences;
    if (
      !Array.isArray(owners) ||
      !owners.some(
        (owner) =>
          owner?.apiVersion === "apps/v1" &&
          owner.kind === "Deployment" &&
          owner.name === deploymentName &&
          owner.uid === deploymentUid &&
          owner.controller === true,
      )
    ) {
      continue;
    }
    const spec = item.spec?.template?.spec;
    const containers = spec?.containers;
    if (!Array.isArray(containers)) return refuse("an owned routing revision has no containers");
    const routing = containers.find((container) => container?.name === "routing-service");
    if (!routing || typeof routing.image !== "string" || !routing.image) {
      return refuse("an owned routing revision has no routing image");
    }
    const env = Array.isArray(routing.env) ? routing.env : [];
    const taggedBuildId =
      routing.image.includes(":") && !routing.image.includes("@")
        ? routing.image.slice(routing.image.lastIndexOf(":") + 1)
        : undefined;
    // Tagged legacy revisions may predate NEXT_BUILD_ID updates. The recorded image tag
    // identifies the executable build in those revisions, just as the live reader does.
    const buildId = taggedBuildId || env.find((entry) => entry?.name === "NEXT_BUILD_ID")?.value;
    if (buildId !== targetBuildId) continue;
    const secretEnv = env.find((entry) => entry?.name === "INTERNAL_HEADER_SECRET");
    const secretRef = secretEnv?.valueFrom?.secretKeyRef;
    if (secretEnv && (!secretRef?.name || secretRef.key !== INTERNAL_SECRET_KEY)) {
      return refuse("the target revision has an unsupported dispatch Secret binding");
    }
    const nodeArchitecture = spec?.nodeSelector?.["kubernetes.io/arch"] ?? null;
    if (nodeArchitecture !== null && typeof nodeArchitecture !== "string") {
      return refuse("the target revision has an invalid architecture selector");
    }
    candidates.push({
      image: routing.image,
      internalSecretRef: secretRef?.name ?? null,
      nodeArchitecture,
    });
  }
  const target = candidates[0];
  if (!target) return refuse("no retained workload revision matches the requested build");
  if (candidates.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(target))) {
    return refuse("retained workload revisions disagree on the image, Secret, or architecture");
  }
  return target;
}
