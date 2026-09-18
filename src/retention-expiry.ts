import {
  assertSafeBuildId,
  assertSafeNamespace,
  assertSafePoolName,
  assertSafeReleaseName,
  sanitizeK8sName,
} from "./emit/templates/utils.js";

export const RETENTION_EXPIRY_ANNOTATION = "adapter-k8s.io/retention-expiry";
export interface ExpiryMarker {
  buildId: string;
  expiresAt: number;
}
export function parseExpiryMarker(raw: string | undefined): ExpiryMarker | undefined {
  try {
    const marker = JSON.parse(raw ?? "null") as ExpiryMarker;
    assertSafeBuildId(marker.buildId);
    if (!Number.isSafeInteger(marker.expiresAt) || marker.expiresAt <= 0) return;
    return marker;
  } catch {
    return;
  }
}

export interface ClusterObject {
  metadata: {
    name: string;
    uid?: string;
    resourceVersion?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    continue?: string;
  };
  spec?: {
    replicas?: number;
    selector?: Record<string, unknown>;
    scaleTargetRef?: { name?: string };
  };
  data?: Record<string, string>;
  items?: ClusterObject[];
}
export interface CleanupApi {
  get(path: string): Promise<ClusterObject>;
  patch(path: string, operations: unknown[]): Promise<void>;
}

/** The Deployment version is the fence: promotion renews its marker before readiness. */
export async function cleanupExpiredRetention(
  api: CleanupApi,
  release: string,
  namespace: string,
  now = Date.now(),
): Promise<number> {
  assertSafeReleaseName(release);
  assertSafeNamespace(namespace);
  const core = `/api/v1/namespaces/${namespace}`;
  const apps = `/apis/apps/v1/namespaces/${namespace}`;
  const statePath = `${core}/configmaps/${release}-adapter-state`;
  let stateObject: ClusterObject;
  try {
    stateObject = await api.get(statePath);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return 0;
    throw error;
  }
  const stateRaw = stateObject.data?.["state.json"];
  const state = JSON.parse(stateRaw ?? "null");
  if (!state?.previousBuildId || state.buildId === state.previousBuildId) return 0;
  assertSafeBuildId(state.buildId);
  assertSafeBuildId(state.previousBuildId);
  const currentPools: unknown = state.poolTopologies?.[state.buildId];
  const previousPools: unknown = state.poolTopologies?.[state.previousBuildId];
  if (
    !Array.isArray(currentPools) ||
    !currentPools.length ||
    !Array.isArray(previousPools) ||
    !previousPools.length
  )
    return 0;
  for (const pool of [...currentPools, ...previousPools]) assertSafePoolName(pool);
  const query = `?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${release}`)}&limit=500`;
  const list = async (path: string, all = false) => {
    const result = await api.get(path + (all ? "?limit=500" : query));
    if (!Array.isArray(result.items) || result.metadata?.continue)
      throw new Error("Incomplete retention cleanup list");
    return result.items;
  };
  // Capture the Deployment versions BEFORE reading state/traffic guards. A promotion
  // racing any subsequent read or patch invalidates this snapshot by renewing its marker.
  const deployments = await list(`${apps}/deployments`);
  const services = await list(`${core}/services`);
  const hpas = await list(
    `/apis/autoscaling/v2/namespaces/${namespace}/horizontalpodautoscalers`,
    true,
  );
  const activeVersion = sanitizeK8sName(state.buildId);
  for (const pool of currentPools) {
    const service = services.find((s) => s.metadata.name === sanitizeK8sName(`${release}-${pool}`));
    if (service?.spec?.selector?.["app.kubernetes.io/version"] !== activeVersion) return 0;
  }
  const origin = services.find((s) => s.metadata.name === sanitizeK8sName(`${release}-origin`));
  if (origin && origin.spec?.selector?.["app.kubernetes.io/version"] !== activeVersion) return 0;
  let scaled = 0;
  for (const deployment of deployments) {
    const { metadata, spec } = deployment;
    const raw = metadata?.annotations?.[RETENTION_EXPIRY_ANNOTATION];
    const marker = parseExpiryMarker(raw);
    const pool = metadata?.labels?.["app.kubernetes.io/component"];
    if (
      !marker ||
      marker.buildId !== state.previousBuildId ||
      marker.expiresAt > now ||
      metadata.deletionTimestamp ||
      !metadata.resourceVersion ||
      !metadata.uid ||
      !Number.isSafeInteger(spec?.replicas) ||
      spec!.replicas! <= 0 ||
      metadata.labels?.["app.kubernetes.io/name"] !== release ||
      metadata.labels?.["app.kubernetes.io/version"] !== sanitizeK8sName(marker.buildId) ||
      !previousPools.includes(pool) ||
      metadata.name !== sanitizeK8sName(`${release}-${pool}-${marker.buildId}`)
    )
      continue;
    // An HPA means another controller owns capacity. Never fight it or delete it here.
    if (hpas.some((hpa) => hpa.spec?.scaleTargetRef?.name === metadata.name)) continue;
    if ((await api.get(statePath)).data?.["state.json"] !== stateRaw) return scaled;
    try {
      // Scale subresource RBAC cannot edit images, credentials, or pod templates.
      // Its resourceVersion/UID are the parent Deployment's, including marker changes.
      await api.patch(`${apps}/deployments/${metadata.name}/scale`, [
        { op: "test", path: "/metadata/uid", value: metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: metadata.resourceVersion },
        { op: "replace", path: "/spec/replicas", value: 0 },
      ]);
      scaled++;
      console.log(`Expired standby ${metadata.name}: scaled to zero`);
    } catch (error) {
      // A changed Deployment is re-evaluated from scratch by a later scheduled job.
      const status = (error as { status?: number }).status;
      if (status !== 404 && status !== 409 && status !== 422) throw error;
    }
  }
  return scaled;
}
